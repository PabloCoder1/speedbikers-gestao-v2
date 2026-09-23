-- O destinatário escolhido em uma mensagem de claim é parte do ato auditado.
-- Não pode ser reatribuído depois que a tentativa nasce PENDING.

alter table public.support_reply_attempts
  add column claim_recipient_role text
  check (claim_recipient_role is null or claim_recipient_role in ('complainant', 'mediator'));

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

  if new.client_request_id is distinct from old.client_request_id
    or new.final_text is distinct from old.final_text
    or new.suggested_text is distinct from old.suggested_text
    or new.claim_recipient_role is distinct from old.claim_recipient_role
    or new.requested_by is distinct from old.requested_by
    or new.support_case_id is distinct from old.support_case_id
    or new.organization_id is distinct from old.organization_id
    or new.ml_account_id is distinct from old.ml_account_id
    or new.requested_at is distinct from old.requested_at then
    raise exception 'support_reply_attempts: so o desfecho pode ser atualizado.';
  end if;

  return new;
end;
$$;

comment on column public.support_reply_attempts.claim_recipient_role is
  'Destinatário escolhido pelo operador para mensagem de claim; nulo para Pergunta e conversa pós-venda.';
