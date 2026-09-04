/**
 * Seed dos dados que os testes Playwright precisam — SOMENTE contra o
 * Supabase local (`supabase start`). Nunca aponta para Dev/produção: usa
 * `SUPABASE_SERVICE_ROLE_KEY`, que ignora RLS, e criar/alterar dado com essa
 * chave fora do local seria escrever direto num banco compartilhado.
 *
 * Cobre o mínimo para os quatro fluxos críticos de `docs/TESTING.md`
 * ("E2E | Playwright | Login, página do produto, conferência de NF-e,
 * pedido de compra"):
 *
 *   - organização + usuário ADMIN com senha fixa (login);
 *   - um SKU com saldo LOCAL via `stock_movements` (página do produto);
 *   - uma NF-e (`documents`/`document_items`) em PARSED, com um item ainda
 *     sem vínculo (conferência de NF-e — o vínculo em si o teste faz pela
 *     UI, exercitando `link_document_item` de verdade);
 *   - uma conta Mercado Livre CONNECTED e dois `support_cases` (Caixa de
 *     Entrada, D-090): um NOVO com vínculo tipado de SKU e um RESOLVIDO com
 *     o fallback externo de anúncio que D-086 preserva. Dois estados porque
 *     o filtro padrão da tela é "abertos" — com um só não daria para provar
 *     que o RESOLVIDO fica de fora.
 *
 * "Pedido de compra" não precisa de seed: o formulário de `/compras/novo`
 * aceita SKU em texto livre sem exigir cadastro prévio (mesmo padrão de
 * `document_items` — vínculo pendente é informação, não bloqueio).
 *
 * Idempotente por reexecução: usa upsert por chave natural onde existe, e
 * apaga+recria a NF-e de teste pelo `content_hash` fixo — reexecutar local
 * sem `supabase db reset` não duplica dado.
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";

import {
  E2E_DECISION_TEXT,
  E2E_GESTOR_EMAIL,
  E2E_GESTOR_PASSWORD,
  E2E_LISTINGS,
  E2E_LISTING_DECISION_TEXT,
  E2E_LISTING_FULL,
  E2E_LISTING_PRICE_EVENT,
  E2E_LISTING_RELIST,
  E2E_LISTING_TRAFFIC,
  E2E_SKU_SALES,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./constants.js";
import { SEED_OUTPUT_PATH, type SeedOutput } from "./seed-output.js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORG_SLUG = "e2e-speed-bikers";
const SKU_CODE = "E2E-SKU-001";
const DOCUMENT_CONTENT_HASH = createHash("sha256").update("e2e-fixture-nfe").digest("hex");
const ML_ACCOUNT_SLUG = "e2e-loja";
const ML_ACCOUNT_LABEL = "Loja E2E";
const ML_SELLER_ID = 419_059_118;
const SUPPORT_OPEN_EXTERNAL_ID = "900001";
const SUPPORT_RESOLVED_EXTERNAL_ID = "900002";
const SUPPORT_RESOLVED_ITEM_ID = "MLB1623490410";
const SUPPORT_QUESTION_TEXT = "Esse bau serve na CB 500X 2023?";

function requireServiceRoleKey(): string {
  if (SERVICE_ROLE_KEY === undefined || SERVICE_ROLE_KEY === "") {
    throw new Error(
      "defina SUPABASE_SERVICE_ROLE_KEY (a chave local impressa por `supabase status`, nunca a de produção) antes de rodar o seed de E2E",
    );
  }

  return SERVICE_ROLE_KEY;
}

async function findUserIdByEmail(
  db: ReturnType<typeof createClient<Database>>,
  email: string,
): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const listed = await db.auth.admin.listUsers({ page, perPage: 200 });

    if (listed.error !== null) {
      throw listed.error;
    }

    const found = listed.data.users.find((candidate) => candidate.email === email);

    if (found !== undefined) {
      return found.id;
    }

    if (listed.data.users.length === 0) {
      break;
    }
  }

  return null;
}

/**
 * Cria (ou reaproveita) um usuário e garante que ele é membro da organização
 * com o papel pedido. Idempotente: o seed roda repetido no mesmo banco.
 */
async function garanteMembro(
  db: ReturnType<typeof createClient<Database>>,
  organizationId: string,
  quem: { email: string; password: string; fullName: string; role: "ADMIN" | "GESTOR" },
): Promise<string> {
  const existente = await findUserIdByEmail(db, quem.email);

  let userId: string;

  if (existente !== null) {
    const atualizado = await db.auth.admin.updateUserById(existente, { password: quem.password });

    if (atualizado.error !== null) {
      throw atualizado.error;
    }

    userId = existente;
  } else {
    const criado = await db.auth.admin.createUser({
      email: quem.email,
      password: quem.password,
      email_confirm: true,
    });

    if (criado.error !== null) {
      throw criado.error;
    }

    userId = criado.data.user.id;
  }

  const profile = await db.from("profiles").upsert({ id: userId, full_name: quem.fullName }, { onConflict: "id" });

  if (profile.error !== null) {
    throw profile.error;
  }

  const membership = await db.from("organization_members").upsert(
    { organization_id: organizationId, user_id: userId, role: quem.role },
    { onConflict: "organization_id,user_id" },
  );

  if (membership.error !== null) {
    throw membership.error;
  }

  return userId;
}

async function main(): Promise<void> {
  const db = createClient<Database>(SUPABASE_URL, requireServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const org = await db
    .from("organizations")
    .upsert({ name: "E2E Speed Bikers", slug: ORG_SLUG }, { onConflict: "slug" })
    .select("id")
    .single();

  if (org.error !== null) {
    throw org.error;
  }

  const organizationId = org.data.id;

  const userId = await garanteMembro(db, organizationId, {
    email: E2E_USER_EMAIL,
    password: E2E_USER_PASSWORD,
    fullName: "E2E",
    role: "ADMIN",
  });

  // O SEGUNDO membro (D-234), e ele é a PROVA de um defeito, não decoração.
  // Enquanto a organização tinha um membro só, ~25 telas liam
  // `organization_members` com `maybeSingle()` SEM filtrar por usuário e
  // funcionavam por acidente de cardinalidade. Com dois membros o PostgREST
  // devolve `PGRST116`, `data` vira nulo, e a tela diz "sem organização" para
  // o próprio ADMIN — ou seja, cadastrar o segundo usuário em `/usuarios`
  // quebrava o produto para todo mundo. Este usuário existe para que a suíte
  // fique VERMELHA se alguém reintroduzir a leitura sem filtro.
  await garanteMembro(db, organizationId, {
    email: E2E_GESTOR_EMAIL,
    password: E2E_GESTOR_PASSWORD,
    fullName: "E2E Gestor",
    role: "GESTOR",
  });

  const sku = await db
    .from("skus")
    .upsert(
      { organization_id: organizationId, sku: SKU_CODE, title: "Produto de teste E2E", kind: "PRODUTO" },
      { onConflict: "organization_id,sku_key" },
    )
    .select("id")
    .single();

  if (sku.error !== null) {
    throw sku.error;
  }

  const skuId = sku.data.id;

  const movementIdempotencyKey = `e2e:seed:${skuId}`;

  const existingMovement = await db
    .from("stock_movements")
    .select("id")
    .eq("idempotency_key", movementIdempotencyKey)
    .maybeSingle();

  if (existingMovement.error !== null) {
    throw existingMovement.error;
  }

  if (existingMovement.data === null) {
    const movement = await db.from("stock_movements").insert({
      organization_id: organizationId,
      sku_id: skuId,
      location_kind: "LOCAL",
      qty_delta: 50,
      movement_type: "ENTRADA_NFE",
      idempotency_key: movementIdempotencyKey,
      occurred_at: new Date().toISOString(),
    });

    if (movement.error !== null) {
      throw movement.error;
    }
  }

  const existingDocument = await db
    .from("documents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("content_hash", DOCUMENT_CONTENT_HASH)
    .maybeSingle();

  if (existingDocument.error !== null) {
    throw existingDocument.error;
  }

  let documentId: string;

  if (existingDocument.data !== null) {
    documentId = existingDocument.data.id;

    // Reexecução local: volta ao estado inicial (item sem vínculo) para o
    // teste de conferência poder rodar de novo do mesmo jeito.
    const reset = await db
      .from("documents")
      .update({ status: "PARSED", total_items: 1, resolved_items: 0 })
      .eq("id", documentId);

    if (reset.error !== null) {
      throw reset.error;
    }

    const deleteItems = await db.from("document_items").delete().eq("document_id", documentId);

    if (deleteItems.error !== null) {
      throw deleteItems.error;
    }
  } else {
    const document = await db
      .from("documents")
      .insert({
        organization_id: organizationId,
        status: "PARSED",
        storage_path: "e2e/fixture-nfe.xml",
        file_name: "fixture-nfe.xml",
        content_hash: DOCUMENT_CONTENT_HASH,
        document_type: "NFE",
        document_number: "E2E-1",
        total_items: 1,
        resolved_items: 0,
        parsed_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (document.error !== null) {
      throw document.error;
    }

    documentId = document.data.id;
  }

  const item = await db
    .from("document_items")
    .insert({
      document_id: documentId,
      position: 0,
      supplier_code: "FORN-001",
      description: "Item de teste E2E",
      unit: "UN",
      quantity: 10,
      unit_value: 12.5,
      total_value: 125,
    })
    .select("id")
    .single();

  if (item.error !== null) {
    throw item.error;
  }

  // Conta Mercado Livre + Caixa de Entrada (D-090). `connected_at` é
  // obrigatório junto de `seller_id` quando o status é CONNECTED
  // (`ml_accounts_status_coherent`).
  const mlAccount = await db
    .from("ml_accounts")
    .upsert(
      {
        organization_id: organizationId,
        slug: ML_ACCOUNT_SLUG,
        label: ML_ACCOUNT_LABEL,
        status: "CONNECTED",
        seller_id: ML_SELLER_ID,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,slug" },
    )
    .select("id")
    .single();

  if (mlAccount.error !== null) {
    throw mlAccount.error;
  }

  const mlAccountId = mlAccount.data.id;
  const now = Date.now();

  const supportCases = await db
    .from("support_cases")
    .upsert(
      [
        {
          organization_id: organizationId,
          ml_account_id: mlAccountId,
          channel: "QUESTION",
          external_case_key: `question:${SUPPORT_OPEN_EXTERNAL_ID}`,
          external_case_id: SUPPORT_OPEN_EXTERNAL_ID,
          external_status: "UNANSWERED",
          internal_status: "NOVO",
          priority: "NORMAL",
          remote_reply_state: "ALLOWED",
          last_activity_at: new Date(now).toISOString(),
        },
        {
          organization_id: organizationId,
          ml_account_id: mlAccountId,
          channel: "QUESTION",
          external_case_key: `question:${SUPPORT_RESOLVED_EXTERNAL_ID}`,
          external_case_id: SUPPORT_RESOLVED_EXTERNAL_ID,
          external_status: "ANSWERED",
          internal_status: "RESOLVIDO",
          priority: "ALTA",
          remote_reply_state: "BLOCKED",
          last_activity_at: new Date(now - 3_600_000).toISOString(),
          resolved_at: new Date(now - 3_600_000).toISOString(),
        },
      ],
      { onConflict: "organization_id,ml_account_id,channel,external_case_key" },
    )
    .select("id, external_case_id");

  if (supportCases.error !== null) {
    throw supportCases.error;
  }

  const openCaseId = supportCases.data.find(
    (row) => row.external_case_id === SUPPORT_OPEN_EXTERNAL_ID,
  )?.id;
  const resolvedCaseId = supportCases.data.find(
    (row) => row.external_case_id === SUPPORT_RESOLVED_EXTERNAL_ID,
  )?.id;

  if (openCaseId === undefined || resolvedCaseId === undefined) {
    throw new Error("seed de atendimento não devolveu os dois cases");
  }

  // Os índices únicos de `support_case_links` são PARCIAIS, então `onConflict`
  // não os expressa com segurança (mesma razão de D-086) — apagar e recriar é
  // o caminho idempotente aqui.
  const clearLinks = await db
    .from("support_case_links")
    .delete()
    .in("support_case_id", [openCaseId, resolvedCaseId]);

  if (clearLinks.error !== null) {
    throw clearLinks.error;
  }

  // Transcript do case aberto (D-095): uma mensagem normal do cliente e uma
  // com conteúdo BANIDO. A segunda existe porque é a regra sutil — o Mercado
  // Livre devolve texto VAZIO em conteúdo banido, e a tela precisa dizer
  // "removido", não mostrar uma bolha em branco.
  const clearMessages = await db
    .from("support_messages")
    .delete()
    .eq("support_case_id", openCaseId);

  if (clearMessages.error !== null) {
    throw clearMessages.error;
  }

  const messages = await db.from("support_messages").insert([
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      support_case_id: openCaseId,
      external_message_key: `question:${SUPPORT_OPEN_EXTERNAL_ID}:question`,
      external_message_id: SUPPORT_OPEN_EXTERNAL_ID,
      direction: "INBOUND",
      sender_kind: "CUSTOMER",
      body: SUPPORT_QUESTION_TEXT,
      body_state: "AVAILABLE",
      remote_status: "UNANSWERED",
      occurred_at: new Date(now - 7_200_000).toISOString(),
    },
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      support_case_id: openCaseId,
      external_message_key: `question:${SUPPORT_OPEN_EXTERNAL_ID}:banida`,
      external_message_id: null,
      direction: "INBOUND",
      sender_kind: "CUSTOMER",
      body: null,
      body_state: "BANNED",
      remote_status: "BANNED",
      occurred_at: new Date(now - 3_600_000).toISOString(),
    },
  ]);

  if (messages.error !== null) {
    throw messages.error;
  }

  const links = await db.from("support_case_links").insert([
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      support_case_id: openCaseId,
      sku_id: skuId,
      link_source: "LISTING_DERIVED",
    },
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      support_case_id: resolvedCaseId,
      external_entity_kind: "LISTING",
      external_entity_id: SUPPORT_RESOLVED_ITEM_ID,
      link_source: "REMOTE",
    },
  ]);

  if (links.error !== null) {
    throw links.error;
  }

  // Vendas do SKU (aba Vendas, D-227): duas linhas do recálculo diário, na
  // MESMA conta e no MESMO grão da tabela real (`unique nulls not distinct
  // (ml_account_id, sku_id, metric_date)`), para o e2e provar que o total, a
  // linha por conta e as linhas por dia saem do banco já somados. Upsert pela
  // chave do grão: rodar o seed duas vezes não duplica venda.
  const salesRows = E2E_SKU_SALES.map((venda) => ({
    organization_id: organizationId,
    ml_account_id: mlAccountId,
    sku_id: skuId,
    metric_date: new Date(Date.now() - venda.daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    units_sold: venda.units,
    gross_revenue: venda.revenue,
    orders_count: venda.orders,
    purchases_count: venda.purchases,
  }));

  const sales = await db
    .from("daily_sku_metrics")
    .upsert(salesRows, { onConflict: "ml_account_id,sku_id,metric_date" });

  if (sales.error !== null) {
    throw sales.error;
  }

  // O MESMO recálculo no grão de CONTA. `/vendas` lê `daily_account_metrics`
  // quando não há filtro de marca (`get_sales_summary`, `get_sales_daily_series`)
  // e, sem estas linhas, a tela renderizava "Nenhuma métrica calculada para
  // este período" em todo teste e em toda captura — a faixa de KPIs e o gráfico,
  // que são a composição principal do frame, nunca eram exercitados. A conta
  // tem um SKU só, então as linhas são as mesmas: o total da conta É o do SKU.
  const accountRows = salesRows.map((linha) => ({
    organization_id: linha.organization_id,
    ml_account_id: linha.ml_account_id,
    metric_date: linha.metric_date,
    units_sold: linha.units_sold,
    gross_revenue: linha.gross_revenue,
    orders_count: linha.orders_count,
    purchases_count: linha.purchases_count,
  }));

  const accountSales = await db
    .from("daily_account_metrics")
    .upsert(accountRows, { onConflict: "ml_account_id,metric_date" });

  if (accountSales.error !== null) {
    throw accountSales.error;
  }

  // Memória de decisões (aba Decisões, D-228): UMA ação do SKU, UMA decisão
  // com baseline e UMA medição (7 dias) — o e2e prova o lado a lado e as
  // janelas ainda sem medição. A ação entra pela chave estável (`dedup_key`);
  // a decisão só se ainda não existe (não há chave natural); o outcome pela
  // unique (decisão, janela). Rodar o seed duas vezes não duplica nada.
  const action = await db
    .from("actions")
    .upsert(
      {
        organization_id: organizationId,
        kind: "venda_anomala",
        severity: "alta",
        confidence: "alta",
        estimated_impact_brl: 900,
        sku_id: skuId,
        evidence: {
          direcao: "queda",
          evidencias: [{ tipo: "vendas", descricao: "Vendeu 2 nos últimos 7 dias contra baseline de 9." }],
          causas_candidatas: [],
        },
        recommendation: "Revisar preço e estoque antes de repor.",
        status: "novo",
        created_by: "system",
        dedup_key: `e2e:seed:venda_anomala:${skuId}`,
      },
      { onConflict: "organization_id,dedup_key" },
    )
    .select("id")
    .single();

  if (action.error !== null) {
    throw action.error;
  }

  const existingDecision = await db
    .from("action_decisions")
    .select("id")
    .eq("action_id", action.data.id)
    .maybeSingle();

  if (existingDecision.error !== null) {
    throw existingDecision.error;
  }

  let decisionId: string;

  if (existingDecision.data === null) {
    const decision = await db
      .from("action_decisions")
      .insert({
        organization_id: organizationId,
        action_id: action.data.id,
        decision: E2E_DECISION_TEXT,
        baseline_snapshot: {
          as_of: "2026-08-25",
          units_sold_7d: 2,
          avg_daily_units_7d: 0.29,
          avg_price_7d: 100,
          stock_local: 50,
        },
        created_by: userId,
      })
      .select("id")
      .single();

    if (decision.error !== null) {
      throw decision.error;
    }

    decisionId = decision.data.id;
  } else {
    decisionId = existingDecision.data.id;
  }

  const outcome = await db.from("action_outcomes").upsert(
    {
      organization_id: organizationId,
      action_decision_id: decisionId,
      window_days: 7,
      outcome_snapshot: {
        as_of: "2026-09-01",
        units_sold_7d: 5,
        avg_daily_units_7d: 0.71,
        avg_price_7d: 100,
        stock_local: 45,
      },
    },
    { onConflict: "action_decision_id,window_days" },
  );

  if (outcome.error !== null) {
    throw outcome.error;
  }

  // ------------------------------------------------------------------
  // Anúncios (D-242). O seed não criava nenhum, então `/anuncios` nunca teve
  // e2e: depois de um `db reset` a tela ficava vazia. Os quatro cobrem os
  // quatro estados que a faixa de resumo conta — ver `E2E_LISTINGS`.
  // ------------------------------------------------------------------
  const listings = await db.from("listings").upsert(
    E2E_LISTINGS.map((anuncio) => ({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      item_id: anuncio.itemId,
      title: anuncio.title,
      status: anuncio.status,
      price: anuncio.price,
      currency_id: "BRL",
      available_quantity: anuncio.available,
      // Vínculo DIRETO só no primeiro. O de variação mora em
      // `sku_listing_links` e deixa esta coluna nula de propósito (D-122).
      sku_id: anuncio.vinculo === "sku" ? skuId : null,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "ml_account_id,item_id" },
  );

  if (listings.error !== null) {
    throw listings.error;
  }

  // Full DO ANÚNCIO (D-243): UM snapshot, só para o primeiro anúncio. Os outros
  // três ficam sem snapshot de propósito — é o que prova na tela que ausência
  // de snapshot vira "—" e não "0" (D-067), e que a célula "No Full" conta
  // exatamente um. `inventory_id` é o id do Mercado Livre; no fixture é uma
  // chave estável derivada do MLB.
  // Existe-então-insere, não upsert: `service_role` tem INSERT mas não UPDATE
  // nesta tabela (o snapshot é imutável por desenho — quem escreve é o job de
  // Full, e ele só acrescenta). Rodar o seed duas vezes não duplica.
  const fullExistente = await db
    .from("fulfillment_stock_snapshots")
    .select("id")
    .eq("ml_account_id", mlAccountId)
    .eq("inventory_id", `INV-${E2E_LISTING_TRAFFIC.itemId}`)
    .limit(1)
    .maybeSingle();

  if (fullExistente.error !== null) {
    throw fullExistente.error;
  }

  if (fullExistente.data === null) {
    const fullSnapshot = await db.from("fulfillment_stock_snapshots").insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      inventory_id: `INV-${E2E_LISTING_TRAFFIC.itemId}`,
      item_id: E2E_LISTING_TRAFFIC.itemId,
      sku_id: skuId,
      quantity: E2E_LISTING_FULL,
      captured_at: new Date().toISOString(),
    });

    if (fullSnapshot.error !== null) {
      throw fullSnapshot.error;
    }
  }

  const porVariacao = E2E_LISTINGS.find((anuncio) => anuncio.vinculo === "variacao");

  if (porVariacao !== undefined) {
    const VARIATION_ID = "123456789";

    // Existe-então-insere em vez de upsert: a unicidade é um índice PARCIAL
    // (`where ref_kind = 'ITEM' and variation_id is not null`) e o `on_conflict`
    // do PostgREST não o alcança. Mesmo caminho do movimento de estoque acima.
    const linkExistente = await db
      .from("sku_listing_links")
      .select("id")
      .eq("ml_account_id", mlAccountId)
      .eq("item_id", porVariacao.itemId)
      .eq("variation_id", VARIATION_ID)
      .maybeSingle();

    if (linkExistente.error !== null) {
      throw linkExistente.error;
    }

    if (linkExistente.data === null) {
      const link = await db.from("sku_listing_links").insert({
        organization_id: organizationId,
        ml_account_id: mlAccountId,
        ref_kind: "ITEM",
        item_id: porVariacao.itemId,
        variation_id: VARIATION_ID,
        sku_id: skuId,
        source: "MANUAL",
      });

      if (link.error !== null) {
        throw link.error;
      }
    }
  }

  const diaTrafego = new Date(Date.now() - E2E_LISTING_TRAFFIC.daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const visitas = await db.from("daily_listing_visits").upsert(
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      item_id: E2E_LISTING_TRAFFIC.itemId,
      metric_date: diaTrafego,
      visits: E2E_LISTING_TRAFFIC.visits,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "ml_account_id,item_id,metric_date" },
  );

  if (visitas.error !== null) {
    throw visitas.error;
  }

  const metricasAnuncio = await db.from("daily_listing_metrics").upsert(
    {
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      mlb_id: E2E_LISTING_TRAFFIC.itemId,
      metric_date: diaTrafego,
      units_sold: E2E_LISTING_TRAFFIC.units,
      gross_revenue: E2E_LISTING_TRAFFIC.revenue,
      orders_count: E2E_LISTING_TRAFFIC.orders,
      purchases_count: E2E_LISTING_TRAFFIC.orders,
    },
    { onConflict: "ml_account_id,mlb_id,variation_id,metric_date" },
  );

  if (metricasAnuncio.error !== null) {
    throw metricasAnuncio.error;
  }

  // ------------------------------------------------------------------
  // O Dashboard do Anúncio (D13) tem abas de Preço, Histórico e Decisões que
  // só existem se houver EVENTO, REPUBLICAÇÃO e AÇÃO deste anúncio. O seed não
  // criava nenhum dos três: as abas nasceriam vazias, sem o que afirmar nem o
  // que capturar — a mesma lição de D-242 e da auditoria A1.
  // ------------------------------------------------------------------
  // Existe-então-insere, e não `upsert`: `service_role` tem INSERT em
  // `domain_events` mas NÃO tem UPDATE — a tabela é append-only por desenho, e
  // `upsert` é INSERT … ON CONFLICT DO UPDATE, que exige o privilégio que ela
  // deliberadamente nega. Um evento de domínio não se corrige: se estivesse
  // errado, o certo é um evento novo. A idempotência vem do `dedup_key`.
  const precoDedupKey = `e2e:seed:price:${E2E_LISTING_TRAFFIC.itemId}`;

  const precoExistente = await db
    .from("domain_events")
    .select("id")
    .eq("dedup_key", precoDedupKey)
    .maybeSingle();

  if (precoExistente.error !== null) {
    throw precoExistente.error;
  }

  if (precoExistente.data === null) {
    const precoEvento = await db.from("domain_events").insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      occurred_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      event_type: "listing.price.changed",
      entity_type: "listing",
      entity_id: E2E_LISTING_TRAFFIC.itemId,
      before: { price: E2E_LISTING_PRICE_EVENT.de },
      after: { price: E2E_LISTING_PRICE_EVENT.para },
      severity: "informativo",
      source: "sync",
      dedup_key: precoDedupKey,
    });

    if (precoEvento.error !== null) {
      throw precoEvento.error;
    }
  }

  // Uma republicação em estado terminal de FALHA — o estado que a tela precisa
  // mostrar bem (o motivo aparece na tabela) e o único que não exige inventar
  // um anúncio filho. Existe-então-insere: não há chave natural.
  const relistExistente = await db
    .from("listing_relists")
    .select("id")
    .eq("ml_account_id", mlAccountId)
    .eq("parent_item_id", E2E_LISTING_TRAFFIC.itemId)
    .maybeSingle();

  if (relistExistente.error !== null) {
    throw relistExistente.error;
  }

  if (relistExistente.data === null) {
    const relist = await db.from("listing_relists").insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      parent_item_id: E2E_LISTING_TRAFFIC.itemId,
      status: E2E_LISTING_RELIST.status,
      failure_reason: E2E_LISTING_RELIST.failureReason,
      requested_by: userId,
      // NOT NULL por contrato: o retrato do PAI no instante do pedido é o que
      // permite recriar o anúncio; sem ele não há republicação a auditar.
      parent_snapshot: {
        title: E2E_LISTINGS[0].title,
        price: E2E_LISTINGS[0].price,
        status: E2E_LISTINGS[0].status,
        available_quantity: E2E_LISTINGS[0].available,
      },
    });

    if (relist.error !== null) {
      throw relist.error;
    }
  }

  // A ação do seed já existe com `sku_id`; esta é a MESMA anomalia vista pelo
  // anúncio (`mlb_id`), que é como o Dashboard do Anúncio a encontra.
  const acaoDoAnuncio = await db
    .from("actions")
    .upsert(
      {
        organization_id: organizationId,
        kind: "venda_anomala",
        severity: "media",
        confidence: "media",
        ml_account_id: mlAccountId,
        mlb_id: E2E_LISTING_TRAFFIC.itemId,
        evidence: {
          direcao: "queda",
          evidencias: [{ tipo: "visitas", descricao: "Visitas caíram sem queda de preço." }],
          causas_candidatas: [],
        },
        recommendation: "Conferir se o anúncio perdeu exposição antes de mexer no preço.",
        status: "novo",
        created_by: "system",
        dedup_key: `e2e:seed:venda_anomala:${E2E_LISTING_TRAFFIC.itemId}`,
      },
      { onConflict: "organization_id,dedup_key" },
    )
    .select("id")
    .single();

  if (acaoDoAnuncio.error !== null) {
    throw acaoDoAnuncio.error;
  }

  // E uma DECISÃO sobre ela, para a aba Decisões do anúncio ter conteúdo.
  const decisaoExistente = await db
    .from("action_decisions")
    .select("id")
    .eq("action_id", acaoDoAnuncio.data.id)
    .maybeSingle();

  if (decisaoExistente.error !== null) {
    throw decisaoExistente.error;
  }

  if (decisaoExistente.data === null) {
    const decisao = await db.from("action_decisions").insert({
      organization_id: organizationId,
      action_id: acaoDoAnuncio.data.id,
      decision: E2E_LISTING_DECISION_TEXT,
      baseline_snapshot: { as_of: new Date().toISOString().slice(0, 10), units_sold_7d: 2, stock_local: 12 },
      created_by: userId,
    });

    if (decisao.error !== null) {
      throw decisao.error;
    }
  }

  const output: SeedOutput = {
    organizationId,
    userId,
    skuId,
    skuCode: SKU_CODE,
    documentId,
    documentItemId: item.data.id,
    mlAccountLabel: ML_ACCOUNT_LABEL,
    supportOpenExternalId: SUPPORT_OPEN_EXTERNAL_ID,
    supportResolvedExternalId: SUPPORT_RESOLVED_EXTERNAL_ID,
    supportResolvedItemId: SUPPORT_RESOLVED_ITEM_ID,
    supportQuestionText: SUPPORT_QUESTION_TEXT,
  };

  await mkdir(dirname(SEED_OUTPUT_PATH), { recursive: true });
  await writeFile(SEED_OUTPUT_PATH, JSON.stringify(output, null, 2));

  process.stdout.write(`seed de E2E ok: ${SEED_OUTPUT_PATH}\n`);
}

await main();
