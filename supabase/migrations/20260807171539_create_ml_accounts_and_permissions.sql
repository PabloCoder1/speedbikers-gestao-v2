-- ============================================================
-- Speed Bikers Gestão V2
-- Mercado Livre accounts and per-account permissions
-- ============================================================

-- ------------------------------------------------------------
-- 1. CONNECTION STATUS
-- ------------------------------------------------------------

create type public.ml_account_connection_status as enum (
  'not_connected',
  'connected',
  'reauthorization_required',
  'disabled'
);

-- ------------------------------------------------------------
-- 2. MERCADO LIVRE ACCOUNTS
-- One row represents one seller account connected or intended
-- to be connected to the organization.
-- ------------------------------------------------------------

create table public.ml_accounts (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  code text not null
    check (
      code = lower(code)
      and code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    ),

  display_name text not null
    check (
      char_length(trim(display_name))
      between 2 and 120
    ),

  -- Mercado Livre seller/user ID.
  -- Stored as text deliberately because it is an external
  -- identifier and may exceed Int32.
  seller_id text
    check (
      seller_id is null
      or seller_id ~ '^[0-9]+$'
    ),

  nickname text
    check (
      nickname is null
      or char_length(trim(nickname))
        between 1 and 120
    ),

  site_id text not null default 'MLB'
    check (
      site_id ~ '^[A-Z]{3}$'
    ),

  connection_status
    public.ml_account_connection_status
    not null
    default 'not_connected',

  is_active boolean not null default true,

  connected_at timestamptz,
  last_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ml_accounts_organization_code_unique
    unique (organization_id, code),

  constraint ml_accounts_organization_id_id_unique
    unique (organization_id, id)
);

comment on table public.ml_accounts is
  'Mercado Livre seller accounts managed by an organization.';

comment on column public.ml_accounts.seller_id is
  'Mercado Livre user/seller identifier returned after OAuth. Stored as text to preserve external identifier precision.';

-- A seller cannot be connected twice inside the same
-- organization, while NULL is allowed before OAuth.
create unique index ml_accounts_organization_seller_unique_idx
  on public.ml_accounts (
    organization_id,
    seller_id
  )
  where seller_id is not null;

create index ml_accounts_organization_id_idx
  on public.ml_accounts (
    organization_id
  );

create index ml_accounts_connection_status_idx
  on public.ml_accounts (
    organization_id,
    connection_status
  );

-- ------------------------------------------------------------
-- 3. UPDATED_AT
-- ------------------------------------------------------------

create trigger ml_accounts_set_updated_at
before update on public.ml_accounts
for each row
execute function private.set_updated_at();

-- ------------------------------------------------------------
-- 4. USER ↔ ML ACCOUNT PERMISSIONS
--
-- The existence of a row means the user is allowed to access
-- that marketplace account.
--
-- Operation-level permissions continue to be controlled by
-- the user's organization role.
-- ------------------------------------------------------------

create table public.user_account_permissions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  user_id uuid not null,

  ml_account_id uuid not null,

  created_by uuid
    references auth.users(id)
    on delete set null,

  created_at timestamptz not null default now(),

  constraint user_account_permissions_member_fk
    foreign key (
      organization_id,
      user_id
    )
    references public.organization_members (
      organization_id,
      user_id
    )
    on delete cascade,

  constraint user_account_permissions_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint user_account_permissions_unique
    unique (
      ml_account_id,
      user_id
    )
);

comment on table public.user_account_permissions is
  'Explicit access granted to an internal user for a Mercado Livre seller account.';

create index user_account_permissions_user_id_idx
  on public.user_account_permissions (
    user_id
  );

create index user_account_permissions_account_id_idx
  on public.user_account_permissions (
    ml_account_id
  );

-- ------------------------------------------------------------
-- 5. CENTRAL ACCOUNT ACCESS FUNCTION
--
-- ADMIN receives implicit access to every account in their
-- organization.
--
-- Other roles require an explicit row in
-- user_account_permissions.
-- ------------------------------------------------------------

create or replace function private.can_access_ml_account(
  target_ml_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ml_accounts as account

    inner join public.organization_members as membership
      on membership.organization_id =
        account.organization_id

    where account.id =
      target_ml_account_id

      and membership.user_id =
        (select auth.uid())

      and membership.is_active = true

      and (
        membership.role =
          'admin'::public.app_role

        or exists (
          select 1
          from public.user_account_permissions
            as permission

          where permission.organization_id =
            account.organization_id

            and permission.ml_account_id =
              account.id

            and permission.user_id =
              (select auth.uid())
        )
      )
  );
$$;

revoke all
on function private.can_access_ml_account(uuid)
from public;

grant execute
on function private.can_access_ml_account(uuid)
to authenticated;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------

alter table public.ml_accounts
enable row level security;

alter table public.user_account_permissions
enable row level security;

-- ------------------------------------------------------------
-- 7. TABLE PRIVILEGES
--
-- Marketplace account mutations remain backend-only.
-- ------------------------------------------------------------

revoke all
on public.ml_accounts
from anon;

revoke all
on public.user_account_permissions
from anon;

revoke all
on public.ml_accounts
from authenticated;

revoke all
on public.user_account_permissions
from authenticated;

grant select
on public.ml_accounts
to authenticated;

grant select
on public.user_account_permissions
to authenticated;

-- ------------------------------------------------------------
-- 8. ML ACCOUNT RLS
-- ------------------------------------------------------------

create policy "users can view permitted ml accounts"
on public.ml_accounts
for select
to authenticated
using (
  private.can_access_ml_account(id)
);

-- ------------------------------------------------------------
-- 9. PERMISSION RLS
--
-- User may inspect their own permissions.
-- Admin may inspect permissions belonging to their org.
-- Writes stay backend-only.
-- ------------------------------------------------------------

create policy "users can view account permissions"
on public.user_account_permissions
for select
to authenticated
using (
  user_id = (select auth.uid())

  or private.has_organization_role(
    organization_id,
    array[
      'admin'::public.app_role
    ]
  )
);

-- ------------------------------------------------------------
-- 10. INITIAL MERCADO LIVRE ACCOUNTS
--
-- These are configuration records only.
-- No OAuth credential is stored here.
-- ------------------------------------------------------------

insert into public.ml_accounts (
  organization_id,
  code,
  display_name
)
select
  organization.id,
  account.code,
  account.display_name
from public.organizations as organization

cross join (
  values
    (
      'speedbikers',
      'SpeedBikers'
    ),
    (
      'offracer',
      'OffRacer'
    ),
    (
      'sb',
      'SB'
    ),
    (
      'gmr',
      'GMR'
    )
) as account(
  code,
  display_name
)

where organization.slug =
  'speed-bikers'

on conflict (
  organization_id,
  code
)
do nothing;