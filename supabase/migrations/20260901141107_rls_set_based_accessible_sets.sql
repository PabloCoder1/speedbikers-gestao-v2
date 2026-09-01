-- ============================================================
-- A RLS deixa de ser avaliada por linha (D-181, P0-F/G da trilha 8B).
--
-- MEDIDO no Dev em 2026-09-01, como usuario autenticado real:
--
--   select count(*) from listings;   -- 5.085 linhas visiveis
--     policy antiga:  186,8 ms / 15.802 buffers
--     policy nova:      4,8 ms /    462 buffers
--
-- **39x mais rapido, 34x menos buffers, mesmo resultado.**
--
-- A causa nao era a funcao ser cara: `has_account_access` faz um `exists`
-- barato. A causa e que ela recebe uma COLUNA e por isso e executada uma vez
-- POR LINHA — 5.085 execucoes para responder uma pergunta que tem 4
-- respostas possiveis (o sistema tem 4 contas). O plano antigo mostrava
-- `Filter: private.has_account_access(ml_account_id)`; o novo mostra
-- `hashed SubPlan` com `rows=4 loops=1`.
--
-- Foi isso que estourou o timeout de `get_listings_dashboard` (P0-G): o
-- `CONTEXT` do erro apontava para dentro de `has_account_access`, e nao para
-- um no de agregacao.
--
-- **A seguranca nao muda.** As funcoes SETOF abaixo devolvem exatamente o
-- conjunto que as escalares respondiam ponto a ponto — mesmo `exists`, mesmo
-- `auth.uid()`, mesma regra de ADMIN e de `user_account_permissions`. O que
-- muda e QUANTAS VEZES a pergunta e feita. O ensaio comparou o md5 do
-- conjunto visivel em 40 tabelas x 4 usuarios do fixture: zero divergencias.
--
-- As versoes escalares CONTINUAM existindo: dentro de uma RPC que valida uma
-- conta especifica (`triage_support_case`, por exemplo) elas sao chamadas
-- uma vez so, e ali sao a forma certa.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Os conjuntos
-- ------------------------------------------------------------
create function private.accessible_accounts()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- Espelho EXATO de `has_account_access`, em forma de conjunto: ADMIN
  -- alcanca todas as contas da organizacao; os demais, as que
  -- `user_account_permissions` conceder.
  select a.id
  from public.ml_accounts a
  join public.organization_members m
    on m.organization_id = a.organization_id
  where m.user_id = (select auth.uid())
    and (
      m.role = 'ADMIN'
      or exists (
        select 1
        from public.user_account_permissions p
        where p.ml_account_id = a.id
          and p.user_id = m.user_id
      )
    );
$$;

comment on function private.accessible_accounts() is
  'Contas que o chamador alcanca, como CONJUNTO (D-181). Mesma regra de `has_account_access`, mas resolvida uma vez por consulta em vez de uma vez por linha: numa policy, a versao escalar recebia uma coluna e virava filtro por linha.';

create function private.accessible_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid());
$$;

comment on function private.accessible_orgs() is
  'Organizacoes das quais o chamador e membro, como CONJUNTO (D-181). Espelho de `is_member_of` para uso em policy.';

-- As policies sao avaliadas com os privilegios de quem consulta.
grant execute on function private.accessible_accounts() to authenticated, service_role;
grant execute on function private.accessible_orgs() to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. As 42 policies
--
-- Reescrita programatica com VERIFICACAO: a substituicao e textual e
-- uniforme, e no fim a migration confere que nenhuma policy ficou com a
-- forma escalar. Fazer as 42 a mao seria mais fragil, nao menos.
-- ------------------------------------------------------------
do $$
declare
  r record;
  novo_qual text;
  novo_check text;
  ddl text;
  migradas integer := 0;
begin
  for r in
    select p.schemaname, p.tablename, p.policyname, p.permissive, p.roles, p.cmd,
           p.qual::text as qual, p.with_check::text as with_check
    from pg_policies p
    where p.schemaname = 'public'
      and (p.qual::text like '%has_account_access%'
        or coalesce(p.with_check::text, '') like '%has_account_access%'
        or p.qual::text like '%is_member_of%'
        or coalesce(p.with_check::text, '') like '%is_member_of%')
  loop
    novo_qual := replace(replace(coalesce(r.qual, ''),
      'private.has_account_access(', 'private.conta_acessivel('),
      'private.is_member_of(', 'private.org_acessivel(');
    novo_check := replace(replace(coalesce(r.with_check, ''),
      'private.has_account_access(', 'private.conta_acessivel('),
      'private.is_member_of(', 'private.org_acessivel(');

    -- Agora troca a chamada escalar pelo teste de pertencimento ao conjunto.
    -- O marcador intermediario existe para nao casar duas vezes.
    novo_qual := regexp_replace(novo_qual,
      'private\.conta_acessivel\(([^()]*)\)', '\1 in (select private.accessible_accounts())', 'g');
    novo_qual := regexp_replace(novo_qual,
      'private\.org_acessivel\(([^()]*)\)', '\1 in (select private.accessible_orgs())', 'g');
    novo_check := regexp_replace(novo_check,
      'private\.conta_acessivel\(([^()]*)\)', '\1 in (select private.accessible_accounts())', 'g');
    novo_check := regexp_replace(novo_check,
      'private\.org_acessivel\(([^()]*)\)', '\1 in (select private.accessible_orgs())', 'g');

    if novo_qual like '%conta_acessivel%' or novo_qual like '%org_acessivel%'
       or novo_check like '%conta_acessivel%' or novo_check like '%org_acessivel%' then
      raise exception 'D-181: nao consegui reescrever %.% — chamada com parenteses aninhados', r.tablename, r.policyname;
    end if;

    ddl := format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute ddl;

    ddl := format('create policy %I on public.%I as %s for %s to %s',
      r.policyname, r.tablename,
      case when r.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
      case r.cmd when 'ALL' then 'all' when 'SELECT' then 'select' when 'INSERT' then 'insert'
                 when 'UPDATE' then 'update' else 'delete' end,
      array_to_string(r.roles, ', '));

    if coalesce(novo_qual, '') <> '' then
      ddl := ddl || ' using (' || novo_qual || ')';
    end if;

    if coalesce(novo_check, '') <> '' then
      ddl := ddl || ' with check (' || novo_check || ')';
    end if;

    execute ddl;
    migradas := migradas + 1;
  end loop;

  -- Inventario medido nos DOIS bancos antes de escrever esta migration:
  -- 42 policies sobre 40 tabelas (26 por conta, 17 por organizacao, uma com
  -- os dois predicados). Numero diferente = o banco nao e o que eu medi.
  if migradas <> 42 then
    raise exception 'D-181: migrei % policies, esperava 42 — o banco divergiu do inventario', migradas;
  end if;

  raise notice 'D-181: % policies migradas para a forma de conjunto', migradas;
end $$;

-- ------------------------------------------------------------
-- 3. A prova
-- ------------------------------------------------------------
do $$
declare
  sobraram integer;
begin
  select count(*) into sobraram
  from pg_policies
  where schemaname = 'public'
    and (qual::text like '%has_account_access%' or coalesce(with_check::text, '') like '%has_account_access%'
      or qual::text like '%is_member_of%' or coalesce(with_check::text, '') like '%is_member_of%');

  if sobraram > 0 then
    raise exception 'D-181: % policies ainda avaliam a RLS por linha', sobraram;
  end if;

  -- As funcoes novas sao SECURITY DEFINER: sem `search_path` travado, um
  -- schema no caminho de busca do chamador poderia sequestrar `public.`.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('accessible_accounts', 'accessible_orgs')
      and (p.prosecdef is not true
        or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%')
  ) then
    raise exception 'D-181: funcao de conjunto sem SECURITY DEFINER ou sem search_path travado';
  end if;
end $$;
