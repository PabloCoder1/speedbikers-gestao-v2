-- ============================================================
-- `get_organization_members`: as tres colunas que D-271 recusou por FALTA DE
-- FONTE -- e-mail, ultimo acesso e status do convite.
--
-- D-271 mediu e recusou, com razao para a epoca:
--
--   | o que o frame desenha | existia? |
--   |---|---|
--   | coluna "Ultimo Acesso" | `auth.users.last_sign_in_at`: ZERO colunas e
--   |                        | ZERO funcoes em `public` o alcancavam |
--   | metade "E-mail"        | `profiles` e id, full_name, created_at, updated_at |
--   | coluna "Status"        | sem fluxo de convite, todo membro esta ativo |
--
-- O que mudou nao foi o esquema: foi o PEDIDO. O convite entra nesta mesma
-- fatia (a `api` cria o usuario e o vinculo), e com ele "Status" passa a ter
-- dois valores de verdade -- convidado que ainda nao entrou, e membro ativo.
-- Coluna de valor unico continua sendo ruido; esta deixou de ser de valor
-- unico.
--
-- ------------------------------------------------------------
-- POR QUE UMA FUNCAO, E POR QUE ELA E `security definer`
--
-- `auth.users` nao e alcancavel pela Data API, e isso e desenho da
-- plataforma, nao lacuna: e-mail e carimbo de sessao sao dados de
-- autenticacao. A janela e esta funcao, com tres travas:
--
--   1. **ADMIN DAQUELA organizacao** -- nao "ADMIN de alguma", que e o guard
--      de `get_system_health` (D-209) e cabe la porque aquilo e telemetria de
--      PLATAFORMA. Aqui o dado e do tenant: o guard pergunta pela linha do
--      chamador NA organizacao pedida;
--   2. **so os membros daquela organizacao** entram no resultado -- o join
--      parte de `organization_members`, nunca de `auth.users`;
--   3. **so tres campos** de `auth.users` saem: e-mail, ultimo login e o
--      carimbo de confirmacao. Nada de token, senha, provedores ou metadata.
--
-- `search_path` travado, `revoke` de `public`/`anon` e `grant` explicito, como
-- toda funcao nova desde 20260902194500.
-- ============================================================

create or replace function public.get_organization_members(p_organization_id uuid)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role text,
  member_since timestamptz,
  last_sign_in_at timestamptz,
  invite_accepted boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with guard as (
    -- A autorizacao e refeita aqui dentro, e e sobre ESTA organizacao.
    select exists (
      select 1
      from public.organization_members m
      where m.organization_id = p_organization_id
        and m.user_id = (select auth.uid())
        and m.role = 'ADMIN'
    ) as ok
  )
  select
    m.user_id,
    p.full_name,
    u.email::text,
    m.role,
    m.created_at,
    u.last_sign_in_at,
    -- Convite ACEITO = a pessoa ja entrou alguma vez. `confirmed_at` sozinho
    -- nao serve: com `enable_confirmations = false` ele nasce preenchido no
    -- proprio convite, e a coluna diria "ativo" para quem nunca entrou.
    (u.last_sign_in_at is not null) as invite_accepted
  from guard g
  join public.organization_members m on m.organization_id = p_organization_id
  left join public.profiles p on p.id = m.user_id
  left join auth.users u on u.id = m.user_id
  where g.ok
  order by m.created_at
$$;

comment on function public.get_organization_members(uuid) is
  'Membros da organizacao com os tres campos que vivem em auth.users (e-mail, ultimo login e se o convite foi aceito) -- as colunas que D-271 recusou por falta de fonte e que o convite de D-296 destravou. security definer com autorizacao ADMIN DAQUELA organizacao refeita dentro; o join parte de organization_members, entao ninguem de fora dela aparece.';

revoke all on function public.get_organization_members(uuid) from public, anon;
grant execute on function public.get_organization_members(uuid) to authenticated, service_role;
