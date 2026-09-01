-- ============================================================
-- Administracao de Usuarios e Permissoes (D-175, trilha 8A) — as duas
-- metades que faltavam: a GUARDA contra lockout e o HISTORICO.
--
-- O que JA existia e foi medido antes de escrever: as policies
-- `organization_members_admin_writes` e
-- `user_account_permissions_admin_writes` ja restringem escrita a ADMIN
-- (`private.has_role(array['ADMIN'])`), e `private.has_account_access` ja da
-- acesso total ao ADMIN e acesso por linha aos demais. Ou seja, o backend
-- efetivo do item ("nao segurança apenas visual") ja estava de pe — nao
-- precisa de RPC nova para autorizar, e a tela escreve direto sob RLS, o
-- mesmo padrao de D-119.
--
-- Faltavam duas coisas, e as duas sao de BANCO, nao de tela:
--
-- 1. **Protecao do ultimo ADMIN.** A policy autoriza um ADMIN a rebaixar ou
--    remover qualquer membro — inclusive o ultimo ADMIN, inclusive ele
--    mesmo. Isso tranca a organizacao inteira para fora da administracao,
--    sem caminho de volta pela interface. E o risco "lockout" que o item
--    nomeia. A guarda vai num TRIGGER, nao numa RPC: assim protege todo
--    caminho de escrita (tela, PostgREST direto, codigo futuro), e nao so o
--    caminho que alguem lembrar de usar.
--
-- 2. **Historico.** Nao havia registro nenhum de quem mudou o papel de quem,
--    nem de quem concedeu acesso a qual conta. Auditoria de privilegio e
--    justamente o que precisa existir ANTES de a segunda pessoa entrar.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O historico (L2 append-only, mesma forma das outras instancias)
-- ------------------------------------------------------------
create table public.organization_access_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  event_type text not null check (event_type in (
    'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED',
    'ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED'
  )),

  -- SEM FK: em MEMBER_REMOVED o vinculo nao existe mais, e o perfil pode ser
  -- apagado depois. Mesma forma de `domain_events.entity_id`.
  target_user_id uuid not null,

  -- So nos eventos de acesso por conta.
  ml_account_id uuid references public.ml_accounts(id) on delete set null,

  previous_role text,
  new_role text,

  -- NULO de proposito quando a mudanca veio de `service_role` (seed,
  -- importacao, migration): inventar um ator seria pior que declarar que
  -- nao houve humano identificado.
  actor_user_id uuid references public.profiles(id) on delete restrict,

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint organization_access_events_role_shape check (
    (event_type = 'MEMBER_ADDED' and new_role is not null and previous_role is null)
    or (event_type = 'MEMBER_ROLE_CHANGED' and new_role is not null and previous_role is not null)
    or (event_type = 'MEMBER_REMOVED' and previous_role is not null and new_role is null)
    or (event_type in ('ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED')
        and ml_account_id is not null and previous_role is null and new_role is null)
  )
);

comment on table public.organization_access_events is
  'Auditoria L2 append-only de quem mudou o acesso de quem (D-175): papel de membro e acesso por conta. Sem backfill — o historico comeca aqui, e evento sintetico para o passado seria dado inventado.';

comment on column public.organization_access_events.actor_user_id is
  'NULO quando a mudanca veio de service_role (seed/importacao/migration): sem humano identificado, declara-se a ausencia em vez de inventar um.';

create index organization_access_events_org_idx
  on public.organization_access_events (organization_id, occurred_at desc);

create index organization_access_events_target_idx
  on public.organization_access_events (target_user_id, occurred_at desc);

alter table public.organization_access_events enable row level security;

-- Auditoria de PRIVILEGIO e informacao de administracao: quem pode ler e
-- quem ja pode mudar. Escrita: ninguem — so os triggers abaixo, que sao
-- `security definer`.
create policy organization_access_events_admin_reads
  on public.organization_access_events
  for select
  to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN']));

revoke all on public.organization_access_events from anon, authenticated;
grant select on public.organization_access_events to authenticated;

create or replace function private.organization_access_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'organization_access_events e append-only: % nao e permitido. Corrija inserindo uma nova linha.', tg_op;
end;
$$;

create trigger organization_access_events_no_update
  before update or delete on public.organization_access_events
  for each row execute function private.organization_access_events_reject_mutation();

-- ------------------------------------------------------------
-- 2. A guarda contra lockout
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
  -- So interessa quando um ADMIN deixa de ser ADMIN ou sai. Rebaixar quem
  -- nunca foi ADMIN, ou promover alguem, nao ameaca ninguem.
  if tg_op = 'UPDATE' and (old.role <> 'ADMIN' or new.role = 'ADMIN') then
    return new;
  end if;

  if tg_op = 'DELETE' and old.role <> 'ADMIN' then
    return old;
  end if;

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

comment on function private.guard_last_admin() is
  'Impede que a organizacao fique sem ADMIN (D-175). Em TRIGGER e nao em RPC de proposito: protege todo caminho de escrita, inclusive PostgREST direto, e nao so o caminho que a tela usa.';

create trigger organization_members_guard_last_admin
  before update or delete on public.organization_members
  for each row execute function private.guard_last_admin();

-- ------------------------------------------------------------
-- 3. A auditoria, gravada pelo proprio banco
-- ------------------------------------------------------------
create or replace function private.log_member_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.organization_access_events
      (organization_id, event_type, target_user_id, new_role, actor_user_id)
    values (new.organization_id, 'MEMBER_ADDED', new.user_id, new.role, (select auth.uid()));

    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Update que nao mexe no papel (por exemplo `updated_at`) nao vira
    -- evento: historico de acesso registra MUDANCA de acesso.
    if old.role is not distinct from new.role then
      return new;
    end if;

    insert into public.organization_access_events
      (organization_id, event_type, target_user_id, previous_role, new_role, actor_user_id)
    values (new.organization_id, 'MEMBER_ROLE_CHANGED', new.user_id, old.role, new.role, (select auth.uid()));

    return new;
  end if;

  insert into public.organization_access_events
    (organization_id, event_type, target_user_id, previous_role, actor_user_id)
  values (old.organization_id, 'MEMBER_REMOVED', old.user_id, old.role, (select auth.uid()));

  return old;
end;
$$;

create trigger organization_members_audit
  after insert or update or delete on public.organization_members
  for each row execute function private.log_member_access_change();

create or replace function private.log_account_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_account uuid;
  v_user uuid;
begin
  v_account := coalesce(new.ml_account_id, old.ml_account_id);
  v_user := coalesce(new.user_id, old.user_id);

  select a.organization_id into v_org
  from public.ml_accounts a
  where a.id = v_account;

  -- Conta ja removida: sem organizacao para pendurar o evento. Nao inventa.
  if v_org is null then
    return coalesce(new, old);
  end if;

  insert into public.organization_access_events
    (organization_id, event_type, target_user_id, ml_account_id, actor_user_id)
  values (
    v_org,
    case when tg_op = 'INSERT' then 'ACCOUNT_ACCESS_GRANTED' else 'ACCOUNT_ACCESS_REVOKED' end,
    v_user,
    v_account,
    (select auth.uid())
  );

  return coalesce(new, old);
end;
$$;

create trigger user_account_permissions_audit
  after insert or delete on public.user_account_permissions
  for each row execute function private.log_account_access_change();
