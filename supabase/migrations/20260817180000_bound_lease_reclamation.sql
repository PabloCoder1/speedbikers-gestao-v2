-- ============================================================
-- LIMITAR A REAQUISIÇÃO DE LEASES EXPIRADOS
-- ============================================================
--
-- Problema corrigido:
--
-- Seis funções de claim readquiriam um job com lease expirado sem
-- incrementar contador algum. O retry_count/attempt_count só cresce no
-- bloco catch do worker em Node. Se a Function for morta pelo limite de
-- 60 s antes do catch, nada é persistido: o lease expira em 120 s, o
-- mesmo job é readquirido e o ciclo se repete indefinidamente. O run
-- fica preso em 'running' para sempre, nunca atinge max_retries e nunca
-- aparece como falha.
--
-- Quatro funções já contavam corretamente e não são tocadas aqui:
-- claim_next_ml_offer_refresh_job, claim_next_ml_fulfillment_refresh_job,
-- claim_next_operational_alert_job e
-- claim_next_product_inventory_reconcile_job.
--
-- Correção: contar a reaquisição no próprio claim, dentro do banco, onde
-- ela sempre acontece. O contador é separado de retry_count/attempt_count
-- de propósito, para manter distinguíveis os dois modos de falha:
-- erro tratado pela aplicação versus worker morto sem deixar rastro.
--
-- As assinaturas das funções são preservadas exatamente. Nenhum parâmetro
-- novo é adicionado — isso criaria uma sobrecarga em vez de substituir a
-- função, deixando a versão antiga ativa e mantendo os grants na função
-- errada. O teto é uma constante no corpo.

-- ------------------------------------------------------------
-- 1. CONTADORES
-- ------------------------------------------------------------

alter table public.sync_runs
add column if not exists lease_reclaim_count integer not null
default 0
check (lease_reclaim_count >= 0);

comment on column public.sync_runs.lease_reclaim_count is
  'Quantas vezes este run foi readquirido apos o lease expirar sem o worker concluir nem registrar falha. Zerado a cada progresso real.';

alter table public.upseller_import_batches
add column if not exists lease_reclaim_count integer not null
default 0
check (lease_reclaim_count >= 0);

comment on column public.upseller_import_batches.lease_reclaim_count is
  'Quantas vezes este import foi readquirido apos o lease expirar sem o worker concluir nem registrar falha. Zerado a cada progresso real.';

-- ------------------------------------------------------------
-- 2. DEAD-LETTER COMPARTILHADO PARA sync_runs
-- ------------------------------------------------------------
--
-- Runs que já esgotaram as reaquisições param de ser servidos e passam a
-- ser visíveis como falha, em vez de girar para sempre. Roda antes de
-- cada claim, escopado ao sync_type daquela fila.

create or replace function private.dead_letter_exhausted_sync_leases(
  target_sync_type text,
  max_lease_reclaims integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sync_runs as sync_run
  set
    status = 'failed',
    lease_id = null,
    lease_expires_at = null,
    error_code = 'lease_reclaim_exhausted',
    error_message = format(
      'O lease expirou %s vezes sem o worker concluir nem registrar falha.',
      sync_run.lease_reclaim_count
    ),
    finished_at = now()
  where sync_run.sync_type = target_sync_type
    and sync_run.status in ('queued', 'running')
    and sync_run.lease_id is not null
    and sync_run.lease_expires_at <= now()
    and sync_run.lease_reclaim_count >= max_lease_reclaims;
$$;

revoke all on function private.dead_letter_exhausted_sync_leases(text, integer)
from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. CLAIMS SOBRE sync_runs
-- ------------------------------------------------------------

create or replace function public.claim_next_listings_sync_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if (lease_duration_seconds < 30 or lease_duration_seconds > 300) then
    raise exception 'invalid_lease_duration';
  end if;

  perform private.dead_letter_exhausted_sync_leases('listings_full', max_reclaims);

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run
    where sync_run.sync_type = 'listings_full'
      and sync_run.status in ('queued', 'running')
      and sync_run.next_attempt_at <= now()
      and (sync_run.lease_id is null or sync_run.lease_expires_at <= now())
    order by sync_run.started_at asc
    for update skip locked
    limit 1
  )
  update public.sync_runs as sync_run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when sync_run.lease_id is not null and sync_run.lease_expires_at <= now()
          then sync_run.lease_reclaim_count + 1
        else sync_run.lease_reclaim_count
      end
  from candidate
  where sync_run.id = candidate.id
  returning sync_run.id into claimed_run_id;

  return claimed_run_id;
end;
$$;

create or replace function public.claim_next_orders_backfill_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if (lease_duration_seconds < 30 or lease_duration_seconds > 300) then
    raise exception 'invalid_lease_duration';
  end if;

  perform private.dead_letter_exhausted_sync_leases('orders_backfill', max_reclaims);

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run
    where sync_run.sync_type = 'orders_backfill'
      and sync_run.status in ('queued', 'running')
      and sync_run.next_attempt_at <= now()
      and (sync_run.lease_id is null or sync_run.lease_expires_at <= now())
    order by sync_run.started_at asc
    for update skip locked
    limit 1
  )
  update public.sync_runs as sync_run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when sync_run.lease_id is not null and sync_run.lease_expires_at <= now()
          then sync_run.lease_reclaim_count + 1
        else sync_run.lease_reclaim_count
      end
  from candidate
  where sync_run.id = candidate.id
  returning sync_run.id into claimed_run_id;

  return claimed_run_id;
end;
$$;

create or replace function public.claim_next_orders_dashboard_backfill_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if (lease_duration_seconds < 30 or lease_duration_seconds > 300) then
    raise exception 'invalid_lease_duration';
  end if;

  perform private.dead_letter_exhausted_sync_leases(
    'orders_dashboard_backfill',
    max_reclaims
  );

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run
    where sync_run.sync_type = 'orders_dashboard_backfill'
      and sync_run.status in ('queued', 'running')
      and sync_run.next_attempt_at <= now()
      and (sync_run.lease_id is null or sync_run.lease_expires_at <= now())
    order by sync_run.started_at asc
    for update skip locked
    limit 1
  )
  update public.sync_runs as sync_run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when sync_run.lease_id is not null and sync_run.lease_expires_at <= now()
          then sync_run.lease_reclaim_count + 1
        else sync_run.lease_reclaim_count
      end
  from candidate
  where sync_run.id = candidate.id
  returning sync_run.id into claimed_run_id;

  return claimed_run_id;
end;
$$;

create or replace function public.claim_next_offer_prices_backfill_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if lease_duration_seconds < 30 or lease_duration_seconds > 300 then
    raise exception 'invalid_lease_duration';
  end if;

  perform private.dead_letter_exhausted_sync_leases(
    'offer_prices_backfill',
    max_reclaims
  );

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run
    where sync_run.sync_type = 'offer_prices_backfill'
      and sync_run.status in ('queued', 'running')
      and sync_run.next_attempt_at <= now()
      and (sync_run.lease_id is null or sync_run.lease_expires_at <= now())
    order by sync_run.next_attempt_at asc, sync_run.started_at asc
    for update skip locked
    limit 1
  )
  update public.sync_runs as sync_run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when sync_run.lease_id is not null and sync_run.lease_expires_at <= now()
          then sync_run.lease_reclaim_count + 1
        else sync_run.lease_reclaim_count
      end
  from candidate
  where sync_run.id = candidate.id
  returning sync_run.id into claimed_run_id;

  return claimed_run_id;
end;
$$;

create or replace function public.claim_next_fulfillment_stock_sync_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  perform private.dead_letter_exhausted_sync_leases(
    'fulfillment_stock_backfill',
    max_reclaims
  );

  with candidate as (
    select id from public.sync_runs
    where sync_type = 'fulfillment_stock_backfill'
      and status in ('queued', 'running')
      and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now())
    order by next_attempt_at, started_at
    for update skip locked
    limit 1
  )
  update public.sync_runs as run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when run.lease_id is not null and run.lease_expires_at <= now()
          then run.lease_reclaim_count + 1
        else run.lease_reclaim_count
      end
  from candidate
  where run.id = candidate.id
  returning run.id into claimed_id;

  return claimed_id;
end;
$$;

-- ------------------------------------------------------------
-- 4. CLAIM SOBRE upseller_import_batches
-- ------------------------------------------------------------

create or replace function public.claim_next_upseller_import(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
  max_reclaims constant integer := 5;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if lease_duration_seconds < 30 or lease_duration_seconds > 300 then
    raise exception 'invalid_lease_duration';
  end if;

  update public.upseller_import_batches as batch
  set
    status = 'failed',
    lease_id = null,
    lease_expires_at = null,
    error_code = 'lease_reclaim_exhausted',
    error_message = format(
      'O lease expirou %s vezes sem o worker concluir nem registrar falha.',
      batch.lease_reclaim_count
    )
  where batch.status in ('queued', 'running')
    and batch.lease_id is not null
    and batch.lease_expires_at <= now()
    and batch.lease_reclaim_count >= max_reclaims;

  with candidate as (
    select batch.id
    from public.upseller_import_batches as batch
    where batch.status in ('queued', 'running')
      and batch.next_attempt_at <= now()
      and (batch.lease_id is null or batch.lease_expires_at <= now())
    order by batch.next_attempt_at, batch.created_at
    for update skip locked
    limit 1
  )
  update public.upseller_import_batches as batch
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
    lease_reclaim_count =
      case
        when batch.lease_id is not null and batch.lease_expires_at <= now()
          then batch.lease_reclaim_count + 1
        else batch.lease_reclaim_count
      end
  from candidate
  where batch.id = candidate.id
  returning batch.id into claimed_id;

  return claimed_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. INVENTÁRIO DOS RUNS JÁ PRESOS
-- ------------------------------------------------------------
--
-- Runs que já estavam girando antes desta migration começam com
-- lease_reclaim_count = 0 e terão até max_reclaims novas tentativas antes
-- de virar dead-letter. Isso é intencional: dá a eles uma chance real de
-- concluir agora que o ciclo é contado, em vez de falhá-los em massa.
--
-- Para inspecionar o que estava preso, sem alterar nada:
--
--   select id, sync_type, status, started_at, lease_expires_at
--   from public.sync_runs
--   where status = 'running'
--     and started_at < now() - interval '1 hour'
--   order by started_at;
