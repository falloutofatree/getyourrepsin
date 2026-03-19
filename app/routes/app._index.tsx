import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  IndexTable,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { requireAuth, getStaffAssignedLocationIds } from "../lib/auth.server";
import { fetchCompanyLocationsForStaff } from "../lib/graphql/companies";
import { fetchRepDraftOrders } from "../lib/graphql/orders";
import { CompanySelector } from "../components/CompanySelector";
import { AppBranding } from "../components/AppBranding";
import { formatMoney, formatDate } from "../lib/utils/format";
import type { CompanyLocation, DraftOrder } from "../types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin, staffMember } = await requireAuth(request);
    console.log("[Dashboard] Staff member loaded:", staffMember.id, staffMember.firstName);

    let locations: CompanyLocation[] = [];
    let recentOrders: DraftOrder[] = [];

    try {
      locations = await fetchCompanyLocationsForStaff(admin, staffMember.id, staffMember.isAdmin);
      console.log("[Dashboard] Locations loaded:", locations.length);
    } catch (err) {
      console.error("[Dashboard] Error fetching locations:", err);
    }

    try {
      const allowedLocationIds = await getStaffAssignedLocationIds(staffMember);
      const draftOrdersResult = await fetchRepDraftOrders(admin, staffMember.id, 10, undefined, allowedLocationIds);
      recentOrders = draftOrdersResult.orders;
      console.log("[Dashboard] Draft orders loaded:", recentOrders.length);
    } catch (err) {
      console.error("[Dashboard] Error fetching draft orders:", err);
    }

    return json({
      staffMember: {
        firstName: staffMember.firstName,
        lastName: staffMember.lastName,
        id: staffMember.id,
        isAdmin: staffMember.isAdmin,
      },
      locations,
      recentOrders,
    });
  } catch (err) {
    console.error("[Dashboard] Fatal error in loader:", err);
    throw err;
  }
};

function statusBadge(status: string) {
  switch (status.toUpperCase()) {
    case "OPEN":
      return <Badge tone="attention">Open</Badge>;
    case "INVOICE_SENT":
      return <Badge tone="info">Invoice Sent</Badge>;
    case "COMPLETED":
      return <Badge tone="success">Completed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function Dashboard() {
  const { staffMember, locations, recentOrders } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const handleSelectLocation = (locationId: string) => {
    const numericId = locationId.replace(
      "gid://shopify/CompanyLocation/",
      ""
    );
    navigate(`/app/company/${numericId}`);
  };

  return (
    <>
      <AppBranding staffName={staffMember.firstName} />
      <Page>
        <TitleBar title="Dashboard" />
        <BlockStack gap="500">
          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <Text as="h2" variant="headingLg">
                  Your Accounts
                </Text>
                <CompanySelector
                  locations={locations as CompanyLocation[]}
                  onSelect={handleSelectLocation}
                />
              </BlockStack>
            </Layout.Section>
          </Layout>

          {recentOrders.length > 0 && (
            <Layout>
              <Layout.Section>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Recent Orders
                    </Text>
                    <IndexTable
                      itemCount={recentOrders.length}
                      headings={[
                        { title: "Order" },
                        { title: "Company" },
                        { title: "Total" },
                        { title: "Status" },
                        { title: "Date" },
                      ]}
                      selectable={false}
                    >
                      {(recentOrders as DraftOrder[]).map((order, index) => (
                        <IndexTable.Row
                          key={order.id}
                          id={order.id}
                          position={index}
                          onClick={() => {
                            const numericId = order.id.replace(
                              "gid://shopify/DraftOrder/",
                              ""
                            );
                            navigate(`/app/order/${numericId}`);
                          }}
                        >
                          <IndexTable.Cell>
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              {order.name}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {order.purchasingEntity?.company?.name ?? "—"}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {formatMoney(
                              order.totalPriceSet.shopMoney.amount,
                              order.totalPriceSet.shopMoney.currencyCode
                            )}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {statusBadge(order.status)}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {formatDate(order.createdAt)}
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          )}
        </BlockStack>
      </Page>
    </>
  );
}

export function ErrorBoundary() {
  return (
    <Page>
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" variant="bodyMd">
            We couldn't load your dashboard. Please try refreshing the page.
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
