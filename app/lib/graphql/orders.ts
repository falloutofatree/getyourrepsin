import type { DraftOrder, Order, PageInfo } from "../../types";

export const REP_DRAFT_ORDERS_QUERY = `#graphql
  query RepDraftOrders($query: String!, $first: Int!, $after: String) {
    draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        status
        email
        createdAt
        updatedAt
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          firstName
          lastName
          email
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              id
              name
            }
            location {
              id
              name
            }
          }
        }
        lineItems(first: 10) {
          nodes {
            title
            quantity
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const DRAFT_ORDER_DETAIL_QUERY = `#graphql
  query DraftOrderDetail($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      status
      email
      note2
      createdAt
      updatedAt
      invoiceUrl
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
        presentmentMoney {
          amount
          currencyCode
        }
      }
      subtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        firstName
        lastName
        email
      }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
          }
          location {
            id
            name
          }
        }
      }
      shippingAddress {
        address1
        city
        province
        country
        zip
      }
      billingAddress {
        address1
        city
        province
        country
        zip
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          variant {
            id
            sku
            title
            image {
              url
              altText
            }
          }
        }
      }
      tags
    }
  }
`;

export const COMPANY_ORDERS_QUERY = `#graphql
  query CompanyOrders($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

interface RepDraftOrdersResponse {
  data?: {
    draftOrders: {
      nodes: DraftOrder[];
      pageInfo: PageInfo;
    };
  };
  errors?: Array<{ message: string }>;
}

interface DraftOrderDetailResponse {
  data?: {
    draftOrder: (DraftOrder & {
      note2: string | null;
      subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      totalTaxSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingAddress: { address1: string | null; city: string | null; province: string | null; country: string | null; zip: string | null } | null;
      billingAddress: { address1: string | null; city: string | null; province: string | null; country: string | null; zip: string | null } | null;
      tags: string[];
    }) | null;
  };
  errors?: Array<{ message: string }>;
}

interface CompanyOrdersResponse {
  data?: {
    orders: {
      nodes: Order[];
    };
  };
  errors?: Array<{ message: string }>;
}

export async function fetchRepDraftOrders(
  admin: { graphql: Function },
  staffGid: string,
  first: number = 50,
  cursor?: string,
  allowedLocationIds?: Set<string> | null,
): Promise<{ orders: DraftOrder[]; pageInfo: PageInfo }> {
  const numericId = staffGid.replace("gid://shopify/StaffMember/", "");
  const queryFilter = `tag:sales-rep-portal AND tag:rep:${numericId}`;
  const response = await admin.graphql(REP_DRAFT_ORDERS_QUERY, {
    variables: { query: queryFilter, first, after: cursor ?? null },
  });

  const json: RepDraftOrdersResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch draft orders: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.draftOrders) {
    return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  let orders = json.data.draftOrders.nodes;

  // Filter out orders for company locations the rep is no longer assigned to.
  // null means admin (no filtering). undefined means legacy call (no filtering).
  if (allowedLocationIds) {
    orders = orders.filter((order) => {
      const locationId = order.purchasingEntity?.location?.id;
      // Keep orders without a location (shouldn't happen, but defensive)
      if (!locationId) return true;
      return allowedLocationIds.has(locationId);
    });
  }

  return {
    orders,
    pageInfo: json.data.draftOrders.pageInfo,
  };
}

export async function fetchDraftOrderDetail(
  admin: { graphql: Function },
  draftOrderId: string
) {
  const response = await admin.graphql(DRAFT_ORDER_DETAIL_QUERY, {
    variables: { id: draftOrderId },
  });

  const json: DraftOrderDetailResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch draft order: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.draftOrder) {
    throw new Error(`Draft order not found: ${draftOrderId}`);
  }

  return json.data.draftOrder;
}

export async function fetchCompanyOrders(
  admin: { graphql: Function },
  companyLocationId: string,
  first: number = 50
): Promise<Order[]> {
  const numericId = companyLocationId.replace(
    "gid://shopify/CompanyLocation/",
    ""
  );
  const queryFilter = `company_location_id:${numericId}`;

  const response = await admin.graphql(COMPANY_ORDERS_QUERY, {
    variables: { query: queryFilter, first },
  });

  const json: CompanyOrdersResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch company orders: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  return json.data?.orders?.nodes ?? [];
}
