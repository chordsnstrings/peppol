import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { INTEGRATIONS } from "@/lib/marketing/integrations";
import { GUIDES } from "@/lib/marketing/guides";

/** Public, indexable routes only — the app surface stays out of the sitemap. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
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
  return routes.map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
