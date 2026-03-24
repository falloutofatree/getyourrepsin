import type { Catalog } from "../../types";
import { getCached, setCached } from "../cache.server";

export const B2B_CATALOGS_QUERY = `#graphql
  query B2BCatalogs($first: Int!, $after: String) {
    catalogs(first: $first, after: $after) {
      nodes {
        id
        title
        status
        ... on CompanyLocationCatalog {
          companyLocations(first: 100) {
            nodes {
              id
              name
              company {
                id
                name
              }
            }
          }
        }
        publication {
          id
        }
        priceList {
          id
          currency
          name
        }
      }
    }
  }
`;

// Query all markets with their regions to map country → market
const MARKETS_QUERY = `#graphql
  query Markets {
    markets(first: 50) {
      nodes {
        id
        name
        regions(first: 100) {
          nodes {
            ... on MarketRegionCountry {
              code
              name
            }
          }
        }
        catalogs(first: 5) {
          nodes {
            id
            title
            status
            publication {
              id
            }
            priceList {
              id
              currency
              name
            }
          }
        }
      }
    }
  }
`;

interface MarketRegion {
  code: string;
  name: string;
}

interface MarketsResponse {
  data?: {
    markets: {
      nodes: Array<{
        id: string;
        name: string;
        regions: { nodes: MarketRegion[] };
        catalogs: { nodes: Catalog[] };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface B2BCatalogsResponse {
  data?: {
    catalogs: {
      nodes: Catalog[];
    };
  };
  errors?: Array<{ message: string }>;
}

export async function fetchCatalogForLocation(
  admin: { graphql: Function },
  locationId: string,
  locationCountry?: string | null
): Promise<Catalog | null> {
  const cacheKey = `location:${locationId}:catalog`;
  // Temporarily skip cache for debugging
  // const cached = getCached<Catalog | null>(cacheKey);
  // if (cached !== undefined) return cached;

  const response = await admin.graphql(B2B_CATALOGS_QUERY, {
    variables: { first: 50 },
  });
  const json: B2BCatalogsResponse = await response.json();

  console.log("[Catalogs] Root catalogs query result:", JSON.stringify(json, null, 2));

  if (json.errors?.length) {
    console.error("[Catalogs] Root query errors:", JSON.stringify(json.errors));
    throw new Error(
      `Failed to fetch catalogs: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.catalogs?.nodes) {
    console.log("[Catalogs] No catalogs data in response");
    return null;
  }

  console.log("[Catalogs] Found", json.data.catalogs.nodes.length, "catalogs, looking for locationId:", locationId);

  // First try: CompanyLocationCatalog with matching location
  let catalog = json.data.catalogs.nodes.find((c) =>
    c.companyLocations?.nodes?.some((loc) => loc.id === locationId)
  ) ?? null;

  // Second try: query markets to find the right MarketCatalog by country
  if (!catalog && locationCountry) {
    console.log("[Catalogs] Looking up markets for country:", locationCountry);
    try {
      const marketsResponse = await admin.graphql(MARKETS_QUERY);
      const marketsJson: MarketsResponse = await marketsResponse.json();

      if (marketsJson.data?.markets?.nodes) {
        const countryUpper = locationCountry.toUpperCase();

        // Find the market whose regions include this country
        const matchingMarket = marketsJson.data.markets.nodes.find((m) =>
          m.regions.nodes.some((r) =>
            r.name?.toUpperCase() === countryUpper ||
            r.code?.toUpperCase() === countryUpper
          )
        );

        if (matchingMarket) {
          console.log("[Catalogs] Matched market:", matchingMarket.name, "for country:", locationCountry);

          // Use the catalog from the market directly
          const marketCatalog = matchingMarket.catalogs.nodes.find(
            (c) => c.status === "ACTIVE" && c.publication
          );
          if (marketCatalog) {
            catalog = marketCatalog;
            console.log("[Catalogs] Found catalog via market:", catalog.title);
          }
        } else {
          console.log("[Catalogs] No market found for country:", locationCountry);
        }
      }
    } catch (err) {
      console.error("[Catalogs] Markets query failed:", err);
    }
  }

  // Last resort: use first market catalog from the catalogs query
  if (!catalog) {
    const marketCatalogs = json.data.catalogs.nodes.filter(
      (c) => c.id.includes("MarketCatalog") && c.status === "ACTIVE" && c.publication
    );
    if (marketCatalogs.length > 0) {
      catalog = marketCatalogs[0];
      console.log("[Catalogs] Fallback to first market catalog:", catalog?.title);
    }
  }

  setCached(cacheKey, catalog, "CATALOG_PUBLICATION");
  return catalog;
}

// --- Catalog assignment for new company locations ---

const CATALOG_CONTEXT_UPDATE_MUTATION = `#graphql
  mutation CatalogContextUpdate($catalogId: ID!, $contextsToAdd: [CatalogContextInput!]!) {
    catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contextsToAdd) {
      catalog {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CatalogContextUpdateResponse {
  data?: {
    catalogContextUpdate: {
      catalog: { id: string; title: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Find the right catalog for a country code and assign the new company location to it.
 * For MarketCatalogs, the market membership handles it automatically.
 * For CompanyLocationCatalogs, we need to explicitly add the location.
 */
export async function assignCatalogToNewLocation(
  admin: { graphql: Function },
  companyLocationId: string,
  countryCode: string,
): Promise<{ catalogId: string | null; errors: string[] }> {
  // Find the matching market catalog by country code
  try {
    const marketsResponse = await admin.graphql(MARKETS_QUERY);
    const marketsJson: MarketsResponse = await marketsResponse.json();

    if (!marketsJson.data?.markets?.nodes) {
      return { catalogId: null, errors: ["No markets found"] };
    }

    const matchingMarket = marketsJson.data.markets.nodes.find((m) =>
      m.regions.nodes.some(
        (r) => r.code?.toUpperCase() === countryCode.toUpperCase(),
      ),
    );

    if (!matchingMarket) {
      console.log("[Catalogs] No market found for country code:", countryCode);
      return { catalogId: null, errors: [] };
    }

    const marketCatalog = matchingMarket.catalogs.nodes.find(
      (c) => c.status === "ACTIVE" && c.publication,
    );

    if (!marketCatalog) {
      console.log("[Catalogs] No active catalog for market:", matchingMarket.name);
      return { catalogId: null, errors: [] };
    }

    // Market catalogs automatically cover locations in their regions,
    // so no explicit assignment needed. But for CompanyLocationCatalogs,
    // we need to add the location to the catalog context.
    if (marketCatalog.id.includes("CompanyLocationCatalog")) {
      const updateResponse = await admin.graphql(
        CATALOG_CONTEXT_UPDATE_MUTATION,
        {
          variables: {
            catalogId: marketCatalog.id,
            contextsToAdd: [
              { companyLocationIds: [companyLocationId] },
            ],
          },
        },
      );
      const updateJson: CatalogContextUpdateResponse =
        await updateResponse.json();

      if (updateJson.errors?.length) {
        return {
          catalogId: null,
          errors: updateJson.errors.map((e) => e.message),
        };
      }

      if (updateJson.data?.catalogContextUpdate?.userErrors?.length) {
        return {
          catalogId: null,
          errors: updateJson.data.catalogContextUpdate.userErrors.map(
            (e) => e.message,
          ),
        };
      }
    }

    console.log(
      "[Catalogs] Assigned catalog",
      marketCatalog.title,
      "for new location in",
      countryCode,
    );
    return { catalogId: marketCatalog.id, errors: [] };
  } catch (err) {
    console.error("[Catalogs] Assign catalog failed:", err);
    return {
      catalogId: null,
      errors: [err instanceof Error ? err.message : "Unknown error"],
    };
  }
}
