import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D-861: o produto FORA DO CATÁLOGO (D-860) que ainda tem anúncio ativo
 * vinculado vira ação na Central (`sincronizar_alertas_central`, fonte
 * `fora_do_catalogo_anunciado`). Provado contra o Postgres real.
 *
 * O que só o banco prova:
 * - o vínculo do Mercado Livre é o de `get_sku_listings` (o SKU resolvido em
 *   `listings` e o vínculo ITEM);
 * - o anúncio pausado ou excluído (D-631 b) não conta;
 * - na Shopee só conta a unidade NORMAL de loja live;
 * - a ação é uma por SKU, com a evidência e a recomendação pela origem da marca;
 * - quem volta ao catálogo encerra pelo ciclo de vida de 3 dias.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = randomUUID();
const CONTA = randomUUID();
const LOJA = randomUUID();
const PREFIXO = `d861-${ORG.slice(0, 8)}`.toUpperCase();
const FONTE = "fora_do_catalogo_anunciado";

let client: Client;

const sku: Record<string, string> = {};

interface Acao {
  subject_key: string;
  status: string;
  severity: string;
  confidence: string;
  impacto: string | null;
  sku_id: string | null;
  ml_account_id: string | null;
  shopee_shop_id: string | null;
  recommendation: string;
  evidencias: { tipo: string; descricao: string }[];
  detector: {
    sku: string;
    origem: string;
    anuncios_ml: number;
    anuncios_shopee: number;
    anuncios: { canal: string; item_id: string | number }[];
    saldo_local: number | null;
  };
  motivo: string | null;
}

const codigo = (chave: string): string => `${PREFIXO}-${chave}`;

async function sincronizar(dia: string): Promise<{ fontes: string[]; detectados: Record<string, number>; criadas: number; encerradas: number }> {
  const result = await client.query<{ r: { fontes: string[]; detectados: Record<string, number>; criadas: number; encerradas: number } }>(
    "select public.sincronizar_alertas_central($1, $2::date, array[$3]) as r",
    [ORG, dia, FONTE],
  );
  const r = result.rows[0]?.r;

  if (r === undefined) throw new Error("sem resposta");

  return r;
}

async function acoes(): Promise<Acao[]> {
  const result = await client.query<Acao>(
    `select subject_key, status, severity, confidence, estimated_impact_brl::text as impacto, sku_id, ml_account_id, shopee_shop_id,
            recommendation, evidence -> 'evidencias' as evidencias, evidence -> 'detector' as detector,
            evidence -> 'encerramento' ->> 'motivo' as motivo
       from public.actions where organization_id = $1 and kind = $2 order by evidence -> 'detector' ->> 'sku'`,
    [ORG, FONTE],
  );

  return result.rows;
}

async function marcar(chave: string, origem: "PLANILHA" | "MANUAL" | null): Promise<void> {
  await client.query(
    `update public.skus set
       erp_absent_since = case when $2::text is null then null else timestamptz '2026-11-23 10:00:00-03' end,
       erp_absent_source = $2::text,
       erp_absent_was_active = case when $2::text = 'MANUAL' then true end,
       is_active = $2::text is null
     where id = $1`,
    [sku[chave], origem],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query("insert into public.organizations (id, name, slug) values ($1, 'Org D-861', $2)", [ORG, `org-${PREFIXO.toLowerCase()}`]);
  await client.query(
    `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $2, 'Conta D-861', $3, $4, 'CONNECTED', now())`,
    [CONTA, ORG, `conta-${PREFIXO.toLowerCase()}`, Math.floor(Math.random() * 1e9) + 8_610_000_000],
  );
  await client.query(
    `insert into public.shopee_shops (id, organization_id, environment, shop_id, shop_name, status, connected_at, orders_synced_until, orders_last_success_at, items_synced_until)
     values ($1, $2, 'live', $3, 'Loja D-861', 'CONNECTED', now() - interval '60 days', now(), now(), now())`,
    [LOJA, ORG, Math.floor(Math.random() * 1e8) + 861_000_000],
  );

  // A: planilha, anúncio ML pelo SKU resolvido. B: à mão, vínculo ITEM no ML
  // e unidade na Shopee. C: anúncio pausado. D: anúncio excluído (D-631 b).
  // E: no catálogo, com anúncio. F: fora, sem anúncio. G: só Shopee fora do ar.
  for (const chave of ["A", "B", "C", "D", "E", "F", "G"]) {
    const result = await client.query<{ id: string }>(
      "insert into public.skus (organization_id, sku, kind, title) values ($1, $2, 'PRODUTO', $3) returning id",
      [ORG, codigo(chave), `Produto ${chave}`],
    );
    const id = result.rows[0]?.id;

    if (id === undefined) throw new Error(`sku ${chave}`);
    sku[chave] = id;
  }

  await marcar("A", "PLANILHA");
  await marcar("B", "MANUAL");
  await marcar("C", "PLANILHA");
  await marcar("D", "PLANILHA");
  await marcar("F", "MANUAL");
  await marcar("G", "PLANILHA");

  await client.query(
    `insert into public.listings (organization_id, ml_account_id, item_id, title, status, price, currency_id, available_quantity, sku_id, deleted_at)
     values ($1, $2, 'MLB8610001', 'Anúncio A', 'active', 10, 'BRL', 3, $3, null),
            ($1, $2, 'MLB8610002', 'Anúncio B', 'active', 10, 'BRL', 1, null, null),
            ($1, $2, 'MLB8610003', 'Anúncio C', 'paused', 10, 'BRL', 0, $4, null),
            ($1, $2, 'MLB8610004', 'Anúncio D', 'active', 10, 'BRL', 1, $5, now()),
            ($1, $2, 'MLB8610005', 'Anúncio E', 'active', 10, 'BRL', 1, $6, null)`,
    [ORG, CONTA, sku.A, sku.C, sku.D, sku.E],
  );
  await client.query(
    `insert into public.sku_listing_links (organization_id, ml_account_id, sku_id, ref_kind, item_id)
     values ($1, $2, $3, 'ITEM', 'MLB8610002')`,
    [ORG, CONTA, sku.B],
  );
  await client.query(
    `insert into public.shopee_items (shopee_shop_id, organization_id, item_id, item_status, shopee_updated_at, item_name, item_sku, has_model,
                                      details_synced_at, details_update_time, details_error, available_stock, is_fulfillment_by_shopee)
     values ($1, $2, 8610001, 'NORMAL', now(), 'Shopee B', $3, false, now(), now(), null, 2, false),
            ($1, $2, 8610002, 'UNLIST', now(), 'Shopee G', $4, false, now(), now(), null, 2, false)`,
    [LOJA, ORG, codigo("B"), codigo("G")],
  );
  await client.query(
    `insert into public.stock_movements (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
     values ($1, $2, 'LOCAL', 3, 'AJUSTE_RECONCILIACAO', $3, now() - interval '2 days')`,
    [ORG, sku.A, `${PREFIXO}-saldo-a`],
  );
});

afterAll(async () => {
  await client.query("delete from public.actions where organization_id = $1", [ORG]);
  await client.end();
});

describe("o produto fora do catálogo com anúncio ativo na Central de Ações (D-861)", () => {
  it("a fonte roda e acha só quem está fora do catálogo com anúncio ativo vinculado", async () => {
    const r = await sincronizar("2026-11-24");

    expect(r.fontes).toEqual([FONTE]);
    expect(r.detectados).toEqual({ [FONTE]: 2 });
    expect(r.criadas).toBe(2);

    const lista = await acoes();

    expect(lista.map((a) => a.detector.sku)).toEqual([codigo("A"), codigo("B")]);
  });

  it("uma ação por SKU, média, confiança alta, sem impacto e sem conta ou loja", async () => {
    for (const a of await acoes()) {
      expect(a).toMatchObject({ status: "novo", severity: "media", confidence: "alta", impacto: null, ml_account_id: null, shopee_shop_id: null });
      expect(a.subject_key).toBe(a.sku_id);
    }
  });

  it("A: a marca da planilha, o anúncio do SKU resolvido e o último saldo", async () => {
    const a = (await acoes()).find((x) => x.detector.sku === codigo("A"));

    expect(a?.sku_id).toBe(sku.A);
    expect(a?.detector).toMatchObject({ origem: "PLANILHA", anuncios_ml: 1, anuncios_shopee: 0, saldo_local: 3 });
    expect(a?.detector.anuncios).toEqual([expect.objectContaining({ canal: "mercado_livre", item_id: "MLB8610001", conta: "Conta D-861" })]);
    expect(a?.evidencias.map((e) => e.descricao)).toEqual([
      `O SKU ${codigo("A")} está fora do catálogo desde 23/11/2026: saiu da planilha de produtos do UpSeller.`,
      "Ainda há 1 anúncio(s) ativo(s) vinculado(s) a ele: 1 no Mercado Livre e 0 na Shopee.",
      "O último saldo local na V3 é 3.",
    ]);
    expect(a?.recommendation).toContain("cadastre-o de novo no UpSeller");
  });

  it("B: a marca à mão, o vínculo ITEM no ML e a unidade da Shopee; sem saldo não vira zero", async () => {
    const b = (await acoes()).find((x) => x.detector.sku === codigo("B"));

    expect(b?.detector).toMatchObject({ origem: "MANUAL", anuncios_ml: 1, anuncios_shopee: 1, saldo_local: null });
    expect(b?.detector.anuncios.map((x) => [x.canal, x.item_id])).toEqual([
      ["mercado_livre", "MLB8610002"],
      ["shopee", 8610001],
    ]);
    expect(b?.evidencias.at(-1)?.descricao).toBe("A V3 não tem saldo local registrado para o SKU.");
    expect(b?.recommendation).toContain("volte o SKU ao catálogo em Produtos");
  });

  it("rodar de novo no mesmo dia atualiza e não duplica", async () => {
    const r = await sincronizar("2026-11-24");

    expect(r.criadas).toBe(0);
    expect(await acoes()).toHaveLength(2);
  });

  it("quem volta ao catálogo encerra depois de 3 dias sem detecção, com o motivo", async () => {
    await marcar("A", null);

    expect((await sincronizar("2026-11-26")).encerradas).toBe(0);

    const r = await sincronizar("2026-11-27");

    expect(r.encerradas).toBe(1);

    const a = (await acoes()).find((x) => x.detector.sku === codigo("A"));

    expect(a?.status).toBe("resolvido");
    expect(a?.motivo).toBe("O SKU voltou ao catálogo, ou deixou de ter anúncio ativo vinculado no Mercado Livre e na Shopee, há 3 dias.");
    expect((await acoes()).find((x) => x.detector.sku === codigo("B"))?.status).toBe("novo");
  });

  it("a fonte segue sendo só do worker (service_role)", async () => {
    const grants = await client.query<{ grantee: string }>(
      `select grantee from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = 'sincronizar_alertas_central' and privilege_type = 'EXECUTE'
        order by grantee`,
    );

    expect(grants.rows.map((g) => g.grantee)).not.toContain("authenticated");
    expect(grants.rows.map((g) => g.grantee)).not.toContain("anon");
  });
});
