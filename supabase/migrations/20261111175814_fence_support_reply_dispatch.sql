-- A fila original e a tentativa identificam a mesma task mesmo quando a API
-- perde a confirmação do Cloud Tasks. Linhas antigas mantêm fila nula, pois
-- não há prova de que uma tentativa PENDING nunca chegou ao worker anterior.
alter table public.support_reply_attempts
  add column dispatch_queue text
    check (dispatch_queue ~ '^ml-sync-[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  add column dispatch_started_at timestamptz,
  add constraint support_reply_attempts_dispatch_queue_required
    check (dispatch_started_at is null or dispatch_queue is not null);

comment on column public.support_reply_attempts.dispatch_queue is
  'Fila gravada na confirmação. Nula no legado, que não tem retomada automática.';
comment on column public.support_reply_attempts.dispatch_started_at is
  'Trava adquirida uma vez antes de POST /answers. Se PENDING após a trava, conciliar o desfecho externo antes de qualquer nova confirmação.';

create or replace function private.guard_support_reply_attempts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'support_reply_attempts e append-only: DELETE nao e permitido.';
  end if;

  if old.status <> 'PENDING' then
    raise exception 'tentativa de resposta ja resolvida (%): desfecho nao pode ser reescrito.', old.status;
  end if;

  if new.id is distinct from old.id
    or new.client_request_id is distinct from old.client_request_id
    or new.final_text is distinct from old.final_text
    or new.suggested_text is distinct from old.suggested_text
    or new.claim_recipient_role is distinct from old.claim_recipient_role
    or new.requested_by is distinct from old.requested_by
    or new.support_case_id is distinct from old.support_case_id
    or new.organization_id is distinct from old.organization_id
    or new.ml_account_id is distinct from old.ml_account_id
    or new.requested_at is distinct from old.requested_at
    or new.dispatch_queue is distinct from old.dispatch_queue then
    raise exception 'support_reply_attempts: so o desfecho e o inicio do envio podem ser atualizados.';
  end if;

  if new.dispatch_started_at is distinct from old.dispatch_started_at
    and (old.dispatch_started_at is not null
      or new.status <> 'PENDING'
      or new.error_message is distinct from old.error_message) then
    raise exception 'support_reply_attempts: o inicio do envio e irreversivel e exige tentativa PENDING.';
  end if;

  return new;
end;
$$;
