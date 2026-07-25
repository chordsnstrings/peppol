import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Index the public marketing surface; keep the authenticated app, admin console,
 * API and payment/auth flows out of search indexes.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/admin",
          "/admin-setup",
          "/login",
          "/dashboard",
          "/settings",
          "/invoices",
          "/customers",
          "/products",
          "/payments",
          "/recurring",
          "/reports",
          "/inbox",
          "/uploads",
          "/integrations",
          "/fixit",
          "/onboarding",
          "/oauth",
          "/pay",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
