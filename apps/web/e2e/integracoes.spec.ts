import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Central de Integrações (D-231) — tela de composição: seis fontes lidas em
 * paralelo e transformadas por `lib/integrations.ts`. O módulo é puro e tem
 * os seus testes; o que só se prova RODANDO é a fiação — as leituras sob RLS
 * como ADMIN do seed, a página não quebrar quando uma fonte está vazia (não
 * há lote do UpSeller nem execução de IA no seed), e o estado honesto
 * "Não verificável" aparecendo onde não há coletor (D-188: rodar é a prova).
 *
 * TESTING.md reserva o Playwright a fluxos críticos; este teste é o mínimo
 * que sustenta a regra do item — "nunca verde não verificável" — na tela
 * servida, e não no fake.
 */
test("Central de Integrações: ADMIN vê a conta do seed conectada e o que não dá para verificar dito por extenso", async ({
  page,
}) => {
  const seed = await readSeedOutput();

  await login(page, "/integracoes");

  await expect(page).toHaveURL(/\/integracoes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Integrações" })).toBeVisible();

  // A conta do seed está CONNECTED: conexão do Mercado Livre em ok.
  const mercadoLivre = page.getByRole("region", { name: "Mercado Livre" });
  await expect(mercadoLivre.getByText("1 conta(s) conectada(s)")).toBeVisible();

  // Sem coletor autenticado, configuração nunca é verde — e a tela diz por quê.
  const googleCloud = page.getByRole("region", { name: "Google Cloud (API e worker)" });
  await expect(googleCloud.getByText("Não verificável").first()).toBeVisible();
  await expect(googleCloud.getByText(/sem coletor autenticado/)).toBeVisible();

  // O seed não tem lote do UpSeller: "não configurado", não zero fingido nem erro.
  const upseller = page.getByRole("region", { name: "UpSeller (planilha)" });
  await expect(upseller.getByText("nenhuma importação registrada")).toBeVisible();

  // Um dado, um dono: cada card aponta para a tela dona.
  await expect(mercadoLivre.getByRole("link", { name: "Contas ML" })).toBeVisible();

  // Nada aqui é ação: a Central compõe e aponta. O escopo é o dos cards — o
  // Shell em volta tem os seus botões (menu, sair), e eles não são da Central.
  await expect(page.getByRole("region").getByRole("button")).toHaveCount(0);

  void seed;
});
