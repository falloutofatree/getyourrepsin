import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { assignCatalogToNewLocation } from "../lib/graphql/catalogs";

/**
 * Auto-assigns a B2B catalog to company locations created OUTSIDE the rep
 * portal (i.e. directly in the Shopify admin). Shopify has no native
 * "catalog by country" rule, so without this a location created in the admin
 * gets no catalog and falls back to default shop pricing.
 *
 * The portal's own create flow assigns the catalog inline, so this handler
 * skips any location that already has one.
 */

const LOCATION_STATE_QUERY = `#graphql
  query CompanyLocationCatalogState($id: ID!) {
    companyLocation(id: $id) {
      id
      name
      shippingAddress {
        countryCode
      }
      billingAddress {
        countryCode
      }
      catalogs(first: 10) {
        nodes {
          id
          title
          status
        }
      }
    }
  }
`;

interface LocationStateResponse {
  data?: {
    companyLocation: {
      id: string;
      name: string;
      shippingAddress: { countryCode: string | null } | null;
      billingAddress: { countryCode: string | null } | null;
      catalogs: { nodes: Array<{ id: string; title: string; status: string }> };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // The app was uninstalled between the event and delivery — nothing to do,
  // but still ack so Shopify doesn't retry.
  if (!admin) return new Response();

  const locationId = (payload as { admin_graphql_api_id?: string })
    .admin_graphql_api_id;

  if (!locationId) {
    console.error("[Webhook company_locations/create] No location GID in payload");
    return new Response();
  }

  try {
    // Read the country and existing catalogs from the API rather than the
    // payload — the payload's address may lag behind the created location.
    const response = await admin.graphql(LOCATION_STATE_QUERY, {
      variables: { id: locationId },
    });
    const json: LocationStateResponse = await response.json();

    if (json.errors?.length) {
      console.error(
        "[Webhook company_locations/create] Location query failed:",
        json.errors.map((e) => e.message).join(", "),
      );
      return new Response();
    }

    const location = json.data?.companyLocation;
    if (!location) {
      console.error(
        `[Webhook company_locations/create] Location ${locationId} not found`,
      );
      return new Response();
    }

    const existingCatalog = location.catalogs.nodes[0];
    if (existingCatalog) {
      console.log(
        `[Webhook company_locations/create] ${location.name} already on catalog "${existingCatalog.title}" — skipping`,
      );
      return new Response();
    }

    const countryCode =
      location.shippingAddress?.countryCode ??
      location.billingAddress?.countryCode ??
      null;

    const result = await assignCatalogToNewLocation(
      admin,
      shop,
      locationId,
      countryCode,
    );

    if (result.errors.length > 0) {
      console.error(
        `[Webhook company_locations/create] Catalog assignment failed for ${location.name}:`,
        result.errors.join(", "),
      );
    }
  } catch (err) {
    // Never throw out of a webhook — a non-2xx makes Shopify retry, and a
    // failure here is not something a retry will fix.
    console.error("[Webhook company_locations/create] Unexpected error:", err);
  }

  return new Response();
};
