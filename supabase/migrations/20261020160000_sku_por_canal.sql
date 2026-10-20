-- ============================================================
-- D-607 -- o SKU com a Shopee: o dia a dia por canal e os pedidos da Shopee
-- com o SKU (contrato C-71, item 4 (b) das decisoes do dono, escolhido em
-- 20/10; o desenho e o pedido do A2 para a aba Vendas de /skus/[id], D-618).
--
-- O GRAO E O DO C-59 (D-439): o `sku_id` gravado no item. No ML,
-- `daily_sku_metrics`; na Shopee, `shopee_sales_items` com a situacao VALIDA.
-- O kit conta como o kit: a pagina de um componente nao ve a venda do kit
-- que o contem, nos dois canais -- e o que o C-59 ja mostra.
--
-- 1. get_sku_sales_daily_by_marketplace -- uma linha por dia com venda em
--    algum canal: o ML e a Shopee lado a lado e o total do dia, somado no SQL.
--    Canal sem venda no dia e NULO (nunca zero); dia sem venda nenhuma nao
--    aparece. A loja de teste fica fora (como o TOTAL do C-59). A receita do
--    dia e NULA quando nenhum lado tem receita conhecida (so itens Shopee de
--    preco 0, contados em `itens_shopee_sem_receita`).
-- 2. get_shopee_orders ganha `p_sku_id` NO FIM (nulo = a lista de hoje).
--    Com valor, so os pedidos com algum item do SKU, e tres colunas: `dia`
--    (a data do pedido em Sao Paulo, sempre preenchida, para o link da D-614),
--    `unidades_do_sku` e `receita_do_sku` (somadas so nos itens do SKU; a
--    receita NULA se algum item do SKU no pedido tem preco 0). O resto igual:
--    todas as situacoes, a permissao por loja, paginas de ate 200 com
--    total_count. Vira plpgsql com plano custom: o "nulo ou valor" de cada
--    filtro degrada no plano generico (D-305, D-469). A faixa em timestamptz,
--    equivalente ao `dia`, entra para o indice (organization_id,
--    shopee_created_at) valer; o filtro pelo `dia` fica, como a regra.
-- ============================================================

create function public.get_sku_sales_daily_by_marketplace(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  dia date,
  unidades_ml bigint,
  receita_ml numeric,
  unidades_shopee bigint,
  receita_shopee numeric,
  itens_shopee_sem_receita bigint,
  unidades bigint,
  receita_bruta numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  ml as (
    -- A mesma fonte e o mesmo filtro do C-59 (por conta) e de
    -- get_sku_sales_breakdown (por dia).
    select m.metric_date as dia, sum(m.units_sold)::bigint as unidades, sum(m.gross_revenue) as receita
    from public.daily_sku_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where a.organization_id = p_organization_id
      and m.sku_id = p_sku_id
      and m.metric_date between p_date_from and p_date_to
    group by m.metric_date
  ),
  shopee as (
    select
      it.dia,
      sum(it.quantity)::bigint as unidades,
      sum(it.receita_item) as receita,
      count(*) filter (where it.receita_item is null)::bigint as sem_receita
    from public.shopee_sales_items it
    where it.organization_id = p_organization_id
      and it.sku_id = p_sku_id
      and it.situacao = 'VALIDA'
      and it.environment = 'live'
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.dia
  )
  select
    coalesce(ml.dia, s.dia),
    ml.unidades,
    round(ml.receita, 2),
    s.unidades,
    round(s.receita, 2),
    s.sem_receita,
    (coalesce(ml.unidades, 0) + coalesce(s.unidades, 0))::bigint,
    case when ml.receita is null and s.receita is null then null
         else round(coalesce(ml.receita, 0) + coalesce(s.receita, 0), 2) end
  from ml
  full join shopee s on s.dia = ml.dia
  order by 1;
end;
$$;

comment on function public.get_sku_sales_daily_by_marketplace(uuid, uuid, date, date) is
  'O dia a dia de um SKU por canal (D-607, C-71): uma linha por dia com venda em algum canal -- o ML (daily_sku_metrics) e a Shopee (shopee_sales_items VALIDA, so lojas live) lado a lado e o total do dia somado no SQL. Canal sem venda no dia NULO; dia sem venda nao aparece; receita do dia NULA sem receita conhecida. O grao e o sku_id do item (o kit como o kit), o do C-59. security invoker.';

revoke all on function public.get_sku_sales_daily_by_marketplace(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_sku_sales_daily_by_marketplace(uuid, uuid, date, date) to authenticated;

drop function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text);

create function public.get_shopee_orders(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_shopee_shop_id uuid default null,
  p_situacao text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  -- D-467: o pedido que a Busca Universal abriu (o order_sn exato, sem
  -- diferenciar maiuscula). NULO = a lista de sempre.
  p_order_sn text default null,
  -- D-607: so os pedidos com algum item deste SKU. NULO = a lista de sempre.
  p_sku_id uuid default null
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  order_sn text,
  order_status text,
  situacao text,
  shopee_created_at timestamptz,
  unidades bigint,
  receita_bruta numeric,
  recebido numeric,
  financeiro_lido boolean,
  com_devolucao boolean,
  itens jsonb,
  total_count bigint,
  dia date,
  unidades_do_sku bigint,
  receita_do_sku numeric
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
#variable_conflict use_column
begin
  return query
  select
    v.shopee_shop_id, v.shop_name, v.environment, v.order_sn, v.order_status, v.situacao, v.shopee_created_at,
    v.unidades, v.receita_bruta, v.recebido, v.financeiro_lido, v.com_devolucao, v.resumo,
    count(*) over (),
    v.dia,
    sku.unidades,
    sku.receita
  from public.shopee_sales_orders v
  left join lateral (
    select
      sum(i.quantity)::bigint as unidades,
      case when bool_and(i.discounted_price > 0) then round(sum(i.discounted_price * i.quantity), 2) end as receita
    from public.shopee_order_items i
    where p_sku_id is not null
      and i.shopee_shop_id = v.shopee_shop_id
      and i.order_sn = v.order_sn
      and i.sku_id = p_sku_id
  ) sku on true
  where v.organization_id = p_organization_id
    and v.dia between p_date_from and p_date_to
    and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
    and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    and (p_shopee_shop_id is null or v.shopee_shop_id = p_shopee_shop_id)
    and (p_situacao is null or v.situacao = p_situacao)
    and (nullif(btrim(p_order_sn), '') is null or upper(v.order_sn) = upper(btrim(p_order_sn)))
    and (p_sku_id is null or exists (
      select 1 from public.shopee_order_items i
      where i.organization_id = p_organization_id
        and i.sku_id = p_sku_id
        and i.shopee_shop_id = v.shopee_shop_id
        and i.order_sn = v.order_sn
    ))
  order by v.shopee_created_at desc, v.order_sn
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$fn$;

comment on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text, uuid) is
  'Pedidos Shopee no periodo (D-430), mais novos primeiro, com situacao, receita bruta, recebido, financeiro lido, devolucao, os itens com o SKU gravado e o dia (Sao Paulo); filtro por loja, situacao, pedido (p_order_sn, D-467) e SKU (p_sku_id, D-607: so os pedidos com item do SKU, com unidades_do_sku e receita_do_sku, NULAS sem ele); paginada (ate 200) com total_count.';

revoke all on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text, uuid) from public, anon;
grant execute on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text, uuid) to authenticated;
