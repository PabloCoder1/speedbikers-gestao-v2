-- ============================================================
-- D-493 (C-67) -- as vendas por anuncio da Shopee
--
-- Decisao do dono (19/10): a /anuncios/shopee mostra quanto cada anuncio
-- vendeu, no desenho do get_listings_dashboard do ML (D-385).
--
-- 1. shopee_sales_items (D-439) ganha item_id e model_id NO FIM: a venda
--    casa com a linha do anuncio por (loja, item, variacao). Na leitura real
--    (19/10), o item sem variacao tem model_id NULO no pedido e no anuncio --
--    nenhum 0 --, entao o casamento compara a variacao com NULO = 0, por
--    igualdade (para o planejador poder usar hash).
-- 2. get_shopee_listings ganha, no FIM, p_date_from/p_date_to (o dia do
--    pedido em Sao Paulo), p_vendeu ('com' | 'sem') e p_ordem ('vendas' |
--    'receita'), todos com default nulo -- nulo e o comportamento de hoje --,
--    e as colunas unidades_vendidas, receita_bruta, pedidos,
--    unidades_sem_receita e o recorte inteiro (antes do limite). Venda e a do
--    C-59: pedido VALIDA (C-53) e receita do item = preco com o desconto da
--    loja x quantidade; preco 0 = desconhecida, fora da soma e contada.
--    Sem periodo, as colunas novas vem NULAS e vendeu/ordem sao recusados.
-- Drop + create (parametros e colunas novas); o filtro, a busca e a ordem de
-- sempre sao os da D-429. A tela manda os parametros so com valor, depois
-- desta migration em producao (PGRST202).
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
  case when i.discounted_price > 0 then i.discounted_price * i.quantity end as receita_item,
  -- D-493: o anuncio vendido (o model_id e NULO no item sem variacao, como na
  -- linha do anuncio), para as vendas por anuncio (C-67).
  i.item_id,
  i.model_id
from public.shopee_sales_orders v
join public.shopee_order_items i
  on i.shopee_shop_id = v.shopee_shop_id and i.order_sn = v.order_sn;

drop function public.get_shopee_listings(uuid, uuid, text, text, integer, integer);

create function public.get_shopee_listings(
  p_organization_id uuid,
  p_shopee_shop_id uuid default null,
  p_estado text default null,
  p_busca text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  -- D-493 (C-67): as vendas do anuncio no periodo -- o dia do pedido em Sao Paulo.
  p_date_from date default null,
  p_date_to date default null,
  -- 'com' | 'sem' venda valida no periodo; 'vendas' | 'receita' (maior primeiro).
  p_vendeu text default null,
  p_ordem text default null
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  item_id bigint,
  model_id bigint,
  item_name text,
  model_name text,
  sku_anuncio text,
  item_status text,
  model_status text,
  currency text,
  current_price numeric,
  original_price numeric,
  available_stock integer,
  image_url text,
  sku_id uuid,
  sku text,
  sku_title text,
  estado text,
  vinculo_via text,
  details_synced_at timestamptz,
  details_error text,
  manual_link_id uuid,
  sku_pelo_anuncio text,
  total_count bigint,
  -- D-493 (C-67), no FIM; todas NULAS sem periodo. Loja nunca lida: NULAS.
  unidades_vendidas bigint,
  receita_bruta numeric,
  pedidos bigint,
  -- Unidades vendidas com preco 0 (bundle): receita desconhecida, fora da soma.
  unidades_sem_receita bigint,
  -- O recorte inteiro (todas as linhas do filtro, antes do limite).
  recorte_unidades bigint,
  recorte_receita numeric,
  recorte_unidades_sem_receita bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
-- Sem laco aninhado SO nesta funcao: com a RLS, o planejador estima 30 anuncios e
-- 6 grupos de venda (eram 6 mil e 4,5 mil no ensaio) e casava os dois num laco --
-- 1,4 s em 30 dias; com hash, 53 ms (docs/PERFORMANCE.md). Vale so na execucao dela,
-- como o work_mem da auditoria de 28/09.
set enable_nestloop = off
as $$
#variable_conflict use_column
begin
  if (p_date_from is null) <> (p_date_to is null) or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;
  if p_vendeu is not null and p_vendeu not in ('com', 'sem') then
    raise exception 'vendeu invalido: % (use com ou sem)', p_vendeu;
  end if;
  if p_ordem is not null and p_ordem not in ('vendas', 'receita') then
    raise exception 'ordem invalida: % (use vendas ou receita)', p_ordem;
  end if;
  -- Sem periodo nao ha venda a filtrar nem a ordenar: recusar evita confundir
  -- "sem periodo" com "nao vendeu".
  if p_date_from is null and (p_vendeu is not null or p_ordem is not null) then
    raise exception 'vendeu e ordem pedem o periodo (p_date_from e p_date_to)';
  end if;

  return query
  with
  filtrado as (
    select u.*
    from public.shopee_listing_units u
    where u.organization_id = p_organization_id
      and (p_shopee_shop_id is null or u.shopee_shop_id = p_shopee_shop_id)
      and (p_estado is null or u.estado = p_estado)
      and (
        nullif(btrim(p_busca), '') is null
        or u.item_name ilike '%' || btrim(p_busca) || '%'
        or u.model_name ilike '%' || btrim(p_busca) || '%'
        or u.sku_anuncio ilike '%' || btrim(p_busca) || '%'
        or u.sku ilike '%' || btrim(p_busca) || '%'
        or u.item_id::text = btrim(p_busca)
      )
  ),
  -- As vendas validas do periodo por anuncio: a regra do item do C-59
  -- (shopee_sales_items, D-439) -- situacao do C-53 e receita = preco com o
  -- desconto da loja x quantidade, preco 0 = desconhecida.
  vendas as (
    select it.shopee_shop_id, it.item_id, coalesce(it.model_id, 0) as variacao,
           sum(it.quantity)::bigint as unidades,
           sum(it.receita_item) as receita,
           count(distinct it.order_sn)::bigint as pedidos,
           coalesce(sum(it.quantity) filter (where it.receita_item is null), 0)::bigint as sem_receita
    from public.shopee_sales_items it
    where p_date_from is not null
      and it.organization_id = p_organization_id
      and (p_shopee_shop_id is null or it.shopee_shop_id = p_shopee_shop_id)
      and it.situacao = 'VALIDA'
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.shopee_shop_id, it.item_id, coalesce(it.model_id, 0)
  ),
  linhas as (
    select
      f.*,
      sh.shop_name as nome_loja,
      -- Com periodo e loja lida, nao vender e fato (0); loja nunca lida, NULO.
      case when p_date_from is not null and sh.orders_last_success_at is not null
           then coalesce(v.unidades, 0) end as v_unidades,
      case when p_date_from is not null and sh.orders_last_success_at is not null
           then case when v.unidades is null then 0 else v.receita end end as v_receita,
      case when p_date_from is not null and sh.orders_last_success_at is not null
           then coalesce(v.pedidos, 0) end as v_pedidos,
      case when p_date_from is not null and sh.orders_last_success_at is not null
           then coalesce(v.sem_receita, 0) end as v_sem_receita
    from filtrado f
    join public.shopee_shops sh on sh.id = f.shopee_shop_id
    -- O casamento por igualdade (a variacao NULA vira 0; em producao ela e NULA
    -- ou > 0): `is not distinct from` nao admite hash, e com a estimativa da RLS
    -- o planejador caia num laco de 6 mil anuncios x 4,5 mil vendas no ensaio.
    left join vendas v
      on v.shopee_shop_id = f.shopee_shop_id and v.item_id = f.item_id
     and v.variacao = coalesce(f.model_id, 0)
  ),
  recortado as (
    select l.* from linhas l
    where p_vendeu is null
       or (p_vendeu = 'com' and l.v_unidades > 0)
       or (p_vendeu = 'sem' and l.v_unidades = 0)
  )
  select
    r.shopee_shop_id,
    r.nome_loja,
    r.item_id,
    r.model_id,
    r.item_name,
    r.model_name,
    r.sku_anuncio,
    r.item_status,
    r.model_status,
    r.currency,
    r.current_price,
    r.original_price,
    r.available_stock,
    r.image_url,
    r.sku_id,
    r.sku,
    r.sku_title,
    r.estado,
    r.vinculo_via,
    r.details_synced_at,
    r.details_error,
    r.manual_link_id,
    r.sku_pelo_anuncio,
    count(*) over (),
    r.v_unidades,
    round(r.v_receita, 2),
    r.v_pedidos,
    r.v_sem_receita,
    case when p_date_from is not null then (sum(r.v_unidades) over ())::bigint end,
    case when p_date_from is not null then round(sum(r.v_receita) over (), 2) end,
    case when p_date_from is not null then (sum(r.v_sem_receita) over ())::bigint end
  from recortado r
  order by
    case when p_ordem = 'vendas' then r.v_unidades end desc nulls last,
    case when p_ordem = 'receita' then r.v_receita end desc nulls last,
    case when p_ordem is not null then r.v_unidades end desc nulls last,
    case when p_ordem is null then r.item_name end nulls last,
    r.item_id,
    r.model_name nulls first,
    r.model_id nulls first,
    r.shopee_shop_id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer, date, date, text, text) is
  'Anuncios Shopee da organizacao (D-428, D-429), uma linha por unidade, com o vinculo (manual vence o SKU do anuncio), o id do vinculo manual e o SKU que o anuncio indicaria; filtro por loja, estado e busca; paginada (ate 200) com total_count. D-493 (C-67): com periodo, as vendas validas do anuncio (unidades, receita do item, pedidos e as unidades de preco 0, desconhecidas), o filtro vendeu (com | sem), a ordem por vendas ou receita e o recorte inteiro antes do limite; sem periodo, NULAS.';

revoke all on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer, date, date, text, text) from public, anon;
grant execute on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer, date, date, text, text) to authenticated;
