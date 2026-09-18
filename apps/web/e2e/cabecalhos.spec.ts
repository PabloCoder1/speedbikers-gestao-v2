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
  // A CSP completa, com nonce, desde D-331 — `strict-dynamic` e nonce juntos.
  "content-security-policy": /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'.*frame-ancestors 'none'/,
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

  /*
    O NONCE É POR REQUISIÇÃO (D-331). Um nonce fixo seria uma senha escrita no
    HTML: quem o lesse uma vez injetaria script para sempre.
  */
  const nonceDe = (cabecalhos: Record<string, string>): string | undefined =>
    /'nonce-([^']+)'/.exec(cabecalhos["content-security-policy"] ?? "")?.[1];
  const outra = await page.goto("/vendas");

  expect(nonceDe(autenticada?.headers() ?? {})).toBeDefined();
  expect(nonceDe(outra?.headers() ?? {})).not.toBe(nonceDe(autenticada?.headers() ?? {}));
});

/**
 * A CSP NÃO QUEBRA A APLICAÇÃO (D-331) — e é este caso, e não o de cima, que
 * protege de verdade.
 *
 * Uma CSP errada não derruba a página: ela deixa o HTML chegar e BLOQUEIA em
 * silêncio o script sem nonce, a conexão fora da lista, o WebSocket esquecido.
 * O único sinal é a mensagem de violação no console. O caso passa pelos três
 * caminhos que a política tem de permitir:
 *
 * - o login, que era a única página estática e ficaria sem nonce;
 * - uma tela autenticada, onde o Shell abre o WebSocket do Realtime dos toasts;
 * - a paleta de busca digitando, que chama RPC do Supabase pelo navegador.
 *
 * E exige zero violações — além de a paleta mostrar resultado, porque um
 * `fetch` bloqueado também apareceria como "nada encontrado".
 */
test("CSP: login, tela autenticada, Realtime e busca rodam sem uma violação sequer", async ({ page }) => {
  const violacoes: string[] = [];

  page.on("console", (mensagem) => {
    const texto = mensagem.text();

    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(texto)) {
      violacoes.push(texto.slice(0, 200));
    }
  });

  await login(page, "/vendas");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  // Tempo para o Realtime dos toasts abrir o WebSocket.
  await page.waitForTimeout(2000);

  // Pelo PAPEL, não pela classe: o esqueleto de `carregando.tsx` repete
  // `.sb-search` num `<div aria-hidden>` sem handler, e o clique na classe cai
  // nele quando o shell ainda não trocou (D-356, ver `busca.spec.ts`). Aqui a
  // espera do cabeçalho acima já cobria na prática — o papel torna isso uma
  // garantia em vez de sorte.
  await page.getByRole("button", { name: /Buscar SKU, anúncio, NF-e/ }).click();

  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });

  await caixa.getByRole("combobox", { name: "Buscar" }).fill("E2E");
  await expect(caixa.getByRole("option").filter({ hasText: "E2E" }).first()).toBeVisible();

  expect(violacoes).toEqual([]);
});
