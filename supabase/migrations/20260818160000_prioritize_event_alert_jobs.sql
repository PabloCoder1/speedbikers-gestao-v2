-- ============================================================
-- Hotfix — proteger leituras da carga de background
--
-- Parte A: claim_next_operational_alert_job tratava
-- 'periodic_reconcile' com a mesma prioridade de um alerta gerado por
-- mudança real (mapeamento, import, etc.). Com milhares de jobs de
-- reconciliação periódica na fila, um evento real podia esperar atrás
-- de um backlog histórico. A prioridade agora é só isso — evento real
-- antes de reconciliação periódica — sem prioridade por alert_type.
--
-- FOR UPDATE SKIP LOCKED, lease, attempt_count e retry preservados
-- sem alteração.
-- ============================================================

create or replace function public.claim_next_operational_alert_job(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid;
begin
  with candidate as (
    select id from public.operational_alert_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now())
    order by
      (reason = 'periodic_reconcile'), -- false (evento real) antes de true (reconciliação)
      next_attempt_at,
      created_at,
      id
    for update skip locked limit 1
  )
  update public.operational_alert_jobs as job
  set status = 'running', lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
      attempt_count = job.attempt_count + 1
  from candidate where job.id = candidate.id returning job.id into claimed_id;
  return claimed_id;
end $$;
