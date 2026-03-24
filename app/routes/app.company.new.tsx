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
import { searchCustomerByEmail, createCustomer } from "../lib/graphql/customers";
import {
  createCompany,
  fetchPaymentTermsTemplates,
} from "../lib/graphql/companies";
import { assignCatalogToNewLocation } from "../lib/graphql/catalogs";
import { invalidatePattern } from "../lib/cache.server";
import prisma from "../db.server";

const PHONE_CODES = [
  { code: "US", dial: "+1", flag: "\u{1F1FA}\u{1F1F8}" },
  { code: "CA", dial: "+1", flag: "\u{1F1E8}\u{1F1E6}" },
  { code: "GB", dial: "+44", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "AU", dial: "+61", flag: "\u{1F1E6}\u{1F1FA}" },
  { code: "DE", dial: "+49", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "FR", dial: "+33", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "IT", dial: "+39", flag: "\u{1F1EE}\u{1F1F9}" },
  { code: "ES", dial: "+34", flag: "\u{1F1EA}\u{1F1F8}" },
  { code: "NL", dial: "+31", flag: "\u{1F1F3}\u{1F1F1}" },
  { code: "JP", dial: "+81", flag: "\u{1F1EF}\u{1F1F5}" },
  { code: "MX", dial: "+52", flag: "\u{1F1F2}\u{1F1FD}" },
  { code: "BR", dial: "+55", flag: "\u{1F1E7}\u{1F1F7}" },
  { code: "AR", dial: "+54", flag: "\u{1F1E6}\u{1F1F7}" },
  { code: "CO", dial: "+57", flag: "\u{1F1E8}\u{1F1F4}" },
  { code: "CL", dial: "+56", flag: "\u{1F1E8}\u{1F1F1}" },
  { code: "PE", dial: "+51", flag: "\u{1F1F5}\u{1F1EA}" },
  { code: "CN", dial: "+86", flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "KR", dial: "+82", flag: "\u{1F1F0}\u{1F1F7}" },
  { code: "IN", dial: "+91", flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "SG", dial: "+65", flag: "\u{1F1F8}\u{1F1EC}" },
  { code: "NZ", dial: "+64", flag: "\u{1F1F3}\u{1F1FF}" },
  { code: "BE", dial: "+32", flag: "\u{1F1E7}\u{1F1EA}" },
  { code: "AT", dial: "+43", flag: "\u{1F1E6}\u{1F1F9}" },
  { code: "CH", dial: "+41", flag: "\u{1F1E8}\u{1F1ED}" },
  { code: "SE", dial: "+46", flag: "\u{1F1F8}\u{1F1EA}" },
  { code: "NO", dial: "+47", flag: "\u{1F1F3}\u{1F1F4}" },
  { code: "DK", dial: "+45", flag: "\u{1F1E9}\u{1F1F0}" },
  { code: "FI", dial: "+358", flag: "\u{1F1EB}\u{1F1EE}" },
  { code: "PT", dial: "+351", flag: "\u{1F1F5}\u{1F1F9}" },
  { code: "IE", dial: "+353", flag: "\u{1F1EE}\u{1F1EA}" },
  { code: "PL", dial: "+48", flag: "\u{1F1F5}\u{1F1F1}" },
  { code: "CZ", dial: "+420", flag: "\u{1F1E8}\u{1F1FF}" },
  { code: "IL", dial: "+972", flag: "\u{1F1EE}\u{1F1F1}" },
  { code: "AE", dial: "+971", flag: "\u{1F1E6}\u{1F1EA}" },
  { code: "SA", dial: "+966", flag: "\u{1F1F8}\u{1F1E6}" },
  { code: "ZA", dial: "+27", flag: "\u{1F1FF}\u{1F1E6}" },
];

const phoneCodeOptions = PHONE_CODES.map((p) => ({
  label: `${p.flag} ${p.dial}`,
  value: p.dial,
}));

interface CountryWithProvinces {
  code: string;
  name: string;
  provinces: Array<{ code: string; name: string }>;
}

const COUNTRIES: CountryWithProvinces[] = [
  { code: "US", name: "United States", provinces: [
    { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
    { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
    { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
    { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
    { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
    { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
    { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
    { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
    { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
    { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
    { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
    { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
    { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
    { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
    { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
    { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
    { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "District of Columbia" },
  ]},
  { code: "CA", name: "Canada", provinces: [
    { code: "AB", name: "Alberta" }, { code: "BC", name: "British Columbia" }, { code: "MB", name: "Manitoba" },
    { code: "NB", name: "New Brunswick" }, { code: "NL", name: "Newfoundland and Labrador" },
    { code: "NS", name: "Nova Scotia" }, { code: "NT", name: "Northwest Territories" },
    { code: "NU", name: "Nunavut" }, { code: "ON", name: "Ontario" }, { code: "PE", name: "Prince Edward Island" },
    { code: "QC", name: "Quebec" }, { code: "SK", name: "Saskatchewan" }, { code: "YT", name: "Yukon" },
  ]},
  { code: "AU", name: "Australia", provinces: [
    { code: "ACT", name: "Australian Capital Territory" }, { code: "NSW", name: "New South Wales" },
    { code: "NT", name: "Northern Territory" }, { code: "QLD", name: "Queensland" },
    { code: "SA", name: "South Australia" }, { code: "TAS", name: "Tasmania" },
    { code: "VIC", name: "Victoria" }, { code: "WA", name: "Western Australia" },
  ]},
  { code: "MX", name: "Mexico", provinces: [
    { code: "AGU", name: "Aguascalientes" }, { code: "BCN", name: "Baja California" },
    { code: "BCS", name: "Baja California Sur" }, { code: "CAM", name: "Campeche" },
    { code: "CHP", name: "Chiapas" }, { code: "CHH", name: "Chihuahua" },
    { code: "COA", name: "Coahuila" }, { code: "COL", name: "Colima" },
    { code: "CMX", name: "Ciudad de Mexico" }, { code: "DUR", name: "Durango" },
    { code: "GUA", name: "Guanajuato" }, { code: "GRO", name: "Guerrero" },
    { code: "HID", name: "Hidalgo" }, { code: "JAL", name: "Jalisco" },
    { code: "MEX", name: "Mexico State" }, { code: "MIC", name: "Michoacan" },
    { code: "MOR", name: "Morelos" }, { code: "NAY", name: "Nayarit" },
    { code: "NLE", name: "Nuevo Leon" }, { code: "OAX", name: "Oaxaca" },
    { code: "PUE", name: "Puebla" }, { code: "QUE", name: "Queretaro" },
    { code: "ROO", name: "Quintana Roo" }, { code: "SLP", name: "San Luis Potosi" },
    { code: "SIN", name: "Sinaloa" }, { code: "SON", name: "Sonora" },
    { code: "TAB", name: "Tabasco" }, { code: "TAM", name: "Tamaulipas" },
    { code: "TLA", name: "Tlaxcala" }, { code: "VER", name: "Veracruz" },
    { code: "YUC", name: "Yucatan" }, { code: "ZAC", name: "Zacatecas" },
  ]},
  { code: "GB", name: "United Kingdom", provinces: [] },
  { code: "DE", name: "Germany", provinces: [] },
  { code: "FR", name: "France", provinces: [] },
  { code: "IT", name: "Italy", provinces: [] },
  { code: "ES", name: "Spain", provinces: [] },
  { code: "NL", name: "Netherlands", provinces: [] },
  { code: "JP", name: "Japan", provinces: [] },
  { code: "BR", name: "Brazil", provinces: [] },
  { code: "AR", name: "Argentina", provinces: [] },
  { code: "CO", name: "Colombia", provinces: [] },
  { code: "CL", name: "Chile", provinces: [] },
  { code: "PE", name: "Peru", provinces: [] },
  { code: "CN", name: "China", provinces: [] },
  { code: "KR", name: "South Korea", provinces: [] },
  { code: "IN", name: "India", provinces: [] },
  { code: "SG", name: "Singapore", provinces: [] },
  { code: "NZ", name: "New Zealand", provinces: [] },
  { code: "BE", name: "Belgium", provinces: [] },
  { code: "AT", name: "Austria", provinces: [] },
  { code: "CH", name: "Switzerland", provinces: [] },
  { code: "SE", name: "Sweden", provinces: [] },
  { code: "NO", name: "Norway", provinces: [] },
  { code: "DK", name: "Denmark", provinces: [] },
  { code: "FI", name: "Finland", provinces: [] },
  { code: "PT", name: "Portugal", provinces: [] },
  { code: "IE", name: "Ireland", provinces: [] },
  { code: "PL", name: "Poland", provinces: [] },
  { code: "CZ", name: "Czech Republic", provinces: [] },
  { code: "IL", name: "Israel", provinces: [] },
  { code: "AE", name: "United Arab Emirates", provinces: [] },
  { code: "SA", name: "Saudi Arabia", provinces: [] },
  { code: "ZA", name: "South Africa", provinces: [] },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await requireAuth(request);
  const templates = await fetchPaymentTermsTemplates(admin);
  return json({ paymentTermsTemplates: templates, countries: COUNTRIES });
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
    const addrCompany = (formData.get("addrCompany") as string).trim();
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

    // Step 1: Create customer if needed
    if (!existingCustomerId) {
      const customerResult = await createCustomer(admin, {
        email: contactEmail,
        firstName: contactFirstName || undefined,
        lastName: contactLastName || undefined,
        phone: contactPhone || undefined,
      });
      if (customerResult.errors.length > 0) {
        return json({
          intent,
          success: false,
          errors: customerResult.errors,
          companyLocationId: null,
        });
      }
    }

    // Step 2: Create company with location and contact
    const companyResult = await createCompany(admin, {
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
          phone: addrPhone || undefined,
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
      companyContact: {
        email: contactEmail,
        firstName: contactFirstName || undefined,
        lastName: contactLastName || undefined,
        phone: contactPhone || undefined,
      },
    });

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

    // Step 3: Assign catalog based on country
    const catalogResult = await assignCatalogToNewLocation(
      admin,
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
      shopify.toast.show("Company created successfully!");
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
    formData.set("contactPhone", contactPhone ? `${contactPhoneCode}${contactPhone}` : "");
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
    formData.set("addrPhone", addrPhone ? `${addrPhoneCode}${addrPhone}` : "");
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

  const countryOptions = [
    { label: "Select a country...", value: "" },
    ...(countries as CountryWithProvinces[]).map((c) => ({
      label: c.name,
      value: c.code,
    })),
  ];

  const selectedCountry = (countries as CountryWithProvinces[]).find(
    (c) => c.code === countryCode,
  );
  const provinceOptions = selectedCountry?.provinces?.length
    ? [
        { label: "Select a state/province...", value: "" },
        ...selectedCountry.provinces.map((p) => ({
          label: p.name,
          value: p.code,
        })),
      ]
    : null;

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
                        <div style={{ width: "110px" }}>
                          <Select
                            label="Code"
                            options={phoneCodeOptions}
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
                  <Select
                    label="Country/region"
                    options={countryOptions}
                    value={countryCode}
                    onChange={(v) => {
                      setCountryCode(v);
                      setZoneCode("");
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
                    {provinceOptions ? (
                      <Select
                        label="State/Province"
                        options={provinceOptions}
                        value={zoneCode}
                        onChange={setZoneCode}
                      />
                    ) : (
                      <TextField
                        label="State/Province"
                        value={zoneCode}
                        onChange={setZoneCode}
                        autoComplete="address-level1"
                      />
                    )}
                  </InlineGrid>
                  <TextField
                    label="ZIP code"
                    value={zip}
                    onChange={setZip}
                    autoComplete="postal-code"
                  />
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ width: "110px" }}>
                      <Select
                        label="Code"
                        options={phoneCodeOptions}
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
