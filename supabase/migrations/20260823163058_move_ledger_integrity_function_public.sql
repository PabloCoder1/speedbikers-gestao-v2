-- ============================================================
-- Move private.compute_inventory_balances_from_ledger para public (D-056,
-- docs/ROADMAP.md Fase 4: "Conferência automática ledger × projeção").
--
-- MESMO achado já documentado para compute_erp_snapshot_balances
-- (20260822193916_reconcile_balances.sql): `supabase/config.toml` expõe só
-- `schemas = ["public", "graphql_public"]` ao PostgREST, e o worker fala
-- com o Postgres via AdminClient (PostgREST), nunca conexão direta — uma
-- função em `private` é inalcançável dali, 404 na API, independente do
-- GRANT estar certo. Esta função nunca tinha sido chamada por código
-- nenhum até agora (só existia como base para o job de conferência que
-- ainda não existia) — não há nenhum caller a atualizar além do teste de
-- integração.
--
-- Segurança não depende do schema: o GRANT abaixo, restrito a
-- `service_role`, já impede `anon`/`authenticated` de qualquer forma.
-- ============================================================

drop function if exists private.compute_inventory_balances_from_ledger(uuid, uuid);

create function public.compute_inventory_balances_from_ledger(
  p_organization_id uuid,
  p_sku_id uuid default null
)
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
  select
    m.sku_id,
    m.location_kind,
    sum(m.qty_delta) as quantity
  from public.stock_movements m
  where m.organization_id = p_organization_id
    and (p_sku_id is null or m.sku_id = p_sku_id)
  group by m.sku_id, m.location_kind;
$$;

comment on function public.compute_inventory_balances_from_ledger is
  'Soma stock_movements do zero — o mesmo número que inventory_balances deveria ter. Divergência entre os dois é bug, nunca esperado (D-056).';

revoke all on function public.compute_inventory_balances_from_ledger(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.compute_inventory_balances_from_ledger(uuid, uuid)
  to service_role;
