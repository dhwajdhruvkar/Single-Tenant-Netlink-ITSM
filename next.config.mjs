/** @type {import('next').NextConfig} */
// Baseline security headers. CSP is tightened in Phase 11.
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const isVercelBuild = process.env.VERCEL === "1";

const nextConfig = {
  reactStrictMode: true,
  // Standalone output is for the minimal Docker image; Vercel supplies its own build adapter.
  output: isVercelBuild ? undefined : "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
