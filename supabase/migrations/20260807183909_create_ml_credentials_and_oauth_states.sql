-- ============================================================
-- Speed Bikers Gestão V2
-- Mercado Livre credentials and OAuth states
-- ============================================================

-- ------------------------------------------------------------
-- 1. MERCADO LIVRE CREDENTIALS
--
-- Tokens are encrypted by the trusted application backend
-- before they reach PostgreSQL.
-- ------------------------------------------------------------

create table public.ml_credentials (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  access_token_encrypted text not null,

  refresh_token_encrypted text not null,

  token_type text not null default 'bearer',

  scope text,

  expires_at timestamptz not null,

  -- Increased whenever a token set is replaced.
  token_version bigint not null default 1
    check (token_version > 0),

  -- Used to serialize refresh attempts.
  refresh_lock_id uuid,

  refresh_lock_expires_at timestamptz,

  last_refreshed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ml_credentials_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint ml_credentials_account_unique
    unique (ml_account_id),

  constraint ml_credentials_refresh_lock_consistency
    check (
      (
        refresh_lock_id is null
        and refresh_lock_expires_at is null
      )
      or
      (
        refresh_lock_id is not null
        and refresh_lock_expires_at is not null
      )
    )
);

comment on table public.ml_credentials is
  'Encrypted Mercado Livre access and refresh tokens. Backend-only.';

create index ml_credentials_expires_at_idx
  on public.ml_credentials (
    expires_at
  );

create trigger ml_credentials_set_updated_at
before update on public.ml_credentials
for each row
execute function private.set_updated_at();


-- ------------------------------------------------------------
-- 2. OAUTH STATES
--
-- Raw OAuth state is never stored.
-- Only a SHA-256 hash is persisted.
-- ------------------------------------------------------------

create table public.ml_oauth_states (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  initiated_by uuid not null
    references auth.users(id)
    on delete cascade,

  state_hash text not null unique,

  pkce_verifier_encrypted text not null,

  expires_at timestamptz not null,

  used_at timestamptz,

  created_at timestamptz not null default now(),

  constraint ml_oauth_states_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint ml_oauth_states_expiration_check
    check (
      expires_at > created_at
    )
);

comment on table public.ml_oauth_states is
  'Short-lived OAuth state and encrypted PKCE verifier. Backend-only.';

create index ml_oauth_states_account_idx
  on public.ml_oauth_states (
    ml_account_id
  );

create index ml_oauth_states_expires_at_idx
  on public.ml_oauth_states (
    expires_at
  );


-- ------------------------------------------------------------
-- 3. RLS
--
-- No browser or normal authenticated user may read tokens or
-- OAuth state records directly.
-- ------------------------------------------------------------

alter table public.ml_credentials
enable row level security;

alter table public.ml_oauth_states
enable row level security;

revoke all
on public.ml_credentials
from anon;

revoke all
on public.ml_credentials
from authenticated;

revoke all
on public.ml_oauth_states
from anon;

revoke all
on public.ml_oauth_states
from authenticated;


-- ------------------------------------------------------------
-- 4. ACQUIRE REFRESH LOCK
--
-- Only one worker may refresh an account at a time.
-- Backend invokes this with the privileged Supabase client.
-- ------------------------------------------------------------

create or replace function public.acquire_ml_refresh_lock(
  target_ml_account_id uuid,
  requested_lock_id uuid,
  lock_duration_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean;
begin
  if requested_lock_id is null then
    raise exception 'lock_id_required';
  end if;

  if (
    lock_duration_seconds < 10
    or lock_duration_seconds > 300
  ) then
    raise exception 'invalid_lock_duration';
  end if;

  update public.ml_credentials
  set
    refresh_lock_id =
      requested_lock_id,

    refresh_lock_expires_at =
      now()
      + make_interval(
          secs =>
            lock_duration_seconds
        )

  where ml_account_id =
      target_ml_account_id

    and (
      refresh_lock_id is null
      or refresh_lock_expires_at <= now()
    );

  get diagnostics
    acquired = row_count;

  return acquired;
end;
$$;


-- ------------------------------------------------------------
-- 5. RELEASE REFRESH LOCK
-- ------------------------------------------------------------

create or replace function public.release_ml_refresh_lock(
  target_ml_account_id uuid,
  requested_lock_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  released boolean;
begin
  update public.ml_credentials
  set
    refresh_lock_id = null,
    refresh_lock_expires_at = null

  where ml_account_id =
      target_ml_account_id

    and refresh_lock_id =
      requested_lock_id;

  get diagnostics
    released = row_count;

  return released;
end;
$$;


-- ------------------------------------------------------------
-- 6. PROTECT REFRESH FUNCTIONS
-- ------------------------------------------------------------

revoke all
on function public.acquire_ml_refresh_lock(
  uuid,
  uuid,
  integer
)
from public;

revoke all
on function public.acquire_ml_refresh_lock(
  uuid,
  uuid,
  integer
)
from anon;

revoke all
on function public.acquire_ml_refresh_lock(
  uuid,
  uuid,
  integer
)
from authenticated;


revoke all
on function public.release_ml_refresh_lock(
  uuid,
  uuid
)
from public;

revoke all
on function public.release_ml_refresh_lock(
  uuid,
  uuid
)
from anon;

revoke all
on function public.release_ml_refresh_lock(
  uuid,
  uuid
)
from authenticated;