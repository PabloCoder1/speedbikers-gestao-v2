alter table public.ml_accounts
add column if not exists oauth_app_code text;


update public.ml_accounts
set oauth_app_code = code
where oauth_app_code is null;


alter table public.ml_accounts
alter column oauth_app_code
set not null;


alter table public.ml_accounts
add column if not exists expected_seller_id bigint;


create unique index if not exists
ml_accounts_expected_seller_id_unique_idx

on public.ml_accounts (
  expected_seller_id
)

where expected_seller_id is not null;


comment on column public.ml_accounts.oauth_app_code is
'Identifica qual configuração OAuth/client_id deve ser usada. É independente da identidade lógica da conta Mercado Livre.';


comment on column public.ml_accounts.expected_seller_id is
'Seller ID esperado para a conta lógica. Usado para impedir que uma conta Mercado Livre seja conectada no card incorreto.';