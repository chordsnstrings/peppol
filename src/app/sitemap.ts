import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { INTEGRATIONS } from "@/lib/marketing/integrations";
import { GUIDES } from "@/lib/marketing/guides";
import { localizedPath } from "@/lib/marketing/i18n";

type Freq = MetadataRoute.Sitemap[number]["changeFrequency"];

/** English paths that also have an Arabic mirror (get hreflang alternates). */
const MIRRORED = new Set(["/", "/features", "/pricing", "/uae-e-invoicing"]);

/** Public, indexable routes only — the app surface stays out of the sitemap. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes: { path: string; priority: number; changeFrequency: Freq }[] = [
    { path: "/", priority: 1.0, changeFrequency: "weekly" },
    { path: "/features", priority: 0.9, changeFrequency: "weekly" },
    { path: "/pricing", priority: 0.9, changeFrequency: "weekly" },
    { path: "/connect", priority: 0.8, changeFrequency: "weekly" },
    { path: "/developers", priority: 0.8, changeFrequency: "weekly" },
    { path: "/uae-e-invoicing", priority: 0.8, changeFrequency: "monthly" },
    { path: "/guides", priority: 0.7, changeFrequency: "weekly" },
    ...GUIDES.map((g) => ({ path: `/guides/${g.slug}`, priority: 0.7, changeFrequency: "monthly" as const })),
    ...INTEGRATIONS.map((i) => ({ path: `/connect/${i.slug}`, priority: 0.7, changeFrequency: "monthly" as const })),
    { path: "/signup", priority: 0.6, changeFrequency: "monthly" },
  ];

  // Absolute URL; the homepage has no trailing slash (matches its canonical).
  const abs = (path: string) => (path === "/" ? SITE_URL : `${SITE_URL}${path}`);

  const entries: MetadataRoute.Sitemap = [];
  for (const r of routes) {
    const mirrored = MIRRORED.has(r.path);
    const languages = mirrored
      ? { "en-AE": abs(r.path), "ar-AE": abs(localizedPath(r.path, "ar")), "x-default": abs(r.path) }
      : undefined;
    // English URL
    entries.push({
      url: abs(r.path),
      lastModified: now,
      changeFrequency: r.changeFrequency,
      priority: r.priority,
      ...(languages ? { alternates: { languages } } : {}),
    });
    // Arabic mirror URL (same alternates set)
    if (mirrored) {
      entries.push({
        url: abs(localizedPath(r.path, "ar")),
        lastModified: now,
        changeFrequency: r.changeFrequency,
        priority: r.priority,
        alternates: { languages },
      });
    }
  }
  return entries;
}
