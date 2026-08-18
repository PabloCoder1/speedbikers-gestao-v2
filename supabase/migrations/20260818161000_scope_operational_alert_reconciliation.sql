-- ============================================================
-- Hotfix — proteger leituras da carga de background
--
-- Parte B: a reconciliação diária enfileirava TODOS os products,
-- incluindo milhares de products históricos sem anúncio ativo. Agora
-- considera só: (A) product com ml_listing atual, (B) product com
-- ml_listing_variation atual, ou (C) product com operational_alert
-- aberto (um alert antigo precisa de uma última avaliação para ser
-- resolvido, mesmo que o product já não seja operacional). UNION
-- (distinct por padrão) entre as três fontes.
-- ============================================================

create or replace function private.enqueue_operational_alert_reconciliation()
returns integer language plpgsql security definer set search_path = '' as $$
declare inserted_count integer;
begin
  with candidates as (
    select listing.organization_id, listing.product_id
    from public.ml_listings as listing
    where listing.is_current and listing.product_id is not null

    union

    select variation.organization_id, variation.product_id
    from public.ml_listing_variations as variation
    where variation.is_current and variation.product_id is not null

    union

    select alert.organization_id, alert.product_id
    from public.operational_alerts as alert
    where alert.status = 'open'
  )
  insert into public.operational_alert_jobs (organization_id, product_id, reason)
  select candidates.organization_id, candidates.product_id, 'periodic_reconcile'
  from candidates
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end $$;

-- ============================================================
-- Limpeza segura do backlog histórico já enfileirado pela versão
-- antiga (sem escopo). Remove APENAS jobs 'queued' com reason
-- 'periodic_reconcile' de products sem listing/variation atual e sem
-- alert aberto — reconciliações periódicas ainda não executadas, de
-- products que a nova versão do enqueue nunca teria criado. Não toca
-- em running, jobs de evento real, jobs failed, nem em operational_alerts.
-- ============================================================

do $$
declare removed_count integer;
begin
  delete from public.operational_alert_jobs as job
  where job.status = 'queued'
    and job.reason = 'periodic_reconcile'
    and not exists (
      select 1 from public.ml_listings as listing
      where listing.organization_id = job.organization_id
        and listing.product_id = job.product_id
        and listing.is_current
    )
    and not exists (
      select 1 from public.ml_listing_variations as variation
      where variation.organization_id = job.organization_id
        and variation.product_id = job.product_id
        and variation.is_current
    )
    and not exists (
      select 1 from public.operational_alerts as alert
      where alert.organization_id = job.organization_id
        and alert.product_id = job.product_id
        and alert.status = 'open'
    );

  get diagnostics removed_count = row_count;
  raise notice 'Hotfix: removed % safe historical periodic_reconcile queued jobs', removed_count;
end $$;
