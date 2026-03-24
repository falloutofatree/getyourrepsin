import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher, useSubmit } from "@remix-run/react";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage collection filters", {
      status: 403,
    });
  }

  const [collections, enabledCollections] = await Promise.all([
    fetchAllCollections(admin),
    prisma.filterableCollection.findMany({
      where: { shop },
      select: { collectionId: true },
    }),
  ]);

  const enabledIds = new Set(enabledCollections.map((c) => c.collectionId));

  return json({ collections, enabledIds: Array.from(enabledIds), shop });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage collection filters", {
      status: 403,
    });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  console.log("[Collections] Action hit, intent:", intent, "formData keys:", [...formData.keys()]);

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
  const { collections, enabledIds } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const enabledSet = new Set(enabledIds);

  return (
    <Page backAction={{ content: "Settings", url: "/app/settings" }}>
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
                  filter dropdown.
                </Text>

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
