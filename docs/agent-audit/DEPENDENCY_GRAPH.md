# Dependências entre módulos e serviços

Referência da topologia · `d6169205`. Os manifests, `Dockerfile`, `infra/` e `.github/workflows/` determinam dependências de execução e build.

| Unidade | Dependências internas de execução | Responsabilidade e entrada |
|---|---|---|
| `@sb/web` | `db`, `domain`, `observability` | Next.js App Router na Vercel. Entradas em `apps/web/app`, sessão/cabeçalhos em `apps/web/proxy.ts`, navegação em `apps/web/components/nav.tsx` |
| `@sb/api` | `contracts`, `db`, `domain`, `mercado-livre`, `observability`, `shopee`, `tiktok-shop` | Hono no Cloud Run. `apps/api/src/app.ts` registra rotas, `index.ts` monta dependências e autenticação. Usa Supabase, Cloud Tasks, Cloud Storage, marketplaces e Anthropic nos fluxos correspondentes |
| `@sb/worker` | `contracts`, `db`, `domain`, `mercado-livre`, `observability`, `shopee` | Cloud Run privado. `apps/worker/src/app.ts` recebe tarefas e `index.ts` monta o registro de handlers |
| `@sb/contracts` | — | Envelopes e contratos Zod compartilhados entre quem enfileira e quem executa |
| `@sb/db` | — | Clientes Supabase, tipos gerados, adaptadores de persistência e utilitários de paginação. Testes de integração também usam `domain` |
| `@sb/domain` | — | Regras puras de estoque, compras, vendas, preço, anúncios e diagnóstico. Casos equivalentes exercitados nas suítes SQL |
| `@sb/mercado-livre`, `@sb/shopee`, `@sb/tiktok-shop` | — | Clientes HTTP, OAuth, validação de payload, assinaturas e testes de contrato por marketplace |
| `@sb/observability` | — | Logs estruturados, redação de valores, métricas de duração e configuração de observabilidade |
| `@sb/config` | — | Configuração de TypeScript e lint usada pelos consumidores em desenvolvimento |

## Fluxos que cruzam serviços

- **Leitura web.** App Router → cliente de sessão em `apps/web/lib/supabase/server.ts` → PostgREST/RPC sob RLS. Server Actions seguem o mesmo caminho ou chamam a API. O cliente em `apps/web/lib/chamar-api.ts` auxilia chamadas do navegador.
- **Sincronização.** Marketplace → webhook da API → `apps/api/src/enqueue.ts` → Cloud Tasks → handler do worker → tabelas e RPCs → projeções lidas pela web. Cloud Scheduler chama a API nos fluxos periódicos.
- **OAuth.** `apps/web/app/(app)/contas` e `configuracoes` → rotas da API → consentimento do marketplace → callback → persistência privilegiada das contas e credenciais.
- **NF-e.** Web → API → Cloud Storage + metadados no Supabase → tarefa de processamento → worker → aplicação de movimentos ao ledger no banco.
- **Deploy.** `main` → Vercel para web. `infra/deploy-cloud-run.sh` e `infra/cloudbuild.yaml` montam API e worker. `ci.yml` valida e tenta aplicar migrations no Dev. `migrations-producao.yml` separa verificação de origem, plano e aplicação com aprovações.

[Mapa de rotas](ROUTES_AND_PAGES.md) · [Mapa da API e jobs](API_AND_JOBS_MAP.md) · [Arquitetura](../ARCHITECTURE.md) · [Deploy](../DEPLOYMENT.md)
