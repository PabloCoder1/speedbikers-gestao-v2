-- ============================================================
-- D-425 -- a SHOPEE entra como segundo canal, so leitura: a CONEXAO da loja.
--
-- D-037 restringiu a V3 ao Mercado Livre. O app da empresa foi aprovado no
-- Shopee Open Platform (tipo "Seller In House System") em 13/10, e o dono pediu
-- a integracao. Esta e a primeira fatia: guardar a loja autorizada e os tokens
-- dela. Pedidos, financeiro, produtos e estoque vem nas seguintes.
--
-- TABELAS PROPRIAS, nao `ml_accounts` generalizada: o esquema do Mercado
-- Livre e cravado no canal (slug da fila, `seller_id`, `item_id ~ '^MLB'`), e
-- generalizar agora reescreveria o que funciona para servir a algo que ainda
-- nao le um pedido. A convergencia (canal como dimensao nos relatorios) vem
-- quando houver dado dos dois lados.
--
-- DIFERENCA DE FLUXO: no Mercado Livre a conta nasce antes (em /contas) e so
-- depois e conectada. Na Shopee a loja so e conhecida NO RETORNO da
-- autorizacao (`shop_id`, ou varias por uma conta principal) -- e o retorno
-- que cria a linha. Por isso o `state` aponta para a organizacao, nao para
-- uma loja.
--
-- Contrato conferido na documentacao oficial em 13/10/2026
-- (open.shopee.com/developer-guide/20): access_token vale 4 h, refresh_token
-- 30 dias e so pode ser usado UMA vez; a autorizacao vence em ate 365 dias
-- (`expire_time` de shop/get_shop_info).
-- ============================================================

create table public.shopee_shops (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Sandbox e producao sao ambientes separados na Shopee: o partner_id de
  -- teste so autoriza loja de teste, e o mesmo numero de loja nao se repete
  -- entre eles por acaso -- mas a unicidade e por ambiente.
  environment text not null check (environment in ('sandbox', 'live')),
  shop_id bigint not null check (shop_id > 0),
  shop_name text,
  region text,
  -- O estado da loja NA SHOPEE (NORMAL, BANNED, FROZEN), como veio.
  shop_status text,
  -- O estado da CONEXAO: CONNECTED ou ERROR (como `ml_accounts`).
  status text not null default 'CONNECTED' check (status in ('CONNECTED', 'ERROR')),
  authorized_at timestamptz,
  -- Quando a autorizacao vence (`expire_time`); o vendedor escolhe ate 365 dias.
  auth_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_shops_unica unique (environment, shop_id)
);

create index shopee_shops_organization_idx on public.shopee_shops (organization_id);

create trigger shopee_shops_set_updated_at
  before update on public.shopee_shops
  for each row execute function private.set_updated_at();

comment on table public.shopee_shops is
  'Lojas Shopee autorizadas para a organizacao (D-425). Criadas pelo retorno da autorizacao (a api), nunca pelo navegador. shop_status e o estado da loja na Shopee; status e o da conexao.';

-- Os tokens, cifrados com a mesma chave de `ml_credentials` (AES-256-GCM,
-- `encryptToken`). Ninguem fora da api/worker le esta tabela.
create table public.shopee_credentials (
  shopee_shop_id uuid primary key references public.shopee_shops (id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  encryption_key_version smallint not null default 1,
  access_token_expires_at timestamptz not null,
  -- 30 dias depois de emitido; renovar antes, ou a loja precisa reautorizar.
  refresh_token_expires_at timestamptz not null,
  -- A trava da renovacao (mesmo desenho de `ml_credentials`, D-414).
  refresh_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ciphertext e base64 de iv(12) + tag(16) + dado: nunca menor que 40.
  constraint shopee_credentials_cifradas check (
    length(access_token_ciphertext) >= 40 and length(refresh_token_ciphertext) >= 40
  )
);

create trigger shopee_credentials_set_updated_at
  before update on public.shopee_credentials
  for each row execute function private.set_updated_at();

comment on table public.shopee_credentials is
  'Tokens da Shopee por loja (D-425), cifrados. Sem politica de RLS e sem grant para anon/authenticated: so a api e o worker leem.';

-- O `state` anti-CSRF da autorizacao: aponta para a ORGANIZACAO (a loja so e
-- conhecida no retorno). Consumido uma vez, atomicamente, no callback.
create table public.shopee_oauth_states (
  state text primary key check (length(state) between 20 and 200),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'live')),
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index shopee_oauth_states_expires_idx on public.shopee_oauth_states (expires_at);

comment on table public.shopee_oauth_states is
  'State anti-CSRF da autorizacao Shopee (D-425), um por inicio de conexao, valido por 15 minutos e consumido uma vez. So a api le e escreve.';

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.shopee_shops enable row level security;
alter table public.shopee_credentials enable row level security;
alter table public.shopee_oauth_states enable row level security;

-- Quem e da organizacao ve as lojas dela; ninguem escreve pelo navegador.
create policy shopee_shops_select_member
  on public.shopee_shops for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.shopee_shops from anon, authenticated;
grant select on public.shopee_shops to authenticated;
grant all on public.shopee_shops to service_role;

-- Credenciais e states: nenhuma politica, nenhum grant fora do service_role.
revoke all on public.shopee_credentials from anon, authenticated;
revoke all on public.shopee_oauth_states from anon, authenticated;
grant all on public.shopee_credentials to service_role;
grant all on public.shopee_oauth_states to service_role;
