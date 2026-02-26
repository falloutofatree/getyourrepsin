# B2B Sales Rep Portal — Custom Shopify App

## Technical Specification for Development

**Store Platform:** Shopify Plus
**Business Model:** B2B (wholesale) with optional B2C
**Date:** February 2026

---

## 1. PROBLEM STATEMENT

Shopify's native B2B has a confirmed limitation: **when sales reps create draft orders in the admin, they can see ALL products** — not just those in the catalog assigned to their companies. This means a rep assigned to one region could accidentally add products from another region's catalog to a draft order.

The B2B storefront (customer-facing) correctly filters products by catalog. But the admin product picker does not. Shopify has no extension point to modify the admin product picker, so we need to build a **separate ordering interface** that enforces catalog-based product filtering.

---

## 2. APP OVERVIEW

Build a **Shopify Embedded App** that provides sales reps with a catalog-filtered ordering portal. The app lives inside the Shopify admin as an embedded app and replaces the native draft order creation flow for sales reps.

### Core Workflow
1. Rep opens the app inside Shopify admin
2. App identifies the current staff member via `currentStaffMember` query
3. App fetches only the company locations assigned to that staff member
4. Rep selects a company location → app fetches only the catalog/products published to that location
5. Rep browses products, adds to cart, sets quantities
6. Rep submits → app creates a B2B draft order via `draftOrderCreate` mutation
7. Rep sends invoice to customer → `draftOrderInvoiceSend` mutation
8. Customer receives email with checkout link, pays through Shopify's standard B2B checkout (where all validation functions run)

---

## 3. TECH STACK

| Layer | Technology |
|-------|------------|
| Framework | Shopify Remix App Template (React Router) |
| Auth | Shopify App Bridge + Session Token (automatic with template) |
| API | Shopify GraphQL Admin API (version 2025-10 or latest stable) |
| UI Components | Shopify Polaris (default with template) + custom CSS for client branding |
| Database | Prisma + SQLite (or PostgreSQL for production) — session storage |
| Hosting | Fly.io, Railway, or Vercel (Shopify CLI handles deploy) |

### Required Access Scopes
```
read_products
read_product_listings
read_publications
read_companies
read_customers
write_draft_orders
read_draft_orders
read_orders
read_staff_members
```

---

## 4. SHOPIFY API ENDPOINTS — COMPLETE REFERENCE

### 4.1 Authentication & Current Staff Member

**Get the currently logged-in staff member:**
```graphql
query CurrentStaffMember {
  currentStaffMember {
    id
    firstName
    lastName
    email
    active
    avatar {
      url
    }
    locale
  }
}
```
- No arguments needed — returns the staff member making the API request
- The `id` format: `gid://shopify/StaffMember/{numericId}`
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/queries/currentStaffMember

---

### 4.2 Company Locations Assigned to Staff Member

**Get all company locations assigned to a specific staff member:**
```graphql
query CompanyLocationsForStaff($staffMemberId: ID!) {
  companyLocations(first: 100, query: "") {
    nodes {
      id
      name
      company {
        id
        name
      }
      staffMemberAssignments(first: 10) {
        nodes {
          staffMember {
            id
            firstName
            lastName
          }
        }
      }
      billingAddress {
        address1
        city
        province
        country
      }
      shippingAddress {
        address1
        city
        province
        country
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

**IMPORTANT IMPLEMENTATION NOTE:** The API does not support filtering `companyLocations` directly by `staffMemberId`. You must:
1. Fetch all company locations (paginate through all)
2. Filter client-side by checking `staffMemberAssignments` for the current staff member's ID

**Alternative approach — query from the staff member side:**
```graphql
query StaffMemberCompanies($id: ID!) {
  staffMember(id: $id) {
    id
    firstName
    lastName
  }
}
```
Then iterate company locations and check assignments. Consider caching this mapping.

- Object: `CompanyLocationStaffMemberAssignment`
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/CompanyLocationStaffMemberAssignment
- Company Location docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/CompanyLocation

---

### 4.3 Catalogs — Get Catalog for a Company Location

**Get all B2B catalogs with their assigned company locations:**
```graphql
query B2BCatalogs {
  catalogs(first: 50, type: COMPANY_LOCATION) {
    nodes {
      id
      title
      status
      ... on CompanyLocationCatalog {
        companyLocationsCount
        companyLocations(first: 100) {
          nodes {
            id
            name
            company {
              id
              name
            }
          }
        }
      }
      publication {
        id
      }
      priceList {
        id
        currency
        name
      }
    }
  }
}
```

**Get catalogs for a specific company location:**
```graphql
query CompanyLocationCatalogs($companyLocationId: ID!) {
  companyLocation(id: $companyLocationId) {
    id
    name
    catalogs(first: 10) {
      nodes {
        id
        title
        status
        publication {
          id
        }
        priceList {
          id
          currency
        }
      }
    }
  }
}
```

- Catalog types: `COMPANY_LOCATION` (B2B), `MARKET`, `APP`
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/queries/catalogs
- Object: https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Catalog

---

### 4.4 Products — Get Products from a Catalog's Publication

**This is the KEY query that enforces product visibility.** Once you have the catalog's `publication.id`, query its products:

```graphql
query CatalogProducts($publicationId: ID!, $first: Int!, $after: String, $query: String) {
  publication(id: $publicationId) {
    id
    products(first: $first, after: $after, query: $query) {
      nodes {
        id
        title
        handle
        description
        vendor
        productType
        status
        featuredImage {
          url
          altText
        }
        images(first: 5) {
          nodes {
            url
            altText
          }
        }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            availableForSale
            inventoryQuantity
            selectedOptions {
              name
              value
            }
            image {
              url
              altText
            }
          }
        }
        options {
          name
          values
        }
        totalInventory
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

**Alternative — check if a single product is published to a company location context:**
```graphql
query IsProductPublished($productId: ID!, $companyLocationId: ID!) {
  product(id: $productId) {
    title
    publishedInContext(
      context: { companyLocationId: $companyLocationId }
    )
  }
}
```

**Filter products by publication_ids in the products query:**
```graphql
query ProductsByPublication($publicationId: String!) {
  products(first: 50, query: "publication_ids:$publicationId") {
    nodes {
      id
      title
      # ...
    }
  }
}
```
Note: The `publication_ids` filter expects numeric IDs, not GIDs.

- Publication object: https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication
- Product query: https://shopify.dev/docs/api/admin-graphql/latest/queries/products

---

### 4.5 Price Lists — Get B2B Pricing

The catalog's `priceList` contains wholesale pricing overrides. Query prices for variants:

```graphql
query PriceListPrices($priceListId: ID!, $first: Int!, $after: String) {
  priceList(id: $priceListId) {
    id
    name
    currency
    prices(first: $first, after: $after) {
      nodes {
        variant {
          id
        }
        price {
          amount
          currencyCode
        }
        compareAtPrice {
          amount
          currencyCode
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

- If no price override exists for a variant, fall back to the variant's default `price`
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList

---

### 4.6 Company Contacts — Get Contacts for Invoice

```graphql
query CompanyContacts($companyLocationId: ID!) {
  companyLocation(id: $companyLocationId) {
    id
    name
    company {
      id
      name
      contacts(first: 50) {
        nodes {
          id
          customer {
            id
            email
            firstName
            lastName
          }
          isMainContact
        }
      }
    }
  }
}
```

---

### 4.7 Draft Order — Create B2B Draft Order

**This is the core mutation that creates the order:**

```graphql
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
```

**Variables structure:**
```json
{
  "input": {
    "purchasingEntity": {
      "purchasingCompany": {
        "companyId": "gid://shopify/Company/XXXXX",
        "companyLocationId": "gid://shopify/CompanyLocation/XXXXX",
        "companyContactId": "gid://shopify/CompanyContact/XXXXX"
      }
    },
    "email": "buyer@example.com",
    "note": "Order placed by [Rep Name] via Sales Portal",
    "tags": ["sales-rep-portal", "rep-name"],
    "lineItems": [
      {
        "variantId": "gid://shopify/ProductVariant/XXXXX",
        "quantity": 3
      }
    ],
    "shippingAddress": {
      "address1": "123 Main St",
      "city": "Los Angeles",
      "province": "California",
      "country": "US",
      "zip": "90001"
    },
    "billingAddress": {
      "address1": "123 Main St",
      "city": "Los Angeles",
      "province": "California",
      "country": "US",
      "zip": "90001"
    }
  }
}
```

**CRITICAL:** The `purchasingEntity.purchasingCompany` object links this draft order to the B2B company. This means:
- The order shows up under the company in Shopify admin
- Checkout validation functions run when the invoice is paid
- B2B pricing from the catalog's price list applies

- Docs: https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate

---

### 4.8 Draft Order — Send Invoice

```graphql
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
```

**Variables:**
```json
{
  "id": "gid://shopify/DraftOrder/XXXXX",
  "email": {
    "to": "buyer@example.com",
    "subject": "Your Wholesale Order",
    "customMessage": "Please review and complete your order."
  }
}
```

- Sends email with secure checkout link
- Customer pays at checkout → all Shopify checkout validation functions run
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderInvoiceSend

---

### 4.9 Draft Orders — List Rep's Orders

```graphql
query RepDraftOrders($query: String!) {
  draftOrders(first: 50, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id
      name
      status
      email
      createdAt
      updatedAt
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        firstName
        lastName
        email
      }
      purchasingEntity {
        ... on PurchasingCompany {
          company {
            id
            name
          }
          companyLocation {
            id
            name
          }
        }
      }
      lineItems(first: 10) {
        nodes {
          title
          quantity
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

**Filter by tag to show only orders from the portal:**
```json
{
  "query": "tag:sales-rep-portal"
}
```

---

### 4.10 Orders — View Completed Orders

```graphql
query CompanyOrders($companyLocationId: ID!) {
  orders(first: 50, query: "company_location_id:$companyLocationId", sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
  }
}
```

---

## 5. APP ARCHITECTURE

### 5.1 File Structure (Remix/React Router)
```
app/
├── routes/
│   ├── app._index.tsx          # Dashboard — company selector
│   ├── app.company.$id.tsx     # Company detail — product catalog
│   ├── app.cart.tsx             # Cart review & submit
│   ├── app.orders.tsx           # Order history
│   ├── app.order.$id.tsx        # Order detail
│   └── webhooks.tsx             # Webhook handlers
├── components/
│   ├── CompanySelector.tsx      # Company/location list
│   ├── ProductGrid.tsx          # Product catalog grid
│   ├── ProductCard.tsx          # Individual product card
│   ├── VariantSelector.tsx      # Variant picker (color/size)
│   ├── CartSummary.tsx          # Cart sidebar
│   ├── OrderSummary.tsx         # Order confirmation
│   └── AppBranding.tsx          # Client branding wrapper
├── hooks/
│   ├── useCurrentStaff.ts       # Fetch current staff member
│   ├── useAssignedCompanies.ts  # Fetch assigned company locations
│   ├── useCatalogProducts.ts    # Fetch products from catalog
│   ├── useCart.ts               # Cart state management
│   └── usePriceList.ts          # B2B pricing
├── lib/
│   ├── graphql/
│   │   ├── staff.ts             # Staff member queries
│   │   ├── companies.ts         # Company/location queries
│   │   ├── catalogs.ts          # Catalog & publication queries
│   │   ├── products.ts          # Product queries
│   │   ├── draftOrders.ts       # Draft order mutations
│   │   └── orders.ts            # Order queries
│   └── utils/
│       ├── filterByStaff.ts     # Filter company locations by assignment
│       └── priceResolver.ts     # Resolve B2B vs default pricing
├── shopify.server.ts            # Shopify app configuration
└── db.server.ts                 # Database connection
```

### 5.2 Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│  APP LOADS                                                       │
│  ↓                                                               │
│  currentStaffMember → get staff ID                               │
│  ↓                                                               │
│  companyLocations (all, paginated) → filter by staffMember ID    │
│  ↓                                                               │
│  Display company location list (rep's accounts only)             │
│  ↓                                                               │
│  Rep selects a company location                                  │
│  ↓                                                               │
│  companyLocation.catalogs → get publication ID + priceList ID    │
│  ↓                                                               │
│  publication.products → ONLY catalog products shown              │
│  priceList.prices → wholesale pricing applied                    │
│  ↓                                                               │
│  Rep browses products, adds variants to cart                     │
│  ↓                                                               │
│  Rep submits order                                               │
│  ↓                                                               │
│  draftOrderCreate (with purchasingEntity) → B2B draft order      │
│  ↓                                                               │
│  draftOrderInvoiceSend → customer gets checkout link              │
│  ↓                                                               │
│  Customer pays at checkout → Shopify validation functions run     │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3 Caching Strategy

To avoid excessive API calls, cache the following:
- **Staff → Company Location mapping:** Cache for 15 minutes (invalidate on app reload)
- **Catalog → Publication mapping:** Cache for 1 hour (rarely changes)
- **Product data:** Cache for 5 minutes (inventory may change)
- **Price list data:** Cache for 1 hour

Use Remix loader caching headers or in-memory cache (e.g., `node-cache`).

---

## 6. FRONTEND REQUIREMENTS — BRANDING

### 6.1 Branding Approach

The app uses a **configurable branding system** so it can be white-labeled for any client. Branding is controlled through CSS custom properties and a config object.

### 6.2 UI Design Guidelines

**Since this is an embedded admin app using Polaris, the approach is:**
- Use Shopify Polaris as the base design system (required for embedded apps)
- Add client-specific branding through CSS custom property overrides
- Add the client's logo/wordmark in the app header
- Maintain a professional, clean aesthetic suitable for wholesale ordering

**Polaris Components to Use:**
- `Page` — main layout wrapper
- `Layout` — responsive grid
- `Card` / `LegacyCard` — content containers
- `ResourceList` / `ResourceItem` — company location list
- `Thumbnail` — product images
- `Badge` — status indicators (order status, inventory)
- `Banner` — notifications, warnings
- `Modal` — order confirmation
- `DataTable` — order line items, pricing
- `TextField` — search, quantities
- `Select` — variant selection
- `Button` — actions (add to cart, submit order, send invoice)
- `SkeletonPage` / `SkeletonBodyText` — loading states
- `EmptyState` — no products / no companies
- `Pagination` — product catalog pagination
- `Filters` — product search and filtering
- `Toast` — success/error notifications

### 6.3 CSS Custom Properties (Configurable per Client)

```css
/* Default branding — override per client deployment */
:root {
  --portal-primary: #000000;
  --portal-on-primary: #FFFFFF;
  --portal-background: #F9F7F4;
  --portal-accent: #4A90D9;
  --portal-border: #E8E8E8;
  --portal-text: #333333;
  --portal-heading-font: 'Georgia', serif;
  --portal-body-font: system-ui, sans-serif;
  --portal-border-radius: 0px;      /* 0 for luxury/sharp, 8px for friendly */
  --portal-letter-spacing: 2px;     /* wide for luxury, 0 for standard */
}

/* App header branding */
.rep-portal-header {
  background-color: var(--portal-primary);
  padding: 16px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.rep-portal-header__logo {
  font-family: var(--portal-heading-font);
  font-size: 24px;
  font-weight: 400;
  letter-spacing: var(--portal-letter-spacing);
  color: var(--portal-on-primary);
  text-transform: uppercase;
}

.rep-portal-header__subtitle {
  font-size: 12px;
  letter-spacing: 2px;
  color: var(--portal-accent);
  text-transform: uppercase;
}

/* Product card styling */
.rep-portal-product-card {
  border: 1px solid var(--portal-border);
  border-radius: var(--portal-border-radius);
  overflow: hidden;
  transition: box-shadow 0.2s ease;
}

.rep-portal-product-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.rep-portal-product-card__image {
  aspect-ratio: 1;
  object-fit: cover;
  background-color: var(--portal-background);
}

.rep-portal-product-card__title {
  font-family: var(--portal-heading-font);
  font-weight: 400;
  letter-spacing: 1px;
}

.rep-portal-product-card__price {
  color: var(--portal-text);
  font-weight: 600;
}

/* Primary action button */
.rep-portal-btn-primary {
  background-color: var(--portal-primary) !important;
  color: var(--portal-on-primary) !important;
  border-radius: var(--portal-border-radius) !important;
  text-transform: uppercase;
  letter-spacing: var(--portal-letter-spacing);
  font-size: 12px;
}

/* Cart sidebar */
.rep-portal-cart {
  border-left: 1px solid var(--portal-border);
  background-color: var(--portal-background);
}
```

### 6.4 Page-by-Page UI Specifications

#### Page 1: Dashboard / Company Selector (`app._index.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  [LOGO]  WHOLESALE PORTAL                           │ ← Branded header bar
│  Welcome, [Rep First Name]                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  🔍 Search companies...                             │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ 🏪 Acme Retail                               │  │
│  │    New York, NY, US                           │  │
│  │    Catalog: B2B_Standard                      │  │
│  │    Last Order: Jan 15, 2026                   │  │
│  │                              [Place Order →]  │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │ 🏪 Euro Distributors                         │  │
│  │    Munich, Germany                            │  │
│  │    Catalog: B2B_Europe                        │  │
│  │    Last Order: Dec 22, 2025                   │  │
│  │                              [Place Order →]  │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ── Recent Orders ──────────────────────────────── │
│  #D1234  Acme Retail        $2,450.00   Open       │
│  #D1230  Euro Distributors  €1,890.00   Invoice Sent│
│  #D1225  Acme Retail        $3,100.00   Completed  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Data needed:**
- `currentStaffMember` → name, avatar
- `companyLocations` filtered by staff assignments → list
- `draftOrders` filtered by `tag:sales-rep-portal` → recent orders

#### Page 2: Product Catalog (`app.company.$id.tsx`)

```
┌────────────────────────────────────────────────────────────────┐
│  [LOGO]  WHOLESALE PORTAL                                      │
│  ← Back to Companies | Ordering for: Acme Retail, New York     │
├──────────────────────────────────────────────┬─────────────────┤
│                                              │  CART (3 items) │
│  🔍 Search products...  [Filter ▾]          │                 │
│                                              │  Product A      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │  Option 1 × 2   │
│  │          │ │          │ │          │    │  $180.00         │
│  │  [image] │ │  [image] │ │  [image] │    │                 │
│  │          │ │          │ │          │    │  Product B       │
│  ├──────────┤ ├──────────┤ ├──────────┤    │  Option 2 × 1   │
│  │Product   │ │Product   │ │Product   │    │  $95.00          │
│  │A         │ │B         │ │C         │    │                 │
│  │$90.00    │ │$95.00    │ │$120.00   │    │  ──────────     │
│  │          │ │          │ │          │    │  Subtotal:       │
│  │[Opt ▾]   │ │[Opt ▾]   │ │[Opt ▾]   │    │  $455.00        │
│  │Qty: [1]  │ │Qty: [1]  │ │Qty: [1]  │    │                 │
│  │[Add ▪▪▪] │ │[Add ▪▪▪] │ │[Add ▪▪▪] │    │ [Review Order]  │
│  └──────────┘ └──────────┘ └──────────┘    │                 │
│                                              │                 │
│  [← Previous]            [Next →]           │                 │
├──────────────────────────────────────────────┴─────────────────┤
```

**Data needed:**
- `companyLocation` → company details, shipping/billing addresses
- `companyLocation.catalogs` → publication ID, price list ID
- `publication.products` → product grid (paginated, searchable)
- `priceList.prices` → wholesale pricing overlay

#### Page 3: Cart Review & Submit (`app.cart.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  [LOGO]  WHOLESALE PORTAL                           │
│  ← Back to Catalog | Order Review                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Ordering for: Acme Retail, New York                │
│  Contact: Jane Doe (jane@acmeretail.com)            │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ Product       │ Variant  │ Qty │ Price │ Total  ││
│  ├───────────────┼──────────┼─────┼───────┼────────┤│
│  │ Product A     │ Opt 1    │  2  │ $90   │ $180   ││
│  │ Product B     │ Opt 2    │  1  │ $95   │ $95    ││
│  │ Product C     │ Opt 3    │  3  │ $120  │ $360   ││
│  ├───────────────┴──────────┴─────┴───────┼────────┤│
│  │                                Subtotal│ $635   ││
│  └────────────────────────────────────────┴────────┘│
│                                                     │
│  📝 Order notes: [________________________]         │
│                                                     │
│  Contact to invoice:                                │
│  [▾ Jane Doe — jane@acmeretail.com              ]  │
│                                                     │
│  Shipping Address:                                  │
│  123 Broadway, New York, NY 10001, US               │
│  [Edit]                                             │
│                                                     │
│  [ Create Draft Order ]  [ Create & Send Invoice ]  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Actions:**
- "Create Draft Order" → `draftOrderCreate` mutation only
- "Create & Send Invoice" → `draftOrderCreate` + `draftOrderInvoiceSend`

#### Page 4: Order History (`app.orders.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  [LOGO]  WHOLESALE PORTAL                           │
│  My Orders                                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  🔍 Search orders...  [Status ▾] [Company ▾]       │
│                                                     │
│  ┌──────┬──────────────────┬──────────┬────────────┐│
│  │Order │ Company          │ Total    │ Status     ││
│  ├──────┼──────────────────┼──────────┼────────────┤│
│  │D1234 │ Acme Retail      │ $2,450   │ 🟡 Open   ││
│  │D1230 │ Euro Distributors│ €1,890   │ 🔵 Invoiced││
│  │D1225 │ Acme Retail      │ $3,100   │ 🟢 Complete││
│  └──────┴──────────────────┴──────────┴────────────┘│
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 7. CART STATE MANAGEMENT

Use React context or `useReducer` for cart state:

```typescript
interface CartItem {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  price: number;        // wholesale price from priceList
  imageUrl: string;
}

interface CartState {
  companyLocationId: string;
  companyId: string;
  companyContactId: string;
  items: CartItem[];
  note: string;
}

type CartAction =
  | { type: 'ADD_ITEM'; payload: CartItem }
  | { type: 'UPDATE_QUANTITY'; payload: { variantId: string; quantity: number } }
  | { type: 'REMOVE_ITEM'; payload: { variantId: string } }
  | { type: 'SET_NOTE'; payload: string }
  | { type: 'SET_CONTACT'; payload: string }
  | { type: 'CLEAR_CART' };
```

**IMPORTANT:** Cart must be cleared when switching company locations, since different locations may have different catalogs/pricing.

---

## 8. ERROR HANDLING & EDGE CASES

| Scenario | Handling |
|----------|----------|
| Staff member has no company assignments | Show `EmptyState` with message: "No accounts assigned. Contact your manager." |
| Company location has no catalog | Show warning banner: "No catalog configured for this location." |
| Catalog has no publication (pricing-only catalog) | Skip — don't show as orderable location |
| Product has 0 inventory | Show product but disable "Add to Cart", show "Out of Stock" badge |
| Price list has no price for a variant | Fall back to variant's default `price` |
| Draft order creation fails | Show error toast with Shopify's `userErrors` message |
| Invoice send fails | Show error toast, keep draft order (allow retry) |
| Session token expires | App Bridge auto-refreshes (handled by template) |
| Paginated results > 250 products | Implement cursor-based pagination, load more on scroll or with "Load More" button |

---

## 9. SECURITY CONSIDERATIONS

1. **Server-side enforcement:** ALL company location filtering must happen server-side in the Remix loader. Never trust client-side filtering alone.
2. **Validate before create:** Before creating a draft order, server-side verify that:
   - The current staff member IS assigned to the target company location
   - Each variant ID in the order IS published to the location's catalog
3. **Tag all orders:** Always tag draft orders with `sales-rep-portal` and the rep's staff member ID for audit trail
4. **No marking as paid:** Reps should NOT have the `mark_draft_orders_as_paid` permission. All payment goes through checkout.

---

## 10. DEVELOPMENT STEPS (SUGGESTED ORDER)

1. **Scaffold app:** `shopify app init` with Remix template
2. **Configure scopes** in `shopify.app.toml`
3. **Build data layer** (`lib/graphql/` files) — all queries and mutations
4. **Build hooks** — `useCurrentStaff`, `useAssignedCompanies`, `useCatalogProducts`, `useCart`
5. **Build Page 1** — Dashboard / Company Selector
6. **Build Page 2** — Product Catalog (hardest — product grid, variant picker, search, pagination)
7. **Build Page 3** — Cart Review & Order Submission
8. **Build Page 4** — Order History
9. **Add client branding** — CSS overrides, header, typography
10. **Testing** — install on dev store, test with actual company locations and catalogs
11. **Error handling** — edge cases, loading states, empty states
12. **Deploy** — Fly.io or Railway, `shopify app deploy`

---

## 11. TESTING CHECKLIST

- [ ] Staff member with 0 assigned companies sees empty state
- [ ] Staff member sees ONLY their assigned company locations
- [ ] Selecting a company loads ONLY that location's catalog products
- [ ] Products show wholesale pricing (not retail)
- [ ] Adding product to cart works with variant selection
- [ ] Switching company clears the cart
- [ ] Draft order creates correctly with purchasingEntity
- [ ] Draft order is tagged with `sales-rep-portal`
- [ ] Invoice sends successfully to customer email
- [ ] Customer receives checkout link and can pay
- [ ] Order history shows only the rep's orders
- [ ] Pagination works for 100+ product catalogs
- [ ] Search/filter works within the catalog
- [ ] App loads in < 3 seconds
- [ ] Mobile/tablet responsive within Shopify admin

---

## 12. API RATE LIMITS

Shopify GraphQL Admin API uses a cost-based throttle:
- **Bucket size:** 1,000 points
- **Restore rate:** 50 points/second
- Most queries cost 1-10 points
- Include `extensions { cost }` in queries during development to monitor

For product catalogs with 500+ products, use pagination (50 per page) and consider lazy loading with infinite scroll.

---

## 13. FUTURE ENHANCEMENTS (POST-MVP)

1. **Commission tracking** — log order value per rep (simple metafield or database table)
2. **PDF catalog download** — generate printable wholesale catalog per region
3. **Reorder functionality** — duplicate a previous order
4. **Bulk order upload** — CSV import for large orders
5. **Inventory alerts** — warn rep when adding low-stock items
6. **Analytics dashboard** — rep performance, top products by region
