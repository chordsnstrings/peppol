/** Canonical public site URL (override per-environment). Used for SEO metadata,
 * sitemap, robots, JSON-LD and Open Graph. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://arks.ae").replace(/\/$/, "");

export const SITE_NAME = "ARKS e-Invoicing";
