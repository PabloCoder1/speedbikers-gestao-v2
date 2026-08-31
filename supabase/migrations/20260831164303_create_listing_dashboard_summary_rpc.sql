-- ============================================================
-- Dashboard 360º do Anúncio (D-168, trilha 5E) — o read model do destino
-- individual que não existia: vendas + tráfego de UM anúncio, janela
-- declarada, métricas canônicas (soma das linhas do grão listing, o mesmo
-- caminho que D-123 provou equivalente a daily_account_metrics em R$ 0,00).
--
-- Conversão = pedidos ÷ visitas, NULL sem visita (nunca Infinity nem zero
-- fingido) — a convenção de D-059.
-- ============================================================

create function public.get_listing_dashboard_summary(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_item_id text,
  p_date_from date,
  p_date_to date
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  visits bigint,
  conversion numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with m as (
    select coalesce(sum(dm.units_sold), 0)::bigint as units,
           coalesce(round(sum(dm.gross_revenue), 2), 0) as revenue,
           coalesce(sum(dm.orders_count), 0)::bigint as orders
    from public.daily_listing_metrics dm
    where dm.organization_id = p_organization_id
      and dm.ml_account_id = p_ml_account_id
      and dm.mlb_id = p_item_id
      and dm.metric_date between p_date_from and p_date_to
  ),
  v as (
    select coalesce(sum(dv.visits), 0)::bigint as total_visits
    from public.daily_listing_visits dv
    where dv.organization_id = p_organization_id
      and dv.ml_account_id = p_ml_account_id
      and dv.item_id = p_item_id
      and dv.metric_date between p_date_from and p_date_to
  )
  select m.units, m.revenue, m.orders, v.total_visits,
         round(m.orders::numeric / nullif(v.total_visits, 0), 4) as conversion
  from m, v
$$;

comment on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) is
  'Resumo de vendas + tráfego de UM anúncio (D-168, Dashboard 360º): soma das linhas do grão listing (equivalência provada em D-123) + visitas, conversão NULL sem visita. security invoker: RLS filtra antes da soma.';

revoke all on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) from public, anon;
grant execute on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) to authenticated, service_role;
