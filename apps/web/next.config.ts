import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O `web` roda na Vercel em gru1, junto do Supabase em sa-east-1.
  // Ver docs/DEPLOYMENT.md.
  reactStrictMode: true,

  // Pacotes do workspace são transpilados a partir do fonte.
  transpilePackages: ["@sb/contracts"],
};

export default nextConfig;
