-- Auditoria de envio de resposta (D-096, Fase 7B).
--
-- D-084 decisao 8 desenhou esta tabela e D-085 a deixou de fora de proposito:
-- o nucleo era read-only. Ela nasce agora porque e' pre-requisito do primeiro
-- comando que ESCREVE no Mercado Livre.
--
-- REFINAMENTO da decisao 8, registrado em D-096: D-084 fala em "uma linha
-- imutavel ... inclusive em falha ou resultado incerto". Escrever a linha so'
-- DEPOIS da chamada remota tornaria imutabilidade e auditoria incompativeis:
-- uma queda entre o POST e o INSERT deixaria uma resposta enviada ao cliente
-- SEM registro nenhum, e a tentativa seguinte enviaria a segunda copia.
--
-- Aqui a linha nasce PENDING antes da chamada e transiciona UMA vez para um
-- estado terminal. O que D-084 protege continua protegido: `final_text`,
-- `suggested_text`, `requested_by` e `client_request_id` nunca mudam, e nada
-- e' apagado. "Resultado incerto" deixa de ser conceito e vira estado real --
-- uma linha parada em PENDING significa exatamente "nao sabemos se saiu".

create table public.support_reply_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_case_id uuid not null,

  -- Gerado pelo cliente na confirmacao humana: e' o que impede que um
  -- duplo-clique ou um retry de rede vire DUAS respostas ao comprador.
  client_request_id text not null
    check (char_length(btrim(client_request_id)) between 1 and 120),

  -- `restrict`, nao `set null`: a linha e' append-only, e um SET NULL e' um
  -- UPDATE que o trigger abaixo recusaria -- apagar o usuario falharia com
  -- uma mensagem sobre append-only em vez de "usuario em uso" (defeito
  -- exatamente equivalente ao achado em D-094 para support_case_events).
  -- Mesmo precedente de `stock_movements.created_by`.
  requested_by uuid not null references public.profiles(id) on delete restrict,

  -- Texto que a IA sugeriu, quando houver (Copiloto, fase posterior). Fica
  -- separado do final para a auditoria distinguir o que foi sugerido do que
  -- o humano efetivamente enviou.
  suggested_text text
    check (suggested_text is null or char_length(suggested_text) between 1 and 2000),
  -- 2.000 caracteres e' o limite da API de Perguntas (D-083).
  final_text text not null
    check (char_length(btrim(final_text)) between 1 and 2000),

  status text not null default 'PENDING'
    check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),

  remote_message_id text
    check (remote_message_id is null or char_length(btrim(remote_message_id)) between 1 and 120),
  error_code text
    check (error_code is null or char_length(btrim(error_code)) between 1 and 120),
  error_message text
    check (error_message is null or char_length(error_message) between 1 and 2000),

  requested_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint support_reply_attempts_case_scope_fkey
    foreign key (support_case_id, organization_id, ml_account_id)
    references public.support_cases (id, organization_id, ml_account_id)
    on delete cascade,

  constraint support_reply_attempts_client_request_unique
    unique (organization_id, client_request_id),

  -- Estado terminal exige desfecho registrado; PENDING nao pode ter nenhum.
  constraint support_reply_attempts_outcome_coherent check (
    (status = 'PENDING' and resolved_at is null and error_code is null and remote_message_id is null)
    or (status = 'SUCCEEDED' and resolved_at is not null and error_code is null)
    or (status = 'FAILED' and resolved_at is not null and error_code is not null)
  )
);

comment on table public.support_reply_attempts is
  'L2 de auditoria de resposta (D-084 decisao 8, D-096). Uma linha por client_request_id. Nasce PENDING antes da chamada remota e transiciona UMA vez; texto, usuario e chave nunca mudam. Linha parada em PENDING significa "nao sabemos se a resposta saiu".';

comment on column public.support_reply_attempts.client_request_id is
  'Idempotencia do ENVIO: impede que duplo-clique ou retry vire duas respostas ao comprador.';

create index support_reply_attempts_case_idx
  on public.support_reply_attempts (support_case_id, requested_at desc);

-- Uma tentativa parada em PENDING e' o caso que precisa de olho humano; o
-- indice parcial existe para a consulta que vai procura-las.
create index support_reply_attempts_pending_idx
  on public.support_reply_attempts (organization_id, requested_at)
  where status = 'PENDING';

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

  -- Unica transicao aceita: PENDING -> terminal. Nem o backend privilegiado
  -- reescreve um desfecho ja registrado, nem altera o texto enviado.
  if old.status <> 'PENDING' then
    raise exception 'tentativa de resposta ja resolvida (%): desfecho nao pode ser reescrito.', old.status;
  end if;

  if new.client_request_id is distinct from old.client_request_id
    or new.final_text is distinct from old.final_text
    or new.suggested_text is distinct from old.suggested_text
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

create trigger support_reply_attempts_append_only
  before update or delete on public.support_reply_attempts
  for each row execute function private.guard_support_reply_attempts();

alter table public.support_reply_attempts enable row level security;

-- Quem enxerga o atendimento enxerga as tentativas dele: a auditoria de
-- resposta e' parte do historico, nao informacao mais sensivel que o proprio
-- transcript.
create policy support_reply_attempts_select_permitted
  on public.support_reply_attempts
  for select
  to authenticated
  using (private.has_account_access(ml_account_id));

revoke all on public.support_reply_attempts from anon, authenticated, service_role;
grant select on public.support_reply_attempts to authenticated;
-- Sem DELETE para ninguem. UPDATE existe apenas para a transicao de desfecho,
-- e o trigger acima e' quem a delimita.
grant select, insert, update on public.support_reply_attempts to service_role;
