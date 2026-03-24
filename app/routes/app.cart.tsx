import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  Select,
  TextField,
  DataTable,
  Banner,
  InlineStack,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import {
  requireStaffAccess,
  validateOrderProducts,
  validateCompanyContact,
} from "../lib/auth.server";
import { fetchCompanyContacts, fetchCompanyLocationWithCatalogs } from "../lib/graphql/companies";
import { createDraftOrder, sendInvoice } from "../lib/graphql/draft-orders";
import { sendSlackNotification } from "../lib/slack.server";
import { useCartContext } from "../components/CartProvider";
import { OrderConfirmation } from "../components/OrderConfirmation";
import { formatMoney, formatAddress } from "../lib/utils/format";
import type { CompanyContact } from "../types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");

  if (!locationId) {
    return json({
      contacts: [] as CompanyContact[],
      locationData: null,
      canSendInvoice: false,
    });
  }

  const { admin, staffMember } = await requireStaffAccess(request, locationId);
  const [contacts, location] = await Promise.all([
    fetchCompanyContacts(admin, locationId),
    fetchCompanyLocationWithCatalogs(admin, locationId),
  ]);

  return json({
    contacts,
    locationData: {
      shippingAddress: location.shippingAddress,
      billingAddress: location.billingAddress,
    },
    canSendInvoice: staffMember.canSendInvoice,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const companyLocationId = formData.get("companyLocationId") as string;
  const companyId = formData.get("companyId") as string;
  const contactId = formData.get("contactId") as string;
  const contactEmail = formData.get("contactEmail") as string;
  const note = formData.get("note") as string;
  const lineItemsJson = formData.get("lineItems") as string;
  const sendInvoiceFlag = formData.get("sendInvoice") === "true";
  const shippingAddressJson = formData.get("shippingAddress") as string;
  const billingAddressJson = formData.get("billingAddress") as string;

  if (!companyLocationId || !companyId || !contactId || !lineItemsJson) {
    return json(
      { success: false, errors: ["Missing required fields"], draftOrder: null },
      { status: 400 }
    );
  }

  const { admin, staffMember, shop } = await requireStaffAccess(
    request,
    companyLocationId
  );

  const lineItems: Array<{
    variantId: string;
    quantity: number;
    productId: string;
  }> = JSON.parse(lineItemsJson);

  // Validate products are in the catalog
  const productIds = [...new Set(lineItems.map((li) => li.productId))];
  const validationResult = await validateOrderProducts(
    admin,
    companyLocationId,
    productIds
  );

  if (!validationResult.valid) {
    return json(
      {
        success: false,
        errors: [
          `Some products are not available in this catalog: ${validationResult.invalidProducts.join(", ")}`,
        ],
        draftOrder: null,
      },
      { status: 400 }
    );
  }

  // Validate company contact
  const contactValid = await validateCompanyContact(
    admin,
    companyLocationId,
    contactId
  );
  if (!contactValid) {
    return json(
      {
        success: false,
        errors: ["Selected contact does not belong to this company"],
        draftOrder: null,
      },
      { status: 400 }
    );
  }

  const shippingAddress = shippingAddressJson
    ? JSON.parse(shippingAddressJson)
    : null;
  const billingAddress = billingAddressJson
    ? JSON.parse(billingAddressJson)
    : null;

  // Create draft order
  const repName = `${staffMember.firstName} ${staffMember.lastName}`.trim();
  const result = await createDraftOrder(admin, {
    companyId,
    companyLocationId,
    companyContactId: contactId,
    customerEmail: contactEmail,
    lineItems: lineItems.map((li) => ({
      variantId: li.variantId,
      quantity: li.quantity,
    })),
    note: note
      ? `${note}\n\nOrder placed by ${repName} via Sales Portal`
      : `Order placed by ${repName} via Sales Portal`,
    tags: ["sales-rep-portal", `rep:${staffMember.id.replace("gid://shopify/StaffMember/", "")}`],
    shippingAddress,
    billingAddress,
  });

  if (result.errors.length > 0) {
    return json({
      success: false,
      errors: result.errors,
      draftOrder: null,
    });
  }

  // Send invoice if requested AND rep has permission
  let invoiceSent = false;
  const canSend = staffMember.canSendInvoice;

  if (sendInvoiceFlag && canSend && result.draftOrder) {
    const invoiceResult = await sendInvoice(admin, result.draftOrder.id, {
      to: contactEmail,
    });
    invoiceSent = invoiceResult.success;
    if (!invoiceResult.success) {
      return json({
        success: true,
        draftOrder: result.draftOrder,
        invoiceSent: false,
        invoiceErrors: invoiceResult.errors,
        errors: [],
      });
    }
  }

  // Send Slack notification when rep doesn't have invoice permission
  if (!canSend && result.draftOrder) {
    const repName = `${staffMember.firstName} ${staffMember.lastName}`.trim();
    const companyName = formData.get("companyName") as string || "Unknown";
    const locationName = formData.get("locationName") as string || "Unknown";
    const total = result.draftOrder.totalPriceSet?.shopMoney;

    sendSlackNotification(shop, {
      orderName: result.draftOrder.name,
      repName,
      companyName,
      locationName,
      totalAmount: total?.amount ?? "0.00",
      currencyCode: total?.currencyCode ?? "USD",
      draftOrderId: result.draftOrder.id,
      shopDomain: shop,
    }).catch((err) => console.error("[Cart] Slack notification failed:", err));
  }

  return json({
    success: true,
    draftOrder: result.draftOrder,
    invoiceSent,
    errors: [],
  });
};

export default function CartReview() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const { cart, setContact, setNote, clearCart, totalItems, subtotal } =
    useCartContext();

  const [selectedContactId, setSelectedContactId] = useState(
    cart.companyContactId || ""
  );

  const contacts = (loaderData.contacts ?? []) as CompanyContact[];
  const locationData = loaderData.locationData;

  // Load contacts when component mounts
  const contactFetcher = useFetcher<typeof loader>();

  const canSendInvoice =
    (contactFetcher.data as typeof loaderData)?.canSendInvoice ??
    loaderData.canSendInvoice ??
    false;
  useEffect(() => {
    if (cart.companyLocationId && contacts.length === 0) {
      contactFetcher.load(
        `/app/cart?locationId=${encodeURIComponent(cart.companyLocationId)}`
      );
    }
  }, [cart.companyLocationId]);

  const availableContacts: CompanyContact[] =
    (contactFetcher.data?.contacts as CompanyContact[] | undefined) ?? contacts;

  const contactOptions = availableContacts.map((c) => ({
    label: `${c.customer.firstName} ${c.customer.lastName} (${c.customer.email})`,
    value: c.id,
  }));

  // Auto-select main contact
  useEffect(() => {
    if (!selectedContactId && availableContacts.length > 0) {
      const mainContact = availableContacts.find((c) => c.isMainContact);
      const contactToSelect = mainContact ?? availableContacts[0];
      setSelectedContactId(contactToSelect.id);
      setContact(contactToSelect.id);
    }
  }, [availableContacts, selectedContactId, setContact]);

  const selectedContact = availableContacts.find(
    (c) => c.id === selectedContactId
  );

  const handleContactChange = useCallback(
    (value: string) => {
      setSelectedContactId(value);
      setContact(value);
    },
    [setContact]
  );

  const handleSubmit = useCallback(
    (withInvoice: boolean) => {
      if (!selectedContact) {
        shopify.toast.show("Please select a contact", { isError: true });
        return;
      }

      const shippingAddress =
        (contactFetcher.data?.locationData as typeof locationData)
          ?.shippingAddress ??
        locationData?.shippingAddress;
      const billingAddress =
        (contactFetcher.data?.locationData as typeof locationData)
          ?.billingAddress ??
        locationData?.billingAddress;

      const formData = new FormData();
      formData.set("companyLocationId", cart.companyLocationId);
      formData.set("companyId", cart.companyId);
      formData.set("contactId", selectedContact.id);
      formData.set("contactEmail", selectedContact.customer.email);
      formData.set("note", cart.note);
      formData.set("sendInvoice", String(withInvoice));
      formData.set(
        "lineItems",
        JSON.stringify(
          cart.items.map((item) => ({
            variantId: item.variantId,
            productId: item.productId,
            quantity: item.quantity,
          }))
        )
      );
      formData.set("companyName", cart.companyName);
      formData.set("locationName", cart.locationName);
      if (shippingAddress) {
        formData.set("shippingAddress", JSON.stringify(shippingAddress));
      }
      if (billingAddress) {
        formData.set("billingAddress", JSON.stringify(billingAddress));
      }

      fetcher.submit(formData, { method: "POST" });
    },
    [selectedContact, cart, fetcher, locationData, contactFetcher.data, shopify]
  );

  // Handle successful order creation
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.draftOrder) {
      shopify.toast.show("Draft order created!");
      clearCart();
    }
  }, [fetcher.data, shopify, clearCart]);

  if (cart.items.length === 0 && !fetcher.data?.success) {
    return (
      <Page backAction={{ content: "Dashboard", url: "/app" }} title="Cart">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Your cart is empty
            </Text>
            <Text as="p" variant="bodyMd">
              Select a company and add products to your cart first.
            </Text>
            <Button url="/app">Go to Dashboard</Button>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  if (fetcher.data?.success && fetcher.data?.draftOrder) {
    const draftOrder = fetcher.data.draftOrder;
    return (
      <Page title="Order Confirmation">
        <TitleBar title="Order Confirmation" />
        <OrderConfirmation
          success
          draftOrderName={draftOrder.name}
          draftOrderId={draftOrder.id}
          totalAmount={draftOrder.totalPriceSet.shopMoney.amount}
          currencyCode={draftOrder.totalPriceSet.shopMoney.currencyCode}
          invoiceSent={fetcher.data.invoiceSent}
          onNewOrder={() => navigate("/app")}
          onViewOrder={() => {
            const numericId = draftOrder.id.replace(
              "gid://shopify/DraftOrder/",
              ""
            );
            navigate(`/app/order/${numericId}`);
          }}
        />
      </Page>
    );
  }

  const isSubmitting = fetcher.state === "submitting";
  const currencyCode = "USD";
  const shippingAddr =
    (contactFetcher.data?.locationData as typeof locationData)
      ?.shippingAddress ??
    locationData?.shippingAddress;

  const numericLocationId = cart.companyLocationId.replace(
    "gid://shopify/CompanyLocation/",
    ""
  );

  const tableRows = cart.items.map((item) => [
    item.productTitle,
    item.variantTitle === "Default Title" ? "—" : item.variantTitle,
    item.sku || "—",
    String(item.quantity),
    formatMoney(item.price, currencyCode),
    formatMoney(String(parseFloat(item.price) * item.quantity), currencyCode),
  ]);

  return (
    <Page
      backAction={{
        content: "Back to Catalog",
        url: `/app/company/${numericLocationId}`,
      }}
      title="Review Order"
    >
      <TitleBar title="Review Order" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Ordering for: {cart.companyName} — {cart.locationName}
                  </Text>
                  {shippingAddr && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shipping to: {formatAddress(shippingAddr)}
                    </Text>
                  )}
                </BlockStack>
              </Card>

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
                      "Price",
                      "Total",
                    ]}
                    rows={tableRows}
                    totals={[
                      "",
                      "",
                      "",
                      String(totalItems),
                      "",
                      formatMoney(String(subtotal), currencyCode),
                    ]}
                    showTotalsInFooter
                  />
                </BlockStack>
              </Card>

              {fetcher.data?.success === false && fetcher.data.errors && (
                <Banner tone="critical">
                  {(fetcher.data.errors as string[]).map((err, i) => (
                    <p key={i}>{err}</p>
                  ))}
                </Banner>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Contact & Notes
                  </Text>
                  {contactOptions.length > 0 ? (
                    <Select
                      label="Invoice contact"
                      options={contactOptions}
                      value={selectedContactId}
                      onChange={handleContactChange}
                    />
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Loading contacts...
                    </Text>
                  )}
                  <TextField
                    label="Order notes"
                    value={cart.note}
                    onChange={setNote}
                    multiline={3}
                    autoComplete="off"
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodyMd" fontWeight="bold">
                      Subtotal
                    </Text>
                    <Text as="span" variant="bodyMd" fontWeight="bold">
                      {formatMoney(String(subtotal), currencyCode)}
                    </Text>
                  </InlineStack>
                  <Button
                    variant="primary"
                    fullWidth
                    onClick={() => handleSubmit(false)}
                    loading={isSubmitting}
                    disabled={!selectedContactId}
                  >
                    Create Draft Order
                  </Button>
                  {canSendInvoice && (
                    <Button
                      fullWidth
                      onClick={() => handleSubmit(true)}
                      loading={isSubmitting}
                      disabled={!selectedContactId}
                    >
                      Create & Send Invoice
                    </Button>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
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
            An error occurred while processing your order. Please try again.
          </Text>
          <Button url="/app">Back to Dashboard</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
