-- Tendencia deterministica: as janelas entram na RPC, a CLASSIFICACAO no
-- dominio (D-145, Fase 5D).
--
-- ACHADO QUE PRECEDEU A FORMULA, e mudou a fatia: a primeira medicao de
-- limiares deu 86% dos SKUs "crescendo" -- artefato, nao tendencia. Junho
-- tinha 13 de 30 dias com metrica recomputada (1.903 unidades) com os
-- PEDIDOS COMPLETOS na tabela orders (23.025 pedidos, 30/30 dias): buraco de
-- RECALCULO, nao de dados. Reparado com rebuild_daily_sales_metrics
-- (idempotente, L3 e 100% recomputavel por desenho) para as 4 contas em
-- 2026-06-01..2026-08-29: junho foi de 1.903 para 21.224 unidades (11x
-- subcontado) e julho de 16.723 para 25.581 -- TODA tela de 90 dias lia
-- junho/julho errados ate 2026-08-30.
--
-- Pos-reparo, os limiares (+-25%, minimo 12 unidades/90d) produzem 239
-- crescendo / 174 caindo / 152 estavel -- corte com significado.
--
-- O que esta migration adiciona a get_stock_coverage:
--   * units_15d/30d/60d/90d -- janelas TRAILING encerradas em p_date_to,
--     independentes do periodo da tela (o PRD pede a analise das quatro);
--   * history_days_90 -- dias com metrica na organizacao dentro da janela.
--     E a guarda de HISTORICO_INCOMPLETO: se o buraco de recalculo voltar,
--     a tendencia SE RECUSA em vez de repetir o artefato.
--
-- A classificacao (classifySalesTrend) mora em @sb/domain/purchasing --
-- regra da formula unica. Definicao normativa em docs/METRICS.md secao 5D.
--
-- EXPLAIN (ANALYZE, BUFFERS): 94 ms, 12.742 buffers, 3.254 linhas na
-- organizacao inteira. Nenhum indice novo.

drop function public.get_stock_coverage(uuid, date, date, uuid);

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
  stock_is_virtual boolean,
  units_15d bigint,
  units_30d bigint,
  units_60d bigint,
  units_90d bigint,
  history_days_90 bigint
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
  trend_windows as (
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
    group by m.sku_id
  ),
  history as (
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
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
    sk.stock_is_virtual,
    coalesce(t.units_15d, 0),
    coalesce(t.units_30d, 0),
    coalesce(t.units_60d, 0),
    coalesce(t.units_90d, 0),
    h.history_days_90
  from combined c
  join public.skus sk on sk.id = c.sku_id
  left join trend_windows t on t.sku_id = c.sku_id
  cross join history h
$$;

comment on function public.get_stock_coverage(uuid, date, date, uuid) is
  'Cobertura de estoque local por SKU. Desde D-145 tambem devolve as quatro janelas de tendencia (15/30/60/90 dias TRAILING encerradas em p_date_to, independentes do periodo da tela) e history_days_90 (dias com metrica na organizacao dentro da janela de 90 -- a guarda contra classificar tendencia sobre historico furado, que foi exatamente o artefato encontrado em 2026-08-30: junho com 13 de 30 dias recomputados fazia 86% dos SKUs parecerem crescendo). A CLASSIFICACAO e feita em @sb/domain/purchasing (classifySalesTrend), nunca aqui -- regra da formula unica.';

revoke all on function public.get_stock_coverage(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid) to authenticated, service_role;
