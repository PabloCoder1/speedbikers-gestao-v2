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

Na continuidade de 12/11, as mudanças em OAuth, renovação de credenciais e SAC foram atualizadas nos mapas de API e banco. A branch de auditoria passou a ter 310 migrations e o worker passou a reconhecer a versão protegida do job de resposta. O callback do Mercado Livre passou a preservar contas conectadas diante de falhas de outra autorização (D-662). Perguntas e detalhe do SAC recuperam uma confirmação pendente do autor após recarregar (D-663).

## Cobertura e lacunas por área

| Área | Evidência já disponível | Próxima verificação |
| --- | --- | --- |
| Next.js, páginas, componentes e route handlers | [Rotas](ROUTES_AND_PAGES.md), análise de consumidores, testes web e E2E selecionados. Remoções locais de ações órfãs e casts. | Auditar o uso de cada componente e rota candidata, incluindo links diretos e clientes externos. |
| Hono, workers, filas e sincronização | [API e jobs](API_AND_JOBS_MAP.md). Rotas, webhooks, autorização, handlers e Scheduler declarados. Concorrência e retries testados em OAuth e SAC. | Validar o volume de jobs, falhas e backlog representativos após acesso aos serviços. |
| Mercado Livre, Shopee e TikTok Shop | Callbacks, titularidade e credenciais mapeados. Regressões locais com concorrência. | Validar a revisão publicada e a autorização real de cada marketplace. TikTok mapeado na fatia OAuth disponível. |
| Supabase/PostgreSQL, RPCs, views, triggers, índices e RLS | [Banco](DATABASE_MAP.md), migrations aplicadas localmente, 1.151 testes de integração e 38 embeds. Comparação local de definições de índices. | Conferir catálogo aplicado, dependências e estatísticas reais antes de retirar estruturas. |
| Autenticação, papéis, escopo e segurança | Auth da web e da API mapeados. RLS e escopo por conta exercitados em regressões. Lockfile e entradas públicas inspecionados. D-666 verificou o escopo de plataforma das RPCs de saúde. | Completar a verificação dos papéis em todos os fluxos e conferir regras do ambiente publicado. |
| Chamadas duplicadas, consultas repetidas e N+1 | Auth medido em três renders iniciais. Consulta em lote verificada em OAuth. Perguntas lê só a primeira mensagem por cartão (D-664). O detalhe da conversa lê até 51 por navegação (D-665). A Central compartilha a leitura do período atual. Faturamento, Vendas, Anúncios e Curva ABC antecipam as consultas conforme o recorte. A tela e o CSV compartilham a paginação das séries (D-670 a D-678). | Medir dependências das consultas de Vinculações, a navegação cliente e recortes grandes. |
| Estoque, vendas, faturamento e sincronização | Mapeados de entrada a projeção e consumidor. Revisão de SQL e testes de integração existentes. | Comparar planos, custo e consistência com cardinalidade representativa por canal. |
| Dependências, scripts, agentes, skills e histórico Git | [Dependências](DEPENDENCY_GRAPH.md) e [limpeza](CLEANUP_CANDIDATES.md). Manifests, scripts de CI, 31 worktrees e referências Git cruzados. | Aprofundar consumidores indiretos de código, scripts e skills locais. |
| Testes, pipelines, performance e recursos | Suítes do monorepo, replay de migrations e fluxos Playwright selecionados. CI e gates mapeados. | Verificar checks efetivos em merge, carga e consumo de recursos com o serviço acessível. |

## Como atualizar

1. Confira o [handoff](../HANDOFF.md) e o SHA atual.
2. Use `git diff --name-status <sha-do-mapa>..HEAD -- apps packages supabase infra .github` para localizar a área alterada.
3. Valide o caminho desde a rota ou evento até o consumidor e o teste. Atualize a parte do mapa afetada e registre a revisão verificada.
4. Consulte [Arquitetura](../ARCHITECTURE.md), [Testes](../TESTING.md) e os contratos de cada domínio para regras e histórico.
