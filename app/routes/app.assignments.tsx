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
  Badge,
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
  canSendInvoice: boolean;
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

  // Fetch all company locations
  const locationsResponse = await admin.graphql(COMPANY_LOCATIONS_QUERY, {
    variables: { first: 100 },
  });
  const locationsJson = await locationsResponse.json();
  const locations: LocationInfo[] = locationsJson.data?.companyLocations?.nodes ?? [];

  // Load known staff members from our DB (populated when they log in)
  const staffMembers: StaffMemberInfo[] = await prisma.staffInfo.findMany({
    orderBy: { lastSeen: "desc" },
  });

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
    } catch (err: any) {
      if (err.code === "P2002") {
        return json({ error: "This assignment already exists" }, { status: 400 });
      }
      throw err;
    }
  }

  if (intent === "toggle-invoice-permission") {
    const staffId = formData.get("staffId") as string;
    const currentValue = formData.get("currentValue") === "true";

    await prisma.staffInfo.update({
      where: { id: staffId },
      data: { canSendInvoice: !currentValue },
    });

    return json({ success: true });
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

  const staffOptions = [
    { label: "Select a staff member...", value: "" },
    ...staffMembers.map((s) => ({
      label: `${s.firstName} ${s.lastName} (${s.email})`,
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

  const actionData = fetcher.data as { error?: string; success?: boolean } | undefined;

  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="Staff Assignments" />
      <BlockStack gap="500">
        {actionData?.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Add Assignment
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Assign a staff member to a company location so they can see it in their dashboard
                  and place orders for it.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="add" />
                  <BlockStack gap="300">
                    {staffMembers.length > 0 ? (
                      <Select
                        label="Staff Member"
                        options={staffOptions}
                        value={selectedStaff}
                        onChange={setSelectedStaff}
                        name="staffId"
                      />
                    ) : (
                      <Banner tone="info">
                        <p>
                          No staff members found yet. Staff members appear here automatically
                          after they log into the app for the first time.
                        </p>
                      </Banner>
                    )}
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

        {staffMembers.length > 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Invoice Permissions
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Control which reps can send invoices directly. Reps without
                    permission can only create draft orders for admin review.
                  </Text>
                  <IndexTable
                    itemCount={staffMembers.length}
                    headings={[
                      { title: "Staff Member" },
                      { title: "Email" },
                      { title: "Invoice Permission" },
                    ]}
                    selectable={false}
                  >
                    {staffMembers.map((s, index) => (
                      <IndexTable.Row key={s.id} id={s.id} position={index}>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd" fontWeight="bold">
                            {s.firstName} {s.lastName}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {s.email}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <fetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="toggle-invoice-permission"
                            />
                            <input type="hidden" name="staffId" value={s.id} />
                            <input
                              type="hidden"
                              name="currentValue"
                              value={String(s.canSendInvoice)}
                            />
                            <InlineStack gap="200" blockAlign="center">
                              <Badge
                                tone={s.canSendInvoice ? "success" : "new"}
                              >
                                {s.canSendInvoice ? "Can Send" : "Restricted"}
                              </Badge>
                              <Button variant="plain" submit>
                                {s.canSendInvoice ? "Restrict" : "Allow"}
                              </Button>
                            </InlineStack>
                          </fetcher.Form>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Current Assignments ({assignments.length})
                </Text>
                {assignments.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No assignments yet. Add one above.
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
                      return (
                        <IndexTable.Row key={a.id} id={a.id} position={index}>
                          <IndexTable.Cell>
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              {staff
                                ? `${staff.firstName} ${staff.lastName}`
                                : a.staffId}
                            </Text>
                            {staff && (
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
