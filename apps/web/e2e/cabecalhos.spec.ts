import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * CABEÇALHOS DE SEGURANÇA (D-329) — e o motivo de haver um caso para isso.
 *
 * Medido antes, ao vivo no Dev: o único cabeçalho de segurança da `web` era o
 * HSTS que a Vercel acrescenta. Nada impedia outro site de pôr o sistema num
 * `<iframe>`. Os cabeçalhos agora moram em `next.config.ts`, e um arquivo de
 * configuração é exatamente o tipo de lugar onde uma linha some numa refatoração
 * sem nenhuma tela mudar de pixel. Este caso é a guarda.
 *
 * Duas respostas, porque são dois caminhos: `/login` (pública) e uma tela
 * autenticada, que passa pelo `proxy.ts` antes de renderizar.
 */
const ESPERADOS: Readonly<Record<string, RegExp>> = {
  "content-security-policy": /frame-ancestors 'none'/,
  "x-frame-options": /^DENY$/,
  "x-content-type-options": /^nosniff$/,
  "referrer-policy": /^strict-origin-when-cross-origin$/,
  "permissions-policy": /camera=\(\)/,
};

function conferir(cabecalhos: Record<string, string>, onde: string): void {
  for (const [nome, esperado] of Object.entries(ESPERADOS)) {
    expect(cabecalhos[nome], `${nome} em ${onde}`).toMatch(esperado);
  }

  // O framework não se anuncia.
  expect(cabecalhos["x-powered-by"], `x-powered-by em ${onde}`).toBeUndefined();
}

test("cabeçalhos de segurança: a tela pública e a autenticada não podem ser emolduradas", async ({ page }) => {
  const publica = await page.goto("/login");

  expect(publica).not.toBeNull();
  conferir(publica?.headers() ?? {}, "/login");

  await login(page, "/vendas");

  const autenticada = await page.goto("/vendas");

  expect(autenticada?.status()).toBe(200);
  conferir(autenticada?.headers() ?? {}, "/vendas");
});
