// Static security headers for every response. The Content-Security-Policy (with a per-request nonce) is set in proxy.ts.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"], // solo desarrollo: permite recursos /_next/* al abrir el sitio por 127.0.0.1
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};
export default nextConfig;
