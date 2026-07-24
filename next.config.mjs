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
