import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";

/** O cliente com a chave de serviço local, tipado pelo banco, como o do seed. */
export type ClienteDeServico = ReturnType<typeof createClient<Database>>;

/**
 * UMA LOJA SHOPEE LIVE, SÓ DURANTE O ENSAIO DO GO LIVE DAS TELAS (D-486, T9).
 *
 * O seed tem só a loja de TESTE, de propósito: as provas de equivalência das
 * outras telas (o "Todos" igual ao Mercado Livre) dependem de nenhuma loja live
 * existir. Por isso o caminho "com Shopee" de cada tela nunca era renderizado
 * no e2e — só os unitários (a leitura) e a integração do A1 (o SQL). Este módulo
 * cria a loja live no começo do spec e a APAGA no fim: apagar a loja leva
 * pedidos, itens, devoluções, repasse e Ads em cascata. O SKU próprio FICA: o
 * custo dele gera uma linha em `sku_cost_history`, que é só de inserção (nem a
 * chave de serviço apaga) e segura o SKU. Por isso o spec roda no projeto
 * `loja-live`, DEPOIS de todos os outros (`playwright.config.ts`), e o SKU é
 * reaproveitado (upsert) numa rodada seguinte no mesmo banco. Nunca em Dev nem
 * em produção: a chave é a local (`supabase status`).
 *
 * Os números são feitos para conferir de cabeça (regras do A1, 16/10):
 * - 10 pedidos COBERTOS nos últimos 10 dias: R$ 100 de receita cada, R$ 80 de
 *   recebido (comissão 10, serviço 5, transação 3, frete 2), 1 unidade do SKU
 *   próprio, de custo R$ 20 — financeiro lido, item com SKU e custo conhecido;
 * - 1 pedido válido AGUARDANDO O FINANCEIRO (sem `order_income` nem recebido);
 * - 1 pedido CANCELADO, que não entra em nada;
 * - 1 devolução, do 1º pedido; o repasse de 5 pedidos; 7 dias de Ads CPC.
 * Válidos no período: 11 pedidos e R$ 1.100 de receita.
 */

export const LOJA_LIVE = {
  shopId: 990000777,
  nome: "Loja Shopee Real E2E",
  /**
   * Prefixo próprio, que não colide com o seed (`E2E-SKU-…`) nem com a integração do A1.
   * Este SKU FICA no banco depois do ensaio: o custo dele gera uma linha em
   * `sku_cost_history`, que é só de inserção, e ela segura o SKU (ver o topo).
   */
  sku: "E2E-SHOPEE-LIVE-001",
  skuTitulo: "Produto da loja live E2E",
  custo: 20,
  receitaPorPedido: 100,
  recebidoPorPedido: 80,
  pedidosCobertos: 10,
  pedidosValidos: 11,
  receitaValida: 1_100,
} as const;

const ORG_SLUG = "e2e-speed-bikers";

interface Pedido {
  readonly sn: string;
  readonly dia: number;
  readonly status: string;
  readonly financeiro: boolean;
}
const DIA_MS = 86_400_000;

export function clienteDeServico(): ClienteDeServico {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (chave === "") {
    throw new Error(
      "defina SUPABASE_SERVICE_ROLE_KEY (a chave local de `supabase status`, nunca a de produção) para o ensaio da loja live",
    );
  }

  return createClient<Database>(url, chave, { auth: { persistSession: false } });
}

function erro(contexto: string, e: { message: string } | null): void {
  if (e !== null) throw new Error(`${contexto}: ${e.message}`);
}

/** Às 15:00 UTC de N dias atrás: dentro do mesmo dia comercial em São Paulo. */
function diasAtras(n: number): string {
  const d = new Date(Date.now() - n * DIA_MS);

  d.setUTCHours(15, 0, 0, 0);

  return d.toISOString();
}

export async function criarLojaLive(db: ClienteDeServico): Promise<{ lojaId: string; skuId: string }> {
  await apagarLojaLive(db);

  const org = await db.from("organizations").select("id").eq("slug", ORG_SLUG).single();

  if (org.error !== null) throw new Error(`organização do e2e: ${org.error.message}`);

  const organizationId = org.data.id;

  const sku = await db
    .from("skus")
    .upsert(
      { organization_id: organizationId, sku: LOJA_LIVE.sku, title: LOJA_LIVE.skuTitulo, kind: "PRODUTO", purchase_cost: LOJA_LIVE.custo },
      { onConflict: "organization_id,sku_key" },
    )
    .select("id")
    .single();

  if (sku.error !== null) throw new Error(`SKU da loja live: ${sku.error.message}`);

  const skuId = sku.data.id;
  const agora = new Date().toISOString();

  const loja = await db
    .from("shopee_shops")
    .insert({
      organization_id: organizationId,
      environment: "live",
      shop_id: LOJA_LIVE.shopId,
      shop_name: LOJA_LIVE.nome,
      region: "BR",
      shop_status: "NORMAL",
      status: "CONNECTED",
      auth_expires_at: new Date(Date.now() + 365 * DIA_MS).toISOString(),
      connected_at: new Date(Date.now() - 120 * DIA_MS).toISOString(),
      items_synced_until: agora,
      // As cinco marcas de leitura (A1): sem elas a Shopee vem "não lida" e nula.
      orders_synced_until: agora,
      orders_last_success_at: agora,
      returns_synced_until: agora,
      escrow_releases_read_from: new Date(Date.now() - 90 * DIA_MS).toISOString(),
      escrow_releases_synced_until: agora,
      ads_read_from: diasAtras(30).slice(0, 10),
      ads_read_until: diasAtras(1).slice(0, 10),
      ads_synced_at: agora,
    })
    .select("id")
    .single();

  if (loja.error !== null) throw new Error(`loja live: ${loja.error.message}`);

  const lojaId = loja.data.id;

  const pedidos: Pedido[] = [
    ...Array.from({ length: LOJA_LIVE.pedidosCobertos }, (_, i) => ({
      sn: `E2ELIVE${String(i + 1).padStart(2, "0")}`,
      dia: i + 1,
      status: "COMPLETED",
      financeiro: true,
    })),
    { sn: "E2ELIVE-SEMFIN", dia: 2, status: "SHIPPED", financeiro: false },
    { sn: "E2ELIVE-CANCEL", dia: 3, status: "CANCELLED", financeiro: false },
  ];

  const insercaoPedidos = await db.from("shopee_orders").insert(
    pedidos.map((p) => ({
      shopee_shop_id: lojaId,
      organization_id: organizationId,
      order_sn: p.sn,
      order_status: p.status,
      currency: "BRL",
      total_amount: LOJA_LIVE.receitaPorPedido,
      shopee_created_at: diasAtras(p.dia),
      shopee_updated_at: diasAtras(p.dia),
      paid_at: p.status === "CANCELLED" ? null : diasAtras(p.dia),
      ...(p.financeiro
        ? {
            escrow_amount: LOJA_LIVE.recebidoPorPedido,
            commission_fee: 10,
            service_fee: 5,
            seller_transaction_fee: 3,
            actual_shipping_fee: 2,
            order_income: {
              order_discounted_price: LOJA_LIVE.receitaPorPedido,
              escrow_amount: LOJA_LIVE.recebidoPorPedido,
            },
            financials_synced_at: agora,
          }
        : {}),
    })),
  );

  erro("pedidos da loja live", insercaoPedidos.error);

  const insercaoItens = await db.from("shopee_order_items").insert(
    pedidos.map((p) => ({
      shopee_shop_id: lojaId,
      order_sn: p.sn,
      position: 0,
      organization_id: organizationId,
      item_id: 990777001,
      item_name: LOJA_LIVE.skuTitulo,
      item_sku: LOJA_LIVE.sku,
      quantity: 1,
      original_price: 120,
      discounted_price: LOJA_LIVE.receitaPorPedido,
      sku_id: skuId,
      vinculo_via: "SKU_DO_PEDIDO",
    })),
  );

  erro("itens da loja live", insercaoItens.error);

  const devolucao = await db.from("shopee_returns").insert({
    shopee_shop_id: lojaId,
    organization_id: organizationId,
    return_sn: "E2ELIVE-DEV01",
    order_sn: "E2ELIVE01",
    status: "ACCEPTED",
    reason: "NOT_RECEIPT",
    return_solution: "RETURN_REFUND",
    refund_amount: LOJA_LIVE.receitaPorPedido,
    currency: "BRL",
    shopee_created_at: diasAtras(1),
    shopee_updated_at: diasAtras(1),
  });

  erro("devolução da loja live", devolucao.error);

  const itemDevolvido = await db.from("shopee_return_items").insert({
    shopee_shop_id: lojaId,
    return_sn: "E2ELIVE-DEV01",
    position: 0,
    organization_id: organizationId,
    item_id: 990777001,
    item_name: LOJA_LIVE.skuTitulo,
    item_sku: LOJA_LIVE.sku,
    quantity: 1,
    item_price: LOJA_LIVE.receitaPorPedido,
    sku_id: skuId,
    vinculo_via: "SKU_DO_PEDIDO",
  });

  erro("item devolvido da loja live", itemDevolvido.error);

  const repasse = await db.from("shopee_escrow_releases").insert(
    pedidos.slice(5, 10).map((p) => ({
      shopee_shop_id: lojaId,
      organization_id: organizationId,
      order_sn: p.sn,
      released_at: diasAtras(p.dia - 4),
      payout_amount: LOJA_LIVE.recebidoPorPedido,
    })),
  );

  erro("repasse da loja live", repasse.error);

  const ads = await db.from("daily_shopee_ads_metrics").insert(
    Array.from({ length: 7 }, (_, i) => ({
      shopee_shop_id: lojaId,
      organization_id: organizationId,
      metric_date: diasAtras(i + 1).slice(0, 10),
      impressions: 1_000,
      clicks: 50,
      direct_orders: 1,
      broad_orders: 2,
      direct_items: 1,
      broad_items: 2,
      direct_gmv: 100,
      broad_gmv: 200,
      expense: 10,
    })),
  );

  erro("Ads da loja live", ads.error);

  return { lojaId, skuId };
}

/** Apaga a loja; pedidos, itens, devoluções, repasse e Ads vão em cascata. Pode rodar sem a loja existir. */
export async function apagarLojaLive(db: ClienteDeServico): Promise<void> {
  const loja = await db.from("shopee_shops").delete().eq("environment", "live").eq("shop_id", LOJA_LIVE.shopId);

  erro("apagar a loja live", loja.error);
}
