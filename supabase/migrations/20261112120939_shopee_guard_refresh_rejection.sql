-- A reautorizacao grava loja e credenciais nessa ordem. A recusa da
-- renovacao usa a mesma ordem de locks e so atinge a credencial que travou.
create function public.shopee_reject_token_refresh(
  p_shopee_shop_id uuid,
  p_locked_until timestamptz,
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
     set refresh_locked_until = null
   where shopee_shop_id = p_shopee_shop_id and refresh_locked_until = p_locked_until;

  if not found then
    return false;
  end if;

  update public.shopee_shops
     set status = 'ERROR', last_error = left(p_error, 2000)
   where id = p_shopee_shop_id;

  return true;
end;
$$;

revoke execute on function public.shopee_reject_token_refresh(uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.shopee_reject_token_refresh(uuid, timestamptz, text)
  to service_role;
