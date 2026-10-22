-- ============================================================
-- D-645 -- o TIKTOK SHOP entra como terceiro canal, so leitura: a CONEXAO da
-- loja (a fatia 1 de `docs/TIKTOK_SHOP.md` §15).
--
-- O desenho da Shopee (D-425, 20261013120000): TABELAS PROPRIAS, a loja
-- criada no RETORNO da autorizacao (o `state` aponta para a organizacao), o
-- token cifrado e lido so pela api e pelo worker.
--
-- Contrato conferido na documentacao oficial em 22/10/2026
-- (P`authorization-overview-202407`, P`get-authorized-shops-202309`):
-- - o access token vale 7 dias e o refresh token, a duracao de autorizacao que
--   o vendedor escolheu; as duas validades vem como instante Unix;
-- - a loja e identificada pelo `id` (texto de digitos, o que o webhook traz) e
--   cada chamada de loja leva o `cipher` como `shop_cipher`;
-- - o mesmo token vale para as lojas que o vendedor autorizou (a do Brasil e
--   LOCAL, uma loja so).
-- Nao ha sandbox de API separado: a loja de teste usa os mesmos enderecos.
-- ============================================================

create table public.tiktok_shops (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- O `id` da loja no TikTok Shop, como texto (ex.: 7000714532876273420).
  shop_id text not null check (shop_id ~ '^[0-9]{1,30}$'),
  shop_name text,
  region text,
  -- LOCAL ou CROSS_BORDER, como veio.
  seller_type text,
  -- O codigo da loja no Seller Center.
  shop_code text,
  -- Quem autorizou: o vendedor (`open_id`) e o nome dele.
  open_id text,
  seller_name text,
  -- Os escopos que o vendedor concedeu (`granted_scopes`): a falta de um da o
  -- erro 105005, e a tela pode dizer qual.
  granted_scopes text[],
  -- O estado da CONEXAO: CONNECTED ou ERROR (como `shopee_shops`).
  status text not null default 'CONNECTED' check (status in ('CONNECTED', 'ERROR')),
  authorized_at timestamptz,
  -- O fim da autorizacao: a validade do refresh token.
  auth_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tiktok_shops_unica unique (shop_id)
);

create index tiktok_shops_organization_idx on public.tiktok_shops (organization_id);

create trigger tiktok_shops_set_updated_at
  before update on public.tiktok_shops
  for each row execute function private.set_updated_at();

comment on table public.tiktok_shops is
  'Lojas do TikTok Shop autorizadas para a organizacao (D-645). Criadas pelo retorno da autorizacao (a api), nunca pelo navegador. status e o da conexao.';

-- O token e o cipher, com a mesma cifra de `shopee_credentials` (AES-256-GCM,
-- `encryptToken`). Ninguem fora da api e do worker le esta tabela.
create table public.tiktok_credentials (
  tiktok_shop_id uuid primary key references public.tiktok_shops (id) on delete cascade,
  -- O `cipher` da loja, que vai como `shop_cipher` em toda chamada de loja.
  shop_cipher text not null check (length(shop_cipher) between 1 and 500),
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  encryption_key_version smallint not null default 1,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz not null,
  -- A trava da renovacao (o desenho de `ml_credentials`, D-414), para a fatia 2.
  refresh_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ciphertext e base64 de iv(12) + tag(16) + dado: nunca menor que 40.
  constraint tiktok_credentials_cifradas check (
    length(access_token_ciphertext) >= 40 and length(refresh_token_ciphertext) >= 40
  )
);

create trigger tiktok_credentials_set_updated_at
  before update on public.tiktok_credentials
  for each row execute function private.set_updated_at();

comment on table public.tiktok_credentials is
  'Tokens do TikTok Shop por loja (D-645), cifrados, e o shop_cipher. Sem politica de RLS e sem grant para anon/authenticated: so a api e o worker leem.';

-- O `state` anti-CSRF da autorizacao: aponta para a ORGANIZACAO (a loja so e
-- conhecida no retorno). Consumido uma vez, atomicamente, no callback.
create table public.tiktok_oauth_states (
  state text primary key check (length(state) between 20 and 200),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index tiktok_oauth_states_expires_idx on public.tiktok_oauth_states (expires_at);

comment on table public.tiktok_oauth_states is
  'State anti-CSRF da autorizacao do TikTok Shop (D-645), um por inicio de conexao, valido por 15 minutos e consumido uma vez. So a api le e escreve.';

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.tiktok_shops enable row level security;
alter table public.tiktok_credentials enable row level security;
alter table public.tiktok_oauth_states enable row level security;

-- Quem e da organizacao ve as lojas dela; ninguem escreve pelo navegador.
create policy tiktok_shops_select_member
  on public.tiktok_shops for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.tiktok_shops from anon, authenticated;
grant select on public.tiktok_shops to authenticated;
grant all on public.tiktok_shops to service_role;

-- Credenciais e states: nenhuma politica, nenhum grant fora do service_role.
revoke all on public.tiktok_credentials from anon, authenticated;
revoke all on public.tiktok_oauth_states from anon, authenticated;
grant all on public.tiktok_credentials to service_role;
grant all on public.tiktok_oauth_states to service_role;
