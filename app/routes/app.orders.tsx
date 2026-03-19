import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  IndexTable,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { requireAuth, getStaffAssignedLocationIds } from "../lib/auth.server";
import { fetchRepDraftOrders } from "../lib/graphql/orders";
import { AppBranding } from "../components/AppBranding";
import { formatMoney, formatDate } from "../lib/utils/format";
import type { DraftOrder } from "../types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, staffMember } = await requireAuth(request);

  const allowedLocationIds = await getStaffAssignedLocationIds(staffMember);
  const result = await fetchRepDraftOrders(admin, staffMember.id, 50, undefined, allowedLocationIds);

  return json({
    staffMember: { firstName: staffMember.firstName },
    orders: result.orders,
    hasMore: result.pageInfo.hasNextPage,
  });
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

export default function OrderHistory() {
  const { staffMember, orders } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <>
      <AppBranding staffName={staffMember.firstName} />
      <Page title="My Orders">
        <TitleBar title="My Orders" />
        {orders.length === 0 ? (
          <Card>
            <EmptyState
              heading="No orders yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              action={{ content: "Place an Order", url: "/app" }}
            >
              <p>
                You haven't created any orders through the Sales Portal yet.
                Start by selecting a company on the dashboard.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <IndexTable
              itemCount={orders.length}
              headings={[
                { title: "Order" },
                { title: "Company" },
                { title: "Customer" },
                { title: "Total" },
                { title: "Status" },
                { title: "Date" },
              ]}
              selectable={false}
            >
              {(orders as DraftOrder[]).map((order, index) => (
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
                    {order.customer
                      ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim() ||
                        order.customer.email
                      : "—"}
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
          </Card>
        )}
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
            We couldn't load your orders. Please try refreshing the page.
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
