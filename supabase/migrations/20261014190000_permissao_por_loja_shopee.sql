-- ============================================================
-- D-433 -- permissao por LOJA Shopee, a mesma regra das contas do Mercado
-- Livre (etapa E2 da frente multicanal, risco S1 de
-- docs/MULTICHANNEL_CONTRACTS.md).
--
-- O ML separa o PAPEL (o que a pessoa faz) do ALCANCE (em quais contas):
-- ADMIN alcanca todas as contas da organizacao; os demais, as concedidas em
-- `user_account_permissions` (D-175, PRODUCT_REQUIREMENTS: "respeitar
-- permissoes por conta"). As tabelas `shopee_*` nasceram filtrando so por
-- ORGANIZACAO (D-425 a D-430): um usuario restrito a uma conta ML via todas
-- as lojas Shopee, com pedidos e financeiro. Latente em 14/10 (todo membro
-- nao-ADMIN de producao tem todas as contas ML), mas nada permitia
-- restringir uma loja -- e o consolidado entre canais (E4) somaria o que a
-- pessoa nao deveria ver.
--
-- O desenho e o do ML, em tabela propria:
--   - `user_shopee_shop_permissions` (usuario, loja): o alcance concedido;
--   - `private.accessible_shopee_shops()`: o CONJUNTO de lojas do chamador
--     (ADMIN: todas da organizacao), na forma de D-181 (uma vez por consulta);
--   - as sete politicas de leitura `shopee_*` passam de organizacao para loja;
--     views (`security_invoker`) e RPCs `security invoker` herdam;
--   - o vinculo manual (RPCs `security definer`) exige o alcance da loja,
--     como `check_sku_listing_link_writer` exige o da conta;
--   - a concessao e auditada em `organization_access_events`, como a da conta.
--
-- NINGUEM PERDE VISAO NO DIA: as lojas que ja existem sao concedidas a quem
-- hoje alcanca TODAS as contas ML da organizacao. Loja conectada depois
-- nasce so do ADMIN, como a conta ML, ate ele conceder.
-- ============================================================

create table public.user_shopee_shop_permissions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  shopee_shop_id uuid not null references public.shopee_shops (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, shopee_shop_id)
);

create index user_shopee_shop_permissions_shop_idx on public.user_shopee_shop_permissions (shopee_shop_id);

comment on table public.user_shopee_shop_permissions is
  'Em quais lojas Shopee o usuario pode atuar (D-433), o espelho de user_account_permissions. ADMIN alcanca todas da organizacao sem linha aqui. Escrita so por ADMIN da organizacao da loja; cada concessao e revogacao vira evento em organization_access_events.';

-- ------------------------------------------------------------
-- O alcance, como conjunto (D-181) e como pergunta pontual.
-- ------------------------------------------------------------
create function private.accessible_shopee_shops()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.shopee_shops s
  join public.organization_members m
    on m.organization_id = s.organization_id
  where m.user_id = (select auth.uid())
    and (
      m.role = 'ADMIN'
      or exists (
        select 1
        from public.user_shopee_shop_permissions p
        where p.shopee_shop_id = s.id
          and p.user_id = m.user_id
      )
    );
$$;

comment on function private.accessible_shopee_shops() is
  'Lojas Shopee que o chamador alcanca, como CONJUNTO (D-433, forma de D-181): ADMIN todas as da organizacao; os demais, as de user_shopee_shop_permissions.';

create function private.has_shopee_shop_access(p_shopee_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.accessible_shopee_shops() a where a = p_shopee_shop_id);
$$;

comment on function private.has_shopee_shop_access(uuid) is
  'O chamador alcanca esta loja Shopee? (D-433) Para RPC que valida UMA loja; em politica, use accessible_shopee_shops().';

revoke all on function private.accessible_shopee_shops() from public, anon;
revoke all on function private.has_shopee_shop_access(uuid) from public, anon;
grant execute on function private.accessible_shopee_shops() to authenticated, service_role;
grant execute on function private.has_shopee_shop_access(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- As sete politicas de leitura: de organizacao para loja.
-- ------------------------------------------------------------
drop policy shopee_shops_select_member on public.shopee_shops;
create policy shopee_shops_select_permitted
  on public.shopee_shops for select to authenticated
  using (id in (select private.accessible_shopee_shops()));

drop policy shopee_orders_select_member on public.shopee_orders;
create policy shopee_orders_select_permitted
  on public.shopee_orders for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

drop policy shopee_order_items_select_member on public.shopee_order_items;
create policy shopee_order_items_select_permitted
  on public.shopee_order_items for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

drop policy shopee_items_select_member on public.shopee_items;
create policy shopee_items_select_permitted
  on public.shopee_items for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

drop policy shopee_item_models_select_member on public.shopee_item_models;
create policy shopee_item_models_select_permitted
  on public.shopee_item_models for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

drop policy shopee_sku_links_select_member on public.shopee_sku_links;
create policy shopee_sku_links_select_permitted
  on public.shopee_sku_links for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

drop policy shopee_sku_link_events_select_member on public.shopee_sku_link_events;
create policy shopee_sku_link_events_select_permitted
  on public.shopee_sku_link_events for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

-- ------------------------------------------------------------
-- A concessao: quem le e quem escreve (o espelho de
-- user_account_permissions_select_own e _admin_writes, ja com has_org_role).
-- Alem do ML: so se concede a quem e membro da organizacao da loja.
-- ------------------------------------------------------------
alter table public.user_shopee_shop_permissions enable row level security;

create policy user_shopee_shop_permissions_select
  on public.user_shopee_shop_permissions for select to authenticated
  using (
    user_id = (select auth.uid())
    or shopee_shop_id in (select private.accessible_shopee_shops())
  );

create policy user_shopee_shop_permissions_admin_insert
  on public.user_shopee_shop_permissions for insert to authenticated
  with check (
    exists (
      select 1
      from public.shopee_shops s
      join public.organization_members m
        on m.organization_id = s.organization_id
       and m.user_id = user_shopee_shop_permissions.user_id
      where s.id = user_shopee_shop_permissions.shopee_shop_id
        and private.has_org_role(s.organization_id, array['ADMIN'])
    )
  );

create policy user_shopee_shop_permissions_admin_delete
  on public.user_shopee_shop_permissions for delete to authenticated
  using (
    exists (
      select 1
      from public.shopee_shops s
      where s.id = user_shopee_shop_permissions.shopee_shop_id
        and private.has_org_role(s.organization_id, array['ADMIN'])
    )
  );

revoke all on public.user_shopee_shop_permissions from anon, authenticated;
grant select, insert, delete on public.user_shopee_shop_permissions to authenticated;
grant all on public.user_shopee_shop_permissions to service_role;

-- ------------------------------------------------------------
-- A auditoria: os dois eventos novos em organization_access_events, com a
-- loja SEM FK (como target_user_id): o evento sobrevive a loja apagada, e o
-- historico e append-only -- um `on delete set null` viraria UPDATE recusado.
-- ------------------------------------------------------------
alter table public.organization_access_events add column if not exists shopee_shop_id uuid;

comment on column public.organization_access_events.shopee_shop_id is
  'A loja Shopee dos eventos SHOPEE_SHOP_ACCESS_* (D-433). Sem FK: o evento e rastro e sobrevive a loja.';

alter table public.organization_access_events drop constraint organization_access_events_event_type_check;
alter table public.organization_access_events add constraint organization_access_events_event_type_check
  check (event_type in (
    'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED',
    'ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED',
    'MEMBER_SUSPENDED', 'MEMBER_REACTIVATED',
    'SHOPEE_SHOP_ACCESS_GRANTED', 'SHOPEE_SHOP_ACCESS_REVOKED'
  ));

alter table public.organization_access_events drop constraint organization_access_events_role_shape;
alter table public.organization_access_events add constraint organization_access_events_role_shape
  check (
    (event_type = 'MEMBER_ADDED' and new_role is not null and previous_role is null and shopee_shop_id is null)
    or (event_type = 'MEMBER_ROLE_CHANGED' and new_role is not null and previous_role is not null and shopee_shop_id is null)
    or (event_type = 'MEMBER_REMOVED' and previous_role is not null and new_role is null and shopee_shop_id is null)
    or (event_type in ('ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED')
        and ml_account_id is not null and previous_role is null and new_role is null and shopee_shop_id is null)
    or (event_type in ('MEMBER_SUSPENDED', 'MEMBER_REACTIVATED')
        and ml_account_id is null and previous_role is null and new_role is null and shopee_shop_id is null)
    or (event_type in ('SHOPEE_SHOP_ACCESS_GRANTED', 'SHOPEE_SHOP_ACCESS_REVOKED')
        and shopee_shop_id is not null and ml_account_id is null and previous_role is null and new_role is null)
  );

create or replace function private.log_shopee_shop_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_loja uuid := coalesce(new.shopee_shop_id, old.shopee_shop_id);
begin
  select s.organization_id into v_org from public.shopee_shops s where s.id = v_loja;

  -- Loja ja apagada (cascade): sem organizacao para pendurar o evento.
  if v_org is null then
    return coalesce(new, old);
  end if;

  insert into public.organization_access_events
    (organization_id, event_type, target_user_id, shopee_shop_id, actor_user_id)
  values (
    v_org,
    case when tg_op = 'INSERT' then 'SHOPEE_SHOP_ACCESS_GRANTED' else 'SHOPEE_SHOP_ACCESS_REVOKED' end,
    coalesce(new.user_id, old.user_id),
    v_loja,
    (select auth.uid())
  );

  return coalesce(new, old);
end;
$$;

create trigger user_shopee_shop_permissions_audit
  after insert or delete on public.user_shopee_shop_permissions
  for each row execute function private.log_shopee_shop_access_change();

-- ------------------------------------------------------------
-- Quem sai da organizacao perde as lojas dela. No ML a limpeza das contas e
-- da tela (removeMember, D-354); aqui e do banco, para valer em qualquer
-- caminho de remocao. Cada linha apagada grava SHOPEE_SHOP_ACCESS_REVOKED.
-- (Sem o vinculo a permissao ja nao vale -- accessible_shopee_shops exige o
-- membro --, mas uma permissao orfa ressuscitaria num convite futuro.)
-- ------------------------------------------------------------
create or replace function private.revoke_shopee_shops_of_removed_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.user_shopee_shop_permissions p
   using public.shopee_shops s
   where s.id = p.shopee_shop_id
     and s.organization_id = old.organization_id
     and p.user_id = old.user_id;

  return old;
end;
$$;

create trigger organization_members_revoke_shopee_shops
  after delete on public.organization_members
  for each row execute function private.revoke_shopee_shops_of_removed_member();

-- ------------------------------------------------------------
-- NINGUEM PERDE VISAO NO DIA: as lojas existentes para quem hoje alcanca
-- TODAS as contas ML da organizacao (o que, no ML, e "ver tudo"). ADMIN nao
-- precisa de linha. O evento sai com ator NULO: veio de migration.
-- ------------------------------------------------------------
insert into public.user_shopee_shop_permissions (user_id, shopee_shop_id)
select m.user_id, s.id
from public.shopee_shops s
join public.organization_members m on m.organization_id = s.organization_id
where m.role <> 'ADMIN'
  and not exists (
    select 1
    from public.ml_accounts a
    where a.organization_id = s.organization_id
      and not exists (
        select 1 from public.user_account_permissions p
        where p.ml_account_id = a.id and p.user_id = m.user_id
      )
  )
on conflict do nothing;

-- ------------------------------------------------------------
-- O vinculo manual exige o alcance da loja. Corpos vigentes (D-430 e D-429)
-- com uma condicao a mais; assinatura e grants iguais.
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

  -- D-433: papel na organizacao E alcance da loja, como no ML
  -- (check_sku_listing_link_writer exige has_account_access).
  if v_ator is null
     or not private.has_org_role(v_org, array['ADMIN', 'GESTOR', 'OPERADOR'])
     or not private.has_shopee_shop_access(p_shopee_shop_id) then
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
      perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_atual.id, p_sku_id);
      return v_atual.id;
    end if;

    update public.shopee_sku_links
       set sku_id = p_sku_id, updated_by = v_ator, updated_at = now()
     where id = v_atual.id;

    insert into public.shopee_sku_link_events
      (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, previous_sku_id, actor_user_id, reason)
    values
      (v_org, p_shopee_shop_id, v_atual.id, 'RETARGETED', p_item_id, p_model_id, p_sku_id, v_atual.sku_id, v_ator, v_motivo);

    perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_atual.id, p_sku_id);

    return v_atual.id;
  end if;

  insert into public.shopee_sku_links (organization_id, shopee_shop_id, item_id, model_id, sku_id, created_by, updated_by)
  values (v_org, p_shopee_shop_id, p_item_id, p_model_id, p_sku_id, v_ator, v_ator)
  returning id into v_id;

  insert into public.shopee_sku_link_events
    (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, actor_user_id, reason)
  values
    (v_org, p_shopee_shop_id, v_id, 'CREATED', p_item_id, p_model_id, p_sku_id, v_ator, v_motivo);

  perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_id, p_sku_id);

  return v_id;
end;
$$;

comment on function public.set_shopee_sku_link(uuid, bigint, bigint, uuid, text) is
  'Vinculo manual de uma unidade de anuncio Shopee (D-429): cria ou troca o SKU, com evento, e preenche o SKU que faltava nas vendas da unidade (D-430). Exige ADMIN/GESTOR/OPERADOR na organizacao da loja E alcance da loja (D-433), SKU da mesma organizacao e a unidade no catalogo sincronizado.';

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

  if v_ator is null
     or not private.has_org_role(v_link.organization_id, array['ADMIN', 'GESTOR', 'OPERADOR'])
     or not private.has_shopee_shop_access(v_link.shopee_shop_id) then
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
  'Remove o vinculo manual de um anuncio Shopee (D-429), com motivo obrigatorio e evento REMOVED; exige papel e alcance da loja (D-433). O vinculo pelo SKU do anuncio volta a valer.';
