import { expect, test } from "@playwright/test";

import { E2E_ACAO_RECLAMACAO, E2E_DECISION_TEXT } from "./constants.js";
import { login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * D-648: o ciclo de episódio (D-403; a venda anômala desde a D-643, do A1) nas
 * telas. O episódio é um cartão só, atualizado enquanto o detector vê a
 * condição e encerrado pelo banco 3 dias depois de ela sumir. Este arquivo
 * prova as três coisas que a tela passou a mostrar ou a mostrar certo:
 *
 *  1. a última detecção no cartão aberto da `/acoes`;
 *  2. a idade de um cartão com mais de 7 dias, que era "—" (`formatBusinessDate`
 *     recebia o instante `created_at` e só aceita `AAAA-MM-DD`);
 *  3. o motivo do encerramento automático na aba Decisões do SKU, o único
 *     lugar onde uma ação fechada aparece (a fila só traz as abertas).
 *
 * As ações entram pela chave de serviço e saem no `finally`; a decisão sai em
 * cascata com a ação. Nada fica para os outros arquivos.
 */

const db = clienteDeServico();

const DIA_DE_NEGOCIO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** `AAAA-MM-DD` do dia de São Paulo, N dias atrás. */
function diaSp(diasAtras: number): string {
  return DIA_DE_NEGOCIO.format(new Date(Date.now() - diasAtras * 86_400_000));
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`, como a tela escreve. */
function br(dia: string): string {
  const [ano, mes, d] = dia.split("-");

  return `${d ?? ""}/${mes ?? ""}/${ano ?? ""}`;
}

test("/acoes: o episódio aberto diz a última detecção, e o cartão de 10 dias diz a data (D-648)", async ({ page }) => {
  const seed = await readSeedOutput();
  const recomendacao = "Episódio E2E da D-648: revisar o preço e o estoque do SKU.";
  const nasceu = new Date(Date.now() - 10 * 86_400_000);

  const acao = await db
    .from("actions")
    .insert({
      organization_id: seed.organizationId,
      kind: "venda_anomala",
      severity: "alta",
      confidence: "alta",
      estimated_impact_brl: 1234,
      sku_id: seed.skuId,
      evidence: {
        direcao: "queda",
        marketplace: "ML",
        evidencias: [{ tipo: "venda_vs_baseline", descricao: "Vendeu 4 unidades a menos que o esperado." }],
        causas_candidatas: [],
        primeira_deteccao: diaSp(10),
        ultima_deteccao: diaSp(1),
      },
      recommendation: recomendacao,
      status: "novo",
      created_by: "system",
      created_at: nasceu.toISOString(),
      subject_key: `ML:${seed.skuId}`,
      last_detected_on: diaSp(1),
      dedup_key: `e2e:d648:venda_anomala:ML:${seed.skuId}`,
    })
    .select("id")
    .single();

  expect(acao.error).toBeNull();

  try {
    await login(page, "/acoes");
    await expect(page.getByRole("heading", { name: "Central de Ações", level: 1 })).toBeVisible();

    const cartao = page.getByRole("article").filter({ hasText: recomendacao });

    await expect(cartao).toContainText(`Última detecção em ${br(diaSp(1))}`);
    // A idade acima de 7 dias é o DIA de São Paulo do instante, nunca "—".
    await expect(cartao.getByText(br(DIA_DE_NEGOCIO.format(nasceu)), { exact: true })).toBeVisible();

    // A ação de fora do ciclo (a de reclamações do seed) não ganha a linha.
    const semCiclo = page.getByRole("article").filter({ hasText: E2E_ACAO_RECLAMACAO.recomendacao });

    await expect(semCiclo).toBeVisible();
    await expect(semCiclo).not.toContainText("Última detecção");
  } finally {
    const apagou = await db.from("actions").delete().eq("id", acao.data?.id ?? "");

    if (apagou.error !== null) console.error(`ação da D-648 ficou no banco: ${apagou.error.message}`);
  }
});

test("aba Decisões do SKU: a ação que o sistema encerrou diz quando e por quê (D-648)", async ({ page }) => {
  const seed = await readSeedOutput();
  const motivo = "A venda do SKU neste canal voltou ao normal há 3 dias (E2E da D-648).";
  const decisao = "Decisão E2E da D-648: segurar a reposição até a venda voltar.";

  const acao = await db
    .from("actions")
    .insert({
      organization_id: seed.organizationId,
      kind: "venda_anomala",
      severity: "media",
      confidence: "media",
      sku_id: seed.skuId,
      evidence: {
        direcao: "queda",
        marketplace: "ML",
        evidencias: [{ tipo: "venda_vs_baseline", descricao: "Vendeu 3 unidades a menos que o esperado." }],
        causas_candidatas: [],
        primeira_deteccao: diaSp(6),
        ultima_deteccao: diaSp(3),
        encerramento: { em: diaSp(0), por: "sistema", motivo },
      },
      recommendation: "Revisar a reposição do SKU.",
      status: "resolvido",
      created_by: "system",
      subject_key: `ML:${seed.skuId}`,
      last_detected_on: diaSp(3),
      dedup_key: `e2e:d648:encerrada:ML:${seed.skuId}`,
    })
    .select("id")
    .single();

  expect(acao.error).toBeNull();

  try {
    const registro = await db.from("action_decisions").insert({
      organization_id: seed.organizationId,
      action_id: acao.data?.id ?? "",
      decision: decisao,
      baseline_snapshot: { as_of: diaSp(6), units_sold_7d: 1, stock_local: 50 },
      created_by: seed.userId,
    });

    expect(registro.error).toBeNull();

    await login(page, `/skus/${seed.skuId}?aba=decisoes`);
    await expect(page.getByRole("heading", { name: "Decisões registradas" })).toBeVisible();

    const encerrada = page.getByRole("article").filter({ hasText: decisao });

    await expect(encerrada).toContainText(`Encerrada pelo sistema em ${br(diaSp(0))}: ${motivo}`);
    await expect(encerrada).toContainText("Resolvido");

    // A decisão do seed, numa ação aberta, não ganha a linha.
    const aberta = page.getByRole("article").filter({ hasText: E2E_DECISION_TEXT });

    await expect(aberta).toBeVisible();
    await expect(aberta).not.toContainText("Encerrada pelo sistema");
  } finally {
    const apagou = await db.from("actions").delete().eq("id", acao.data?.id ?? "");

    if (apagou.error !== null) console.error(`ação da D-648 ficou no banco: ${apagou.error.message}`);
  }
});
