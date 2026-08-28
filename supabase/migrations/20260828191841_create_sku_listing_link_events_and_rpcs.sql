-- Desfazer vínculo + histórico auditável (D-125). As duas nascem juntas,
-- como o roadmap exigia: sem histórico, remover é destruir.
--
-- POR QUE REMOÇÃO FÍSICA E NÃO `removed_at` (soft delete). Um painel de
-- desenho testou as duas, e o soft delete quebra em três lugares:
--   1. `resolveSku` (persist-order.ts) filtra pela chave natural e termina em
--      `.maybeSingle()`. Remover e revincular criaria DUAS linhas com a mesma
--      chave (o índice único só cobriria as vivas) -> PGRST116 -> o `throw`
--      da guarda anti-overselling dispara sobre um estado LEGAL e o pedido
--      inteiro deixa de persistir.
--   2. `get_unlinked_listings` (D-122) é anti-join físico: a lápide continua
--      satisfazendo o `exists`, e o anúncio NÃO volta para a fila.
--   3. `createManualLink` leria a lápide como "já vinculado" e recusaria o
--      revínculo.
-- Além disso exigiria o PRIMEIRO `drop index` em 68 migrations, sobre um dos
-- "três constraints que sustentam o sistema" (`docs/DATABASE.md` secao 3).
--
-- Com remoção física, seis leitores continuam corretos sem UMA linha alterada:
-- a tabela volta a significar o que todos eles já assumem — uma linha, um
-- vínculo vigente.

-- ------------------------------------------------------------
-- 1. O histórico (L2 append-only, nona instância do padrão)
-- ------------------------------------------------------------
create table public.sku_listing_link_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- SEM FK: em REMOVED a linha não existe mais. Mesma forma de
  -- `domain_events.entity_id`, e é o alvo de `order_items.sku_listing_link_id`.
  link_id uuid not null,

  event_type text not null check (event_type in ('CREATED', 'RETARGETED', 'REMOVED')),

  ref_kind text not null check (ref_kind in ('ITEM', 'USER_PRODUCT')),
  item_id text check (item_id is null or item_id ~ '^MLB[0-9]+$'),
  variation_id text check (variation_id is null or variation_id ~ '^[0-9]+$'),
  user_product_id text check (user_product_id is null or user_product_id ~ '^MLBU[0-9]+$'),
  channel_sku text,

  sku_id uuid not null references public.skus(id) on delete restrict,
  previous_sku_id uuid references public.skus(id) on delete restrict,

  link_source text not null check (link_source in ('MANUAL', 'IMPORT_UPSELLER', 'IMPORT_V2', 'RULE')),
  actor_source text not null check (actor_source in ('HUMAN', 'IMPORT', 'RULE')),
  actor_user_id uuid references public.profiles(id) on delete restrict,

  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint sku_listing_link_events_ref_shape check (
    (ref_kind = 'ITEM' and item_id is not null and user_product_id is null)
    or
    (ref_kind = 'USER_PRODUCT' and user_product_id is not null
       and item_id is null and variation_id is null)
  ),

  constraint sku_listing_link_events_actor_coherent check (
    (actor_source = 'HUMAN' and actor_user_id is not null)
    or (actor_source <> 'HUMAN' and actor_user_id is null)
  ),

  constraint sku_listing_link_events_target_coherent check (
    (event_type = 'RETARGETED' and previous_sku_id is not null and previous_sku_id <> sku_id)
    or (event_type in ('CREATED', 'REMOVED') and previous_sku_id is null)
  ),

  -- Remoção por humano exige motivo, no espírito de
  -- `link_candidates_resolved_coherent`.
  constraint sku_listing_link_events_reason_required check (
    not (event_type = 'REMOVED' and actor_source = 'HUMAN') or reason is not null
  )
);

comment on table public.sku_listing_link_events is
  'Auditoria L2 append-only do vinculo SKU<->anuncio (D-125). A criacao em MASSA pelo importador NAO gera evento: a procedencia dela ja vive em erp_import_rows/erp_import_batches. A auditoria comeca nesta migration; para os 20.650 vinculos anteriores a procedencia e sku_listing_links.source + created_at. Sem backfill: evento sintetico seria dado inventado.';

comment on column public.sku_listing_link_events.link_id is
  'Id do vinculo, SEM FK: em REMOVED a linha nao existe mais. Mesma forma de domain_events.entity_id, e alvo de order_items.sku_listing_link_id.';

create index sku_listing_link_events_link_idx
  on public.sku_listing_link_events (link_id, occurred_at desc);

create index sku_listing_link_events_ref_idx
  on public.sku_listing_link_events (ml_account_id, item_id, variation_id)
  where ref_kind = 'ITEM';

-- Consulta de SUPRESSAO do importador: "esta chave foi removida por gente?"
create index sku_listing_link_events_human_removed_idx
  on public.sku_listing_link_events
     (ml_account_id, ref_kind, item_id, variation_id, user_product_id)
  where event_type = 'REMOVED' and actor_source = 'HUMAN';

create or replace function private.sku_listing_link_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception
    'sku_listing_link_events e append-only: % nao e permitido. Insira um novo evento.',
    tg_op;
end;
$$;

revoke all on function private.sku_listing_link_events_reject_mutation() from public, anon, authenticated;

create trigger sku_listing_link_events_no_mutation
  before update or delete on public.sku_listing_link_events
  for each row execute function private.sku_listing_link_events_reject_mutation();

alter table public.sku_listing_link_events enable row level security;

create policy sku_listing_link_events_select_permitted
  on public.sku_listing_link_events for select to authenticated
  using (private.has_account_access(ml_account_id));

grant select on public.sku_listing_link_events to authenticated;
grant select, insert on public.sku_listing_link_events to service_role;
revoke all on public.sku_listing_link_events from anon;

-- ------------------------------------------------------------
-- 2. Fechar a escrita direta em sku_listing_links
--
-- Medido hoje: `authenticated` tem DELETE/INSERT/UPDATE e a policy e `for all`.
-- Qualquer ADMIN/GESTOR/OPERADOR com acesso a conta ja apaga ou reescreve
-- `sku_id` pelo PostgREST, sem interface e sem auditoria. Sem fechar isto, a
-- garantia "toda mudanca deixa evento" seria vazia.
-- Precedente do revoke: 20260827130000.
-- NENHUM indice e tocado. NENHUMA coluna e adicionada.
-- ------------------------------------------------------------
revoke insert, update, delete, truncate on public.sku_listing_links from authenticated;
drop policy sku_listing_links_write_permitted on public.sku_listing_links;

comment on table public.sku_listing_links is
  'Vinculo entre SKU canonico e anuncio/user product do Mercado Livre (D-004). ESTADO CORRENTE PURO: uma linha = um vinculo vigente, sem lapide. Escrita por authenticated SO pelas RPCs create_/retarget_/remove_sku_listing_link (D-125); o historico vive em sku_listing_link_events.';

-- ------------------------------------------------------------
-- 3. Preservar a procedencia ja gravada em order_items
--
-- 255.815 linhas (76,7%) carregam este ponteiro. O `on delete set null` as
-- zeraria de forma irreversivel na primeira remocao. A coluna nao tem leitor
-- de aplicacao hoje, entao tirar a FK nao quebra nada — e o id passa a
-- resolver no snapshot IMUTAVEL do evento, em vez de numa linha mutavel.
-- ------------------------------------------------------------
alter table public.order_items
  drop constraint order_items_sku_listing_link_id_fkey;

comment on column public.order_items.sku_listing_link_id is
  'Vinculo usado para resolver sku_id (D-020). Referencia SEM FK desde D-125: a remocao de vinculo e fisica e o id resolve em sku_listing_link_events (snapshot do REMOVED). Mesma forma de domain_events.entity_id.';

-- ------------------------------------------------------------
-- 4. Autorizacao fatorada — molde de private.check_purchase_order_writer.
--    Mesmos termos da policy que a Fase 2 tinha: a RPC nao pode conceder
--    mais acesso do que a escrita direta concedia.
-- ------------------------------------------------------------
create or replace function private.check_sku_listing_link_writer(
  p_organization_id uuid,
  p_ml_account_id uuid
) returns void language plpgsql stable set search_path = '' as $$
begin
  if not private.is_member_of(p_organization_id)
     or not private.has_account_access(p_ml_account_id)
     or not private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para operar vinculos desta conta';
  end if;
end;
$$;

revoke all on function private.check_sku_listing_link_writer(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5.1 create_sku_listing_link — substitui a escrita direta de D-119.
--     As tres pre-checagens migram para DENTRO da transacao; em
--     `createManualLink` elas eram TOCTOU, como o proprio comentario admitia.
-- ------------------------------------------------------------
create or replace function public.create_sku_listing_link(
  p_ml_account_id uuid,
  p_item_id text,
  p_variation_id text,
  p_sku_id uuid
) returns public.sku_listing_links
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  target_org uuid;
  result public.sku_listing_links;
begin
  select organization_id into v_org from public.ml_accounts where id = p_ml_account_id;

  if v_org is null then
    raise exception 'conta % nao encontrada', p_ml_account_id;
  end if;

  perform private.check_sku_listing_link_writer(v_org, p_ml_account_id);

  select organization_id into target_org from public.skus where id = p_sku_id;

  if target_org is distinct from v_org then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  -- Mistura de formas: os indices parciais sao DISJUNTOS, entao "anuncio
  -- inteiro" e "variacao X" nunca colidem no banco — e o estado misto leva o
  -- estoque Full para o SKU errado (D-119).
  if exists (
    select 1 from public.sku_listing_links k
    where k.ml_account_id = p_ml_account_id
      and k.ref_kind = 'ITEM'
      and k.item_id = p_item_id
      and ((p_variation_id is null) <> (k.variation_id is null))
  ) then
    raise exception 'mistura de formas de vinculo neste anuncio';
  end if;

  if exists (
    select 1 from public.link_candidates c
    where c.ml_account_id = p_ml_account_id
      and c.ref_kind = 'ITEM'
      and c.item_id = p_item_id
      and c.variation_id is not distinct from p_variation_id
      and c.status = 'OPEN'
  ) then
    raise exception 'candidato aberto para esta referencia';
  end if;

  insert into public.sku_listing_links (
    organization_id, ml_account_id, ref_kind, item_id, variation_id,
    sku_id, source, confirmed_by, confirmed_at
  ) values (
    v_org, p_ml_account_id, 'ITEM', p_item_id, p_variation_id,
    p_sku_id, 'MANUAL', (select auth.uid()), now()
  ) returning * into result;

  insert into public.sku_listing_link_events (
    organization_id, ml_account_id, link_id, event_type,
    ref_kind, item_id, variation_id, channel_sku,
    sku_id, link_source, actor_source, actor_user_id
  ) values (
    v_org, p_ml_account_id, result.id, 'CREATED',
    'ITEM', p_item_id, p_variation_id, result.channel_sku,
    p_sku_id, 'MANUAL', 'HUMAN', (select auth.uid())
  );

  return result;
end;
$$;

-- ------------------------------------------------------------
-- 5.2 retarget_sku_listing_link — a operacao PRIMARIA.
--     Preserva o id, logo preserva TODOS os ponteiros de order_items;
--     satisfaz os tres indices trivialmente; e `source='MANUAL'` blinda da
--     planilha para sempre (PROTECTED_SOURCES em erp-import-apply).
-- ------------------------------------------------------------
create or replace function public.retarget_sku_listing_link(
  p_link_id uuid,
  p_sku_id uuid,
  p_reason text default null
) returns public.sku_listing_links
language plpgsql security definer set search_path = '' as $$
declare
  l public.sku_listing_links;
  target_org uuid;
  result public.sku_listing_links;
begin
  select * into l from public.sku_listing_links where id = p_link_id for update;

  if l.id is null then
    raise exception 'vinculo % nao encontrado', p_link_id;
  end if;

  perform private.check_sku_listing_link_writer(l.organization_id, l.ml_account_id);

  if l.sku_id = p_sku_id then
    raise exception 'vinculo % ja aponta para este SKU', p_link_id;
  end if;

  select organization_id into target_org from public.skus where id = p_sku_id;

  if target_org is distinct from l.organization_id then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  update public.sku_listing_links
    set sku_id = p_sku_id,
        source = 'MANUAL',
        confirmed_by = (select auth.uid()),
        confirmed_at = now()
    where id = p_link_id
    returning * into result;

  insert into public.sku_listing_link_events (
    organization_id, ml_account_id, link_id, event_type,
    ref_kind, item_id, variation_id, user_product_id, channel_sku,
    sku_id, previous_sku_id, link_source, actor_source, actor_user_id, reason
  ) values (
    l.organization_id, l.ml_account_id, l.id, 'RETARGETED',
    l.ref_kind, l.item_id, l.variation_id, l.user_product_id, l.channel_sku,
    p_sku_id, l.sku_id, 'MANUAL', 'HUMAN', (select auth.uid()),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  return result;
end;
$$;

-- ------------------------------------------------------------
-- 5.3 remove_sku_listing_link — a operacao RARA.
--     `for update` serializa: o segundo removedor acha a linha ausente e
--     recebe erro limpo. Idempotencia natural, sem dedup_key.
-- ------------------------------------------------------------
create or replace function public.remove_sku_listing_link(
  p_link_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.sku_listing_links;
begin
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'motivo obrigatorio para remover vinculo';
  end if;

  select * into l from public.sku_listing_links where id = p_link_id for update;

  if l.id is null then
    raise exception 'vinculo % nao encontrado (ja removido?)', p_link_id;
  end if;

  perform private.check_sku_listing_link_writer(l.organization_id, l.ml_account_id);

  -- Evento ANTES do delete: le da linha ainda viva.
  insert into public.sku_listing_link_events (
    organization_id, ml_account_id, link_id, event_type,
    ref_kind, item_id, variation_id, user_product_id, channel_sku,
    sku_id, link_source, actor_source, actor_user_id, reason
  ) values (
    l.organization_id, l.ml_account_id, l.id, 'REMOVED',
    l.ref_kind, l.item_id, l.variation_id, l.user_product_id, l.channel_sku,
    l.sku_id, l.source, 'HUMAN', (select auth.uid()), btrim(p_reason)
  );

  delete from public.sku_listing_links where id = p_link_id;
end;
$$;

comment on function public.remove_sku_listing_link is
  'Remove o vinculo e grava REMOVED na mesma transacao. O anuncio volta sozinho para get_unlinked_listings (anti-join fisico). Autorizacao refeita internamente nos termos da antiga policy de escrita.';

revoke all on function public.create_sku_listing_link(uuid, text, text, uuid) from public, anon;
revoke all on function public.retarget_sku_listing_link(uuid, uuid, text) from public, anon;
revoke all on function public.remove_sku_listing_link(uuid, text) from public, anon;
grant execute on function public.create_sku_listing_link(uuid, text, text, uuid) to authenticated;
grant execute on function public.retarget_sku_listing_link(uuid, uuid, text) to authenticated;
grant execute on function public.remove_sku_listing_link(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 6. resolve_link_candidate passa a emitir CREATED. Ja e security definer e
--    ja escreve duas tabelas na mesma transacao — nenhuma doutrina nova.
-- ------------------------------------------------------------
create or replace function public.resolve_link_candidate(p_candidate_id uuid, p_sku_id uuid)
returns public.sku_listing_links
language plpgsql security definer set search_path = '' as $$
declare
  c public.link_candidates;
  target_org uuid;
  result public.sku_listing_links;
begin
  select * into c from public.link_candidates where id = p_candidate_id for update;

  if c.id is null then
    raise exception 'candidato % nao encontrado', p_candidate_id;
  end if;

  if c.status <> 'OPEN' then
    raise exception 'candidato % nao esta aberto', p_candidate_id;
  end if;

  if not private.is_member_of(c.organization_id)
     or not private.has_account_access(c.ml_account_id)
     or not private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para vincular este candidato';
  end if;

  select organization_id into target_org from public.skus where id = p_sku_id;

  if target_org is distinct from c.organization_id then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  insert into public.sku_listing_links (
    organization_id, ml_account_id, ref_kind, item_id, variation_id, user_product_id,
    sku_id, channel_sku, source, confirmed_by, confirmed_at
  ) values (
    c.organization_id, c.ml_account_id, c.ref_kind, c.item_id, c.variation_id, c.user_product_id,
    p_sku_id, c.channel_sku, 'MANUAL', (select auth.uid()), now()
  )
  returning * into result;

  insert into public.sku_listing_link_events (
    organization_id, ml_account_id, link_id, event_type,
    ref_kind, item_id, variation_id, user_product_id, channel_sku,
    sku_id, link_source, actor_source, actor_user_id
  ) values (
    c.organization_id, c.ml_account_id, result.id, 'CREATED',
    c.ref_kind, c.item_id, c.variation_id, c.user_product_id, c.channel_sku,
    p_sku_id, 'MANUAL', 'HUMAN', (select auth.uid())
  );

  update public.link_candidates
    set status = 'RESOLVED',
        resolved_sku_id = p_sku_id,
        resolved_by = (select auth.uid()),
        resolved_at = now(),
        resolution_method = 'MANUAL'
    where id = p_candidate_id;

  return result;
end;
$$;
