-- ============================================================
-- Correcoes na auditoria de acesso e na guarda do ultimo ADMIN (D-175).
--
-- A migration anterior (20260901114420) foi submetida a uma revisao
-- adversarial e a quatro defeitos reais, tres deles invisiveis em teste
-- feliz. Cada um abaixo com o porque.
-- ============================================================

-- ------------------------------------------------------------
-- 1. FK com acao de escrita numa tabela append-only e contradicao (D-149)
--
-- `ml_account_id ... on delete set null` faz o PROPRIO POSTGRES emitir um
-- UPDATE quando a conta e removida — e o trigger append-only recusa. Foi o
-- que quebrou a limpeza da suite: "organization_access_events e append-only:
-- UPDATE nao e permitido".
--
-- A saida e a mesma que `target_user_id` ja usava: SEM FK. O id fica como
-- fato historico, e a tela resolve o rotulo quando a conta ainda existe.
-- ------------------------------------------------------------
alter table public.organization_access_events
  drop constraint organization_access_events_ml_account_id_fkey;

comment on column public.organization_access_events.ml_account_id is
  'SEM FK de proposito (licao de D-149): FK com `on delete set null` faria o Postgres ESCREVER nesta tabela append-only quando a conta fosse removida, e o trigger recusaria. O id e fato historico; a tela mostra o rotulo quando a conta ainda existe.';

-- ------------------------------------------------------------
-- 2. A guarda tinha uma CORRIDA
--
-- `select count(*)` sem trava: duas transacoes simultaneas, cada uma
-- rebaixando um de dois ADMINs, veem "sobra o outro" e passam as duas —
-- resultado, zero ADMIN, exatamente o lockout que a guarda existe para
-- impedir. O idioma da casa para serializar por chave logica ja existe
-- (`pg_advisory_xact_lock` em 20260828215404 e 20260821184047).
--
-- 3. A guarda tornava a ORGANIZACAO e o USUARIO indeletaveis
--
-- `organizations` e `profiles` cascateiam para `organization_members`. Na
-- cascata, a linha do ultimo ADMIN passa pelo BEFORE DELETE e a guarda
-- levantava excecao — impedindo apagar a organizacao inteira ou o proprio
-- usuario. Lockout e sobre deixar a organizacao VIVA sem administrador;
-- quando ela (ou o usuario) esta indo embora, nao ha ninguem para trancar
-- do lado de fora.
-- ------------------------------------------------------------
create or replace function private.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admins integer;
begin
  if tg_op = 'UPDATE' and (old.role <> 'ADMIN' or new.role = 'ADMIN') then
    return new;
  end if;

  if tg_op = 'DELETE' and old.role <> 'ADMIN' then
    return old;
  end if;

  -- A organizacao inteira esta sendo removida (cascata de `organizations`):
  -- nao ha o que proteger. Na cascata o pai ja saiu quando o filho e
  -- processado, entao a ausencia e o sinal.
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return coalesce(old, new);
  end if;

  -- O proprio usuario esta sendo removido (cascata de `auth.users` ->
  -- `profiles`): idem. Apagar gente exige service_role; a guarda protege
  -- contra rebaixamento acidental, nao contra remocao deliberada de conta.
  if tg_op = 'DELETE' and not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return old;
  end if;

  -- Serializa por organizacao: sem isto, duas transacoes simultaneas cada
  -- uma "veem" o outro ADMIN sobrando e as duas passam.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization_members_last_admin', 0),
    pg_catalog.hashtextextended(old.organization_id::text, 0)
  );

  select count(*) into v_admins
  from public.organization_members m
  where m.organization_id = old.organization_id
    and m.role = 'ADMIN'
    and m.user_id <> old.user_id;

  if v_admins = 0 then
    raise exception
      'a organizacao ficaria sem nenhum ADMIN: promova outro membro antes de rebaixar ou remover este'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 4. A policy de leitura herdava um furo de escopo
--
-- `private.has_role(array['ADMIN'])` responde "sou ADMIN em ALGUMA
-- organizacao", sem filtrar qual. Combinado com `is_member_of(org)`, um
-- ADMIN da organizacao X que seja mero membro da Y satisfazia os dois para
-- linhas da Y. Numa tabela de AUDITORIA DE PRIVILEGIO isso e o pior lugar
-- possivel para o furo — entao esta policy checa papel e organizacao na
-- MESMA linha, sem depender do helper.
--
-- O furo existe em outras policies do banco e NAO e consertado aqui: mexer
-- nelas e fatia propria, com teste negativo multi-organizacao para cada uma.
-- ------------------------------------------------------------
drop policy organization_access_events_admin_reads on public.organization_access_events;

create policy organization_access_events_admin_reads
  on public.organization_access_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.user_id = (select auth.uid())
        and m.organization_id = organization_access_events.organization_id
        and m.role = 'ADMIN'
    )
  );

-- ------------------------------------------------------------
-- 5. `service_role` nao precisa poder reescrever a auditoria
--
-- Os grants default do projeto dao UPDATE/DELETE/TRUNCATE a service_role, e
-- TRUNCATE **nao dispara trigger**: apagaria o historico inteiro sem passar
-- pelo backstop append-only. O worker so precisa inserir.
-- ------------------------------------------------------------
revoke update, delete, truncate on public.organization_access_events from service_role;
