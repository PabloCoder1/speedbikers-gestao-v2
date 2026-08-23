-- ============================================================
-- Cobertura e ruptura de estoque (Fase 5B, docs/ROADMAP.md) — primeira
-- fatia do item "Cobertura, ruptura, vendas perdidas estimadas".
--
-- Mesmo raciocínio de get_sales_summary (20260821190000): SQL faz a soma,
-- nunca a UI (docs/ARCHITECTURE.md secao 21, "Zero agregação em
-- JavaScript" — regra extraída de gargalo medido na V2). security invoker:
-- RLS de daily_sku_metrics/inventory_balances/skus já filtra as linhas
-- antes da soma, sem duplicar is_member_of aqui.
--
-- Escopo DELIBERADAMENTE menor que o item completo do checklist:
-- "vendas perdidas estimadas" fica de fora nesta fatia — exigiria detectar
-- PERÍODOS de ruptura no histórico do ledger (quando começou, quando
-- terminou) para multiplicar pela velocidade de venda de antes, sem
-- nenhum caso real ainda para calibrar essa regra (mesma evidência medida
-- de D-037/D-039/D-040/D-048/D-053/D-057/D-058). Cobertura e ruptura
-- (o "agora", não o histórico) já entregam valor sozinhos.
-- ============================================================

create function public.get_stock_coverage(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  local_quantity numeric,
  units_sold bigint,
  avg_daily_sales numeric,
  days_of_coverage numeric,
  is_ruptura boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with sales as (
    select m.sku_id, sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  stock as (
    select b.sku_id, b.quantity as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
  ),
  combined as (
    select coalesce(sales.sku_id, stock.sku_id) as sku_id, sales.units_sold, stock.local_quantity
    from sales
    full outer join stock on stock.sku_id = sales.sku_id
  )
  select
    sk.id as sku_id,
    sk.sku,
    sk.title,
    coalesce(c.local_quantity, 0) as local_quantity,
    coalesce(c.units_sold, 0)::bigint as units_sold,
    round(coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0), 3) as avg_daily_sales,
    case
      when coalesce(c.units_sold, 0) = 0 then null
      else round(
        coalesce(c.local_quantity, 0)
        / (coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0)),
        1
      )
    end as days_of_coverage,
    (coalesce(c.local_quantity, 0) <= 0 and coalesce(c.units_sold, 0) > 0) as is_ruptura
  from combined c
  join public.skus sk on sk.id = c.sku_id
$$;

comment on function public.get_stock_coverage is
  'Cobertura (dias até esgotar, no ritmo do período) e ruptura (sem estoque local, mas com venda recente) por SKU. "Vendas perdidas estimadas" fica de fora desta fatia — sem evidência ainda para calibrar a regra de período de ruptura.';

-- `revoke ... from public` não basta neste projeto (achado documentado em
-- link_document_item): `alter default privileges` concede EXECUTE a `anon`
-- em toda função nova do schema public.
revoke all on function public.get_stock_coverage(uuid, date, date) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date) to authenticated, service_role;
