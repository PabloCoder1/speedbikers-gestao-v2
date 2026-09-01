-- ============================================================
-- P0-H: o CTE que o Postgres decidiu NAO materializar (D-183).
--
-- MEDIDO no Dev em 2026-09-01, usuario autenticado real, duas passadas
-- quentes seguidas para descartar cache frio:
--
--   get_sku_sales_baseline(org, current_date)   1.334 ms e 1.367 ms
--                                               440 linhas, 4.136 buffers
--
-- 4 mil buffers e 1,3 segundo: o gasto era CPU, nao I/O. O plano mostrou
-- onde:
--
--   Nested Loop Left Join (actual time=69.128..1078.580 rows=440)
--     Rows Removed by Join Filter: 76865
--     ->  CTE Scan on daily_totals (rows=175 loops=440)
--           Filter: (metric_date = CURRENT_DATE)
--           Rows Removed by Filter: 31182
--
-- Tudo ANTES do join custava 70 ms. O `left join current_day` consumia o
-- segundo restante sozinho.
--
-- A CAUSA e uma regra do PostgreSQL 12+ que aqui funcionou ao contrario: um
-- CTE referenciado UMA vez e INLINE por padrao; referenciado duas ou mais,
-- e materializado. `daily_totals` e lido duas vezes, entao ja era
-- materializado (o plano confirma o HashAggregate). Mas `current_day` e
-- lido uma vez so — foi inlineado dentro do join, e o que era "175 linhas
-- calculadas uma vez" virou "re-filtrar as 31.357 linhas do CTE materializado
-- uma vez POR SKU": 440 loops x 31 mil linhas.
--
-- Nao e caso de indice: os dados ja estavam em memoria. E o inline de um CTE
-- barato dentro do lado interno de um nested loop.
--
-- Resultado, com equivalencia conferida por md5 do conjunto em CINCO formatos
-- de chamada (org inteira e SKU unico, hoje e datas passadas):
--
--   atual                              1.037 ms
--   so `current_day as materialized`     107 ms   (9,6x)
--   mais o filtro de dia da semana        44 ms   (23x)
-- ============================================================

create or replace function public.get_sku_sales_baseline(
  p_organization_id uuid,
  p_as_of date,
  p_sku_id uuid default null::uuid
)
returns table(
  sku_id uuid,
  sku text,
  title text,
  weekday smallint,
  current_units_sold bigint,
  baseline_mean numeric,
  baseline_stddev numeric,
  sample_count bigint
)
language sql
stable
set search_path to ''
as $function$
  with daily_totals as materialized (
    -- Soma ENTRE CONTAS por (sku_id, metric_date) antes de qualquer janela
    -- ou join -- sem isso, um SKU vendido em duas contas no mesmo dia conta
    -- como duas ocorrências em vez de uma.
    --
    -- D-183: o filtro de dia da semana desceu para cá. Antes ele vivia em
    -- `weekday_history`, o que obrigava o agregado a processar a história
    -- inteira (41.585 linhas) para no fim manter só as ocorrências de um dia
    -- da semana (6.617). `current_day` continua correto porque `p_as_of`
    -- trivialmente tem o mesmo dia da semana que ele próprio.
    select
      m.sku_id,
      m.metric_date,
      sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date <= p_as_of
      and extract(dow from m.metric_date) = extract(dow from p_as_of)
    group by m.sku_id, m.metric_date
  ),
  weekday_history as (
    select
      sku_id,
      units_sold,
      row_number() over (partition by sku_id order by metric_date desc) as recency_rank
    from daily_totals
    where metric_date < p_as_of
  ),
  baseline as (
    select
      sku_id,
      avg(units_sold) as baseline_mean,
      stddev_samp(units_sold) as baseline_stddev,
      count(*) as sample_count
    from weekday_history
    where recency_rank <= 8
    group by sku_id
  ),
  current_day as materialized (
    -- `as materialized` NAO e estilo: e a correcao. Sem ela, este CTE de 175
    -- linhas e inlineado no lado interno do `left join` abaixo e re-executado
    -- uma vez por SKU do resultado.
    select sku_id, units_sold
    from daily_totals
    where metric_date = p_as_of
  )
  select
    sk.id as sku_id,
    sk.sku,
    sk.title,
    extract(dow from p_as_of)::smallint as weekday,
    coalesce(cd.units_sold, 0)::bigint as current_units_sold,
    round(b.baseline_mean, 2) as baseline_mean,
    round(coalesce(b.baseline_stddev, 0), 2) as baseline_stddev,
    b.sample_count
  from baseline b
  join public.skus sk on sk.id = b.sku_id
  left join current_day cd on cd.sku_id = b.sku_id
  -- Amostra mínima de 4 ocorrências do mesmo dia da semana — abaixo disso o
  -- desvio padrão é ruído, não sinal (regra própria, sem referência externa;
  -- documentada em D-063 junto com o limiar de z-score usado na interpretação).
  where b.sample_count >= 4
$function$;

comment on function public.get_sku_sales_baseline(uuid, date, uuid) is
  'Baseline de vendas por dia da semana (D-063). D-183: `current_day` e materializado de proposito — inlineado, ele vira o lado interno de um nested loop e custa 23x mais.';

-- ------------------------------------------------------------
-- A prova
-- ------------------------------------------------------------
do $$
declare
  corpo text;
begin
  corpo := (select pg_get_functiondef(p.oid) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'get_sku_sales_baseline');

  -- As duas materializacoes precisam sobreviver a qualquer reescrita futura:
  -- sao elas que impedem o inline que custava o segundo.
  if corpo not like '%current_day as materialized%' then
    raise exception 'D-183: current_day precisa ser materializado — inlineado, custa 23x mais';
  end if;

  if corpo not like '%daily_totals as materialized%' then
    raise exception 'D-183: daily_totals precisa ser materializado';
  end if;

  -- A funcao continua SECURITY INVOKER: ela le `daily_sku_metrics` e `skus`
  -- sob a RLS de quem chama, e e assim que tem de ser.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_sku_sales_baseline' and p.prosecdef
  ) then
    raise exception 'D-183: get_sku_sales_baseline virou SECURITY DEFINER — nao deveria';
  end if;
end $$;
