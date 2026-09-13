import type { NextConfig } from "next";

/**
 * CABEÇALHOS DE SEGURANÇA (D-329).
 *
 * Medido antes, na resposta ao vivo de `/login` no Dev: o único cabeçalho de
 * segurança era o `Strict-Transport-Security` que a própria Vercel acrescenta.
 * Nenhum `frame-ancestors`, então qualquer site podia pôr o sistema dentro de
 * um `<iframe>` e desenhar botões por cima (clickjacking) — num sistema que
 * republica anúncio, convida usuário e muda papel.
 *
 * O que entra, e o limite de cada um:
 *
 * - `X-Frame-Options: DENY` — nega moldura para navegador que não lê CSP.
 *   Conferido: nada no app usa `iframe`, `postMessage` nem `window.parent`.
 * - **A CSP NÃO mora mais aqui** (D-331). D-329 pôs uma CSP estática só com
 *   `frame-ancestors`; a completa precisa de nonce por requisição e passou a ser
 *   escrita pelo `proxy.ts`. Deixar as duas seria dois donos para o mesmo
 *   cabeçalho — e a estática poderia SOBRESCREVER a do proxy, apagando o nonce.
 * - `nosniff`, `Referrer-Policy` e um `Permissions-Policy` mínimo (o app não usa
 *   câmera, microfone nem localização).
 * - **HSTS não entra aqui:** a Vercel já o envia, com `preload`. Duplicar daria
 *   dois donos para o mesmo cabeçalho.
 */
const CABECALHOS_DE_SEGURANCA = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // O `web` roda na Vercel em gru1, junto do Supabase em sa-east-1.
  // Ver docs/DEPLOYMENT.md.
  reactStrictMode: true,

  // `X-Powered-By: Next.js` diz a versão do framework a quem procura alvo.
  poweredByHeader: false,

  // Sem `transpilePackages` por enquanto: o `web` ainda não importa nenhum
  // package do workspace. Ao passar a importar `@sb/contracts` ou `@sb/ui`,
  // declarar aqui E garantir que o build da Vercel construa a dependência
  // antes — os packages exportam a partir de `dist/`.

  // `Promise.resolve` e não `async`: não há o que esperar, e `require-await`
  // reprova método assíncrono sem `await`.
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: CABECALHOS_DE_SEGURANCA }]);
  },
};

export default nextConfig;
