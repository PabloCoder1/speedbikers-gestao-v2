import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O `web` roda na Vercel em gru1, junto do Supabase em sa-east-1.
  // Ver docs/DEPLOYMENT.md.
  reactStrictMode: true,

  // Sem `transpilePackages` por enquanto: o `web` ainda não importa nenhum
  // package do workspace. Ao passar a importar `@sb/contracts` ou `@sb/ui`,
  // declarar aqui E garantir que o build da Vercel construa a dependência
  // antes — os packages exportam a partir de `dist/`.
};

export default nextConfig;
