import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D-352 — a venda entregue pelo Full nao baixa o estoque da LOJA, provada contra o
 * Postgres real.
 *
 * O que so o banco prova, e por isso este arquivo existe ao lado do de D-351:
 *
 *  - a compensacao `packages/db/scripts/compensacao-estorno-full-d352.sql` (que NAO e
 *    migration) escolhe exatamente o pedido do Full — nem o `cross_docking`, nem o que
 *    ainda nao tem sinal —, espelha a data da venda gravada e anula a reversao INTEIRA;
 *  - o ALVO (`compute_erp_target_balances`) fecha: o par venda/estorno cai do mesmo lado
 *    do corte e soma zero la tambem, que e o ponto inteiro do desenho;
 *  - a venda que ja tinha `ESTORNO_PRE_CAPTURA` nao ganha um segundo estorno (a chave e
 *    a mesma, e o UNIQUE e quem garante), mas ganha a anulacao da reversao;
 *  - a organizacao que ja reconciliou NAO e tocada, e sai em NOTICE — pelas duas fontes
 *    de `reconciled_at` de `get_erp_stock_cutoffs` (o `AJUSTE_RECONCILIACAO` e a rodada
 *    concluida em `job_runs`, que pega a reconciliacao que nao gravou ajuste nenhum);
 *  - a anulacao PARCIAL que a D-351 §12 gravou vira residuo declarado, e nao um numero
 *    errado em silencio;
 *  - o pedido sem sinal com a venda JA estornada pela D-351 conta como pendente no NOTICE
 *    (revisao de 6965b0e, ALTA): ele soma zero hoje, mas o cancelamento dele so e anulado
 *    depois que o sinal chega;
 *  - a captura gravada nao volta a nula nem troca de valor (trigger
 *    `orders_logistica_congelada`, revisao de 6965b0e, BAIXA).
 *
 * **Nada e mutado depois de inserido.** `stock_movements` recusa UPDATE e DELETE por
 * trigger (`stock_movements_no_update`/`_no_delete`, `20260902194500`), entao cada forma
 * tem a sua ORGANIZACAO ou o seu PEDIDO — nunca uma linha alterada no meio do teste.
 *
 * Organizacoes, usuario e conta proprios (uuid aleatorio): este arquivo roda ao lado de
 * `rls.integration.test.ts` e de `estoque-pre-captura.integration.test.ts`. A compensacao
 * roda dentro de uma transacao revertida, e as assercoes olham so as linhas deste arquivo.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`) e o banco recriado.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const RAIZ = new URL("../../../", import.meta.url);

const ORG_FULL = randomUUID();
const ORG_RECONCILIADA = randomUUID();
const ORG_RODADA = randomUUID();
const ORG_COBERTO = randomUUID();
const ORG_RESIDUO = randomUUID();
const ORG_PENDENTE = randomUUID();
const ADMIN = randomUUID();
const PREFIXO = `d352-${ORG_FULL.slice(0, 8)}`;

/** Corte recente, como no bloco da F3 da D-351: toda venda deste arquivo cai DEPOIS dele. */
const CORTE = new Date(Date.now() - 10 * 60_000);
const em = (minutos: number): string => new Date(CORTE.getTime() + minutos * 60_000).toISOString();

/** Base dos ids de pedido, aleatoria: o arquivo roda ao lado dos outros no mesmo banco. */
const PEDIDO = 935_200_000_000 + Math.floor(Math.random() * 1_000_000) * 100;

const chave = (n: number): string => `venda:${String(PEDIDO + n)}:0`;
const claim = (n: number): string => `CLAIM-${String(PEDIDO + n)}`;

let client: Client;
let skuFull = "";
let skuReconciliada = "";
let skuRodada = "";
let skuCoberto = "";
let skuResiduo = "";
let skuPendente = "";

async function umId(sql: string, params: unknown[]): Promise<string> {
  const result = await client.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;

  if (id === undefined) {
    throw new Error(`fixture sem id: ${sql}`);
  }

  return id;
}

async function novaOrganizacao(id: string, nome: string): Promise<void> {
  await client.query(`insert into public.organizations (id, name, slug) values ($1, $2, $3)`, [
    id,
    `${PREFIXO} ${nome}`,
    `${PREFIXO}-${nome}`,
  ]);
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')`,
    [id, ADMIN],
  );
}

async function novoSku(organizationId: string, nome: string): Promise<string> {
  return umId(`insert into public.skus (organization_id, sku, kind) values ($1, $2, 'PRODUTO') returning id`, [
    organizationId,
    `${PREFIXO}-${nome}`,
  ]);
}

async function novaConta(organizationId: string, nome: string, sellerId: number): Promise<string> {
  return umId(
    `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $2, $3, $4, 'CONNECTED', now()) returning id`,
    [organizationId, nome, `${PREFIXO}-${nome}`, sellerId],
  );
}

async function snapshot(organizationId: string, skuId: string, disponivel: number): Promise<void> {
  const batchId = await umId(
    `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
     values ($1, 'STOCK', $2, md5($2) || md5($2), $3) returning id`,
    [organizationId, `erp-imports/${PREFIXO}/${skuId}`, `${PREFIXO}.xlsx`],
  );

  await client.query(
    `insert into public.erp_stock_snapshots
       (organization_id, batch_id, sku_key, sku_id, warehouse, on_hand, available, reserved, captured_at)
     values ($1, $2, 'FULL', $3, 'ESTOQUE LOJA', $4, $4, 0, $5)`,
    [organizationId, batchId, skuId, disponivel, CORTE.toISOString()],
  );
}

/**
 * Um pedido com a logistica JA capturada — o primeiro passo da varredura
 * `sync.order-logistics`, que carimba a captura ANTES de qualquer movimento. Com
 * `capturado = false`, o pedido continua PENDENTE (as duas colunas nulas), que e o
 * estado de quem a varredura ainda nao visitou.
 */
async function pedido(
  organizationId: string,
  contaId: string,
  id: number,
  logisticType: string | null,
  capturado = true,
  status = "paid",
): Promise<void> {
  await client.query(
    `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_closed,
                                date_last_updated, total_amount, currency_id, logistic_type, logistic_captured_at)
     values ($1, $2, $3, $4, $5::timestamptz - interval '1 minute', $5, now(), 10, 'BRL', $6,
             case when $7::boolean then now() else null end)`,
    [id, organizationId, contaId, status, em(1), logisticType, capturado],
  );
}

async function movimento(
  organizationId: string,
  skuId: string,
  tipo: string,
  delta: number,
  chaveIdempotencia: string,
  occurredAt: string,
  sourceId: string | null = null,
  sourceType = "ORDER",
): Promise<void> {
  await client.query(
    `insert into public.stock_movements
       (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
     values ($1, $2, 'LOCAL', $3, $4, $5, $6, $7, $8)`,
    [
      organizationId,
      skuId,
      delta,
      tipo,
      sourceId === null ? null : sourceType,
      sourceId,
      chaveIdempotencia,
      occurredAt,
    ],
  );
}

/** Roda a compensacao restrita a UMA organizacao, coletando os NOTICE. */
async function rodarCompensacao(organizationId: string, avisos: string[]): Promise<void> {
  const script = await readFile(new URL("packages/db/scripts/compensacao-estorno-full-d352.sql", RAIZ), "utf8");
  const escuta = (aviso: { message?: string | undefined }): void => {
    avisos.push(aviso.message ?? "");
  };

  client.on("notice", escuta);

  try {
    await client.query(`set local sb.compensacao_organizacao = '${organizationId}'`);
    await client.query(script);
  } finally {
    client.off("notice", escuta);
  }
}

/** O alvo LOCAL de um SKU: `snapshot + movimentos com occurred_at > captured_at`. */
async function alvoLocal(organizationId: string, skuId: string): Promise<number> {
  const result = await client.query<{ quantity: string }>(
    `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
    [organizationId, skuId],
  );

  return Number(result.rows[0]?.quantity ?? 0);
}

async function saldoLocal(organizationId: string, skuId: string): Promise<number> {
  const result = await client.query<{ quantity: string }>(
    `select quantity from public.inventory_balances
      where organization_id = $1 and sku_id = $2 and location_kind = 'LOCAL'`,
    [organizationId, skuId],
  );

  return Number(result.rows[0]?.quantity ?? 0);
}

interface LinhaGravada {
  movement_type: string;
  idempotency_key: string;
  qty_delta: number;
  occurred_at: string;
  created_by: string | null;
}

async function movimentosDe(organizationId: string): Promise<LinhaGravada[]> {
  const result = await client.query<{
    movement_type: string;
    idempotency_key: string;
    qty_delta: string;
    occurred_at: Date;
    created_by: string | null;
  }>(
    `select movement_type, idempotency_key, qty_delta, occurred_at, created_by
       from public.stock_movements where organization_id = $1 order by idempotency_key`,
    [organizationId],
  );

  return result.rows.map((row) => ({
    movement_type: row.movement_type,
    idempotency_key: row.idempotency_key,
    qty_delta: Number(row.qty_delta),
    occurred_at: row.occurred_at.toISOString(),
    created_by: row.created_by,
  }));
}

function indexadoPorChave(linhas: readonly LinhaGravada[]): Map<string, LinhaGravada> {
  return new Map(linhas.map((linha) => [linha.idempotency_key, linha]));
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Tokens como '' e nao NULL: usuario criado por SQL com token nulo envenena a listagem
  // do GoTrue inteira (docs/TESTING.md).
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_user_meta_data, created_at, updated_at,
                             confirmation_token, recovery_token, email_change, email_change_token_new,
                             email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, 'x', now(),
             '{"full_name":"Admin D-352"}', now(), now(), '', '', '', '', '', '', '', '')`,
    [ADMIN, `${PREFIXO}@d352.test`],
  );

  await novaOrganizacao(ORG_FULL, "full");
  await novaOrganizacao(ORG_RECONCILIADA, "reconciliada");
  await novaOrganizacao(ORG_RODADA, "rodada");
  await novaOrganizacao(ORG_COBERTO, "coberto");
  await novaOrganizacao(ORG_RESIDUO, "residuo");
  await novaOrganizacao(ORG_PENDENTE, "pendente");

  skuFull = await novoSku(ORG_FULL, "full");
  skuReconciliada = await novoSku(ORG_RECONCILIADA, "full");
  skuRodada = await novoSku(ORG_RODADA, "full");
  skuCoberto = await novoSku(ORG_COBERTO, "full");
  skuResiduo = await novoSku(ORG_RESIDUO, "full");
  skuPendente = await novoSku(ORG_PENDENTE, "full");

  await snapshot(ORG_FULL, skuFull, 20);
  await snapshot(ORG_RECONCILIADA, skuReconciliada, 20);
  await snapshot(ORG_RODADA, skuRodada, 20);
  await snapshot(ORG_COBERTO, skuCoberto, 20);
  await snapshot(ORG_RESIDUO, skuResiduo, 20);

  const contaFull = await novaConta(ORG_FULL, "full", 3521);
  const contaReconciliada = await novaConta(ORG_RECONCILIADA, "rec", 3522);
  const contaRodada = await novaConta(ORG_RODADA, "rod", 3523);
  const contaCoberto = await novaConta(ORG_COBERTO, "cob", 3524);
  const contaResiduo = await novaConta(ORG_RESIDUO, "res", 3525);
  const contaPendente = await novaConta(ORG_PENDENTE, "pen", 3526);

  // 1: Full, venda sem par -> ESTORNO_FULL espelhado.
  await pedido(ORG_FULL, contaFull, PEDIDO + 1, "fulfillment");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(1), em(5), String(PEDIDO + 1));

  // 2: cross_docking -> a venda continua baixando a loja, nada a fazer.
  await pedido(ORG_FULL, contaFull, PEDIDO + 2, "cross_docking");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(2), em(5), String(PEDIDO + 2));

  // 3: sinal ainda NAO capturado -> a varredura nao passou por ele; nada a fazer, e sai
  // no NOTICE de pendentes (R2: nunca presumir Full).
  await pedido(ORG_FULL, contaFull, PEDIDO + 3, null, false);
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(3), em(5), String(PEDIDO + 3));

  // 4: Full ja estornado pelo worker novo -> nao duplica.
  await pedido(ORG_FULL, contaFull, PEDIDO + 4, "fulfillment");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(4), em(5), String(PEDIDO + 4));
  await movimento(ORG_FULL, skuFull, "ESTORNO_FULL", 1, `estorno:${chave(4)}`, em(5), String(PEDIDO + 4));

  // 5: Full com ESTORNO_PRE_CAPTURA (D-351) e cancelamento -> NAO ganha segundo estorno,
  // mas a reversao e anulada inteira. E um estado que a varredura DEIXA desde a revisao de
  // 6965b0e: ela le o envio tambem da venda pre-capturada, carimba a captura primeiro e so
  // depois grava a anulacao -- se a anulacao falhar, o pedido fica assim ate a rodada
  // seguinte, e a compensacao que rodar nesse meio tempo o fecha.
  await pedido(ORG_FULL, contaFull, PEDIDO + 5, "fulfillment", true, "cancelled");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(5), em(5), String(PEDIDO + 5));
  await movimento(ORG_FULL, skuFull, "ESTORNO_PRE_CAPTURA", 1, `estorno:${chave(5)}`, em(5), String(PEDIDO + 5));
  await movimento(ORG_FULL, skuFull, "CANCELAMENTO_ML", 1, `cancelamento:${chave(5)}`, em(30), String(PEDIDO + 5));

  // 6: Full com cancelamento e SEM estorno -> estorno + anulacao, soma zero.
  await pedido(ORG_FULL, contaFull, PEDIDO + 6, "fulfillment", true, "cancelled");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(6), em(5), String(PEDIDO + 6));
  await movimento(ORG_FULL, skuFull, "CANCELAMENTO_ML", 1, `cancelamento:${chave(6)}`, em(40), String(PEDIDO + 6));

  // 7: Full com DEVOLUCAO_ML, gravada com a origem do CLAIM -- o pedido so aparece DENTRO
  // da chave, e e por isso que a view a procura pelo `split_part`.
  await pedido(ORG_FULL, contaFull, PEDIDO + 7, "fulfillment");
  await movimento(ORG_FULL, skuFull, "VENDA_ML", -1, chave(7), em(5), String(PEDIDO + 7));
  await movimento(
    ORG_FULL,
    skuFull,
    "DEVOLUCAO_ML",
    1,
    `devolucao:${claim(7)}:${chave(7)}`,
    em(50),
    claim(7),
    "CLAIM",
  );

  // Organizacao que JA reconciliou (AJUSTE_RECONCILIACAO): fora, com aviso.
  await pedido(ORG_RECONCILIADA, contaReconciliada, PEDIDO + 8, "fulfillment");
  await movimento(ORG_RECONCILIADA, skuReconciliada, "VENDA_ML", -1, chave(8), em(5), String(PEDIDO + 8));
  await movimento(ORG_RECONCILIADA, skuReconciliada, "AJUSTE_RECONCILIACAO", 21, `${PREFIXO}:reconciliacao`, em(8));

  // Organizacao com uma RODADA concluida e nenhum ajuste: tambem fora. A rodada que nao
  // gravou ajuste nenhum TAMBEM alinhou o saldo (`get_erp_stock_cutoffs`).
  await pedido(ORG_RODADA, contaRodada, PEDIDO + 11, "fulfillment");
  await movimento(ORG_RODADA, skuRodada, "VENDA_ML", -1, chave(11), em(5), String(PEDIDO + 11));
  await client.query(
    `insert into public.job_runs (organization_id, job_id, job_type, dedupe_key, attempt, status, started_at, finished_at)
     values ($1, $2, 'maintenance.reconcile-balances', $3, 1, 'done', now(), now())`,
    [ORG_RODADA, randomUUID(), `${PREFIXO}:reconcile`],
  );

  // Anulacao da D-351 que COBRE a reversao inteira (V = 1, R = 1 pelo cancelamento):
  // nao e residuo, e o pedido fecha em zero. A devolucao, sem anulacao, e anulada agora.
  await pedido(ORG_COBERTO, contaCoberto, PEDIDO + 9, "fulfillment", true, "cancelled");
  await movimento(ORG_COBERTO, skuCoberto, "VENDA_ML", -1, chave(9), em(5), String(PEDIDO + 9));
  await movimento(ORG_COBERTO, skuCoberto, "ESTORNO_PRE_CAPTURA", 1, `estorno:${chave(9)}`, em(5), String(PEDIDO + 9));
  await movimento(
    ORG_COBERTO,
    skuCoberto,
    "DEVOLUCAO_ML",
    1,
    `devolucao:${claim(9)}:${chave(9)}`,
    em(30),
    claim(9),
    "CLAIM",
  );
  await movimento(ORG_COBERTO, skuCoberto, "CANCELAMENTO_ML", 1, `cancelamento:${chave(9)}`, em(40), String(PEDIDO + 9));
  await movimento(
    ORG_COBERTO,
    skuCoberto,
    "ESTORNO_REVERSAO_EXCEDENTE",
    -1,
    `estorno:cancelamento:${chave(9)}`,
    em(40),
    String(PEDIDO + 9),
  );

  // Pedido SEM sinal com a venda ja estornada pela D-351 e cancelada depois do corte: soma
  // +1 hoje e nao e compensado aqui (sem sinal, nunca presumir Full) -- mas CONTA como
  // pendente, porque a varredura ainda vai ler o envio dele.
  await pedido(ORG_PENDENTE, contaPendente, PEDIDO + 12, null, false, "cancelled");
  await movimento(ORG_PENDENTE, skuPendente, "VENDA_ML", -1, chave(12), em(5), String(PEDIDO + 12));
  await movimento(ORG_PENDENTE, skuPendente, "ESTORNO_PRE_CAPTURA", 1, `estorno:${chave(12)}`, em(5), String(PEDIDO + 12));
  await movimento(ORG_PENDENTE, skuPendente, "CANCELAMENTO_ML", 1, `cancelamento:${chave(12)}`, em(30), String(PEDIDO + 12));

  // Anulacao da D-351 que cobre MENOS que a reversao (R = 2, E = 1): o UNIQUE impede
  // completar, e o caso vira residuo DECLARADO.
  await pedido(ORG_RESIDUO, contaResiduo, PEDIDO + 10, "fulfillment", true, "cancelled");
  await movimento(ORG_RESIDUO, skuResiduo, "VENDA_ML", -1, chave(10), em(5), String(PEDIDO + 10));
  await movimento(ORG_RESIDUO, skuResiduo, "ESTORNO_PRE_CAPTURA", 1, `estorno:${chave(10)}`, em(5), String(PEDIDO + 10));
  await movimento(
    ORG_RESIDUO,
    skuResiduo,
    "CANCELAMENTO_ML",
    2,
    `cancelamento:${chave(10)}`,
    em(40),
    String(PEDIDO + 10),
  );
  await movimento(
    ORG_RESIDUO,
    skuResiduo,
    "ESTORNO_REVERSAO_EXCEDENTE",
    -1,
    `estorno:cancelamento:${chave(10)}`,
    em(40),
    String(PEDIDO + 10),
  );
});

afterAll(async () => {
  // Sem limpeza: `stock_movements` e append-only, e as organizacoes ficam como ficam as
  // das outras suites ("o ambiente local acumula ate o proximo `supabase db reset`").
  await client.end();
});

describe("compensacao D-352 (packages/db/scripts, fora das migrations)", () => {
  it("compensa so o pedido do Full: espelha a data, anula a reversao inteira, fecha o alvo e a segunda execucao grava 0", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_FULL, avisos);

      const gravados = await movimentosDe(ORG_FULL);
      const porChave = indexadoPorChave(gravados);

      // 1 -- o estorno espelhado: quantidade OPOSTA, MESMA `occurred_at` da venda, linha
      // de sistema (sem `created_by`).
      expect(porChave.get(`estorno:${chave(1)}`)).toEqual({
        movement_type: "ESTORNO_FULL",
        idempotency_key: `estorno:${chave(1)}`,
        qty_delta: 1,
        occurred_at: em(5),
        created_by: null,
      });

      // 2 e 3 -- `cross_docking` e sem sinal: nada. A venda deles continua baixando a loja.
      expect(porChave.has(`estorno:${chave(2)}`)).toBe(false);
      expect(porChave.has(`estorno:${chave(3)}`)).toBe(false);

      // 4 -- ja estornado: continua com UM estorno.
      expect(gravados.filter((linha) => linha.idempotency_key === `estorno:${chave(4)}`)).toHaveLength(1);

      // 5 -- o estorno que a D-351 gravou NAO e substituido (a chave e a mesma, e um
      // estorno por venda, nunca dois), mas a reversao e anulada INTEIRA.
      expect(porChave.get(`estorno:${chave(5)}`)?.movement_type).toBe("ESTORNO_PRE_CAPTURA");
      expect(porChave.get(`estorno:cancelamento:${chave(5)}`)).toMatchObject({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
        // O instante ESPELHADO da reversao: o par cai do mesmo lado do corte do alvo.
        occurred_at: em(30),
      });

      // 6 -- estorno e anulacao juntos.
      expect(porChave.get(`estorno:${chave(6)}`)?.qty_delta).toBe(1);
      expect(porChave.get(`estorno:cancelamento:${chave(6)}`)).toMatchObject({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
        occurred_at: em(40),
      });

      // 7 -- a devolucao, achada pela chave e nao pela origem, tambem e anulada.
      expect(porChave.get(`estorno:devolucao:${claim(7)}:${chave(7)}`)).toMatchObject({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
        occurred_at: em(50),
      });

      // O ALVO: 20 do snapshot, menos as DUAS vendas que continuam baixando a loja (a
      // `cross_docking` e a sem sinal). Todo pedido do Full soma zero no alvo tambem,
      // porque cada par cai do mesmo lado do corte.
      expect(await alvoLocal(ORG_FULL, skuFull)).toBe(18);
      // E o saldo anda junto: o ledger deste SKU tambem soma -2.
      expect(await saldoLocal(ORG_FULL, skuFull)).toBe(-2);

      // Tres estornos (1, 6 e 7 -- o 4 ja tinha e o 5 fica com o da D-351) e tres
      // anulacoes (5, 6 e 7).
      expect(avisos).toContain("compensacao_d352: 3 estornos de venda do Full gravados");
      expect(avisos).toContain("compensacao_d352: 3 reversoes de pedido do Full anuladas inteiras");
      // O pedido 3 ainda nao tem sinal: a varredura nao terminou, e isso e DECLARADO.
      expect(avisos.some((aviso) => aviso.includes("1 pedido(s) com VENDA_ML continuam SEM o sinal"))).toBe(true);

      // Segunda execucao: nada novo, e nenhuma assercao quebra.
      const segunda: string[] = [];

      await rodarCompensacao(ORG_FULL, segunda);

      expect(segunda).toContain("compensacao_d352: 0 estornos de venda do Full gravados");
      expect(segunda).toContain("compensacao_d352: 0 reversoes de pedido do Full anuladas inteiras");
      expect(await movimentosDe(ORG_FULL)).toHaveLength(gravados.length);
    } finally {
      await client.query("rollback");
    }
  });

  it("organizacao com AJUSTE_RECONCILIACAO nao e compensada — e avisa, em vez de sumir em silencio", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_RECONCILIADA, avisos);

      expect((await movimentosDe(ORG_RECONCILIADA)).map((linha) => linha.movement_type).sort()).toEqual([
        "AJUSTE_RECONCILIACAO",
        "VENDA_ML",
      ]);
      expect(avisos.some((aviso) => aviso.includes("ja reconciliou") && aviso.includes("NAO compensada"))).toBe(true);
      expect(avisos).toContain("compensacao_d352: 0 estornos de venda do Full gravados");
    } finally {
      await client.query("rollback");
    }
  });

  it("uma rodada CONCLUIDA de reconcile-balances, sem ajuste nenhum, tambem tira a organizacao da lista", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_RODADA, avisos);

      expect((await movimentosDe(ORG_RODADA)).map((linha) => linha.movement_type)).toEqual(["VENDA_ML"]);
      expect(avisos.some((aviso) => aviso.includes("ja reconciliou") && aviso.includes("NAO compensada"))).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("anulacao da D-351 que ja cobre a reversao inteira: nao e residuo, e o pedido fecha em zero", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_COBERTO, avisos);

      const gravados = await movimentosDe(ORG_COBERTO);
      const porChave = indexadoPorChave(gravados);

      // A devolucao nao tinha anulacao nenhuma: e anulada INTEIRA agora.
      expect(porChave.get(`estorno:devolucao:${claim(9)}:${chave(9)}`)).toMatchObject({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
      });
      // O cancelamento ja tinha a anulacao da D-351, que cobre a reversao inteira.
      expect(porChave.get(`estorno:cancelamento:${chave(9)}`)?.qty_delta).toBe(-1);
      expect(avisos.some((aviso) => aviso.includes("RESIDUO"))).toBe(false);
      // -1 (venda) +1 (estorno) +1 (devolucao) +1 (cancelamento) -1 -1 (anulacoes) = 0.
      expect(gravados.reduce((total, linha) => total + linha.qty_delta, 0)).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("anulacao parcial que cobre MENOS que a reversao: sai em NOTICE de RESIDUO com o que falta, e o bloco termina", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_RESIDUO, avisos);

      const residuo = avisos.find((aviso) => aviso.includes("RESIDUO"));

      expect(residuo).toBeDefined();
      expect(residuo).toContain(`cancelamento:${chave(10)}`);
      expect(residuo).toContain("faltam 1 un.");
      // Nenhuma segunda anulacao entrou (a chave e a mesma, e o UNIQUE a recusa).
      expect(
        (await movimentosDe(ORG_RESIDUO)).filter(
          (linha) => linha.idempotency_key === `estorno:cancelamento:${chave(10)}`,
        ),
      ).toHaveLength(1);
      // E o bloco TERMINA: a assercao final exclui o pedido do residuo em vez de abortar a
      // correcao dos outros por causa dele.
      expect(avisos).toContain("compensacao_d352: 0 estornos de venda do Full gravados");
    } finally {
      await client.query("rollback");
    }
  });

  it("pedido sem sinal com a venda JA estornada pela D-351 conta como pendente — e nao e compensado (revisao de 6965b0e, ALTA)", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarCompensacao(ORG_PENDENTE, avisos);

      // Antes da revisao o NOTICE contava so venda SEM estorno e dizia "nenhum pedido
      // pendente" -- com o +1 deste pedido de pe e fora de toda conta.
      expect(avisos.some((aviso) => aviso.includes("1 pedido(s) com VENDA_ML continuam SEM o sinal"))).toBe(true);
      expect(avisos).not.toContain("compensacao_d352: nenhum pedido pendente do sinal -- a varredura cobriu o universo");
      // Sem sinal, nada: nunca presumir Full (R2).
      expect(indexadoPorChave(await movimentosDe(ORG_PENDENTE)).has(`estorno:cancelamento:${chave(12)}`)).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("a captura da logistica so nasce uma vez (trigger orders_logistica_congelada, D-352 R5)", () => {
  async function logisticaDe(id: number): Promise<{ logistic_type: string | null; capturado: boolean }> {
    const result = await client.query<{ logistic_type: string | null; capturado: boolean }>(
      `select logistic_type, logistic_captured_at is not null as capturado from public.orders where id = $1`,
      [id],
    );
    const linha = result.rows[0];

    if (linha === undefined) {
      throw new Error(`pedido ${String(id)} sumiu`);
    }

    return linha;
  }

  it("o upsert do pedido que leu a linha ANTES da varredura nao apaga a captura dela", async () => {
    await client.query("begin");

    try {
      // A forma do upsert de `persist-order.ts`: DO UPDATE com as duas colunas nulas.
      await client.query(
        `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_last_updated,
                                    total_amount, currency_id, logistic_type, logistic_captured_at)
         select id, organization_id, ml_account_id, status, date_created, now(), total_amount, currency_id, null, null
           from public.orders where id = $1
         on conflict (id) do update
           set logistic_type = excluded.logistic_type,
               logistic_captured_at = excluded.logistic_captured_at,
               date_last_updated = excluded.date_last_updated`,
        [PEDIDO + 4],
      );

      expect(await logisticaDe(PEDIDO + 4)).toEqual({ logistic_type: "fulfillment", capturado: true });
    } finally {
      await client.query("rollback");
    }
  });

  it("captura gravada nao troca de valor, e a pendente ainda recebe a primeira", async () => {
    await client.query("begin");

    try {
      await client.query(`update public.orders set logistic_type = 'fulfillment' where id = $1`, [PEDIDO + 2]);
      await client.query(
        `update public.orders set logistic_type = 'fulfillment', logistic_captured_at = now()
          where id = $1 and logistic_captured_at is null`,
        [PEDIDO + 3],
      );

      expect(await logisticaDe(PEDIDO + 2)).toEqual({ logistic_type: "cross_docking", capturado: true });
      expect(await logisticaDe(PEDIDO + 3)).toEqual({ logistic_type: "fulfillment", capturado: true });
    } finally {
      await client.query("rollback");
    }
  });
});
