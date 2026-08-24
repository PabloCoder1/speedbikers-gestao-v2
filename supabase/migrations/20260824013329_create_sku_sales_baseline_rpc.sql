-- Diagnóstico e Central de Ações (Fase 6, docs/ARCHITECTURE.md secao 16) —
-- primeira peça: "Baseline, desvio e detecção estatística sem machine
-- learning". Pipeline determinístico, IA nunca no meio (só narraria no fim,
-- Fase 7, fora de escopo aqui).
--
-- Método (dos três aprovados em ARCHITECTURE.md §16: "média móvel, desvio
-- padrão e comparação com o mesmo dia da semana anterior"): os três viram
-- UM método só — baseline é média + desvio padrão calculados SOBRE O MESMO
-- DIA DA SEMANA (últimas 8 ocorrências), não sobre dias corridos. Isso
-- controla sazonalidade semanal automaticamente (sábado nunca é comparado
-- contra terça), sem precisar reconciliar três sinais separados.
--
-- SQL só agrega (docs/ARCHITECTURE.md secao 21/15: zero agregação em JS) —
-- a interpretação (é anomalia? qual a confiança?) vive em
-- @sb/domain/diagnostics, puro, testável sem banco.

create function public.get_sku_sales_baseline(
  p_organization_id uuid,
  p_as_of date
)
returns table (
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
security invoker
set search_path = ''
as $$
  with weekday_history as (
    select
      m.sku_id,
      m.units_sold,
      row_number() over (partition by m.sku_id order by m.metric_date desc) as recency_rank
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date < p_as_of
      and extract(dow from m.metric_date) = extract(dow from p_as_of)
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
  current_day as (
    select sku_id, units_sold
    from public.daily_sku_metrics
    where organization_id = p_organization_id
      and sku_id is not null
      and metric_date = p_as_of
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
$$;

comment on function public.get_sku_sales_baseline(uuid, date) is
  'Baseline de venda por SKU (Fase 6, D-063) — média e desvio padrão de units_sold no MESMO DIA DA SEMANA que p_as_of, últimas 8 ocorrências (controla sazonalidade semanal). Amostra mínima de 4 — abaixo disso o SKU nem aparece (desvio padrão não é confiável). A decisão de "é anomalia" NÃO vive aqui — é interpretação pura em @sb/domain/diagnostics, esta função só agrega (docs/ARCHITECTURE.md secao 21).';

revoke all on function public.get_sku_sales_baseline(uuid, date) from public, anon;
grant execute on function public.get_sku_sales_baseline(uuid, date) to authenticated, service_role;
