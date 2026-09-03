import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Central de Integrações (D-231, refeita em D-232). O que só se prova RODANDO
 * (D-188) é a fiação — as leituras sob RLS, a página inteira quando fontes
 * estão vazias — e as duas regras do item na tela servida. O teste negativo
 * com um GESTOR fica para a fatia que migra as leituras de
 * `organization_members` (ver `e2e/constants.ts`):
 *
 *  - "ok exige atividade observada": a conta do seed é CONNECTED e nunca
 *    sincronizou; a primeira versão a pintava de verde, e o teste EXIGIA isso.
 *    Agora exige o contrário.
 *  - "nunca verde não verificável": nenhuma linha de Configuração, em nenhuma
 *    das seis regiões, pode dizer OK.
 */
test("ADMIN: a conta do seed, conectada e sem nenhum run, NÃO é ok; nenhuma configuração é OK; zero botões", async ({
  page,
}) => {
  const seed = await readSeedOutput();

  await login(page, "/integracoes");

  await expect(page).toHaveURL(/\/integracoes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Integrações" })).toBeVisible();

  // `exact` NAO e enfeite: `getByRole` casa nome por SUBSTRING, e existe um
  // segundo card chamado "Webhook do Mercado Livre" — sem isso o locator pega
  // as duas regioes e o modo estrito recusa com dois resultados.
  const mercadoLivre = page.getByRole("region", { name: "Mercado Livre", exact: true });
  const conexao = mercadoLivre.getByRole("row", { name: /Conexão/ });

  // `toContainText` na LINHA, não `getByText`: a pílula e a célula que a contém
  // têm o mesmo texto, e o modo estrito recusa dois elementos.
  await expect(conexao).toContainText("Sem atividade");
  await expect(conexao).toContainText("nenhuma chamada ao Mercado Livre bem-sucedida");
  await expect(conexao).toContainText(seed.mlAccountLabel);
  await expect(conexao).not.toContainText("OK");

  // Em NENHUMA das seis regiões a linha de Configuração pode ser OK.
  for (const regiao of await page.getByRole("region").all()) {
    const configuracao = regiao.getByRole("row", { name: /Configuração/ });

    await expect(configuracao).toBeVisible();
    await expect(configuracao).not.toContainText("OK");
  }

  // O seed não tem lote do UpSeller: "não configurado", não zero fingido nem erro.
  await expect(page.getByRole("region", { name: "UpSeller (planilha)" }).getByText(/nenhuma importação registrada/)).toBeVisible();

  // Um dado, um dono: cada card aponta para a tela dona; nada aqui é ação.
  await expect(mercadoLivre.getByRole("link", { name: "Contas ML" })).toBeVisible();
  await expect(page.getByRole("region").getByRole("button")).toHaveCount(0);
});
