-- ============================================================
-- C-83 (D-639) -- o diagnostico de venda por canal: o Mercado Livre e a Shopee.
--
-- As tres funcoes do diagnostico (o /diagnostico, o diagnostico do SKU e o
-- worker da venda anomala) so conheciam o ML. Pedido do A2 (C-11); decisao do
-- dono em 22/10: o detector avalia CADA CANAL separado -- uma queda no ML vira
-- alerta mesmo que a Shopee compense, e o alerta diz o canal.
--
-- O padrao do C-60: `p_marketplaces text[]` no fim ('ML' e/ou 'SHOPEE'); NULO
-- = so o ML, o resultado de antes. Lista vazia ou valor fora da lista e
-- recusado. Cada funcao ganha a coluna `marketplace` no fim.
--
-- - `get_sku_sales_baseline`: a linha de base por SKU, dia da semana E canal.
--   Na Shopee, `shopee_sales_items` com a situacao VALIDA e so a loja live (o
--   sandbox nunca entra), somada entre as lojas por dia -- o mesmo grao do ML,
--   que soma entre as contas.
-- - `get_sku_average_prices`: o preco medio por canal, pelo mesmo metodo (a
--   media dos precos medios do dia); na Shopee, so os itens com a receita
--   conhecida.
-- - `get_sku_correlated_events`: os eventos do SKU (sem canal: valem para os
--   dois, `marketplace` NULO), os do anuncio e do pedido do ML, e a mudanca de
--   preco do anuncio da Shopee (C-81), ligada ao SKU pela unidade
--   (`shopee_listing_units`). A Shopee nao grava evento de cancelamento ou
--   devolucao: nao ha o que correlacionar dela alem do preco.
-- ============================================================

drop function public.get_sku_sales_baseline(uuid, date, uuid);

create function public.get_sku_sales_baseline(
  p_organization_id uuid,
  p_as_of date,
  p_sku_id uuid default null,
  p_marketplaces text[] default null
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  weekday smallint,
  current_units_sold bigint,
  baseline_mean numeric,
  baseline_stddev numeric,
  sample_count bigint,
  marketplace text
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'p_marketplaces deve ter ML e/ou SHOPEE (veio %)', p_marketplaces;
  end if;

  return query
  with daily_totals as materialized (
    -- Soma ENTRE CONTAS (ou entre lojas) por (canal, sku_id, dia) antes de
    -- qualquer janela -- um SKU vendido em duas contas no mesmo dia e UMA
    -- ocorrencia. D-183: o filtro de dia da semana fica aqui, antes do agregado.
    select 'ML'::text as canal, m.sku_id, m.metric_date, sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where 'ML' = any(v_marketplaces)
      and m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date <= p_as_of
      and extract(dow from m.metric_date) = extract(dow from p_as_of)
    group by m.sku_id, m.metric_date

    union all

    -- A Shopee pela mesma regra das outras leituras dela: a venda VALIDA da
    -- loja live, no dia da venda.
    select 'SHOPEE'::text, it.sku_id, it.dia, sum(it.quantity)
    from public.shopee_sales_items it
    where 'SHOPEE' = any(v_marketplaces)
      and it.organization_id = p_organization_id
      and it.sku_id is not null
      and (p_sku_id is null or it.sku_id = p_sku_id)
      and it.situacao = 'VALIDA'
      and it.environment = 'live'
      and it.dia <= p_as_of
      and extract(dow from it.dia) = extract(dow from p_as_of)
    group by it.sku_id, it.dia
  ),
  weekday_history as (
    select
      d.canal,
      d.sku_id,
      d.units_sold,
      row_number() over (partition by d.canal, d.sku_id order by d.metric_date desc) as recency_rank
    from daily_totals d
    where d.metric_date < p_as_of
  ),
  baseline as (
    select
      w.canal,
      w.sku_id,
      avg(w.units_sold) as baseline_mean,
      stddev_samp(w.units_sold) as baseline_stddev,
      count(*) as sample_count
    from weekday_history w
    where w.recency_rank <= 8
    group by w.canal, w.sku_id
  ),
  current_day as materialized (
    -- `as materialized` NAO e estilo (D-183): inlineado, este CTE vira o lado
    -- interno do `left join` abaixo e e re-executado uma vez por SKU.
    select d.canal, d.sku_id, d.units_sold
    from daily_totals d
    where d.metric_date = p_as_of
  )
  select
    sk.id as sku_id,
    sk.sku,
    sk.title,
    extract(dow from p_as_of)::smallint as weekday,
    coalesce(cd.units_sold, 0)::bigint as current_units_sold,
    round(b.baseline_mean, 2) as baseline_mean,
    round(coalesce(b.baseline_stddev, 0), 2) as baseline_stddev,
    b.sample_count,
    b.canal as marketplace
  from baseline b
  join public.skus sk on sk.id = b.sku_id
  left join current_day cd on cd.sku_id = b.sku_id and cd.canal = b.canal
  -- Amostra minima de 4 ocorrencias do mesmo dia da semana, por canal (D-063).
  where b.sample_count >= 4;
end;
$fn$;

comment on function public.get_sku_sales_baseline(uuid, date, uuid, text[]) is
  'Baseline de vendas por dia da semana (D-063), por canal desde o C-83 (p_marketplaces ML e/ou SHOPEE; nulo = so o ML). D-183: `daily_totals` e `current_day` sao materializados de proposito.';

revoke all on function public.get_sku_sales_baseline(uuid, date, uuid, text[]) from public, anon;
grant execute on function public.get_sku_sales_baseline(uuid, date, uuid, text[]) to authenticated, service_role;

drop function public.get_sku_average_prices(uuid, uuid[], date, date);

create function public.get_sku_average_prices(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null
)
returns table (sku_id uuid, average_price numeric, marketplace text)
language plpgsql
stable
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'p_marketplaces deve ter ML e/ou SHOPEE (veio %)', p_marketplaces;
  end if;

  return query
  select m.sku_id, round(avg(m.average_selling_price), 2), 'ML'::text
  from public.daily_sku_metrics m
  where 'ML' = any(v_marketplaces)
    and m.organization_id = p_organization_id
    and m.sku_id = any(p_sku_ids)
    and m.metric_date between p_date_from and p_date_to
    and m.average_selling_price is not null
  group by m.sku_id

  union all

  -- O mesmo metodo do ML: a media dos precos medios de cada dia. Na Shopee, o
  -- preco do dia e a receita conhecida sobre as unidades desses itens.
  select d.sku_id, round(avg(d.preco_do_dia), 2), 'SHOPEE'::text
  from (
    select it.sku_id, it.dia,
           sum(it.receita_item) / nullif(sum(it.quantity) filter (where it.receita_item is not null), 0) as preco_do_dia
    from public.shopee_sales_items it
    where 'SHOPEE' = any(v_marketplaces)
      and it.organization_id = p_organization_id
      and it.sku_id = any(p_sku_ids)
      and it.situacao = 'VALIDA'
      and it.environment = 'live'
      and it.dia between p_date_from and p_date_to
    group by it.sku_id, it.dia
  ) d
  where d.preco_do_dia is not null
  group by d.sku_id;
end;
$fn$;

comment on function public.get_sku_average_prices(uuid, uuid[], date, date, text[]) is
  'Preco medio do SKU no periodo (D-064), por canal desde o C-83 (p_marketplaces ML e/ou SHOPEE; nulo = so o ML): a media dos precos medios do dia; na Shopee, so os itens com a receita conhecida.';

revoke all on function public.get_sku_average_prices(uuid, uuid[], date, date, text[]) from public, anon;
grant execute on function public.get_sku_average_prices(uuid, uuid[], date, date, text[]) to authenticated, service_role;

drop function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.get_sku_correlated_events(p_organization_id uuid, p_sku_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone, p_marketplaces text[] DEFAULT NULL::text[])
 RETURNS TABLE(sku_id uuid, event_type text, occurred_at timestamp with time zone, marketplace text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'p_marketplaces deve ter ML e/ou SHOPEE (veio %)', p_marketplaces;
  end if;

  return query
  with candidates as (select unnest(p_sku_ids) as sku_id),
  eventos_pedido as materialized (
    -- Os cancelamentos e devoluções da janela, com o id do pedido como
    -- número só quando cabe em bigint (o CASE avalia na ordem).
    select e.event_type, e.occurred_at,
      case
        when e.entity_id ~ '^[0-9]{1,19}$'
         and (length(e.entity_id) < 19 or e.entity_id <= '9223372036854775807')
        then e.entity_id::bigint
      end as order_id
    from public.domain_events e
    where 'ML' = any(v_marketplaces)
      and e.organization_id = p_organization_id
      and e.entity_type = 'order'
      and e.event_type in ('order.cancelled', 'order.returned')
      and e.occurred_at >= p_from and e.occurred_at < p_to
  ),
  itens as (
    -- Só os itens DESSES pedidos, pelo índice (order_id, position).
    select oi.order_id, oi.sku_id
    from public.order_items oi
    where oi.order_id = any (array(
        select ev.order_id from eventos_pedido ev where ev.order_id is not null
      ))
      and oi.sku_id = any (p_sku_ids)
  ),
  correlacionados as (
    -- Os eventos do SKU nao tem canal: valem para os dois (`marketplace` nulo).
    select c.sku_id, e.event_type, e.occurred_at, null::text as canal
    from public.domain_events e
    join candidates c on c.sku_id::text = e.entity_id
    where e.organization_id = p_organization_id
      and e.entity_type = 'sku'
      and e.occurred_at >= p_from and e.occurred_at < p_to

    union all

    select l.sku_id, e.event_type, e.occurred_at, 'ML'::text
    from public.domain_events e
    join public.listings l
      on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
    join candidates c on c.sku_id = l.sku_id
    where 'ML' = any(v_marketplaces)
      and e.organization_id = p_organization_id
      and e.entity_type = 'listing'
      and e.event_type in (
        'listing.price.changed',
        'listing.title.changed',
        'listing.status.paused',
        'listing.status.reactivated',
        'listing.fulfillment.entered')
      and e.occurred_at >= p_from and e.occurred_at < p_to

    union all

    select distinct i.sku_id, ev.event_type, ev.occurred_at, 'ML'::text
    from eventos_pedido ev
    join itens i on i.order_id = ev.order_id

    union all

    -- C-83: a mudanca de preco do anuncio da Shopee (C-81), ligada ao SKU pela
    -- unidade (o item, ou o item e a variacao) com o vinculo resolvido. O cast
    -- so no id numerico.
    select u.sku_id, e.event_type, e.occurred_at, 'SHOPEE'::text
    from public.domain_events e
    join public.shopee_listing_units u
      on u.shopee_shop_id = e.shopee_shop_id
     and u.item_id = case when e.entity_id ~ '^[0-9]{1,18}$' then e.entity_id::bigint end
     and u.model_id is not distinct from case when (e.after ->> 'model_id') ~ '^[0-9]{1,18}$' then (e.after ->> 'model_id')::bigint end
    join candidates c on c.sku_id = u.sku_id
    where 'SHOPEE' = any(v_marketplaces)
      and e.organization_id = p_organization_id
      and e.shopee_shop_id is not null
      and e.entity_type = 'shopee_item'
      and e.event_type = 'listing.price.changed'
      and e.occurred_at >= p_from and e.occurred_at < p_to
  )
  select r.sku_id, r.event_type, r.occurred_at, r.canal
  from correlacionados r
  order by r.occurred_at, r.sku_id, r.event_type, r.canal nulls first;
end;
$function$;

comment on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz, text[]) is
  'Eventos correlacionados ao SKU na janela (D-152), por canal desde o C-83 (p_marketplaces ML e/ou SHOPEE; nulo = so o ML): os do SKU com marketplace nulo, os do anuncio e do pedido do ML, e a mudanca de preco do anuncio da Shopee.';

revoke all on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz, text[]) from public, anon;
grant execute on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz, text[]) to authenticated, service_role;
