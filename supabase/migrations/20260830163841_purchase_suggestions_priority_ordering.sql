-- Priorizacao de compras (D-150, Fase 5D) -- camada de ORDENACAO, nunca
-- compra automatica (PRD). E o momento que D-144/D-147 declararam: a
-- PRIMEIRA versao SQL derivada das formulas canonicas de @sb/domain, com
-- TESTE DE EQUIVALENCIA na CI (packages/db importa @sb/domain e compara
-- linha a linha o que esta funcao devolve com o que computePurchaseSuggestion
-- e classifyStockState devolvem sobre os mesmos ingredientes).
--
-- A ORDEM E LEXICOGRAFICA POR CATEGORIAS, sem score e sem peso inventado:
--   1. estado operacional (D-148): RUPTURA > COMPRA_URGENTE >
--      COMPRAR_EM_BREVE > COBERTURA_BAIXA > recusas > ADEQUADA > EXCESSO.
--      Recusa fica no meio de proposito: e pendencia HUMANA (config/ensaio),
--      acima do que nao precisa de acao, abaixo do que precisa de compra.
--   2. classe ABC (D-140, criterio faturamento, 90d TRAILING -- a MESMA
--      janela do units_90d), pela PROPRIA get_sku_abc_curve via join:
--      a formula da curva e canonica em SQL, nunca reimplementada.
--   3. cobertura crescente (menos dias primeiro), nulos por ultimo.
--   4. venda recente decrescente, SKU como desempate final.
-- Crescimento e valor necessario sao COLUNAS para o julgamento humano, nao
-- chaves de ordenacao -- chave explicavel vale mais que score opaco.
--
-- A resolucao da politica (D-144) entra em SQL por PRECEDENCIA DE LINHA
-- INTEIRA (SKU > marca > padrao), nunca coalesce por campo -- coalesce
-- misturaria escopos quando max_coverage_days do escopo vencedor e nulo.
-- SKU sem marca so casa com o padrao (o join por igualdade ja garante).
--
-- As colunas derivadas (suggested_quantity, state, coverage_days) existem
-- para ORDENAR e para o teste de equivalencia; a TELA continua renderizando
-- pelo dominio (formula unica: o canonico e o TS; isto e derivacao testada).
--
-- EXPLAIN (ANALYZE, BUFFERS) 2026-08-30: 196 ms quente, 15.047 buffers,
-- temp ~4MB, 3.276 linhas -- acima da familia de 90-137 ms das RPCs
-- anteriores, e o custo extra e o preco DECLARADO de reusar a
-- get_sku_abc_curve canonica (que refaz o proprio join de Full por dentro)
-- em vez de duplicar a formula da curva. Nenhum indice novo.

drop function public.get_purchase_suggestions(uuid, date, text, text, integer, integer);

create function public.get_purchase_suggestions(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  supplier_brand text,
  purchase_cost numeric,
  stock_is_virtual boolean,
  local_quantity numeric,
  reservado numeric,
  transito numeric,
  full_quantity numeric,
  units_15d bigint,
  units_30d bigint,
  units_60d bigint,
  units_90d bigint,
  history_days_90 bigint,
  abc_class text,
  coverage_days numeric,
  state text,
  suggested_quantity integer,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
    group by b.sku_id
  ),
  ultima_captura as (
    select f.ml_account_id, max(f.captured_at) as captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
    group by f.ml_account_id
  ),
  full_por_sku as (
    select f.sku_id, sum(f.quantity) as full_quantity
    from public.fulfillment_stock_snapshots f
    join ultima_captura u
      on u.ml_account_id = f.ml_account_id and u.captured_at = f.captured_at
    where f.organization_id = p_organization_id
    group by f.sku_id
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
  abc as (
    -- Reuso da curva canonica (D-140): criterio faturamento, 90d TRAILING
    -- encerrados em p_date_to -- a mesma janela do units_90d acima.
    select a.sku_id, a.abc_class
    from public.get_sku_abc_curve(
      p_organization_id, p_date_to - 89, p_date_to,
      null, 'faturamento', false, 2147483647, 0
    ) a
  ),
  combined as (
    select coalesce(p.sku_id, t.sku_id) as sku_id,
      p.local_quantity, p.reservado, p.transito,
      t.units_15d, t.units_30d, t.units_60d, t.units_90d
    from pivot p
    full outer join trend_windows t on t.sku_id = p.sku_id
  ),
  settings as (
    select * from public.replenishment_settings s
    where s.organization_id = p_organization_id
  ),
  base as (
    select c.sku_id, sk.sku, sk.title, sk.supplier_brand, sk.purchase_cost,
      sk.stock_is_virtual,
      coalesce(c.local_quantity, 0) as local_quantity,
      coalesce(c.reservado, 0) as reservado,
      coalesce(c.transito, 0) as transito,
      coalesce(fp.full_quantity, 0) as full_quantity,
      coalesce(c.units_15d, 0) as units_15d,
      coalesce(c.units_30d, 0) as units_30d,
      coalesce(c.units_60d, 0) as units_60d,
      coalesce(c.units_90d, 0) as units_90d,
      ab.abc_class,
      -- Precedencia de LINHA INTEIRA: o escopo que venceu fornece TODOS os
      -- campos, inclusive um max_coverage_days nulo.
      case
        when s_sku.id is not null then s_sku.lead_time_days
        when s_brand.id is not null then s_brand.lead_time_days
        else s_org.lead_time_days
      end as lead_time_days,
      case
        when s_sku.id is not null then s_sku.target_coverage_days
        when s_brand.id is not null then s_brand.target_coverage_days
        else s_org.target_coverage_days
      end as target_coverage_days,
      case
        when s_sku.id is not null then s_sku.safety_stock_days
        when s_brand.id is not null then s_brand.safety_stock_days
        else s_org.safety_stock_days
      end as safety_stock_days,
      case
        when s_sku.id is not null then s_sku.max_coverage_days
        when s_brand.id is not null then s_brand.max_coverage_days
        else s_org.max_coverage_days
      end as max_coverage_days,
      (s_sku.id is not null or s_brand.id is not null or s_org.id is not null) as has_policy
    from combined c
    join public.skus sk on sk.id = c.sku_id
    left join full_por_sku fp on fp.sku_id = c.sku_id
    left join abc ab on ab.sku_id = c.sku_id
    left join settings s_sku   on s_sku.sku_id = c.sku_id
    left join settings s_brand on s_brand.supplier_brand = sk.supplier_brand and s_brand.sku_id is null
    left join settings s_org   on s_org.supplier_brand is null and s_org.sku_id is null
    where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_search is null
           or sk.sku   ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
  ),
  computed as (
    select b.*, h.history_days_90,
      b.units_30d / 30.0 as rate,
      case when b.stock_is_virtual then null
           else b.local_quantity + b.full_quantity + b.transito end as usable
    from base b
    cross join history h
  ),
  verdict as (
    select c.*,
      -- As quatro recusas da sugestao (D-147), como flag unica.
      (not c.has_policy
        or c.usable is null
        or c.history_days_90 < 84
        or c.units_90d < 12) as refused,
      case when c.usable is null or c.rate <= 0 then null
           else round(greatest(c.usable, 0) / c.rate, 1) end as coverage_days
    from computed c
  )
  select
    v.sku_id, v.sku, v.title, v.supplier_brand, v.purchase_cost,
    v.stock_is_virtual, v.local_quantity, v.reservado, v.transito,
    v.full_quantity, v.units_15d, v.units_30d, v.units_60d, v.units_90d,
    v.history_days_90, v.abc_class, v.coverage_days,
    -- classifyStockState (D-148), derivado: as recusas e SEM_DEMANDA_RECENTE
    -- viram estado nulo; os cinco estados saem dos limiares da politica.
    case
      when v.refused or v.rate <= 0 then null
      when v.usable <= 0 then 'RUPTURA'
      when v.coverage_days <= v.lead_time_days then 'COMPRA_URGENTE'
      when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 'COMPRAR_EM_BREVE'
      when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 'COBERTURA_BAIXA'
      when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 'EXCESSO'
      else 'ADEQUADA'
    end as state,
    -- computePurchaseSuggestion (D-147), derivado: ceil(taxa x janela) -
    -- aproveitavel, piso zero; nulo sob recusa.
    case when v.refused then null
         else greatest(
           0,
           ceil(
             ceil((v.lead_time_days + v.target_coverage_days + v.safety_stock_days) * v.rate)
             - v.usable
           )
         )::integer
    end as suggested_quantity,
    count(*) over () as total_count
  from verdict v
  order by
    case
      when v.refused or v.rate <= 0 then 4
      when v.usable <= 0 then 0
      when v.coverage_days <= v.lead_time_days then 1
      when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 2
      when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 3
      when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 6
      else 5
    end,
    case v.abc_class when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
    v.coverage_days asc nulls last,
    v.units_30d desc,
    v.sku
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) is
  'Ingredientes E prioridade da sugestao de compra (D-147/D-150). Desde D-150 tambem DERIVA em SQL a formula canonica de @sb/domain (sugestao, estado, cobertura) -- exclusivamente para ordenar o conjunto inteiro e para o teste de equivalencia na CI; a tela renderiza pelo dominio. Ordem lexicografica sem pesos: estado (ruptura>urgente>em breve>baixa>recusas>adequada>excesso), classe ABC (get_sku_abc_curve, faturamento/90d -- join, nunca reimplementacao), cobertura asc, venda 30d desc, sku. Recusa no meio de proposito: pendencia humana acima do que nao precisa de acao.';

revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) to authenticated, service_role;
