import { authenticate, unauthenticated } from "../shopify.server";
import { isProductPublished } from "./graphql/products";
import prisma from "../db.server";
import type { StaffMember } from "../types";

interface AdminContext {
  graphql: Function;
}

interface AuthResult {
  admin: AdminContext;
  staffMember: StaffMember;
  shop: string;
}

interface StaffAccessResult extends AuthResult {
  companyLocationId: string;
}

/**
 * Get staff member identity from the session.
 * With token exchange auth, the session contains user info from the JWT.
 * We construct a StaffMember from the session data + the session's userId.
 */
export async function requireAuth(request: Request): Promise<AuthResult> {
  // With useOnlineTokens=true, authenticate.admin() returns an online session
  // that contains the associated_user data (names, email, account_owner)
  const { session, sessionToken } = await authenticate.admin(request);

  const associatedUser = session.onlineAccessInfo?.associated_user;
  const userId = sessionToken?.sub ?? associatedUser?.id?.toString();

  // Online session gives us user identity directly
  let firstName = associatedUser?.first_name ?? "";
  let lastName = associatedUser?.last_name ?? "";
  let email = associatedUser?.email ?? "";
  let isAccountOwner = associatedUser?.account_owner ?? false;

  // Fallback: if online session data is missing, check our StaffInfo cache
  let canSendInvoice = false;
  if (!firstName && userId) {
    const staffInfo = await prisma.staffInfo.findFirst({
      where: { id: `gid://shopify/StaffMember/${userId}` },
    });
    if (staffInfo?.firstName) {
      firstName = staffInfo.firstName;
      lastName = staffInfo.lastName;
      email = staffInfo.email;
    }
    if (staffInfo) {
      canSendInvoice = staffInfo.canSendInvoice;
    }
  } else if (userId) {
    const staffInfo = await prisma.staffInfo.findFirst({
      where: { id: `gid://shopify/StaffMember/${userId}` },
      select: { canSendInvoice: true },
    });
    if (staffInfo) {
      canSendInvoice = staffInfo.canSendInvoice;
    }
  }

  // Fallback for account_owner check
  if (!isAccountOwner && userId) {
    const ownerSession = await prisma.session.findFirst({
      where: { userId: BigInt(userId), accountOwner: true },
    });
    if (ownerSession) isAccountOwner = true;
  }

  // Build staff member GID from the user ID
  let staffId: string;
  if (userId) {
    staffId = `gid://shopify/StaffMember/${userId}`;
  } else {
    console.warn("[Auth] No user ID found in session or sessionToken, falling back to shop context");
    staffId = `gid://shopify/StaffMember/0`;
  }

  // Check if user is admin: account owner OR flagged in our DB
  const dbAdmin = await prisma.staffAssignment.findFirst({
    where: { staffId, companyLocationId: "__ADMIN__" },
  });
  const isAdmin = isAccountOwner || !!dbAdmin;

  const staffMember: StaffMember = {
    id: staffId,
    firstName,
    lastName,
    email,
    active: true,
    avatar: null,
    locale: associatedUser?.locale ?? "en",
    isAdmin,
    canSendInvoice: isAdmin || canSendInvoice,
  };

  console.log("[Auth] Staff member:", staffMember.id, staffMember.firstName, "isAdmin:", isAdmin);

  // Track staff info for the assignments UI (only write when we have useful data)
  if (staffId !== "gid://shopify/StaffMember/0") {
    const updateData: Record<string, unknown> = { lastSeen: new Date() };
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;

    prisma.staffInfo.upsert({
      where: { id: staffId },
      update: updateData,
      create: { id: staffId, shop: session.shop, firstName, lastName, email },
    }).catch((err) => console.error("[Auth] Failed to upsert staff info:", err));
  }

  // Use the OFFLINE admin client for API calls (full app permissions)
  // Online tokens have user-level permissions which are too restricted for
  // operations like draftOrders. The offline session was created during install.
  const { admin } = await unauthenticated.admin(session.shop);

  return { admin, staffMember, shop: session.shop };
}

export async function requireStaffAccess(
  request: Request,
  companyLocationId: string
): Promise<StaffAccessResult> {
  const { admin, staffMember, shop } = await requireAuth(request);

  // Admins can access any location
  if (staffMember.isAdmin) {
    return { admin, staffMember, companyLocationId, shop };
  }

  // Check assignment in our database
  const assignment = await prisma.staffAssignment.findFirst({
    where: {
      staffId: staffMember.id,
      companyLocationId,
    },
  });

  if (!assignment) {
    console.warn("[Auth] Staff", staffMember.id, "NOT assigned to location", companyLocationId);
    throw new Response("Forbidden — you are not assigned to this company location", { status: 403 });
  }

  return { admin, staffMember, companyLocationId, shop };
}

/**
 * Get the set of company location GIDs the staff member is assigned to.
 * Admins get null (meaning "all locations allowed").
 */
export async function getStaffAssignedLocationIds(
  staffMember: StaffMember,
): Promise<Set<string> | null> {
  if (staffMember.isAdmin) return null;

  const assignments = await prisma.staffAssignment.findMany({
    where: { staffId: staffMember.id, companyLocationId: { not: "__ADMIN__" } },
    select: { companyLocationId: true },
  });

  return new Set(assignments.map((a) => a.companyLocationId));
}

export async function validateOrderProducts(
  admin: AdminContext,
  companyLocationId: string,
  productIds: string[]
): Promise<{ valid: boolean; invalidProducts: string[] }> {
  const invalidProducts: string[] = [];

  const checks = await Promise.all(
    productIds.map(async (productId) => {
      const published = await isProductPublished(
        admin,
        productId,
        companyLocationId
      );
      return { productId, published };
    })
  );

  for (const check of checks) {
    if (!check.published) {
      invalidProducts.push(check.productId);
    }
  }

  return {
    valid: invalidProducts.length === 0,
    invalidProducts,
  };
}

const COMPANY_CONTACT_QUERY = `#graphql
  query ValidateContact($companyLocationId: ID!) {
    companyLocation(id: $companyLocationId) {
      company {
        contacts(first: 100) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

interface ValidateContactResponse {
  data?: {
    companyLocation: {
      company: {
        contacts: {
          nodes: Array<{ id: string }>;
        };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export async function validateCompanyContact(
  admin: AdminContext,
  companyLocationId: string,
  contactId: string
): Promise<boolean> {
  const response = await admin.graphql(COMPANY_CONTACT_QUERY, {
    variables: { companyLocationId },
  });
  const json: ValidateContactResponse = await response.json();

  if (json.errors?.length || !json.data?.companyLocation) {
    return false;
  }

  return json.data.companyLocation.company.contacts.nodes.some(
    (c) => c.id === contactId
  );
}
