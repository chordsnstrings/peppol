/** Canonical public site URL (override per-environment). Used for SEO metadata,
 * sitemap, robots, JSON-LD and Open Graph. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://arks.ae").replace(/\/$/, "");

export const SITE_NAME = "ARKS e-Invoicing";
export const SITE_SHORT = "ARKS";

/** Area the service is offered in (schema.org areaServed). */
export const SITE_AREA = "United Arab Emirates";

/**
 * Public social / profile URLs for the Organization `sameAs` (knowledge-panel &
 * entity consolidation). Leave empty until real profiles exist — `sameAs` is
 * omitted entirely when this is empty rather than pointing at nothing.
 */
export const SITE_SOCIALS: string[] = (process.env.NEXT_PUBLIC_SITE_SOCIALS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Raster logo for schema.org ImageObject (Google prefers raster over SVG). */
export const SITE_LOGO_PNG = "/icons/apple-touch-icon.png";
export const SITE_LOGO_W = 180;
export const SITE_LOGO_H = 180;
