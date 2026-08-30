-- Tres defeitos que a CI revelou ao voltar depois de 17 commits sem esteira
-- (D-142). Nenhum aparecia no `check` local: `packages/db` exclui
-- `*.integration.test.ts` do script `test` por construcao.
--
-- 1. `/produtos` ESTAVA QUEBRADA. `current_date` e palavra reservada do SQL,
--    nao funcao: `pg_catalog.current_date` e parseado como `tabela.coluna` e
--    estoura "missing FROM-clause entry for table pg_catalog". A qualificacao
--    veio de aplicar mecanicamente a regra do `search_path = ''`, que vale
--    para funcoes e nao para palavras reservadas. Nunca falhou antes porque o
--    erro so dispara DEPOIS do guarda de permissao, e a tela nunca foi aberta
--    como ADMIN -- exatamente a verificacao que D-133 declarou pendente ("a
--    tela nao foi vista no navegador").
--
--    O arquivo de origem (`20260828215404`) tambem foi corrigido, para o
--    Postgres local da CI, que reconstroi do zero. Este bloco e IDEMPOTENTE
--    (`if ... like`): num rebuild com o arquivo ja corrigido ele nao faz
--    nada; no Dev remoto, que aplicou a versao com o defeito, ele conserta.
--    Reescreve a definicao REAL da funcao lida do catalogo, trocando apenas o
--    trecho quebrado -- nada e reinventado.
do $fix$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_sku_curation';

  if v_def like '%pg_catalog.current_date%' then
    execute replace(v_def, 'pg_catalog.current_date', 'current_date');
  end if;
end $fix$;

-- 2. `profiles` PERDEU O UPDATE em D-130, e a policy `profiles_update_self`
--    ficou morta -- o GRANT e avaliado ANTES da RLS. O comentario da propria
--    migration de D-130 concluia que a escrita legitima era "verdade para
--    UPDATE, e so para ele"; a linha seguinte revogou os tres. "Usuario
--    atualiza o proprio perfil" esteve quebrado de 28/08 ate aqui. INSERT e
--    DELETE seguem revogados: a linha nasce de trigger sobre `auth.users`.
grant update on public.profiles to authenticated;

-- 3. `compute_erp_target_balances` foi concedida a `authenticated` por D-132,
--    contra o que o teste da MESMA decisao afirma ("authenticated nao executa
--    -- so service_role, mesmo sendo ADMIN"). O unico chamador e o worker,
--    via service_role. Migration e teste da mesma decisao discordavam, e a CI
--    vermelha escondeu a contradicao por dois dias.
revoke execute on function public.compute_erp_target_balances(uuid) from authenticated;
