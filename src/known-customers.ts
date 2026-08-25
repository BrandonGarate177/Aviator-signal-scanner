/**
 * Aviator's publicly named customers and logo-wall accounts, mapped to their
 * GitHub org logins.
 *
 * These are excluded from the outbound list. A prospect list that pitches a
 * company already named on the vendor's own homepage discredits the whole
 * list, so this check runs before ranking, not after.
 *
 * Sources: aviator.co homepage logo wall, aviator.co/customers, and the
 * per-customer case studies at aviator.co/client/*. Captured 2026-08-25.
 */
export interface KnownCustomer {
  org: string;
  company: string;
  /** Where the relationship is stated publicly. */
  source: string;
}

export const KNOWN_CUSTOMERS: KnownCustomer[] = [
  { org: "doordash", company: "DoorDash", source: "https://www.aviator.co/client/doordash" },
  { org: "amplitude", company: "Amplitude", source: "https://www.aviator.co/client/amplitude" },
  { org: "color", company: "Color Health", source: "https://www.aviator.co/client/color" },
  { org: "reforge", company: "Reforge", source: "https://www.aviator.co/client/reforge" },
  { org: "prodigygame", company: "Prodigy Education", source: "https://www.aviator.co/client/prodigy-education" },
  { org: "shippabo", company: "Shippabo", source: "https://www.aviator.co/client/shippabo" },
  { org: "airspace", company: "Airspace", source: "https://www.aviator.co/client/airspace" },
  { org: "makenotion", company: "Notion", source: "https://www.aviator.co/ (testimonial)" },
  { org: "secureframe", company: "Secureframe", source: "https://www.aviator.co/ (testimonial)" },
  { org: "verkada", company: "Verkada", source: "https://www.aviator.co/ (testimonial)" },
  { org: "butternutbox", company: "Butternut Box", source: "https://www.aviator.co/ (testimonial)" },
  { org: "slackhq", company: "Slack", source: "https://www.aviator.co/ (logo wall)" },
  { org: "facebook", company: "Meta", source: "https://www.aviator.co/ (logo wall)" },
  { org: "square", company: "Square", source: "https://www.aviator.co/ (logo wall)" },
  { org: "figma", company: "Figma", source: "https://www.aviator.co/ (logo wall)" },
  { org: "coda", company: "Coda", source: "https://www.aviator.co/ (logo wall)" },
  { org: "workos", company: "WorkOS", source: "https://www.aviator.co/ (logo wall)" },
  { org: "cyera", company: "Cyera", source: "https://www.aviator.co/ (logo wall)" },
  { org: "port-labs", company: "Port", source: "https://www.aviator.co/ (logo wall)" },
  { org: "anrok", company: "Anrok", source: "https://www.aviator.co/ (logo wall)" },
];

const BY_ORG = new Map(KNOWN_CUSTOMERS.map((c) => [c.org.toLowerCase(), c]));

export function knownCustomer(login: string): KnownCustomer | undefined {
  return BY_ORG.get(login.toLowerCase());
}
