-- ============================================================
-- Identidade: organizações, perfis e papéis.
--
-- Primeira tabela de dominio da V3. Tudo que vier depois se apoia nos helpers
-- definidos aqui, entao o cuidado nesta migration paga juros.
--
-- Modelo A (D-012): o `web` le o banco direto sob RLS. As policies abaixo NAO
-- sao uma segunda camada de conforto — elas SAO a seguranca do sistema.
-- ============================================================

-- ============================================================
-- 1. Schema privado
--
-- Funcoes auxiliares ficam fora de `public` de proposito: o PostgREST expoe
-- `public`, e helper de autorizacao nao deve virar endpoint.
-- ============================================================

create schema if not exists private;

revoke all on schema private from anon, authenticated;
grant usage on schema private to service_role;

-- ============================================================
-- 2. Tabelas
-- ============================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  slug text not null check (slug = lower(slug) and char_length(slug) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_unique unique (slug)
);

comment on table public.organizations is
  'Empresa/tenant. Chave de particao de toda tabela de dominio (D-031).';

-- `profiles` espelha `auth.users`. Os dados de login (e-mail, senha, sessao)
-- continuam sendo do Supabase Auth; aqui fica apenas o que a aplicacao precisa
-- exibir e relacionar.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or char_length(btrim(full_name)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Dados de aplicacao do usuario. A identidade de login vive em auth.users.';

-- Papeis previstos em docs/PROMPT_MASTER.md secao 10.
--
-- `text` com check em vez de enum nativo: alterar um enum do Postgres exige
-- migration cara, e a lista de papeis tende a mudar mais que o schema.
create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('ADMIN', 'GESTOR', 'ANALISTA', 'OPERADOR', 'VISUALIZADOR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

comment on table public.organization_members is
  'Vinculo usuario-organizacao com papel. Um usuario pode pertencer a mais de uma.';

create index organization_members_user_idx
  on public.organization_members (user_id);

-- ============================================================
-- 3. updated_at
-- ============================================================

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function private.set_updated_at();

-- ============================================================
-- 4. Helpers de RLS
--
-- TRES decisoes deliberadas em cada um deles:
--
-- `security definer` — o helper consulta `organization_members`, que tem RLS.
--   Executando como o chamador, a policy chamaria o helper, que consultaria a
--   tabela, que aplicaria a policy... recursao infinita. É a armadilha classica
--   de RLS no Postgres, e `security definer` a evita.
--
-- `stable` — funcoes de RLS entram no plano de TODA consulta. Marcada `stable`,
--   o planner avalia uma vez por statement; marcada `volatile` (o padrao), uma
--   vez POR LINHA. É o modo mais comum de um sistema com RLS ficar lento sem
--   ninguem entender por que (docs/ARCHITECTURE.md secao 18).
--
-- `set search_path = ''` — com `security definer`, um search_path manipulavel
--   permitiria a um usuario criar um objeto que a funcao resolveria no lugar do
--   pretendido. Por isso todo nome aqui e qualificado.
-- ============================================================

create or replace function private.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid())
  limit 1;
$$;

comment on function private.current_org_id is
  'Organizacao do usuario autenticado. Com multiplas organizacoes por usuario, '
  'passara a depender de um claim de sessao — hoje ha uma so.';

create or replace function private.is_member_of(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_role(allowed text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.user_id = (select auth.uid())
      and m.role = any (allowed)
  );
$$;

create or replace function private.shares_org_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members mine
    join public.organization_members theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = other_user
  );
$$;

-- ============================================================
-- 5. Criacao automatica do perfil
--
-- Sem isto, um usuario criado pelo Auth nao teria linha em `profiles` e
-- qualquer join com ele devolveria vazio — falha silenciosa.
-- ============================================================

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;

-- Organizacao: quem e membro ve a sua. Escrita so pela service_role, porque
-- criar organizacao e ato administrativo, nao de usuario.
create policy organizations_select_own
  on public.organizations for select to authenticated
  using (private.is_member_of(id));

-- Perfil: o proprio, e os colegas de organizacao (necessario para exibir
-- responsavel por acao, autor de decisao, etc).
create policy profiles_select_self_or_colleague
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id or private.shares_org_with(id));

-- Atualizar o proprio perfil, e apenas ele.
create policy profiles_update_self
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Membros: visiveis dentro da organizacao.
create policy organization_members_select_same_org
  on public.organization_members for select to authenticated
  using (private.is_member_of(organization_id));

-- Conceder e revogar papel e privilegio de ADMIN. Sem policy de insert/update/
-- delete para os demais papeis: a ausencia de policy ja nega.
create policy organization_members_admin_writes
  on public.organization_members for all to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN']));

-- ============================================================
-- 7. GRANTs
--
-- Privilegio de tabela e avaliado ANTES da policy: sem GRANT, a policy nunca
-- chega a ser consultada (docs/DATABASE.md secao 5).
--
-- `anon` nao recebe nada. Usuario nao autenticado nao tem o que ver aqui.
-- ============================================================

grant select on public.organizations to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;

grant select, insert, update, delete
  on public.organizations, public.profiles, public.organization_members
  to service_role;

revoke all on public.organizations from anon;
revoke all on public.profiles from anon;
revoke all on public.organization_members from anon;
