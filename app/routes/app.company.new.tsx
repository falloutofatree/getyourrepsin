import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Checkbox,
  Button,
  Banner,
  Badge,
  Divider,
  InlineGrid,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { requireAuth } from "../lib/auth.server";
import { searchCustomerByEmail } from "../lib/graphql/customers";
import {
  createCompany,
  assignCustomerAsContact,
  fetchPaymentTermsTemplates,
} from "../lib/graphql/companies";
import { assignCatalogToNewLocation } from "../lib/graphql/catalogs";
import { invalidatePattern } from "../lib/cache.server";
import prisma from "../db.server";
import { getAllCountries } from "../lib/data/countries.server";
import { toE164 } from "../lib/utils/phone";
import { CountryCombobox } from "../components/CountryCombobox";
import { ZoneCombobox } from "../components/ZoneCombobox";
import { PhoneCodeCombobox } from "../components/PhoneCodeCombobox";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await requireAuth(request);
  const templates = await fetchPaymentTermsTemplates(admin);
  return json({ paymentTermsTemplates: templates, countries: getAllCountries() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, staffMember, shop } = await requireAuth(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search-customer") {
    const email = (formData.get("email") as string).trim();
    if (!email) {
      return json({ intent, customer: null, error: "Email is required" });
    }

    try {
      const customer = await searchCustomerByEmail(admin, email);
      return json({ intent, customer, error: null });
    } catch (err) {
      return json({
        intent,
        customer: null,
        error: err instanceof Error ? err.message : "Search failed",
      });
    }
  }

  if (intent === "create-company") {
    const errors: string[] = [];

    // Extract form data
    const contactEmail = (formData.get("contactEmail") as string).trim();
    const contactFirstName = (formData.get("contactFirstName") as string).trim();
    const contactLastName = (formData.get("contactLastName") as string).trim();
    const contactPhone = (formData.get("contactPhone") as string).trim();
    const existingCustomerId = formData.get("existingCustomerId") as string;

    const companyName = (formData.get("companyName") as string).trim();
    const externalId = (formData.get("externalId") as string).trim();

    const countryCode = formData.get("countryCode") as string;
    const addrFirstName = (formData.get("addrFirstName") as string).trim();
    const addrLastName = (formData.get("addrLastName") as string).trim();
    const address1 = (formData.get("address1") as string).trim();
    const address2 = (formData.get("address2") as string).trim();
    const city = (formData.get("city") as string).trim();
    const zoneCode = (formData.get("zoneCode") as string).trim();
    const zip = (formData.get("zip") as string).trim();
    const addrPhone = (formData.get("addrPhone") as string).trim();

    const paymentTermsTemplateId = formData.get("paymentTermsTemplateId") as string;
    const taxExempt = formData.get("taxExempt") === "true";
    const taxRegistrationId = (formData.get("taxRegistrationId") as string).trim();

    // Validation
    if (!contactEmail) errors.push("Contact email is required");
    if (!companyName) errors.push("Company name is required");
    if (!countryCode) errors.push("Country is required");

    if (errors.length > 0) {
      return json({ intent, success: false, errors, companyLocationId: null });
    }

    // Create the company together with its location and contact.
    //
    // For a BRAND-NEW customer we let companyCreate create the customer +
    // contact in one shot via `companyContact`. We must NOT pre-create the
    // customer separately — companyContact also creates a customer from the
    // email, so doing both would fail with "Email address has already been
    // taken".
    //
    // For an EXISTING customer we omit `companyContact` entirely (its email is
    // already taken, so companyCreate would reject it) and link them to the new
    // company afterwards with companyAssignCustomerAsContact.
    const buildCompanyInput = (includePhones: boolean) => ({
      company: {
        name: companyName,
        externalId: externalId || undefined,
      },
      companyLocation: {
        name: companyName,
        shippingAddress: {
          address1: address1 || undefined,
          address2: address2 || undefined,
          city: city || undefined,
          countryCode,
          firstName: addrFirstName || undefined,
          lastName: addrLastName || undefined,
          phone: includePhones ? addrPhone || undefined : undefined,
          zip: zip || undefined,
          zoneCode: zoneCode || undefined,
        },
        billingSameAsShipping: true,
        buyerExperienceConfiguration: paymentTermsTemplateId
          ? { paymentTermsTemplateId }
          : undefined,
        taxExempt,
        taxRegistrationId: taxRegistrationId || undefined,
      },
      companyContact: existingCustomerId
        ? undefined
        : {
            email: contactEmail,
            firstName: contactFirstName || undefined,
            lastName: contactLastName || undefined,
            phone: includePhones ? contactPhone || undefined : undefined,
          },
    });

    let companyResult = await createCompany(admin, buildCompanyInput(true));

    // A phone number is optional. If Shopify rejects ONLY because the phone is
    // invalid (e.g. the dial code doesn't match the number's country), retry
    // without the phone so the rep isn't blocked, and flag it so we can warn
    // them to fix the number later.
    let phoneSkipped = false;
    const hadPhone = Boolean(addrPhone || contactPhone);
    if (
      companyResult.errors.length > 0 &&
      hadPhone &&
      companyResult.errors.every((e) => /phone/i.test(e))
    ) {
      companyResult = await createCompany(admin, buildCompanyInput(false));
      phoneSkipped = companyResult.errors.length === 0;
    }

    if (companyResult.errors.length > 0) {
      return json({
        intent,
        success: false,
        errors: companyResult.errors,
        companyLocationId: null,
      });
    }

    const newCompany = companyResult.company;
    const newLocationId = newCompany?.locations?.nodes?.[0]?.id;

    if (!newLocationId) {
      return json({
        intent,
        success: false,
        errors: ["Company created but no location was returned"],
        companyLocationId: null,
      });
    }

    // Link the existing customer to the new company as a contact.
    if (existingCustomerId && newCompany?.id) {
      const assignResult = await assignCustomerAsContact(
        admin,
        newCompany.id,
        existingCustomerId,
      );
      if (assignResult.errors.length > 0) {
        return json({
          intent,
          success: false,
          errors: assignResult.errors,
          companyLocationId: null,
        });
      }
    }

    // Step 3: Assign the B2B catalog configured for this country.
    const catalogResult = await assignCatalogToNewLocation(
      admin,
      shop,
      newLocationId,
      countryCode,
    );
    if (catalogResult.errors.length > 0) {
      console.warn("[Company New] Catalog assignment warnings:", catalogResult.errors);
    }

    // Step 4: Create staff assignment for the rep
    try {
      await prisma.staffAssignment.create({
        data: {
          shop,
          staffId: staffMember.id,
          companyLocationId: newLocationId,
        },
      });
      invalidatePattern(`staff:${staffMember.id}:locations`);
    } catch (err) {
      console.error("[Company New] Staff assignment failed:", err);
    }

    return json({
      intent,
      success: true,
      errors: [],
      companyLocationId: newLocationId,
      companyName: newCompany?.name,
      phoneSkipped,
      catalogTitle: catalogResult.catalogTitle,
      catalogAssigned: Boolean(catalogResult.catalogId),
    });
  }

  return json({ intent: null, error: "Unknown action" });
};

export default function NewCompany() {
  const { paymentTermsTemplates, countries } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [step, setStep] = useState(1);

  // Step 1: Contact
  const [contactEmail, setContactEmail] = useState("");
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactPhoneCode, setContactPhoneCode] = useState("+1");
  const [existingCustomerId, setExistingCustomerId] = useState<string | null>(null);
  const [customerSearched, setCustomerSearched] = useState(false);
  const [customerFound, setCustomerFound] = useState(false);

  // Step 2: Company
  const [companyName, setCompanyName] = useState("");
  const [externalId, setExternalId] = useState("");

  // Step 3: Address
  const [countryCode, setCountryCode] = useState("");
  const [addrFirstName, setAddrFirstName] = useState("");
  const [addrLastName, setAddrLastName] = useState("");
  const [addrCompany, setAddrCompany] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [zoneCode, setZoneCode] = useState("");
  const [zip, setZip] = useState("");
  const [addrPhone, setAddrPhone] = useState("");
  const [addrPhoneCode, setAddrPhoneCode] = useState("+1");

  // Step 4: Terms & Tax
  const [paymentTermsTemplateId, setPaymentTermsTemplateId] = useState("");
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxRegistrationId, setTaxRegistrationId] = useState("");

  // Handle customer search result
  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (data?.intent === "search-customer" && fetcher.state === "idle") {
      setCustomerSearched(true);
      if (data.customer) {
        const c = data.customer as {
          id: string;
          firstName: string | null;
          lastName: string | null;
          phone: string | null;
        };
        setExistingCustomerId(c.id);
        setContactFirstName(c.firstName ?? "");
        setContactLastName(c.lastName ?? "");
        setContactPhone(c.phone ?? "");
        setCustomerFound(true);
      } else {
        setExistingCustomerId(null);
        setCustomerFound(false);
      }
    }
  }, [fetcher.data, fetcher.state]);

  // Handle company creation success
  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (data?.intent === "create-company" && data?.success) {
      if (!data.catalogAssigned) {
        // Without a catalog the location falls back to default shop pricing,
        // so the rep needs to know before they quote anything.
        shopify.toast.show(
          "Company created, but no catalog was assigned for this country. Pricing may be wrong until an admin sets it.",
          { isError: true, duration: 8000 },
        );
      } else {
        shopify.toast.show(
          data.phoneSkipped
            ? "Company created, but the phone number was invalid and was not saved. You can add it later."
            : `Company created on catalog "${data.catalogTitle ?? "assigned"}"`,
        );
      }
      const locId = data.companyLocationId as string;
      const numericId = locId.replace("gid://shopify/CompanyLocation/", "");
      navigate(`/app/company/${numericId}`);
    }
  }, [fetcher.data, shopify, navigate]);

  const handleSearchCustomer = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "search-customer");
    formData.set("email", contactEmail);
    fetcher.submit(formData, { method: "POST" });
  }, [contactEmail, fetcher]);

  const handleCreateCompany = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "create-company");
    formData.set("contactEmail", contactEmail);
    formData.set("contactFirstName", contactFirstName);
    formData.set("contactLastName", contactLastName);
    formData.set("contactPhone", toE164(contactPhoneCode, contactPhone));
    formData.set("existingCustomerId", existingCustomerId ?? "");
    formData.set("companyName", companyName);
    formData.set("externalId", externalId);
    formData.set("countryCode", countryCode);
    formData.set("addrFirstName", addrFirstName);
    formData.set("addrLastName", addrLastName);
    formData.set("addrCompany", addrCompany);
    formData.set("address1", address1);
    formData.set("address2", address2);
    formData.set("city", city);
    formData.set("zoneCode", zoneCode);
    formData.set("zip", zip);
    formData.set("addrPhone", toE164(addrPhoneCode, addrPhone));
    formData.set("paymentTermsTemplateId", paymentTermsTemplateId);
    formData.set("taxExempt", String(taxExempt));
    formData.set("taxRegistrationId", taxRegistrationId);
    fetcher.submit(formData, { method: "POST" });
  }, [
    contactEmail, contactFirstName, contactLastName, contactPhone, contactPhoneCode,
    existingCustomerId, companyName, externalId, countryCode,
    addrFirstName, addrLastName, addrCompany, address1, address2,
    city, zoneCode, zip, addrPhone, addrPhoneCode, paymentTermsTemplateId,
    taxExempt, taxRegistrationId, fetcher,
  ]);

  const actionData = fetcher.data as Record<string, unknown> | undefined;
  const actionErrors =
    actionData?.intent === "create-company"
      ? (actionData?.errors as string[]) ?? []
      : [];
  const searchError =
    actionData?.intent === "search-customer"
      ? (actionData?.error as string | null)
      : null;
  const isSubmitting = fetcher.state === "submitting";

  const VALID_B2B_TYPES = ["NET", "FULFILLMENT"];
  const paymentTermsOptions = [
    { label: "No payment terms", value: "" },
    ...paymentTermsTemplates
      .filter((t) => VALID_B2B_TYPES.includes(t.paymentTermsType))
      .map((t) => ({
        label: t.name || `${t.paymentTermsType} (${t.dueInDays} days)`,
        value: t.id,
      })),
  ];

  const selectedCountry = countries.find((c) => c.code === countryCode);

  const canProceedStep1 = contactEmail && customerSearched;
  const canProceedStep2 = companyName;
  const canProceedStep3 = countryCode;

  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="New Company" />
      <BlockStack gap="500">
        {actionErrors.length > 0 && (
          <Banner tone="critical">
            {actionErrors.map((err, i) => (
              <p key={i}>{err}</p>
            ))}
          </Banner>
        )}

        {/* Progress indicator */}
        <Card>
          <InlineStack gap="400" align="center">
            {[1, 2, 3, 4].map((s) => (
              <Button
                key={s}
                variant={step === s ? "primary" : step > s ? "tertiary" : "plain"}
                onClick={() => {
                  if (s < step) setStep(s);
                }}
                disabled={s > step}
              >
                {s === 1 ? "Contact" : s === 2 ? "Company" : s === 3 ? "Address" : "Terms & Tax"}
              </Button>
            ))}
          </InlineStack>
        </Card>

        <Layout>
          <Layout.Section>
            {/* Step 1: Contact */}
            {step === 1 && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Main Contact
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Search by email to find an existing customer, or create a new one.
                  </Text>

                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Email"
                        type="email"
                        value={contactEmail}
                        onChange={(v) => {
                          setContactEmail(v);
                          setCustomerSearched(false);
                          setCustomerFound(false);
                          setExistingCustomerId(null);
                        }}
                        autoComplete="email"
                        requiredIndicator
                      />
                    </div>
                    <Button
                      onClick={handleSearchCustomer}
                      loading={isSubmitting && actionData?.intent === "search-customer"}
                      disabled={!contactEmail}
                    >
                      Search
                    </Button>
                  </InlineStack>

                  {searchError && (
                    <Banner tone="critical">
                      <p>{searchError}</p>
                    </Banner>
                  )}

                  {customerSearched && customerFound && (
                    <Banner tone="success">
                      <p>
                        Customer found! Their information has been pre-filled below.
                      </p>
                    </Banner>
                  )}

                  {customerSearched && !customerFound && (
                    <Banner tone="info">
                      <p>
                        No existing customer found. A new customer will be created.
                      </p>
                    </Banner>
                  )}

                  {customerSearched && (
                    <>
                      <InlineGrid columns={2} gap="300">
                        <TextField
                          label="First name"
                          value={contactFirstName}
                          onChange={setContactFirstName}
                          autoComplete="given-name"
                          disabled={customerFound}
                        />
                        <TextField
                          label="Last name"
                          value={contactLastName}
                          onChange={setContactLastName}
                          autoComplete="family-name"
                          disabled={customerFound}
                        />
                      </InlineGrid>
                      <InlineStack gap="200" blockAlign="end">
                        <div style={{ width: "180px" }}>
                          <PhoneCodeCombobox
                            label="Code"
                            countries={countries}
                            value={contactPhoneCode}
                            onChange={setContactPhoneCode}
                            disabled={customerFound}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Phone"
                            value={contactPhone}
                            onChange={setContactPhone}
                            autoComplete="tel"
                            disabled={customerFound}
                          />
                        </div>
                      </InlineStack>
                    </>
                  )}

                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      onClick={() => setStep(2)}
                      disabled={!canProceedStep1}
                    >
                      Next
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* Step 2: Company */}
            {step === 2 && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Company Information
                  </Text>
                  <TextField
                    label="Company name"
                    value={companyName}
                    onChange={setCompanyName}
                    autoComplete="organization"
                    requiredIndicator
                    helpText="This will appear in customer accounts and at checkout."
                  />
                  <TextField
                    label="Company ID"
                    value={externalId}
                    onChange={setExternalId}
                    autoComplete="off"
                    helpText="Add an existing external ID or create a unique ID."
                  />
                  <InlineStack align="space-between">
                    <Button onClick={() => setStep(1)}>Back</Button>
                    <Button
                      variant="primary"
                      onClick={() => setStep(3)}
                      disabled={!canProceedStep2}
                    >
                      Next
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* Step 3: Address */}
            {step === 3 && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Shipping Address
                  </Text>
                  <CountryCombobox
                    label="Country/region"
                    countries={countries}
                    value={countryCode}
                    onChange={(v) => {
                      setCountryCode(v);
                      setZoneCode("");
                      // Keep the phone dial code in sync with the country so we
                      // don't build e.g. "+1<non-US number>", which Shopify
                      // rejects as an invalid phone.
                      const dial = countries.find((c) => c.code === v)?.dial;
                      if (dial) setAddrPhoneCode(dial);
                    }}
                    requiredIndicator
                  />
                  <InlineGrid columns={2} gap="300">
                    <TextField
                      label="First name"
                      value={addrFirstName}
                      onChange={setAddrFirstName}
                      autoComplete="given-name"
                    />
                    <TextField
                      label="Last name"
                      value={addrLastName}
                      onChange={setAddrLastName}
                      autoComplete="family-name"
                    />
                  </InlineGrid>
                  <TextField
                    label="Company/attention"
                    value={addrCompany}
                    onChange={setAddrCompany}
                    autoComplete="organization"
                  />
                  <TextField
                    label="Address"
                    value={address1}
                    onChange={setAddress1}
                    autoComplete="address-line1"
                  />
                  <TextField
                    label="Apartment, suite, etc"
                    value={address2}
                    onChange={setAddress2}
                    autoComplete="address-line2"
                  />
                  <InlineGrid columns={2} gap="300">
                    <TextField
                      label="City"
                      value={city}
                      onChange={setCity}
                      autoComplete="address-level2"
                    />
                    <ZoneCombobox
                      label="State/Province"
                      countryCode={countryCode}
                      value={zoneCode}
                      onChange={setZoneCode}
                    />
                  </InlineGrid>
                  <TextField
                    label="ZIP code"
                    value={zip}
                    onChange={setZip}
                    autoComplete="postal-code"
                  />
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ width: "180px" }}>
                      <PhoneCodeCombobox
                        label="Code"
                        countries={countries}
                        value={addrPhoneCode}
                        onChange={setAddrPhoneCode}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Phone"
                        value={addrPhone}
                        onChange={setAddrPhone}
                        autoComplete="tel"
                      />
                    </div>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Button onClick={() => setStep(2)}>Back</Button>
                    <Button
                      variant="primary"
                      onClick={() => setStep(4)}
                      disabled={!canProceedStep3}
                    >
                      Next
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* Step 4: Terms & Tax + Review */}
            {step === 4 && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Payment Terms
                    </Text>
                    <Select
                      label="Payment terms"
                      options={paymentTermsOptions}
                      value={paymentTermsTemplateId}
                      onChange={setPaymentTermsTemplateId}
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Tax Details
                    </Text>
                    <TextField
                      label="Tax ID"
                      value={taxRegistrationId}
                      onChange={setTaxRegistrationId}
                      autoComplete="off"
                    />
                    <Checkbox
                      label="Tax exempt"
                      checked={taxExempt}
                      onChange={setTaxExempt}
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Review
                    </Text>
                    <Divider />
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">Contact</Text>
                        <Text as="span" variant="bodySm">
                          {contactFirstName} {contactLastName} ({contactEmail})
                        </Text>
                      </InlineStack>
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">Company</Text>
                        <Text as="span" variant="bodySm">{companyName}</Text>
                      </InlineStack>
                      {externalId && (
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" tone="subdued">External ID</Text>
                          <Text as="span" variant="bodySm">{externalId}</Text>
                        </InlineStack>
                      )}
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">Address</Text>
                        <Text as="span" variant="bodySm">
                          {[address1, city, zoneCode, zip].filter(Boolean).join(", ")}
                        </Text>
                      </InlineStack>
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" tone="subdued">Country</Text>
                        <Text as="span" variant="bodySm">
                          {selectedCountry?.name ?? countryCode}
                        </Text>
                      </InlineStack>
                      {taxExempt && (
                        <Badge tone="info">Tax Exempt</Badge>
                      )}
                    </BlockStack>
                    <Divider />
                    <InlineStack align="space-between">
                      <Button onClick={() => setStep(3)}>Back</Button>
                      <Button
                        variant="primary"
                        onClick={handleCreateCompany}
                        loading={isSubmitting && actionData?.intent === "create-company"}
                      >
                        Create Company
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </BlockStack>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return (
    <Page backAction={{ content: "Dashboard", url: "/app" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" variant="bodyMd">
            An error occurred while creating the company. Please try again.
          </Text>
          <Button url="/app">Back to Dashboard</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
