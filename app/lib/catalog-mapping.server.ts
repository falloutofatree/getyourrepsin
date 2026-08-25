import prisma from "../db.server";
import {
  COUNTRY_GROUP_KEYS,
  getCountryGroup,
  type CountryGroupKey,
} from "./data/country-groups.server";

const SETTINGS_KEY = "catalogCountryMapping";

export interface CatalogMapping {
  /** Country group → CompanyLocationCatalog GID. */
  groups: Partial<Record<CountryGroupKey, string>>;
  /** Per-country exceptions, country code → CompanyLocationCatalog GID. */
  overrides: Record<string, string>;
}

export const EMPTY_MAPPING: CatalogMapping = { groups: {}, overrides: {} };

function parseMapping(raw: string): CatalogMapping {
  try {
    const parsed = JSON.parse(raw) as Partial<CatalogMapping>;
    const groups: CatalogMapping["groups"] = {};
    for (const key of COUNTRY_GROUP_KEYS) {
      const value = parsed.groups?.[key];
      if (typeof value === "string" && value) groups[key] = value;
    }

    const overrides: CatalogMapping["overrides"] = {};
    for (const [code, value] of Object.entries(parsed.overrides ?? {})) {
      if (typeof value === "string" && value) {
        overrides[code.toUpperCase()] = value;
      }
    }

    return { groups, overrides };
  } catch {
    console.error("[CatalogMapping] Stored mapping is not valid JSON, ignoring it");
    return { groups: {}, overrides: {} };
  }
}

export async function getCatalogMapping(shop: string): Promise<CatalogMapping> {
  const setting = await prisma.appSettings.findUnique({
    where: { shop_key: { shop, key: SETTINGS_KEY } },
  });

  if (!setting?.value) return { groups: {}, overrides: {} };
  return parseMapping(setting.value);
}

export async function saveCatalogMapping(
  shop: string,
  mapping: CatalogMapping,
): Promise<void> {
  const value = JSON.stringify(mapping);
  await prisma.appSettings.upsert({
    where: { shop_key: { shop, key: SETTINGS_KEY } },
    update: { value },
    create: { shop, key: SETTINGS_KEY, value },
  });
}

/**
 * Pick the catalog for a country: a per-country exception wins, then the
 * country's group, then the rest-of-world catalog. Returns null when nothing
 * is configured — the caller must treat that as "no catalog assigned" rather
 * than silently falling back to some other region's pricing.
 */
export function resolveCatalogIdForCountry(
  mapping: CatalogMapping,
  countryCode: string | null | undefined,
): string | null {
  const code = (countryCode ?? "").trim().toUpperCase();
  if (code && mapping.overrides[code]) return mapping.overrides[code];

  const group = getCountryGroup(code);
  return mapping.groups[group] ?? mapping.groups.REST_OF_WORLD ?? null;
}
