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

/**
 * O CELULAR NÃO ROLA PARA O LADO — e quem rola aqui é o `.sb-content`, não o
 * `<html>`.
 *
 * A varredura de D-383 abriu as 48 telas a 390px e registrou "nenhuma com
 * rolagem lateral no celular"; esta tinha 340 contra 332 de caixa útil. O
 * `<html>` fica do tamanho da janela — quem tem `overflow: auto` é o
 * `<main>` —, então medir o documento, que é o que o caso de
 * /estoque/[skuId]/ajuste faz, não alcança este defeito: o piso rígido da
 * grade transbordava DENTRO do `.sb-content`.
 */
test("/configuracoes: em 390px a tela não rola para o lado", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 812 });

  await login(page, "/configuracoes");

  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  // A grade só se mede depois que os cartões chegaram.
  await expect(page.getByRole("region", { name: "Reposição" })).toBeVisible();

  const largura = await page.locator(".sb-content").evaluate((elemento) => ({
    rolagem: elemento.scrollWidth,
    visivel: elemento.clientWidth,
  }));

  expect(largura.rolagem).toBeLessThanOrEqual(largura.visivel);
});

/**
 * A ORDEM POR ZONA — a única coisa desta fatia que só se prova RODANDO.
 *
 * `describeSettings` devolve na ordem do ROADMAP (Organização primeiro,
 * Reposição em segundo, e o teste de unidade prende isso). A TELA imprime por
 * presença de configuração: com o seed — nenhuma política de reposição e a
 * organização com nome —, Reposição está na zona "SEM CONFIGURAÇÃO AINDA" e
 * Organização na "COM CONFIGURAÇÃO", então a segunda do array aparece ACIMA da
 * primeira. Comparar `y` é o que distingue reordenar de só rotular.
 */
test("/configuracoes: a área sem configuração aparece ACIMA da área que já tem", async ({ page }) => {
  await login(page, "/configuracoes");

  // Nome exato, nunca substring: "Configuradas" mora dentro de "Não
  // configuradas", e é assim que o locator já pegou duas células uma vez.
  await expect(page.getByRole("region", { name: "SEM CONFIGURAÇÃO AINDA" })).toBeVisible();
  await expect(page.getByRole("region", { name: "COM CONFIGURAÇÃO", exact: true })).toBeVisible();

  const semConfiguracao = page.getByRole("region", { name: "Reposição" });
  const comConfiguracao = page.getByRole("region", { name: "Organização" });

  // A premissa de cada uma, dita antes de comparar: sem isto um seed diferente
  // faria este caso falhar sem explicar por quê.
  await expect(semConfiguracao.getByText("Não configurado")).toBeVisible();
  await expect(comConfiguracao.getByText("Configurado", { exact: true })).toBeVisible();

  const caixaSemConfiguracao = await semConfiguracao.boundingBox();
  const caixaComConfiguracao = await comConfiguracao.boundingBox();

  if (caixaSemConfiguracao === null || caixaComConfiguracao === null) {
    throw new Error("as duas regiões precisam estar visíveis para comparar a ordem na tela");
  }

  expect(caixaSemConfiguracao.y).toBeLessThan(caixaComConfiguracao.y);
});

/**
 * "INCLUI:" É O VOCABULÁRIO DA TELA DONA, caractere a caractere.
 *
 * `check:settings-vocabulary` confere que os termos existem em
 * `/reposicao/configuracoes`; este caso confere a outra ponta — que eles
 * chegam à tela, na linha do cartão certo. Os dois juntos fecham o ciclo: a
 * guarda fica vermelha se a tela dona renomear o rótulo, e este caso fica
 * vermelho se o hub parar de imprimi-lo.
 */
test("/configuracoes: o cartão diz o que a área abrange, com a palavra da tela dona", async ({ page }) => {
  await login(page, "/configuracoes");

  const inclui = page.getByRole("region", { name: "Reposição" }).locator(".sb-settings-inclui");

  await expect(inclui).toHaveText("Inclui: Prazo do fornecedor, Cobertura desejada, Segurança, Teto.");
});

/**
 * O ADMIN ÚNICO É DITO NO CARTÃO, e é o único risco operacional que o seed
 * tem.
 *
 * O seed monta DOIS membros (o ADMIN do login e o GESTOR de D-232) e um ADMIN
 * só — `usuarios.spec.ts` afirma as mesmas duas pessoas. A condição do aviso é
 * exatamente essa: um ADMIN com mais gente na organização. Com `members_total`
 * igual a 1 o aviso não dispararia (seria o dono sozinho, e aviso sem ação vira
 * mobília) e este caso teria de virar o de "Quem altera" em segunda pessoa.
 *
 * O aviso NÃO leva `role="alert"` de propósito — é estado permanente da
 * página, não evento —, então o que se localiza é o parágrafo do cartão.
 */
test("/configuracoes: o ADMIN único da organização é dito no cartão, com a saída", async ({ page }) => {
  await login(page, "/configuracoes");

  const organizacao = page.getByRole("region", { name: "Organização" });

  await expect(organizacao.getByText("2 membros, 1 ADMIN")).toBeVisible();

  const aviso = organizacao.locator(".sb-settings-aviso");

  await expect(aviso).toBeVisible();
  await expect(aviso).toHaveText(/^Só uma pessoa é ADMIN\./);

  // A regra da frase: termina na ação e na tela onde ela se faz. Alarme que o
  // dono não pode apagar vira mobília.
  await expect(aviso).toHaveText(/promova um segundo ADMIN em Usuários\.$/);
  await expect(organizacao.getByRole("link", { name: "Usuários" })).toBeVisible();
});
