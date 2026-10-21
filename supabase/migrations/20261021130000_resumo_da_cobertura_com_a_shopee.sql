-- ============================================================
-- D-623 -- o resumo de cobertura da Home com a venda da Shopee.
--
-- A D-615 (20261020210000) deu ao resumo um corpo proprio, com as vendas
-- so do ML. Desde a D-459 (C-65, 15/10), get_stock_coverage soma o ML e a
-- Shopee. Em producao, com as lojas live, o resumo deixou de bater com a
-- contagem sobre get_stock_coverage logo depois de aplicado (21/10): o SKU
-- que vende so na Shopee saia do total e da ruptura e caia em "sem
-- cobertura". A suite de integracao da D-615 nao tinha venda da Shopee.
--
-- O corpo volta a ter as vendas de get_stock_coverage (ML + Shopee). A
-- assinatura e as colunas nao mudam.
-- ============================================================

create or replace function public.get_stock_coverage_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_supplier_brand text default null
)
returns table (
  total bigint,
  em_ruptura bigint,
  virtuais bigint,
  sem_cobertura bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
begin
  return query
  with sales_ml as (
    select m.sku_id, sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  -- D-623: a venda da Shopee, a MESMA leitura de get_stock_coverage (C-65,
  -- D-459): unidades dos itens de vendas VALIDAS das lojas LIVE, por SKU, no
  -- dia de Sao Paulo da janela. Sem ela, o SKU que vende so na Shopee saia
  -- do total e da ruptura e caia em "sem cobertura".
  sales_shopee as (
    select i.sku_id, sum(i.quantity)::bigint as units
    from public.shopee_sales_items i
    where i.organization_id = p_organization_id
      and i.environment = 'live'
      and i.situacao = 'VALIDA'
      and i.sku_id is not null
      and i.dia between p_date_from and p_date_to
    group by i.sku_id
  ),
  sales as (
    -- O total e o ML + a Shopee; um SKU so da Shopee tambem entra.
    select coalesce(m.sku_id, s.sku_id) as sku_id,
      coalesce(m.units_sold, 0) + coalesce(s.units, 0) as units_sold
    from sales_ml m
    full outer join sales_shopee s on s.sku_id = m.sku_id
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
    count(*)::bigint,
    count(*) filter (where not sk.stock_is_virtual
                       and coalesce(c.local_quantity, 0) <= 0
                       and coalesce(c.units_sold, 0) > 0)::bigint,
    count(*) filter (where sk.stock_is_virtual)::bigint,
    count(*) filter (where not sk.stock_is_virtual
                       and (coalesce(c.units_sold, 0) = 0 or p_date_to - p_date_from + 1 = 0))::bigint
  from combined c
  join public.skus sk on sk.id = c.sku_id
  where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand);
end;
$$;


comment on function public.get_stock_coverage_summary(uuid, date, date, text) is
  'Contagens de cobertura para a Home (D-058; marca desde D-237): total, em ruptura, virtuais e sem cobertura, com as expressoes de get_stock_coverage. D-615: corpo proprio, sem as janelas de tendencia e o historico que o resumo nao usa (~109 mil -> ~6,6 mil paginas em producao, 30 dias). D-623: as vendas sao ML + Shopee, como get_stock_coverage desde D-459. plpgsql + force_custom_plan. security invoker.';
