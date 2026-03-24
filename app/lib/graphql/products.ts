import type { Product, PageInfo } from "../../types";
import { getCached, setCachedWithTTL, CACHE_TTL } from "../cache.server";

export const CATALOG_PRODUCTS_QUERY = `#graphql
  query CatalogProducts($publicationId: ID!, $first: Int!, $after: String) {
    publication(id: $publicationId) {
      products(first: $first, after: $after) {
        nodes {
          id
          title
          handle
          description
          vendor
          productType
          status
          featuredImage {
            url
            altText
          }
          variants(first: 100) {
            nodes {
              id
              title
              sku
              price
              availableForSale
              inventoryQuantity
              selectedOptions {
                name
                value
              }
              image {
                url
                altText
              }
            }
          }
          options {
            name
            values
          }
          totalInventory
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const CATALOG_PRODUCTS_GRID_QUERY = `#graphql
  query CatalogProductsGrid($publicationId: ID!, $first: Int!, $after: String, $query: String) {
    publication(id: $publicationId) {
      products(first: $first, after: $after, query: $query) {
        nodes {
          id
          title
          featuredImage {
            url
            altText
          }
          variants(first: 10) {
            nodes {
              id
              title
              sku
              price
              inventoryQuantity
              selectedOptions {
                name
                value
              }
              image {
                url
                altText
              }
            }
          }
          options {
            name
            values
          }
          totalInventory
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const IS_PRODUCT_PUBLISHED_QUERY = `#graphql
  query IsProductPublished($productId: ID!, $companyLocationId: ID!) {
    product(id: $productId) {
      id
      title
      publishedInContext(
        context: { companyLocationId: $companyLocationId }
      )
    }
  }
`;

interface CatalogProductsResponse {
  data?: {
    publication: {
      products: {
        nodes: Product[];
        pageInfo: PageInfo;
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface IsProductPublishedResponse {
  data?: {
    product: {
      id: string;
      title: string;
      publishedInContext: boolean;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export async function fetchCatalogProducts(
  admin: { graphql: Function },
  publicationId: string,
  cursor?: string,
  gridOnly: boolean = true,
  productQuery?: string,
): Promise<{ products: Product[]; pageInfo: PageInfo }> {
  const cacheKey = `publication:${publicationId}:products:${cursor ?? "start"}:${gridOnly ? "grid" : "full"}:${productQuery ?? ""}`;
  const cached = getCached<{ products: Product[]; pageInfo: PageInfo }>(cacheKey);
  if (cached) return cached;

  const gqlQuery = gridOnly ? CATALOG_PRODUCTS_GRID_QUERY : CATALOG_PRODUCTS_QUERY;
  const response = await admin.graphql(gqlQuery, {
    variables: {
      publicationId,
      first: 50,
      after: cursor ?? null,
      query: productQuery ?? null,
    },
  });

  const json: CatalogProductsResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch catalog products: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.publication?.products) {
    return { products: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  const result = {
    products: json.data.publication.products.nodes,
    pageInfo: json.data.publication.products.pageInfo,
  };

  // Debug: log inventory data
  for (const p of result.products) {
    console.log(`[Products] ${p.title}: totalInventory=${p.totalInventory}, variants:`,
      p.variants?.nodes?.map((v: any) => `${v.title}:qty=${v.inventoryQuantity}`) ?? []);
  }

  setCachedWithTTL(cacheKey, result, CACHE_TTL.PRODUCT_DATA);
  return result;
}

export async function isProductPublished(
  admin: { graphql: Function },
  productId: string,
  companyLocationId: string
): Promise<boolean> {
  const response = await admin.graphql(IS_PRODUCT_PUBLISHED_QUERY, {
    variables: { productId, companyLocationId },
  });

  const json: IsProductPublishedResponse = await response.json();

  if (json.errors?.length) {
    return false;
  }

  return json.data?.product?.publishedInContext ?? false;
}
