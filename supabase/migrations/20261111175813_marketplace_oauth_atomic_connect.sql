-- A conta OAuth pode autorizar varias lojas. A titularidade e o par de
-- credenciais sao confirmados na mesma transacao para o lote inteiro.
create function public.shopee_connect_shops(
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
      access_token_expires_at, refresh_token_expires_at, refresh_locked_until
    )
    select id, p_access_token_ciphertext, p_refresh_token_ciphertext,
           p_access_token_expires_at, p_refresh_token_expires_at, null
      from lojas
    on conflict (shopee_shop_id) do update set
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      refresh_locked_until = null
    returning 1
  )
  select count(*) into v_gravadas from credenciais;

  if v_gravadas <> jsonb_array_length(p_shops) then
    raise sqlstate 'PT409' using message = 'Uma das lojas ja esta ligada a outra organizacao';
  end if;
end;
$$;

revoke execute on function public.shopee_connect_shops(uuid, uuid, text, timestamptz, jsonb, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.shopee_connect_shops(uuid, uuid, text, timestamptz, jsonb, text, text, timestamptz, timestamptz)
  to service_role;

create function public.tiktok_connect_shops(
  p_organization_id uuid,
  p_created_by uuid,
  p_connected_at timestamptz,
  p_shops jsonb,
  p_open_id text,
  p_seller_name text,
  p_granted_scopes text[],
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
  with autorizadas as (
    select * from jsonb_to_recordset(p_shops) as loja (
      shop_id text, shop_name text, region text, seller_type text, shop_code text, shop_cipher text
    )
  ), lojas as (
    insert into public.tiktok_shops as atual (
      organization_id, shop_id, shop_name, region, seller_type, shop_code,
      open_id, seller_name, granted_scopes, status, authorized_at,
      auth_expires_at, connected_at, last_error, created_by
    )
    select p_organization_id, loja.shop_id, loja.shop_name, loja.region, loja.seller_type, loja.shop_code,
           p_open_id, p_seller_name, p_granted_scopes, 'CONNECTED', p_connected_at,
           p_refresh_token_expires_at, p_connected_at, null, p_created_by
      from autorizadas as loja
     order by loja.shop_id
    on conflict (shop_id) do update set
      shop_name = excluded.shop_name,
      region = excluded.region,
      seller_type = excluded.seller_type,
      shop_code = excluded.shop_code,
      open_id = excluded.open_id,
      seller_name = excluded.seller_name,
      granted_scopes = excluded.granted_scopes,
      status = excluded.status,
      authorized_at = excluded.authorized_at,
      auth_expires_at = excluded.auth_expires_at,
      connected_at = excluded.connected_at,
      last_error = excluded.last_error,
      created_by = excluded.created_by
    where atual.organization_id = excluded.organization_id
    returning id, shop_id
  ), credenciais as (
    insert into public.tiktok_credentials (
      tiktok_shop_id, shop_cipher, access_token_ciphertext, refresh_token_ciphertext,
      access_token_expires_at, refresh_token_expires_at, refresh_locked_until
    )
    select loja.id, autorizadas.shop_cipher, p_access_token_ciphertext, p_refresh_token_ciphertext,
           p_access_token_expires_at, p_refresh_token_expires_at, null
      from lojas as loja
      join autorizadas using (shop_id)
    on conflict (tiktok_shop_id) do update set
      shop_cipher = excluded.shop_cipher,
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      refresh_locked_until = null
    returning 1
  )
  select count(*) into v_gravadas from credenciais;

  if v_gravadas <> jsonb_array_length(p_shops) then
    raise sqlstate 'PT409' using message = 'Uma das lojas ja esta ligada a outra organizacao';
  end if;
end;
$$;

revoke execute on function public.tiktok_connect_shops(uuid, uuid, timestamptz, jsonb, text, text, text[], text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.tiktok_connect_shops(uuid, uuid, timestamptz, jsonb, text, text, text[], text, text, timestamptz, timestamptz)
  to service_role;
