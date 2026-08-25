import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useFetcher,
} from "@remix-run/react";
import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  Banner,
  InlineStack,
  InlineGrid,
  EmptyState,
  Select,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { requireStaffAccess } from "../lib/auth.server";
import {
  fetchCompanyLocationWithCatalogs,
  assignCompanyLocationShippingAddress,
} from "../lib/graphql/companies";
import { fetchCatalogForLocation } from "../lib/graphql/catalogs";
import { fetchCatalogProducts } from "../lib/graphql/products";
import { fetchPriceListPrices } from "../lib/graphql/price-list";
import { priceMapToObject } from "../lib/utils/price-resolver";
import { AppBranding } from "../components/AppBranding";
import { ProductGrid } from "../components/ProductGrid";
import { CartSummary } from "../components/CartSummary";
import { FloatingCartButton } from "../components/FloatingCartButton";
import { CountryCombobox } from "../components/CountryCombobox";
import { ZoneCombobox } from "../components/ZoneCombobox";
import { PhoneCodeCombobox } from "../components/PhoneCodeCombobox";
import { toE164 } from "../lib/utils/phone";
import { useCartContext } from "../components/CartProvider";
import { getAllCountries } from "../lib/data/countries.server";
import { sendAddressChangeSlackNotification } from "../lib/slack.server";
import { invalidatePattern } from "../lib/cache.server";
import prisma from "../db.server";
import type { Product, PageInfo } from "../types";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const companyLocationId = `gid://shopify/CompanyLocation/${params.id}`;
  const { admin, staffMember, shop } = await requireStaffAccess(
    request,
    companyLocationId
  );

  const location = await fetchCompanyLocationWithCatalogs(
    admin,
    companyLocationId
  );

  // Try from companyLocation.catalogs first
  let activeCatalog = location.catalogs?.nodes?.find(
    (c) => c.publication
  );

  // Fallback: resolve the catalog this location's country maps to. Never fall
  // back to a market catalog — that is what showed non-US companies US pricing.
  let catalogUnassigned = false;
  if (!activeCatalog) {
    catalogUnassigned = true;
    const locationCountry =
      location.shippingAddress?.countryCode ?? location.billingAddress?.countryCode;
    const rootCatalog = await fetchCatalogForLocation(
      admin,
      shop,
      companyLocationId,
      locationCountry,
    );
    if (rootCatalog) {
      activeCatalog = {
        id: rootCatalog.id,
        title: rootCatalog.title,
        status: rootCatalog.status,
        publication: rootCatalog.publication,
        priceList: rootCatalog.priceList,
      };
      console.log(
        "[Catalog] Location unassigned — using mapped catalog:",
        activeCatalog.id,
        activeCatalog.title,
      );
    }
  }

  if (!activeCatalog?.publication) {
    return json({
      staffMember: { firstName: staffMember.firstName },
      location: {
        id: location.id,
        name: location.name,
        company: location.company,
        shippingAddress: location.shippingAddress,
      },
      countries: getAllCountries(),
      products: [] as Product[],
      pageInfo: { hasNextPage: false, endCursor: null } as PageInfo,
      priceMap: {} as Record<string, string>,
      currencyCode: "USD",
      publicationId: null as string | null,
      noCatalog: true,
      catalogTitle: null as string | null,
      catalogUnassigned,
      filterableCollections: [] as Array<{ id: string; title: string; numericId: string }>,
      currentSearch: "",
      currentCollection: "",
    });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const searchQuery = url.searchParams.get("search") ?? "";
  const collectionNumericId = url.searchParams.get("collection") ?? "";

  // Build product query filter
  const queryParts: string[] = [];
  if (collectionNumericId) queryParts.push(`collection_id:${collectionNumericId}`);
  if (searchQuery) queryParts.push(`title:${searchQuery} OR sku:${searchQuery}`);
  const productQuery = queryParts.length > 0 ? queryParts.join(" ") : undefined;

  // Fetch filterable collections from DB
  const filterableCollections = await prisma.filterableCollection.findMany({
    where: { shop },
    orderBy: { title: "asc" },
  });

  const [productsResult, priceMap] = await Promise.all([
    fetchCatalogProducts(admin, activeCatalog.publication.id, cursor, true, productQuery),
    activeCatalog.priceList
      ? fetchPriceListPrices(admin, activeCatalog.priceList.id)
      : Promise.resolve(new Map<string, string>()),
  ]);

  return json({
    staffMember: { firstName: staffMember.firstName },
    location: {
      id: location.id,
      name: location.name,
      company: location.company,
      shippingAddress: location.shippingAddress,
    },
    countries: getAllCountries(),
    products: productsResult.products,
    pageInfo: productsResult.pageInfo,
    priceMap: priceMapToObject(priceMap),
    currencyCode: activeCatalog.priceList?.currency ?? "USD",
    publicationId: activeCatalog.publication.id,
    noCatalog: false,
    catalogTitle: activeCatalog.title,
    // True when the location isn't actually a context of this catalog — prices
    // shown here are the country's mapped prices, but checkout will not match
    // until someone assigns the location in Shopify.
    catalogUnassigned,
    filterableCollections: filterableCollections.map((c) => ({
      id: c.collectionId,
      title: c.title,
      numericId: c.numericId,
    })),
    currentSearch: searchQuery,
    currentCollection: collectionNumericId,
  });
};

const PHONE_REGEX = /^[+\-()\s\d]+$/;
const PHONE_REGEX_CLIENT = /^[+\-()\s\d]+$/;

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const companyLocationId = `gid://shopify/CompanyLocation/${params.id}`;
  const { admin, staffMember, shop } = await requireStaffAccess(
    request,
    companyLocationId
  );

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "update-shipping-address") {
    return json({ success: false, errors: ["Unknown intent"] }, { status: 400 });
  }

  const countryCode = (formData.get("countryCode") as string ?? "").trim().toUpperCase();
  const zoneCode = (formData.get("zoneCode") as string ?? "").trim().toUpperCase();
  const address1 = (formData.get("address1") as string ?? "").trim();
  const address2 = (formData.get("address2") as string ?? "").trim();
  const city = (formData.get("city") as string ?? "").trim();
  const zip = (formData.get("zip") as string ?? "").trim();
  const recipient = (formData.get("recipient") as string ?? "").trim();
  const firstName = (formData.get("firstName") as string ?? "").trim();
  const lastName = (formData.get("lastName") as string ?? "").trim();
  const phone = (formData.get("phone") as string ?? "").trim();

  const errors: string[] = [];
  if (!countryCode) errors.push("Country is required");
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    errors.push("Invalid country code");
  }
  if (phone && !PHONE_REGEX.test(phone)) {
    errors.push("Phone contains invalid characters");
  }

  if (errors.length > 0) {
    return json({ success: false, errors }, { status: 400 });
  }

  // Fetch current address for diff before mutating
  const before = await fetchCompanyLocationWithCatalogs(admin, companyLocationId);
  const beforeAddr = before.shippingAddress;

  const result = await assignCompanyLocationShippingAddress(admin, companyLocationId, {
    address1: address1 || undefined,
    address2: address2 || undefined,
    city: city || undefined,
    zip: zip || undefined,
    recipient: recipient || undefined,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    phone: phone || undefined,
    zoneCode: zoneCode || undefined,
    countryCode,
  });

  if (!result.success) {
    return json({ success: false, errors: result.errors }, { status: 400 });
  }

  invalidatePattern(`location:${companyLocationId}`);

  // Build diff for Slack
  const fieldsToCompare: Array<{
    label: string;
    before: string | null | undefined;
    after: string;
  }> = [
    { label: "Address 1", before: beforeAddr?.address1, after: address1 },
    { label: "Address 2", before: beforeAddr?.address2, after: address2 },
    { label: "City", before: beforeAddr?.city, after: city },
    { label: "ZIP", before: beforeAddr?.zip, after: zip },
    { label: "State/Region", before: beforeAddr?.zoneCode, after: zoneCode },
    { label: "Country", before: beforeAddr?.countryCode, after: countryCode },
    { label: "Recipient", before: beforeAddr?.recipient, after: recipient },
    { label: "First name", before: beforeAddr?.firstName, after: firstName },
    { label: "Last name", before: beforeAddr?.lastName, after: lastName },
    { label: "Phone", before: beforeAddr?.phone, after: phone },
  ];
  const changes = fieldsToCompare
    .filter((f) => (f.before ?? "") !== (f.after ?? ""))
    .map((f) => ({
      field: f.label,
      before: f.before ?? "",
      after: f.after ?? "",
    }));

  if (changes.length > 0) {
    const repName = `${staffMember.firstName} ${staffMember.lastName}`.trim();
    const locationNumericId = (params.id ?? "").trim();
    sendAddressChangeSlackNotification(shop, {
      repName,
      repEmail: staffMember.email ?? "",
      companyName: before.company.name,
      locationName: before.name,
      changes,
      shopDomain: shop,
      locationNumericId,
    }).catch((err) =>
      console.error("[CompanyDetail] Slack notification failed:", err)
    );
  }

  return json({ success: true, errors: [] as string[] });
};

export default function CompanyCatalog() {
  const {
    staffMember,
    location,
    countries,
    products: initialProducts,
    pageInfo: initialPageInfo,
    priceMap,
    currencyCode,
    noCatalog,
    catalogTitle,
    catalogUnassigned,
    filterableCollections,
    currentSearch,
    currentCollection,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const { setCompany, addItem, cart } = useCartContext();
  const fetcher = useFetcher<typeof loader>();
  const addressFetcher = useFetcher<{ success: boolean; errors: string[] }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Edit shipping address modal state
  const initialAddr = location.shippingAddress;
  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [addressConfirmOpen, setAddressConfirmOpen] = useState(false);
  const [editAddress1, setEditAddress1] = useState(initialAddr?.address1 ?? "");
  const [editAddress2, setEditAddress2] = useState(initialAddr?.address2 ?? "");
  const [editCity, setEditCity] = useState(initialAddr?.city ?? "");
  const [editZip, setEditZip] = useState(initialAddr?.zip ?? "");
  const [editCountryCode, setEditCountryCode] = useState(
    initialAddr?.countryCode ?? ""
  );
  const [editZoneCode, setEditZoneCode] = useState(initialAddr?.zoneCode ?? "");
  const [editRecipient, setEditRecipient] = useState(initialAddr?.recipient ?? "");
  const [editFirstName, setEditFirstName] = useState(initialAddr?.firstName ?? "");
  const [editLastName, setEditLastName] = useState(initialAddr?.lastName ?? "");
  const [editPhone, setEditPhone] = useState(initialAddr?.phone ?? "");
  const [editPhoneCode, setEditPhoneCode] = useState("+1");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const resetEditForm = useCallback(() => {
    setEditAddress1(initialAddr?.address1 ?? "");
    setEditAddress2(initialAddr?.address2 ?? "");
    setEditCity(initialAddr?.city ?? "");
    setEditZip(initialAddr?.zip ?? "");
    setEditCountryCode(initialAddr?.countryCode ?? "");
    setEditZoneCode(initialAddr?.zoneCode ?? "");
    setEditRecipient(initialAddr?.recipient ?? "");
    setEditFirstName(initialAddr?.firstName ?? "");
    setEditLastName(initialAddr?.lastName ?? "");
    setEditPhone(initialAddr?.phone ?? "");
    setEditPhoneCode("+1");
    setPhoneError(null);
  }, [initialAddr]);

  const openAddressModal = useCallback(() => {
    resetEditForm();
    setAddressModalOpen(true);
  }, [resetEditForm]);

  const closeAddressModal = useCallback(() => {
    setAddressModalOpen(false);
    setAddressConfirmOpen(false);
  }, []);

  const fullPhone = toE164(editPhoneCode, editPhone);

  const diff = useMemo(() => {
    const fields: Array<{ label: string; before: string; after: string }> = [
      { label: "Recipient", before: initialAddr?.recipient ?? "", after: editRecipient },
      { label: "First name", before: initialAddr?.firstName ?? "", after: editFirstName },
      { label: "Last name", before: initialAddr?.lastName ?? "", after: editLastName },
      { label: "Address 1", before: initialAddr?.address1 ?? "", after: editAddress1 },
      { label: "Address 2", before: initialAddr?.address2 ?? "", after: editAddress2 },
      { label: "City", before: initialAddr?.city ?? "", after: editCity },
      { label: "State/Region", before: initialAddr?.zoneCode ?? "", after: editZoneCode },
      { label: "Country", before: initialAddr?.countryCode ?? "", after: editCountryCode },
      { label: "ZIP", before: initialAddr?.zip ?? "", after: editZip },
      { label: "Phone", before: initialAddr?.phone ?? "", after: fullPhone },
    ];
    return fields.filter((f) => f.before !== f.after);
  }, [
    initialAddr,
    editRecipient,
    editFirstName,
    editLastName,
    editAddress1,
    editAddress2,
    editCity,
    editZoneCode,
    editCountryCode,
    editZip,
    fullPhone,
  ]);

  const handleReviewClick = useCallback(() => {
    if (editPhone && !PHONE_REGEX_CLIENT.test(editPhone)) {
      setPhoneError("Phone contains invalid characters");
      return;
    }
    setPhoneError(null);
    setAddressConfirmOpen(true);
  }, [editPhone]);

  const handleConfirmSubmit = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "update-shipping-address");
    formData.set("countryCode", editCountryCode);
    formData.set("zoneCode", editZoneCode);
    formData.set("address1", editAddress1);
    formData.set("address2", editAddress2);
    formData.set("city", editCity);
    formData.set("zip", editZip);
    formData.set("recipient", editRecipient);
    formData.set("firstName", editFirstName);
    formData.set("lastName", editLastName);
    formData.set("phone", fullPhone);
    addressFetcher.submit(formData, { method: "POST" });
  }, [
    editCountryCode,
    editZoneCode,
    editAddress1,
    editAddress2,
    editCity,
    editZip,
    editRecipient,
    editFirstName,
    editLastName,
    fullPhone,
    addressFetcher,
  ]);

  // Close modal + reload page on successful update; on server error, return
  // to the form view so the error banner is visible and the rep can edit.
  useEffect(() => {
    if (addressFetcher.state !== "idle" || !addressFetcher.data) return;
    if (addressFetcher.data.success) {
      shopify.toast.show("Shipping address updated");
      closeAddressModal();
      navigate(`/app/company/${location.id.replace("gid://shopify/CompanyLocation/", "")}`, {
        replace: true,
      });
    } else if ((addressFetcher.data.errors ?? []).length > 0) {
      setAddressConfirmOpen(false);
    }
  }, [addressFetcher.state, addressFetcher.data, shopify, closeAddressModal, navigate, location.id]);

  const [allProducts, setAllProducts] = useState<Product[]>(
    initialProducts as Product[]
  );
  const [currentPageInfo, setCurrentPageInfo] = useState(initialPageInfo);
  const [searchValue, setSearchValue] = useState(currentSearch ?? "");
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Set company context in cart when entering this page
  useEffect(() => {
    if (location.id !== cart.companyLocationId) {
      setCompany({
        companyLocationId: location.id,
        companyId: location.company.id,
        companyName: location.company.name,
        locationName: location.name,
      });
    }
  }, [location, cart.companyLocationId, setCompany]);

  // Append fetcher results for "Load More"
  useEffect(() => {
    if (fetcher.data && fetcher.data.products) {
      const newProducts = fetcher.data.products as Product[];
      setAllProducts((prev) => [...prev, ...newProducts]);
      setCurrentPageInfo(fetcher.data.pageInfo as PageInfo);
    }
  }, [fetcher.data]);

  // Reset products when initial data changes (e.g. new search)
  useEffect(() => {
    setAllProducts(initialProducts as Product[]);
    setCurrentPageInfo(initialPageInfo);
  }, [initialProducts, initialPageInfo]);

  const handleCollectionChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      if (value) {
        params.set("collection", value);
      } else {
        params.delete("collection");
      }
      params.delete("cursor");
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchValue(value);
      if (searchTimeout) clearTimeout(searchTimeout);
      const timeout = setTimeout(() => {
        const params = new URLSearchParams(searchParams);
        if (value.trim()) {
          params.set("search", value.trim());
        } else {
          params.delete("search");
        }
        params.delete("cursor");
        setSearchParams(params);
      }, 400);
      setSearchTimeout(timeout);
    },
    [searchParams, setSearchParams, searchTimeout],
  );

  const handleLoadMore = useCallback(() => {
    if (!currentPageInfo.hasNextPage || !currentPageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("cursor", currentPageInfo.endCursor);
    fetcher.load(`/app/company/${location.id.replace("gid://shopify/CompanyLocation/", "")}?${params}`);
  }, [currentPageInfo, fetcher, location.id, searchParams]);

  const handleAddToCart = useCallback(
    (item: {
      variantId: string;
      productId: string;
      productTitle: string;
      variantTitle: string;
      sku: string;
      quantity: number;
      price: string;
      imageUrl: string;
    }) => {
      addItem(item);
    },
    [addItem]
  );

  const handleReviewOrder = useCallback(() => {
    navigate("/app/cart");
  }, [navigate]);

  const editAddressAction = {
    content: "Edit shipping address",
    onAction: openAddressModal,
  };

  const isUpdating = addressFetcher.state === "submitting";
  const updateErrors = (addressFetcher.data?.errors as string[] | undefined) ?? [];

  function renderAddressModal() {
    const inReview = addressConfirmOpen;
    return (
      <Modal
        open={addressModalOpen}
        onClose={closeAddressModal}
        title={
          inReview
            ? `Review changes — ${location.company.name} (${location.name})`
            : `Edit shipping address — ${location.company.name} (${location.name})`
        }
        primaryAction={
          inReview
            ? {
                content: "Confirm and save",
                onAction: handleConfirmSubmit,
                loading: isUpdating,
                disabled: diff.length === 0,
                destructive: true,
              }
            : {
                content: "Review changes",
                onAction: handleReviewClick,
                disabled: !editCountryCode || diff.length === 0,
              }
        }
        secondaryActions={[
          inReview
            ? { content: "Keep editing", onAction: () => setAddressConfirmOpen(false) }
            : { content: "Cancel", onAction: closeAddressModal },
        ]}
      >
        {inReview ? (
          <Modal.Section>
            <BlockStack gap="400">
              <Banner tone="warning">
                <p>
                  This affects all future orders for this location, including
                  orders placed by other reps and via Shopify directly.
                </p>
              </Banner>
              {diff.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No changes detected.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {diff.map((d) => (
                    <InlineStack key={d.label} gap="200" blockAlign="start" wrap={false}>
                      <div style={{ minWidth: 130 }}>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {d.label}:
                        </Text>
                      </div>
                      <Text as="span" variant="bodyMd">
                        <span style={{ textDecoration: "line-through", opacity: 0.6 }}>
                          {d.before || "(empty)"}
                        </span>
                        {" → "}
                        <strong>{d.after || "(empty)"}</strong>
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        ) : (
          <Modal.Section>
            <BlockStack gap="400">
              {updateErrors.length > 0 && (
                <Banner tone="critical">
                  {updateErrors.map((err, i) => (
                    <p key={i}>{err}</p>
                  ))}
                </Banner>
              )}
              <Banner tone="warning">
                <p>
                  This affects all future orders for this location, including
                  orders placed by other reps and via Shopify directly.
                </p>
              </Banner>
              <TextField
                label="Recipient (company name on shipping label)"
                value={editRecipient}
                onChange={setEditRecipient}
                autoComplete="organization"
              />
              <InlineGrid columns={2} gap="300">
                <TextField
                  label="First name"
                  value={editFirstName}
                  onChange={setEditFirstName}
                  autoComplete="given-name"
                />
                <TextField
                  label="Last name"
                  value={editLastName}
                  onChange={setEditLastName}
                  autoComplete="family-name"
                />
              </InlineGrid>
              <TextField
                label="Address"
                value={editAddress1}
                onChange={setEditAddress1}
                autoComplete="address-line1"
              />
              <TextField
                label="Apartment, suite, etc."
                value={editAddress2}
                onChange={setEditAddress2}
                autoComplete="address-line2"
              />
              <CountryCombobox
                label="Country/region"
                countries={countries}
                value={editCountryCode}
                onChange={(v) => {
                  setEditCountryCode(v);
                  setEditZoneCode("");
                }}
                requiredIndicator
              />
              <InlineGrid columns={2} gap="300">
                <TextField
                  label="City"
                  value={editCity}
                  onChange={setEditCity}
                  autoComplete="address-level2"
                />
                <ZoneCombobox
                  label="State/Region"
                  countryCode={editCountryCode}
                  value={editZoneCode}
                  onChange={setEditZoneCode}
                />
              </InlineGrid>
              <TextField
                label="ZIP/Postal code"
                value={editZip}
                onChange={setEditZip}
                autoComplete="postal-code"
              />
              <InlineStack gap="200" blockAlign="end">
                <div style={{ width: "180px" }}>
                  <PhoneCodeCombobox
                    label="Phone code"
                    countries={countries}
                    value={editPhoneCode}
                    onChange={setEditPhoneCode}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Phone"
                    value={editPhone}
                    onChange={setEditPhone}
                    autoComplete="tel"
                    error={phoneError ?? undefined}
                  />
                </div>
              </InlineStack>
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    );
  }

  if (noCatalog) {
    return (
      <>
        <AppBranding staffName={staffMember.firstName} />
        <Page
          backAction={{ content: "Dashboard", url: "/app" }}
          title={`${location.company.name} — ${location.name}`}
          secondaryActions={[editAddressAction]}
        >
          <Banner tone="warning">
            <p>
              No active catalog is configured for this location. Contact your
              administrator to set up a catalog.
            </p>
          </Banner>
        </Page>
        {renderAddressModal()}
      </>
    );
  }

  return (
    <>
      <AppBranding staffName={staffMember.firstName} />
      <Page
        backAction={{ content: "Dashboard", url: "/app" }}
        title={`${location.company.name} — ${location.name}`}
        secondaryActions={[editAddressAction]}
      >
        <TitleBar title={location.company.name} />
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {catalogUnassigned && (
                <Banner tone="warning" title="Location not assigned to a catalog">
                  <p>
                    This location isn't assigned to a B2B catalog in Shopify.
                    Prices below are from{" "}
                    <strong>{catalogTitle ?? "the mapped catalog"}</strong> based
                    on the shipping country, but checkout won't match until an
                    admin assigns the location. Ask them to check Catalog
                    Assignment in Settings.
                  </p>
                </Banner>
              )}
              {(filterableCollections.length > 0 || true) && (
                <Card>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    {filterableCollections.length > 0 && (
                      <Select
                        label="Filter by collection"
                        options={[
                          { label: "All Collections", value: "" },
                          ...filterableCollections.map((c) => ({
                            label: c.title,
                            value: c.numericId,
                          })),
                        ]}
                        value={currentCollection ?? ""}
                        onChange={handleCollectionChange}
                      />
                    )}
                    <TextField
                      label="Search products"
                      value={searchValue}
                      onChange={handleSearchChange}
                      autoComplete="off"
                      placeholder="Search by title or SKU..."
                      clearButton
                      onClearButtonClick={() => handleSearchChange("")}
                    />
                  </InlineGrid>
                </Card>
              )}
              {allProducts.length === 0 ? (
                <Card>
                  <EmptyState
                    heading="No products in catalog"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>
                      This catalog doesn't have any products yet. Contact your
                      administrator.
                    </p>
                  </EmptyState>
                </Card>
              ) : (
                <>
                  <ProductGrid
                    products={allProducts}
                    priceMap={priceMap as Record<string, string>}
                    currencyCode={currencyCode}
                    onAddToCart={handleAddToCart}
                  />
                  {currentPageInfo.hasNextPage && (
                    <InlineStack align="center">
                      <Button
                        onClick={handleLoadMore}
                        loading={fetcher.state === "loading"}
                      >
                        Load More Products
                      </Button>
                    </InlineStack>
                  )}
                </>
              )}
            </BlockStack>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <CartSummary
              currencyCode={currencyCode}
              onReviewOrder={handleReviewOrder}
            />
          </Layout.Section>
        </Layout>
      </Page>
      <FloatingCartButton
        currencyCode={currencyCode}
        onReviewOrder={handleReviewOrder}
      />
      {renderAddressModal()}
    </>
  );
}

export function ErrorBoundary() {
  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Access Denied or Error
          </Text>
          <Text as="p" variant="bodyMd">
            You may not have access to this company location, or an error
            occurred. Please go back to the dashboard.
          </Text>
          <Button url="/app">Back to Dashboard</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
