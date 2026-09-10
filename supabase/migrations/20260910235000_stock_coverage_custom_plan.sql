-- ============================================================
-- A varredura das 19 achou UMA doente, e ela e a pior das tres (D-307).
--
-- `get_stock_coverage` custava **27 segundos** contra um teto de 8 s para
-- `authenticated`. Nao as vezes: nas quatro execucoes medidas, 27.103,
-- 26.987, 26.675 e 28.016 ms. Nao e cache frio -- e o estado normal dela.
--
-- ------------------------------------------------------------
-- POR QUE NINGUEM TINHA VISTO
-- ------------------------------------------------------------
--
-- `pg_stat_statements` mostrava **89 ms de media e 1.425 ms de pior caso**, e
-- por isso ela nem estava na lista de suspeitas de D-305. Duas razoes:
--
-- 1. **as chamadas de tela passam `p_sku_id`** (o cartao "Cobertura" do
--    dashboard de SKU e `apps/web/app/produtos/inspecao.ts`), e com UM SKU a
--    funcao e barata;
-- 2. a unica chamada SEM `p_sku_id` vem de `get_stock_coverage_summary`, que
--    a chama com 3 argumentos -- e as **3 chamadas** registradas dela sao de
--    **2026-09-01**, quando a base era menor. Nove dias sem ninguem abrir a
--    tela que a usa.
--
-- **A tela que a usa e a INICIAL** (`apps/web/app/page.tsx`, cartao "SKUs sem
-- saldo local"). Ou seja: isto nao era um defeito ativo sendo tolerado, era um
-- defeito **armado** -- o proximo carregamento da Home o encontraria.
--
-- Medido, ja com a doenca instalada:
--
--     get_stock_coverage         (sem p_sku_id)   26.675 a 28.016 ms
--     get_stock_coverage_summary                  27.154 a 28.272 ms
--     get_stock_coverage_summary (com marca)      estoura igual -- a interna
--                                                 e chamada com 3 argumentos
--                                                 e o filtro so vem depois
--
-- ------------------------------------------------------------
-- E A MESMA CAUSA DE D-305, CONFERIDA DO MESMO JEITO
-- ------------------------------------------------------------
--
-- O corpo, com os mesmos valores como literais, roda em **19 ms**. A funcao,
-- 27.000. Mil e quatrocentas vezes. Corpo rapido + funcao lenta = e o PLANO,
-- nao o SQL: no PostgreSQL 17 o corpo de uma funcao `language sql` e
-- planejado uma vez **sem os valores dos argumentos**, e funcao com clausula
-- `SET` nunca e inlined.
--
-- A cura e a de D-305, e o resultado foi conferido linha a linha:
--
--     md5 das 3.259 linhas, funcao atual x nova     IDENTICO
--     tempo, 6 execucoes seguidas    49, 49, 50, 49, 49, 49 ms
--
-- **27.000 ms -> 49 ms.** Sem degradacao na sexta.
--
-- ------------------------------------------------------------
-- O QUE NAO MUDA
-- ------------------------------------------------------------
--
-- Assinatura, os 5 argumentos na ordem (incluindo `p_supplier_brand` por
-- ULTIMO, que e o que mantem valida a chamada posicional de 3 argumentos de
-- `get_stock_coverage_summary`), tipo de retorno, `security invoker`,
-- `search_path = ''`, `stable`, e o SQL do corpo -- extraido do arquivo de
-- `20260903213000_stock_coverage_supplier_brand.sql`.
--
-- **Nenhuma alteracao textual foi necessaria**, diferente de D-305: aqui todas
-- as referencias ja estavam qualificadas, inclusive as do CTE `combined`
-- (`sales.units_sold`, `stock.local_quantity`), que sao os nomes que colidiriam
-- com as variaveis de `returns table`. O padrao `variable_conflict = error`
-- fica, entao colisao futura falha alto.
--
-- `get_stock_coverage_summary` NAO precisou mudar: ela e um agregado sobre
-- esta funcao, e herda o plano custom da interna.
--
-- ------------------------------------------------------------
-- O RESTO DA VARREDURA: 16 SAUDAVEIS, e vale dizer quais
-- ------------------------------------------------------------
--
-- Todas medidas como `authenticated` real, 6 a 8 execucoes seguidas. Estado
-- estavel:
--
--   get_purchase_state_counts     778-986 ms     get_stock_movements   148-149 ms
--   get_purchase_suggestions      771-1200 ms    get_sales_margin_summary  88-93 ms
--   get_stock_movements_summary   418-430 ms     get_sku_sales_baseline    50-53 ms
--   get_link_integrity            251-389 ms     get_sku_timeline          48-50 ms
--   get_sku_abc_curve             224-297 ms     get_unlinked_listings     31-33 ms
--   get_fulfillment_overview      100-103 ms     get_sales_today_summary   18-31 ms
--   get_stock_balances             14-15 ms      get_sales_summary            2 ms
--   get_system_health                  1 ms      get_sales_daily_series       1 ms
--
-- Nenhuma perto do teto. As duas de ~800 ms a 1,2 s (`get_purchase_state_counts`
-- e `get_purchase_suggestions`, as duas de `/reposicao`) ficam ANOTADAS e nao
-- consertadas: 1,2 s e folgado contra 8 s, e nao ha defeito medido nelas --
-- so custo. Consertar sem defeito e o erro que D-306 registrou.
--
-- `compute_erp_target_balances` e `compute_inventory_balances_from_ledger`
-- saem da conta: **`authenticated` nao as executa** (permission denied). Sao
-- caminho de `service_role`, nao de tela.
-- ============================================================

create or replace function public.get_stock_coverage(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_sku_id uuid default null,
  -- ULTIMO de proposito: mantem valida a chamada posicional de 3 argumentos
  -- que `get_stock_coverage_summary` faz.
  p_supplier_brand text default null
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
language plpgsql
stable
security invoker
set search_path = ''
-- A linha que troca 27.000 ms por 49 ms (D-307). Ver o cabecalho: sem ela, o
-- corpo e planejado sem os valores dos argumentos e o plano generico erra.
set plan_cache_mode = 'force_custom_plan'
as $fn$
begin
  return query
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
    -- SEM filtro de marca, de proposito: esta contagem e sobre o pipeline de
    -- metricas da ORGANIZACAO, e e o que sustenta a recusa
    -- HISTORICO_INCOMPLETO de D-145.
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
    -- `sales.` e `stock.` QUALIFICADOS: sao os nomes que colidiriam com as
    -- variaveis homonimas de `returns table` num corpo plpgsql (D-305).
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
  -- Forma da casa: `sk` ja estava juntado, entao o filtro cai aqui e nao
  -- precisa de join novo (diferente de `get_sku_abc_curve`, D-235).
  where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand);
end;
$fn$;

comment on function public.get_stock_coverage(uuid, date, date, uuid, text) is
  'Cobertura e ruptura por SKU (D-058), com janelas de venda 15/30/60/90 dias e recorte de marca (D-235/D-237). p_supplier_brand entra por ULTIMO para manter valida a chamada posicional de 3 argumentos de get_stock_coverage_summary. history_days_90 NAO leva recorte de marca: e o pipeline de metricas da organizacao, e sustenta a recusa HISTORICO_INCOMPLETO de D-145. plpgsql + force_custom_plan desde D-307: em language sql o corpo era planejado sem os valores dos argumentos e a chamada SEM p_sku_id custava 27 s contra 19 ms do mesmo SQL com literais -- e e essa a chamada que a tela inicial faz, via get_stock_coverage_summary. security invoker.';

revoke all on function public.get_stock_coverage(uuid, date, date, uuid, text) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid, text) to authenticated, service_role;
