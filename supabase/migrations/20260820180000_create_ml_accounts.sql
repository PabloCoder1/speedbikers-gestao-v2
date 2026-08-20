-- ============================================================
-- Contas Mercado Livre: identidade da conta, credenciais e permissao por conta.
--
-- E a parte mais sensivel do schema: guarda o que da acesso a operacao inteira
-- no Mercado Livre. As decisoes de exposicao aqui sao mais restritivas que em
-- qualquer outra tabela, e de proposito.
-- ============================================================

-- ============================================================
-- 1. ml_accounts
--
-- A conta existe ANTES do OAuth: o ADMIN cadastra, depois autoriza. Por isso
-- `seller_id` e `nickname` sao nulos ate a autorizacao concluir, e `status`
-- carrega em que ponto do caminho a conta esta.
-- ============================================================

create table public.ml_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Rotulo interno, escolhido por nos. A exportacao do UpSeller mostra que a
  -- operacao usa nomes como "Speedbikers (loja 1)" e "SbMotos".
  label text not null check (char_length(btrim(label)) between 1 and 120),

  -- Identificador tecnico. NOMEIA A FILA do Cloud Tasks: `ml-sync-<slug>`
  -- (D-036, uma fila por conta). Por isso o charset e restrito exatamente ao
  -- que o Cloud Tasks aceita em nome de fila — a constraint aqui evita
  -- descobrir o problema so na hora de provisionar.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),

  -- Preenchidos pelo OAuth.
  seller_id bigint check (seller_id is null or seller_id > 0),
  nickname text,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'CONNECTED', 'REVOKED', 'ERROR')),

  connected_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ml_accounts_org_slug_unique unique (organization_id, slug),

  -- Uma conta do Mercado Livre nao pode ser cadastrada duas vezes na mesma
  -- organizacao. Parcial porque `seller_id` e nulo antes do OAuth.
  constraint ml_accounts_status_coherent check (
    (status = 'CONNECTED' and seller_id is not null and connected_at is not null)
    or status <> 'CONNECTED'
  )
);

create unique index ml_accounts_org_seller_unique
  on public.ml_accounts (organization_id, seller_id)
  where seller_id is not null;

comment on table public.ml_accounts is
  'Conta do Mercado Livre. O slug nomeia a fila Cloud Tasks ml-sync-<slug> (D-036).';

comment on column public.ml_accounts.status is
  'PENDING cadastrada sem OAuth · CONNECTED autorizada · REVOKED acesso retirado · ERROR falha persistente.';

create trigger ml_accounts_set_updated_at
  before update on public.ml_accounts
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. ml_credentials
--
-- Tabela separada de `ml_accounts` por um motivo unico e suficiente: assim a
-- conta pode ser lida sem que o segredo esteja no mesmo SELECT. Quem consulta
-- "quais contas existem" nunca toca na linha que guarda o token.
--
-- O token e gravado JA CIFRADO pela `api`, com chave no Secret Manager
-- (docs/ARCHITECTURE.md secao 18). O banco nunca ve texto claro e nunca tem a
-- chave: um vazamento do dump nao entrega acesso ao Mercado Livre.
--
-- `encryption_key_version` existe para permitir rotacao de chave sem
-- reprocessar tudo de uma vez.
-- ============================================================

create table public.ml_credentials (
  ml_account_id uuid primary key references public.ml_accounts(id) on delete cascade,

  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  encryption_key_version smallint not null default 1 check (encryption_key_version > 0),

  access_token_expires_at timestamptz not null,
  scopes text[],

  -- Trava de refresh. A V2 precisou disto: varias execucoes concorrentes
  -- tentando renovar o mesmo token gastam refresh tokens e derrubam a conta.
  refresh_locked_until timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Guarda contra gravar texto claro por engano. Nao prova que esta cifrado,
  -- mas pega o erro obvio de salvar o token do jeito que o ML devolve.
  constraint ml_credentials_looks_encrypted check (
    access_token_ciphertext not like 'APP_USR-%'
    and refresh_token_ciphertext not like 'TG-%'
  )
);

comment on table public.ml_credentials is
  'Tokens CIFRADOS pela api. A chave vive no Secret Manager, nunca no banco.';

create trigger ml_credentials_set_updated_at
  before update on public.ml_credentials
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. ml_oauth_states
--
-- Protecao de CSRF do fluxo OAuth: o `state` enviado ao Mercado Livre volta no
-- callback e precisa ser reconhecido, uso unico e dentro do prazo.
-- ============================================================

create table public.ml_oauth_states (
  state text primary key check (char_length(state) between 20 and 200),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  redirect_to text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.ml_oauth_states is
  'State de CSRF do OAuth. Uso unico: consumed_at marca que ja foi trocado.';

create index ml_oauth_states_expiry_idx on public.ml_oauth_states (expires_at);

-- ============================================================
-- 4. user_account_permissions
--
-- `docs/PROMPT_MASTER.md` secao 10: permissoes respeitam contas autorizadas.
-- Papel diz O QUE o usuario pode fazer; esta tabela diz EM QUAIS CONTAS.
-- ============================================================

create table public.user_account_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, ml_account_id)
);

create index user_account_permissions_account_idx
  on public.user_account_permissions (ml_account_id);

create trigger user_account_permissions_set_updated_at
  before update on public.user_account_permissions
  for each row execute function private.set_updated_at();

-- ============================================================
-- 5. Helper de acesso por conta
--
-- ADMIN enxerga todas as contas da propria organizacao: sem isso ele nao
-- conseguiria conceder permissao para os outros, o que trancaria a operacao
-- no primeiro dia.
--
-- Mesmas tres marcacoes dos demais helpers, pelos mesmos tres motivos:
-- `security definer` evita recursao, `stable` evita avaliacao por linha,
-- `search_path` vazio fecha a superficie de injecao.
-- ============================================================

create or replace function private.has_account_access(target_account uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ml_accounts a
    join public.organization_members m
      on m.organization_id = a.organization_id
    where a.id = target_account
      and m.user_id = (select auth.uid())
      and (
        m.role = 'ADMIN'
        or exists (
          select 1
          from public.user_account_permissions p
          where p.ml_account_id = a.id
            and p.user_id = m.user_id
        )
      )
  );
$$;

comment on function private.has_account_access is
  'Usuario alcanca a conta? ADMIN alcanca todas da sua organizacao.';

-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.ml_accounts enable row level security;
alter table public.ml_credentials enable row level security;
alter table public.ml_oauth_states enable row level security;
alter table public.user_account_permissions enable row level security;

create policy ml_accounts_select_permitted
  on public.ml_accounts for select to authenticated
  using (private.has_account_access(id));

create policy ml_accounts_admin_writes
  on public.ml_accounts for all to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN']));

create policy user_account_permissions_select_own
  on public.user_account_permissions for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_account_access(ml_account_id)
  );

create policy user_account_permissions_admin_writes
  on public.user_account_permissions for all to authenticated
  using (
    exists (
      select 1 from public.ml_accounts a
      where a.id = user_account_permissions.ml_account_id
        and private.is_member_of(a.organization_id)
        and private.has_role(array['ADMIN'])
    )
  )
  with check (
    exists (
      select 1 from public.ml_accounts a
      where a.id = user_account_permissions.ml_account_id
        and private.is_member_of(a.organization_id)
        and private.has_role(array['ADMIN'])
    )
  );

-- `ml_credentials` e `ml_oauth_states` ficam SEM POLICY NENHUMA, como a
-- `job_runs`. Nao ha caso de uso em que o navegador precise ler um token ou um
-- state de OAuth — e a policy que nao existe e a que nao pode ser escrita
-- errado.

-- ============================================================
-- 7. GRANTs
--
-- Privilegio de tabela e avaliado ANTES da policy (docs/DATABASE.md secao 5).
--
-- `ml_credentials` e `ml_oauth_states` NAO recebem grant nem para
-- `authenticated`: sao inalcancaveis pela Data API, em qualquer cenario.
-- ============================================================

grant select, insert, update, delete on public.ml_accounts to authenticated;
grant select, insert, update, delete on public.user_account_permissions to authenticated;

grant select, insert, update, delete
  on public.ml_accounts, public.ml_credentials,
     public.ml_oauth_states, public.user_account_permissions
  to service_role;

revoke all on public.ml_accounts from anon;
revoke all on public.ml_credentials from anon, authenticated;
revoke all on public.ml_oauth_states from anon, authenticated;
revoke all on public.user_account_permissions from anon;
