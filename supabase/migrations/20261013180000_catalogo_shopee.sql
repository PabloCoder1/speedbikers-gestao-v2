-- ============================================================
-- D-428 -- o CATALOGO da Shopee e o vinculo pelo SKU do anuncio (fatia 4a
-- da trilha, D-425).
--
-- Contrato conferido em 13/10/2026 (`docs/SHOPEE.md` secao 4.3):
-- `get_item_list` (offset, 100 por pagina, status repetido, janela de
-- `update_time`), `get_item_base_info` (ate 50 itens) e `get_model_list`
-- (as variacoes de um item; preco e estoque ficam nelas quando ha variacao).
--
-- Tabelas proprias, como as lojas e os pedidos (D-425 secao 1):
-- `listings` e `sku_listing_links` sao cravados no Mercado Livre (item_id
-- '^MLB', ml_account_id NOT NULL, RLS por conta) e nenhuma contagem do ML
-- muda por construcao.
--
-- O VINCULO, decisao do dono de 13/10: o SKU que o vendedor digitou no
-- anuncio (o da variacao; o do item quando nao ha variacao), normalizado
-- como `skus.sku_key` (`upper(btrim())`), igual a um SKU do catalogo, conta
-- como vinculado -- rotulo proprio, como o vinculo indireto de D-362. E
-- DERIVADO, nunca gravado: trocar o SKU no anuncio ou no catalogo muda o
-- vinculo na proxima leitura. O vinculo manual (que vence) e a fatia 4b.
-- ============================================================

create table public.shopee_items (
  shopee_shop_id uuid not null references public.shopee_shops (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  item_id bigint not null check (item_id > 0),
  -- NORMAL, UNLIST, BANNED, REVIEWING, SELLER_DELETE, SHOPEE_DELETE -- como
  -- veio da lista; o item que some nunca e apagado (como `listings` do ML).
  item_status text not null,
  shopee_updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  -- O detalhe (`get_item_base_info`): NULO ate a primeira leitura dele.
  item_name text,
  item_sku text,
  has_model boolean,
  -- Preco e estoque so do item SEM variacao; com variacao ficam nas
  -- variacoes. Ausente = NULO, nunca zero.
  currency text,
  current_price numeric,
  original_price numeric,
  available_stock integer,
  image_url text,
  is_fulfillment_by_shopee boolean,
  shopee_created_at timestamptz,
  -- Quando a V3 leu o detalhe (relogio do worker): a ordem e o recuo da fila.
  details_synced_at timestamptz,
  -- O `update_time` que o DETALHE trouxe (relogio da Shopee): o item esta em
  -- dia quando a lista nao viu nada mais novo que isso. Comparar o relogio
  -- da Shopee com o do worker perderia a mudanca do mesmo segundo.
  details_update_time timestamptz,
  -- Por que a ultima leitura do detalhe nao serviu (nao devolvido, fora do
  -- contrato, erro definitivo nas variacoes). NULO = a ultima leitura serviu.
  details_error text,
  primary key (shopee_shop_id, item_id)
);

create index shopee_items_org_idx on public.shopee_items (organization_id);

comment on table public.shopee_items is
  'Itens do catalogo de uma loja Shopee (D-428): a lista por get_item_list, o detalhe por get_item_base_info. Escritos so pelo worker; nunca apagados.';
comment on column public.shopee_items.details_synced_at is
  'Quando a V3 leu o detalhe pela ultima vez, no relogio do worker (D-428). NULO = nunca lido.';
comment on column public.shopee_items.details_update_time is
  'O update_time que o detalhe trouxe, no relogio da Shopee (D-428): shopee_updated_at mais novo que ele = o item mudou e sera relido.';
comment on column public.shopee_items.details_error is
  'Por que a ultima leitura do detalhe nao serviu (D-428); a fila tenta de novo em 1 dia ou quando o item mudar. NULO = serviu.';

create table public.shopee_item_models (
  shopee_shop_id uuid not null,
  item_id bigint not null,
  model_id bigint not null check (model_id > 0),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- As opcoes da tier_variation pelos indices do model ("Azul / P").
  model_name text,
  -- O SKU do vendedor na variacao: o caminho do vinculo.
  model_sku text,
  model_status text,
  currency text,
  current_price numeric,
  original_price numeric,
  available_stock integer,
  primary key (shopee_shop_id, item_id, model_id),
  foreign key (shopee_shop_id, item_id) references public.shopee_items (shopee_shop_id, item_id) on delete cascade
);

comment on table public.shopee_item_models is
  'Variacoes de um item Shopee (get_model_list, D-428), substituidas a cada leitura do item. model_sku e o SKU do vendedor.';

alter table public.shopee_shops add column if not exists items_synced_until timestamptz;
-- Uma cadeia de leitura do detalhe por loja: o gatilho horario abriria outra
-- enquanto a anterior ainda anda, e as duas brigariam nas variacoes.
alter table public.shopee_shops add column if not exists items_hydrate_locked_until timestamptz;

comment on column public.shopee_shops.items_synced_until is
  'Ate onde (update_time da Shopee) a lista de itens da loja ja foi lida (D-428). NULO = nunca; a primeira leitura enumera o catalogo inteiro.';

-- ------------------------------------------------------------
-- RLS: membros da organizacao leem; so o worker escreve.
-- ------------------------------------------------------------
alter table public.shopee_items enable row level security;
alter table public.shopee_item_models enable row level security;

create policy shopee_items_select_member
  on public.shopee_items for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy shopee_item_models_select_member
  on public.shopee_item_models for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.shopee_items from anon, authenticated;
revoke all on public.shopee_item_models from anon, authenticated;
grant select on public.shopee_items to authenticated;
grant select on public.shopee_item_models to authenticated;
grant all on public.shopee_items to service_role;
grant all on public.shopee_item_models to service_role;

-- ------------------------------------------------------------
-- A UNIDADE de anuncio: cada variacao, ou o item quando nao ha variacao, com
-- o vinculo pelo SKU do anuncio. Uma definicao so para a lista e para os
-- contadores. `security_invoker`: a RLS de quem le vale aqui dentro.
--
-- estado:
--   AGUARDANDO_LEITURA  o detalhe ainda nao foi lido (ou o item tem variacao
--                       e nenhuma foi lida);
--   VINCULADO           o SKU do anuncio e um SKU do catalogo;
--   SEM_SKU_NO_ANUNCIO  o anuncio nao tem SKU do vendedor;
--   SKU_FORA_DO_CATALOGO o SKU do anuncio nao existe no catalogo da V3.
-- Item apagado (SELLER_DELETE, SHOPEE_DELETE) nao e anuncio: fica de fora.
-- ------------------------------------------------------------
create view public.shopee_listing_units
with (security_invoker = true)
as
with unidades as (
  select
    i.organization_id,
    i.shopee_shop_id,
    i.item_id,
    m.model_id,
    i.item_name,
    m.model_name,
    nullif(btrim(m.model_sku), '') as sku_anuncio,
    i.item_status,
    m.model_status,
    coalesce(m.currency, i.currency) as currency,
    m.current_price,
    m.original_price,
    m.available_stock,
    i.image_url,
    i.shopee_updated_at,
    i.details_synced_at,
    i.details_error,
    false as aguardando
  from public.shopee_items i
  join public.shopee_item_models m
    on m.shopee_shop_id = i.shopee_shop_id and m.item_id = i.item_id
  where i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')

  union all

  select
    i.organization_id,
    i.shopee_shop_id,
    i.item_id,
    null::bigint,
    i.item_name,
    null::text,
    case when i.has_model is false then nullif(btrim(i.item_sku), '') end,
    i.item_status,
    null::text,
    i.currency,
    i.current_price,
    i.original_price,
    i.available_stock,
    i.image_url,
    i.shopee_updated_at,
    i.details_synced_at,
    i.details_error,
    -- Sem detalhe, ou com variacao e nenhuma variacao lida. A fila volta a
    -- ler esses itens (shopee_items_details_pending): o estado nunca e final.
    i.details_synced_at is null or i.has_model is not false
  from public.shopee_items i
  where i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
    and not exists (
      select 1 from public.shopee_item_models m
      where m.shopee_shop_id = i.shopee_shop_id and m.item_id = i.item_id
    )
)
select
  u.organization_id,
  u.shopee_shop_id,
  u.item_id,
  u.model_id,
  u.item_name,
  u.model_name,
  u.sku_anuncio,
  u.item_status,
  u.model_status,
  u.currency,
  u.current_price,
  u.original_price,
  u.available_stock,
  u.image_url,
  u.shopee_updated_at,
  u.details_synced_at,
  u.details_error,
  s.id as sku_id,
  s.sku,
  s.title as sku_title,
  case
    when u.aguardando then 'AGUARDANDO_LEITURA'
    when s.id is not null then 'VINCULADO'
    when u.sku_anuncio is null then 'SEM_SKU_NO_ANUNCIO'
    else 'SKU_FORA_DO_CATALOGO'
  end as estado,
  case when s.id is not null and not u.aguardando then 'SKU_DO_ANUNCIO' end as vinculo_via
from unidades u
left join public.skus s
  on s.organization_id = u.organization_id
 and s.sku_key = upper(btrim(u.sku_anuncio))
 and not u.aguardando;

comment on view public.shopee_listing_units is
  'Unidade de anuncio Shopee (variacao, ou o item sem variacao) com o vinculo pelo SKU do anuncio (D-428): upper(btrim(SKU do anuncio)) = skus.sku_key. Derivado, nunca gravado; itens apagados de fora.';

revoke all on public.shopee_listing_units from anon, authenticated;
grant select on public.shopee_listing_units to authenticated;
grant select on public.shopee_listing_units to service_role;

-- ------------------------------------------------------------
-- A lista da tela, paginada no SQL, com o total da consulta.
-- ------------------------------------------------------------
create or replace function public.get_shopee_listings(
  p_organization_id uuid,
  p_shopee_shop_id uuid default null,
  p_estado text default null,
  p_busca text default null,
  p_limit integer default 50,
  p_offset integer default 0
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
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with filtrado as (
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
  )
  select
    f.shopee_shop_id,
    sh.shop_name,
    f.item_id,
    f.model_id,
    f.item_name,
    f.model_name,
    f.sku_anuncio,
    f.item_status,
    f.model_status,
    f.currency,
    f.current_price,
    f.original_price,
    f.available_stock,
    f.image_url,
    f.sku_id,
    f.sku,
    f.sku_title,
    f.estado,
    f.vinculo_via,
    f.details_synced_at,
    f.details_error,
    count(*) over () as total_count
  from filtrado f
  join public.shopee_shops sh on sh.id = f.shopee_shop_id
  order by f.item_name nulls last, f.item_id, f.model_name nulls first, f.model_id nulls first
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) is
  'Anuncios Shopee da organizacao (D-428), uma linha por unidade (variacao, ou item sem variacao), com o vinculo pelo SKU do anuncio; filtro por loja, estado e busca; paginada (ate 200) com total_count.';

revoke all on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- Os contadores da faixa da tela: contados no SQL, sobre a mesma unidade.
-- `ultima_leitura` e a leitura MAIS VELHA entre as lojas do escopo, e NULA se
-- alguma loja nunca foi lida: com varias lojas, a data de uma esconderia a
-- outra parada -- a tela mostra "--", nunca zero.
-- ------------------------------------------------------------
create or replace function public.get_shopee_listings_summary(
  p_organization_id uuid,
  p_shopee_shop_id uuid default null
)
returns table (
  anuncios bigint,
  itens bigint,
  vinculados bigint,
  sem_sku_no_anuncio bigint,
  sku_fora_do_catalogo bigint,
  aguardando_leitura bigint,
  ultima_leitura timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) as anuncios,
    count(distinct (u.shopee_shop_id, u.item_id)) as itens,
    count(*) filter (where u.estado = 'VINCULADO') as vinculados,
    count(*) filter (where u.estado = 'SEM_SKU_NO_ANUNCIO') as sem_sku_no_anuncio,
    count(*) filter (where u.estado = 'SKU_FORA_DO_CATALOGO') as sku_fora_do_catalogo,
    count(*) filter (where u.estado = 'AGUARDANDO_LEITURA') as aguardando_leitura,
    (
      select case when bool_or(sh.items_synced_until is null) then null else min(sh.items_synced_until) end
      from public.shopee_shops sh
      where sh.organization_id = p_organization_id
        and (p_shopee_shop_id is null or sh.id = p_shopee_shop_id)
    ) as ultima_leitura
  from public.shopee_listing_units u
  where u.organization_id = p_organization_id
    and (p_shopee_shop_id is null or u.shopee_shop_id = p_shopee_shop_id);
$$;

comment on function public.get_shopee_listings_summary(uuid, uuid) is
  'Contadores dos anuncios Shopee (D-428) por estado do vinculo pelo SKU do anuncio, e a leitura mais velha do catalogo entre as lojas do escopo (NULA = alguma nunca lida).';

revoke all on function public.get_shopee_listings_summary(uuid, uuid) from public, anon;
grant execute on function public.get_shopee_listings_summary(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- Quais itens de UMA loja precisam do detalhe (worker, `shopee.items.hydrate`).
-- Apagados nunca. Na ordem:
--   1. nunca lidos;
--   2. lidos e alterados depois (a lista viu `update_time` mais novo que o
--      do detalhe -- o mesmo relogio, o da Shopee);
--   3. leitura que nao serviu (`details_error`) ha mais de 1 dia, ou o item
--      mudou depois dela;
--   4. lidos com variacao e nenhuma variacao gravada ha mais de 1 dia.
-- O recuo de 1 dia nos casos 3 e 4 e o que impede um item ruim de voltar
-- primeiro em toda execucao e travar a fila da loja; e o que faz o estado
-- "aguardando leitura" nunca ser final. Devolve o `shopee_updated_at` para o
-- worker gravar como `details_update_time` quando o detalhe nao trouxer um.
-- ------------------------------------------------------------
create or replace function public.shopee_items_details_pending(p_shopee_shop_id uuid, p_limit integer default 50)
returns table (item_id bigint, shopee_updated_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with candidatos as (
    select
      i.item_id,
      i.shopee_updated_at,
      case
        when i.details_synced_at is null then 1
        when i.details_error is null
         and (i.details_update_time is null or i.shopee_updated_at > i.details_update_time) then 2
        when i.details_error is not null
         and (i.details_synced_at < now() - interval '1 day' or i.shopee_updated_at > i.details_synced_at) then 3
        when i.details_error is null
         and i.has_model is not false
         and i.details_synced_at < now() - interval '1 day'
         and not exists (
           select 1 from public.shopee_item_models m
           where m.shopee_shop_id = i.shopee_shop_id and m.item_id = i.item_id
         ) then 4
      end as prioridade
    from public.shopee_items i
    where i.shopee_shop_id = p_shopee_shop_id
      and i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
  )
  select c.item_id, c.shopee_updated_at
  from candidatos c
  where c.prioridade is not null
  order by c.prioridade, c.shopee_updated_at, c.item_id
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

comment on function public.shopee_items_details_pending(uuid, integer) is
  'Itens de uma loja Shopee cujo detalhe precisa ser lido (D-428): nunca lidos, alterados depois da leitura (relogio da Shopee), leitura que nao serviu ha 1 dia, ou variacoes ausentes ha 1 dia; apagados de fora; ate 50. So o worker chama.';

revoke all on function public.shopee_items_details_pending(uuid, integer) from public, anon, authenticated;
grant execute on function public.shopee_items_details_pending(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- A trava da cadeia de leitura do detalhe de UMA loja (worker). Pega a trava
-- se estiver livre ou vencida e devolve se pegou. Soltar e gravar NULO.
-- ------------------------------------------------------------
create or replace function public.shopee_items_hydrate_lock(p_shopee_shop_id uuid, p_ttl_seconds integer default 900)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with travada as (
    update public.shopee_shops
       set items_hydrate_locked_until = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 900), 60))
     where id = p_shopee_shop_id
       and (items_hydrate_locked_until is null or items_hydrate_locked_until < now())
    returning id
  )
  select exists (select 1 from travada);
$$;

comment on function public.shopee_items_hydrate_lock(uuid, integer) is
  'Trava por loja da leitura do detalhe do catalogo Shopee (D-428): true se pegou. O worker solta gravando items_hydrate_locked_until NULO.';

revoke all on function public.shopee_items_hydrate_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.shopee_items_hydrate_lock(uuid, integer) to service_role;
