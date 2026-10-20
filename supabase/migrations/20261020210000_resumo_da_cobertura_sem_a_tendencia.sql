-- ============================================================
-- D-615 -- o resumo de cobertura da Home sem a tendencia que ele nao usa
-- (pedido do A3: a "Atencao necessaria" da Home espera so esta leitura).
--
-- `get_stock_coverage_summary` contava quatro numeros por cima da
-- `get_stock_coverage` INTEIRA, que tambem calcula as janelas de 15, 30, 60
-- e 90 dias e a contagem de historico de 90 dias -- nada disso entra no
-- resumo. Medido em producao em 20/10, como `authenticated`, 30 dias: ~109
-- mil paginas tocadas em toda chamada (200-270 ms quente; ~2,5 s fria na
-- Home). O corpo so com o que o resumo usa -- a venda da janela, o saldo
-- LOCAL e o SKU -- toca ~6,6 mil.
--
-- A DEFINICAO NAO MUDA: as quatro contagens copiam as expressoes de
-- `get_stock_coverage` (D-058, D-235/D-237), provadas iguais no teste:
--   - total = os SKUs que vendem na janela ou tem saldo LOCAL;
--   - em_ruptura = `is_ruptura` (nao virtual, saldo <= 0, vendeu);
--   - virtuais = `stock_is_virtual`;
--   - sem_cobertura = `days_of_coverage` nulo e nao virtual (nao vendeu, ou
--     a janela de zero dias).
-- A assinatura e as colunas sao as de sempre: a Home nao muda. plpgsql com
-- plano custom, a licao de D-307.
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
  'Contagens de cobertura para a Home (D-058; marca desde D-237): total, em ruptura, virtuais e sem cobertura, com as expressoes de get_stock_coverage. D-615: corpo proprio, sem as janelas de tendencia e o historico que o resumo nao usa (~109 mil -> ~6,6 mil paginas em producao, 30 dias). plpgsql + force_custom_plan. security invoker.';
