export interface CustomerSearchResult {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  numberOfOrders: string;
}

export interface CompanyCreateFormData {
  // Contact
  contactEmail: string;
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
  existingCustomerId: string | null;

  // Company
  companyName: string;
  externalId: string;

  // Address
  countryCode: string;
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  zoneCode: string;
  zip: string;
  phone: string;

  // Terms & Tax
  paymentTermsTemplateId: string;
  taxExempt: boolean;
  taxRegistrationId: string;
}
