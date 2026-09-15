-- ============================================================
-- D-354 -- /usuarios: foto de perfil, nome editavel pelo ADMIN e suspensao
-- de acesso no historico.
--
-- O pedido do usuario: na tela de Usuarios "so conseguimos criar" -- sem
-- nome, sem foto, sem tirar o acesso de ninguem.
--
-- REMOVER JA EXISTIA NO BANCO, e nao entra aqui: a policy
-- `organization_members_admin_writes` e `for all`, o trigger
-- `guard_last_admin` cobre DELETE e `log_member_access_change` grava
-- `MEMBER_REMOVED`. Faltava so a tela.
--
-- O que o banco NAO tinha, e esta migration acrescenta:
--
--   1. `profiles.avatar_path` -- o CAMINHO da foto no bucket, nunca a URL. A
--      URL depende do projeto (Dev x producao); gravada, ela envelheceria no
--      primeiro restore entre ambientes;
--   2. quem pode editar o perfil de quem: a propria pessoa, como sempre, e
--      agora tambem o ADMIN de uma organizacao da qual ela e membro;
--   3. o bucket `avatars` e as policies de escrita por pasta `<user_id>/`;
--   4. `MEMBER_SUSPENDED` e `MEMBER_REACTIVATED` no historico de acesso. A
--      suspensao em si mora no Auth (`auth.users.banned_until`) e e escrita
--      pela `api`, que tem a chave de service role (D-012);
--   5. `suspended` na janela `get_organization_members` (D-296).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A foto: caminho, com forma travada
-- ------------------------------------------------------------
-- A forma `<uuid>/<nome>.<ext>` e a mesma que as policies do bucket exigem:
-- a pasta e o dono. Um caminho fora dela nao passaria pelo Storage, e tambem
-- nao entra no perfil.
alter table public.profiles
  add column avatar_path text
    constraint profiles_avatar_path_shape check (
      avatar_path is null
      or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(webp|png|jpg|jpeg)$'
    );

comment on column public.profiles.avatar_path is
  'Caminho da foto de perfil no bucket `avatars` (`<user_id>/<arquivo>`), nunca a URL: a URL depende do projeto e envelheceria no banco (D-354). NULL = sem foto, e a tela desenha as iniciais.';

-- ------------------------------------------------------------
-- 2. Quem edita o perfil de quem
-- ------------------------------------------------------------
-- Recebe TEXTO, e nao uuid, porque a policy do Storage passa o nome da pasta
-- (`storage.foldername(name)[1]`), que e texto vindo do cliente. Converter
-- para uuid dentro da policy transformaria um nome de pasta invalido em ERRO
-- de sintaxe, e nao em "nao pode".
--
-- O ADMIN alcanca o perfil de quem divide organizacao com ele, e so: papel e
-- organizacao na MESMA linha, a juncao de `has_org_role` (20260901135046).
create or replace function private.can_edit_profile(target_user text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select auth.uid())::text = target_user, false)
    or exists (
      select 1
      from public.organization_members mine
      join public.organization_members theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = (select auth.uid())
        and mine.role = 'ADMIN'
        and theirs.user_id::text = target_user
    );
$$;

comment on function private.can_edit_profile(text) is
  'A propria pessoa, ou ADMIN de uma organizacao da qual ela e membro, pode editar o perfil (nome e foto) -- D-354. Texto e nao uuid: a policy do Storage passa o nome da pasta, e uuid invalido viraria erro em vez de recusa.';

-- UMA policy de UPDATE, e nao duas: 20260915133738 acabou de consolidar as
-- permissivas duplicadas, e uma segunda aqui traria o aviso de volta.
drop policy profiles_update_self on public.profiles;

create policy profiles_update_self_or_org_admin
  on public.profiles for update to authenticated
  using (private.can_edit_profile(id::text))
  with check (private.can_edit_profile(id::text));

-- ------------------------------------------------------------
-- 3. O bucket
-- ------------------------------------------------------------
-- PUBLICO DE PROPOSITO. A foto aparece no topo de TODA pagina autenticada, e
-- bucket privado exigiria uma URL assinada por render -- uma ida a mais no
-- Shell, que e o waterfall de maior alcance do app (D-195). O caminho leva um
-- uuid aleatorio por envio; quem nao tem o caminho nao acha a foto, e foto de
-- perfil de sistema interno nao e dado sensivel.
--
-- 1 MiB e folga: a tela recorta e reduz para 512x512 antes de enviar (~60 KB
-- em WebP). O limite e a guarda contra quem chame o Storage direto.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Leitura por `authenticated` so para o upload/remocao funcionarem (o Storage
-- confere a linha antes de sobrescrever ou apagar). A foto em si e publica.
create policy avatars_select
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

create policy avatars_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and private.can_edit_profile((storage.foldername(name))[1]));

create policy avatars_update
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and private.can_edit_profile((storage.foldername(name))[1]))
  with check (bucket_id = 'avatars' and private.can_edit_profile((storage.foldername(name))[1]));

create policy avatars_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and private.can_edit_profile((storage.foldername(name))[1]));

-- ------------------------------------------------------------
-- 4. Suspensao no historico de acesso
-- ------------------------------------------------------------
-- O check de `event_type` foi declarado INLINE em 20260901114420, entao o
-- nome dele e o que o Postgres gerou. Procurar pelo catalogo em vez de supor
-- o nome: se a suposicao errasse, o `drop ... if exists` passaria calado e o
-- check velho continuaria recusando os eventos novos -- em producao, no
-- primeiro clique.
do $$
declare
  v_nome text;
begin
  select c.conname
    into v_nome
  from pg_constraint c
  where c.conrelid = 'public.organization_access_events'::regclass
    and c.contype = 'c'
    and c.conname <> 'organization_access_events_role_shape'
    and pg_get_constraintdef(c.oid) like '%MEMBER_ADDED%';

  if v_nome is null then
    raise exception 'check de event_type de organization_access_events nao encontrado';
  end if;

  execute format('alter table public.organization_access_events drop constraint %I', v_nome);
end;
$$;

alter table public.organization_access_events
  add constraint organization_access_events_event_type_check check (event_type in (
    'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED',
    'ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED',
    'MEMBER_SUSPENDED', 'MEMBER_REACTIVATED'
  ));

alter table public.organization_access_events
  drop constraint organization_access_events_role_shape;

alter table public.organization_access_events
  add constraint organization_access_events_role_shape check (
    (event_type = 'MEMBER_ADDED' and new_role is not null and previous_role is null)
    or (event_type = 'MEMBER_ROLE_CHANGED' and new_role is not null and previous_role is not null)
    or (event_type = 'MEMBER_REMOVED' and previous_role is not null and new_role is null)
    or (event_type in ('ACCOUNT_ACCESS_GRANTED', 'ACCOUNT_ACCESS_REVOKED')
        and ml_account_id is not null and previous_role is null and new_role is null)
    -- Suspender nao muda papel nem conta: muda se a pessoa ENTRA.
    or (event_type in ('MEMBER_SUSPENDED', 'MEMBER_REACTIVATED')
        and ml_account_id is null and previous_role is null and new_role is null)
  );

-- ------------------------------------------------------------
-- 5. A janela ganha `suspended`
-- ------------------------------------------------------------
-- DROP e nao `create or replace`: o Postgres nao deixa mudar o tipo de retorno
-- de uma funcao existente. As tres travas de 20260910120000 continuam
-- identicas; o que entra e UM campo a mais de `auth.users`.
drop function public.get_organization_members(uuid);

create function public.get_organization_members(p_organization_id uuid)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role text,
  member_since timestamptz,
  last_sign_in_at timestamptz,
  invite_accepted boolean,
  suspended boolean
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
    -- Convite ACEITO = a pessoa ja entrou alguma vez (20260910120000).
    (u.last_sign_in_at is not null) as invite_accepted,
    -- Suspenso = banido no Auth AGORA. `ban_duration` grava um instante no
    -- futuro; reativar o apaga. Um ban vencido ja nao impede a entrada, e a
    -- coluna nao pode dizer o contrario.
    coalesce(u.banned_until > now(), false) as suspended
  from guard g
  join public.organization_members m on m.organization_id = p_organization_id
  left join public.profiles p on p.id = m.user_id
  left join auth.users u on u.id = m.user_id
  where g.ok
  order by m.created_at
$$;

comment on function public.get_organization_members(uuid) is
  'Membros da organizacao com os campos que vivem em auth.users (e-mail, ultimo login, se o convite foi aceito e, desde D-354, se o acesso esta suspenso). security definer com autorizacao ADMIN DAQUELA organizacao refeita dentro; o join parte de organization_members, entao ninguem de fora dela aparece.';

revoke all on function public.get_organization_members(uuid) from public, anon;
grant execute on function public.get_organization_members(uuid) to authenticated, service_role;
