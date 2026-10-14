-- ============================================================
-- D-439 -- vendas por SKU entre marketplaces (etapa E6a da frente
-- multicanal; contrato C-59 para ranking e a aba Vendas do SKU).
--
-- O grao de SKU do ML ja existe: `daily_sku_metrics` (conta, SKU com o balde
-- nulo, dia). O da Shopee nao existia -- o pedido Shopee tem varios itens e a
-- receita bruta de 5S e do PEDIDO. Aqui ele nasce como definicao unica:
--
-- `shopee_sales_items` (view, security_invoker): uma linha por item dos
-- pedidos Shopee, com a situacao e o dia do pedido herdados de
-- `shopee_sales_orders` (D-430, sem repetir a regra) e a RECEITA DO ITEM =
-- preco com o desconto da loja x quantidade. Item de preco 0 (bundle deal)
-- tem receita DESCONHECIDA (NULO), contada a parte -- nunca zero. O SKU e o
-- gravado no item (D-430).
--
-- O que soma por SKU entre os canais: unidades, receita bruta (o preco de
-- linha do ML -- uma linha por pedido, 5.2 -- e o do item da Shopee) e
-- compras (o pack do ML e o pedido Shopee que contem o SKU). Sandbox nunca
-- soma. As RPCs do ML nao mudam: a parte ML le `daily_sku_metrics`, a mesma
-- fonte de `get_sku_sales_breakdown` e `get_sales_top_skus`.
--
-- Fica para depois (E6b/E6c): curva ABC, ranking com resultado/margem e o
-- /produtos com a Shopee (C-56) -- sao RPCs grandes do ML com regras proprias.
-- ============================================================

create or replace view public.shopee_sales_items
with (security_invoker = true)
as
select
  v.organization_id,
  v.shopee_shop_id,
  v.environment,
  v.order_sn,
  v.situacao,
  v.dia,
  v.shopee_created_at,
  i.position,
  i.sku_id,
  i.quantity,
  case when i.discounted_price > 0 then i.discounted_price * i.quantity end as receita_item
from public.shopee_sales_orders v
join public.shopee_order_items i
  on i.shopee_shop_id = v.shopee_shop_id and i.order_sn = v.order_sn;

comment on view public.shopee_sales_items is
  'Item de pedido Shopee com a situacao e o dia do pedido (de shopee_sales_orders, D-430) e a receita do item = preco com o desconto da loja x quantidade; preco 0 (bundle) = receita NULA (D-439). O grao de SKU da Shopee.';

revoke all on public.shopee_sales_items from anon, authenticated;
grant select on public.shopee_sales_items to authenticated;
grant select on public.shopee_sales_items to service_role;

-- ------------------------------------------------------------
-- Vendas por SKU entre os marketplaces, com o total no SQL, para ranking.
-- Uma linha por SKU (e o balde sem SKU, sku_id NULO), colunas por
-- marketplace e o total. Ordem: receita ou unidades, decrescente.
-- ------------------------------------------------------------
create or replace function public.get_marketplace_sku_sales(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_sku_ids uuid[] default null,
  p_ordem text default 'receita',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  sku_title text,
  unidades_ml bigint,
  receita_ml numeric,
  compras_ml bigint,
  unidades_shopee bigint,
  receita_shopee numeric,
  itens_shopee_sem_receita bigint,
  compras_shopee bigint,
  unidades bigint,
  receita_bruta numeric,
  compras bigint,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  if coalesce(p_ordem, 'receita') not in ('receita', 'unidades') then
    raise exception 'ordem invalida: % (use receita ou unidades)', p_ordem;
  end if;

  return query
  with
  ml as (
    select m.sku_id,
           sum(m.units_sold)::bigint as unidades,
           sum(m.gross_revenue) as receita,
           sum(m.purchases_count)::bigint as compras
    from public.daily_sku_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
      and (p_sku_ids is null or m.sku_id = any (p_sku_ids))
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  shopee as (
    select it.sku_id,
           sum(it.quantity)::bigint as unidades,
           sum(it.receita_item) as receita,
           count(*) filter (where it.receita_item is null)::bigint as sem_receita,
           count(distinct (it.shopee_shop_id, it.order_sn))::bigint as compras
    from public.shopee_sales_items it
    where 'SHOPEE' = any (v_marketplaces)
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and (p_sku_ids is null or it.sku_id = any (p_sku_ids))
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id
  ),
  juntos as (
    -- O balde sem SKU (NULO) dos dois lados fica numa linha so. FULL JOIN
    -- exige igualdade comum ("is not distinct from" e recusado): o nulo vira
    -- um sentinela que nenhum uuid real e, so para casar.
    select
      coalesce(ml.sku_id, sh.sku_id) as sku_id,
      ml.unidades as unidades_ml, ml.receita as receita_ml, ml.compras as compras_ml,
      sh.unidades as unidades_shopee, sh.receita as receita_shopee, sh.sem_receita, sh.compras as compras_shopee
    from ml
    full join shopee sh
      on coalesce(sh.sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(ml.sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  totais as (
    select
      j.*,
      (coalesce(j.unidades_ml, 0) + coalesce(j.unidades_shopee, 0))::bigint as unidades,
      -- Receita conhecida dos dois lados; o desconhecido da Shopee esta em
      -- itens_shopee_sem_receita. Sem nenhuma receita conhecida: NULO.
      case when j.receita_ml is null and j.receita_shopee is null then null
           else coalesce(j.receita_ml, 0) + coalesce(j.receita_shopee, 0) end as receita,
      (coalesce(j.compras_ml, 0) + coalesce(j.compras_shopee, 0))::bigint as compras
    from juntos j
  )
  select
    t.sku_id, s.sku, s.title,
    t.unidades_ml, round(t.receita_ml, 2), t.compras_ml,
    t.unidades_shopee, round(t.receita_shopee, 2), t.sem_receita, t.compras_shopee,
    t.unidades, round(t.receita, 2), t.compras,
    count(*) over ()
  from totais t
  left join public.skus s on s.id = t.sku_id
  order by
    case when coalesce(p_ordem, 'receita') = 'receita' then t.receita end desc nulls last,
    t.unidades desc,
    s.sku nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer) is
  'Vendas por SKU entre marketplaces (D-439, C-59): unidades, receita bruta e compras por marketplace e o total no SQL; o balde sem SKU (sku_id NULO) numa linha; itens Shopee de receita desconhecida contados; sandbox fora; paginada (ate 500) com total_count. p_marketplaces nulo = so ML.';

revoke all on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer) from public, anon;
grant execute on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- As vendas de UM SKU por conta e por loja (a aba Vendas da pagina do SKU):
-- uma linha por conta ML e por loja Shopee (sandbox com a marca) e a do
-- TOTAL (so o que e operacao).
-- ------------------------------------------------------------
create or replace function public.get_sku_sales_by_marketplace_account(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  nivel text,
  marketplace text,
  account_id uuid,
  account_name text,
  environment text,
  unidades bigint,
  receita_bruta numeric,
  itens_sem_receita bigint,
  compras bigint,
  preco_medio numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  contas as (
    select 'ML'::text as mk, m.ml_account_id as id, a.label as nome, 'live'::text as amb,
           sum(m.units_sold)::bigint as unidades, sum(m.gross_revenue) as receita,
           0::bigint as sem_receita, sum(m.purchases_count)::bigint as compras
    from public.daily_sku_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where a.organization_id = p_organization_id
      and m.sku_id = p_sku_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, a.label

    union all

    select 'SHOPEE', it.shopee_shop_id, coalesce(sh.shop_name, 'Loja Shopee ' || sh.shop_id::text), it.environment,
           sum(it.quantity)::bigint, sum(it.receita_item),
           count(*) filter (where it.receita_item is null)::bigint,
           count(distinct it.order_sn)::bigint
    from public.shopee_sales_items it
    join public.shopee_shops sh on sh.id = it.shopee_shop_id
    where it.organization_id = p_organization_id
      and it.sku_id = p_sku_id
      and it.situacao = 'VALIDA'
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.shopee_shop_id, sh.shop_name, sh.shop_id, it.environment
  )
  select 'TOTAL'::text, null::text, null::uuid, null::text, null::text,
         sum(c.unidades)::bigint, round(sum(c.receita), 2), sum(c.sem_receita)::bigint, sum(c.compras)::bigint,
         -- Preco medio so sem item de receita desconhecida: dividir a receita
         -- conhecida por todas as unidades daria um preco falso.
         case when sum(c.sem_receita) = 0 then round(sum(c.receita) / nullif(sum(c.unidades), 0), 2) end
  from contas c
  where c.amb = 'live'
  having count(*) > 0

  union all

  select 'CONTA', c.mk, c.id, c.nome, c.amb,
         c.unidades, round(c.receita, 2), c.sem_receita, c.compras,
         case when c.sem_receita = 0 then round(c.receita / nullif(c.unidades, 0), 2) end
  from contas c;
end;
$$;

comment on function public.get_sku_sales_by_marketplace_account(uuid, uuid, date, date) is
  'As vendas de um SKU por conta ML e loja Shopee (D-439, C-59): unidades, receita bruta, itens Shopee de receita desconhecida, compras e preco medio; a linha TOTAL so com o que e operacao (sandbox fora). A parte ML e a de get_sku_sales_breakdown.';

revoke all on function public.get_sku_sales_by_marketplace_account(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_sku_sales_by_marketplace_account(uuid, uuid, date, date) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (5S e 5T): a receita do item Shopee e o grao
-- de SKU das metricas do consolidado.
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_receita_item', 'Receita do item na Shopee',
   'SUM(discounted_price x quantity) dos itens de pedidos validos',
   'shopee_sales_items (shopee_order_items, shopee_sales_orders)', array['sku', 'account', 'organization'],
   'O preco do item com o desconto da loja, sem frete, como o pedido o trouxe -- o grao de SKU da receita bruta da Shopee (5S).',
   'Item de preco 0 (bundle deal): receita DESCONHECIDA (NULO), contada a parte, nunca zero. Pedido cancelado, em cancelamento ou nao pago. Sandbox nunca soma.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');

update public.metric_definitions
   set granularities = array['sku', 'account', 'organization'],
       inclusions = inclusions || ' No grao de SKU (D-439): o ML por daily_sku_metrics e a Shopee pelo item (shopee_receita_item), com o balde sem SKU.',
       definition_updated_on = date '2026-10-14'
 where id in ('multicanal_compras', 'multicanal_unidades', 'multicanal_receita_bruta');
