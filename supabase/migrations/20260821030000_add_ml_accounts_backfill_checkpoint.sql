-- ============================================================
-- Checkpoint do backfill de pedidos — Fase 3.
--
-- Backfill anda em pedacos (janelas de ~7 dias, `apps/worker/src/handlers/
-- backfill-orders.ts`) porque uma unica execucao nao percorre 12 meses de
-- historico dentro do timeout do worker. `backfill_covered_until` e o estado
-- ATUAL do progresso — L1, mutavel, igual a `ml_accounts.status`/
-- `connected_at` — e nao pertence a `sync_runs` (L2, historico append-only
-- de CADA execucao, nao de onde a proxima deve comecar).
--
-- NULL = backfill nunca comecou. Quando >= `connected_at`, o backfill
-- terminou: a reconciliacao por janela (`docs/MERCADO_LIVRE.md` secao 3) ja
-- cobre tudo dali em diante.
-- ============================================================

alter table public.ml_accounts
  add column backfill_covered_until timestamptz;

comment on column public.ml_accounts.backfill_covered_until is
  'Ate onde o backfill de pedidos ja cobriu (exclusivo). NULL = nao comecou. >= connected_at = concluido.';
