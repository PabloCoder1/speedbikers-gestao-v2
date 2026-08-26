-- Triagem interna do atendimento (D-094, Fase 7B).
--
-- A Caixa de Entrada (D-090) e' so' leitura: ninguem consegue assumir um
-- atendimento, mudar o status ou resolver. Esta RPC e' a escrita que faltava.
--
-- POR QUE RPC e nao escrita direta sob RLS (o padrao do resto do `web`,
-- D-012): a triagem tem que atualizar `support_cases` E acrescentar
-- `support_case_events` na MESMA transacao. D-084 decidiu que o historico
-- operacional e' append-only e que "nada importante depende apenas do estado
-- visual da interface" -- um UPDATE solto no case, sem o evento, perderia
-- quem assumiu e quando. Duas escritas separadas do navegador nao tem como
-- ser atomicas.

create function public.triage_support_case(
  p_case_id uuid,
  p_internal_status text default null,
  p_priority text default null,
  p_assignee_id uuid default null,
  -- `null` em `p_assignee_id` significa "nao mexer"; desatribuir precisa ser
  -- um pedido explicito, senao seria impossivel distinguir os dois.
  p_clear_assignee boolean default false
)
returns public.support_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
  atual public.support_cases;
  novo public.support_cases;
  proximo_status text;
  proxima_prioridade text;
  proximo_responsavel uuid;
  proximo_resolvido_em timestamptz;
begin
  select * into atual from public.support_cases where id = p_case_id;

  if atual.id is null then
    raise exception 'atendimento % nao encontrado', p_case_id;
  end if;

  -- Autorizacao refeita aqui dentro, nunca herdada da interface (D-084):
  -- precisa alcancar a CONTA, nao so' pertencer a' organizacao -- e' a mesma
  -- regra que a RLS de leitura aplica.
  if not private.has_account_access(atual.ml_account_id) then
    raise exception 'sem permissao para este atendimento';
  end if;

  -- ANALISTA e VISUALIZADOR leem, nao triam (D-084).
  if not private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'papel sem permissao para triagem';
  end if;

  if p_internal_status is not null
    and p_internal_status not in (
      'NOVO', 'EM_ATENDIMENTO', 'AGUARDANDO_CLIENTE',
      'AGUARDANDO_MERCADO_LIVRE', 'RESOLVIDO'
    ) then
    raise exception 'status interno invalido: %', p_internal_status;
  end if;

  if p_priority is not null and p_priority not in ('NORMAL', 'ALTA', 'CRITICA') then
    raise exception 'prioridade invalida: %', p_priority;
  end if;

  if p_assignee_id is not null and p_clear_assignee then
    raise exception 'nao da para atribuir e desatribuir na mesma chamada';
  end if;

  -- Responsavel tem que ser membro da MESMA organizacao. Sem esta checagem,
  -- daria para pendurar o atendimento em alguem de outra organizacao, que
  -- depois o veria na propria lista de "meus atendimentos".
  if p_assignee_id is not null
    and not exists (
      select 1 from public.organization_members
      where user_id = p_assignee_id and organization_id = atual.organization_id
    ) then
    raise exception 'responsavel nao pertence a esta organizacao';
  end if;

  proximo_status := coalesce(p_internal_status, atual.internal_status);
  proxima_prioridade := coalesce(p_priority, atual.priority);
  proximo_responsavel := case
    when p_clear_assignee then null
    else coalesce(p_assignee_id, atual.assignee_id)
  end;

  -- `support_cases_resolution_coherent` exige `resolved_at` preenchido em
  -- RESOLVIDO e nulo em qualquer outro estado. Derivar aqui e' o que permite
  -- reabrir um atendimento sem a interface precisar saber da constraint.
  proximo_resolvido_em := case
    when proximo_status = 'RESOLVIDO' then coalesce(atual.resolved_at, now())
    else null
  end;

  -- Chamada que nao muda nada nao vira evento: historico append-only so'
  -- tem valor se cada linha significar uma decisao de verdade.
  if proximo_status is not distinct from atual.internal_status
    and proxima_prioridade is not distinct from atual.priority
    and proximo_responsavel is not distinct from atual.assignee_id then
    return atual;
  end if;

  update public.support_cases set
    internal_status = proximo_status,
    priority = proxima_prioridade,
    assignee_id = proximo_responsavel,
    resolved_at = proximo_resolvido_em
  where id = p_case_id
  returning * into novo;

  insert into public.support_case_events (
    organization_id, ml_account_id, support_case_id,
    event_type, source, actor_user_id, before, after, occurred_at, dedup_key
  )
  values (
    atual.organization_id,
    atual.ml_account_id,
    atual.id,
    'support.case.triaged',
    'USER',
    auth.uid(),
    jsonb_build_object(
      'internal_status', atual.internal_status,
      'priority', atual.priority,
      'assignee_id', atual.assignee_id,
      'resolved_at', atual.resolved_at
    ),
    jsonb_build_object(
      'internal_status', novo.internal_status,
      'priority', novo.priority,
      'assignee_id', novo.assignee_id,
      'resolved_at', novo.resolved_at
    ),
    now(),
    -- Para `source = 'USER'` o dedup_key nao tem o papel que tem na ingestao
    -- (onde webhook e reconciliacao precisam convergir para a MESMA linha):
    -- cada acao humana e' um fato distinto. A precisao de microssegundo evita
    -- colisao entre acoes reais e, de quebra, colapsa um duplo-clique que
    -- chegue no mesmo instante -- que e' o comportamento desejado.
    'triage:' || atual.id::text || ':' || coalesce(auth.uid()::text, 'sem-usuario')
      || ':' || to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US')
  );

  return novo;
end;
$$;

comment on function public.triage_support_case(uuid, text, text, uuid, boolean) is
  'Triagem do atendimento: atualiza support_cases e acrescenta support_case_events na MESMA transacao (D-084). Autorizacao (acesso a conta + papel ADMIN/GESTOR/OPERADOR) refeita internamente. Parametro nulo = nao mexer; desatribuir exige p_clear_assignee. resolved_at e derivado do status para satisfazer support_cases_resolution_coherent.';

revoke all on function public.triage_support_case(uuid, text, text, uuid, boolean) from public, anon;
grant execute on function public.triage_support_case(uuid, text, text, uuid, boolean) to authenticated, service_role;
