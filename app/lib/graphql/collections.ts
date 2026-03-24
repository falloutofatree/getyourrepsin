const COLLECTIONS_QUERY = `#graphql
  query AllCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        productsCount {
          count
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface CollectionInfo {
  id: string;
  title: string;
  handle: string;
  numericId: string;
  productsCount: number;
}

interface CollectionsResponse {
  data?: {
    collections: {
      nodes: Array<{
        id: string;
        title: string;
        handle: string;
        productsCount: { count: number } | null;
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

export async function fetchAllCollections(
  admin: { graphql: Function },
): Promise<CollectionInfo[]> {
  const allCollections: CollectionInfo[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(COLLECTIONS_QUERY, {
      variables: { first: 100, after: cursor },
    });
    const json: CollectionsResponse = await response.json();

    if (json.errors?.length) {
      console.error("[Collections] Query error:", json.errors);
      throw new Error(
        `Failed to fetch collections: ${json.errors.map((e) => e.message).join(", ")}`,
      );
    }

    if (!json.data?.collections?.nodes) break;

    for (const c of json.data.collections.nodes) {
      const numericId = c.id.replace("gid://shopify/Collection/", "");
      allCollections.push({
        id: c.id,
        title: c.title,
        handle: c.handle,
        numericId,
        productsCount: c.productsCount?.count ?? 0,
      });
    }

    hasNextPage = json.data.collections.pageInfo.hasNextPage;
    cursor = json.data.collections.pageInfo.endCursor;
  }

  return allCollections;
}
