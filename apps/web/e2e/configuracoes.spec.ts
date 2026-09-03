import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Hub de Configurações (D-232) — o que só se prova RODANDO (D-188) é a fiação:
 * a RPC `get_settings_overview` sob a RLS do usuário do seed, as sete seções
 * renderizadas com o estado honesto para um seed que tem UMA conta ML e
 * NENHUMA política de reposição, e a regra do item — apontar, não embutir —
 * visível como ausência total de botão.
 */
test("Hub de Configurações: sete seções, estados honestos e nenhum botão — só links para a tela dona", async ({
  page,
}) => {
  const seed = await readSeedOutput();

  await login(page, "/configuracoes");

  await expect(page).toHaveURL(/\/configuracoes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();

  // As sete seções do item, cada uma como região nomeada.
  for (const nome of ["Organização", "Reposição", "Notificações", "Mercado Livre", "IA / Copiloto", "Operação (atendimento)", "Preferências"]) {
    await expect(page.getByRole("region", { name: nome })).toBeVisible();
  }

  // Seed: uma conta ML, conectada.
  const mercadoLivre = page.getByRole("region", { name: "Mercado Livre" });
  await expect(mercadoLivre.getByText("1 de 1 conta conectada")).toBeVisible();
  await expect(mercadoLivre.getByRole("link", { name: "Contas ML" })).toBeVisible();

  // Seed: nenhuma política de reposição — e a tela diz a consequência (D-144).
  const reposicao = page.getByRole("region", { name: "Reposição" });
  await expect(reposicao.getByText("Não configurado")).toBeVisible();
  await expect(reposicao.getByText(/recusa número/)).toBeVisible();
  await expect(reposicao.getByRole("link", { name: "Configuração de reposição" })).toBeVisible();

  // O teto de IA mora no deploy: nunca "configurado", nunca "não configurado".
  await expect(page.getByRole("region", { name: "IA / Copiloto" }).getByText("Não editável aqui")).toBeVisible();

  // Apontar, não embutir: zero botões dentro das seções.
  await expect(page.getByRole("region").getByRole("button")).toHaveCount(0);

  void seed;
});
