-- Ação contextual "O que aconteceu?" (Fase 7, item 8, docs/PRODUCT_REQUIREMENTS.md:
-- "KPIs, gráficos, produtos e contas relevantes poderão oferecer uma ação
-- contextual para investigar alteração ou queda").
--
-- `get_sku_sales_baseline` (D-063) já é o motor que `/diagnostico` varre
-- para TODOS os SKUs da organização de uma vez. A ação contextual precisa
-- do mesmo cálculo para UM SKU só, sob demanda, a partir do Dashboard de
-- SKU (`/skus/[skuId]`) -- rodar a agregação inteira e filtrar em
-- JavaScript violaria docs/ARCHITECTURE.md secao 21 ("zero agregação em
-- JS", "read model por tela"). `p_sku_id` opcional, default null: chamada
-- existente (sem o parâmetro) continua varrendo todos os SKUs, sem
-- mudança de comportamento.
--
-- `drop function` explícito, não só `create or replace`: acrescentar um
-- parâmetro muda a ASSINATURA (uuid,date) -> (uuid,date,uuid) — Postgres
-- trataria isso como sobrecarga nova, deixando as duas versões
-- coexistindo no banco (mesma pegadinha já resolvida em
-- 20260823163058_move_ledger_integrity_function_public.sql). Uma função
-- só, para não haver duas implementações da mesma fórmula divergindo com
-- o tempo.
drop function if exists public.get_sku_sales_baseline(uuid, date);

create function public.get_sku_sales_baseline(
  p_organization_id uuid,
  p_as_of date,
  p_sku_id uuid default null
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
      and (p_sku_id is null or m.sku_id = p_sku_id)
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
      and (p_sku_id is null or sku_id = p_sku_id)
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

comment on function public.get_sku_sales_baseline(uuid, date, uuid) is
  'Baseline de venda por SKU (D-063) — média e desvio padrão de units_sold no MESMO DIA DA SEMANA que p_as_of, últimas 8 ocorrências. p_sku_id opcional (D-078, "O que aconteceu?"): null varre todos os SKUs (uso de /diagnostico e do job de Central de Ações), preenchido filtra um só (uso da ação contextual). Amostra mínima de 4 — abaixo disso o SKU nem aparece.';

revoke all on function public.get_sku_sales_baseline(uuid, date, uuid) from public, anon;
grant execute on function public.get_sku_sales_baseline(uuid, date, uuid) to authenticated, service_role;
