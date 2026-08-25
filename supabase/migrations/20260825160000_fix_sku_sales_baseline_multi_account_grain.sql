-- Bug real encontrado ao confirmar o ciclo diário do Checkpoint pré-Fase 7
-- (D-081, docs/HANDOFF.md "Pendências técnicas imediatas"): o job
-- `diagnostics.detect-sales-anomalies` (Central de Ações, D-064) falhou em
-- 2026-08-25 com "ON CONFLICT DO UPDATE command cannot affect row a second
-- time" -- `get_sku_sales_baseline` (D-063) devolveu DUAS linhas para o
-- MESMO SKU no mesmo dia, cada uma gerando o mesmo `dedup_key` dentro do
-- mesmo upsert em lote.
--
-- Causa raiz: `daily_sku_metrics` tem grão POR CONTA
-- (`unique nulls not distinct (ml_account_id, sku_id, metric_date)`,
-- 20260821182620_create_daily_sales_metrics.sql). Um SKU vendido em DUAS
-- contas Mercado Livre no mesmo dia gera DUAS linhas na tabela. As CTEs
-- `weekday_history`/`current_day` desta função liam essas linhas SEM somar
-- entre contas primeiro -- o join contra `baseline` (já agrupado por
-- `sku_id`) multiplicava a saída, uma linha por conta em vez de uma por SKU.
--
-- SKU é organizacional (D-006) -- mesmo raciocínio já aplicado em toda outra
-- leitura de `daily_sku_metrics` do projeto (`get_stock_coverage`,
-- `get_sku_dashboard`, `get_sku_abc_curve` -- conferidas nesta sessão, todas
-- somam por `sku_id` antes de qualquer outra coisa). Esta função era a
-- única exceção, mascarada até uma venda multi-conta de verdade acontecer
-- (nenhum teste de RLS existente cobria duas contas para o mesmo SKU).
--
-- Efeito duplo do bug, não só o crash observado: `weekday_history` também
-- podia contar linhas de contas diferentes no MESMO `metric_date` como duas
-- ocorrências distintas na janela de "últimas 8 ocorrências", inflando a
-- amostra e distorcendo média/desvio padrão em silêncio -- corrigido pela
-- mesma soma prévia por `(sku_id, metric_date)`.
--
-- Mesma assinatura (uuid, date, uuid) -- `create or replace`, sem `drop`.
create or replace function public.get_sku_sales_baseline(
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
  with daily_totals as (
    -- Soma ENTRE CONTAS por (sku_id, metric_date) antes de qualquer janela
    -- ou join -- sem isso, um SKU vendido em duas contas no mesmo dia conta
    -- como duas ocorrências em vez de uma.
    select
      m.sku_id,
      m.metric_date,
      sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date <= p_as_of
    group by m.sku_id, m.metric_date
  ),
  weekday_history as (
    select
      sku_id,
      units_sold,
      row_number() over (partition by sku_id order by metric_date desc) as recency_rank
    from daily_totals
    where metric_date < p_as_of
      and extract(dow from metric_date) = extract(dow from p_as_of)
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
$$;

comment on function public.get_sku_sales_baseline(uuid, date, uuid) is
  'Baseline de venda por SKU (D-063) — média e desvio padrão de units_sold no MESMO DIA DA SEMANA que p_as_of, últimas 8 ocorrências, somado ENTRE CONTAS por (sku_id, metric_date) antes de rankear (D-081 — daily_sku_metrics tem grão por conta, SKU é organizacional). p_sku_id opcional (D-078): null varre todos os SKUs, preenchido filtra um só. Amostra mínima de 4 — abaixo disso o SKU nem aparece.';

revoke all on function public.get_sku_sales_baseline(uuid, date, uuid) from public, anon;
grant execute on function public.get_sku_sales_baseline(uuid, date, uuid) to authenticated, service_role;
