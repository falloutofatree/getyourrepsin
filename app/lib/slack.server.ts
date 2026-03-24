import prisma from "../db.server";

interface SlackOrderNotification {
  orderName: string;
  repName: string;
  companyName: string;
  locationName: string;
  totalAmount: string;
  currencyCode: string;
  draftOrderId: string;
  shopDomain: string;
}

export async function sendSlackNotification(
  shop: string,
  notification: SlackOrderNotification,
): Promise<void> {
  const setting = await prisma.appSettings.findUnique({
    where: { shop_key: { shop, key: "slackWebhookUrl" } },
  });

  if (!setting?.value) return;

  const numericId = notification.draftOrderId.replace(
    "gid://shopify/DraftOrder/",
    "",
  );
  const adminUrl = `https://${notification.shopDomain}/admin/draft_orders/${numericId}`;

  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "New Draft Order (Pending Review)",
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Order:*\n${notification.orderName}` },
          { type: "mrkdwn", text: `*Sales Rep:*\n${notification.repName}` },
          {
            type: "mrkdwn",
            text: `*Company:*\n${notification.companyName}`,
          },
          {
            type: "mrkdwn",
            text: `*Location:*\n${notification.locationName}`,
          },
          {
            type: "mrkdwn",
            text: `*Total:*\n${notification.totalAmount} ${notification.currencyCode}`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in Shopify" },
            url: adminUrl,
          },
        ],
      },
    ],
    text: `New draft order ${notification.orderName} from ${notification.repName} — ${notification.companyName} — ${notification.totalAmount} ${notification.currencyCode}`,
  };

  fetch(setting.value, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => console.error("[Slack] Webhook failed:", err));
}
