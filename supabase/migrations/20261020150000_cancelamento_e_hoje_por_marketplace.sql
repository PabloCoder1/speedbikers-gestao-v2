-- ============================================================
-- D-603 -- o cancelamento e o "hoje" no "Todos" de /vendas (contrato C-70,
-- item 4 (a) das decisoes do dono, escolhido em 20/10).
--
-- Duas funcoes NOVAS, ao lado do C-53 (D-436), que nao muda: a Home, o
-- export e a /vendas continuam lendo o mesmo get_marketplace_sales_summary,
-- sem pagar a leitura de `orders` que o cancelamento pede.
--
-- 1. get_marketplace_sales_cancellations -- a taxa de cancelamento POR
--    COMPRA, a unidade que soma entre os canais (C-53): o pack do ML e o
--    pedido da Shopee.
--    - ML: os pedidos da janela (`orders.date_created`, o dia de Sao Paulo,
--      a mesma janela de get_sales_expanded_summary) agrupados pela compra
--      (`pack_id`, ou o proprio pedido sem pack). A compra e VALIDA se algum
--      pedido dela vale (`paid`, `partially_refunded`) e CANCELADA se todos
--      foram cancelados (`cancelled`, `pending_cancel` -- 5C). A compra com
--      um item cancelado e outro valido e valida: o cliente comprou.
--    - Shopee: a situacao de `shopee_sales_orders` (VALIDA e CANCELADA, que
--      ja inclui IN_CANCEL), lida em `shopee_orders` com a MESMA expressao
--      (a view montaria os itens de cada pedido sem precisar; o teste prova a
--      igualdade com a view).
--    - Taxa = canceladas / (validas + canceladas), como a 5C, so que por
--      compra. A do ML aqui pode diferir da tela do ML, que conta por pedido
--      (docs/METRICS.md 5T).
-- 2. get_marketplace_sales_today -- as vendas do dia AO VIVO, como o "hoje"
--    do ML (get_sales_today_summary, D-158/D-165), e nao o agregado diario
--    recalculado do C-53.
--    - ML: os pedidos validos do dia em `orders`; receita = `total_amount`,
--      unidades = `order_items.quantity`, compras = packs distintos -- as
--      definicoes de get_sales_today_summary, provadas iguais no teste.
--    - Shopee: as vendas VALIDAS do dia de `shopee_sales_orders` (C-53), com
--      o "lido ate" da loja (`orders_synced_until`): a Shopee e lida a cada
--      5 minutos, nao por webhook.
--
-- As regras do C-53 valem nas duas: loja de SANDBOX so em CONTA, fora das
-- somas; loja nunca lida com tudo NULO (nunca zero); sem loja live lida, sem
-- linha MARKETPLACE da Shopee; p_marketplaces nulo = so ML; p_account_ids de
-- marketplace_accounts. security invoker: a permissao por conta (D-175) e
-- por loja (D-433) vale. Sem recorte de marca nesta fatia (D-605).
-- ============================================================

create function public.get_marketplace_sales_cancellations(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  marketplace text,
  account_id uuid,
  account_name text,
  environment text,
  compras_validas bigint,
  compras_canceladas bigint,
  taxa_cancelamento numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
-- A compra e um agrupamento de todos os pedidos da janela: em 90 dias de
-- producao a agregacao passava do work_mem padrao e ia ao disco (medido em
-- 20/10). O mesmo ajuste da D-499.
set work_mem = '32MB'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
  v_de timestamptz;
  v_ate timestamptz;
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  v_de := (p_date_from::timestamp at time zone 'America/Sao_Paulo');
  v_ate := ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo');

  return query
  with
  contas_ml as (
    select a.id, a.label
    from public.ml_accounts a
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
  ),
  compras_ml as (
    -- Uma linha por compra: o pack, ou o pedido sem pack.
    select
      o.ml_account_id,
      bool_or(o.status in ('paid', 'partially_refunded')) as valida,
      bool_and(o.status in ('cancelled', 'pending_cancel')) as cancelada
    from public.orders o
    where o.organization_id = p_organization_id
      and o.date_created >= v_de
      and o.date_created < v_ate
      and o.ml_account_id in (select c.id from contas_ml c)
    group by o.ml_account_id, coalesce('pack:' || o.pack_id::text, 'pedido:' || o.id::text)
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      count(*) filter (where k.valida)::bigint as validas,
      count(*) filter (where k.cancelada and not k.valida)::bigint as canceladas
    from contas_ml c
    left join compras_ml k on k.ml_account_id = c.id
    group by c.id, c.label
  ),
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where 'SHOPEE' = any (v_marketplaces)
      and s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  situacao_shopee as (
    -- A expressao de `shopee_sales_orders.situacao` (D-430), sem os itens.
    select
      o.shopee_shop_id,
      case
        when o.order_status in ('CANCELLED', 'IN_CANCEL') then 'CANCELADA'
        when o.paid_at is null or o.order_status = 'UNPAID' then 'NAO_PAGA'
        else 'VALIDA'
      end as situacao
    from public.shopee_orders o
    where o.organization_id = p_organization_id
      and o.shopee_shop_id in (select l.id from lojas l)
      and o.shopee_created_at >= v_de
      and o.shopee_created_at < v_ate
  ),
  canc_shopee as (
    select
      s.shopee_shop_id,
      count(*) filter (where s.situacao = 'VALIDA') as validas,
      count(*) filter (where s.situacao = 'CANCELADA') as canceladas
    from situacao_shopee s
    group by s.shopee_shop_id
  ),
  por_loja as (
    -- Loja cujos pedidos nunca foram lidos: NULO, nunca zero.
    select
      l.id,
      l.nome,
      l.environment,
      case when l.orders_last_success_at is null then null else coalesce(cs.validas, 0) end::bigint as validas,
      case when l.orders_last_success_at is null then null else coalesce(cs.canceladas, 0) end::bigint as canceladas
    from lojas l
    left join canc_shopee cs on cs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb, c.validas, c.canceladas
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment, l.validas, l.canceladas
    from por_loja l
  ),
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.validas is not null
  ),
  por_marketplace as (
    select s.mk, sum(s.validas)::bigint as validas, sum(s.canceladas)::bigint as canceladas
    from somaveis s
    group by s.mk
  )
  select
    'TOTAL'::text, null::text, null::uuid, null::text, null::text,
    sum(p.validas)::bigint,
    sum(p.canceladas)::bigint,
    round(sum(p.canceladas)::numeric / nullif(sum(p.canceladas) + sum(p.validas), 0), 4)
  from por_marketplace p
  having count(*) > 0

  union all

  select
    'MARKETPLACE', p.mk, null, null, null,
    p.validas, p.canceladas,
    round(p.canceladas::numeric / nullif(p.canceladas + p.validas, 0), 4)
  from por_marketplace p

  union all

  select
    'CONTA', l.mk, l.id, l.nome, l.amb,
    l.validas, l.canceladas,
    round(l.canceladas::numeric / nullif(l.canceladas + l.validas, 0), 4)
  from linhas_conta l;
end;
$$;

comment on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[]) is
  'Taxa de cancelamento por COMPRA, por marketplace e o consolidado (D-603, C-70): linhas TOTAL, MARKETPLACE e CONTA, como o C-53. Compra = pack do ML (valida se algum pedido vale, cancelada se todos foram cancelados, cancelled/pending_cancel) ou pedido da Shopee (situacao de shopee_sales_orders). Taxa = canceladas / (validas + canceladas). Sandbox so em CONTA; loja nunca lida NULA. security invoker.';

revoke all on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[]) from public, anon;
grant execute on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[]) to authenticated;

create function public.get_marketplace_sales_today(
  p_organization_id uuid,
  p_date date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  marketplace text,
  account_id uuid,
  account_name text,
  environment text,
  compras bigint,
  unidades bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  ticket_medio numeric,
  ultimo_pedido_em timestamptz,
  lido_ate timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
  v_de timestamptz;
  v_ate timestamptz;
begin
  if p_date is null then
    raise exception 'dia invalido: %', p_date;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  v_de := (p_date::timestamp at time zone 'America/Sao_Paulo');
  v_ate := ((p_date + 1)::timestamp at time zone 'America/Sao_Paulo');

  return query
  with
  contas_ml as (
    select a.id, a.label
    from public.ml_accounts a
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
  ),
  pedidos_ml as materialized (
    -- Os pedidos validos do dia, como get_sales_today_summary.
    select o.id, o.ml_account_id, o.pack_id, o.total_amount, o.date_created
    from public.orders o
    where o.organization_id = p_organization_id
      and o.date_created >= v_de
      and o.date_created < v_ate
      and o.status in ('paid', 'partially_refunded')
      and o.ml_account_id in (select c.id from contas_ml c)
  ),
  totais_ml as (
    select
      p.ml_account_id,
      count(distinct case when p.pack_id is null then 'pedido:' || p.id::text else 'pack:' || p.pack_id::text end)::bigint as compras,
      sum(p.total_amount) as receita,
      max(p.date_created) as ultimo
    from pedidos_ml p
    group by p.ml_account_id
  ),
  unidades_ml as (
    select p.ml_account_id, sum(oi.quantity)::bigint as unidades
    from pedidos_ml p
    join public.order_items oi on oi.order_id = p.id
    group by p.ml_account_id
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      coalesce(t.compras, 0)::bigint as compras,
      coalesce(u.unidades, 0)::bigint as unidades,
      coalesce(t.receita, 0) as receita,
      t.ultimo
    from contas_ml c
    left join totais_ml t on t.ml_account_id = c.id
    left join unidades_ml u on u.ml_account_id = c.id
  ),
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment,
           s.orders_last_success_at, s.orders_synced_until
    from public.shopee_shops s
    where 'SHOPEE' = any (v_marketplaces)
      and s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  vendas_shopee as (
    select
      v.shopee_shop_id,
      count(*) as compras,
      coalesce(sum(v.unidades), 0) as unidades,
      sum(v.receita_bruta) as receita,
      count(*) filter (where v.receita_bruta is null) as sem_receita,
      max(v.shopee_created_at) as ultimo
    from public.shopee_sales_orders v
    where v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= v_de
      and v.shopee_created_at < v_ate
    group by v.shopee_shop_id
  ),
  por_loja as (
    -- Loja cujos pedidos nunca foram lidos: NULO, nunca zero.
    select
      l.id,
      l.nome,
      l.environment,
      case when l.orders_last_success_at is null then null else coalesce(vs.compras, 0) end::bigint as compras,
      case when l.orders_last_success_at is null then null else coalesce(vs.unidades, 0) end::bigint as unidades,
      case when l.orders_last_success_at is null then null else coalesce(vs.receita, 0) end as receita,
      case when l.orders_last_success_at is null then null else coalesce(vs.sem_receita, 0) end::bigint as sem_receita,
      vs.ultimo,
      l.orders_synced_until as lido
    from lojas l
    left join vendas_shopee vs on vs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb,
           c.compras, c.unidades, c.receita, 0::bigint as sem_receita, c.ultimo, null::timestamptz as lido
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment, l.compras, l.unidades, l.receita, l.sem_receita, l.ultimo, l.lido
    from por_loja l
  ),
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.compras is not null
  ),
  por_marketplace as (
    select
      s.mk,
      sum(s.compras)::bigint as compras,
      sum(s.unidades)::bigint as unidades,
      sum(s.receita) as receita,
      sum(s.sem_receita)::bigint as sem_receita,
      max(s.ultimo) as ultimo,
      -- O elo mais fraco: a loja lida ha mais tempo. O ML e ao vivo (webhook): sem marco.
      case when s.mk = 'SHOPEE' then (case when bool_or(s.lido is null) then null else min(s.lido) end) end as lido
    from somaveis s
    group by s.mk
  )
  select
    'TOTAL'::text, null::text, null::uuid, null::text, null::text,
    sum(p.compras)::bigint,
    sum(p.unidades)::bigint,
    round(sum(p.receita), 2),
    sum(p.sem_receita)::bigint,
    round(sum(p.receita) / nullif(sum(p.compras) - sum(p.sem_receita), 0), 2),
    max(p.ultimo),
    min(p.lido)
  from por_marketplace p
  having count(*) > 0

  union all

  select
    'MARKETPLACE', p.mk, null, null, null,
    p.compras, p.unidades, round(p.receita, 2), p.sem_receita,
    round(p.receita / nullif(p.compras - p.sem_receita, 0), 2),
    p.ultimo, p.lido
  from por_marketplace p

  union all

  select
    'CONTA', l.mk, l.id, l.nome, l.amb,
    l.compras, l.unidades, round(l.receita, 2), l.sem_receita,
    round(l.receita / nullif(l.compras - l.sem_receita, 0), 2),
    l.ultimo, l.lido
  from linhas_conta l;
end;
$$;

comment on function public.get_marketplace_sales_today(uuid, date, text[], uuid[]) is
  'Vendas do dia ao vivo, por marketplace e o consolidado (D-603, C-70): linhas TOTAL, MARKETPLACE e CONTA, como o C-53. ML de orders (as definicoes de get_sales_today_summary); Shopee das vendas validas do dia de shopee_sales_orders, com lido_ate = orders_synced_until (o elo mais fraco no MARKETPLACE e no TOTAL). ultimo_pedido_em = a venda mais recente. Sandbox so em CONTA; loja nunca lida NULA. security invoker.';

revoke all on function public.get_marketplace_sales_today(uuid, date, text[], uuid[]) from public, anon;
grant execute on function public.get_marketplace_sales_today(uuid, date, text[], uuid[]) to authenticated;
