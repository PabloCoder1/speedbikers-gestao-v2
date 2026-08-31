import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho da sincronização de visitas por anúncio (D-032) — chamado pelo
 * Cloud Scheduler, mesmo formato de `listings-schedule.ts`, mas por CONTA
 * (visita pertence a uma conta Mercado Livre específica) com cadência
 * DIÁRIA (não 6h): visita não é um dado operacional urgente como estoque —
 * `fetchListingVisits` já busca `last=3` dias a cada rodada, absorvendo uma
 * rodada diária perdida sem esperar até o dia seguinte.
 *
 * **As contas saem ESCALONADAS (D-171).** O Mercado Livre limita por
 * `client_id` + endpoint (`docs/MERCADO_LIVRE.md` secao 2.15), não por conta
 * — e até aqui TODA a defesa da casa era por conta: fila `ml-sync-<slug>`
 * própria e o espaçamento entre itens de D-156. Enfileirar as quatro contas
 * no mesmo instante fazia as quatro varreduras baterem no mesmo endpoint ao
 * mesmo tempo, somando ~12 req/s contra um teto que ~6 req/s respeita.
 */

/**
 * Distância entre o início de uma conta e o da seguinte.
 *
 * MEDIDO em produção (29–31/08/2026), não estimado: uma varredura completa
 * leva **196–328 s** e roda a **~3 req/s** — ritmo ditado pela latência do
 * próprio Mercado Livre (~330 ms por item), não pelo laço. Em 29/08 duas
 * contas rodaram sobrepostas por ~5,5 min (~6 req/s somados) e **as duas
 * completaram**; as quatro juntas (~12 req/s) falharam com 429 em todos os
 * dias medidos. O teto do endpoint está entre 6 e 12 req/s, e 600 s cobre a
 * varredura mais longa com folga suficiente para nenhuma sobrepor a outra.
 *
 * Se uma rodada estourar o offset, o pior caso é DUAS contas sobrepostas —
 * exatamente o cenário que 29/08 mostrou funcionando.
 */
const ACCOUNT_STAGGER_SECONDS = 600;

export interface ListingVisitsScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface ListingVisitsScheduleOutcome {
  accountsScanned: number;
  enqueued: number;
  deduplicated: number;
}

export async function triggerListingVisitsSnapshot(
  deps: ListingVisitsScheduleDeps,
): Promise<ListingVisitsScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const businessDate = toSalesMetricDate(now);

  const accounts = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("status", "CONNECTED");

  if (accounts.error !== null) {
    deps.logger.error("listing_visits_schedule_accounts_not_listed", { reason: accounts.error.message });

    return { accountsScanned: 0, enqueued: 0, deduplicated: 0 };
  }

  let enqueued = 0;
  let deduplicated = 0;

  // Ordem estável: a consulta acima não ordena, e um offset por índice sobre
  // ordem indefinida trocaria a conta de horário a cada rodada — o que
  // tornaria a própria medição do escalonamento ilegível.
  const ordered = [...accounts.data].sort((a, b) => a.slug.localeCompare(b.slug));

  for (const [index, account] of ordered.entries()) {
    const delaySeconds = index * ACCOUNT_STAGGER_SECONDS;

    const result = await deps.enqueuer.enqueue({
      jobType: "sync.listing-visits.snapshot",
      organizationId: account.organization_id,
      dedupeKey: `listing-visits:${account.slug}:${businessDate}`,
      queue: `ml-sync-${account.slug}`,
      payload: { mlAccountId: account.id },
      // A primeira conta sai idêntica a hoje: `enqueue.ts` testa
      // `=== undefined` para decidir se monta `scheduleTime`, e um zero
      // explícito produziria um agendamento onde antes não havia nenhum.
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    });

    if (result.deduplicated) {
      deduplicated += 1;
    } else {
      enqueued += 1;
    }
  }

  deps.logger.info("listing_visits_schedule_triggered", {
    accounts_scanned: accounts.data.length,
    enqueued,
    deduplicated,
  });

  return { accountsScanned: accounts.data.length, enqueued, deduplicated };
}
