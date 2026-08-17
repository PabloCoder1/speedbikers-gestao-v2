-- Products with a proven current exact source are safe to reconcile even when
-- they no longer have a current ML target. This bounded seed also repairs
-- products created between the last UpSeller import and installation of the
-- continuous products trigger.

insert into public.product_inventory_reconcile_jobs (
  organization_id, product_id, reason
)
select product.organization_id, product.id, 'exact_source_reconcile_seed'
from public.products product
where not exists (
    select 1 from public.product_inventory_links link
    where link.organization_id = product.organization_id
      and link.product_id = product.id
      and link.source = 'upseller'
      and link.is_active
  )
  and not exists (
    select 1 from public.product_inventory_link_conflicts conflict
    where conflict.organization_id = product.organization_id
      and conflict.product_id = product.id
      and conflict.source = 'upseller'
      and conflict.is_current
  )
  and (
    exists (
      select 1 from public.upseller_stock_states state
      where state.organization_id = product.organization_id
        and state.sku_key = product.sku_key
    )
    or exists (
      select 1 from public.upseller_product_catalog catalog
      where catalog.organization_id = product.organization_id
        and catalog.sku_key = product.sku_key
    )
    or exists (
      select 1 from public.upseller_kits kit
      where kit.organization_id = product.organization_id
        and kit.kit_sku_key = product.sku_key
        and kit.is_current
    )
  )
on conflict (organization_id, product_id) where status in ('queued','running') do nothing;
