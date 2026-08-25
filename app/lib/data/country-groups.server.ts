import { countries as RAW_COUNTRIES } from "countries-list";

/**
 * Country groups used to pick a B2B catalog for a new company location.
 *
 * Shopify has no native "catalog by country" rule — a company location only
 * gets B2B pricing when it is explicitly added to a CompanyLocationCatalog.
 * These groups are what an admin maps to catalogs in Settings; the mapping
 * itself lives in the AppSettings table (see catalog-mapping.server.ts).
 */
export const COUNTRY_GROUP_KEYS = [
  "US",
  "CA",
  "EUROPE",
  "UK",
  "REST_OF_WORLD",
] as const;

export type CountryGroupKey = (typeof COUNTRY_GROUP_KEYS)[number];

export interface CountryGroupInfo {
  key: CountryGroupKey;
  label: string;
  description: string;
  /** Example/complete country codes in the group, for display in Settings. */
  countryCodes: string[];
}

/**
 * Countries that get their own group regardless of continent. UK is split out
 * of Europe because it sells on a different catalog.
 */
const EXPLICIT_GROUPS: Record<string, CountryGroupKey> = {
  US: "US",
  CA: "CA",
  GB: "UK",
};

type RawCountry = { name: string; continent: string };
const COUNTRY_TABLE = RAW_COUNTRIES as unknown as Record<string, RawCountry>;

/**
 * Resolve a two-letter country code to its group. Anything that isn't US, CA,
 * GB, or on the European continent falls through to REST_OF_WORLD.
 */
export function getCountryGroup(countryCode: string | null | undefined): CountryGroupKey {
  const code = (countryCode ?? "").trim().toUpperCase();
  if (!code) return "REST_OF_WORLD";

  const explicit = EXPLICIT_GROUPS[code];
  if (explicit) return explicit;

  if (COUNTRY_TABLE[code]?.continent === "EU") return "EUROPE";

  return "REST_OF_WORLD";
}

let cachedGroups: CountryGroupInfo[] | null = null;

/**
 * The group list for the Settings UI, with the resolved member countries so an
 * admin can see exactly which countries land in "Europe".
 */
export function getCountryGroups(): CountryGroupInfo[] {
  if (cachedGroups) return cachedGroups;

  const europeCodes = Object.keys(COUNTRY_TABLE)
    .filter((code) => getCountryGroup(code) === "EUROPE")
    .sort((a, b) => COUNTRY_TABLE[a].name.localeCompare(COUNTRY_TABLE[b].name));

  cachedGroups = [
    {
      key: "US",
      label: "United States",
      description: "Company locations shipping to the US.",
      countryCodes: ["US"],
    },
    {
      key: "CA",
      label: "Canada",
      description: "Company locations shipping to Canada.",
      countryCodes: ["CA"],
    },
    {
      key: "EUROPE",
      label: "Europe (excluding UK)",
      description: `${europeCodes.length} countries on the European continent. The UK is handled separately.`,
      countryCodes: europeCodes,
    },
    {
      key: "UK",
      label: "United Kingdom",
      description: "Split out of Europe so it can sell on its own catalog.",
      countryCodes: ["GB"],
    },
    {
      key: "REST_OF_WORLD",
      label: "Rest of world",
      description:
        "Every country not covered above. Also used as the fallback when a group has no catalog set.",
      countryCodes: [],
    },
  ];

  return cachedGroups;
}

export function getCountryName(countryCode: string): string {
  return COUNTRY_TABLE[countryCode.toUpperCase()]?.name ?? countryCode;
}
