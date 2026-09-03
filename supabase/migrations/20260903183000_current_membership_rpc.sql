-- ============================================================
-- `get_current_membership()` -- a associacao do usuario logado, em UMA ida
-- (D-234).
--
-- O DEFEITO QUE ISTO CONSERTA, medido e nao suposto. ~25 telas liam
-- `from("organization_members").select(...).maybeSingle()` **sem filtrar por
-- usuario**. Funcionava por acidente de cardinalidade: a policy de SELECT e
-- `organization_id in (private.accessible_orgs())`, ou seja, devolve TODOS os
-- membros da organizacao, e so havia um. Com o segundo membro na mesma
-- organizacao:
--
--   forma antiga     ->  data = null, PGRST116
--   filtrada por uid ->  1 linha
--
-- Com `data` nulo a tela diz "sem organizacao" ou "restrita a ADMIN" **para o
-- proprio ADMIN**. Ou seja: **cadastrar o segundo usuario em `/usuarios`
-- quebrava o produto para todo mundo**. Provado antes de existir codigo novo:
-- por o segundo usuario no seed derrubou 9 dos 19 e2e de uma vez.
--
-- ------------------------------------------------------------
-- POR QUE UMA RPC, E NAO O FILTRO EM JAVASCRIPT
-- ------------------------------------------------------------
-- O conserto obvio e `.eq("user_id", (await getUser()).id)`. Ele funciona --
-- e foi assim que as duas telas de D-232/D-233 sairam --, mas **nao escala
-- para 25 telas**, e a razao esta escrita na propria casa, em
-- `components/shell.tsx`:
--
--   "getUser() revalida o token contra o servidor de Auth e CUSTA UMA IDA
--    INTEIRA. Enfileira-lo nao protegia nada: quem barra a rota e o proxy.ts,
--    que ja chamou getUser() nesta mesma requisicao."
--
-- Filtrar em JS exige o `uid` ANTES da consulta, entao as duas idas ficam em
-- SERIE: `getUser()` -> `select`. Em ~25 telas isso e latencia nova em toda a
-- aplicacao, e e exatamente a fila que `check:waterfalls` existe para pegar.
--
-- Aqui o `uid` ja esta no banco. `(select auth.uid())` resolve dentro da
-- mesma chamada, e o custo volta a ser **uma ida**, igual ao de hoje.
--
-- `security invoker`: a policy `organization_members_select_same_org` continua
-- valendo por cima. O `where user_id = auth.uid()` nao SUBSTITUI a RLS --
-- estreita o que ela ja permitiu, do "todos os membros da minha organizacao"
-- para "a minha linha".
--
-- **Nao e view.** O `public` tem 33 funcoes e ZERO views; introduzir a
-- primeira aqui seria criar um segundo padrao de leitura para economizar
-- nada.
--
-- ------------------------------------------------------------
-- POR QUE DEVOLVE CONJUNTO, E NAO UMA LINHA
-- ------------------------------------------------------------
-- `accessible_orgs()` e um CONJUNTO: multi-organizacao e estruturalmente
-- possivel, mesmo que hoje NENHUM usuario esteja em duas (medido no Dev:
-- 0 de 1). Devolver `setof` e deixar o chamador decidir e o honesto -- um
-- `limit 1` aqui escolheria uma organizacao arbitraria em silencio, que e a
-- mesma classe de erro que esta migration conserta. O ajudante em
-- `lib/membership.ts` trata "mais de uma" como estado NOMEADO, nao como
-- "pegue a primeira".
--
-- `organization_name` vem junto porque o `Shell` precisava dele e o obtinha
-- por embed (`organizations(name)`); com o nome aqui, some um embed.
-- ============================================================

create function public.get_current_membership()
returns table (
  organization_id uuid,
  organization_name text,
  role text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.organization_id, o.name, m.role
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
  order by o.name
$$;

comment on function public.get_current_membership() is
  'A associacao do usuario logado (D-234): organizacao, nome e papel DELE, em uma ida. Substitui o `select organization_members` sem filtro por usuario, que devolvia PGRST116 assim que a organizacao ganhava o segundo membro. Filtra por auth.uid() DENTRO do banco de proposito: fazer isso em JS exigiria getUser() antes da consulta, e as duas idas ficariam em serie. Devolve conjunto: multi-organizacao e possivel e escolher uma em silencio seria o mesmo erro. security invoker -- a policy continua por cima.';

revoke all on function public.get_current_membership() from public, anon;
grant execute on function public.get_current_membership() to authenticated, service_role;
