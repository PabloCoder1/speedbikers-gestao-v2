-- ============================================================
-- /reposicao mais rapida: plano custom na sugestao e UMA leitura para a tela
-- (D-358).
--
-- ------------------------------------------------------------
-- O QUE FOI MEDIDO (Dev, `authenticated` real, 16/09/2026)
-- ------------------------------------------------------------
--
--   get_purchase_suggestions (pagina de 100)   2.420 frio, ~490 ms quente
--   get_purchase_state_counts                  ~495 ms quente
--   o MESMO corpo com os valores literais       218 ms
--
-- Corpo rapido + funcao lenta = o PLANO, nao o SQL: e a doenca de D-305/D-307.
-- `language sql` com clausula `SET` e planejada uma vez sem os valores dos
-- argumentos e nunca e inlined. D-307 tinha anotado as duas como "custo, nao
-- defeito" contra o teto de 8 s -- e continua certo; o que mudou e o pedido:
-- deixar a tela rapida.
--
-- E a tela pagava DUAS vezes: `get_purchase_state_counts` delega em
-- `get_purchase_suggestions` com limite de um milhao, entao cada carregamento
-- classificava o catalogo inteiro (3.284 SKUs) duas vezes, em paralelo.
--
-- ------------------------------------------------------------
-- AS DUAS MUDANCAS
-- ------------------------------------------------------------
--
-- 1. `get_purchase_suggestions` vira `plpgsql` com
--    `plan_cache_mode = 'force_custom_plan'`. Corpo EXTRAIDO por script do
--    arquivo `20260909150000` (D-253), sem alteracao textual: todas as
--    referencias ja sao qualificadas, e `variable_conflict = error` faz
--    colisao futura falhar alto. Assinatura, retorno, `security invoker` e
--    `search_path` iguais -- Copiloto, `get_purchase_state_counts` e os
--    testes seguem valendo.
--
-- 2. `get_replenishment_overview` -- a leitura da TELA. Chama a sugestao UMA
--    vez, sem filtro de estado, e devolve num `jsonb`: a pagina, o total
--    filtrado, a contagem por estado (sobre o conjunto SEM o filtro de estado,
--    como os cartoes sempre foram), o investimento sugerido por estado e o
--    frescor das duas entradas que envelhecem. NAO reclassifica nada: estado,
--    sugestao e ordem sao os da funcao delegada (uma definicao so, D-150). A
--    ordem da pagina e a da propria funcao, preservada por `with ordinality`
--    -- que numera as linhas na ordem em que a funcao as devolve.
--
-- ------------------------------------------------------------
-- INVESTIMENTO: custo desconhecido NAO e zero
-- ------------------------------------------------------------
--
-- `investimento` = soma de sugestao x `purchase_cost` so onde a sugestao e
-- positiva E o custo e > 0. Custo nulo ou 0 e desconhecido (mesma regra de
-- D-356), e esses SKUs sao CONTADOS a parte em `sem_custo`: a tela diz "R$ X
-- + N SKUs sem custo" em vez de somar zero calado.
-- ============================================================

create or replace function public.get_purchase_suggestions(
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
language plpgsql
stable
security invoker
set search_path = ''
-- A linha que tira o plano generico (D-305/D-307, medido em D-358).
set plan_cache_mode = 'force_custom_plan'
as $fn$
begin
  return query

  with janela as (
    -- `p_date_to` NULO passa a significar HOJE, e nao NADA (D-280).
    --
    -- Antes, um nulo aqui fazia toda comparacao de data virar NULL: as CTEs
    -- `trend_windows` e `history` nao casavam UMA linha, `units_90d` saia 0
    -- para o catalogo inteiro, e a recusa `units_90d < 12` (D-147) reprovava
    -- todo mundo. O resultado eram 3.284 SKUs devolvidos, TODOS sem estado --
    -- indistinguivel de "nada se qualifica hoje".
    --
    -- Foi essa leitura que me fez diagnosticar uma regressao inexistente em
    -- 2026-09-09. A funcao estava certa; o silencio e que nao estava. Zero
    -- nao pode ser a resposta para "voce nao me disse a data" (D-067).
    select coalesce(p_date_to, current_date) as ate
  ),
  pivot as (
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
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
    group by m.sku_id
  ),
  history as (
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
  ),
  abc as (
    -- Reuso da curva canonica (D-140): criterio faturamento, 90d TRAILING
    -- encerrados na janela -- a mesma do units_90d acima.
    select a.sku_id, a.abc_class
    from public.get_sku_abc_curve(
      p_organization_id, (select ate from janela) - 89, (select ate from janela),
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
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
end
$fn$;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) is
  'Sugestao de compra por SKU (D-147/D-150; p_state desde D-250; p_date_to nulo = hoje desde D-280; plpgsql com plano custom desde D-358). O estado subiu para CTE para poder ser filtrado, e a contagem e subconsulta sobre o conjunto FILTRADO (D-167). SEM_ESTADO seleciona o bucket de recusa. A ordem de prioridade de D-150 nao mudou. security invoker.';

revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) to authenticated, service_role;

create function public.get_replenishment_overview(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null,
  p_state text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  resultado jsonb;
begin
  with todas as (
    -- UMA classificacao do catalogo, sem filtro de estado: os cartoes precisam
    -- dos outros estados quando um deles esta ativo (D-250).
    select o.*
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, p_supplier_brand, p_search, 1000000, 0, null
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count, ordem
         )
  ),
  filtrada as (
    select t.*
    from todas t
    where p_state is null
       or (p_state = 'SEM_ESTADO' and t.state is null)
       or t.state = p_state
  ),
  contagens as (
    select
      coalesce(t.state, 'SEM_ESTADO') as state,
      count(*)::bigint as skus,
      coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0)::bigint as unidades,
      round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
        filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2) as investimento,
      count(*) filter (where t.suggested_quantity > 0
                         and (t.purchase_cost is null or t.purchase_cost <= 0))::bigint as sem_custo
    from todas t
    group by 1
  ),
  pagina as (
    select f.*
    from filtrada f
    order by f.ordem
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'contagens', coalesce((
      select jsonb_agg(jsonb_build_object(
               'state', c.state, 'skus', c.skus, 'unidades', c.unidades,
               'investimento', c.investimento, 'sem_custo', c.sem_custo))
      from contagens c), '[]'::jsonb),
    -- Os agregados que a tela mostra sem somar nada: o total de todos os
    -- estados e o "comprar agora" (ruptura + compra urgente), no MESMO
    -- conjunto dos cartoes.
    'totais', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t),
    'comprar_agora', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t
      where t.state in ('RUPTURA', 'COMPRA_URGENTE')),
    'linhas', coalesce((
      select jsonb_agg((to_jsonb(p) - 'ordem' - 'total_count') order by p.ordem)
      from pagina p), '[]'::jsonb),
    -- O frescor das duas entradas que envelhecem sozinhas. NULL = nunca houve.
    'vendas_calculadas_em', (
      select max(m.computed_at) from public.daily_sku_metrics m
      where m.organization_id = p_organization_id
        and m.metric_date > coalesce(p_date_to, current_date) - 90),
    -- O frescor do Full sai da MESMA leitura canonica que o Full conta (D-173,
    -- D-204): a captura mais recente de cada (conta, inventory_id) na janela
    -- de 3 dias. Um `max(captured_at)` direto na tabela devolve o mesmo
    -- numero -- o maximo dos maximos por bucket e' o maximo da janela --, mas
    -- seria uma sexta forma de ler `fulfillment_stock_snapshots`, e e'
    -- exatamente isso que o teste de D-204 recusa. Lido assim, o horario
    -- mostrado e' o do Full que a tela de fato soma.
    'full_capturado_em', (
      select max(q.captured_at)
      from (
        select distinct on (f.ml_account_id, f.inventory_id) f.captured_at
        from public.fulfillment_stock_snapshots f
        where f.organization_id = p_organization_id
          and f.captured_at >= now() - interval '3 days'
        order by f.ml_account_id, f.inventory_id, f.captured_at desc
      ) q)
  )
  into resultado;

  return resultado;
end
$fn$;

comment on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer) is
  'A leitura de /reposicao (D-358): UMA chamada a get_purchase_suggestions sem filtro de estado, devolvendo em jsonb a pagina (na ordem da funcao, via with ordinality), o total filtrado, contagem/unidades/investimento por estado e o frescor de vendas e Full. Nao reclassifica: estado e sugestao sao os da funcao delegada (D-150). Investimento so com custo > 0; sem custo e contado a parte, nunca somado como zero. security invoker.';

revoke all on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer) to authenticated, service_role;
