-- Add the UpSeller-provided mapped listing SKU as deterministic inventory
-- evidence and prepare secure backend read/write operations for manual review.

alter table public.product_inventory_links
  drop constraint if exists product_inventory_links_link_method_check;
alter table public.product_inventory_links
  add constraint product_inventory_links_link_method_check check (link_method in (
    'exact_sku',
    'mapped_listing_sku_relationship',
    'ml_item_relationship',
    'ml_variation_relationship',
    'ml_user_product_relationship',
    'manual'
  ));

alter table public.upseller_inventory_link_candidates
  drop constraint if exists upseller_inventory_link_candidates_link_method_check;
alter table public.upseller_inventory_link_candidates
  add constraint upseller_inventory_link_candidates_link_method_check check (link_method in (
    'exact_sku',
    'mapped_listing_sku_relationship',
    'ml_item_relationship',
    'ml_variation_relationship',
    'ml_user_product_relationship'
  ));

create index if not exists upseller_relationships_current_mapped_sku_idx
  on public.upseller_channel_sku_relationships
    (organization_id, mapped_listing_sku_key, ml_account_id)
  where is_current
    and channel = 'mercado_livre'
    and mapped_listing_sku_key is not null;

-- Preserve the existing candidate implementation and add one bounded layer.
-- This avoids changing exact/item/variation/MLBU semantics that are already in
-- production while shifting their priorities behind mapped SKU evidence.
alter function private.inventory_link_candidates_for_product(uuid)
rename to inventory_link_candidates_for_product_before_mapped_sku;

revoke all on function private.inventory_link_candidates_for_product_before_mapped_sku(uuid)
from public, anon, authenticated, service_role;

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
  existing_candidates as (
    select
      candidate.organization_id,
      candidate.product_id,
      candidate.source_sku,
      candidate.source_sku_key,
      candidate.source_kind,
      candidate.link_method,
      case candidate.link_method
        when 'exact_sku' then 1
        when 'ml_item_relationship' then 3
        when 'ml_variation_relationship' then 4
        when 'ml_user_product_relationship' then 5
        else candidate.priority
      end as priority,
      candidate.evidence,
      candidate.source_import_id
    from private.inventory_link_candidates_for_product_before_mapped_sku(target_product_id) candidate
  ),
  mapped_candidates_raw as (
    -- Canonical product SKU equals the explicit mapped listing SKU.
    select
      target.organization_id,
      target.id as product_id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end as source_kind,
      'mapped_listing_sku_relationship'::text as link_method,
      2 as priority,
      jsonb_build_object(
        'matchSource', 'product_sku',
        'mappedListingSku', relation.mapped_listing_sku,
        'mappedListingSkuKey', relation.mapped_listing_sku_key,
        'storeName', relation.store_name,
        'mlAccountId', relation.ml_account_id
      ) as evidence,
      relation.source_import_id
    from target
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = target.organization_id
     and relation.mapped_listing_sku_key = target.sku_key
     and relation.channel = 'mercado_livre'
     and relation.is_current
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

    -- Current listing seller SKU is account-scoped and compared only by
    -- trim+uppercase to the relationship mapped SKU key.
    select
      target.organization_id,
      target.id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'mapped_listing_sku_relationship'::text,
      2,
      jsonb_build_object(
        'matchSource', 'listing_seller_sku',
        'targetId', listing.id,
        'sellerSku', listing.seller_sku,
        'mappedListingSku', relation.mapped_listing_sku,
        'mappedListingSkuKey', relation.mapped_listing_sku_key,
        'storeName', relation.store_name,
        'mlAccountId', relation.ml_account_id
      ),
      relation.source_import_id
    from target
    join public.ml_listings listing
      on listing.organization_id = target.organization_id
     and listing.product_id = target.id
     and listing.is_current
     and nullif(btrim(listing.seller_sku), '') is not null
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = listing.organization_id
     and relation.ml_account_id = listing.ml_account_id
     and relation.mapped_listing_sku_key = upper(btrim(listing.seller_sku))
     and relation.channel = 'mercado_livre'
     and relation.is_current
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

    -- Variations use their own account and seller SKU; a relationship from a
    -- different account cannot participate.
    select
      target.organization_id,
      target.id,
      relation.source_sku,
      relation.source_sku_key,
      case when kit.id is not null then 'kit' else 'simple' end,
      'mapped_listing_sku_relationship'::text,
      2,
      jsonb_build_object(
        'matchSource', 'variation_seller_sku',
        'targetId', variation.id,
        'sellerSku', variation.seller_sku,
        'mappedListingSku', relation.mapped_listing_sku,
        'mappedListingSkuKey', relation.mapped_listing_sku_key,
        'storeName', relation.store_name,
        'mlAccountId', relation.ml_account_id
      ),
      relation.source_import_id
    from target
    join public.ml_listing_variations variation
      on variation.organization_id = target.organization_id
     and variation.product_id = target.id
     and variation.is_current
     and nullif(btrim(variation.seller_sku), '') is not null
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = variation.organization_id
     and relation.ml_account_id = variation.ml_account_id
     and relation.mapped_listing_sku_key = upper(btrim(variation.seller_sku))
     and relation.channel = 'mercado_livre'
     and relation.is_current
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
  mapped_candidates as (
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
    from mapped_candidates_raw candidate
    order by candidate.source_sku_key, candidate.link_method,
      candidate.evidence::text, candidate.source_sku, candidate.source_import_id
  ),
  all_candidates as (
    select * from existing_candidates
    union all
    select * from mapped_candidates
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
  from all_candidates candidate
  order by candidate.source_sku_key, candidate.link_method, candidate.priority,
    candidate.evidence::text, candidate.source_sku, candidate.source_import_id;
$$;

revoke all on function private.inventory_link_candidates_for_product(uuid)
from public, anon, authenticated, service_role;

-- Extend the existing status model without duplicating its established counts.
alter function public.get_inventory_mapping_status(uuid)
rename to get_inventory_mapping_status_before_mapped_sku;

revoke all on function public.get_inventory_mapping_status_before_mapped_sku(uuid)
from public, anon, authenticated;
grant execute on function public.get_inventory_mapping_status_before_mapped_sku(uuid)
to authenticated, service_role;

create or replace function public.get_inventory_mapping_status(
  target_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  base_status jsonb;
  mapped_resolvable bigint;
  mapped_resolved bigint;
begin
  if (select auth.role()) <> 'service_role'
    and not private.is_organization_member(target_organization_id)
  then
    raise exception 'not_authorized';
  end if;

  base_status := public.get_inventory_mapping_status_before_mapped_sku(target_organization_id);

  with mapped_matches as (
    select product.id as product_id, relation.source_sku_key
    from public.products product
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = product.organization_id
     and relation.mapped_listing_sku_key = product.sku_key
     and relation.channel = 'mercado_livre' and relation.is_current
    where product.organization_id = target_organization_id

    union

    select listing.product_id, relation.source_sku_key
    from public.ml_listings listing
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = listing.organization_id
     and relation.ml_account_id = listing.ml_account_id
     and relation.mapped_listing_sku_key = upper(btrim(listing.seller_sku))
     and relation.channel = 'mercado_livre' and relation.is_current
    where listing.organization_id = target_organization_id
      and listing.is_current and listing.product_id is not null
      and nullif(btrim(listing.seller_sku), '') is not null

    union

    select variation.product_id, relation.source_sku_key
    from public.ml_listing_variations variation
    join public.upseller_channel_sku_relationships relation
      on relation.organization_id = variation.organization_id
     and relation.ml_account_id = variation.ml_account_id
     and relation.mapped_listing_sku_key = upper(btrim(variation.seller_sku))
     and relation.channel = 'mercado_livre' and relation.is_current
    where variation.organization_id = target_organization_id
      and variation.is_current and variation.product_id is not null
      and nullif(btrim(variation.seller_sku), '') is not null
  ), valid_matches as (
    select match.product_id, match.source_sku_key
    from mapped_matches match
    where exists (
        select 1 from public.upseller_kits kit
        where kit.organization_id = target_organization_id
          and kit.kit_sku_key = match.source_sku_key and kit.is_current
      )
      or exists (
        select 1 from public.upseller_product_catalog catalog
        where catalog.organization_id = target_organization_id
          and catalog.sku_key = match.source_sku_key
      )
      or exists (
        select 1 from public.upseller_stock_states state
        where state.organization_id = target_organization_id
          and state.sku_key = match.source_sku_key
      )
      or not exists (
        select 1 from public.upseller_unresolved_kits unresolved
        where unresolved.organization_id = target_organization_id
          and unresolved.source_sku_key = match.source_sku_key and unresolved.is_current
      )
  )
  select count(distinct product_id) into mapped_resolvable from valid_matches;

  select count(*) into mapped_resolved
  from public.product_inventory_links link
  where link.organization_id = target_organization_id
    and link.source = 'upseller'
    and link.link_method = 'mapped_listing_sku_relationship'
    and link.is_active;

  return base_status || jsonb_build_object(
    'mappedSkuResolvable', mapped_resolvable,
    'mappedSkuResolved', mapped_resolved
  );
end;
$$;

-- Keyset-paginated operational read model for the next visual review stage.
-- Suggestions are presentation-only and are never consumed by reconciliation.
create or replace function public.get_inventory_mapping_review(
  target_organization_id uuid,
  requested_status text default 'all',
  after_product_id uuid default null,
  requested_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_limit integer := greatest(1, least(requested_limit, 100));
  result jsonb;
begin
  if (select auth.role()) <> 'service_role'
    and not private.is_organization_member(target_organization_id)
  then
    raise exception 'not_authorized';
  end if;
  if requested_status not in ('all','linked','conflict','missing') then
    raise exception 'invalid_mapping_status';
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
  ), candidate_products as (
    select product.id, product.organization_id, product.sku, product.sku_key, product.name,
      case
        when link.id is not null then 'linked'
        when conflict.id is not null then 'conflict'
        else 'missing'
      end as mapping_status,
      link.id as link_id,
      conflict.id as conflict_id,
      conflict.candidate_source_skus
    from operational
    join public.products product
      on product.organization_id = target_organization_id and product.id = operational.product_id
    left join public.product_inventory_links link
      on link.organization_id = product.organization_id and link.product_id = product.id
     and link.source = 'upseller' and link.is_active
    left join public.product_inventory_link_conflicts conflict
      on conflict.organization_id = product.organization_id and conflict.product_id = product.id
     and conflict.source = 'upseller' and conflict.is_current
    where (after_product_id is null or product.id > after_product_id)
      and (
        requested_status = 'all'
        or requested_status = case
          when link.id is not null then 'linked'
          when conflict.id is not null then 'conflict'
          else 'missing'
        end
      )
    order by product.id
    limit effective_limit + 1
  ), page as (
    select * from candidate_products order by id limit effective_limit
  ), source_union as (
    select catalog.source_sku, catalog.sku_key as source_sku_key, catalog.title
    from public.upseller_product_catalog catalog
    where catalog.organization_id = target_organization_id
    union all
    select state.source_sku, state.sku_key, state.title
    from public.upseller_stock_states state
    where state.organization_id = target_organization_id
    union all
    select kit.kit_sku, kit.kit_sku_key, kit.title
    from public.upseller_kits kit
    where kit.organization_id = target_organization_id and kit.is_current
  ), source_index as (
    select source.source_sku_key,
      min(source.source_sku) as source_sku,
      min(source.title) as title,
      regexp_replace(upper(btrim(min(source.source_sku))), '[^A-Z0-9]+', '', 'g') as search_key
    from source_union source
    group by source.source_sku_key
  ), details as (
    select
      page.id as product_id,
      jsonb_build_object(
        'productId', page.id,
        'sku', page.sku,
        'productName', page.name,
        'listingSummary', jsonb_build_object(
          'listingCount', (select count(*) from public.ml_listings listing
            where listing.organization_id = page.organization_id
              and listing.product_id = page.id and listing.is_current),
          'activeListingCount', (select count(*) from public.ml_listings listing
            where listing.organization_id = page.organization_id
              and listing.product_id = page.id and listing.is_current and listing.status = 'active'),
          'variationCount', (select count(*) from public.ml_listing_variations variation
            where variation.organization_id = page.organization_id
              and variation.product_id = page.id and variation.is_current),
          'statuses', coalesce((select jsonb_agg(status_row.status order by status_row.status)
            from (select distinct listing.status
              from public.ml_listings listing
              where listing.organization_id = page.organization_id
                and listing.product_id = page.id and listing.is_current
                and listing.status is not null) status_row), '[]'::jsonb)
        ),
        'mappingStatus', page.mapping_status,
        'currentLink', (select jsonb_build_object(
            'sourceSku', link.source_sku,
            'sourceSkuKey', link.source_sku_key,
            'sourceKind', link.source_kind,
            'linkMethod', link.link_method,
            'confidence', link.confidence,
            'evidence', link.evidence,
            'updatedAt', link.updated_at
          ) from public.product_inventory_links link where link.id = page.link_id),
        'conflictCandidates', coalesce(page.candidate_source_skus, '[]'::jsonb),
        'missingReason', case
          when page.mapping_status <> 'missing' then null
          when exists (
            select 1 from public.product_inventory_reconcile_jobs job
            where job.organization_id = page.organization_id and job.product_id = page.id
              and job.status in ('queued','running')
          ) then 'reconcile_pending'
          when exists (
            select 1 from public.upseller_unresolved_kits unresolved
            where unresolved.organization_id = page.organization_id
              and unresolved.source_sku_key = page.sku_key and unresolved.is_current
          ) and not exists (
            select 1 from source_index source where source.source_sku_key = page.sku_key
          ) then 'unresolved_dot_without_direct_source'
          when exists (
            select 1 from private.inventory_link_candidates_for_product(page.id)
          ) then 'reconcile_pending'
          else 'no_matching_relationship'
        end,
        'deterministicCandidates', coalesce((
          select jsonb_agg(jsonb_build_object(
            'sourceSku', candidate.source_sku,
            'sourceSkuKey', candidate.source_sku_key,
            'sourceKind', candidate.source_kind,
            'linkMethod', candidate.link_method,
            'priority', candidate.priority,
            'evidence', candidate.evidence
          ) order by candidate.priority, candidate.source_sku_key, candidate.link_method)
          from private.inventory_link_candidates_for_product(page.id) candidate
        ), '[]'::jsonb),
        'suggestions', case
          when page.mapping_status = 'missing'
            and not exists (select 1 from private.inventory_link_candidates_for_product(page.id))
          then coalesce((
            select jsonb_agg(jsonb_build_object(
              'candidateSourceSku', suggestion.source_sku,
              'candidateTitle', suggestion.title,
              'similarity', null,
              'reason', 'normalized_sku_candidate',
              'ambiguous', suggestion.match_count > 1
            ) order by suggestion.source_sku)
            from (
              select source.source_sku, source.title, count(*) over () as match_count
              from source_index source
              where source.source_sku_key <> page.sku_key
                and source.search_key <> ''
                and source.search_key = regexp_replace(upper(btrim(page.sku)), '[^A-Z0-9]+', '', 'g')
              order by source.source_sku
              limit 3
            ) suggestion
          ), '[]'::jsonb)
          else '[]'::jsonb
        end
      ) as item
    from page
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(details.item order by details.product_id) from details), '[]'::jsonb),
    'nextProductId', (select page.id from page order by page.id desc limit 1),
    'hasMore', (select count(*) from candidate_products) > effective_limit
  ) into result;

  return result;
end;
$$;

create or replace function public.set_manual_product_inventory_link(
  target_product_id uuid,
  target_source_sku_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product public.products%rowtype;
  normalized_source_sku_key text := upper(btrim(target_source_sku_key));
  selected_source record;
  manual_link_id uuid;
begin
  select * into target_product
  from public.products product
  where product.id = target_product_id
  for update;

  if target_product.id is null then raise exception 'product_not_found'; end if;
  if (select auth.role()) <> 'service_role'
    and not private.has_organization_role(target_product.organization_id, array[
      'admin'::public.app_role, 'gestor'::public.app_role
    ])
  then
    raise exception 'not_authorized';
  end if;
  if normalized_source_sku_key is null or normalized_source_sku_key = '' then
    raise exception 'source_sku_required';
  end if;

  select
    coalesce(kit.kit_sku, catalog.source_sku, stock.source_sku) as source_sku,
    case when kit.id is not null then 'kit' else 'simple' end as source_kind,
    coalesce(kit.source_import_id, catalog.source_import_id, stock.source_import_id) as source_import_id
  into selected_source
  from (select normalized_source_sku_key as sku_key) requested
  left join public.upseller_kits kit
    on kit.organization_id = target_product.organization_id
   and kit.kit_sku_key = requested.sku_key and kit.is_current
  left join public.upseller_product_catalog catalog
    on catalog.organization_id = target_product.organization_id
   and catalog.sku_key = requested.sku_key
  left join lateral (
    select state.source_sku, state.source_import_id
    from public.upseller_stock_states state
    where state.organization_id = target_product.organization_id
      and state.sku_key = requested.sku_key
    order by state.warehouse_key, state.id
    limit 1
  ) stock on true
  where kit.id is not null or catalog.id is not null or stock.source_sku is not null;

  if selected_source.source_sku is null then raise exception 'upseller_source_not_found'; end if;

  update public.product_inventory_links link
  set is_active = false
  where link.organization_id = target_product.organization_id
    and link.product_id = target_product.id
    and link.source = 'upseller'
    and link.link_method <> 'manual'
    and link.is_active;

  insert into public.product_inventory_links (
    organization_id, product_id, source, source_sku, source_sku_key,
    source_kind, link_method, confidence, source_import_id, evidence, is_active
  ) values (
    target_product.organization_id, target_product.id, 'upseller', selected_source.source_sku,
    normalized_source_sku_key, selected_source.source_kind, 'manual', 'manual',
    selected_source.source_import_id,
    jsonb_build_object('setBy', auth.uid(), 'setAt', now()), true
  )
  on conflict (organization_id, product_id, source) where is_active do update set
    source_sku = excluded.source_sku,
    source_sku_key = excluded.source_sku_key,
    source_kind = excluded.source_kind,
    link_method = 'manual',
    confidence = 'manual',
    source_import_id = excluded.source_import_id,
    evidence = excluded.evidence,
    updated_at = now()
  returning id into manual_link_id;

  update public.product_inventory_link_conflicts conflict
  set is_current = false, resolved_at = now()
  where conflict.organization_id = target_product.organization_id
    and conflict.product_id = target_product.id
    and conflict.source = 'upseller' and conflict.is_current;

  insert into public.operational_alert_jobs (organization_id, product_id, reason)
  values (target_product.organization_id, target_product.id, 'manual_inventory_link_set')
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  return jsonb_build_object(
    'productId', target_product.id,
    'linkId', manual_link_id,
    'sourceSkuKey', normalized_source_sku_key,
    'sourceKind', selected_source.source_kind,
    'status', 'linked'
  );
end;
$$;

create or replace function public.clear_manual_product_inventory_link(
  target_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product public.products%rowtype;
  cleared_count integer;
begin
  select * into target_product
  from public.products product
  where product.id = target_product_id
  for update;

  if target_product.id is null then raise exception 'product_not_found'; end if;
  if (select auth.role()) <> 'service_role'
    and not private.has_organization_role(target_product.organization_id, array[
      'admin'::public.app_role, 'gestor'::public.app_role
    ])
  then
    raise exception 'not_authorized';
  end if;

  update public.product_inventory_links link
  set is_active = false
  where link.organization_id = target_product.organization_id
    and link.product_id = target_product.id
    and link.source = 'upseller'
    and link.link_method = 'manual'
    and link.is_active;
  get diagnostics cleared_count = row_count;

  insert into public.product_inventory_reconcile_jobs (
    organization_id, product_id, reason
  ) values (
    target_product.organization_id, target_product.id, 'manual_inventory_link_cleared'
  )
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  return jsonb_build_object(
    'productId', target_product.id,
    'manualLinkCleared', cleared_count > 0,
    'reconcileQueued', true
  );
end;
$$;

revoke all on function public.get_inventory_mapping_status(uuid)
from public, anon;
revoke all on function public.get_inventory_mapping_review(uuid, text, uuid, integer)
from public, anon;
revoke all on function public.set_manual_product_inventory_link(uuid, text)
from public, anon;
revoke all on function public.clear_manual_product_inventory_link(uuid)
from public, anon;

grant execute on function public.get_inventory_mapping_status(uuid)
to authenticated, service_role;
grant execute on function public.get_inventory_mapping_review(uuid, text, uuid, integer)
to authenticated, service_role;
grant execute on function public.set_manual_product_inventory_link(uuid, text)
to authenticated, service_role;
grant execute on function public.clear_manual_product_inventory_link(uuid)
to authenticated, service_role;

-- Re-run only operational missing/conflict products through the existing
-- resumable queue. Active jobs remain unique and manual links remain sovereign.
insert into public.product_inventory_reconcile_jobs (
  organization_id, product_id, reason
)
select product.organization_id, product.id, 'mapped_sku_evidence_seed'
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
