-- ============================================================
-- D-163 — remapeamento pós-relist, atômico e auditável.
--
-- O ML renova o item_id E os variation_id (docs/MERCADO_LIVRE.md §2.16).
-- Para vínculo de ITEM inteiro, a correspondência pai→filho é determinística:
-- preservamos o link_id e trocamos apenas a referência. Para VARIAÇÃO não há
-- tabela de/para oficial: os vínculos antigos deixam de ser estado corrente e
-- cada variação nova entra na Central de Vinculações para decisão humana.
--
-- Toda a mudança abaixo acontece em UMA função transacional. O worker nunca
-- pode deixar `listing_relists=REMAPPED` com vínculo/candidato pela metade.
-- A função é SECURITY INVOKER e só service_role recebe EXECUTE.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A fila existente passa a aceitar candidatos nascidos de relist.
--    ERP_IMPORT continua com source_row_id; RELIST usa source_relist_id.
-- ------------------------------------------------------------
alter table public.link_candidates
  drop constraint link_candidates_source_check,
  drop constraint link_candidates_source_row_unique,
  alter column source_row_id drop not null,
  add column source_relist_id uuid references public.listing_relists(id) on delete restrict,
  add constraint link_candidates_source_check check (source in ('ERP_IMPORT', 'RELIST')),
  add constraint link_candidates_source_coherent check (
    (source = 'ERP_IMPORT' and source_row_id is not null and source_relist_id is null)
    or
    (source = 'RELIST' and source_row_id is null and source_relist_id is not null)
  );

create unique index link_candidates_erp_source_row_unique
  on public.link_candidates (source, source_row_id)
  where source = 'ERP_IMPORT';

create unique index link_candidates_relist_variation_unique
  on public.link_candidates (source_relist_id, item_id, variation_id)
  where source = 'RELIST';

comment on column public.link_candidates.source_relist_id is
  'Operacao de relist que criou o candidato. Só source=RELIST; variation_id renovado exige escolha humana.';

comment on table public.link_candidates is
  'Referência sem vínculo pendente de resolução. ERP_IMPORT nasce de linha UpSeller; RELIST nasce de variation_id renovado sem mapa oficial (D-163).';

-- ------------------------------------------------------------
-- 2. O histórico de vínculo ganha a operação que muda a REFERÊNCIA, não o
--    SKU. É diferente de RETARGETED (que troca sku_id).
-- ------------------------------------------------------------
alter table public.sku_listing_link_events
  drop constraint sku_listing_link_events_event_type_check,
  drop constraint sku_listing_link_events_target_coherent,
  add column previous_item_id text check (previous_item_id is null or previous_item_id ~ '^MLB[0-9]+$'),
  add constraint sku_listing_link_events_event_type_check
    check (event_type in ('CREATED', 'RETARGETED', 'REFERENCE_REMAPPED', 'REMOVED')),
  add constraint sku_listing_link_events_target_coherent check (
    (event_type = 'RETARGETED'
      and previous_sku_id is not null and previous_sku_id <> sku_id
      and previous_item_id is null)
    or
    (event_type = 'REFERENCE_REMAPPED'
      and previous_sku_id is null and previous_item_id is not null
      and ref_kind = 'ITEM' and item_id is not null
      and previous_item_id <> item_id)
    or
    (event_type in ('CREATED', 'REMOVED')
      and previous_sku_id is null and previous_item_id is null)
  );

comment on column public.sku_listing_link_events.previous_item_id is
  'Referência anterior somente em REFERENCE_REMAPPED; preserva o pai quando o mesmo link_id passa a apontar ao filho.';

-- Remoção por relist também é supressão: a próxima planilha velha do
-- UpSeller não pode recriar o vínculo do pai encerrado.
drop index sku_listing_link_events_human_removed_idx;

create index sku_listing_link_events_suppressed_idx
  on public.sku_listing_link_events
     (ml_account_id, ref_kind, item_id, variation_id, user_product_id)
  where event_type = 'REMOVED'
    and (actor_source = 'HUMAN' or (actor_source = 'RULE' and reason = 'RELIST_VARIATION_RENEWED'));

-- ------------------------------------------------------------
-- 3. A transação completa: projeção do filho + vínculo/candidatos + ambos
--    os históricos + estado terminal.
-- ------------------------------------------------------------
create function public.complete_listing_relist_remap(
  p_relist_id uuid,
  p_child_title text,
  p_child_status text,
  p_child_price numeric,
  p_child_currency_id text,
  p_child_available_quantity integer,
  p_child_category_id text,
  p_child_variations jsonb
)
returns table (
  item_links_remapped integer,
  variation_links_retired integer,
  variation_candidates_created integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  op public.listing_relists;
  whole_link public.sku_listing_links;
  whole_count integer;
  variation_count integer;
  child_variation_count integer;
  distinct_child_variation_count integer;
  inserted_candidates integer := 0;
  child_sku_id uuid;
  transition_reason text;
begin
  item_links_remapped := 0;
  variation_links_retired := 0;
  variation_candidates_created := 0;

  select * into op
  from public.listing_relists
  where id = p_relist_id
  for update;

  if op.id is null then
    raise exception 'relist % nao encontrado', p_relist_id;
  end if;

  if op.status = 'REMAPPED' then
    return next;
    return;
  end if;

  if op.status <> 'RELISTED' or op.child_item_id is null then
    raise exception 'relist % nao esta pronto para remapeamento (status=%)', p_relist_id, op.status;
  end if;

  if p_child_title is null or btrim(p_child_title) = ''
     or p_child_status is null or btrim(p_child_status) = ''
     or p_child_currency_id is null or btrim(p_child_currency_id) = ''
     or p_child_price is null or p_child_price < 0
     or p_child_available_quantity is null or p_child_available_quantity < 0 then
    raise exception 'projecao do filho incompleta para relist %', p_relist_id;
  end if;

  if p_child_variations is null or jsonb_typeof(p_child_variations) <> 'array' then
    raise exception 'variacoes do filho devem ser um array para relist %', p_relist_id;
  end if;

  select count(*), count(distinct v.id)
    into child_variation_count, distinct_child_variation_count
  from jsonb_to_recordset(p_child_variations) as v(id text, channel_sku text)
  where v.id ~ '^[0-9]+$';

  if child_variation_count <> jsonb_array_length(p_child_variations)
     or distinct_child_variation_count <> child_variation_count then
    raise exception 'variacoes do filho invalidas ou duplicadas para relist %', p_relist_id;
  end if;

  select count(*) filter (where variation_id is null),
         count(*) filter (where variation_id is not null)
    into whole_count, variation_count
  from public.sku_listing_links
  where ml_account_id = op.ml_account_id
    and ref_kind = 'ITEM'
    and item_id = op.parent_item_id;

  if whole_count > 0 and variation_count > 0 then
    raise exception 'relist % encontrou mistura de vinculo inteiro e variacoes no pai', p_relist_id;
  end if;

  if whole_count > 1 then
    raise exception 'relist % encontrou mais de um vinculo inteiro no pai', p_relist_id;
  end if;

  if whole_count = 1 then
    select * into whole_link
    from public.sku_listing_links
    where ml_account_id = op.ml_account_id
      and ref_kind = 'ITEM'
      and item_id = op.parent_item_id
      and variation_id is null
    for update;

    if exists (
      select 1 from public.sku_listing_links
      where ml_account_id = op.ml_account_id
        and ref_kind = 'ITEM'
        and item_id = op.child_item_id
    ) then
      raise exception 'filho % ja tem vinculo; remapeamento automatico recusado', op.child_item_id;
    end if;

    update public.sku_listing_links
      set item_id = op.child_item_id
      where id = whole_link.id;

    insert into public.sku_listing_link_events (
      organization_id, ml_account_id, link_id, event_type,
      ref_kind, item_id, variation_id, user_product_id, channel_sku,
      sku_id, previous_item_id, link_source, actor_source, reason
    ) values (
      whole_link.organization_id, whole_link.ml_account_id, whole_link.id, 'REFERENCE_REMAPPED',
      whole_link.ref_kind, op.child_item_id, whole_link.variation_id, whole_link.user_product_id,
      whole_link.channel_sku, whole_link.sku_id, op.parent_item_id,
      whole_link.source, 'RULE', 'RELIST_ITEM_REMAPPED'
    );

    item_links_remapped := 1;
  elsif variation_count > 0 then
    if child_variation_count = 0 then
      raise exception 'pai tinha % vinculos de variacao, mas o filho nao devolveu variacoes', variation_count;
    end if;

    -- Cada id novo vira trabalho humano. O seller_custom_field, quando
    -- existir, é só pista visual — nunca autorização para mapear sozinho.
    insert into public.link_candidates (
      organization_id, ml_account_id, source, source_row_id, source_relist_id,
      sku_key, ref_kind, item_id, variation_id, channel_sku, status
    )
    select op.organization_id, op.ml_account_id, 'RELIST', null, op.id,
           coalesce(nullif(btrim(v.channel_sku), ''), 'VARIACAO-' || v.id),
           'ITEM', op.child_item_id, v.id, nullif(btrim(v.channel_sku), ''), 'OPEN'
    from jsonb_to_recordset(p_child_variations) as v(id text, channel_sku text)
    where not exists (
      select 1 from public.sku_listing_links k
      where k.ml_account_id = op.ml_account_id
        and k.ref_kind = 'ITEM'
        and k.item_id = op.child_item_id
        and k.variation_id = v.id
    )
    on conflict (source_relist_id, item_id, variation_id) where source = 'RELIST'
    do update set
      channel_sku = excluded.channel_sku,
      sku_key = excluded.sku_key,
      updated_at = now();

    get diagnostics inserted_candidates = row_count;
    variation_candidates_created := inserted_candidates;

    insert into public.sku_listing_link_events (
      organization_id, ml_account_id, link_id, event_type,
      ref_kind, item_id, variation_id, user_product_id, channel_sku,
      sku_id, link_source, actor_source, reason
    )
    select k.organization_id, k.ml_account_id, k.id, 'REMOVED',
           k.ref_kind, k.item_id, k.variation_id, k.user_product_id, k.channel_sku,
           k.sku_id, k.source, 'RULE', 'RELIST_VARIATION_RENEWED'
    from public.sku_listing_links k
    where k.ml_account_id = op.ml_account_id
      and k.ref_kind = 'ITEM'
      and k.item_id = op.parent_item_id
      and k.variation_id is not null;

    delete from public.sku_listing_links
    where ml_account_id = op.ml_account_id
      and ref_kind = 'ITEM'
      and item_id = op.parent_item_id
      and variation_id is not null;

    get diagnostics variation_links_retired = row_count;
  end if;

  select k.sku_id into child_sku_id
  from public.sku_listing_links k
  where k.ml_account_id = op.ml_account_id
    and k.ref_kind = 'ITEM'
    and k.item_id = op.child_item_id
    and k.variation_id is null
  limit 1;

  insert into public.listings (
    organization_id, ml_account_id, item_id, sku_id, title, status,
    price, currency_id, available_quantity, category_id, synced_at
  ) values (
    op.organization_id, op.ml_account_id, op.child_item_id, child_sku_id,
    p_child_title, p_child_status, p_child_price, p_child_currency_id,
    p_child_available_quantity, p_child_category_id, now()
  )
  on conflict (ml_account_id, item_id) do update set
    organization_id = excluded.organization_id,
    sku_id = excluded.sku_id,
    title = excluded.title,
    status = excluded.status,
    price = excluded.price,
    currency_id = excluded.currency_id,
    available_quantity = excluded.available_quantity,
    category_id = excluded.category_id,
    synced_at = excluded.synced_at;

  update public.listings
    set status = 'closed', synced_at = now()
    where ml_account_id = op.ml_account_id and item_id = op.parent_item_id;

  transition_reason := case
    when item_links_remapped = 1 then 'ITEM_LINK_REMAPPED'
    when variation_links_retired > 0 then 'VARIATIONS_QUEUED:' || variation_candidates_created::text
    else 'PARENT_WITHOUT_LINK'
  end;

  update public.listing_relists
    set status = 'REMAPPED', failure_reason = null
    where id = op.id and status = 'RELISTED';

  if not found then
    raise exception 'relist % mudou de estado durante o remapeamento', op.id;
  end if;

  insert into public.listing_relist_events (
    organization_id, ml_account_id, relist_id, from_status, to_status,
    actor_user_id, reason
  ) values (
    op.organization_id, op.ml_account_id, op.id, 'RELISTED', 'REMAPPED',
    null, transition_reason
  );

  return next;
end;
$$;

comment on function public.complete_listing_relist_remap is
  'D-163: transação service_role-only que remapeia ITEM pai→filho ou envia variation_ids renovados à Central de Vinculações, e só então marca REMAPPED.';

revoke all on function public.complete_listing_relist_remap(uuid, text, text, numeric, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_listing_relist_remap(uuid, text, text, numeric, text, integer, text, jsonb)
  to service_role;
