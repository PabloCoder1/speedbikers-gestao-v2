-- Estoque virtual: o usuário confirmou em 2026-08-28 que os saldos altos do
-- UpSeller são DELIBERADOS — número alto para o anúncio não pausar, não erro
-- de exportação (D-127).
--
-- Isso muda a natureza do problema: não é dado sujo a limpar, é uma classe de
-- SKU cujo saldo NÃO responde "quanto eu tenho". Cobertura, sugestão de compra
-- e valor de estoque precisam saber a diferença.
--
-- POR QUE UMA COLUNA DE CONFIGURAÇÃO E NÃO UMA REGRA DERIVADA. Procurei um
-- sinal no dado e NÃO existe:
--   * `erp_stock_snapshots.warehouse` tem UM valor só ('ESTOQUE LOJA') — o
--     virtual não mora num armazém separado;
--   * o export não traz nenhuma coluna de marcação;
--   * a assinatura é visível (615 SKUs em 999, 254 em 998, 148 em 997...;
--     62 em 9.999, 34 em 9.998 — bases 1.000 e 10.000 corroídas por venda),
--     mas testei a hipótese "base menos vendas acumuladas" contra as vendas
--     reais e ela NÃO se sustenta: correlação 0,291 e só 165 de 2.172 SKUs
--     batendo exato. O vendedor reajusta o sentinela por fora.
--
-- Um limiar (">1.000 é virtual") classificaria errado tanto o SKU virtual já
-- bastante consumido quanto o SKU real de giro alto. Então a marcação é
-- HUMANA, com default `false` — nada é presumido, e a migration NÃO semeia
-- nenhuma linha.

alter table public.skus
  add column stock_is_virtual boolean not null default false;

comment on column public.skus.stock_is_virtual is
  'SKU cujo saldo no ERP e SENTINELA (numero alto para o anuncio nao pausar), nao contagem fisica (D-127). Marcado por gente: nao existe sinal no export nem regra derivavel das vendas (testado: correlacao 0,291). Cobertura e sugestao de compra NAO produzem numero para estes.';

-- `get_stock_coverage` passa a devolver a marca e a RECUSAR cobertura para
-- SKU virtual — `null` com motivo, nunca "2.000 dias", que seria uma resposta
-- errada com cara de precisa. `is_ruptura` idem: sem saldo confiavel, nao da
-- para afirmar ruptura.
drop function if exists public.get_stock_coverage(uuid, date, date, uuid);

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
  is_ruptura boolean,
  stock_is_virtual boolean
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
    sk.id,
    sk.sku,
    sk.title,
    coalesce(c.local_quantity, 0) as local_quantity,
    coalesce(c.units_sold, 0)::bigint as units_sold,
    round(coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0), 3) as avg_daily_sales,
    case
      when sk.stock_is_virtual then null
      when coalesce(c.units_sold, 0) = 0 then null
      else round(
        coalesce(c.local_quantity, 0)
        / (coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0)),
        1
      )
    end as days_of_coverage,
    (not sk.stock_is_virtual
       and coalesce(c.local_quantity, 0) <= 0
       and coalesce(c.units_sold, 0) > 0) as is_ruptura,
    sk.stock_is_virtual
  from combined c
  join public.skus sk on sk.id = c.sku_id
$$;

comment on function public.get_stock_coverage is
  'Cobertura em dias por SKU. Devolve NULL para SKU com stock_is_virtual (D-127): sem saldo fisico confiavel, "2.000 dias" seria resposta errada com cara de precisa. is_ruptura idem.';

revoke all on function public.get_stock_coverage(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid) to authenticated, service_role;
