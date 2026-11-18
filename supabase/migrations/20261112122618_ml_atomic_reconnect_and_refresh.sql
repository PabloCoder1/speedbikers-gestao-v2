-- A reconexao e a recusa de refresh adquirem locks na mesma ordem:
-- conta primeiro, credencial depois. A troca do par invalida a trava anterior.
alter table public.ml_credentials
  add column refresh_lock_id uuid,
  add constraint ml_credentials_refresh_lock_has_expiry
    check (refresh_lock_id is null or refresh_locked_until is not null);

create function public.ml_connect_account(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_seller_id bigint,
  p_connected_at timestamptz,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_scopes text[]
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_seller_id bigint;
  v_slug text;
begin
  select seller_id, slug into v_seller_id, v_slug
    from public.ml_accounts
   where id = p_ml_account_id and organization_id = p_organization_id
     for update;

  if not found then
    return null;
  end if;

  if v_seller_id is not null and v_seller_id is distinct from p_seller_id then
    raise sqlstate 'PT409' using message = 'A conta autorizada pertence a outro vendedor';
  end if;

  update public.ml_accounts
     set seller_id = p_seller_id, status = 'CONNECTED', connected_at = p_connected_at, last_error = null
   where id = p_ml_account_id;

  insert into public.ml_credentials (
    ml_account_id, access_token_ciphertext, refresh_token_ciphertext,
    access_token_expires_at, scopes, refresh_locked_until, refresh_lock_id
  )
  values (
    p_ml_account_id, p_access_token_ciphertext, p_refresh_token_ciphertext,
    p_access_token_expires_at, p_scopes, null, null
  )
  on conflict (ml_account_id) do update set
    access_token_ciphertext = excluded.access_token_ciphertext,
    refresh_token_ciphertext = excluded.refresh_token_ciphertext,
    access_token_expires_at = excluded.access_token_expires_at,
    scopes = excluded.scopes,
    refresh_locked_until = null,
    refresh_lock_id = null;

  return v_slug;
end;
$$;

revoke execute on function public.ml_connect_account(uuid, uuid, bigint, timestamptz, text, text, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.ml_connect_account(uuid, uuid, bigint, timestamptz, text, text, timestamptz, text[])
  to service_role;

create function public.ml_reject_token_refresh(
  p_ml_account_id uuid,
  p_lock_id uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.ml_accounts where id = p_ml_account_id and status = 'CONNECTED' for update;
  if not found then
    return false;
  end if;

  update public.ml_credentials
     set refresh_locked_until = null, refresh_lock_id = null
   where ml_account_id = p_ml_account_id and refresh_lock_id = p_lock_id;

  if not found then
    return false;
  end if;

  update public.ml_accounts
     set status = 'ERROR', last_error = left(p_error, 2000)
   where id = p_ml_account_id;

  return true;
end;
$$;

revoke execute on function public.ml_reject_token_refresh(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ml_reject_token_refresh(uuid, uuid, text)
  to service_role;
