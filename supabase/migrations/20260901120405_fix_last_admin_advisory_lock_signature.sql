-- ============================================================
-- A trava da guarda do ultimo ADMIN foi escrita com a assinatura errada
-- (D-175).
--
-- `pg_advisory_xact_lock` existe em duas formas: `(bigint)` e
-- `(integer, integer)`. A migration anterior chamou com DOIS `bigint` —
-- `hashtextextended` devolve bigint — e o Postgres so descobre isso em
-- tempo de execucao, porque a funcao e plpgsql: a guarda passou a falhar
-- com "function pg_catalog.pg_advisory_xact_lock(bigint, bigint) does not
-- exist" em vez de proteger.
--
-- **O erro so apareceu porque o teste negativo existe.** Sem ele, a guarda
-- teria ido para producao quebrada e a mensagem de lockout nunca chegaria —
-- o rebaixamento seria recusado por um erro que ninguem entende, ou pior,
-- num caminho sem trava, nao seria recusado.
--
-- Corrigido para a forma de UM argumento, que e o idioma ja usado em
-- 20260821184047 e 20260828215404.
-- ============================================================

create or replace function private.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admins integer;
begin
  if tg_op = 'UPDATE' and (old.role <> 'ADMIN' or new.role = 'ADMIN') then
    return new;
  end if;

  if tg_op = 'DELETE' and old.role <> 'ADMIN' then
    return old;
  end if;

  -- A organizacao inteira esta sendo removida (cascata de `organizations`):
  -- nao ha o que proteger.
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return coalesce(old, new);
  end if;

  -- O proprio usuario esta sendo removido (cascata de `auth.users` ->
  -- `profiles`): idem.
  if tg_op = 'DELETE' and not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return old;
  end if;

  -- Serializa por organizacao: sem isto, duas transacoes simultaneas cada
  -- uma "veem" o outro ADMIN sobrando e as duas passam, zerando os ADMINs.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization_members_last_admin:' || old.organization_id::text, 0)
  );

  select count(*) into v_admins
  from public.organization_members m
  where m.organization_id = old.organization_id
    and m.role = 'ADMIN'
    and m.user_id <> old.user_id;

  if v_admins = 0 then
    raise exception
      'a organizacao ficaria sem nenhum ADMIN: promova outro membro antes de rebaixar ou remover este'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;
