import type { CustomerSearchResult } from "../../types";

const CUSTOMER_SEARCH_QUERY = `#graphql
  query CustomerSearch($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
        id
        firstName
        lastName
        email
        phone
        numberOfOrders
      }
    }
  }
`;

interface CustomerSearchResponse {
  data?: {
    customers: {
      nodes: CustomerSearchResult[];
    };
  };
  errors?: Array<{ message: string }>;
}

export async function searchCustomerByEmail(
  admin: { graphql: Function },
  email: string,
): Promise<CustomerSearchResult | null> {
  const response = await admin.graphql(CUSTOMER_SEARCH_QUERY, {
    variables: { query: `email:"${email}"` },
  });
  const json: CustomerSearchResponse = await response.json();

  if (json.errors?.length) {
    console.error("[Customers] Search error:", json.errors);
    throw new Error(`Customer search failed: ${json.errors[0].message}`);
  }

  const customers = json.data?.customers?.nodes ?? [];
  return customers.length > 0 ? customers[0] : null;
}

const CUSTOMER_CREATE_MUTATION = `#graphql
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        firstName
        lastName
        email
        phone
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CustomerCreateResponse {
  data?: {
    customerCreate: {
      customer: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface CustomerCreateInput {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export async function createCustomer(
  admin: { graphql: Function },
  input: CustomerCreateInput,
): Promise<{ customerId: string | null; errors: string[] }> {
  const response = await admin.graphql(CUSTOMER_CREATE_MUTATION, {
    variables: { input },
  });
  const json: CustomerCreateResponse = await response.json();

  if (json.errors?.length) {
    console.error("[Customers] Create error:", json.errors);
    return { customerId: null, errors: json.errors.map((e) => e.message) };
  }

  const result = json.data?.customerCreate;
  if (result?.userErrors?.length) {
    return {
      customerId: null,
      errors: result.userErrors.map((e) => e.message),
    };
  }

  return {
    customerId: result?.customer?.id ?? null,
    errors: [],
  };
}
