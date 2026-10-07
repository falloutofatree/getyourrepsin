import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher, useSubmit } from "@remix-run/react";
import { useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { requireAuth } from "../lib/auth.server";
import { fetchAllCollections } from "../lib/graphql/collections";
import type { CollectionInfo } from "../lib/graphql/collections";
import prisma from "../db.server";

type SyncResult =
  | { success: true; intent: "sync"; removedTitles: string[]; renamedTitles: string[] }
  | { success: false; intent: "sync"; error: string };

interface SavedFilter {
  collectionId: string;
  title: string;
  numericId: string;
}

// Compare saved filters against live Shopify collections: filters whose
// collection was deleted, and filters whose title or numeric ID changed.
function diffFilters(saved: SavedFilter[], collections: CollectionInfo[]) {
  const liveById = new Map(collections.map((c) => [c.id, c]));
  const removed = saved.filter((c) => !liveById.has(c.collectionId));
  const renamed = saved.flatMap((c) => {
    const live = liveById.get(c.collectionId);
    return live && (live.title !== c.title || live.numericId !== c.numericId)
      ? [{ saved: c, live }]
      : [];
  });
  return { liveById, removed, renamed };
}

async function loadFilters(
  admin: { graphql: Function },
  shop: string,
) {
  const [collections, saved] = await Promise.all([
    fetchAllCollections(admin),
    prisma.filterableCollection.findMany({
      where: { shop },
      select: { collectionId: true, title: true, numericId: true },
    }),
  ]);
  return { collections, saved };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage collection filters", {
      status: 403,
    });
  }

  // Read-only: report stale filters, but only the Sync button changes them.
  const { collections, saved } = await loadFilters(admin, shop);
  const { liveById, removed, renamed } = diffFilters(saved, collections);

  const enabledIds = saved
    .filter((c) => liveById.has(c.collectionId))
    .map((c) => c.collectionId);

  return json({
    collections,
    enabledIds,
    staleTitles: [
      ...removed.map((c) => c.title),
      ...renamed.map((r) => r.saved.title),
    ],
    shop,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage collection filters", {
      status: 403,
    });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  console.log("[Collections] Action hit, intent:", intent, "formData keys:", [...formData.keys()]);

  if (intent === "sync") {
    try {
      const { collections, saved } = await loadFilters(admin, shop);
      const { removed, renamed } = diffFilters(saved, collections);

      if (removed.length > 0 || renamed.length > 0) {
        await prisma.$transaction([
          prisma.filterableCollection.deleteMany({
            where: { shop, collectionId: { in: removed.map((c) => c.collectionId) } },
          }),
          ...renamed.map(({ saved: c, live }) =>
            prisma.filterableCollection.update({
              where: { shop_collectionId: { shop, collectionId: c.collectionId } },
              data: { title: live.title, numericId: live.numericId },
            }),
          ),
        ]);
      }

      console.log("[Collections] Synced filters", {
        shop,
        removed: removed.map((c) => c.title),
        renamed: renamed.map((r) => `${r.saved.title} -> ${r.live.title}`),
      });

      return json<SyncResult>({
        success: true,
        intent: "sync",
        removedTitles: removed.map((c) => c.title),
        renamedTitles: renamed.map((r) => `${r.saved.title} → ${r.live.title}`),
      });
    } catch (error) {
      console.error("[Collections] Sync failed:", error);
      return json<SyncResult>({
        success: false,
        intent: "sync",
        error: "Could not sync with Shopify. Please try again.",
      });
    }
  }

  if (intent === "toggle") {
    const collectionId = formData.get("collectionId") as string;
    const title = formData.get("title") as string;
    const numericId = collectionId.replace("gid://shopify/Collection/", "");
    const currentlyEnabled = formData.get("enabled") === "true";

    if (currentlyEnabled) {
      await prisma.filterableCollection.deleteMany({
        where: { shop, collectionId },
      });
    } else {
      await prisma.filterableCollection.create({
        data: { shop, collectionId, title, numericId },
      });
    }

    return json({ success: true });
  }

  return json({ success: false, error: "Unknown action" });
};

export default function CollectionSettings() {
  const { collections, enabledIds, staleTitles } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const syncFetcher = useFetcher<SyncResult>();

  const enabledSet = new Set(enabledIds);
  const isSyncing = syncFetcher.state !== "idle";
  const syncResult =
    syncFetcher.state === "idle" ? syncFetcher.data ?? null : null;

  useEffect(() => {
    if (!syncResult) return;
    if (!syncResult.success) {
      shopify.toast.show("Sync failed", { isError: true });
    } else if (
      syncResult.removedTitles.length === 0 &&
      syncResult.renamedTitles.length === 0
    ) {
      shopify.toast.show("Collections are already up to date");
    } else {
      shopify.toast.show("Collections synced with Shopify");
    }
  }, [syncResult, shopify]);

  return (
    <Page
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{
        content: "Sync with Shopify",
        loading: isSyncing,
        onAction: () => syncFetcher.submit({ intent: "sync" }, { method: "POST" }),
      }}
    >
      <TitleBar title="Collection Filters" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Filterable Collections
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Select which collections sales reps can use to filter products
                  in the catalog. Only enabled collections will appear in the
                  filter dropdown. After deleting or renaming collections in
                  Shopify, click Sync with Shopify to update this list.
                </Text>

                {syncResult && !syncResult.success && (
                  <Banner tone="critical">
                    <p>{syncResult.error}</p>
                  </Banner>
                )}

                {syncResult?.success &&
                  (syncResult.removedTitles.length > 0 ||
                    syncResult.renamedTitles.length > 0) && (
                    <Banner tone="success">
                      <BlockStack gap="100">
                        {syncResult.removedTitles.length > 0 && (
                          <p>
                            Removed collections that no longer exist in Shopify:{" "}
                            {syncResult.removedTitles.join(", ")}
                          </p>
                        )}
                        {syncResult.renamedTitles.length > 0 && (
                          <p>Updated names: {syncResult.renamedTitles.join(", ")}</p>
                        )}
                      </BlockStack>
                    </Banner>
                  )}

                {staleTitles.length > 0 && (
                  <Banner
                    tone="warning"
                    action={{
                      content: "Sync with Shopify",
                      loading: isSyncing,
                      onAction: () =>
                        syncFetcher.submit({ intent: "sync" }, { method: "POST" }),
                    }}
                  >
                    <p>
                      {staleTitles.length === 1
                        ? "1 collection filter is out of date"
                        : `${staleTitles.length} collection filters are out of date`}{" "}
                      (deleted or renamed in Shopify): {staleTitles.join(", ")}.
                      Sales reps still see the old version until you sync.
                    </p>
                  </Banner>
                )}

                {collections.length === 0 ? (
                  <Banner tone="info">
                    <p>No collections found in your store.</p>
                  </Banner>
                ) : (
                  <BlockStack gap="300">
                    {collections.map((collection: CollectionInfo) => {
                      const isEnabled = enabledSet.has(collection.id);
                      return (
                        <InlineStack
                          key={collection.id}
                          align="space-between"
                          blockAlign="center"
                          gap="400"
                        >
                          <BlockStack gap="100">
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              {collection.title}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {collection.productsCount} products
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={isEnabled ? "success" : undefined}>
                              {isEnabled ? "Enabled" : "Disabled"}
                            </Badge>
                            <Button
                              onClick={() => {
                                const fd = new FormData();
                                fd.set("intent", "toggle");
                                fd.set("collectionId", collection.id);
                                fd.set("title", collection.title);
                                fd.set("enabled", String(isEnabled));
                                submit(fd, { method: "POST" });
                              }}
                            >
                              {isEnabled ? "Disable" : "Enable"}
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
