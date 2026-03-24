import { json, type LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useFetcher,
} from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  Banner,
  SkeletonPage,
  SkeletonBodyText,
  InlineStack,
  InlineGrid,
  EmptyState,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { requireStaffAccess } from "../lib/auth.server";
import { fetchCompanyLocationWithCatalogs } from "../lib/graphql/companies";
import { fetchCatalogForLocation } from "../lib/graphql/catalogs";
import { fetchCatalogProducts } from "../lib/graphql/products";
import { fetchPriceListPrices } from "../lib/graphql/price-list";
import { priceMapToObject } from "../lib/utils/price-resolver";
import { AppBranding } from "../components/AppBranding";
import { ProductGrid } from "../components/ProductGrid";
import { CartSummary } from "../components/CartSummary";
import { useCartContext } from "../components/CartProvider";
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

  // Fallback: use the root catalogs query to find any catalog linked to this location
  if (!activeCatalog) {
    const locationCountry = location.shippingAddress?.country ?? location.billingAddress?.country;
    const rootCatalog = await fetchCatalogForLocation(admin, companyLocationId, locationCountry);
    if (rootCatalog) {
      activeCatalog = {
        id: rootCatalog.id,
        title: rootCatalog.title,
        status: rootCatalog.status,
        publication: rootCatalog.publication,
        priceList: rootCatalog.priceList,
      };
      console.log("[Catalog] Found via root query:", activeCatalog.id, activeCatalog.title);
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
      products: [] as Product[],
      pageInfo: { hasNextPage: false, endCursor: null } as PageInfo,
      priceMap: {} as Record<string, string>,
      currencyCode: "USD",
      publicationId: null as string | null,
      noCatalog: true,
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
    products: productsResult.products,
    pageInfo: productsResult.pageInfo,
    priceMap: priceMapToObject(priceMap),
    currencyCode: activeCatalog.priceList?.currency ?? "USD",
    publicationId: activeCatalog.publication.id,
    noCatalog: false,
    filterableCollections: filterableCollections.map((c) => ({
      id: c.collectionId,
      title: c.title,
      numericId: c.numericId,
    })),
    currentSearch: searchQuery,
    currentCollection: collectionNumericId,
  });
};

export default function CompanyCatalog() {
  const {
    staffMember,
    location,
    products: initialProducts,
    pageInfo: initialPageInfo,
    priceMap,
    currencyCode,
    publicationId,
    noCatalog,
    filterableCollections,
    currentSearch,
    currentCollection,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { setCompany, addItem, cart } = useCartContext();
  const fetcher = useFetcher<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

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

  if (noCatalog) {
    return (
      <>
        <AppBranding staffName={staffMember.firstName} />
        <Page
          backAction={{ content: "Dashboard", url: "/app" }}
          title={`${location.company.name} — ${location.name}`}
        >
          <Banner tone="warning">
            <p>
              No active catalog is configured for this location. Contact your
              administrator to set up a catalog.
            </p>
          </Banner>
        </Page>
      </>
    );
  }

  return (
    <>
      <AppBranding staffName={staffMember.firstName} />
      <Page
        backAction={{ content: "Dashboard", url: "/app" }}
        title={`${location.company.name} — ${location.name}`}
      >
        <TitleBar title={location.company.name} />
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
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
