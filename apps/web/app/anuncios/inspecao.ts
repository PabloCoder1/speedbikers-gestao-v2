"use server";

import { createClient } from "../../lib/supabase/server";

/**
 * O retrato da gaveta do ANÚNCIO (D39 — a terceira das cinco).
 *
 * ## O que ela mostra é justamente o que a linha NÃO tem
 *
 * A tabela de `/anuncios` já traz título, MLB, SKU, conta, estado, preço,
 * estoque, Full, unidades, faturamento, visitas e conversão. Uma gaveta que
 * repetisse isso seria a linha de novo, mais devagar. Ela lê três coisas que a
 * lista não carrega:
 *
 * 1. **frescor** — `synced_at`, hoje escondido no `title` do cursor;
 * 2. **o que aconteceu** — os últimos eventos de domínio DESTE anúncio
 *    (`entity_type = 'listing'`, `entity_id` = o MLB, como
 *    `packages/domain/src/events/listing-events.ts` grava);
 * 3. **republicação** — o estado do relist vivo ou do último tentado.
 *
 * As oito abas que o frame desenha dentro da gaveta continuam sendo
 * `/anuncios/[itemId]` (D13). A gaveta resume e aponta; não vira uma segunda
 * versão do dashboard.
 *
 * O filtro por `ml_account_id` acompanha o `item_id` porque MLB é único POR
 * CONTA (`listings_account_item_unique`), não por organização — ler só pelo
 * item_id misturaria contas no dia em que duas anunciarem o mesmo código.
 */

export interface ListingEventRow {
  id: string;
  occurredAt: string;
  eventType: string;
  severity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ListingInspection {
  syncedAt: string | null;
  relistStatus: string | null;
  relistFailureReason: string | null;
  relistChildItemId: string | null;
  relistAt: string | null;
  eventos: ListingEventRow[];
  error: string | null;
}

const VAZIO: ListingInspection = {
  syncedAt: null,
  relistStatus: null,
  relistFailureReason: null,
  relistChildItemId: null,
  relistAt: null,
  eventos: [],
  error: null,
};

const EVENTOS_NA_GAVETA = 5;

export async function inspecionarAnuncio(
  mlAccountId: string,
  itemId: string,
): Promise<ListingInspection> {
  const supabase = await createClient();

  const [listingResult, eventsResult, relistResult] = await Promise.all([
    supabase
      .from("listings")
      .select("synced_at")
      .eq("ml_account_id", mlAccountId)
      .eq("item_id", itemId)
      .maybeSingle(),
    supabase
      .from("domain_events")
      .select("id, occurred_at, event_type, severity, before, after")
      .eq("ml_account_id", mlAccountId)
      .eq("entity_type", "listing")
      .eq("entity_id", itemId)
      .order("occurred_at", { ascending: false })
      .limit(EVENTOS_NA_GAVETA),
    /*
      A republicação DESTE anúncio como PAI. Só leitura — a gaveta nunca
      dispara relist, que é ato com aprovação humana e mora na tela cheia.
      `listing_relists_one_live_per_parent` garante no máximo uma viva por pai;
      ordenar por `updated_at` pega a última quando as anteriores falharam.
    */
    supabase
      .from("listing_relists")
      .select("status, failure_reason, child_item_id, updated_at")
      .eq("ml_account_id", mlAccountId)
      .eq("parent_item_id", itemId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const erro = listingResult.error ?? eventsResult.error ?? relistResult.error;

  if (erro !== null) {
    return { ...VAZIO, error: "Não foi possível ler o retrato deste anúncio." };
  }

  const relist = relistResult.data;

  return {
    syncedAt: listingResult.data?.synced_at ?? null,
    relistStatus: relist?.status ?? null,
    relistFailureReason: relist?.failure_reason ?? null,
    relistChildItemId: relist?.child_item_id ?? null,
    relistAt: relist?.updated_at ?? null,
    eventos: (eventsResult.data ?? []).map((evento) => ({
      id: evento.id,
      occurredAt: evento.occurred_at,
      eventType: evento.event_type,
      severity: evento.severity,
      before: evento.before as Record<string, unknown> | null,
      after: evento.after as Record<string, unknown> | null,
    })),
    error: null,
  };
}
