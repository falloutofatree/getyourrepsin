import type { DraftOrder } from "../../types";

export const CREATE_B2B_DRAFT_ORDER_MUTATION = `#graphql
  mutation CreateB2BDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        status
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
          presentmentMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            title
            quantity
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SEND_INVOICE_MUTATION = `#graphql
  mutation SendInvoice($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CreateDraftOrderResponse {
  data?: {
    draftOrderCreate: {
      draftOrder: DraftOrder | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface SendInvoiceResponse {
  data?: {
    draftOrderInvoiceSend: {
      draftOrder: { id: string; status: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface CreateDraftOrderInput {
  companyId: string;
  companyLocationId: string;
  companyContactId: string;
  customerEmail: string;
  lineItems: Array<{ variantId: string; quantity: number }>;
  note: string;
  tags: string[];
}

export async function createDraftOrder(
  admin: { graphql: Function },
  input: CreateDraftOrderInput
): Promise<{ draftOrder: DraftOrder; errors: string[] }> {
  // Shipping/billing addresses intentionally omitted: when purchasingEntity.purchasingCompany
  // is set, Shopify uses the CompanyLocation's full default addresses automatically.
  const response = await admin.graphql(CREATE_B2B_DRAFT_ORDER_MUTATION, {
    variables: {
      input: {
        purchasingEntity: {
          purchasingCompany: {
            companyId: input.companyId,
            companyLocationId: input.companyLocationId,
            companyContactId: input.companyContactId,
          },
        },
        email: input.customerEmail,
        note: input.note,
        tags: input.tags,
        lineItems: input.lineItems,
      },
    },
  });

  const json: CreateDraftOrderResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `GraphQL errors creating draft order: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  const result = json.data?.draftOrderCreate;
  if (!result) {
    throw new Error("No response from draftOrderCreate");
  }

  if (result.userErrors.length > 0) {
    return {
      draftOrder: result.draftOrder as DraftOrder,
      errors: result.userErrors.map((e) => e.message),
    };
  }

  if (!result.draftOrder) {
    throw new Error("Draft order creation returned no order and no errors");
  }

  return { draftOrder: result.draftOrder, errors: [] };
}

export async function sendInvoice(
  admin: { graphql: Function },
  draftOrderId: string,
  email?: { to: string; subject?: string; customMessage?: string }
): Promise<{ success: boolean; errors: string[] }> {
  const variables: Record<string, unknown> = { id: draftOrderId };
  if (email) {
    variables.email = {
      to: email.to,
      subject: email.subject ?? "Your Wholesale Order",
      customMessage:
        email.customMessage ?? "Please review and complete your order.",
    };
  }

  const response = await admin.graphql(SEND_INVOICE_MUTATION, { variables });
  const json: SendInvoiceResponse = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `GraphQL errors sending invoice: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }

  const result = json.data?.draftOrderInvoiceSend;
  if (!result) {
    throw new Error("No response from draftOrderInvoiceSend");
  }

  if (result.userErrors.length > 0) {
    return { success: false, errors: result.userErrors.map((e) => e.message) };
  }

  return { success: true, errors: [] };
}
