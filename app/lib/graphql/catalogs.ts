import type { Catalog } from "../../types";
import { getCached, setCached, invalidatePattern } from "../cache.server";
import {
  getCatalogMapping,
  resolveCatalogIdForCountry,
} from "../catalog-mapping.server";

/**
 * B2B catalogs are CompanyLocationCatalogs — they are NOT reachable through
 * markets. `Market.catalogs` only ever returns MarketCatalog objects, so any
 * lookup that goes through markets will miss every B2B catalog and leave the
 * location on default (shop currency) pricing.
 */
export const B2B_CATALOGS_QUERY = `#graphql
  query B2BCatalogs($first: Int!, $after: String) {
    catalogs(first: $first, after: $after, type: COMPANY_LOCATION) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface B2BCatalogsResponse {
  data?: {
    catalogs: {
      nodes: Catalog[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

const CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGES = 20;

/**
 * Every B2B (company location) catalog in the shop. Paginated — a store with
 * more than one page of catalogs used to silently lose the tail.
 */
export async function fetchB2BCatalogs(
  admin: { graphql: Function },
): Promise<Catalog[]> {
  const cacheKey = "shop:b2b-catalogs";
  const cached = getCached<Catalog[]>(cacheKey);
  if (cached) return cached;

  const catalogs: Catalog[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const response = await admin.graphql(B2B_CATALOGS_QUERY, {
      variables: { first: CATALOG_PAGE_SIZE, after },
    });
    const json: B2BCatalogsResponse = await response.json();

    if (json.errors?.length) {
      throw new Error(
        `Failed to fetch B2B catalogs: ${json.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const connection = json.data?.catalogs;
    if (!connection) break;

    catalogs.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }

  setCached(cacheKey, catalogs, "CATALOG_PUBLICATION");
  return catalogs;
}

/**
 * Fallback catalog lookup for a company location that `companyLocation.catalogs`
 * returned nothing usable for — i.e. the location was never assigned to a B2B
 * catalog. Resolves the catalog its country SHOULD map to, so the rep sees the
 * right region's pricing instead of default shop (USD) pricing.
 *
 * Callers must check `companyLocation.catalogs` first — that is the
 * authoritative assignment. This only covers the unassigned case.
 */
export async function fetchCatalogForLocation(
  admin: { graphql: Function },
  shop: string,
  locationId: string,
  locationCountryCode?: string | null,
): Promise<Catalog | null> {
  if (!locationCountryCode) return null;

  const cacheKey = `location:${locationId}:catalog`;
  const cached = getCached<Catalog | null>(cacheKey);
  if (cached !== undefined) return cached;

  const mapping = await getCatalogMapping(shop);
  const mappedId = resolveCatalogIdForCountry(mapping, locationCountryCode);

  let catalog: Catalog | null = null;
  if (mappedId) {
    const catalogs = await fetchB2BCatalogs(admin);
    catalog = catalogs.find((c) => c.id === mappedId) ?? null;
  }

  if (catalog) {
    console.warn(
      `[Catalogs] Location ${locationId} (${locationCountryCode}) is not assigned to any B2B catalog. ` +
        `Showing mapped catalog "${catalog.title}" — assign it in Shopify to fix checkout pricing.`,
    );
  } else {
    console.warn(
      `[Catalogs] Location ${locationId} (${locationCountryCode}) has no catalog and no mapping for its country.`,
    );
  }

  setCached(cacheKey, catalog, "CATALOG_PUBLICATION");
  return catalog;
}

// --- Catalog assignment for new company locations ---

const CATALOG_CONTEXT_UPDATE_MUTATION = `#graphql
  mutation AssignLocationToCatalog($catalogId: ID!, $companyLocationIds: [ID!]!) {
    catalogContextUpdate(
      catalogId: $catalogId
      contextsToAdd: { companyLocationIds: $companyLocationIds }
    ) {
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

export interface CatalogAssignmentResult {
  catalogId: string | null;
  catalogTitle: string | null;
  errors: string[];
}

/**
 * Assign a company location to the B2B catalog configured for its country.
 *
 * Used by both entry points: the rep portal's company-create flow and the
 * `company_locations/create` webhook (which covers locations created directly
 * in the Shopify admin).
 *
 * Requires the `write_products` access scope — catalogContextUpdate is gated
 * on it even though it only touches catalog contexts.
 */
export async function assignCatalogToNewLocation(
  admin: { graphql: Function },
  shop: string,
  companyLocationId: string,
  countryCode: string | null | undefined,
): Promise<CatalogAssignmentResult> {
  const empty: CatalogAssignmentResult = {
    catalogId: null,
    catalogTitle: null,
    errors: [],
  };

  if (!countryCode) {
    console.warn(
      `[Catalogs] No country for location ${companyLocationId} — skipping catalog assignment`,
    );
    return empty;
  }

  try {
    const mapping = await getCatalogMapping(shop);
    const catalogId = resolveCatalogIdForCountry(mapping, countryCode);

    if (!catalogId) {
      console.warn(
        `[Catalogs] No catalog mapped for country ${countryCode}. ` +
          `Configure the country → catalog mapping in the app's Settings page.`,
      );
      return empty;
    }

    const response = await admin.graphql(CATALOG_CONTEXT_UPDATE_MUTATION, {
      variables: { catalogId, companyLocationIds: [companyLocationId] },
    });
    const json: CatalogContextUpdateResponse = await response.json();

    if (json.errors?.length) {
      const errors = json.errors.map((e) => e.message);
      console.error("[Catalogs] catalogContextUpdate failed:", errors.join(", "));
      return { ...empty, errors };
    }

    const userErrors = json.data?.catalogContextUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const errors = userErrors.map((e) => e.message);
      console.error("[Catalogs] catalogContextUpdate userErrors:", errors.join(", "));
      return { ...empty, errors };
    }

    // The location→catalog and catalog→locations caches are both stale now.
    invalidatePattern(`location:${companyLocationId}:catalog`);
    invalidatePattern("shop:b2b-catalogs");

    const catalog = json.data?.catalogContextUpdate?.catalog ?? null;
    console.log(
      `[Catalogs] Assigned location ${companyLocationId} (${countryCode}) to catalog "${catalog?.title ?? catalogId}"`,
    );

    return {
      catalogId,
      catalogTitle: catalog?.title ?? null,
      errors: [],
    };
  } catch (err) {
    console.error("[Catalogs] Assign catalog failed:", err);
    return {
      ...empty,
      errors: [err instanceof Error ? err.message : "Unknown error"],
    };
  }
}
