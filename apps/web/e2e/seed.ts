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

import { E2E_SKU_SALES, E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";
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

  const existingUserId = await findUserIdByEmail(db, E2E_USER_EMAIL);

  let userId: string;

  if (existingUserId !== null) {
    const updated = await db.auth.admin.updateUserById(existingUserId, {
      password: E2E_USER_PASSWORD,
    });

    if (updated.error !== null) {
      throw updated.error;
    }

    userId = existingUserId;
  } else {
    const created = await db.auth.admin.createUser({
      email: E2E_USER_EMAIL,
      password: E2E_USER_PASSWORD,
      email_confirm: true,
    });

    if (created.error !== null) {
      throw created.error;
    }

    userId = created.data.user.id;
  }

  const profile = await db.from("profiles").upsert({ id: userId, full_name: "E2E" }, { onConflict: "id" });

  if (profile.error !== null) {
    throw profile.error;
  }

  const membership = await db.from("organization_members").upsert(
    { organization_id: organizationId, user_id: userId, role: "ADMIN" },
    { onConflict: "organization_id,user_id" },
  );

  if (membership.error !== null) {
    throw membership.error;
  }

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
