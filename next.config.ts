import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  logging: { incomingRequests: { ignore: [/\/auth\/confirm/] } },
  distDir: process.env.READWORDS_DIST_DIR || ".next",
  serverExternalPackages: ["exceljs"],
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
