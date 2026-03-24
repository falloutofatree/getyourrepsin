import type { CompanyLocation, CompanyContact, PageInfo } from "../../types";
import { getCached, setCached } from "../cache.server";
import prisma from "../../db.server";

export const COMPANY_LOCATIONS_QUERY = `#graphql
  query CompanyLocationsForStaff($first: Int!, $after: String) {
    companyLocations(first: $first, after: $after) {
      nodes {
        id
        name
        company {
          id
          name
        }
        billingAddress {
          address1
          city
          province
          country
          zip
        }
        shippingAddress {
          address1
          city
          province
          country
          zip
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const COMPANY_LOCATION_CATALOGS_QUERY = `#graphql
  query CompanyLocationCatalogs($companyLocationId: ID!) {
    companyLocation(id: $companyLocationId) {
      id
      name
      company {
        id
        name
      }
      billingAddress {
        address1
        city
        province
        country
        zip
      }
      shippingAddress {
        address1
        city
        province
        country
        zip
      }
      catalogs(first: 10) {
        nodes {
          id
          title
          status
          publication {
            id
          }
          ... on CompanyLocationCatalog {
            priceList {
              id
              currency
            }
          }
        }
      }
    }
  }
`;

export const COMPANY_CONTACTS_QUERY = `#graphql
  query CompanyContacts($companyLocationId: ID!) {
    companyLocation(id: $companyLocationId) {
      id
      name
      company {
        id
        name
        contacts(first: 50) {
          nodes {
            id
            customer {
              id
              email
              firstName
              lastName
            }
            isMainContact
          }
        }
      }
    }
  }
`;

interface CompanyLocationsResponse {
  data?: {
    companyLocations: {
      nodes: CompanyLocation[];
      pageInfo: PageInfo;
    };
  };
  errors?: Array<{ message: string }>;
}

interface CompanyLocationCatalogsResponse {
  data?: {
    companyLocation: CompanyLocation | null;
  };
  errors?: Array<{ message: string }>;
}

interface CompanyContactsResponse {
  data?: {
    companyLocation: {
      id: string;
      name: string;
      company: {
        id: string;
        name: string;
        contacts: {
          nodes: CompanyContact[];
        };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export async function fetchCompanyLocationsForStaff(
  admin: { graphql: Function },
  staffId: string,
  isAdmin: boolean = false
): Promise<CompanyLocation[]> {
  const cacheKey = `staff:${staffId}:locations`;
  const cached = getCached<CompanyLocation[]>(cacheKey);
  if (cached) return cached;

  const allLocations: CompanyLocation[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(COMPANY_LOCATIONS_QUERY, {
      variables: { first: 100, after: cursor },
    });
    const json: CompanyLocationsResponse = await response.json();

    if (json.errors?.length) {
      throw new Error(
        `Failed to fetch company locations: ${json.errors.map((e) => e.message).join(", ")}`
      );
    }

    if (!json.data?.companyLocations) {
      break;
    }

    allLocations.push(...json.data.companyLocations.nodes);
    hasNextPage = json.data.companyLocations.pageInfo.hasNextPage;
    cursor = json.data.companyLocations.pageInfo.endCursor;
  }

  // Admins see all locations
  if (isAdmin) {
    console.log("[Companies] Admin user — returning all", allLocations.length, "locations");
    setCached(cacheKey, allLocations, "STAFF_ASSIGNMENTS");
    return allLocations;
  }

  // Filter by staff assignments stored in our database
  const dbAssignments = await prisma.staffAssignment.findMany({
    where: { staffId },
    select: { companyLocationId: true },
  });
  const assignedLocationIds = new Set(dbAssignments.map((a) => a.companyLocationId));

  // If no assignments exist in DB, staff member sees nothing
  if (assignedLocationIds.size === 0) {
    console.log("[Companies] No DB assignments found for staff", staffId);
    setCached(cacheKey, [], "STAFF_ASSIGNMENTS");
    return [];
  }

  const assignedLocations = allLocations.filter((loc) => assignedLocationIds.has(loc.id));
  console.log("[Companies] Total locations:", allLocations.length, "Assigned to staff", staffId, ":", assignedLocations.length);

  setCached(cacheKey, assignedLocations, "STAFF_ASSIGNMENTS");
  return assignedLocations;
}

export async function fetchCompanyLocationWithCatalogs(
  admin: { graphql: Function },
  companyLocationId: string
): Promise<CompanyLocation> {
  const cacheKey = `location:${companyLocationId}:catalogs`;
  // Temporarily skip cache for debugging
  // const cached = getCached<CompanyLocation>(cacheKey);
  // if (cached) return cached;

  const response = await admin.graphql(COMPANY_LOCATION_CATALOGS_QUERY, {
    variables: { companyLocationId },
  });
  const json: CompanyLocationCatalogsResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch location catalogs: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.companyLocation) {
    throw new Error(`Company location not found: ${companyLocationId}`);
  }

  setCached(cacheKey, json.data.companyLocation, "CATALOG_PUBLICATION");
  return json.data.companyLocation;
}

export async function fetchCompanyContacts(
  admin: { graphql: Function },
  companyLocationId: string
): Promise<CompanyContact[]> {
  const cacheKey = `location:${companyLocationId}:contacts`;
  const cached = getCached<CompanyContact[]>(cacheKey);
  if (cached) return cached;

  const response = await admin.graphql(COMPANY_CONTACTS_QUERY, {
    variables: { companyLocationId },
  });
  const json: CompanyContactsResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Failed to fetch contacts: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  if (!json.data?.companyLocation?.company?.contacts) {
    return [];
  }

  const contacts = json.data.companyLocation.company.contacts.nodes;
  setCached(cacheKey, contacts, "COMPANY_CONTACTS");
  return contacts;
}

// --- Company Creation ---

const COMPANY_CREATE_MUTATION = `#graphql
  mutation CompanyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company {
        id
        name
        locations(first: 1) {
          nodes {
            id
            name
            shippingAddress {
              address1
              city
              province
              country
              countryCode
              zip
            }
          }
        }
        contacts(first: 1) {
          nodes {
            id
            customer {
              id
              email
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PAYMENT_TERMS_TEMPLATES_QUERY = `#graphql
  query PaymentTermsTemplates {
    paymentTermsTemplates {
      id
      name
      paymentTermsType
      dueInDays
    }
  }
`;

interface CompanyCreateInput {
  company: {
    name: string;
    externalId?: string;
  };
  companyLocation?: {
    name: string;
    shippingAddress?: {
      address1?: string;
      address2?: string;
      city?: string;
      countryCode: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      zip?: string;
      zoneCode?: string;
    };
    billingSameAsShipping?: boolean;
    buyerExperienceConfiguration?: {
      paymentTermsTemplateId?: string;
    };
    taxExempt?: boolean;
    taxRegistrationId?: string;
  };
  companyContact?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
}

interface CompanyCreateResponse {
  data?: {
    companyCreate: {
      company: {
        id: string;
        name: string;
        locations: {
          nodes: Array<{
            id: string;
            name: string;
            shippingAddress: {
              address1: string | null;
              city: string | null;
              province: string | null;
              country: string | null;
              countryCode: string;
              zip: string | null;
            } | null;
          }>;
        };
        contacts: {
          nodes: Array<{
            id: string;
            customer: { id: string; email: string | null };
          }>;
        };
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface PaymentTermsTemplate {
  id: string;
  name: string;
  paymentTermsType: string;
  dueInDays: number | null;
}

interface PaymentTermsTemplatesResponse {
  data?: {
    paymentTermsTemplates: PaymentTermsTemplate[];
  };
  errors?: Array<{ message: string }>;
}

interface CreatedCompany {
  id: string;
  name: string;
  locations: {
    nodes: Array<{
      id: string;
      name: string;
      shippingAddress: {
        address1: string | null;
        city: string | null;
        province: string | null;
        country: string | null;
        countryCode: string;
        zip: string | null;
      } | null;
    }>;
  };
  contacts: {
    nodes: Array<{
      id: string;
      customer: { id: string; email: string | null };
    }>;
  };
}

export async function createCompany(
  admin: { graphql: Function },
  input: CompanyCreateInput,
): Promise<{ company: CreatedCompany | null; errors: string[] }> {
  const response = await admin.graphql(COMPANY_CREATE_MUTATION, {
    variables: { input },
  });
  const json: CompanyCreateResponse = await response.json();

  if (json.errors?.length) {
    console.error("[Companies] Create error:", json.errors);
    return { company: null, errors: json.errors.map((e) => e.message) };
  }

  const result = json.data?.companyCreate;
  if (result?.userErrors?.length) {
    return {
      company: null,
      errors: result.userErrors.map((e) => e.message),
    };
  }

  if (!result?.company) {
    return { company: null, errors: ["Company creation returned no data"] };
  }

  return { company: result.company, errors: [] };
}

export async function fetchPaymentTermsTemplates(
  admin: { graphql: Function },
): Promise<PaymentTermsTemplate[]> {
  const response = await admin.graphql(PAYMENT_TERMS_TEMPLATES_QUERY);
  const json: PaymentTermsTemplatesResponse = await response.json();

  if (json.errors?.length) {
    console.error("[Companies] Payment terms templates error:", json.errors);
    return [];
  }

  return json.data?.paymentTermsTemplates ?? [];
}
