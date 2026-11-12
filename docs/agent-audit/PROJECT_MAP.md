# Mapa do Speed Bikers Gestão V3

Base da inspeção em 11/11/2026 · `origin/main` em `d6169205ca0ea51d615d2e70cd0b944b5c491adb`. A `main` remota contém a V3 e publica a web na Vercel. A V2 histórica está em `v2-legacy` e na tag `v2-final`.

## Navegação

| Pergunta | Onde começar |
|---|---|
| Onde uma tela lê ou altera dados? | [Rotas e páginas](ROUTES_AND_PAGES.md) |
| Que pacote ou serviço resolve cada etapa? | [Dependências](DEPENDENCY_GRAPH.md) |
| Qual entrada dispara o processamento e quem consome? | [API, webhooks e jobs](API_AND_JOBS_MAP.md) |
| Qual tabela, RPC, trigger ou policy participa? | [Banco](DATABASE_MAP.md) |
| Que mudanças ficaram abertas e como retomar? | [Achados](FINDINGS.md) · [Plano](PLAN.md) · [Sessão](SESSION_LOG.md) |
| Que referências podem ser limpas? | [Branches](BRANCH_AUDIT.md) · [Candidatos](CLEANUP_CANDIDATES.md) |

## Cobertura da primeira sessão

O inventário percorreu a árvore Git autoral de `apps`, `packages`, `infra`, `scripts`, `.github` e `supabase` (1.411 arquivos rastreados). A árvore contém três apps, oito packages, 58 páginas App Router, 11 route handlers, 54 specs Playwright e 305 migrations. A análise em profundidade priorizou dependências, segurança dos webhooks, OAuth multicanal, consistência dos jobs, Supabase e branches. Os mapas indicam onde a cobertura é estática ou depende de confirmação operacional.

Na continuidade de 12/11, as mudanças em OAuth, renovação de credenciais e SAC foram atualizadas nos mapas de API e banco. A branch de auditoria passou a ter 310 migrations e o worker passou a reconhecer a versão protegida do job de resposta. O callback do Mercado Livre em `apps/api/src/ml-accounts.ts` passou a preservar contas conectadas diante de falhas de outra autorização (D-662).

## Como atualizar

1. Confira o [handoff](../HANDOFF.md) e o SHA atual.
2. Use `git diff --name-status <sha-do-mapa>..HEAD -- apps packages supabase infra .github` para localizar a área alterada.
3. Valide o caminho desde a rota ou evento até o consumidor e o teste. Atualize a parte do mapa afetada e registre a revisão verificada.
4. Consulte [Arquitetura](../ARCHITECTURE.md), [Testes](../TESTING.md) e os contratos de cada domínio para regras e histórico.
