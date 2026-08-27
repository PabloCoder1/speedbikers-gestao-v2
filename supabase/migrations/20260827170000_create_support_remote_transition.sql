-- Transição automática de status interno pela ATIVIDADE REMOTA (D-102) —
-- a regra que D-084 previu ("nova atividade inbound reabre para NOVO";
-- "primeira projeção pode nascer resolvida") e que D-086 adiou "porque
-- exige evento/transação próprios". A pergunta do usuário que a motivou:
-- "se a pergunta/mensagem já foi respondida via outra plataforma, ela não
-- deve aparecer ali como novo" — e hoje aparece: o sync nunca toca o
-- status interno depois do INSERT, então um case aberto respondido pelo
-- app do Mercado Livre fica NOVO na Caixa de Entrada para sempre.
--
-- POR QUE RPC, igual à triagem (D-094): o UPDATE guardado do case e o
-- `support_case_events` precisam ser atômicos — D-084 decisão 6. Duas
-- chamadas PostgREST separadas do worker deixariam um buraco de auditoria
-- se a segunda falhasse (o guard de status já teria consumido a transição).
--
-- A regra "sync não sobrescreve decisão humana" (D-084) vive no GUARD:
-- a transição só acontece se o status atual estiver em
-- `p_expected_statuses`. Um case que um humano moveu para EM_ATENDIMENTO
-- nunca é tocado — a função devolve `false` e o chamador segue em frente.
--
-- SECURITY INVOKER + grant só a service_role: só o worker chama (é reação
-- a dado remoto, nunca a clique de usuário — quem clica usa
-- `triage_support_case`). Mesmo padrão de menor privilégio de
-- `compute_erp_snapshot_balances`.

create function public.apply_support_remote_transition(
  p_case_id uuid,
  p_expected_statuses text[],
  p_new_status text,
  p_source text,
  p_event_type text,
  p_dedup_key text,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  atual public.support_cases;
  novo public.support_cases;
  proximo_resolvido_em timestamptz;
begin
  if p_new_status not in (
    'NOVO', 'EM_ATENDIMENTO', 'AGUARDANDO_CLIENTE',
    'AGUARDANDO_MERCADO_LIVRE', 'RESOLVIDO'
  ) then
    raise exception 'status interno invalido: %', p_new_status;
  end if;

  -- Transição automática nunca é ação humana — USER fica de fora de
  -- propósito (esse é o papel de triage_support_case).
  if p_source not in ('WEBHOOK', 'RECONCILIATION', 'SYSTEM') then
    raise exception 'source invalida para transicao automatica: %', p_source;
  end if;

  select * into atual from public.support_cases where id = p_case_id;

  if atual.id is null then
    raise exception 'atendimento % nao encontrado', p_case_id;
  end if;

  -- O guard de "não sobrescrever decisão humana": fora do estado esperado,
  -- nada acontece — sem erro, porque corrida com triagem humana (ou com o
  -- outro caminho de ingestão) é cenário normal, não excepcional.
  if not (atual.internal_status = any(p_expected_statuses)) then
    return false;
  end if;

  if atual.internal_status = p_new_status then
    return false;
  end if;

  -- `support_cases_resolution_coherent`: resolved_at preenchido em
  -- RESOLVIDO e nulo em qualquer outro estado — inclusive na REABERTURA,
  -- onde limpar o resolved_at é parte do significado.
  proximo_resolvido_em := case
    when p_new_status = 'RESOLVIDO' then coalesce(p_occurred_at, now())
    else null
  end;

  update public.support_cases set
    internal_status = p_new_status,
    resolved_at = proximo_resolvido_em
  where id = p_case_id
    and internal_status = any(p_expected_statuses)
  returning * into novo;

  if novo.id is null then
    -- Corrida perdida entre o SELECT e o UPDATE — mesmo significado do
    -- guard acima.
    return false;
  end if;

  insert into public.support_case_events (
    organization_id, ml_account_id, support_case_id,
    event_type, source, actor_user_id, before, after, occurred_at, dedup_key
  )
  values (
    atual.organization_id,
    atual.ml_account_id,
    atual.id,
    p_event_type,
    p_source,
    null,
    jsonb_build_object('internal_status', atual.internal_status, 'resolved_at', atual.resolved_at),
    jsonb_build_object('internal_status', novo.internal_status, 'resolved_at', novo.resolved_at),
    coalesce(p_occurred_at, now()),
    p_dedup_key
  )
  on conflict (organization_id, dedup_key) do nothing;

  return true;
end;
$$;

comment on function public.apply_support_remote_transition(uuid, text[], text, text, text, text, timestamptz) is
  'Transição automática de status interno disparada por atividade REMOTA (D-102): pergunta respondida fora da V3 resolve o case, conversa respondida vira AGUARDANDO_CLIENTE, inbound novo reabre para NOVO. Guard por p_expected_statuses implementa "sync não sobrescreve decisão humana" (D-084) — fora do estado esperado devolve false sem erro. UPDATE + support_case_events na MESMA transação (D-084 decisão 6). Só o worker chama; ação humana usa triage_support_case.';

revoke all on function public.apply_support_remote_transition(uuid, text[], text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_support_remote_transition(uuid, text[], text, text, text, text, timestamptz)
  to service_role;
