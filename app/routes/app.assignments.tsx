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
  Badge,
  Banner,
  Autocomplete,
  Icon,
  TextField,
  Collapsible,
  Modal,
  Box,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import { SearchIcon, ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useMemo, useCallback } from "react";

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

  // Fetch all company locations (paginated)
  const locations: LocationInfo[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const locationsResponse: Response = await admin.graphql(COMPANY_LOCATIONS_QUERY, {
      variables: { first: 100, after: cursor },
    });
    const locationsJson: {
      data?: { companyLocations?: { nodes: LocationInfo[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    } = await locationsResponse.json();

    if (!locationsJson.data?.companyLocations) {
      break;
    }

    locations.push(...locationsJson.data.companyLocations.nodes);
    hasNextPage = locationsJson.data.companyLocations.pageInfo.hasNextPage;
    cursor = locationsJson.data.companyLocations.pageInfo.endCursor;
  }

  // Sort alphabetically by company name, then location name
  locations.sort((a, b) => {
    const companyCompare = a.company.name.localeCompare(b.company.name);
    if (companyCompare !== 0) return companyCompare;
    return a.name.localeCompare(b.name);
  });

  // Load known staff members from our DB (populated when they log in)
  const staffMembers: StaffMemberInfo[] = await prisma.staffInfo.findMany({
    orderBy: { lastSeen: "desc" },
  });

  // Fetch current assignments from DB (exclude __ADMIN__ markers)
  const assignments = await prisma.staffAssignment.findMany({
    where: { companyLocationId: { not: "__ADMIN__" } },
    orderBy: { createdAt: "desc" },
  });

  // Fetch admin flags (staffIds that have __ADMIN__ assignment)
  const adminAssignments = await prisma.staffAssignment.findMany({
    where: { companyLocationId: "__ADMIN__" },
    select: { staffId: true },
  });
  const adminStaffIds = adminAssignments.map((a) => a.staffId);

  return json({ locations, staffMembers, assignments, adminStaffIds });
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

  if (intent === "toggle-admin") {
    const staffId = formData.get("staffId") as string;
    const isCurrentlyAdmin = formData.get("currentValue") === "true";

    if (!staffId) {
      return json({ error: "Staff ID is required" }, { status: 400 });
    }

    if (isCurrentlyAdmin) {
      await prisma.staffAssignment.deleteMany({
        where: { staffId, companyLocationId: "__ADMIN__" },
      });
    } else {
      try {
        await prisma.staffAssignment.create({
          data: { shop, staffId, companyLocationId: "__ADMIN__" },
        });
      } catch (err: unknown) {
        const prismaErr = err as { code?: string };
        if (prismaErr.code === "P2002") {
          return json({ error: "Already an admin" }, { status: 400 });
        }
        throw err;
      }
    }

    invalidatePattern(`staff:${staffId}:locations`);
    return json({ success: true });
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

  if (intent === "remove-all-assignments") {
    const staffId = formData.get("staffId") as string;
    if (!staffId) {
      return json({ error: "Staff ID is required" }, { status: 400 });
    }
    await prisma.staffAssignment.deleteMany({
      where: { staffId, companyLocationId: { not: "__ADMIN__" } },
    });
    invalidatePattern(`staff:${staffId}:locations`);
    return json({ success: true });
  }

  if (intent === "delete-staff") {
    const staffId = formData.get("staffId") as string;
    if (!staffId) {
      return json({ error: "Staff ID is required" }, { status: 400 });
    }
    await prisma.staffAssignment.deleteMany({ where: { staffId } });
    await prisma.staffInfo.deleteMany({ where: { id: staffId } });
    invalidatePattern(`staff:${staffId}:locations`);
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

interface RepCardProps {
  staff: StaffMemberInfo;
  isAdmin: boolean;
  staffAssignments: Array<{ id: string; companyLocationId: string }>;
  locationMap: Map<string, LocationInfo>;
  expanded: boolean;
  onToggleExpand: () => void;
  onRequestRemoveAll: () => void;
  onRequestDelete: () => void;
}

function RepCard({
  staff,
  isAdmin,
  staffAssignments,
  locationMap,
  expanded,
  onToggleExpand,
  onRequestRemoveAll,
  onRequestDelete,
}: RepCardProps) {
  const fetcher = useFetcher();
  const assignmentCount = staffAssignments.length;

  const sortedAssignments = useMemo(() => {
    return [...staffAssignments].sort((a, b) => {
      const la = locationMap.get(a.companyLocationId);
      const lb = locationMap.get(b.companyLocationId);
      const labelA = la ? `${la.company.name} ${la.name}` : a.companyLocationId;
      const labelB = lb ? `${lb.company.name} ${lb.name}` : b.companyLocationId;
      return labelA.localeCompare(labelB);
    });
  }, [staffAssignments, locationMap]);

  return (
    <Card>
      <BlockStack gap="300">
        <div
          onClick={onToggleExpand}
          style={{ cursor: "pointer" }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleExpand();
            }
          }}
        >
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <Icon source={expanded ? ChevronDownIcon : ChevronRightIcon} />
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  {staff.firstName} {staff.lastName}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {staff.email}
                </Text>
              </BlockStack>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center">
              {isAdmin && <Badge tone="success">Admin</Badge>}
              {staff.canSendInvoice && <Badge tone="info">Can Send Invoice</Badge>}
              <Badge tone={assignmentCount > 0 ? "attention" : undefined}>
                {assignmentCount === 0
                  ? "No stores"
                  : `${assignmentCount} ${assignmentCount === 1 ? "store" : "stores"}`}
              </Badge>
            </InlineStack>
          </InlineStack>
        </div>

        <Collapsible
          open={expanded}
          id={`rep-${staff.id}`}
          transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
        >
          <BlockStack gap="400">
            <Divider />

            <InlineStack gap="400" wrap>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle-admin" />
                <input type="hidden" name="staffId" value={staff.id} />
                <input type="hidden" name="currentValue" value={String(isAdmin)} />
                <Button submit>{isAdmin ? "Revoke admin" : "Grant admin"}</Button>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle-invoice-permission" />
                <input type="hidden" name="staffId" value={staff.id} />
                <input type="hidden" name="currentValue" value={String(staff.canSendInvoice)} />
                <Button submit>
                  {staff.canSendInvoice ? "Restrict invoice sending" : "Allow invoice sending"}
                </Button>
              </fetcher.Form>
            </InlineStack>

            <Divider />

            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Assigned stores
              </Text>
              {isAdmin && (
                <Banner tone="info">
                  <p>Admins automatically see every company location, regardless of assignments.</p>
                </Banner>
              )}
              {sortedAssignments.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No stores assigned.
                </Text>
              ) : (
                <BlockStack gap="100">
                  {sortedAssignments.map((a) => {
                    const loc = locationMap.get(a.companyLocationId);
                    return (
                      <Box
                        key={a.id}
                        padding="200"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">
                            {loc
                              ? `${loc.company.name} — ${loc.name}`
                              : a.companyLocationId}
                          </Text>
                          <fetcher.Form method="post">
                            <input type="hidden" name="intent" value="remove" />
                            <input type="hidden" name="assignmentId" value={a.id} />
                            <Button variant="plain" tone="critical" submit>
                              Remove
                            </Button>
                          </fetcher.Form>
                        </InlineStack>
                      </Box>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>

            <Divider />

            <InlineStack gap="200" align="end">
              {sortedAssignments.length > 0 && (
                <Button tone="critical" onClick={onRequestRemoveAll}>
                  Remove all assignments
                </Button>
              )}
              <Button variant="primary" tone="critical" onClick={onRequestDelete}>
                Delete sales rep
              </Button>
            </InlineStack>
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}

export default function Assignments() {
  const { locations, staffMembers, assignments, adminStaffIds } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [selectedStaff, setSelectedStaff] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("");
  const [locationSearchValue, setLocationSearchValue] = useState("");

  const [search, setSearch] = useState("");
  const [expandedReps, setExpandedReps] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<
    | { type: "remove-all"; staffId: string; staffName: string; count: number }
    | { type: "delete-staff"; staffId: string; staffName: string; count: number }
    | null
  >(null);

  const staffOptions = [
    { label: "Select a staff member...", value: "" },
    ...staffMembers.map((s) => ({
      label: `${s.firstName} ${s.lastName} (${s.email})`,
      value: s.id,
    })),
  ];

  const allLocationOptions = useMemo(
    () =>
      locations.map((l) => ({
        label: `${l.company.name} — ${l.name}`,
        value: l.id,
      })),
    [locations]
  );

  const filteredLocationOptions = useMemo(() => {
    if (!locationSearchValue) return allLocationOptions;
    const lower = locationSearchValue.toLowerCase();
    return allLocationOptions.filter((opt) =>
      opt.label.toLowerCase().includes(lower)
    );
  }, [allLocationOptions, locationSearchValue]);

  const handleLocationSelect = useCallback(
    (selected: string[]) => {
      const selectedId = selected[0] ?? "";
      setSelectedLocation(selectedId);
      const match = allLocationOptions.find((o) => o.value === selectedId);
      setLocationSearchValue(match?.label ?? "");
    },
    [allLocationOptions]
  );

  const locationMap = useMemo(
    () => new Map(locations.map((l) => [l.id, l])),
    [locations]
  );

  const assignmentsByStaff = useMemo(() => {
    const map = new Map<string, Array<{ id: string; companyLocationId: string }>>();
    for (const a of assignments) {
      const list = map.get(a.staffId) ?? [];
      list.push({ id: a.id, companyLocationId: a.companyLocationId });
      map.set(a.staffId, list);
    }
    return map;
  }, [assignments]);

  const adminSet = useMemo(() => new Set(adminStaffIds), [adminStaffIds]);

  const sortedStaff = useMemo(() => {
    return [...staffMembers].sort((a, b) => {
      const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [staffMembers]);

  const filteredStaff = useMemo(() => {
    if (!search.trim()) return sortedStaff;
    const lower = search.toLowerCase();
    return sortedStaff.filter((s) => {
      const name = `${s.firstName} ${s.lastName}`.toLowerCase();
      return name.includes(lower) || s.email.toLowerCase().includes(lower);
    });
  }, [sortedStaff, search]);

  const totalAssignments = assignments.length;

  const toggleExpand = useCallback((staffId: string) => {
    setExpandedReps((prev) => {
      const next = new Set(prev);
      if (next.has(staffId)) {
        next.delete(staffId);
      } else {
        next.add(staffId);
      }
      return next;
    });
  }, []);

  const actionData = fetcher.data as { error?: string; success?: boolean } | undefined;

  const closeModal = () => setPendingAction(null);

  const confirmPendingAction = () => {
    if (!pendingAction) return;
    const formData = new FormData();
    formData.set("intent", pendingAction.type);
    formData.set("staffId", pendingAction.staffId);
    fetcher.submit(formData, { method: "post" });
    closeModal();
  };

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
                    <input type="hidden" name="companyLocationId" value={selectedLocation} />
                    <Autocomplete
                      options={filteredLocationOptions}
                      selected={selectedLocation ? [selectedLocation] : []}
                      onSelect={handleLocationSelect}
                      textField={
                        <Autocomplete.TextField
                          label="Company Location"
                          value={locationSearchValue}
                          onChange={(value) => {
                            setLocationSearchValue(value);
                            if (!value) setSelectedLocation("");
                          }}
                          placeholder="Search companies..."
                          autoComplete="off"
                          prefix={<Icon source={SearchIcon} />}
                        />
                      }
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
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Sales Reps ({staffMembers.length})
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {totalAssignments} total store {totalAssignments === 1 ? "assignment" : "assignments"}
                    </Text>
                  </BlockStack>
                  {staffMembers.length > 0 && (
                    <InlineStack gap="200">
                      <Button
                        onClick={() =>
                          setExpandedReps(new Set(filteredStaff.map((s) => s.id)))
                        }
                      >
                        Expand all
                      </Button>
                      <Button onClick={() => setExpandedReps(new Set())}>
                        Collapse all
                      </Button>
                    </InlineStack>
                  )}
                </InlineStack>

                {staffMembers.length === 0 ? (
                  <EmptyState
                    heading="No sales reps yet"
                    image=""
                  >
                    <p>
                      Sales reps appear here automatically after they log into the app for the
                      first time.
                    </p>
                  </EmptyState>
                ) : (
                  <>
                    <TextField
                      label="Search reps"
                      labelHidden
                      value={search}
                      onChange={setSearch}
                      placeholder="Search by name or email..."
                      autoComplete="off"
                      prefix={<Icon source={SearchIcon} />}
                      clearButton
                      onClearButtonClick={() => setSearch("")}
                    />

                    {filteredStaff.length === 0 ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No reps match &quot;{search}&quot;.
                      </Text>
                    ) : (
                      <BlockStack gap="300">
                        {filteredStaff.map((staff) => (
                          <RepCard
                            key={staff.id}
                            staff={staff}
                            isAdmin={adminSet.has(staff.id)}
                            staffAssignments={assignmentsByStaff.get(staff.id) ?? []}
                            locationMap={locationMap}
                            expanded={expandedReps.has(staff.id)}
                            onToggleExpand={() => toggleExpand(staff.id)}
                            onRequestRemoveAll={() =>
                              setPendingAction({
                                type: "remove-all",
                                staffId: staff.id,
                                staffName: `${staff.firstName} ${staff.lastName}`,
                                count: (assignmentsByStaff.get(staff.id) ?? []).length,
                              })
                            }
                            onRequestDelete={() =>
                              setPendingAction({
                                type: "delete-staff",
                                staffId: staff.id,
                                staffName: `${staff.firstName} ${staff.lastName}`,
                                count: (assignmentsByStaff.get(staff.id) ?? []).length,
                              })
                            }
                          />
                        ))}
                      </BlockStack>
                    )}
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {pendingAction && (
        <Modal
          open
          onClose={closeModal}
          title={
            pendingAction.type === "delete-staff"
              ? `Delete ${pendingAction.staffName}?`
              : `Remove all assignments for ${pendingAction.staffName}?`
          }
          primaryAction={{
            content:
              pendingAction.type === "delete-staff"
                ? "Delete sales rep"
                : "Remove all assignments",
            destructive: true,
            onAction: confirmPendingAction,
            loading: fetcher.state === "submitting",
          }}
          secondaryActions={[{ content: "Cancel", onAction: closeModal }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {pendingAction.type === "delete-staff" ? (
                <>
                  <Text as="p" variant="bodyMd">
                    This will permanently remove <strong>{pendingAction.staffName}</strong> from
                    the staff list along with their {pendingAction.count}{" "}
                    {pendingAction.count === 1 ? "assignment" : "assignments"} and admin status.
                  </Text>
                  <Banner tone="warning">
                    <p>
                      If this person logs into the app again, they will reappear here automatically
                      with no assignments.
                    </p>
                  </Banner>
                </>
              ) : (
                <Text as="p" variant="bodyMd">
                  This will remove all {pendingAction.count} store{" "}
                  {pendingAction.count === 1 ? "assignment" : "assignments"} for{" "}
                  <strong>{pendingAction.staffName}</strong>. Their account and admin status (if
                  any) will not be affected.
                </Text>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
