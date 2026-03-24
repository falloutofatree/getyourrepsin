export interface StaffMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  active: boolean;
  avatar: {
    url: string;
  } | null;
  locale: string;
  isAdmin: boolean;
  canSendInvoice: boolean;
}
