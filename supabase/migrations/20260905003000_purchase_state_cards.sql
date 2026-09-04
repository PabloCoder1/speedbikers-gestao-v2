-- ============================================================
-- Cartoes de estado e filtro por estado em `/reposicao` (D-250, fatia D15).
--
-- O frame `Coverage` desenha CINCO cartoes clicaveis: Em ruptura, Compra
-- urgente, Comprar em breve, Cobertura adequada, Excesso. A conferencia contra
-- o vocabulario canonico (D-150, `packages/domain/src/purchasing/stock-state.ts`)
-- achou tres diferencas, e as tres mudam a tela:
--
--   1. O frame OMITE `COBERTURA_BAIXA` -- "cobertura abaixo da janela de
--      demanda, o territorio em que a sugestao ja da numero > 0". Sao 37 SKUs
--      no Dev. Um estado que existe e nao aparece faz os cartoes nao fecharem
--      com o total da tabela.
--
--   2. O frame desenha "Excesso" com numero. `EXCESSO` e o UNICO estado que
--      depende de configuracao: *"sem teto configurado, EXCESSO nunca e
--      afirmado -- quanto e demais e decisao do ADMIN, nao constante do
--      codigo"*. Hoje nenhuma politica tem teto, entao ele volta vazio POR
--      DESENHO, e o cartao precisa dizer isso: "0" cru leria como "nao ha
--      excesso", que e afirmacao diferente.
--
--   3. Falta um SEXTO grupo, que o frame nao tem: **SEM ESTADO, 2.817 SKUs,
--      86% do catalogo**. Nao e lacuna, e recusa documentada com cinco portas
--      (sem configuracao, estoque virtual, historico furado, amostra
--      insuficiente, sem demanda recente). Omitido, os cinco cartoes somariam
--      463 embaixo de uma tabela que anuncia 3.280 -- a tela se contradizendo
--      em dois numeros que o olho compara sozinho.
--
-- Medido no Dev: ADEQUADA 209, RUPTURA 112, COMPRA_URGENTE 93,
-- COBERTURA_BAIXA 37, COMPRAR_EM_BREVE 12, EXCESSO 0, sem estado 2.817.
--
-- ------------------------------------------------------------
-- ASSINATURA: conferida nas DUAS metades, antes de escrever
-- ------------------------------------------------------------
-- A licao que o HANDOFF registrou depois de D-237: `pg_proc` so enxerga
-- dentro do banco, e o Copiloto chamava uma RPC de fora dele. As duas metades:
--
--   catalogo   nenhum chamador de get_purchase_suggestions dentro do banco
--   monorepo   so apps/web/app/reposicao/page.tsx e os testes -- nada em apps/api
--
-- O corpo abaixo, ate a CTE `verdict`, e COPIA EXATA do que ja estava no ar
-- (extraido do arquivo, nao transcrito a mao): a fatia muda a cauda, nao a
-- regra.
-- ============================================================

drop function public.get_purchase_suggestions(uuid, date, text, text, integer, integer);

create function public.get_purchase_suggestions(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0,
  -- ULTIMO, pela convencao das fatias de filtro (D-235/D-236). `SEM_ESTADO`
  -- seleciona o bucket de recusa; qualquer outro valor casa com o estado.
  p_state text default null
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
  ),
  -- ------------------------------------------------------------
  -- O estado sobe para CTE (D-250), e a razao e poder filtrar por ele.
  --
  -- Antes o `case` vivia no `select` final, onde nao ha como aplicar um
  -- `where` em cima. A contagem tambem sai do `count(*) over ()` para
  -- subconsulta independente sobre o conjunto FILTRADO -- o desenho que D-167
  -- aprovou depois do EXPLAIN reprovar a janela.
  --
  -- A ORDEM de prioridade de D-150 NAO mudou: virou a coluna `prioridade`,
  -- calculada uma vez em vez de repetida dentro do `order by`.
  -- ------------------------------------------------------------
  classificada as (
    select v.*,
      case
        when v.refused or v.rate <= 0 then null
        when v.usable <= 0 then 'RUPTURA'
        when v.coverage_days <= v.lead_time_days then 'COMPRA_URGENTE'
        when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 'COMPRAR_EM_BREVE'
        when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 'COBERTURA_BAIXA'
        when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 'EXCESSO'
        else 'ADEQUADA'
      end as estado,
      case when v.refused then null
           else greatest(
             0,
             ceil(
               ceil((v.lead_time_days + v.target_coverage_days + v.safety_stock_days) * v.rate)
               - v.usable
             )
           )::integer
      end as sugestao,
      case
        when v.refused or v.rate <= 0 then 4
        when v.usable <= 0 then 0
        when v.coverage_days <= v.lead_time_days then 1
        when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 2
        when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 3
        when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 6
        else 5
      end as prioridade
    from verdict v
  ),
  filtrada as (
    select * from classificada c
    where p_state is null
       or (p_state = 'SEM_ESTADO' and c.estado is null)
       or c.estado = p_state
  )
  select
    f.sku_id, f.sku, f.title, f.supplier_brand, f.purchase_cost,
    f.stock_is_virtual, f.local_quantity, f.reservado, f.transito,
    f.full_quantity, f.units_15d, f.units_30d, f.units_60d, f.units_90d,
    f.history_days_90, f.abc_class, f.coverage_days,
    f.estado as state,
    f.sugestao as suggested_quantity,
    (select count(*) from filtrada) as total_count
  from filtrada f
  order by
    f.prioridade,
    case f.abc_class when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
    f.coverage_days asc nulls last,
    f.units_30d desc,
    f.sku
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) is
  'Sugestao de compra por SKU (D-147/D-150; p_state desde D-250). O estado subiu para CTE para poder ser filtrado, e a contagem passou a ser subconsulta sobre o conjunto FILTRADO (D-167). SEM_ESTADO seleciona o bucket de recusa -- 86% do catalogo no Dev, com cinco portas documentadas em stock-state.ts. A ordem de prioridade de D-150 nao mudou. security invoker.';

revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) to authenticated, service_role;

-- ============================================================
-- `get_purchase_state_counts` -- os cartoes de estado do frame.
--
-- DELEGA em vez de recalcular, e isso e o desenho. O estado tem UMA definicao
-- (D-150); uma segunda copia aqui divergiria no primeiro ajuste de politica, e
-- os cartoes diriam um estado enquanto a linha da tabela diria outro, na mesma
-- tela e um do lado do outro. Mesmo padrao de `get_stock_coverage_summary`
-- desde D-131.
--
-- Recebe os MESMOS filtros da tabela, MENOS o de estado: os cartoes precisam
-- continuar mostrando os outros estados quando um deles esta ativo.
-- ============================================================
create function public.get_purchase_state_counts(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null
)
returns table (state text, skus bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(s.state, 'SEM_ESTADO') as state, count(*)::bigint as skus
  from public.get_purchase_suggestions(
         p_organization_id, p_date_to, p_supplier_brand, p_search, 1000000, 0, null) s
  group by 1
$$;

comment on function public.get_purchase_state_counts(uuid, date, text, text) is
  'Contagem por estado operacional para os cartoes de /reposicao (D-250). DELEGA a get_purchase_suggestions em vez de reimplementar o case: o estado tem uma definicao so (D-150), e uma copia aqui divergiria no primeiro ajuste de politica. O bucket nulo vira SEM_ESTADO -- e 86% do catalogo, e omiti-lo faria os cartoes nao fecharem com o total da tabela. security invoker.';

revoke all on function public.get_purchase_state_counts(uuid, date, text, text) from public, anon;
grant execute on function public.get_purchase_state_counts(uuid, date, text, text) to authenticated, service_role;
