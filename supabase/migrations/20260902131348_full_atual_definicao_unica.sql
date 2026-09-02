-- ============================================================
-- "Full atual" passa a ter UMA definicao (D-204).
--
-- MEDIDO no Dev em 02/09/2026: cinco funcoes leem
-- `fulfillment_stock_snapshots`, e elas usavam TRES definicoes diferentes de
-- "Full atual":
--
--   canonica de D-173 (bucket `inventory_id` + janela de 3 dias)
--     get_stock_balances, get_sku_abc_curve, get_fulfillment_overview
--
--   `where captured_at = max(captured_at)`, sem bucket e sem janela
--     get_purchase_suggestions        <- a que decide QUANTO COMPRAR
--
--   `distinct on (ml_account_id, item_id, variation_id)`, sem janela
--     get_sku_dashboard
--
-- **As tres devolvem o mesmo numero hoje**, e isso foi verificado antes de
-- mexer: 648 SKUs, 7.873 unidades, zero divergencia nas duas comparacoes. A
-- divergencia e LATENTE, e cada forma acende numa condicao propria:
--
-- 1. `max(captured_at)` -- `captured_at` e carimbado UMA vez no inicio da
--    varredura e as ~500 linhas de cada conta entram ao longo de 312 a 395
--    segundos (medido em 31/08, registrado junto de D-173). Durante esses ~6
--    minutos, DUAS VEZES POR DIA POR CONTA, `/reposicao` via Full parcial --
--    Full menor do que e', logo sugestao de compra MAIOR do que precisa. E,
--    sem janela de frescor, uma captura que falhasse deixaria Full velho
--    passar por atual sem sinal nenhum.
--
-- 2. grao por `(item_id, variation_id)` -- hoje coincide com `inventory_id`
--    porque a relacao esta 1:1 (2.165 para 2.165). Nada garante que continue,
--    e quando o grao errou antes o preco foi alto: a migration
--    `20260831210151_fulfillment_overview_and_full_grain_fix.sql` registra
--    **12 SKUs aparecendo como "sem Full" tendo Full, total 15,6% menor**.
--
-- Ha ainda um efeito que so aparece olhando a linha inteira de `/reposicao`:
-- o `abc_class` dela vem de `get_sku_abc_curve`, que usa a canonica, enquanto
-- o `full_quantity` da MESMA LINHA vinha do grao antigo. Duas definicoes de
-- Full na mesma linha de resultado.
--
-- POR QUE NAO UMA FUNCAO COMPARTILHADA. A tentacao e extrair
-- `private.full_atual()` e chamar das cinco. Nao da: `get_stock_balances`
-- calcula Full por LATERAL, so para os SKUs da pagina, e uma funcao que
-- devolve a organizacao inteira desfaria isso. A unidade aqui e a DEFINICAO,
-- nao a funcao -- por isso a garantia vem de uma guarda de catalogo, abaixo,
-- que falha se alguem escrever uma sexta forma.
--
-- `get_stock_balances` NAO e tocada nesta migration: ela ja usa a canonica.
-- ============================================================

create or replace function public.get_purchase_suggestions(
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
  full_por_sku as (
    -- Definicao CANONICA de "Full atual" (D-173), agora a MESMA de
    -- `get_stock_balances`, `get_sku_abc_curve` e `get_fulfillment_overview`:
    -- um saldo por BUCKET (`inventory_id`), com janela de frescor de 3 dias.
    --
    -- O que estava aqui era `where captured_at = max(captured_at)`, e o
    -- proprio D-173 ja tinha registrado por que isso e' furado: `captured_at`
    -- e carimbado UMA vez no inicio da varredura, mas as ~500 linhas de cada
    -- conta entram ao longo de **312 a 395 segundos**. Durante esses ~6
    -- minutos, duas vezes por dia por conta, esta consulta via so a fracao ja
    -- gravada -- Full menor do que e', e a sugestao de compra pedindo MAIS do
    -- que precisa. Sem janela de frescor, uma captura que falhasse deixaria
    -- Full arbitrariamente velho passar por atual, sem sinal nenhum.
    --
    -- Medido em 02/09/2026, antes de trocar: as duas formas devolvem
    -- exatamente o mesmo numero (648 SKUs, 7.873 unidades). A divergencia e'
    -- LATENTE, nao ativa -- ela acende nas duas condicoes acima.
    select q.sku_id, sum(q.quantity) as full_quantity
    from (
      select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.captured_at >= now() - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q
    group by q.sku_id
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

create or replace function public.get_sku_dashboard(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  local_quantity numeric,
  reservado_quantity numeric,
  transito_quantity numeric,
  full_quantity numeric,
  units_sold bigint,
  gross_revenue numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with balances as (
    select location_kind, quantity
    from public.inventory_balances
    where organization_id = p_organization_id and sku_id = p_sku_id
  ),
  sales as (
    select
      coalesce(sum(units_sold), 0)::bigint as units_sold,
      coalesce(sum(gross_revenue), 0) as gross_revenue
    from public.daily_sku_metrics
    where organization_id = p_organization_id
      and sku_id = p_sku_id
      and metric_date between p_date_from and p_date_to
  ),
  latest_full as (
    -- Definicao CANONICA de "Full atual" (D-173): bucket `inventory_id` e
    -- janela de frescor de 3 dias.
    --
    -- Antes agrupava por `(ml_account_id, item_id, variation_id)`, que e' uma
    -- TERCEIRA forma -- nem a canonica, nem a de `get_purchase_suggestions`.
    -- Hoje ela devolve o mesmo numero porque `inventory_id` e o par
    -- (item, variacao) estao 1:1 nos dados (2.165 para 2.165, medido em
    -- 02/09/2026). Nao ha nada que garanta que continuem: a migration
    -- `20260831210151_fulfillment_overview_and_full_grain_fix.sql` existe
    -- justamente porque um grao errado ja custou **12 SKUs aparecendo como
    -- "sem Full" tendo Full, e o total 15,6% menor**.
    select distinct on (f.ml_account_id, f.inventory_id) f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id and f.sku_id = p_sku_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_total as (
    select coalesce(sum(quantity), 0) as full_quantity from latest_full
  )
  select
    coalesce((select quantity from balances where location_kind = 'LOCAL'), 0) as local_quantity,
    coalesce((select quantity from balances where location_kind = 'RESERVADO'), 0) as reservado_quantity,
    coalesce((select quantity from balances where location_kind = 'TRANSITO'), 0) as transito_quantity,
    full_total.full_quantity,
    sales.units_sold,
    sales.gross_revenue
  from sales cross join full_total
$$;

-- ------------------------------------------------------------
-- A prova: nenhuma sexta definicao
-- ------------------------------------------------------------
do $do$
declare
  v_fora text;
begin
  -- Toda funcao que le `fulfillment_stock_snapshots` precisa carregar as duas
  -- marcas da definicao canonica. Sem esta guarda, a terceira forma volta na
  -- proxima RPC que alguem escrever -- foi exatamente assim que chegaram a
  -- tres.
  --
  -- Os COMENTARIOS saem antes da conferencia. Sem isso a guarda seria
  -- enganada pelo proprio texto que explica a regra: as duas funcoes
  -- corrigidas aqui citam `inventory_id` e "3 dias" em comentario, e passariam
  -- mesmo se o SQL abaixo deles nao usasse nenhum dos dois. Guarda que se
  -- deixa enganar pelo comentario e pior que guarda nenhuma.
  --
  -- Conferida contra o DEFEITO antes de existir: rodada sobre o estado
  -- anterior, ela acusava exatamente `get_purchase_suggestions` e
  -- `get_sku_dashboard`, e deixava passar as tres corretas.
  with corpo as (
    select p.proname,
           regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') as sql_sem_comentario
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%fulfillment_stock_snapshots%'
  )
  select string_agg(c.proname, ', ')
    into v_fora
  from corpo c
  where c.sql_sem_comentario like '%fulfillment_stock_snapshots%'
    and not (
      c.sql_sem_comentario like '%inventory_id%'
      and c.sql_sem_comentario like '%3 days%'
    );

  if v_fora is not null then
    raise exception
      'D-204: estas funcoes leem fulfillment_stock_snapshots sem a definicao canonica (bucket inventory_id + janela de 3 dias): %',
      v_fora;
  end if;
end $do$;
