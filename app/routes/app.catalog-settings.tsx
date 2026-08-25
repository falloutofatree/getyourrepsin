import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  Button,
  Banner,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { requireAuth } from "../lib/auth.server";
import { fetchB2BCatalogs } from "../lib/graphql/catalogs";
import {
  getCatalogMapping,
  saveCatalogMapping,
  type CatalogMapping,
} from "../lib/catalog-mapping.server";
import {
  COUNTRY_GROUP_KEYS,
  getCountryGroups,
  type CountryGroupKey,
} from "../lib/data/country-groups.server";
import { getAllCountries } from "../lib/data/countries.server";
import { CountryCombobox } from "../components/CountryCombobox";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can access settings", { status: 403 });
  }

  const [catalogs, mapping] = await Promise.all([
    fetchB2BCatalogs(admin),
    getCatalogMapping(shop),
  ]);

  return json({
    catalogs: catalogs.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      currency: c.priceList?.currency ?? null,
      hasPublication: Boolean(c.publication),
    })),
    groups: getCountryGroups().map((g) => ({
      key: g.key,
      label: g.label,
      description: g.description,
      memberCount: g.countryCodes.length,
    })),
    mapping,
    countries: getAllCountries(),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can access settings", { status: 403 });
  }

  const formData = await request.formData();
  if (formData.get("intent") !== "save-mapping") {
    return json({ success: false, error: "Unknown action" });
  }

  let submitted: CatalogMapping;
  try {
    submitted = JSON.parse(formData.get("mapping") as string) as CatalogMapping;
  } catch {
    return json({ success: false, error: "Could not read the submitted mapping" });
  }

  // Only accept catalog IDs that actually exist as B2B catalogs in this shop —
  // an unknown ID would silently fail later at assignment time.
  const catalogs = await fetchB2BCatalogs(admin);
  const validIds = new Set(catalogs.map((c) => c.id));

  const groups: CatalogMapping["groups"] = {};
  for (const key of COUNTRY_GROUP_KEYS) {
    const value = submitted.groups?.[key];
    if (typeof value === "string" && validIds.has(value)) {
      groups[key] = value;
    }
  }

  const overrides: CatalogMapping["overrides"] = {};
  for (const [code, value] of Object.entries(submitted.overrides ?? {})) {
    const normalized = code.trim().toUpperCase();
    if (normalized && typeof value === "string" && validIds.has(value)) {
      overrides[normalized] = value;
    }
  }

  await saveCatalogMapping(shop, { groups, overrides });

  return json({ success: true, error: null });
};

interface OverrideRow {
  countryCode: string;
  catalogId: string;
}

export default function CatalogSettings() {
  const { catalogs, groups, mapping, countries } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [groupMap, setGroupMap] = useState<Record<string, string>>(
    () => ({ ...mapping.groups }) as Record<string, string>,
  );
  const [overrides, setOverrides] = useState<OverrideRow[]>(() =>
    Object.entries(mapping.overrides).map(([countryCode, catalogId]) => ({
      countryCode,
      catalogId,
    })),
  );

  const actionData = fetcher.data as
    | { success: boolean; error: string | null }
    | undefined;

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show("Catalog assignment rules saved");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  const catalogOptions = [
    { label: "— Not assigned —", value: "" },
    ...catalogs.map((c) => ({
      label: c.currency ? `${c.title} (${c.currency})` : c.title,
      value: c.id,
    })),
  ];

  const setGroup = useCallback((key: CountryGroupKey, catalogId: string) => {
    setGroupMap((prev) => {
      const next = { ...prev };
      if (catalogId) next[key] = catalogId;
      else delete next[key];
      return next;
    });
  }, []);

  const updateOverride = useCallback(
    (index: number, patch: Partial<OverrideRow>) => {
      setOverrides((prev) =>
        prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const removeOverride = useCallback((index: number) => {
    setOverrides((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(() => {
    const overrideMap: Record<string, string> = {};
    for (const row of overrides) {
      if (row.countryCode && row.catalogId) {
        overrideMap[row.countryCode.toUpperCase()] = row.catalogId;
      }
    }

    const formData = new FormData();
    formData.set("intent", "save-mapping");
    formData.set(
      "mapping",
      JSON.stringify({ groups: groupMap, overrides: overrideMap }),
    );
    fetcher.submit(formData, { method: "POST" });
  }, [groupMap, overrides, fetcher]);

  const isSaving = fetcher.state === "submitting";
  const unmappedGroups = groups.filter((g) => !groupMap[g.key]);
  const catalogsWithoutPublication = catalogs.filter((c) => !c.hasPublication);

  return (
    <Page
      backAction={{ content: "Settings", url: "/app/settings" }}
      title="Catalog Assignment"
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: isSaving,
      }}
    >
      <TitleBar title="Catalog Assignment" />
      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Shopify has no built-in rule that picks a B2B catalog by country. These
            rules are what the app applies when a company location is created —
            both in the sales rep portal and directly in the Shopify admin. A
            location with no catalog falls back to default shop pricing.
          </p>
        </Banner>

        {catalogs.length === 0 && (
          <Banner tone="warning">
            <p>
              No B2B catalogs found in this shop. Create catalogs of type "company
              location" in Shopify admin under Products → Catalogs first.
            </p>
          </Banner>
        )}

        {unmappedGroups.length > 0 && catalogs.length > 0 && (
          <Banner tone="warning">
            <p>
              No catalog set for:{" "}
              {unmappedGroups.map((g) => g.label).join(", ")}. New company
              locations in those regions will fall back to the "Rest of world"
              catalog, or to default shop pricing if that is unset too.
            </p>
          </Banner>
        )}

        {catalogsWithoutPublication.length > 0 && (
          <Banner tone="warning">
            <p>
              These catalogs have no publication, so they control pricing but not
              which products are visible:{" "}
              {catalogsWithoutPublication.map((c) => c.title).join(", ")}.
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.AnnotatedSection
            title="Country groups"
            description="Each new company location is matched to one of these groups by its shipping country, then assigned the catalog you pick here."
          >
            <Card>
              <BlockStack gap="400">
                {groups.map((group, index) => (
                  <BlockStack gap="200" key={group.key}>
                    {index > 0 && <Divider />}
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        {group.label}
                      </Text>
                      {group.memberCount > 1 && (
                        <Badge>{`${group.memberCount} countries`}</Badge>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {group.description}
                    </Text>
                    <Select
                      label="Catalog"
                      labelHidden
                      options={catalogOptions}
                      value={groupMap[group.key] ?? ""}
                      onChange={(v) => setGroup(group.key as CountryGroupKey, v)}
                    />
                  </BlockStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Layout>
          <Layout.AnnotatedSection
            title="Country exceptions"
            description="Optional. A country listed here uses its own catalog and ignores its group — use this for countries that don't fit the continent rule."
          >
            <Card>
              <BlockStack gap="400">
                {overrides.length === 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No exceptions. Every country follows its group.
                  </Text>
                )}

                {overrides.map((row, index) => (
                  <InlineGrid
                    columns={{ xs: 1, md: ["twoThirds", "oneThird"] }}
                    gap="300"
                    key={`${row.countryCode}-${index}`}
                  >
                    <CountryCombobox
                      label="Country"
                      countries={countries}
                      value={row.countryCode}
                      onChange={(code) => updateOverride(index, { countryCode: code })}
                    />
                    <InlineStack gap="200" blockAlign="end" wrap={false}>
                      <div style={{ flex: 1 }}>
                        <Select
                          label="Catalog"
                          options={catalogOptions}
                          value={row.catalogId}
                          onChange={(v) => updateOverride(index, { catalogId: v })}
                        />
                      </div>
                      <Button
                        tone="critical"
                        variant="tertiary"
                        onClick={() => removeOverride(index)}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  </InlineGrid>
                ))}

                <InlineStack align="start">
                  <Button
                    onClick={() =>
                      setOverrides((prev) => [
                        ...prev,
                        { countryCode: "", catalogId: "" },
                      ])
                    }
                  >
                    Add exception
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <InlineStack align="end">
          <Button variant="primary" onClick={handleSave} loading={isSaving}>
            Save
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
