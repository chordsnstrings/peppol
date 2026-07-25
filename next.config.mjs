const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy. `unsafe-inline` is required for Next's inline
// bootstrap + Tailwind styles; `unsafe-eval` only in dev (HMR). There are no
// XSS sinks (no dangerouslySetInnerHTML; React escapes), so the high-value
// protections here are frame-ancestors/object-src/base-uri/form-action.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-src 'self'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Keep builds green; lint is run separately.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // Security headers on every response.
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  async rewrites() {
    // RFC 8414 / RFC 9728 discovery documents live under /.well-known; map them
    // to API routes (Next doesn't route dot-folders). Both the root and the
    // path-suffixed forms (some MCP clients append the resource path) resolve.
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/authorization-server-metadata" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/authorization-server-metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/protected-resource-metadata" },
    ];
  },
};

export default nextConfig;
