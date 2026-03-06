import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  IndexTable,
  TextField,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";

import { requireAuth } from "../lib/auth.server";
import prisma from "../db.server";
import { invalidatePattern } from "../lib/cache.server";

// Query all company locations
const COMPANY_LOCATIONS_QUERY = `#graphql
  query AllCompanyLocations($first: Int!, $after: String) {
    companyLocations(first: $first, after: $after) {
      nodes {
        id
        name
        company {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface StaffMemberInfo {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isPending: boolean;
}

interface LocationInfo {
  id: string;
  name: string;
  company: { id: string; name: string };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, staffMember } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage staff assignments", { status: 403 });
  }

  // Fetch all company locations (paginated)
  const locations: LocationInfo[] = [];
  let locCursor: string | null = null;
  let locHasNext = true;
  while (locHasNext) {
    const resp = await admin.graphql(COMPANY_LOCATIONS_QUERY, {
      variables: { first: 100, after: locCursor },
    });
    const data = (await resp.json()).data?.companyLocations;
    if (!data) break;
    locations.push(...data.nodes);
    locHasNext = data.pageInfo.hasNextPage;
    locCursor = data.pageInfo.endCursor;
  }

  // Load staff members from DB (registered via app or logged in)
  const dbStaff = await prisma.staffInfo.findMany({ orderBy: { firstName: "asc" } });
  const staffMembers: StaffMemberInfo[] = dbStaff.map((s) => ({
    id: s.id,
    firstName: s.firstName,
    lastName: s.lastName,
    email: s.email,
    isPending: s.id.startsWith("pending:"),
  }));

  // Fetch current assignments from DB (exclude __ADMIN__ markers)
  const assignments = await prisma.staffAssignment.findMany({
    where: { companyLocationId: { not: "__ADMIN__" } },
    orderBy: { createdAt: "desc" },
  });

  return json({ locations, staffMembers, assignments });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { staffMember, shop } = await requireAuth(request);

  if (!staffMember.isAdmin) {
    throw new Response("Only admins can manage staff assignments", { status: 403 });
  }
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "register") {
    const firstName = (formData.get("firstName") as string)?.trim();
    const lastName = (formData.get("lastName") as string)?.trim();
    const email = (formData.get("email") as string)?.trim().toLowerCase();

    if (!firstName || !email) {
      return json({ error: "First name and email are required" }, { status: 400 });
    }

    // Use pending:email as the ID until they log in
    const pendingId = `pending:${email}`;

    // Check if this email is already registered
    const existing = await prisma.staffInfo.findFirst({
      where: { email: { equals: email } },
    });
    if (existing) {
      return json({ error: `A staff member with email ${email} already exists` }, { status: 400 });
    }

    await prisma.staffInfo.create({
      data: { id: pendingId, shop, firstName, lastName: lastName ?? "", email },
    });

    return json({ success: true, message: `${firstName} registered. They'll be linked automatically when they log in.` });
  }

  if (intent === "add") {
    const staffId = formData.get("staffId") as string;
    const companyLocationId = formData.get("companyLocationId") as string;

    if (!staffId || !companyLocationId) {
      return json({ error: "Staff and location are required" }, { status: 400 });
    }

    try {
      await prisma.staffAssignment.create({
        data: { shop, staffId, companyLocationId },
      });
      invalidatePattern(`staff:${staffId}:locations`);
      return json({ success: true });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
        return json({ error: "This assignment already exists" }, { status: 400 });
      }
      throw err;
    }
  }

  if (intent === "remove") {
    const assignmentId = formData.get("assignmentId") as string;
    const assignment = await prisma.staffAssignment.findUnique({ where: { id: assignmentId } });
    await prisma.staffAssignment.delete({ where: { id: assignmentId } });
    if (assignment) {
      invalidatePattern(`staff:${assignment.staffId}:locations`);
    }
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

export default function Assignments() {
  const { locations, staffMembers, assignments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [selectedStaff, setSelectedStaff] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const staffOptions = [
    { label: "Select a staff member...", value: "" },
    ...staffMembers.map((s) => ({
      label: `${s.firstName} ${s.lastName} (${s.email})${s.isPending ? " - pending" : ""}`,
      value: s.id,
    })),
  ];

  const locationOptions = [
    { label: "Select a company location...", value: "" },
    ...locations.map((l) => ({
      label: `${l.company.name} — ${l.name}`,
      value: l.id,
    })),
  ];

  // Build lookup maps for display
  const staffMap = new Map(staffMembers.map((s) => [s.id, s]));
  const locationMap = new Map(locations.map((l) => [l.id, l]));

  const actionData = fetcher.data as { error?: string; success?: boolean; message?: string } | undefined;

  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="Staff Assignments" />
      <BlockStack gap="500">
        {actionData?.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}
        {actionData?.message && (
          <Banner tone="success">
            <p>{actionData.message}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Register New Sales Rep
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Add a sales rep before they log in. They'll be linked automatically on first login.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="register" />
                  <BlockStack gap="300">
                    <InlineStack gap="300" wrap={false}>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="First Name"
                          value={newFirstName}
                          onChange={setNewFirstName}
                          autoComplete="off"
                          name="firstName"
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Last Name"
                          value={newLastName}
                          onChange={setNewLastName}
                          autoComplete="off"
                          name="lastName"
                        />
                      </div>
                    </InlineStack>
                    <TextField
                      label="Email"
                      type="email"
                      value={newEmail}
                      onChange={setNewEmail}
                      autoComplete="off"
                      name="email"
                    />
                    <InlineStack align="end">
                      <Button
                        variant="primary"
                        submit
                        disabled={!newFirstName || !newEmail}
                        loading={fetcher.state === "submitting"}
                      >
                        Register Sales Rep
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Add Assignment
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Assign a sales rep to a company location so they can place orders for it.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="add" />
                  <BlockStack gap="300">
                    <Select
                      label="Staff Member"
                      options={staffOptions}
                      value={selectedStaff}
                      onChange={setSelectedStaff}
                      name="staffId"
                    />
                    <Select
                      label="Company Location"
                      options={locationOptions}
                      value={selectedLocation}
                      onChange={setSelectedLocation}
                      name="companyLocationId"
                    />
                    <InlineStack align="end">
                      <Button
                        variant="primary"
                        submit
                        disabled={!selectedStaff || !selectedLocation}
                        loading={fetcher.state === "submitting"}
                      >
                        Add Assignment
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Current Assignments ({assignments.length})
                </Text>
                {assignments.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No assignments yet. Register a sales rep and add an assignment above.
                  </Text>
                ) : (
                  <IndexTable
                    itemCount={assignments.length}
                    headings={[
                      { title: "Staff Member" },
                      { title: "Company / Location" },
                      { title: "Actions" },
                    ]}
                    selectable={false}
                  >
                    {assignments.map((a, index) => {
                      const staff = staffMap.get(a.staffId);
                      const loc = locationMap.get(a.companyLocationId);
                      const isPending = a.staffId.startsWith("pending:");
                      return (
                        <IndexTable.Row key={a.id} id={a.id} position={index}>
                          <IndexTable.Cell>
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="bodyMd" fontWeight="bold">
                                {staff
                                  ? `${staff.firstName} ${staff.lastName}`
                                  : a.staffId}
                              </Text>
                              {isPending && (
                                <span style={{
                                  background: "#FFF3CD",
                                  color: "#856404",
                                  padding: "2px 8px",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                }}>
                                  Pending login
                                </span>
                              )}
                            </InlineStack>
                            {staff?.email && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {" "}({staff.email})
                              </Text>
                            )}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {loc
                              ? `${loc.company.name} — ${loc.name}`
                              : a.companyLocationId}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="remove" />
                              <input type="hidden" name="assignmentId" value={a.id} />
                              <Button
                                variant="plain"
                                tone="critical"
                                submit
                              >
                                Remove
                              </Button>
                            </fetcher.Form>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      );
                    })}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
