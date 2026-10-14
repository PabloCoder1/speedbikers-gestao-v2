-- ============================================================
-- D-429 -- o VINCULO MANUAL do anuncio Shopee com o SKU (fatia 4b da
-- trilha, D-425).
--
-- Decisao do dono de 13/10 (D-428): o SKU do anuncio igual a um SKU do
-- catalogo conta como vinculado; o vinculo manual, quando existe, VENCE. Esta
-- migration traz o manual: a tabela, o historico, as RPCs de escrita e a view
-- com a precedencia.
--
-- O desenho e o do Mercado Livre (D-119, D-125, D-316), em tabelas proprias
-- como toda a trilha (D-425 secao 1):
-- - escrita so por RPC (security definer), nenhum grant de escrita;
-- - historico append-only (CREATED, RETARGETED, REMOVED), remocao fisica do
--   vinculo, motivo obrigatorio na remocao;
-- - o vinculo so e aceito para uma unidade JA no catalogo sincronizado
--   (D-316): a web nunca chama a Shopee;
-- - a unidade e a do anuncio: a variacao, ou o item SEM variacao. Item com
--   variacao nao recebe vinculo no item inteiro (a mistura de D-119).
-- Permissao por ORGANIZACAO (ADMIN, GESTOR, OPERADOR), como as tabelas
-- shopee_*: a Shopee nao tem permissao por loja.
-- ============================================================

create table public.shopee_sku_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shopee_shop_id uuid not null references public.shopee_shops (id) on delete cascade,
  item_id bigint not null check (item_id > 0),
  -- NULO = o item sem variacao; senao, a variacao.
  model_id bigint check (model_id is null or model_id > 0),
  sku_id uuid not null references public.skus (id) on delete restrict,
  -- MANUAL agora; a importacao do UpSeller (fatia 7) entra com o proprio valor.
  source text not null default 'MANUAL' check (source in ('MANUAL')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Uma linha por unidade: NULL nao colide com NULL num UNIQUE comum, por isso
-- dois indices parciais (a mesma armadilha de sku_listing_links).
create unique index shopee_sku_links_unidade_variacao
  on public.shopee_sku_links (shopee_shop_id, item_id, model_id) where model_id is not null;
create unique index shopee_sku_links_unidade_item
  on public.shopee_sku_links (shopee_shop_id, item_id) where model_id is null;
create index shopee_sku_links_sku_idx on public.shopee_sku_links (sku_id);
create index shopee_sku_links_org_idx on public.shopee_sku_links (organization_id);

comment on table public.shopee_sku_links is
  'Vinculo MANUAL anuncio Shopee <-> SKU (D-429), um por unidade (variacao, ou item sem variacao). Vence o vinculo pelo SKU do anuncio (D-428). Escrita so por set_/remove_shopee_sku_link.';

create table public.shopee_sku_link_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- RESTRICT, como a conta em sku_listing_link_events: o historico e
  -- append-only, e a loja com vinculos auditados nao some em cascata sem rastro.
  shopee_shop_id uuid not null references public.shopee_shops (id) on delete restrict,
  -- SEM FK: em REMOVED a linha nao existe mais.
  link_id uuid not null,
  event_type text not null check (event_type in ('CREATED', 'RETARGETED', 'REMOVED')),
  item_id bigint not null,
  model_id bigint,
  sku_id uuid not null references public.skus (id) on delete restrict,
  previous_sku_id uuid references public.skus (id) on delete restrict,
  actor_user_id uuid not null references public.profiles (id) on delete restrict,
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  occurred_at timestamptz not null default now(),

  constraint shopee_sku_link_events_target_coherent check (
    (event_type = 'RETARGETED' and previous_sku_id is not null and previous_sku_id <> sku_id)
    or (event_type in ('CREATED', 'REMOVED') and previous_sku_id is null)
  ),
  constraint shopee_sku_link_events_reason_required check (event_type <> 'REMOVED' or reason is not null)
);

create index shopee_sku_link_events_link_idx on public.shopee_sku_link_events (link_id, occurred_at desc);

comment on table public.shopee_sku_link_events is
  'Historico append-only do vinculo manual Shopee (D-429): CREATED, RETARGETED, REMOVED (com motivo). Mesmo padrao de sku_listing_link_events (D-125).';

create or replace function private.shopee_sku_link_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'shopee_sku_link_events e append-only: % nao e permitido. Insira um novo evento.', tg_op;
end;
$$;

revoke all on function private.shopee_sku_link_events_reject_mutation() from public, anon, authenticated;

create trigger shopee_sku_link_events_no_mutation
  before update or delete on public.shopee_sku_link_events
  for each row execute function private.shopee_sku_link_events_reject_mutation();

-- ------------------------------------------------------------
-- RLS: membros leem; ninguem escreve fora das RPCs.
-- ------------------------------------------------------------
alter table public.shopee_sku_links enable row level security;
alter table public.shopee_sku_link_events enable row level security;

create policy shopee_sku_links_select_member
  on public.shopee_sku_links for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy shopee_sku_link_events_select_member
  on public.shopee_sku_link_events for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.shopee_sku_links from anon, authenticated;
revoke all on public.shopee_sku_link_events from anon, authenticated;
grant select on public.shopee_sku_links to authenticated;
grant select on public.shopee_sku_link_events to authenticated;
grant all on public.shopee_sku_links to service_role;
grant select, insert on public.shopee_sku_link_events to service_role;

-- ------------------------------------------------------------
-- Escrita: grava (cria ou troca o SKU) o vinculo de UMA unidade.
-- ------------------------------------------------------------
create or replace function public.set_shopee_sku_link(
  p_shopee_shop_id uuid,
  p_item_id bigint,
  p_model_id bigint,
  p_sku_id uuid,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_ator uuid := (select auth.uid());
  v_sku_org uuid;
  v_atual public.shopee_sku_links;
  v_id uuid;
  v_motivo text := nullif(btrim(p_reason), '');
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if v_ator is null or not private.has_org_role(v_org, array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para vincular anuncios desta loja';
  end if;

  select organization_id into v_sku_org from public.skus where id = p_sku_id;

  if v_sku_org is null or v_sku_org <> v_org then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  -- D-316: a unidade tem de estar no catalogo sincronizado, e viva.
  if p_model_id is not null then
    if not exists (
      select 1
      from public.shopee_item_models m
      join public.shopee_items i on i.shopee_shop_id = m.shopee_shop_id and i.item_id = m.item_id
      where m.shopee_shop_id = p_shopee_shop_id and m.item_id = p_item_id and m.model_id = p_model_id
        and i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
    ) then
      raise exception 'variacao nao encontrada no catalogo sincronizado';
    end if;
  else
    if not exists (
      select 1 from public.shopee_items i
      where i.shopee_shop_id = p_shopee_shop_id and i.item_id = p_item_id
        and i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
        and i.details_synced_at is not null
        and i.has_model is false
    ) then
      raise exception 'item sem variacao nao encontrado no catalogo sincronizado';
    end if;

    -- D-119: item com variacao recebe vinculo por variacao, nunca no item inteiro.
    if exists (
      select 1 from public.shopee_item_models m
      where m.shopee_shop_id = p_shopee_shop_id and m.item_id = p_item_id
    ) then
      raise exception 'item com variacao: vincule cada variacao';
    end if;
  end if;

  select * into v_atual
  from public.shopee_sku_links l
  where l.shopee_shop_id = p_shopee_shop_id and l.item_id = p_item_id
    and l.model_id is not distinct from p_model_id
  for update;

  if found then
    if v_atual.sku_id = p_sku_id then
      return v_atual.id;
    end if;

    update public.shopee_sku_links
       set sku_id = p_sku_id, updated_by = v_ator, updated_at = now()
     where id = v_atual.id;

    insert into public.shopee_sku_link_events
      (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, previous_sku_id, actor_user_id, reason)
    values
      (v_org, p_shopee_shop_id, v_atual.id, 'RETARGETED', p_item_id, p_model_id, p_sku_id, v_atual.sku_id, v_ator, v_motivo);

    return v_atual.id;
  end if;

  insert into public.shopee_sku_links (organization_id, shopee_shop_id, item_id, model_id, sku_id, created_by, updated_by)
  values (v_org, p_shopee_shop_id, p_item_id, p_model_id, p_sku_id, v_ator, v_ator)
  returning id into v_id;

  insert into public.shopee_sku_link_events
    (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, actor_user_id, reason)
  values
    (v_org, p_shopee_shop_id, v_id, 'CREATED', p_item_id, p_model_id, p_sku_id, v_ator, v_motivo);

  return v_id;
end;
$$;

comment on function public.set_shopee_sku_link(uuid, bigint, bigint, uuid, text) is
  'Vinculo manual de uma unidade de anuncio Shopee (D-429): cria ou troca o SKU, com evento. Exige ADMIN/GESTOR/OPERADOR na organizacao da loja, SKU da mesma organizacao e a unidade no catalogo sincronizado (variacao; ou item sem variacao).';

revoke all on function public.set_shopee_sku_link(uuid, bigint, bigint, uuid, text) from public, anon;
grant execute on function public.set_shopee_sku_link(uuid, bigint, bigint, uuid, text) to authenticated;

-- ------------------------------------------------------------
-- Remocao: o vinculo manual sai, com motivo; o SKU do anuncio volta a valer.
-- ------------------------------------------------------------
create or replace function public.remove_shopee_sku_link(p_link_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.shopee_sku_links;
  v_ator uuid := (select auth.uid());
  v_motivo text := nullif(btrim(p_reason), '');
begin
  select * into v_link from public.shopee_sku_links where id = p_link_id for update;

  if not found then
    raise exception 'vinculo % nao encontrado', p_link_id;
  end if;

  if v_ator is null or not private.has_org_role(v_link.organization_id, array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para vincular anuncios desta loja';
  end if;

  if v_motivo is null then
    raise exception 'motivo obrigatorio para remover o vinculo';
  end if;

  insert into public.shopee_sku_link_events
    (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, actor_user_id, reason)
  values
    (v_link.organization_id, v_link.shopee_shop_id, v_link.id, 'REMOVED', v_link.item_id, v_link.model_id, v_link.sku_id, v_ator, v_motivo);

  delete from public.shopee_sku_links where id = p_link_id;
end;
$$;

comment on function public.remove_shopee_sku_link(uuid, text) is
  'Remove o vinculo manual de um anuncio Shopee (D-429), com motivo obrigatorio e evento REMOVED; o vinculo pelo SKU do anuncio volta a valer.';

revoke all on function public.remove_shopee_sku_link(uuid, text) from public, anon;
grant execute on function public.remove_shopee_sku_link(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- A view: o manual VENCE o SKU do anuncio. Mesmas colunas, na mesma ordem
-- (create or replace), e duas no fim: o id do vinculo manual (para trocar e
-- remover) e o SKU que o anuncio indicaria (para a tela mostrar quando o
-- manual discorda dele).
-- ------------------------------------------------------------
create or replace view public.shopee_listing_units
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
  coalesce(sm.id, sd.id) as sku_id,
  coalesce(sm.sku, sd.sku) as sku,
  coalesce(sm.title, sd.title) as sku_title,
  case
    when sm.id is not null then 'VINCULADO'
    when u.aguardando then 'AGUARDANDO_LEITURA'
    when sd.id is not null then 'VINCULADO'
    when u.sku_anuncio is null then 'SEM_SKU_NO_ANUNCIO'
    else 'SKU_FORA_DO_CATALOGO'
  end as estado,
  case
    when sm.id is not null then 'MANUAL'
    when sd.id is not null then 'SKU_DO_ANUNCIO'
  end as vinculo_via,
  l.id as manual_link_id,
  sd.sku as sku_pelo_anuncio
from unidades u
left join public.shopee_sku_links l
  on l.shopee_shop_id = u.shopee_shop_id
 and l.item_id = u.item_id
 and l.model_id is not distinct from u.model_id
left join public.skus sm on sm.id = l.sku_id
left join public.skus sd
  on sd.organization_id = u.organization_id
 and sd.sku_key = upper(btrim(u.sku_anuncio))
 and not u.aguardando;

comment on view public.shopee_listing_units is
  'Unidade de anuncio Shopee (variacao, ou o item sem variacao) com o vinculo: o MANUAL (shopee_sku_links, D-429) vence o pelo SKU do anuncio (upper(btrim(SKU)) = skus.sku_key, D-428). Itens apagados de fora.';

-- ------------------------------------------------------------
-- A lista da tela ganha o id do vinculo manual e o SKU que o anuncio indica.
-- O retorno muda: drop e create.
-- ------------------------------------------------------------
drop function public.get_shopee_listings(uuid, uuid, text, text, integer, integer);

create function public.get_shopee_listings(
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
  manual_link_id uuid,
  sku_pelo_anuncio text,
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
    f.manual_link_id,
    f.sku_pelo_anuncio,
    count(*) over () as total_count
  from filtrado f
  join public.shopee_shops sh on sh.id = f.shopee_shop_id
  order by f.item_name nulls last, f.item_id, f.model_name nulls first, f.model_id nulls first
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) is
  'Anuncios Shopee da organizacao (D-428, D-429), uma linha por unidade, com o vinculo (manual vence o SKU do anuncio), o id do vinculo manual e o SKU que o anuncio indicaria; filtro por loja, estado e busca; paginada (ate 200) com total_count.';

revoke all on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.get_shopee_listings(uuid, uuid, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- Os anuncios Shopee de UM SKU (painel da pagina do SKU).
-- ------------------------------------------------------------
create or replace function public.get_sku_shopee_listings(p_organization_id uuid, p_sku_id uuid)
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
  available_stock integer,
  vinculo_via text,
  manual_link_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    u.shopee_shop_id,
    sh.shop_name,
    u.item_id,
    u.model_id,
    u.item_name,
    u.model_name,
    u.sku_anuncio,
    u.item_status,
    u.model_status,
    u.currency,
    u.current_price,
    u.available_stock,
    u.vinculo_via,
    u.manual_link_id
  from public.shopee_listing_units u
  join public.shopee_shops sh on sh.id = u.shopee_shop_id
  where u.organization_id = p_organization_id
    and u.sku_id = p_sku_id
  order by sh.shop_name nulls last, u.item_name nulls last, u.item_id, u.model_id nulls first
  limit 200;
$$;

comment on function public.get_sku_shopee_listings(uuid, uuid) is
  'Anuncios Shopee vinculados a um SKU (D-429), pelo vinculo manual ou pelo SKU do anuncio; ate 200.';

revoke all on function public.get_sku_shopee_listings(uuid, uuid) from public, anon;
grant execute on function public.get_sku_shopee_listings(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- Por loja, para /contas: quantos anuncios e quantos vinculados. Loja cujo
-- catalogo nunca foi lido devolve NULO, nunca zero.
-- ------------------------------------------------------------
create or replace function public.get_shopee_shop_catalog_counts(p_organization_id uuid)
returns table (shopee_shop_id uuid, anuncios bigint, vinculados bigint, ultima_leitura timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    sh.id,
    case when sh.items_synced_until is null then null else count(u.item_id) end,
    case when sh.items_synced_until is null then null else count(u.item_id) filter (where u.estado = 'VINCULADO') end,
    sh.items_synced_until
  from public.shopee_shops sh
  left join public.shopee_listing_units u on u.shopee_shop_id = sh.id
  where sh.organization_id = p_organization_id
  group by sh.id, sh.items_synced_until;
$$;

comment on function public.get_shopee_shop_catalog_counts(uuid) is
  'Por loja Shopee (D-429): anuncios e vinculados (manual ou pelo SKU do anuncio) e a ultima leitura do catalogo; NULO quando o catalogo nunca foi lido.';

revoke all on function public.get_shopee_shop_catalog_counts(uuid) from public, anon;
grant execute on function public.get_shopee_shop_catalog_counts(uuid) to authenticated;
