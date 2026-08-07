-- ============================================================
-- Speed Bikers Gestão V2
-- Foundation: organizations, profiles, roles and permissions
-- ============================================================

-- ------------------------------------------------------------
-- 1. APPLICATION ROLES
-- ------------------------------------------------------------

create type public.app_role as enum (
  'admin',
  'gestor',
  'analista',
  'operador',
  'visualizador'
);

-- ------------------------------------------------------------
-- 2. PRIVATE SCHEMA
-- Internal helper functions used by RLS and database triggers.
-- This schema is not intended to be exposed through the API.
-- ------------------------------------------------------------

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ------------------------------------------------------------
-- 3. ORGANIZATIONS
-- ------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),

  name text not null
    check (
      char_length(trim(name)) between 2 and 120
    ),

  slug text not null unique
    check (
      slug = lower(slug)
      and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organizations is
  'Organizations that own users, marketplace accounts and business data.';

-- ------------------------------------------------------------
-- 4. PROFILES
-- One profile per Supabase Auth user.
-- Authorization does NOT live here.
-- ------------------------------------------------------------

create table public.profiles (
  id uuid primary key
    references auth.users(id)
    on delete cascade,

  full_name text
    check (
      full_name is null
      or char_length(trim(full_name)) between 2 and 120
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile associated one-to-one with auth.users.';

-- ------------------------------------------------------------
-- 5. ORGANIZATION MEMBERS
-- A user may belong to one or more organizations.
-- The role is scoped to the organization.
-- ------------------------------------------------------------

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  role public.app_role not null default 'visualizador',

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint organization_members_organization_user_unique
    unique (organization_id, user_id)
);

comment on table public.organization_members is
  'Organization membership and organization-scoped application role.';

-- ------------------------------------------------------------
-- 6. INDEXES
-- ------------------------------------------------------------

create index organization_members_user_id_idx
  on public.organization_members (user_id);

create index organization_members_organization_role_idx
  on public.organization_members (organization_id, role)
  where is_active = true;

-- ------------------------------------------------------------
-- 7. UPDATED_AT FUNCTION
-- ------------------------------------------------------------

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
before update on public.organizations
for each row
execute function private.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function private.set_updated_at();

create trigger organization_members_set_updated_at
before update on public.organization_members
for each row
execute function private.set_updated_at();

-- ------------------------------------------------------------
-- 8. PROFILE CREATION AFTER AUTH SIGNUP
-- Creates the public profile automatically whenever a new
-- Supabase Auth user is created.
-- ------------------------------------------------------------

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_full_name text;
begin
  new_full_name :=
    nullif(
      trim(
        coalesce(
          new.raw_user_meta_data ->> 'full_name',
          ''
        )
      ),
      ''
    );

  insert into public.profiles (
    id,
    full_name
  )
  values (
    new.id,
    new_full_name
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function private.handle_new_auth_user();

-- ------------------------------------------------------------
-- 9. RLS HELPER FUNCTIONS
-- Security-definer functions avoid recursive RLS queries when
-- organization membership is checked inside policies.
-- ------------------------------------------------------------

create or replace function private.is_organization_member(
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
  );
$$;

create or replace function private.shares_organization_with(
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as current_member
    inner join public.organization_members as target_member
      on target_member.organization_id = current_member.organization_id
    where current_member.user_id = (select auth.uid())
      and current_member.is_active = true
      and target_member.user_id = target_user_id
      and target_member.is_active = true
  );
$$;

create or replace function private.has_organization_role(
  target_organization_id uuid,
  allowed_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
      and member.role = any(allowed_roles)
  );
$$;

-- Keep private functions unavailable as public RPC functions.
revoke all on all functions in schema private from public;

grant execute
  on function private.is_organization_member(uuid)
  to authenticated;

grant execute
  on function private.shares_organization_with(uuid)
  to authenticated;

grant execute
  on function private.has_organization_role(uuid, public.app_role[])
  to authenticated;

-- ------------------------------------------------------------
-- 10. ENABLE ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table public.organizations
enable row level security;

alter table public.profiles
enable row level security;

alter table public.organization_members
enable row level security;

-- ------------------------------------------------------------
-- 11. TABLE PRIVILEGES
-- Anonymous users receive no access.
-- Authenticated users receive only the minimum privileges
-- required by the current application stage.
-- ------------------------------------------------------------

revoke all on public.organizations from anon;
revoke all on public.profiles from anon;
revoke all on public.organization_members from anon;

revoke all on public.organizations from authenticated;
revoke all on public.profiles from authenticated;
revoke all on public.organization_members from authenticated;

grant select
  on public.organizations
  to authenticated;

grant select
  on public.profiles
  to authenticated;

grant update (full_name)
  on public.profiles
  to authenticated;

grant select
  on public.organization_members
  to authenticated;

-- ------------------------------------------------------------
-- 12. ORGANIZATIONS RLS POLICIES
-- Users can only see organizations to which they belong.
-- ------------------------------------------------------------

create policy "organization members can view organization"
on public.organizations
for select
to authenticated
using (
  (select private.is_organization_member(id))
);

-- ------------------------------------------------------------
-- 13. PROFILES RLS POLICIES
-- Users can see their own profile and profiles belonging to
-- users who share an active organization with them.
-- A user may update only their own profile.
-- Column-level privileges restrict updates to full_name.
-- ------------------------------------------------------------

create policy "users can view permitted profiles"
on public.profiles
for select
to authenticated
using (
  (select auth.uid()) = id
  or private.shares_organization_with(id)
);

create policy "users can update own profile"
on public.profiles
for update
to authenticated
using (
  (select auth.uid()) = id
)
with check (
  (select auth.uid()) = id
);

-- ------------------------------------------------------------
-- 14. ORGANIZATION MEMBERS RLS POLICIES
-- Members may view memberships belonging to their organization.
-- Mutations remain backend-only for now.
-- ------------------------------------------------------------

create policy "organization members can view memberships"
on public.organization_members
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

-- ------------------------------------------------------------
-- 15. INITIAL ORGANIZATION
-- Creates our current operation without hardcoding the
-- organization into the application code.
-- ------------------------------------------------------------

insert into public.organizations (
  name,
  slug
)
values (
  'Speed Bikers',
  'speed-bikers'
)
on conflict (slug) do nothing;