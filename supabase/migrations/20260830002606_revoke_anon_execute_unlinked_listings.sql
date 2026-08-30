-- `get_unlinked_listings` era a UNICA RPC de negocio executavel por `anon`
-- (D-141). Todas as outras fazem `revoke all ... from public, anon` no fim da
-- propria migration; a de D-122 (`20260828183728`) nao fez.
--
-- Exposicao pratica MEDIDA antes de corrigir: NULA. A funcao e `security
-- invoker` e `anon` nao tem SELECT em nenhuma tabela de `public` -- medido:
-- zero linhas com privilegio, RLS ligada em todas --, entao a chamada morre em
-- permission denied. Nao e vulnerabilidade: e superficie desnecessaria,
-- exatamente o argumento que D-066 usou ao revogar 23 tabelas cuja RLS ja
-- protegia.
--
-- Passou a valer a pena fechar porque o repositorio virou PUBLICO em
-- 2026-08-29, e com ele a chave publicavel e o ref do projeto
-- (`infra/lib.sh`). A defesa deixou de ter a camada de obscuridade.
--
-- Achado no mesmo levantamento, e vale como registro do que NAO foi encontrado:
-- nenhuma tabela de `public` concede SELECT ou INSERT a `anon`, e todas tem RLS
-- habilitada. Abrir o repositorio nao expos dado.

revoke all on function public.get_unlinked_listings(uuid, text, integer, integer) from public, anon;
