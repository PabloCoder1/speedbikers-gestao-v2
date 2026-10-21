-- ============================================================
-- C-81 (D-633) -- o historico de preco da Shopee.
--
-- O worker (`shopee.items.hydrate`) compara o preco que o banco tinha com o
-- da leitura nova e grava `listing.price.changed` da LOJA: o mesmo tipo do
-- Mercado Livre, com `shopee_shop_id` preenchido e `ml_account_id` nulo
-- (`domain_events_uma_origem`), `entity_type = 'shopee_item'`,
-- `entity_id` = o item da Shopee e a variacao em `after ->> 'model_id'`.
-- `price` e o `original_price` (o preco do anuncio; o `current_price` e o da
-- promocao, como o `promotional_price` do ML, e vai junto so informativo).
--
-- Aqui:
-- 1. `shopee_shops.price_history_since`: a primeira leitura da loja com a
--    comparacao. Antes disso nao ha historico, e a tela nunca diz "sem
--    mudanca" antes dessa data.
-- 2. `get_price_changes` com a Shopee, params e colunas novos NO FIM:
--    - `p_marketplace`: NULO ou 'mercado_livre' = so o ML, como a tela de
--      antes chama (o padrao do C-60: nulo = o comportamento de antes);
--      'shopee' = so a Shopee; 'todos' = os dois;
--    - `p_shopee_shop_id`: uma loja (implica a Shopee);
--    - conta e loja juntas, ou um marketplace que contradiz a conta ou a
--      loja, e recusado -- nunca vira recorte vazio calado.
--    Na linha da Shopee: `item_id` = o item em texto, `title`/`status` =
--    `item_name`/`item_status` (o vocabulario da Shopee: NORMAL, UNLIST...),
--    `sku_id`/`sku` = o vinculo resolvido de `shopee_listing_units`,
--    `ml_account_id` NULO e `account_label` = o nome da loja ('Loja Shopee
--    <shop_id>' sem nome lido, como nas outras RPCs).
--
-- A assinatura antiga sai: chamada sem os params novos resolve nesta, com o
-- mesmo resultado de antes (so o ML).
-- ============================================================

alter table public.shopee_shops
  add column price_history_since timestamptz;

comment on column public.shopee_shops.price_history_since is
  'C-81: a primeira leitura do catalogo da loja com a comparacao de preco (shopee.items.hydrate). Antes dela nao ha historico de preco da Shopee; NULO = ainda nao registrada.';

drop function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer);

create function public.get_price_changes(
  p_organization_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_ml_account_id uuid default null,
  p_direction text default null,
  p_search text default null,
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_marketplace text default null,
  p_shopee_shop_id uuid default null
)
returns table (
  event_id uuid,
  item_id text,
  title text,
  status text,
  sku_id uuid,
  sku text,
  ml_account_id uuid,
  account_label text,
  price_before numeric,
  price_after numeric,
  delta numeric,
  delta_ratio numeric,
  occurred_at timestamptz,
  total_count bigint,
  increases bigint,
  decreases bigint,
  listings_affected bigint,
  series_start date,
  marketplace text,
  shopee_shop_id uuid,
  model_id bigint,
  model_name text,
  series_start_shopee date
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  -- A loja sem marketplace dito implica a Shopee; o resto, o ML de antes.
  v_marketplace text := coalesce(
    p_marketplace,
    case when p_shopee_shop_id is not null then 'shopee' else 'mercado_livre' end
  );
  v_ml boolean;
  v_shopee boolean;
begin
  if v_marketplace not in ('mercado_livre', 'shopee', 'todos') then
    raise exception 'p_marketplace deve ser mercado_livre, shopee ou todos (veio %)', p_marketplace;
  end if;

  if p_ml_account_id is not null and p_shopee_shop_id is not null then
    raise exception 'escolha uma conta do Mercado Livre ou uma loja da Shopee, nao as duas';
  end if;

  if p_ml_account_id is not null and v_marketplace = 'shopee' then
    raise exception 'p_ml_account_id e do Mercado Livre e contradiz p_marketplace = shopee';
  end if;

  if p_shopee_shop_id is not null and v_marketplace = 'mercado_livre' then
    raise exception 'p_shopee_shop_id e da Shopee e contradiz p_marketplace = mercado_livre';
  end if;

  v_ml := v_marketplace in ('mercado_livre', 'todos') and p_shopee_shop_id is null;
  v_shopee := v_marketplace in ('shopee', 'todos') and p_ml_account_id is null;

  return query
  with ml as (
    select
      e.id as event_id,
      e.entity_id as item_id,
      -- LEFT join: o anuncio pode ter sumido do catalogo depois do evento.
      -- O evento continua sendo verdade -- a tela mostra o MLB sem titulo em
      -- vez de esconder a linha.
      l.title,
      l.status,
      l.sku_id,
      s.sku,
      e.ml_account_id,
      a.label as account_label,
      (e.before ->> 'price')::numeric as price_before,
      (e.after  ->> 'price')::numeric as price_after,
      e.occurred_at,
      'mercado_livre'::text as marketplace,
      null::uuid as shopee_shop_id,
      null::bigint as model_id,
      null::text as model_name
    from public.domain_events e
    join public.ml_accounts a on a.id = e.ml_account_id
    left join public.listings l
      on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
    left join public.skus s on s.id = l.sku_id
    where v_ml
      and e.organization_id = p_organization_id
      and e.event_type = 'listing.price.changed'
      and e.occurred_at >= p_date_from
      and e.occurred_at < p_date_to
      -- Evento sem os dois lados do preco nao vira linha com NULL silencioso:
      -- fica de fora, porque "de quanto para quanto" e a pergunta da tela.
      and e.before ? 'price'
      and e.after ? 'price'
      and (p_ml_account_id is null or e.ml_account_id = p_ml_account_id)
      -- Equivalente a `l.sku_id = p_sku_id` pela unicidade de
      -- `(ml_account_id, item_id)`, e 5,5x mais barato quando ha filtro.
      and (p_sku_id is null
           or (e.ml_account_id, e.entity_id) in (
                select k.ml_account_id, k.item_id
                from public.listings k
                where k.sku_id = p_sku_id))
      and (p_search is null
           or e.entity_id ilike '%' || p_search || '%'
           or l.title ilike '%' || p_search || '%'
           or s.sku ilike '%' || p_search || '%')
  ),
  eventos_shopee as (
    select
      e.id,
      e.entity_id,
      e.shopee_shop_id,
      e.occurred_at,
      e.before,
      e.after,
      -- O cast so no id numerico: o join nunca tenta converter um MLB.
      case when e.entity_id ~ '^[0-9]{1,18}$' then e.entity_id::bigint end as item_numero,
      case when (e.after ->> 'model_id') ~ '^[0-9]{1,18}$' then (e.after ->> 'model_id')::bigint end as modelo
    from public.domain_events e
    where v_shopee
      and e.organization_id = p_organization_id
      and e.event_type = 'listing.price.changed'
      and e.shopee_shop_id is not null
      and e.entity_type = 'shopee_item'
      and e.occurred_at >= p_date_from
      and e.occurred_at < p_date_to
      and e.before ? 'price'
      and e.after ? 'price'
      and (p_shopee_shop_id is null or e.shopee_shop_id = p_shopee_shop_id)
  ),
  shopee as (
    select
      x.id as event_id,
      x.entity_id as item_id,
      -- LEFT join como no ML: o item pode ter saido do catalogo.
      i.item_name as title,
      i.item_status as status,
      u.sku_id,
      u.sku,
      null::uuid as ml_account_id,
      -- A mesma convencao das outras RPCs da Shopee para a loja sem nome lido.
      coalesce(sh.shop_name, 'Loja Shopee ' || sh.shop_id::text) as account_label,
      (x.before ->> 'price')::numeric as price_before,
      (x.after  ->> 'price')::numeric as price_after,
      x.occurred_at,
      'shopee'::text as marketplace,
      x.shopee_shop_id,
      x.modelo as model_id,
      coalesce(u.model_name, x.after ->> 'model_name') as model_name
    from eventos_shopee x
    join public.shopee_shops sh on sh.id = x.shopee_shop_id
    left join public.shopee_items i
      on i.shopee_shop_id = x.shopee_shop_id and i.item_id = x.item_numero
    -- A unidade (item, ou item e variacao) com o vinculo resolvido (manual
    -- ou pelo SKU do anuncio), a mesma regra de /anuncios da Shopee.
    left join public.shopee_listing_units u
      on u.shopee_shop_id = x.shopee_shop_id
     and u.item_id = x.item_numero
     and u.model_id is not distinct from x.modelo
    where (p_sku_id is null or u.sku_id = p_sku_id)
      and (p_search is null
           or x.entity_id ilike '%' || p_search || '%'
           or i.item_name ilike '%' || p_search || '%'
           or u.sku ilike '%' || p_search || '%')
  ),
  base as (
    select * from ml
    union all
    select * from shopee
  ),
  filtrado as (
    select * from base b
    where case p_direction
            when 'up'   then b.price_after > b.price_before
            when 'down' then b.price_after < b.price_before
            else true
          end
  ),
  -- UMA passada sobre `filtrado` para as quatro contagens.
  resumo as (
    select
      count(*)::bigint                                                  as total_count,
      count(*) filter (where f.price_after > f.price_before)::bigint    as increases,
      count(*) filter (where f.price_after < f.price_before)::bigint    as decreases,
      -- O anuncio e da conta ou da loja: o mesmo numero em duas origens
      -- seriam dois anuncios.
      count(distinct coalesce(f.ml_account_id, f.shopee_shop_id)::text || ':' || f.item_id)::bigint
                                                                         as listings_affected
    from filtrado f
  )
  select
    f.event_id, f.item_id, f.title, f.status, f.sku_id, f.sku,
    f.ml_account_id, f.account_label, f.price_before, f.price_after,
    round(f.price_after - f.price_before, 2) as delta,
    round((f.price_after - f.price_before) / nullif(f.price_before, 0), 4) as delta_ratio,
    f.occurred_at,
    r.total_count,
    r.increases,
    r.decreases,
    r.listings_affected,
    -- FORA do recorte de proposito: a ressalva da tela fala do inicio da SERIE
    -- do ML da organizacao, nao do filtro escolhido. O fuso e o da
    -- organizacao por definicao canonica (`metric_definitions`).
    (select (min(e2.occurred_at) at time zone 'America/Sao_Paulo')::date
       from public.domain_events e2
      where e2.organization_id = p_organization_id
        and e2.event_type = 'listing.price.changed'
        and e2.ml_account_id is not null
        and e2.before ? 'price'
        and e2.after ? 'price') as series_start,
    f.marketplace,
    f.shopee_shop_id,
    f.model_id,
    f.model_name,
    -- Desde quando a Shopee e registrada no recorte: a data MAIS RECENTE
    -- entre as lojas conectadas (o lado conservador), e NULA se alguma ainda
    -- nao foi -- dizer "sem mudanca desde X" seria falso para ela.
    (select case
              when count(*) = 0 or bool_or(sh2.price_history_since is null) then null
              else (max(sh2.price_history_since) at time zone 'America/Sao_Paulo')::date
            end
       from public.shopee_shops sh2
      where sh2.organization_id = p_organization_id
        and sh2.status = 'CONNECTED'
        and (p_shopee_shop_id is null or sh2.id = p_shopee_shop_id)) as series_start_shopee
  from filtrado f
  cross join resumo r
  order by f.occurred_at desc, f.event_id desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$fn$;

comment on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer, text, uuid) is
  'Mudancas de preco observadas por anuncio (D-172, Central de Precos), com a Shopee desde o C-81: p_marketplace nulo ou mercado_livre = so o ML; shopee ou todos com a loja (shopee_shop_id, model_id, account_label = nome da loja). series_start e o do ML; series_start_shopee, desde quando as lojas sao registradas.';

revoke all on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer, text, uuid) from public, anon;
grant execute on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer, text, uuid) to authenticated, service_role;
