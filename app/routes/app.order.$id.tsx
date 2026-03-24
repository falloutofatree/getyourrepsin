import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "@remix-run/react";
import { useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { requireAuth, getStaffAssignedLocationIds } from "../lib/auth.server";
import { fetchDraftOrderDetail } from "../lib/graphql/orders";
import { sendInvoice } from "../lib/graphql/draft-orders";
import { AppBranding } from "../components/AppBranding";
import { formatMoney, formatDate, formatAddress } from "../lib/utils/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, staffMember } = await requireAuth(request);

  const draftOrderId = `gid://shopify/DraftOrder/${params.id}`;
  const order = await fetchDraftOrderDetail(admin, draftOrderId);

  // Verify this order belongs to the current rep by checking tags
  // Tags use numeric staff ID (e.g. "rep:96369574082"), not full GID
  const numericStaffId = staffMember.id.replace("gid://shopify/StaffMember/", "");
  const isOwnOrder = order.tags?.some(
    (tag: string) => tag === `rep:${numericStaffId}`
  );

  // Admins can view any sales-rep-portal order
  if (!isOwnOrder && !staffMember.isAdmin) {
    throw new Response("Forbidden — this order does not belong to you", {
      status: 403,
    });
  }

  // Even if the rep created this order, verify they're still assigned to the company location
  const orderLocationId = order.purchasingEntity?.location?.id;
  if (orderLocationId && !staffMember.isAdmin) {
    const allowedLocationIds = await getStaffAssignedLocationIds(staffMember);
    if (allowedLocationIds && !allowedLocationIds.has(orderLocationId)) {
      throw new Response("Forbidden — you are no longer assigned to this company location", {
        status: 403,
      });
    }
  }

  return json({
    staffMember: {
      firstName: staffMember.firstName,
      canSendInvoice: staffMember.canSendInvoice,
    },
    order,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, staffMember } = await requireAuth(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "send-invoice") {
    if (!staffMember.canSendInvoice) {
      return json({
        success: false,
        errors: ["You do not have permission to send invoices"],
      });
    }

    const draftOrderId = `gid://shopify/DraftOrder/${params.id}`;
    const email = formData.get("email") as string;

    const result = await sendInvoice(admin, draftOrderId, email ? { to: email } : undefined);
    return json({
      success: result.success,
      errors: result.errors,
    });
  }

  return json({ success: false, errors: ["Unknown action"] });
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

export default function OrderDetail() {
  const { staffMember, order } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Invoice sent successfully!");
    } else if (fetcher.data?.success === false) {
      shopify.toast.show("Failed to send invoice", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSendInvoice = () => {
    const formData = new FormData();
    formData.set("intent", "send-invoice");
    if (order.email) {
      formData.set("email", order.email);
    }
    fetcher.submit(formData, { method: "POST" });
  };

  const lineItemRows = order.lineItems.nodes.map(
    (item: {
      title: string;
      variant?: { sku?: string | null; title?: string | null } | null;
      quantity: number;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }) => [
      item.title,
      item.variant?.title ?? "—",
      item.variant?.sku ?? "—",
      String(item.quantity),
      formatMoney(
        item.originalUnitPriceSet.shopMoney.amount,
        order.totalPriceSet.shopMoney.currencyCode
      ),
      formatMoney(
        String(
          parseFloat(item.originalUnitPriceSet.shopMoney.amount) * item.quantity
        ),
        order.totalPriceSet.shopMoney.currencyCode
      ),
    ]
  );

  const canSendInvoice =
    order.status.toUpperCase() === "OPEN" && staffMember.canSendInvoice;

  return (
    <>
      <AppBranding staffName={staffMember.firstName} />
      <Page
        backAction={{ content: "Orders", url: "/app/orders" }}
        title={order.name}
        titleMetadata={statusBadge(order.status)}
      >
        <TitleBar title={order.name} />
        <BlockStack gap="500">
          {fetcher.data?.success === false && (
            <Banner tone="critical">
              {(fetcher.data.errors as string[]).map((err, i) => (
                <p key={i}>{err}</p>
              ))}
            </Banner>
          )}

          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Line Items
                  </Text>
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                    ]}
                    headings={[
                      "Product",
                      "Variant",
                      "SKU",
                      "Qty",
                      "Unit Price",
                      "Total",
                    ]}
                    rows={lineItemRows}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Order Details
                    </Text>
                    <BlockStack gap="200">
                      {order.purchasingEntity && (
                        <>
                          <InlineStack align="space-between">
                            <Text as="span" variant="bodySm" tone="subdued">
                              Company
                            </Text>
                            <Text as="span" variant="bodySm">
                              {order.purchasingEntity.company?.name ?? "—"}
                            </Text>
                          </InlineStack>
                          <InlineStack align="space-between">
                            <Text as="span" variant="bodySm" tone="subdued">
                              Location
                            </Text>
                            <Text as="span" variant="bodySm">
                              {order.purchasingEntity.location?.name ?? "—"}
                            </Text>
                          </InlineStack>
                        </>
                      )}
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Customer
                        </Text>
                        <Text as="span" variant="bodySm">
                          {order.customer
                            ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim()
                            : "—"}
                        </Text>
                      </InlineStack>
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Email
                        </Text>
                        <Text as="span" variant="bodySm">
                          {order.email ?? "—"}
                        </Text>
                      </InlineStack>
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Created
                        </Text>
                        <Text as="span" variant="bodySm">
                          {formatDate(order.createdAt)}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Summary
                    </Text>
                    {order.subtotalPriceSet && (
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm">
                          Subtotal
                        </Text>
                        <Text as="span" variant="bodySm">
                          {formatMoney(
                            order.subtotalPriceSet.shopMoney.amount,
                            order.subtotalPriceSet.shopMoney.currencyCode
                          )}
                        </Text>
                      </InlineStack>
                    )}
                    {order.totalTaxSet && (
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm">
                          Tax
                        </Text>
                        <Text as="span" variant="bodySm">
                          {formatMoney(
                            order.totalTaxSet.shopMoney.amount,
                            order.totalTaxSet.shopMoney.currencyCode
                          )}
                        </Text>
                      </InlineStack>
                    )}
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        Total
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        {formatMoney(
                          order.totalPriceSet.shopMoney.amount,
                          order.totalPriceSet.shopMoney.currencyCode
                        )}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </Card>

                {canSendInvoice && (
                  <Card>
                    <Button
                      variant="primary"
                      fullWidth
                      onClick={handleSendInvoice}
                      loading={fetcher.state === "submitting"}
                    >
                      Send Invoice
                    </Button>
                  </Card>
                )}

                {order.invoiceUrl && (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        Invoice Link
                      </Text>
                      <Button
                        url={order.invoiceUrl}
                        external
                        fullWidth
                      >
                        View Invoice
                      </Button>
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </Layout.Section>
          </Layout>

          {order.shippingAddress && (
            <Layout>
              <Layout.Section>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      Shipping Address
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {formatAddress(order.shippingAddress)}
                    </Text>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          )}

          {order.note2 && (
            <Layout>
              <Layout.Section>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      Notes
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {order.note2}
                    </Text>
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
    <Page backAction={{ content: "Orders", url: "/app/orders" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Order Not Found or Access Denied
          </Text>
          <Text as="p" variant="bodyMd">
            This order may not exist or you may not have permission to view it.
          </Text>
          <Button url="/app/orders">Back to Orders</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
