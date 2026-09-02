-- ============================================================
-- Conserta um efeito colateral de D-210, e a afirmacao errada que o
-- acompanhou.
--
-- D-210 trocou a policy `ml_accounts_admin_writes` (`for ALL`) por
-- `ml_accounts_admin_inserts` (`for insert`) e registrou: "a policy de SELECT
-- nao muda e nao perde nada -- conferido no catalogo, e mais larga que o
-- predicado da ALL que sai". **A conferencia estava certa para linhas que ja
-- existem e errada para UMA linha: a que esta sendo criada.**
--
-- O QUE QUEBROU, medido: `insert ... returning` em ml_accounts, como ADMIN
-- autenticado, passou a responder
--
--     new row violates row-level security policy for table "ml_accounts"
--
-- enquanto o mesmo insert SEM `returning` continua funcionando.
--
-- POR QUE: com `RETURNING`, o Postgres tambem aplica as policies de SELECT. A
-- unica que restou e `ml_accounts_select_permitted`, cujo predicado e
-- `id in (select private.accessible_accounts())` -- e `accessible_accounts()`
-- e STABLE, entao enxerga o snapshot do INICIO da instrucao, onde a linha
-- recem-inserida AINDA NAO EXISTE. A policy `for ALL` que saiu nao tinha esse
-- problema: o predicado dela le `organization_id` da propria linha nova.
--
-- Reproduzido nos dois sentidos antes de escrever: recriando a policy `ALL`
-- numa transacao revertida, o `returning` volta a funcionar.
--
-- POR QUE NAO E "so um teste chato": `apps/web/app/contas/actions.ts` faz
-- `.insert()` sem `.select()`, entao HOJE nada quebra -- mas esta a um
-- `.select()` de distancia de quebrar, que e o gesto mais natural do mundo
-- (pegar o id da conta recem-criada). O erro que apareceria fala de RLS e nao
-- de RETURNING, e custaria a tarde de alguem.
--
-- A CORRECAO NAO devolve a policy de escrita: o disjunto entra na policy de
-- SELECT, que e onde o buraco esta. Para linhas que JA existem ele nao alarga
-- nada -- `accessible_accounts()` ja devolve todas as contas da organizacao
-- para o ADMIN, e o novo disjunto diz exatamente isso com outras palavras. O
-- que ele acrescenta e o unico caso que a versao em conjunto nao alcanca: a
-- linha que ainda nao esta no snapshot.
--
-- Os testes que provam que nao alargou continuam de pe e sao os de sempre:
-- ANALISTA ve so a conta em que tem permissao; usuario de outra organizacao
-- nao ve nenhuma.
-- ============================================================

drop policy ml_accounts_select_permitted on public.ml_accounts;

create policy ml_accounts_select_permitted on public.ml_accounts
  for select
  to authenticated
  using (
    id in (select private.accessible_accounts())
    or private.has_org_role(organization_id, array['ADMIN'])
  );

comment on policy ml_accounts_select_permitted on public.ml_accounts is
  'Leitura por conta acessivel (conjunto, D-181) OU por papel de ADMIN na organizacao da propria linha. O segundo disjunto e redundante para linhas existentes e OBRIGATORIO para a linha recem-inserida: accessible_accounts() e STABLE e nao a enxerga, o que quebrava insert ... returning depois de D-210.';
