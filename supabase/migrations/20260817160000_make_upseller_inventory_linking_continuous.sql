-- Keep canonical products reconciled against the current UpSeller model even
-- when products are created after the import that produced that model.

create table public.product_inventory_reconcile_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  reason text not null,
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((lease_id is null and lease_expires_at is null)
    or (lease_id is not null and lease_expires_at is not null)),
  foreign key (organization_id, product_id)
    references public.products(organization_id, id) on delete cascade
);

create unique index product_inventory_reconcile_jobs_active_idx
  on public.product_inventory_reconcile_jobs (organization_id, product_id)
  where status in ('queued','running');

create index product_inventory_reconcile_jobs_queue_idx
  on public.product_inventory_reconcile_jobs (status, next_attempt_at, created_at, id)
  where status in ('queued','running');

create index product_inventory_reconcile_jobs_product_idx
  on public.product_inventory_reconcile_jobs (organization_id, product_id, status);

create trigger product_inventory_reconcile_jobs_set_updated_at
before update on public.product_inventory_reconcile_jobs
for each row execute function private.set_updated_at();

alter table public.product_inventory_reconcile_jobs enable row level security;

create policy product_inventory_reconcile_jobs_admin_select
on public.product_inventory_reconcile_jobs
for select to authenticated
using (private.has_organization_role(organization_id, array['admin'::public.app_role]));

revoke all on public.product_inventory_reconcile_jobs from public, anon, authenticated;
grant select on public.product_inventory_reconcile_jobs to authenticated;
grant all on public.product_inventory_reconcile_jobs to service_role;

-- A single candidate source is authoritative regardless of how many ML rows
-- prove it. Different physical source_sku_key values remain distinct so the
-- reconciliation function can preserve real conflicts.
create or replace function private.inventory_link_candidates_for_product(
  target_product_id uuid
)
returns table (
  organization_id uuid,
  product_id uuid,
  source_sku text,
  source_sku_key text,
  source_kind text,
  link_method text,
  priority integer,
  evidence jsonb,
  source_import_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select product.id, product.organization_id, product.sku, product.sku_key
    from public.products product
    where product.id = target_product_id
  ),
  exact_candidate as (
    select
      target.organization_id,
      target.id as product_id,
      coalesce(kit.kit_sku, catalog.source_sku, stock.source_sku, target.sku) as source_sku,
      target.sku_key as source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end as source_kind,
      'exact_sku'::text as link_method,
      1 as priority,
      jsonb_build_object(
        'canonicalSku', target.sku,
        'stockExact', stock.source_sku is not null,
        'catalogExact', catalog.id is not null,
        'kitDefinitionSource', kit.definition_source,
        'unresolvedDotted', unresolved.id is not null
      ) as evidence,
      coalesce(kit.source_import_id, catalog.source_import_id, stock.source_import_id) as source_import_id
    from target
    left join public.upseller_kits kit
      on kit.organization_id = target.organization_id
     and kit.kit_sku_key = target.sku_key
     and kit.is_current
    left join public.upseller_product_catalog catalog
      on catalog.organization_id = target.organization_id
     and catalog.sku_key = target.sku_key
    left join lateral (
      select state.source_sku, state.source_import_id
      from public.upseller_stock_states state
      where state.organization_id = target.organization_id
        and state.sku_key = target.sku_key
      order by state.warehouse_key, state.id
      limit 1
    ) stock on true
    left join public.upseller_unresolved_kits unresolved
      on unresolved.organization_id = target.organization_id
     and unresolved.source_sku_key = target.sku_key
     and unresolved.is_current
    where kit.id is not null or catalog.id is not null or stock.source_sku is not null
  ),
  relationship_candidates as (
    select
      target.organization_id,
      target.id as product_id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end as source_kind,
      'ml_item_relationship'::text as link_method,
      2 as priority,
      jsonb_build_object(
        'itemId', listing.item_id,
        'storeName', relation.store_name,
        'mlAccountId', listing.ml_account_id
      ) as evidence,
      relation.source_import_id
    from target
    join public.ml_listings listing
      on listing.organization_id = target.organization_id
     and listing.product_id = target.id
     and listing.is_current
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = target.organization_id
     and relation.ml_account_id = listing.ml_account_id
     and relation.listing_external_id = listing.item_id
     and relation.channel = 'mercado_livre'
     and relation.is_current
    join public.upseller_store_aliases alias
      on alias.organization_id = relation.organization_id
     and alias.store_name_key = relation.store_name_key
    join public.ml_accounts account
      on account.organization_id = relation.organization_id
     and account.id = listing.ml_account_id
     and account.code = alias.ml_account_code
    left join public.upseller_kits kit
      on kit.organization_id = relation.organization_id
     and kit.kit_sku_key = relation.source_sku_key
     and kit.is_current
    where kit.id is not null
       or exists (
         select 1 from public.upseller_product_catalog catalog
         where catalog.organization_id = relation.organization_id
           and catalog.sku_key = relation.source_sku_key
       )
       or exists (
         select 1 from public.upseller_stock_states state
         where state.organization_id = relation.organization_id
           and state.sku_key = relation.source_sku_key
       )
       or not exists (
         select 1 from public.upseller_unresolved_kits unresolved
         where unresolved.organization_id = relation.organization_id
           and unresolved.source_sku_key = relation.source_sku_key
           and unresolved.is_current
       )

    union all

    select
      target.organization_id,
      target.id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'ml_variation_relationship'::text,
      3,
      jsonb_build_object(
        'itemId', listing.item_id,
        'variationId', variation.variation_id,
        'storeName', relation.store_name,
        'mlAccountId', variation.ml_account_id
      ),
      relation.source_import_id
    from target
    join public.ml_listing_variations variation
      on variation.organization_id = target.organization_id
     and variation.product_id = target.id
     and variation.is_current
    join public.ml_listings listing
      on listing.organization_id = variation.organization_id
     and listing.ml_account_id = variation.ml_account_id
     and listing.id = variation.ml_listing_id
     and listing.is_current
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = target.organization_id
     and relation.ml_account_id = variation.ml_account_id
     and relation.listing_external_id = listing.item_id
     and relation.variant_external_id = variation.variation_id
     and relation.channel = 'mercado_livre'
     and relation.is_current
    join public.upseller_store_aliases alias
      on alias.organization_id = relation.organization_id
     and alias.store_name_key = relation.store_name_key
    join public.ml_accounts account
      on account.organization_id = relation.organization_id
     and account.id = variation.ml_account_id
     and account.code = alias.ml_account_code
    left join public.upseller_kits kit
      on kit.organization_id = relation.organization_id
     and kit.kit_sku_key = relation.source_sku_key
     and kit.is_current
    where kit.id is not null
       or exists (
         select 1 from public.upseller_product_catalog catalog
         where catalog.organization_id = relation.organization_id
           and catalog.sku_key = relation.source_sku_key
       )
       or exists (
         select 1 from public.upseller_stock_states state
         where state.organization_id = relation.organization_id
           and state.sku_key = relation.source_sku_key
       )
       or not exists (
         select 1 from public.upseller_unresolved_kits unresolved
         where unresolved.organization_id = relation.organization_id
           and unresolved.source_sku_key = relation.source_sku_key
           and unresolved.is_current
       )

    union all

    select
      target.organization_id,
      target.id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'ml_user_product_relationship'::text,
      4,
      jsonb_build_object(
        'userProductId', listing.user_product_id,
        'targetKind', 'listing',
        'targetId', listing.id,
        'storeName', relation.store_name,
        'mlAccountId', listing.ml_account_id
      ),
      relation.source_import_id
    from target
    join public.ml_listings listing
      on listing.organization_id = target.organization_id
     and listing.product_id = target.id
     and listing.is_current
     and listing.user_product_id like 'MLBU%'
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = target.organization_id
     and relation.ml_account_id = listing.ml_account_id
     and relation.listing_external_id = listing.user_product_id
     and relation.channel = 'mercado_livre'
     and relation.is_current
    join public.upseller_store_aliases alias
      on alias.organization_id = relation.organization_id
     and alias.store_name_key = relation.store_name_key
    join public.ml_accounts account
      on account.organization_id = relation.organization_id
     and account.id = listing.ml_account_id
     and account.code = alias.ml_account_code
    left join public.upseller_kits kit
      on kit.organization_id = relation.organization_id
     and kit.kit_sku_key = relation.source_sku_key
     and kit.is_current
    where kit.id is not null
       or exists (
         select 1 from public.upseller_product_catalog catalog
         where catalog.organization_id = relation.organization_id
           and catalog.sku_key = relation.source_sku_key
       )
       or exists (
         select 1 from public.upseller_stock_states state
         where state.organization_id = relation.organization_id
           and state.sku_key = relation.source_sku_key
       )
       or not exists (
         select 1 from public.upseller_unresolved_kits unresolved
         where unresolved.organization_id = relation.organization_id
           and unresolved.source_sku_key = relation.source_sku_key
           and unresolved.is_current
       )

    union all

    select
      target.organization_id,
      target.id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'ml_user_product_relationship'::text,
      4,
      jsonb_build_object(
        'userProductId', variation.user_product_id,
        'targetKind', 'variation',
        'targetId', variation.id,
        'storeName', relation.store_name,
        'mlAccountId', variation.ml_account_id
      ),
      relation.source_import_id
    from target
    join public.ml_listing_variations variation
      on variation.organization_id = target.organization_id
     and variation.product_id = target.id
     and variation.is_current
     and variation.user_product_id like 'MLBU%'
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = target.organization_id
     and relation.ml_account_id = variation.ml_account_id
     and relation.listing_external_id = variation.user_product_id
     and relation.channel = 'mercado_livre'
     and relation.is_current
    join public.upseller_store_aliases alias
      on alias.organization_id = relation.organization_id
     and alias.store_name_key = relation.store_name_key
    join public.ml_accounts account
      on account.organization_id = relation.organization_id
     and account.id = variation.ml_account_id
     and account.code = alias.ml_account_code
    left join public.upseller_kits kit
      on kit.organization_id = relation.organization_id
     and kit.kit_sku_key = relation.source_sku_key
     and kit.is_current
    where kit.id is not null
       or exists (
         select 1 from public.upseller_product_catalog catalog
         where catalog.organization_id = relation.organization_id
           and catalog.sku_key = relation.source_sku_key
       )
       or exists (
         select 1 from public.upseller_stock_states state
         where state.organization_id = relation.organization_id
           and state.sku_key = relation.source_sku_key
       )
       or not exists (
         select 1 from public.upseller_unresolved_kits unresolved
         where unresolved.organization_id = relation.organization_id
           and unresolved.source_sku_key = relation.source_sku_key
           and unresolved.is_current
       )
  ),
  raw_candidates as (
    select * from exact_candidate
    union all
    select * from relationship_candidates
  )
  select distinct on (candidate.source_sku_key, candidate.link_method)
    candidate.organization_id,
    candidate.product_id,
    candidate.source_sku,
    candidate.source_sku_key,
    candidate.source_kind,
    candidate.link_method,
    candidate.priority,
    candidate.evidence,
    candidate.source_import_id
  from raw_candidates candidate
  order by candidate.source_sku_key, candidate.link_method, candidate.priority,
    candidate.evidence::text, candidate.source_sku, candidate.source_import_id;
$$;

revoke all on function private.inventory_link_candidates_for_product(uuid)
from public, anon, authenticated, service_role;

create or replace function public.reconcile_product_inventory_link(
  target_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product public.products%rowtype;
  manual_link public.product_inventory_links%rowtype;
  chosen record;
  source_count integer;
  source_keys jsonb;
  candidate_evidence jsonb;
  chosen_import_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  select * into target_product
  from public.products product
  where product.id = target_product_id
  for update;

  if target_product.id is null then
    raise exception 'product_not_found';
  end if;

  select * into manual_link
  from public.product_inventory_links link
  where link.organization_id = target_product.organization_id
    and link.product_id = target_product.id
    and link.source = 'upseller'
    and link.link_method = 'manual'
    and link.is_active
  order by link.created_at, link.id
  limit 1;

  if manual_link.id is not null then
    update public.product_inventory_links link
    set is_active = false
    where link.organization_id = target_product.organization_id
      and link.product_id = target_product.id
      and link.source = 'upseller'
      and link.link_method <> 'manual'
      and link.is_active;

    update public.product_inventory_link_conflicts conflict
    set is_current = false, resolved_at = now()
    where conflict.organization_id = target_product.organization_id
      and conflict.product_id = target_product.id
      and conflict.source = 'upseller'
      and conflict.is_current;

    insert into public.operational_alert_jobs (organization_id, product_id, reason)
    values (target_product.organization_id, target_product.id, 'inventory_reconciled')
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

    return jsonb_build_object(
      'productId', target_product.id,
      'status', 'linked',
      'linkMethod', 'manual',
      'sourceSkuKey', manual_link.source_sku_key,
      'manualPreserved', true
    );
  end if;

  select count(*), coalesce(jsonb_agg(source.source_sku_key order by source.source_sku_key), '[]'::jsonb)
  into source_count, source_keys
  from (
    select distinct candidate.source_sku_key
    from private.inventory_link_candidates_for_product(target_product.id) candidate
  ) source;

  select coalesce(jsonb_agg(to_jsonb(candidate) order by candidate.priority,
    candidate.source_sku_key, candidate.link_method, candidate.evidence::text), '[]'::jsonb)
  into candidate_evidence
  from private.inventory_link_candidates_for_product(target_product.id) candidate;

  if source_count = 0 then
    update public.product_inventory_links link
    set is_active = false
    where link.organization_id = target_product.organization_id
      and link.product_id = target_product.id
      and link.source = 'upseller'
      and link.link_method <> 'manual'
      and link.is_active;

    update public.product_inventory_link_conflicts conflict
    set is_current = false, resolved_at = now()
    where conflict.organization_id = target_product.organization_id
      and conflict.product_id = target_product.id
      and conflict.source = 'upseller'
      and conflict.is_current;

    insert into public.operational_alert_jobs (organization_id, product_id, reason)
    values (target_product.organization_id, target_product.id, 'inventory_reconciled')
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

    return jsonb_build_object(
      'productId', target_product.id,
      'status', 'missing',
      'candidateSourceSkus', source_keys
    );
  end if;

  if source_count > 1 then
    update public.product_inventory_links link
    set is_active = false
    where link.organization_id = target_product.organization_id
      and link.product_id = target_product.id
      and link.source = 'upseller'
      and link.link_method <> 'manual'
      and link.is_active;

    select candidate.source_import_id into chosen_import_id
    from private.inventory_link_candidates_for_product(target_product.id) candidate
    order by candidate.priority, candidate.source_sku_key, candidate.link_method,
      candidate.evidence::text, candidate.source_import_id
    limit 1;

    insert into public.product_inventory_link_conflicts (
      organization_id, product_id, source, candidate_source_skus,
      evidence, source_import_id, is_current, resolved_at
    ) values (
      target_product.organization_id, target_product.id, 'upseller', source_keys,
      jsonb_build_object('candidates', candidate_evidence), chosen_import_id, true, null
    )
    on conflict (organization_id, product_id, source) where is_current do update set
      candidate_source_skus = excluded.candidate_source_skus,
      evidence = excluded.evidence,
      source_import_id = excluded.source_import_id,
      resolved_at = null,
      updated_at = now();

    insert into public.operational_alert_jobs (organization_id, product_id, reason)
    values (target_product.organization_id, target_product.id, 'inventory_reconciled')
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

    return jsonb_build_object(
      'productId', target_product.id,
      'status', 'conflict',
      'candidateSourceSkus', source_keys
    );
  end if;

  select candidate.* into chosen
  from private.inventory_link_candidates_for_product(target_product.id) candidate
  order by candidate.priority, candidate.link_method, candidate.evidence::text,
    candidate.source_sku, candidate.source_import_id
  limit 1;

  update public.product_inventory_link_conflicts conflict
  set is_current = false, resolved_at = now()
  where conflict.organization_id = target_product.organization_id
    and conflict.product_id = target_product.id
    and conflict.source = 'upseller'
    and conflict.is_current;

  insert into public.product_inventory_links (
    organization_id, product_id, source, source_sku, source_sku_key,
    source_kind, link_method, confidence, source_import_id, evidence, is_active
  ) values (
    target_product.organization_id, target_product.id, 'upseller', chosen.source_sku,
    chosen.source_sku_key, chosen.source_kind, chosen.link_method, 'exact',
    chosen.source_import_id, chosen.evidence, true
  )
  on conflict (organization_id, product_id, source) where is_active do update set
    source_sku = excluded.source_sku,
    source_sku_key = excluded.source_sku_key,
    source_kind = excluded.source_kind,
    link_method = excluded.link_method,
    confidence = excluded.confidence,
    source_import_id = excluded.source_import_id,
    evidence = excluded.evidence,
    updated_at = now();

  insert into public.operational_alert_jobs (organization_id, product_id, reason)
  values (target_product.organization_id, target_product.id, 'inventory_reconciled')
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  return jsonb_build_object(
    'productId', target_product.id,
    'status', 'linked',
    'sourceSkuKey', chosen.source_sku_key,
    'sourceKind', chosen.source_kind,
    'linkMethod', chosen.link_method,
    'manualPreserved', false
  );
end;
$$;

create or replace function public.enqueue_product_inventory_reconcile_batch(
  target_organization_id uuid,
  after_product_id uuid default null,
  requested_limit integer default 500,
  requested_scope text default 'operational'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_ids uuid[];
  selected_count integer;
  inserted_count integer;
  effective_limit integer := greatest(1, least(requested_limit, 1000));
  next_product_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;
  if requested_scope not in ('all','missing_conflict','operational') then
    raise exception 'invalid_reconcile_scope';
  end if;

  select array_agg(selected.id order by selected.id)
  into selected_ids
  from (
    select product.id
    from public.products product
    where product.organization_id = target_organization_id
      and (after_product_id is null or product.id > after_product_id)
      and (
        requested_scope <> 'operational'
        or exists (
          select 1 from public.ml_listings listing
          where listing.organization_id = product.organization_id
            and listing.product_id = product.id and listing.is_current
        )
        or exists (
          select 1 from public.ml_listing_variations variation
          where variation.organization_id = product.organization_id
            and variation.product_id = product.id and variation.is_current
        )
      )
      and (
        requested_scope <> 'missing_conflict'
        or not exists (
          select 1 from public.product_inventory_links link
          where link.organization_id = product.organization_id
            and link.product_id = product.id and link.source = 'upseller' and link.is_active
        )
        or exists (
          select 1 from public.product_inventory_link_conflicts conflict
          where conflict.organization_id = product.organization_id
            and conflict.product_id = product.id and conflict.source = 'upseller' and conflict.is_current
        )
      )
    order by product.id
    limit effective_limit
  ) selected;

  selected_count := coalesce(cardinality(selected_ids), 0);
  if selected_count > 0 then
    next_product_id := selected_ids[selected_count];
    insert into public.product_inventory_reconcile_jobs (
      organization_id, product_id, reason
    )
    select target_organization_id, selected.product_id, 'batch_' || requested_scope
    from unnest(selected_ids) selected(product_id)
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;
    get diagnostics inserted_count = row_count;
  else
    inserted_count := 0;
  end if;

  return jsonb_build_object(
    'scanned', selected_count,
    'enqueued', inserted_count,
    'nextProductId', next_product_id,
    'completed', selected_count < effective_limit
  );
end;
$$;

create or replace function public.claim_next_product_inventory_reconcile_job(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare claimed_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;
  if requested_lease_id is null then raise exception 'lease_id_required'; end if;

  with candidate as (
    select job.id
    from public.product_inventory_reconcile_jobs job
    where job.status in ('queued','running')
      and job.attempt_count < job.max_attempts
      and job.next_attempt_at <= now()
      and (job.lease_id is null or job.lease_expires_at <= now())
    order by job.next_attempt_at, job.created_at, job.id
    for update skip locked
    limit 1
  )
  update public.product_inventory_reconcile_jobs job
  set status = 'running',
      lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(lease_duration_seconds, 600))),
      attempt_count = job.attempt_count + 1
  from candidate
  where job.id = candidate.id
  returning job.id into claimed_id;

  return claimed_id;
end;
$$;

create or replace function private.enqueue_product_inventory_reconcile_on_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare enqueue_reason text;
begin
  if tg_op = 'INSERT' then
    enqueue_reason := 'product_created';
  elsif new.sku is distinct from old.sku or new.sku_key is distinct from old.sku_key then
    enqueue_reason := 'product_sku_changed';
  else
    return new;
  end if;

  insert into public.product_inventory_reconcile_jobs (
    organization_id, product_id, reason
  ) values (
    new.organization_id, new.id, enqueue_reason
  )
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  return new;
end;
$$;

create trigger products_enqueue_inventory_reconcile
after insert or update of sku, sku_key on public.products
for each row execute function private.enqueue_product_inventory_reconcile_on_change();

-- Keep the already-proven resumable state machine intact. The wrapper only
-- supplements the exact-SKU chunk (without treating unresolved-dot metadata as
-- a veto) and queues continuous reconciliation after finalize.
alter function public.promote_upseller_import_chunk(uuid, uuid, integer)
rename to promote_upseller_import_chunk_before_continuous_reconcile;

revoke all on function public.promote_upseller_import_chunk_before_continuous_reconcile(uuid, uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.promote_upseller_import_chunk_before_continuous_reconcile(uuid, uuid, integer)
to service_role;

create or replace function public.promote_upseller_import_chunk(
  target_import_id uuid,
  requested_lease_id uuid,
  chunk_size integer default 1500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch_before public.upseller_import_batches%rowtype;
  current_phase text;
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;

  select * into batch_before
  from public.upseller_import_batches batch
  where batch.id = target_import_id and batch.lease_id = requested_lease_id;

  if batch_before.id is null then raise exception 'import_or_lease_not_found'; end if;
  current_phase := case when batch_before.phase = 'promote'
    then 'promote_catalog' else batch_before.phase end;

  result := public.promote_upseller_import_chunk_before_continuous_reconcile(
    target_import_id,
    requested_lease_id,
    chunk_size
  );

  if current_phase = 'build_links_exact' then
    with selected as (
      select product.*
      from public.products product
      where product.organization_id = batch_before.organization_id
      order by product.id
      offset batch_before.cursor_row
      limit chunk_size
    )
    insert into public.upseller_inventory_link_candidates (
      organization_id, import_id, product_id, source_sku, source_sku_key,
      source_kind, link_method, priority, evidence
    )
    select
      product.organization_id,
      batch_before.id,
      product.id,
      coalesce(kit.kit_sku, catalog.source_sku, stock.source_sku, product.sku),
      product.sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'exact_sku',
      1,
      jsonb_build_object(
        'canonicalSku', product.sku,
        'stockExact', stock.source_sku is not null,
        'catalogExact', catalog.id is not null,
        'kitDefinitionSource', kit.definition_source,
        'unresolvedDotted', unresolved.id is not null
      )
    from selected product
    left join public.upseller_kits kit
      on kit.organization_id = product.organization_id
     and kit.kit_sku_key = product.sku_key
     and kit.is_current
    left join public.upseller_product_catalog catalog
      on catalog.organization_id = product.organization_id
     and catalog.sku_key = product.sku_key
    left join lateral (
      select state.source_sku
      from public.upseller_stock_states state
      where state.organization_id = product.organization_id
        and state.sku_key = product.sku_key
      order by state.warehouse_key, state.id
      limit 1
    ) stock on true
    left join public.upseller_unresolved_kits unresolved
      on unresolved.organization_id = product.organization_id
     and unresolved.source_sku_key = product.sku_key
     and unresolved.is_current
    where kit.id is not null or catalog.id is not null or stock.source_sku is not null
    on conflict (import_id, product_id, source_sku_key, link_method) do update set
      source_sku = excluded.source_sku,
      source_kind = excluded.source_kind,
      priority = excluded.priority,
      evidence = excluded.evidence;
  end if;

  if current_phase = 'finalize' and coalesce((result ->> 'completed')::boolean, false) then
    insert into public.product_inventory_reconcile_jobs (
      organization_id, product_id, reason
    )
    select product.organization_id, product.id, 'upseller_import_applied'
    from public.products product
    where product.organization_id = batch_before.organization_id
      and (
        exists (
          select 1 from public.ml_listings listing
          where listing.organization_id = product.organization_id
            and listing.product_id = product.id and listing.is_current
        )
        or exists (
          select 1 from public.ml_listing_variations variation
          where variation.organization_id = product.organization_id
            and variation.product_id = product.id and variation.is_current
        )
      )
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;
  end if;

  return result;
end;
$$;

create or replace function public.get_inventory_mapping_status(
  target_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if (select auth.role()) <> 'service_role'
    and not private.is_organization_member(target_organization_id)
  then
    raise exception 'not_authorized';
  end if;

  with operational as (
    select listing.product_id
    from public.ml_listings listing
    where listing.organization_id = target_organization_id
      and listing.is_current and listing.product_id is not null
    union
    select variation.product_id
    from public.ml_listing_variations variation
    where variation.organization_id = target_organization_id
      and variation.is_current and variation.product_id is not null
  ),
  active_listing_products as (
    select listing.product_id
    from public.ml_listings listing
    where listing.organization_id = target_organization_id
      and listing.is_current and listing.status = 'active' and listing.product_id is not null
    union
    select variation.product_id
    from public.ml_listing_variations variation
    join public.ml_listings listing
      on listing.organization_id = variation.organization_id
     and listing.ml_account_id = variation.ml_account_id
     and listing.id = variation.ml_listing_id
    where variation.organization_id = target_organization_id
      and variation.is_current and variation.product_id is not null
      and listing.is_current and listing.status = 'active'
  ),
  linked as (
    select link.product_id
    from public.product_inventory_links link
    where link.organization_id = target_organization_id
      and link.source = 'upseller' and link.is_active
  ),
  conflicting as (
    select conflict.product_id
    from public.product_inventory_link_conflicts conflict
    where conflict.organization_id = target_organization_id
      and conflict.source = 'upseller' and conflict.is_current
  ),
  direct_source as (
    select product.id as product_id
    from public.products product
    where product.organization_id = target_organization_id
      and (
        exists (
          select 1 from public.upseller_stock_states state
          where state.organization_id = product.organization_id and state.sku_key = product.sku_key
        )
        or exists (
          select 1 from public.upseller_product_catalog catalog
          where catalog.organization_id = product.organization_id and catalog.sku_key = product.sku_key
        )
        or exists (
          select 1 from public.upseller_kits kit
          where kit.organization_id = product.organization_id
            and kit.kit_sku_key = product.sku_key and kit.is_current
        )
      )
  ),
  missing as (
    select product.id, product.organization_id, product.sku_key,
      operational.product_id is not null as is_operational,
      direct_source.product_id is not null as has_direct_source
    from public.products product
    left join linked on linked.product_id = product.id
    left join conflicting on conflicting.product_id = product.id
    left join operational on operational.product_id = product.id
    left join direct_source on direct_source.product_id = product.id
    where product.organization_id = target_organization_id
      and linked.product_id is null and conflicting.product_id is null
  ),
  missing_with_reason as (
    select missing.id,
      case
        when exists (
          select 1 from public.product_inventory_reconcile_jobs job
          where job.organization_id = missing.organization_id
            and job.product_id = missing.id and job.status in ('queued','running')
        ) then 'reconcile_pending'
        when exists (
          select 1 from public.upseller_unresolved_kits unresolved
          where unresolved.organization_id = missing.organization_id
            and unresolved.source_sku_key = missing.sku_key and unresolved.is_current
        ) and not missing.has_direct_source then 'unresolved_dot_without_direct_source'
        when missing.has_direct_source then 'reconcile_pending'
        when missing.is_operational then 'no_matching_relationship'
        else 'no_upseller_source'
      end as reason
    from missing
  )
  select jsonb_build_object(
    'totalProducts', (select count(*) from public.products product where product.organization_id = target_organization_id),
    'operationalProducts', (select count(*) from operational),
    'linkedProducts', (select count(*) from linked),
    'conflictingProducts', (select count(*) from conflicting),
    'missingProducts', (select count(*) from missing),
    'operationalLinked', (select count(*) from operational join linked using (product_id)),
    'operationalConflicts', (select count(*) from operational join conflicting using (product_id)),
    'operationalMissing', (select count(*) from operational join missing on missing.id = operational.product_id),
    'activeListingMissing', (select count(*) from active_listing_products active
      join missing on missing.id = active.product_id),
    'exactSourceButUnlinked', (select count(*) from direct_source direct
      join missing on missing.id = direct.product_id),
    'pendingReconcileJobs', (select count(*) from public.product_inventory_reconcile_jobs job
      where job.organization_id = target_organization_id and job.status in ('queued','running')),
    'failedReconcileJobs', (select count(*) from public.product_inventory_reconcile_jobs job
      where job.organization_id = target_organization_id and job.status = 'failed'),
    'missingReasons', coalesce((
      select jsonb_object_agg(reason_summary.reason, reason_summary.reason_count)
      from (
        select reason, count(*) as reason_count
        from missing_with_reason
        group by reason
        order by reason
      ) reason_summary
    ), '{}'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Extend the existing Vault-backed dispatcher; one request drains a bounded
-- burst of this inexpensive database-only queue.
create or replace function private.dispatch_due_stock_workers(worker_task text, maximum integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare due_count integer; current_dispatch integer;
begin
  if worker_task = 'upseller_import' then
    select least(count(*)::integer, maximum) into due_count from public.upseller_import_batches
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'fulfillment_stock_backfill' then
    select least(count(*)::integer, maximum) into due_count from public.sync_runs
    where sync_type = 'fulfillment_stock_backfill' and status in ('queued','running')
      and next_attempt_at <= now() and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'fulfillment_stock_refresh' then
    select least(count(*)::integer, maximum) into due_count from public.ml_fulfillment_stock_refresh_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'operational_alerts' then
    select least(count(*)::integer, maximum) into due_count from public.operational_alert_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'product_inventory_reconcile' then
    select least(count(*)::integer, maximum) into due_count
    from public.product_inventory_reconcile_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and attempt_count < max_attempts
      and (lease_id is null or lease_expires_at <= now());
  else
    raise exception 'unsupported_worker_task';
  end if;

  for current_dispatch in 1..coalesce(due_count, 0) loop
    perform private.dispatch_ml_sync_worker_task(worker_task);
  end loop;
  return coalesce(due_count, 0);
end;
$$;

do $$
declare scheduled_job record;
begin
  for scheduled_job in
    select jobid from cron.job where jobname = 'product-inventory-reconcile-every-minute'
  loop
    perform cron.unschedule(scheduled_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'product-inventory-reconcile-every-minute',
  '* * * * *',
  $$select private.dispatch_due_stock_workers('product_inventory_reconcile', 1);$$
);

revoke all on function public.reconcile_product_inventory_link(uuid)
from public, anon, authenticated;
revoke all on function public.enqueue_product_inventory_reconcile_batch(uuid, uuid, integer, text)
from public, anon, authenticated;
revoke all on function public.claim_next_product_inventory_reconcile_job(uuid, integer)
from public, anon, authenticated;
revoke all on function public.promote_upseller_import_chunk(uuid, uuid, integer)
from public, anon, authenticated;
revoke all on function public.get_inventory_mapping_status(uuid)
from public, anon;
revoke all on function private.enqueue_product_inventory_reconcile_on_change()
from public, anon, authenticated, service_role;
revoke all on function private.dispatch_due_stock_workers(text, integer)
from public, anon, authenticated, service_role;

grant execute on function public.reconcile_product_inventory_link(uuid) to service_role;
grant execute on function public.enqueue_product_inventory_reconcile_batch(uuid, uuid, integer, text) to service_role;
grant execute on function public.claim_next_product_inventory_reconcile_job(uuid, integer) to service_role;
grant execute on function public.promote_upseller_import_chunk(uuid, uuid, integer) to service_role;
grant execute on function public.get_inventory_mapping_status(uuid) to authenticated, service_role;

-- Repair current operational missing/conflict products without re-uploading the
-- UpSeller package. The reason value makes the exact seed count auditable.
insert into public.product_inventory_reconcile_jobs (
  organization_id, product_id, reason
)
select product.organization_id, product.id, 'continuous_reconcile_seed'
from public.products product
where (
    exists (
      select 1 from public.ml_listings listing
      where listing.organization_id = product.organization_id
        and listing.product_id = product.id and listing.is_current
    )
    or exists (
      select 1 from public.ml_listing_variations variation
      where variation.organization_id = product.organization_id
        and variation.product_id = product.id and variation.is_current
    )
  )
  and (
    not exists (
      select 1 from public.product_inventory_links link
      where link.organization_id = product.organization_id
        and link.product_id = product.id and link.source = 'upseller' and link.is_active
    )
    or exists (
      select 1 from public.product_inventory_link_conflicts conflict
      where conflict.organization_id = product.organization_id
        and conflict.product_id = product.id and conflict.source = 'upseller' and conflict.is_current
    )
  )
on conflict (organization_id, product_id) where status in ('queued','running') do nothing;
