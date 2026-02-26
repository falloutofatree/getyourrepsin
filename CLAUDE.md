# CLAUDE.md — B2B Sales Rep Portal

## Project Overview

Custom Shopify Embedded App (Remix/React Router) that provides B2B sales reps with a catalog-filtered ordering portal. Reps can ONLY see products from catalogs assigned to their company locations. This replaces Shopify's native draft order flow which exposes ALL products to all staff.

Read `Sales-rep-portal-spec.md` for the full technical specification including all GraphQL queries, UI wireframes, and data flow.

---

## CRITICAL RULES — READ BEFORE WRITING ANY CODE

### 1. NEVER HALLUCINATE SHOPIFY APIs

**This is the #1 risk on this project.** Shopify's GraphQL Admin API is specific and version-locked. Do NOT invent queries, mutations, fields, or arguments.

**MANDATORY BEFORE using any Shopify API:**
- Verify every query/mutation against the spec document (`Sales-rep-portal-spec.md`) which contains pre-researched, verified endpoints
- If you need an API endpoint NOT in the spec, STOP and tell me. Do not guess.
- The API version is `2025-10` (or latest stable). Do not use unstable or deprecated versions.

**Common hallucination traps to avoid:**
- There is NO `staffMember.companyLocations` field — you must query all `companyLocations` and filter by `staffMemberAssignments` client-side
- There is NO way to filter `companyLocations` query by staff member ID server-side — pagination + client filter is required
- There is NO `catalog.products` direct field — you must go through `catalog.publication.products`
- There is NO `draftOrderCreate` field called `catalogId` — catalog enforcement happens through `purchasingEntity`
- `CompanyLocationCatalog` is a type, not a query — use `catalogs(type: COMPANY_LOCATION)`
- `publication_ids` filter on the `products` query expects numeric IDs, NOT GID strings
- `draftOrderInvoiceSend` takes `id` (the draft order ID) and optional `email` (EmailInput) — nothing else
- `currentStaffMember` takes NO arguments — it returns the staff member making the request
- There is NO `staffMemberCreate` or `staffMemberUpdate` mutation in the public API
- Price list prices may not exist for every variant — always fall back to `variant.price`

**If you're unsure whether a field or query exists:** Write a comment like `// TODO: VERIFY — does this field exist?` and flag it. Do NOT silently invent API surface area.

### 2. SECURITY — SERVER-SIDE ENFORCEMENT

**Every security check MUST happen in the Remix loader/action (server-side). Never trust client-side checks alone.**

**Authentication model:**
```
Session Token (JWT from App Bridge) → identifies WHICH staff member
Offline Access Token (stored in DB) → makes API calls with full app scopes
```

**The app uses OFFLINE access tokens for all GraphQL API calls.** This is because staff reps will have minimal Shopify admin permissions (only app access). Online tokens inherit the user's permissions and would fail. The session token JWT's `sub` claim identifies the staff member.

**Required server-side validations:**

```typescript
// In EVERY loader that returns company data:
// 1. Get current staff member identity from session token
// 2. Verify staff member IS assigned to the requested company location
// 3. Return 403 if not assigned

// In EVERY action that creates a draft order:
// 1. Verify staff member is assigned to the target company location
// 2. Verify EVERY variant ID in the order is published to that location's catalog
// 3. Verify the company contact ID belongs to the company
// 4. Return 403 with specific error if any check fails
```

**Specific security rules:**
- NEVER return company location data for locations not assigned to the current staff member
- NEVER create a draft order without verifying product/variant → catalog membership server-side
- NEVER expose other staff members' data or order history
- ALWAYS tag draft orders with `sales-rep-portal` and the staff member's GID for audit trail
- ALWAYS use `purchasingEntity.purchasingCompany` on draft orders (never create non-B2B drafts)
- NEVER allow the app to mark draft orders as paid — payment goes through checkout only
- NEVER store or log the offline access token in client-accessible code or responses
- Session validation must happen on every request — no cached auth state on the client

**Authorization check helper pattern:**
```typescript
// lib/auth.server.ts — use this in EVERY loader/action
export async function requireStaffAccess(
  request: Request,
  companyLocationId: string
): Promise<{ staffMember: StaffMember; admin: AdminApiContext }> {
  const { admin, session } = await authenticate.admin(request);

  // Get current staff member
  const staffResponse = await admin.graphql(`query { currentStaffMember { id } }`);
  const staffId = staffResponse.data.currentStaffMember.id;

  // Verify assignment to this company location
  const locationResponse = await admin.graphql(`
    query CheckAssignment($locationId: ID!) {
      companyLocation(id: $locationId) {
        staffMemberAssignments(first: 50) {
          nodes { staffMember { id } }
        }
      }
    }
  `, { variables: { locationId: companyLocationId } });

  const isAssigned = locationResponse.data.companyLocation
    .staffMemberAssignments.nodes
    .some(a => a.staffMember.id === staffId);

  if (!isAssigned) {
    throw new Response("Forbidden", { status: 403 });
  }

  return { staffMember, admin };
}
```

**Product validation before order creation:**
```typescript
// MUST run server-side before draftOrderCreate
export async function validateOrderProducts(
  admin: AdminApiContext,
  companyLocationId: string,
  variantIds: string[]
): Promise<{ valid: boolean; invalidVariants: string[] }> {
  // Get the catalog's publication for this location
  // Check each product's publishedInContext for this companyLocationId
  // Return invalid variants if any fail

  // Use product.publishedInContext(context: { companyLocationId })
  // for each product — batch where possible
}
```

### 3. PERFORMANCE

**Target:** App loads in < 3 seconds. Product catalog page renders in < 2 seconds.

**Caching strategy (implement from the start, not as an afterthought):**

```typescript
// Use node-cache or similar in-memory cache on the server
// KEY: Cache aggressively, invalidate conservatively

const CACHE_TTL = {
  STAFF_ASSIGNMENTS: 15 * 60,    // 15 min — staff→location mapping
  CATALOG_PUBLICATION: 60 * 60,  // 1 hour — catalog→publication mapping
  PRODUCT_DATA: 5 * 60,          // 5 min — product listings (inventory changes)
  PRICE_LIST: 60 * 60,           // 1 hour — wholesale prices (rarely change)
  COMPANY_CONTACTS: 30 * 60,     // 30 min — contact list
};

// Cache key patterns:
// `staff:${staffId}:locations` → assigned company location IDs
// `location:${locationId}:catalog` → catalog ID + publication ID
// `publication:${publicationId}:products:page:${cursor}` → product page
// `pricelist:${priceListId}:prices` → all price overrides
```

**GraphQL query optimization:**
- NEVER fetch more fields than you need — Shopify charges API cost per field
- ALWAYS include `pageInfo { hasNextPage endCursor }` for paginated queries
- Use `first: 50` for product listings (not 100 or 250 — balance between API calls and response size)
- Batch related queries where possible using GraphQL query composition
- Include `extensions { cost { requestedQueryCost actualQueryCost throttleStatus { maximumAvailable currentlyAvailable restoreRate } } }` during development to monitor API costs
- Remove the `extensions` field in production

**Pagination:**
- Product catalog: cursor-based pagination, 50 products per page
- Use "Load More" button pattern (not infinite scroll — simpler, more predictable)
- Pre-fetch the next page when the user is viewing current page (if there is a next page)

**Lazy loading:**
- Product images: use `loading="lazy"` on `<img>` tags
- Variant data: fetch variants only when user clicks on a product card (expandable card pattern)
- Price list: fetch once per company location selection, cache the full map, look up client-side

**Avoid these performance anti-patterns:**
- Do NOT fetch ALL products in one query — always paginate
- Do NOT make sequential API calls when parallel calls are possible
- Do NOT re-fetch company locations on every page navigation — cache in the session/loader
- Do NOT fetch full product data (description, all images, all metafields) in the grid view — only fetch title, featured image, price, variant count
- Do NOT fetch price list prices one variant at a time — fetch the full price list once and create a lookup map

**Remix-specific performance:**
- Use `loader` functions for all data fetching (server-side rendering)
- Use `useFetcher` for cart operations (no full page reload)
- Use `defer` for non-critical data (order history on dashboard can load after initial render)
- Use Remix's built-in `headers` export for HTTP caching where appropriate
- Use `shouldRevalidate` to prevent unnecessary re-fetching on navigation

---

## CODE QUALITY STANDARDS

### TypeScript
- Use strict TypeScript everywhere — no `any` types
- Define interfaces for all Shopify API responses (don't rely on inferred types)
- Define interfaces for all component props

### Error Handling
- EVERY GraphQL call must have error handling for both network errors and `userErrors` in the response
- Show user-friendly error messages via Polaris `Toast` or `Banner` components
- Log detailed errors server-side (include query name, variables, error message)
- NEVER show raw GraphQL errors to the user
- Handle the case where Shopify returns partial data (some fields null)

### File Organization
```
app/
├── routes/           # Remix route files (pages)
├── components/       # React components (presentational)
├── hooks/            # Custom React hooks (client-side state)
├── lib/
│   ├── graphql/      # All GraphQL query/mutation strings + executor functions
│   ├── auth.server.ts    # Server-side auth helpers
│   ├── cache.server.ts   # Server-side caching layer
│   └── utils/        # Pure utility functions
├── types/            # TypeScript interfaces and types
├── styles/           # CSS files (client branding overrides)
├── shopify.server.ts # Shopify app config
└── db.server.ts      # Database config
```

### GraphQL Query Organization
- ONE file per domain: `staff.ts`, `companies.ts`, `catalogs.ts`, `products.ts`, `draftOrders.ts`, `orders.ts`
- Each file exports both the query STRING and an executor FUNCTION
- The executor function handles pagination, error extraction, and type casting
- Example pattern:

```typescript
// lib/graphql/products.ts

export const CATALOG_PRODUCTS_QUERY = `#graphql
  query CatalogProducts($publicationId: ID!, $first: Int!, $after: String) {
    publication(id: $publicationId) {
      products(first: $first, after: $after) {
        nodes {
          id
          title
          featuredImage { url altText }
          variants(first: 10) {
            nodes {
              id
              title
              sku
              price
              inventoryQuantity
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export async function fetchCatalogProducts(
  admin: AdminApiContext,
  publicationId: string,
  cursor?: string
): Promise<{ products: Product[]; pageInfo: PageInfo }> {
  const response = await admin.graphql(CATALOG_PRODUCTS_QUERY, {
    variables: {
      publicationId,
      first: 50,
      after: cursor || null,
    },
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return {
    products: data.data.publication.products.nodes,
    pageInfo: data.data.publication.products.pageInfo,
  };
}
```

### Naming Conventions
- Files: `kebab-case.ts` / `PascalCase.tsx` for components
- Functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- GraphQL queries: `UPPER_SNAKE_CASE` with suffix `_QUERY` or `_MUTATION`
- CSS classes: `rep-portal-` prefix for custom styles (e.g., `rep-portal-product-card`)

---

## TESTING APPROACH

### Before claiming any feature is complete:
1. Verify the GraphQL query works in Shopify's GraphiQL explorer (Admin → Settings → Apps → GraphiQL)
2. Test with a staff member who has ONLY app access (no other admin permissions)
3. Test with a staff member assigned to 1 company (should see 1 location)
4. Test with a staff member assigned to 5+ companies (pagination, search)
5. Test creating a draft order and verify it appears correctly in Shopify admin
6. Test sending an invoice and verify the customer receives the email

### Security testing:
- Try accessing a company location NOT assigned to the current staff member → must get 403
- Try adding a product variant NOT in the location's catalog → must get rejected server-side
- Try manipulating URL parameters to access other reps' data → must fail
- Check that no sensitive data (access tokens, other staff data) appears in client-side network responses

---

## WHAT TO DO WHEN STUCK

1. **API not returning expected data?** → Check the API version. Check access scopes. Check that the query matches the spec document EXACTLY.
2. **Field doesn't exist?** → Do NOT invent it. Check the spec, check Shopify docs at shopify.dev. If still can't find it, tell me.
3. **Authentication failing?** → Verify offline vs online token usage. The app needs offline tokens for API calls since staff have minimal permissions.
4. **Performance slow?** → Check the `extensions.cost` field in GraphQL responses. Simplify the query, reduce fields requested, add caching.
5. **UI not matching spec?** → Refer to the wireframes in the spec document. Use Polaris components as base, add client-specific CSS overrides.

---

## DO NOT

- Do NOT install third-party npm packages for things Shopify's template already provides (auth, API client, Polaris)
- Do NOT use REST Admin API — use GraphQL exclusively
- Do NOT create separate frontend/backend projects — this is a single Remix app
- Do NOT use `localStorage` or `sessionStorage` for sensitive data
- Do NOT hardcode any Shopify IDs (company IDs, catalog IDs, etc.) — everything is dynamic
- Do NOT skip error handling to move faster — every API call needs it from day one
- Do NOT build custom auth — use `authenticate.admin(request)` from `@shopify/shopify-app-remix`
- Do NOT make API calls from React components directly — all data fetching goes through Remix loaders/actions
- Do NOT use `useEffect` for data fetching — use Remix `loader` and `useFetcher`
- Do NOT assume Shopify API responses have consistent shape — always null-check nested fields
