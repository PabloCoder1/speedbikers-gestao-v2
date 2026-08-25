-- Simulador de cobertura de estoque (Fase 7, item 10, D-080,
-- docs/PRODUCT_REQUIREMENTS.md secao "Simulador de decisão").
--
-- `get_stock_coverage` (D-063-adjacent, 20260823175030) já é o motor que
-- `/cobertura` varre para TODOS os SKUs da organização de uma vez. O
-- simulador do Dashboard de SKU (`/skus/[skuId]`) precisa da venda média
-- diária REAL de UM SKU só, para pré-preencher a premissa que o usuário
-- pode então ajustar -- rodar a agregação inteira e filtrar em JavaScript
-- violaria docs/ARCHITECTURE.md secao 21 ("zero agregação em JS"). Mesmo
-- padrão já aplicado a `get_sku_sales_baseline` em D-078
-- (`20260825130000_add_sku_filter_to_sales_baseline.sql`): `p_sku_id`
-- opcional, default null, preserva o comportamento de todos os
-- chamadores existentes.
--
-- `drop function` explícito, não só `create or replace`: acrescentar um
-- parâmetro muda a ASSINATURA (uuid,date,date) -> (uuid,date,date,uuid) —
-- Postgres trataria isso como sobrecarga nova, deixando as duas versões
-- coexistindo no banco.
drop function if exists public.get_stock_coverage(uuid, date, date);

create function public.get_stock_coverage(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_sku_id uuid default null
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
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  stock as (
    select b.sku_id, b.quantity as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
      and (p_sku_id is null or b.sku_id = p_sku_id)
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
  'Cobertura (dias até esgotar, no ritmo do período) e ruptura (sem estoque local, mas com venda recente) por SKU. p_sku_id opcional (D-080, simulador do Dashboard de SKU): null varre todos os SKUs (uso de /cobertura, inalterado), preenchido filtra um só. "Vendas perdidas estimadas" fica de fora — sem evidência ainda para calibrar a regra de período de ruptura.';

revoke all on function public.get_stock_coverage(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid) to authenticated, service_role;
