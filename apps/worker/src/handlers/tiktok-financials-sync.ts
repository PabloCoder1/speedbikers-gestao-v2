import { tiktokFinancialsSyncPayloadSchema } from "@sb/contracts";
import {
  FINANCE_MAX_PAGE_SIZE,
  getOrderStatementTransactions,
  getStatementsPage,
  type TikTokStatement,
} from "@sb/tiktok-shop";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDoTikTok, lerLojaTikTokConectada, type TikTokJobDeps } from "./tiktok-comum.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { ensureTikTokAccessToken } from "./tiktok-token.js";

/**
 * Handler `tiktok.financials.sync` (D-834, `M04`):
 * - com `orderId`: busca transações liquidadas pontuais via
 *   `getOrderStatementTransactions` e persiste idempotentemente;
 * - sem `orderId`: pagina extratos dos últimos 30 dias via `getStatementsPage`
 *   com teto de páginas e persiste idempotentemente.
 */

const JANELA_EXTRATOS_S = 30 * 24 * 60 * 60;
const MAX_PAGINAS_EXTRATOS = 100;

export interface TikTokFinancialsSyncDeps extends Pick<TikTokJobDeps, "db" | "client" | "encryptionKey" | "now"> {
  repository: Pick<TikTokSyncRepository, "upsertOrderFinancials" | "upsertStatements">;
}

export function createTikTokFinancialsSyncHandler(deps: TikTokFinancialsSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = tiktokFinancialsSyncPayloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para tiktok.financials.sync" };
    }

    const aberta = await lerLojaTikTokConectada(deps, context, "tiktok_financials_sync_skipped", envelope.organizationId);

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const now = deps.now?.() ?? new Date();
    const token = await ensureTikTokAccessToken(deps, loja.id, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopCipher: token.shopCipher };

    try {
      if (parsed.data.orderId !== undefined) {
        const tx = await getOrderStatementTransactions(deps.client, shop, parsed.data.orderId);
        const saved = await deps.repository.upsertOrderFinancials(loja.organization_id, loja.id, parsed.data.orderId, tx);

        if (saved.error !== null) {
          return { status: "failed", retryable: true, reason: `falha ao gravar financeiro do pedido TikTok: ${saved.error}` };
        }

        return { status: "done", processed: 1 };
      }

      const nowS = Math.floor(now.getTime() / 1000);
      const fromS = Math.max(1, nowS - JANELA_EXTRATOS_S);
      const statements: TikTokStatement[] = [];
      let pageToken: string | undefined;
      let exhausted = false;

      for (let page = 0; page < MAX_PAGINAS_EXTRATOS; page += 1) {
        const res = await getStatementsPage(deps.client, shop, {
          pageSize: FINANCE_MAX_PAGE_SIZE,
          ...(pageToken === undefined ? {} : { pageToken }),
          statementTimeGe: fromS,
          statementTimeLt: nowS,
          sortField: "statement_time",
          sortOrder: "ASC",
        });

        statements.push(...res.statements);

        if (res.nextPageToken === null) {
          exhausted = true;
          break;
        }

        pageToken = res.nextPageToken;
      }

      if (!exhausted) {
        return {
          status: "failed",
          retryable: false,
          reason: `extratos financeiros do TikTok Shop excederam o teto de ${String(MAX_PAGINAS_EXTRATOS)} páginas`,
        };
      }

      if (statements.length === 0) {
        return { status: "done", processed: 0 };
      }

      const saved = await deps.repository.upsertStatements(loja.organization_id, loja.id, statements);

      if (saved.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar extratos TikTok: ${saved.error}` };
      }

      return { status: "done", processed: statements.length };
    } catch (error) {
      return falhaDoTikTok(error, "erro ao sincronizar financeiro do TikTok Shop");
    }
  };
}
