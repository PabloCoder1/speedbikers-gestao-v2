-- ============================================================
-- Speed Bikers Gestão V2
-- Atomic Mercado Livre account permission management
-- ============================================================

create or replace function public.set_user_account_permissions(
  target_organization_id uuid,
  target_user_id uuid,
  target_account_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role public.app_role;
  invalid_accounts integer;
begin
  -- Authentication is mandatory.
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  -- Only an active ADMIN of this organization may manage
  -- marketplace-account permissions.
  if not private.has_organization_role(
    target_organization_id,
    array[
      'admin'::public.app_role
    ]
  ) then
    raise exception 'not_authorized';
  end if;

  -- Target user must belong to the organization.
  select member.role
  into target_role
  from public.organization_members as member
  where member.organization_id =
      target_organization_id
    and member.user_id =
      target_user_id
  limit 1;

  if target_role is null then
    raise exception 'target_user_not_found';
  end if;

  -- ADMIN already has implicit access to every ML account.
  if target_role =
    'admin'::public.app_role
  then
    raise exception 'admin_has_implicit_access';
  end if;

  target_account_ids :=
    coalesce(
      target_account_ids,
      array[]::uuid[]
    );

  -- Reject IDs belonging to another organization or that do
  -- not exist.
  select count(*)
  into invalid_accounts
  from unnest(
    target_account_ids
  ) as selected(account_id)
  left join public.ml_accounts as account
    on account.id =
      selected.account_id
    and account.organization_id =
      target_organization_id
  where account.id is null;

  if invalid_accounts > 0 then
    raise exception 'invalid_ml_account';
  end if;

  -- Replace permissions atomically.
  delete from public.user_account_permissions
  where organization_id =
      target_organization_id
    and user_id =
      target_user_id;

  insert into public.user_account_permissions (
    organization_id,
    user_id,
    ml_account_id,
    created_by
  )
  select
    target_organization_id,
    target_user_id,
    selected.account_id,
    auth.uid()
  from (
    select distinct account_id
    from unnest(
      target_account_ids
    ) as values_list(account_id)
  ) as selected

  on conflict (
    ml_account_id,
    user_id
  )
  do nothing;
end;
$$;

revoke all
on function public.set_user_account_permissions(
  uuid,
  uuid,
  uuid[]
)
from public;

grant execute
on function public.set_user_account_permissions(
  uuid,
  uuid,
  uuid[]
)
to authenticated;