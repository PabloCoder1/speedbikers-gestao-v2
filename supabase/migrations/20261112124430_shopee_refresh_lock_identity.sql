-- O prazo limita a duracao da trava. Cada aquisicao tem identidade propria,
-- inclusive quando dois jobs usam o mesmo horario antes e depois do OAuth.
alter table public.shopee_credentials
  add column refresh_lock_id uuid,
  add constraint shopee_credentials_refresh_lock_has_expiry
    check (refresh_lock_id is null or refresh_locked_until is not null);

-- Preserva a transacao e a verificacao de titularidade de D-657.
create or replace function public.shopee_connect_shops(
  p_organization_id uuid,
  p_created_by uuid,
  p_environment text,
  p_connected_at timestamptz,
  p_shops jsonb,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_gravadas bigint;
begin
  with lojas as (
    insert into public.shopee_shops as atual (
      organization_id, environment, shop_id, shop_name, region, shop_status,
      status, authorized_at, auth_expires_at, connected_at, last_error, created_by
    )
    select p_organization_id, p_environment, loja.shop_id, loja.shop_name, loja.region, loja.shop_status,
           'CONNECTED', loja.authorized_at, loja.auth_expires_at, p_connected_at, null, p_created_by
      from jsonb_to_recordset(p_shops) as loja (
        shop_id bigint, shop_name text, region text, shop_status text,
        authorized_at timestamptz, auth_expires_at timestamptz
      )
     order by loja.shop_id
    on conflict (environment, shop_id) do update set
      shop_name = excluded.shop_name,
      region = excluded.region,
      shop_status = excluded.shop_status,
      status = excluded.status,
      authorized_at = excluded.authorized_at,
      auth_expires_at = excluded.auth_expires_at,
      connected_at = excluded.connected_at,
      last_error = excluded.last_error,
      created_by = excluded.created_by
    where atual.organization_id = excluded.organization_id
    returning id
  ), credenciais as (
    insert into public.shopee_credentials (
      shopee_shop_id, access_token_ciphertext, refresh_token_ciphertext,
      access_token_expires_at, refresh_token_expires_at, refresh_locked_until, refresh_lock_id
    )
    select id, p_access_token_ciphertext, p_refresh_token_ciphertext,
           p_access_token_expires_at, p_refresh_token_expires_at, null, null
      from lojas
    on conflict (shopee_shop_id) do update set
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      refresh_locked_until = null,
      refresh_lock_id = null
    returning 1
  )
  select count(*) into v_gravadas from credenciais;

  if v_gravadas <> jsonb_array_length(p_shops) then
    raise sqlstate 'PT409' using message = 'Uma das lojas ja esta ligada a outra organizacao';
  end if;
end;
$$;

-- A sobrecarga por prazo continua atendendo travas legadas (UUID nulo).
-- A constraint impede que uma chamada legada libere uma trava com UUID.
create function public.shopee_reject_token_refresh(
  p_shopee_shop_id uuid,
  p_lock_id uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.shopee_shops where id = p_shopee_shop_id for update;

  update public.shopee_credentials
     set refresh_locked_until = null, refresh_lock_id = null
   where shopee_shop_id = p_shopee_shop_id and refresh_lock_id = p_lock_id;

  if not found then
    return false;
  end if;

  update public.shopee_shops
     set status = 'ERROR', last_error = left(p_error, 2000)
   where id = p_shopee_shop_id;

  return true;
end;
$$;

revoke execute on function public.shopee_reject_token_refresh(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.shopee_reject_token_refresh(uuid, uuid, text)
  to service_role;
