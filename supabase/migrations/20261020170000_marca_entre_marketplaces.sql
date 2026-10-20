-- ============================================================
-- D-605 -- a marca no "Todos" de /vendas (contrato C-72, item 4 (a2) das
-- decisoes do dono, escolhido em 20/10).
--
-- As quatro funcoes do "Todos" ganham NO FIM `p_supplier_brand text` e
-- `p_sem_marca boolean` -- os nomes e a regra do recorte do ML (D-237):
--   - "marca X" = o SKU do item tem `supplier_brand = X`;
--   - "sem marca" = o item sem SKU, ou o SKU sem marca cadastrada;
--   - os dois juntos: vale o "sem marca" (como get_sales_summary).
--
-- SEM RECORTE, NADA MUDA: a mesma fonte e o mesmo resultado de antes (o
-- C-53 de D-436 e o C-70 de D-603), provados pelos testes de sempre.
--
-- COM RECORTE, o grao fino, o unico que conhece SKU e marca:
--   - ML: `daily_sku_metrics` (o ramo de recorte de get_sales_summary) e, no
--     "hoje", os itens de `order_items` dos pedidos validos do dia (o de
--     get_sales_today_summary): receita = quantidade x preco do item;
--   - Shopee: `shopee_sales_items` VALIDA (C-59): receita do item = preco com
--     o desconto da loja x quantidade; o item de preco 0 fica fora da soma, e
--     o PEDIDO com algum item assim conta em `pedidos_sem_receita`.
-- O que NAO tem resposta por marca vem NULO, como no ML: as COMPRAS (o pack
-- e o pedido atravessam SKU -- somar o grao fino conta o mesmo carrinho duas
-- vezes), o TICKET, o RECEBIDO da Shopee (e do pedido inteiro) e o
-- CANCELAMENTO (o pedido cancelado inteiro nao tem cota de marca, D-237).
-- Os pedidos do ML seguem get_sales_summary: a soma de `orders_count` do
-- grao de SKU.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O resumo (C-53)
-- ------------------------------------------------------------
drop function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[]);

create function public.get_marketplace_sales_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
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
  pedidos_ml bigint,
  recebido numeric,
  pedidos_sem_recebido bigint,
  ultima_atualizacao timestamptz
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
  v_sem_marca boolean := coalesce(p_sem_marca, false);
  v_recorte boolean := p_supplier_brand is not null or coalesce(p_sem_marca, false);
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
    -- Toda conta ML alcancada do escopo, com venda ou sem (0 e venda nenhuma,
    -- como em get_sales_summary; o frescor diz se o 0 e de confianca).
    select a.id, a.label
    from public.ml_accounts a
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
  ),
  metricas_ml as (
    -- Sem recorte: a fonte de sempre.
    select m.ml_account_id, m.purchases_count, m.units_sold, m.gross_revenue, m.orders_count
    from public.daily_account_metrics m
    where not v_recorte
      and m.ml_account_id in (select c.id from contas_ml c)
      and m.metric_date between p_date_from and p_date_to

    union all

    -- Com recorte: o grao de SKU, com a regra de marca de get_sales_summary.
    select m.ml_account_id, null::integer, m.units_sold, m.gross_revenue, m.orders_count
    from public.daily_sku_metrics m
    where v_recorte
      and m.ml_account_id in (select c.id from contas_ml c)
      and m.metric_date between p_date_from and p_date_to
      and (
        case when v_sem_marca
          then m.sku_id is null
               or not exists (select 1 from public.skus s where s.id = m.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      case when v_recorte then null else coalesce(sum(m.purchases_count), 0) end::bigint as compras,
      coalesce(sum(m.units_sold), 0)::bigint as unidades,
      coalesce(sum(m.gross_revenue), 0) as receita,
      coalesce(sum(m.orders_count), 0)::bigint as pedidos,
      (select r.last_refresh_at from public.metric_refresh_state r where r.ml_account_id = c.id) as atualizado
    from contas_ml c
    left join metricas_ml m on m.ml_account_id = c.id
    group by c.id, c.label
  ),
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where 'SHOPEE' = any (v_marketplaces)
      and s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  vendas_shopee as (
    -- Sem recorte: o pedido (D-436).
    select
      v.shopee_shop_id,
      count(*) as compras,
      coalesce(sum(v.unidades), 0) as unidades,
      sum(v.receita_bruta) as receita,
      count(*) filter (where v.receita_bruta is null) as sem_receita,
      sum(v.recebido) filter (where v.financeiro_lido) as recebido,
      count(*) filter (where not v.financeiro_lido) as sem_recebido
    from public.shopee_sales_orders v
    where not v_recorte
      and v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= v_de
      and v.shopee_created_at < v_ate
    group by v.shopee_shop_id

    union all

    -- Com recorte: os itens da marca (C-59).
    select
      it.shopee_shop_id,
      null::bigint,
      coalesce(sum(it.quantity), 0),
      sum(it.receita_item),
      count(distinct it.order_sn) filter (where it.receita_item is null),
      null::numeric,
      null::bigint
    from public.shopee_sales_items it
    where v_recorte
      and it.organization_id = p_organization_id
      and it.shopee_shop_id in (select l.id from lojas l)
      and it.situacao = 'VALIDA'
      and it.shopee_created_at >= v_de
      and it.shopee_created_at < v_ate
      and (
        case when v_sem_marca
          then it.sku_id is null
               or not exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
    group by it.shopee_shop_id
  ),
  por_loja as (
    -- Loja cujos pedidos nunca foram lidos: NULO, nunca zero.
    select
      l.id,
      l.nome,
      l.environment,
      l.orders_last_success_at is not null as lida,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(vs.compras, 0) end::bigint as compras,
      case when l.orders_last_success_at is null then null else coalesce(vs.unidades, 0) end::bigint as unidades,
      case when l.orders_last_success_at is null then null else coalesce(vs.receita, 0) end as receita,
      case when l.orders_last_success_at is null then null else coalesce(vs.sem_receita, 0) end::bigint as sem_receita,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(vs.recebido, 0) end as recebido,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(vs.sem_recebido, 0) end::bigint as sem_recebido,
      l.orders_last_success_at as atualizado
    from lojas l
    left join vendas_shopee vs on vs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb, true as lida,
           c.compras, c.unidades, c.receita, 0::bigint as sem_receita, c.pedidos,
           null::numeric as recebido, null::bigint as sem_recebido, c.atualizado
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment, l.lida,
           l.compras, l.unidades, l.receita, l.sem_receita, null::bigint,
           l.recebido, l.sem_recebido, l.atualizado
    from por_loja l
  ),
  -- So o que e operacao: conta ML e loja live JA LIDA entram nas somas.
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.lida
  ),
  por_marketplace as (
    select
      s.mk,
      sum(s.compras)::bigint as compras,
      sum(s.unidades)::bigint as unidades,
      sum(s.receita) as receita,
      sum(s.sem_receita)::bigint as sem_receita,
      case when s.mk = 'ML' then sum(s.pedidos)::bigint end as pedidos,
      case when s.mk = 'SHOPEE' then sum(s.recebido) end as recebido,
      case when s.mk = 'SHOPEE' then sum(s.sem_recebido)::bigint end as sem_recebido,
      -- O elo mais fraco: a conta/loja menos atualizada do grupo.
      case when bool_or(s.atualizado is null) then null else min(s.atualizado) end as atualizado
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
    null::bigint,
    null::numeric,
    null::bigint,
    case when bool_or(p.atualizado is null) then null else min(p.atualizado) end
  from por_marketplace p
  having count(*) > 0

  union all

  select
    'MARKETPLACE', p.mk, null, null, null,
    p.compras, p.unidades, round(p.receita, 2), p.sem_receita,
    round(p.receita / nullif(p.compras - p.sem_receita, 0), 2),
    p.pedidos, round(p.recebido, 2), p.sem_recebido, p.atualizado
  from por_marketplace p

  union all

  select
    'CONTA', l.mk, l.id, l.nome, l.amb,
    l.compras, l.unidades, round(l.receita, 2), l.sem_receita,
    round(l.receita / nullif(l.compras - l.sem_receita, 0), 2),
    l.pedidos, round(l.recebido, 2), l.sem_recebido, l.atualizado
  from linhas_conta l;
end;
$$;

comment on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[], text, boolean) is
  'Vendas por marketplace e o consolidado, no SQL (D-436, C-53): linhas TOTAL, MARKETPLACE e CONTA. Somam compras (pack ML + pedido Shopee), unidades e receita bruta (pedidos Shopee de receita desconhecida a parte); ticket recalculado; pedidos ML e recebido Shopee so na linha do marketplace. Sandbox so em CONTA, nunca nas somas. p_marketplaces nulo = so ML; p_account_ids de marketplace_accounts. Recorte de marca (D-605, C-72): p_supplier_brand / p_sem_marca, no grao de SKU (daily_sku_metrics e shopee_sales_items); compras, ticket e recebido NULOS sob recorte.';

revoke all on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[], text, boolean) from public, anon;
grant execute on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[], text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 2. A serie diaria (C-53)
-- ------------------------------------------------------------
drop function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[]);

create function public.get_marketplace_sales_daily(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  dia date,
  marketplace text,
  compras bigint,
  unidades bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint
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
  v_sem_marca boolean := coalesce(p_sem_marca, false);
  v_recorte boolean := p_supplier_brand is not null or coalesce(p_sem_marca, false);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  return query
  with
  por_dia as (
    select m.metric_date as d, 'ML'::text as mk,
           sum(m.purchases_count)::bigint as compras,
           sum(m.units_sold)::bigint as unidades,
           sum(m.gross_revenue) as receita,
           0::bigint as sem_receita
    from public.daily_account_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where not v_recorte
      and 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
      and m.metric_date between p_date_from and p_date_to
    group by m.metric_date

    union all

    select m.metric_date, 'ML',
           null::bigint,
           sum(m.units_sold)::bigint,
           sum(m.gross_revenue),
           0::bigint
    from public.daily_sku_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where v_recorte
      and 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
      and m.metric_date between p_date_from and p_date_to
      and (
        case when v_sem_marca
          then m.sku_id is null
               or not exists (select 1 from public.skus s where s.id = m.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
    group by m.metric_date

    union all

    select v.dia, 'SHOPEE',
           count(*)::bigint,
           coalesce(sum(v.unidades), 0)::bigint,
           sum(v.receita_bruta),
           count(*) filter (where v.receita_bruta is null)::bigint
    from public.shopee_sales_orders v
    join public.shopee_shops s on s.id = v.shopee_shop_id
    where not v_recorte
      and 'SHOPEE' = any (v_marketplaces)
      and v.organization_id = p_organization_id
      and s.environment = 'live'
      and (p_account_ids is null or s.id = any (p_account_ids))
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by v.dia

    union all

    select it.dia, 'SHOPEE',
           null::bigint,
           coalesce(sum(it.quantity), 0)::bigint,
           sum(it.receita_item),
           count(distinct it.order_sn) filter (where it.receita_item is null)::bigint
    from public.shopee_sales_items it
    where v_recorte
      and 'SHOPEE' = any (v_marketplaces)
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.situacao = 'VALIDA'
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (
        case when v_sem_marca
          then it.sku_id is null
               or not exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
    group by it.dia
  )
  select p.d, p.mk, p.compras, p.unidades, round(p.receita, 2), p.sem_receita
  from por_dia p

  union all

  select p.d, null::text, sum(p.compras)::bigint, sum(p.unidades)::bigint, round(sum(p.receita), 2), sum(p.sem_receita)::bigint
  from por_dia p
  group by p.d

  order by 1, 2 nulls last;
end;
$$;

comment on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[], text, boolean) is
  'Serie diaria de vendas por marketplace e o total do dia (marketplace NULO), no SQL (D-436, C-53): compras, unidades, receita bruta e pedidos Shopee de receita desconhecida. So loja live; so dias com venda. p_marketplaces nulo = so ML. Recorte de marca (D-605, C-72) no grao de SKU; compras NULAS sob recorte.';

revoke all on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[], text, boolean) from public, anon;
grant execute on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[], text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 3. O hoje (C-70)
-- ------------------------------------------------------------
drop function public.get_marketplace_sales_today(uuid, date, text[], uuid[]);

create function public.get_marketplace_sales_today(
  p_organization_id uuid,
  p_date date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
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
  v_sem_marca boolean := coalesce(p_sem_marca, false);
  v_recorte boolean := p_supplier_brand is not null or coalesce(p_sem_marca, false);
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
  itens_ml as materialized (
    -- Os itens do recorte; sem recorte, todos (e a receita vem do pedido).
    select p.ml_account_id, p.id as order_id, p.date_created, oi.quantity, oi.unit_price
    from pedidos_ml p
    join public.order_items oi on oi.order_id = p.id
    where not v_recorte
       or (
         case when v_sem_marca
           then oi.sku_id is null
                or not exists (select 1 from public.skus s where s.id = oi.sku_id and s.supplier_brand is not null)
           else exists (select 1 from public.skus s where s.id = oi.sku_id and s.supplier_brand = p_supplier_brand)
         end
       )
  ),
  totais_ml as (
    -- Sem recorte: receita e compras nos PEDIDOS (o contrato de sempre).
    select
      p.ml_account_id,
      count(distinct case when p.pack_id is null then 'pedido:' || p.id::text else 'pack:' || p.pack_id::text end)::bigint as compras,
      sum(p.total_amount) as receita,
      max(p.date_created) as ultimo
    from pedidos_ml p
    where not v_recorte
    group by p.ml_account_id

    union all

    -- Com recorte: a receita pela decomposicao em itens; compras de fora.
    select i.ml_account_id, null::bigint, sum(i.quantity * i.unit_price), max(i.date_created)
    from itens_ml i
    where v_recorte
    group by i.ml_account_id
  ),
  unidades_ml as (
    select i.ml_account_id, sum(i.quantity)::bigint as unidades
    from itens_ml i
    group by i.ml_account_id
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      case when v_recorte then null else coalesce(t.compras, 0) end::bigint as compras,
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
    where not v_recorte
      and v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= v_de
      and v.shopee_created_at < v_ate
    group by v.shopee_shop_id

    union all

    select
      it.shopee_shop_id,
      null::bigint,
      coalesce(sum(it.quantity), 0),
      sum(it.receita_item),
      count(distinct it.order_sn) filter (where it.receita_item is null),
      max(it.shopee_created_at)
    from public.shopee_sales_items it
    where v_recorte
      and it.organization_id = p_organization_id
      and it.shopee_shop_id in (select l.id from lojas l)
      and it.situacao = 'VALIDA'
      and it.shopee_created_at >= v_de
      and it.shopee_created_at < v_ate
      and (
        case when v_sem_marca
          then it.sku_id is null
               or not exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s where s.id = it.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
    group by it.shopee_shop_id
  ),
  por_loja as (
    -- Loja cujos pedidos nunca foram lidos: NULO, nunca zero.
    select
      l.id,
      l.nome,
      l.environment,
      l.orders_last_success_at is not null as lida,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(vs.compras, 0) end::bigint as compras,
      case when l.orders_last_success_at is null then null else coalesce(vs.unidades, 0) end::bigint as unidades,
      case when l.orders_last_success_at is null then null else coalesce(vs.receita, 0) end as receita,
      case when l.orders_last_success_at is null then null else coalesce(vs.sem_receita, 0) end::bigint as sem_receita,
      vs.ultimo,
      l.orders_synced_until as lido
    from lojas l
    left join vendas_shopee vs on vs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb, true as lida,
           c.compras, c.unidades, c.receita, 0::bigint as sem_receita, c.ultimo, null::timestamptz as lido
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment, l.lida, l.compras, l.unidades, l.receita, l.sem_receita, l.ultimo, l.lido
    from por_loja l
  ),
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.lida
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

comment on function public.get_marketplace_sales_today(uuid, date, text[], uuid[], text, boolean) is
  'Vendas do dia ao vivo, por marketplace e o consolidado (D-603, C-70): linhas TOTAL, MARKETPLACE e CONTA, como o C-53. ML de orders (as definicoes de get_sales_today_summary); Shopee das vendas validas do dia de shopee_sales_orders, com lido_ate = orders_synced_until (o elo mais fraco no MARKETPLACE e no TOTAL). ultimo_pedido_em = a venda mais recente. Sandbox so em CONTA; loja nunca lida NULA. Recorte de marca (D-605, C-72): pelos itens, compras e ticket NULOS. security invoker.';

revoke all on function public.get_marketplace_sales_today(uuid, date, text[], uuid[], text, boolean) from public, anon;
grant execute on function public.get_marketplace_sales_today(uuid, date, text[], uuid[], text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. O cancelamento (C-70): NULO sob recorte de marca (D-237), sem ler
--    `orders` -- o pedido cancelado inteiro nao tem cota de marca.
-- ------------------------------------------------------------
drop function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[]);

create function public.get_marketplace_sales_cancellations(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
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
  v_recorte boolean := p_supplier_brand is not null or coalesce(p_sem_marca, false);
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
    where not v_recorte
      and o.organization_id = p_organization_id
      and o.date_created >= v_de
      and o.date_created < v_ate
      and o.ml_account_id in (select c.id from contas_ml c)
    group by o.ml_account_id, coalesce('pack:' || o.pack_id::text, 'pedido:' || o.id::text)
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      case when v_recorte then null else count(*) filter (where k.valida) end::bigint as validas,
      case when v_recorte then null else count(*) filter (where k.cancelada and not k.valida) end::bigint as canceladas
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
    where not v_recorte
      and o.organization_id = p_organization_id
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
      l.orders_last_success_at is not null as lida,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(cs.validas, 0) end::bigint as validas,
      case when l.orders_last_success_at is null or v_recorte then null else coalesce(cs.canceladas, 0) end::bigint as canceladas
    from lojas l
    left join canc_shopee cs on cs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb, true as lida, c.validas, c.canceladas
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment, l.lida, l.validas, l.canceladas
    from por_loja l
  ),
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.lida
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

comment on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[], text, boolean) is
  'Taxa de cancelamento por COMPRA, por marketplace e o consolidado (D-603, C-70): linhas TOTAL, MARKETPLACE e CONTA, como o C-53. Compra = pack do ML (valida se algum pedido vale, cancelada se todos foram cancelados, cancelled/pending_cancel) ou pedido da Shopee (situacao de shopee_sales_orders). Taxa = canceladas / (validas + canceladas). Sandbox so em CONTA; loja nunca lida NULA. Sob recorte de marca (D-605, C-72) tudo NULO, sem ler orders (D-237). security invoker.';

revoke all on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[], text, boolean) from public, anon;
grant execute on function public.get_marketplace_sales_cancellations(uuid, date, date, text[], uuid[], text, boolean) to authenticated;
