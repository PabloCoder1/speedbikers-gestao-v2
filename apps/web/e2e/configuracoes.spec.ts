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

/**
 * O que D35 decidiu contra o frame `AdminScreen` na variação de organização
 * (D-275). Os dois interruptores que ele desenha não têm onde gravar, e este
 * caso existe para que voltarem seja vermelho.
 */
test("/configuracoes: os dois interruptores do frame não entraram, e nada nesta tela edita", async ({ page }) => {
  await login(page, "/configuracoes");

  /*
    "2FA Obrigatório": ZERO colunas de 2FA/MFA no esquema e ZERO fatores em
    `auth.mfa_factors`. O frame o desenha LIGADO, o que afirmaria que a
    organização já exige segundo fator — com ninguém tendo um.

    "Modo Manutenção": ZERO colunas de manutenção ou somente-leitura, e
    `organizations` tem seis colunas ao todo.

    Interruptor mente pior que número: um número sem fonte é lido; um
    interruptor sem fonte é ACIONADO.
  */
  await expect(page.getByText(/2FA/i)).toHaveCount(0);
  await expect(page.getByText(/Modo Manuten/i)).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  // "Salvar alterações" cai junto: não há o que salvar numa página que aponta.
  await expect(page.getByRole("button", { name: /Salvar/i })).toHaveCount(0);
});

test("/configuracoes: a faixa conta as sete seções, e as partes fecham com o total", async ({ page }) => {
  await login(page, "/configuracoes");

  const faixa = page.locator(".sb-kpi-strip");

  /*
    O rótulo casa por REGEX ANCORADA, não por substring: "Configuradas" está
    dentro de "Não configuradas", e `hasText` casa pedaço sem diferenciar
    maiúscula — o locator pegava as duas células e o modo estrito recusava.
  */
  const valor = async (rotulo: string): Promise<number> =>
    Number(
      await faixa
        .locator(".sb-kpi")
        .filter({ has: page.locator(".sb-kpi-label", { hasText: new RegExp(`^${rotulo}$`) }) })
        .locator(".sb-kpi-value")
        .innerText(),
    );

  const total = await valor("Seções");
  const configuradas = await valor("Configuradas");
  const parciais = await valor("Parciais");
  const naoConfiguradas = await valor("Não configuradas");
  const naoEditaveis = await valor("Não editáveis aqui");
  const indisponiveis = await valor("Indisponíveis");

  expect(configuradas + parciais + naoConfiguradas + naoEditaveis + indisponiveis).toBe(total);

  /*
    O frame tem QUATRO abas; o sistema tem sete seções. As abas dele não
    cobrem Mercado Livre, IA/Copiloto nem Reposição — e é justamente Reposição
    que aparece "não configurado" aqui, com a consequência escrita.
  */
  expect(total).toBe(7);

  // O teto de IA mora no deploy: nem configurado, nem por configurar.
  expect(naoEditaveis).toBeGreaterThanOrEqual(1);

  // Leitura que falha não vira "não configurado" (D-067).
  expect(indisponiveis).toBe(0);
});
