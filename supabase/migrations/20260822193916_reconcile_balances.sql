-- ============================================================
-- Reconciliação de estoque contra o snapshot do UpSeller (D-029, D-054).
--
-- Fecha, na mesma implementação, dois itens do checklist da Fase 4
-- (docs/ROADMAP.md): "Reservado e em trânsito" e "Reconciliação contra o
-- snapshot do UpSeller" — RESERVADO não tem NENHUMA outra fonte de
-- movimento na V3 hoje (venda/cancelamento/NF-e são sempre LOCAL); esta
-- reconciliação é como ele nasce pela primeira vez. TRANSITO fica de fora
-- de propósito: as colunas de trânsito do UpSeller vêm zeradas em 100% do
-- export real (docs/UPSELLER.md secao 6) — depende de Pedidos de Compra
-- existir como fonte própria.
-- ============================================================

-- ============================================================
-- 1. domain_events.ml_account_id passa a aceitar NULL (D-054)
--
-- `stock.balance.diverged` é um evento ORGANIZACIONAL — estoque não
-- pertence a uma conta Mercado Livre (um SKU pode estar vinculado a
-- várias, ou nenhuma). Forçar uma conta "representativa" seria arbitrário
-- e enganoso. A policy de leitura ganha um segundo caminho: sem conta,
-- qualquer membro da organização vê (mesmo padrão de is_member_of já usado
-- em documents/stock_movements), com conta, continua exigindo
-- has_account_access como antes.
-- ============================================================

alter table public.domain_events alter column ml_account_id drop not null;

drop policy domain_events_select_permitted on public.domain_events;

create policy domain_events_select_permitted
  on public.domain_events for select to authenticated
  using (
    (ml_account_id is not null and private.has_account_access(ml_account_id))
    or (ml_account_id is null and private.is_member_of(organization_id))
  );

comment on column public.domain_events.ml_account_id is
  'Nulo para eventos organizacionais sem conta associada (ex.: stock.balance.diverged, D-054).';

-- Consulta "todos os eventos recentes da organização", independente de
-- conta — o `domain_events_account_timeline_idx` existente não serve para
-- linhas com ml_account_id nulo.
create index domain_events_org_timeline_idx
  on public.domain_events (organization_id, occurred_at desc);

-- ============================================================
-- 2. compute_erp_snapshot_balances — o snapshot mais recente do UpSeller,
--    decomposto em LOCAL (Disponível) e RESERVADO (Ocupado).
--
-- Mesma FORMA de private.compute_inventory_balances_from_ledger
-- (20260821200000_create_stock_ledger.sql): função SQL pura de leitura, a
-- comparação e a decisão de gerar ajuste ficam em @sb/domain
-- (computeReconciliationAdjustments), não aqui.
--
-- NO SCHEMA public, NÃO private — achado ao implementar o handler do
-- worker: `supabase/config.toml` expõe só `schemas = ["public",
-- "graphql_public"]` ao PostgREST. O worker fala com o Postgres através do
-- AdminClient (`@supabase/supabase-js`, via PostgREST), nunca por conexão
-- direta (`pg` é só devDependency de teste de integração,
-- `packages/db/src/rls.integration.test.ts`) — uma função em `private`,
-- por mais que o GRANT esteja correto, é simplesmente inalcançável dali,
-- 404 na API. `private.compute_inventory_balances_from_ledger` tem o
-- MESMO problema (nunca foi chamada por nenhum código ainda) — registrado
-- em docs/ROADMAP.md para quando o job de conferência ledger×projeção for
-- implementado. Segurança não depende do schema aqui: o GRANT restrito a
-- `service_role` (abaixo) já impede `anon`/`authenticated` de qualquer
-- forma, schema `public` ou não.
-- ============================================================

create function public.compute_erp_snapshot_balances(p_organization_id uuid)
returns table (
  sku_id uuid,
  location_kind text,
  quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    -- Snapshot mais recente por (sku_id, warehouse) — um lote reimportado
    -- não soma com o anterior, substitui. Só SKUs já resolvidos (sku_id
    -- not null): um saldo sem vínculo continua registrado em
    -- erp_stock_snapshots, mas não há contra o que reconciliar no ledger.
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.reserved
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  aggregated as (
    -- Soma entre armazéns: o ledger da V3 não distingue armazém do UpSeller
    -- (é um único "LOCAL"), mesmo raciocínio já aceito para inventory_balances.
    select sku_id, sum(available) as available, sum(reserved) as reserved
    from latest
    group by sku_id
  )
  select sku_id, 'LOCAL'::text as location_kind, available as quantity from aggregated
  union all
  select sku_id, 'RESERVADO'::text as location_kind, reserved as quantity from aggregated
$$;

comment on function public.compute_erp_snapshot_balances is
  'Snapshot mais recente do UpSeller por SKU, decomposto em LOCAL/RESERVADO. Fonte para o job de reconciliação (D-029) — TRANSITO fica de fora, ver comentário no topo da migration. Schema public por alcançabilidade via PostgREST, não por exposição — GRANT restrito a service_role.';

revoke all on function public.compute_erp_snapshot_balances(uuid)
  from public, anon, authenticated;
grant execute on function public.compute_erp_snapshot_balances(uuid)
  to service_role;
