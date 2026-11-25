import { TIKTOK_JOB_TYPES } from "@sb/contracts";
import type { AdminClient } from "@sb/db";
import { createTikTokShopClient } from "@sb/tiktok-shop";

import type { Enqueuer } from "../enqueue.js";
import type { Env } from "../env.js";
import type { JobHandler } from "../router.js";
import { createTikTokFinancialsSyncHandler } from "./tiktok-financials-sync.js";
import { createTikTokItemsSyncHandler } from "./tiktok-items-sync.js";
import { createTikTokOrderFetchHandler, createTikTokOrdersSyncHandler } from "./tiktok-orders-sync.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { createTikTokReturnsSyncHandler } from "./tiktok-returns-sync.js";

/**
 * Montagem condicional dos 5 handlers do TikTok Shop no worker (D-835, `M04`),
 * espelhando o interruptor da Shopee em `apps/worker/src/index.ts`.
 *
 * Sem `TIKTOK_SHOP_APP_KEY`/`TIKTOK_SHOP_APP_SECRET` ou sem adaptador de
 * repositório das tabelas transacionais, devolve `{}` sem afetar o boot.
 */

export interface TikTokWorkerBootstrapDeps {
  env: Pick<Env, "TIKTOK_SHOP_APP_KEY" | "TIKTOK_SHOP_APP_SECRET">;
  db: AdminClient;
  enqueuer: Enqueuer;
  encryptionKey: Buffer;
  repository?: TikTokSyncRepository;
}

export function createTikTokWorkerHandlers(deps: TikTokWorkerBootstrapDeps): Record<string, JobHandler> {
  const { TIKTOK_SHOP_APP_KEY: appKey, TIKTOK_SHOP_APP_SECRET: appSecret } = deps.env;

  if (appKey === undefined || appSecret === undefined || deps.repository === undefined) {
    return {};
  }

  const client = createTikTokShopClient({ appKey, appSecret });
  const shared = {
    db: deps.db,
    client,
    encryptionKey: deps.encryptionKey,
    enqueuer: deps.enqueuer,
    repository: deps.repository,
  };

  return {
    [TIKTOK_JOB_TYPES.ordersSync]: createTikTokOrdersSyncHandler(shared),
    [TIKTOK_JOB_TYPES.orderFetch]: createTikTokOrderFetchHandler(shared),
    [TIKTOK_JOB_TYPES.itemsSync]: createTikTokItemsSyncHandler(shared),
    [TIKTOK_JOB_TYPES.returnsSync]: createTikTokReturnsSyncHandler(shared),
    [TIKTOK_JOB_TYPES.financialsSync]: createTikTokFinancialsSyncHandler(shared),
  };
}
