import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  InlineStack,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";

import { requireAuth } from "../lib/auth.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can access settings", { status: 403 });
  }

  const slackSetting = await prisma.appSettings.findUnique({
    where: { shop_key: { shop, key: "slackWebhookUrl" } },
  });

  return json({
    slackWebhookUrl: slackSetting?.value ?? "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can access settings", { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-slack-webhook") {
    const webhookUrl = (formData.get("webhookUrl") as string).trim();

    if (webhookUrl && !webhookUrl.startsWith("https://hooks.slack.com/")) {
      return json({ success: false, error: "Invalid Slack webhook URL" });
    }

    await prisma.appSettings.upsert({
      where: { shop_key: { shop, key: "slackWebhookUrl" } },
      update: { value: webhookUrl },
      create: { shop, key: "slackWebhookUrl", value: webhookUrl },
    });

    return json({ success: true, error: null });
  }

  if (intent === "test-slack") {
    const setting = await prisma.appSettings.findUnique({
      where: { shop_key: { shop, key: "slackWebhookUrl" } },
    });

    if (!setting?.value) {
      return json({ success: false, error: "No webhook URL configured" });
    }

    try {
      const response = await fetch(setting.value, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "Test Notification",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "This is a test message from the Sales Rep Portal. If you see this, Slack notifications are working correctly.",
              },
            },
          ],
          text: "Test notification from Sales Rep Portal",
        }),
      });

      if (!response.ok) {
        return json({
          success: false,
          error: `Slack returned ${response.status}: ${await response.text()}`,
        });
      }

      return json({ success: true, error: null, tested: true });
    } catch (err) {
      return json({
        success: false,
        error: `Failed to reach Slack: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  }

  return json({ success: false, error: "Unknown action" });
};

export default function Settings() {
  const { slackWebhookUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [webhookUrl, setWebhookUrl] = useState(slackWebhookUrl);

  const actionData = fetcher.data as
    | { success: boolean; error: string | null; tested?: boolean }
    | undefined;

  useEffect(() => {
    if (actionData?.success && actionData?.tested) {
      shopify.toast.show("Test message sent to Slack!");
    } else if (actionData?.success && !actionData?.tested) {
      shopify.toast.show("Settings saved");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        <Layout>
          <Layout.AnnotatedSection
            title="Collection Filters"
            description="Control which collections sales reps can use to filter products in the catalog."
          >
            <Card>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  Manage which collections appear as filter options in the
                  product catalog.
                </Text>
                <InlineStack align="end">
                  <Button url="/app/collections-settings">
                    Manage Collection Filters
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Layout>
          <Layout.AnnotatedSection
            title="Slack Notifications"
            description="Get notified in Slack when a sales rep creates a draft order that requires review (reps without invoice permission)."
          >
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="Slack Webhook URL"
                  value={webhookUrl}
                  onChange={setWebhookUrl}
                  autoComplete="off"
                  placeholder="https://hooks.slack.com/services/..."
                  helpText="Create an incoming webhook in your Slack workspace and paste the URL here."
                />
                <InlineStack gap="300" align="end">
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="test-slack" />
                    <Button
                      submit
                      disabled={!webhookUrl}
                      loading={
                        fetcher.state === "submitting" &&
                        fetcher.formData?.get("intent") === "test-slack"
                      }
                    >
                      Test
                    </Button>
                  </fetcher.Form>
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="save-slack-webhook"
                    />
                    <input type="hidden" name="webhookUrl" value={webhookUrl} />
                    <Button
                      variant="primary"
                      submit
                      loading={
                        fetcher.state === "submitting" &&
                        fetcher.formData?.get("intent") === "save-slack-webhook"
                      }
                    >
                      Save
                    </Button>
                  </fetcher.Form>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}
