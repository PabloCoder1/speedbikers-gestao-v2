import type {
  ProjectedTikTokListingUnit,
  ProjectedTikTokOrder,
  ProjectedTikTokReturn,
} from "@sb/domain";
import type { TikTokOrderStatementTransaction, TikTokStatement } from "@sb/tiktok-shop";

/**
 * Contrato de persistência idempotente dos handlers do TikTok Shop (D-834, `M04`).
 *
 * Mantém a camada de orquestração dos 5 handlers do worker totalmente
 * implementada, tipada e testada sem depender das migrations das tabelas
 * transacionais (aguardando reativação do Supabase Dev em 01/12/2026).
 * Todos os métodos falham fechado devolvendo `{ error: string | null }`.
 */

export interface RepoResult {
  readonly error: string | null;
}

export interface RepoDataResult<T> {
  readonly data: T;
  readonly error: string | null;
}

export interface TikTokSyncRepository {
  acquireOrdersLock: (tiktokShopId: string, ttlSeconds: number) => Promise<RepoDataResult<boolean>>;
  releaseOrdersLock: (tiktokShopId: string) => Promise<RepoResult>;
  readOrdersCursor: (tiktokShopId: string) => Promise<RepoDataResult<string | null>>;
  advanceOrdersCursor: (tiktokShopId: string, syncedUntilIso: string) => Promise<RepoResult>;
  upsertOrders: (
    organizationId: string,
    tiktokShopId: string,
    orders: readonly ProjectedTikTokOrder[],
  ) => Promise<RepoResult>;
  upsertCatalogUnits: (
    organizationId: string,
    tiktokShopId: string,
    units: readonly ProjectedTikTokListingUnit[],
  ) => Promise<RepoResult>;
  upsertReturns: (
    organizationId: string,
    tiktokShopId: string,
    returns: readonly ProjectedTikTokReturn[],
  ) => Promise<RepoResult>;
  upsertOrderFinancials: (
    organizationId: string,
    tiktokShopId: string,
    orderId: string,
    transaction: TikTokOrderStatementTransaction,
  ) => Promise<RepoResult>;
  upsertStatements: (
    organizationId: string,
    tiktokShopId: string,
    statements: readonly TikTokStatement[],
  ) => Promise<RepoResult>;
}
