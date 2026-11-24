# Speed Bikers Gestão V3

Plataforma interna de operações de e-commerce **multicontas e multicanais** (Mercado Livre, Shopee e integração em evolução com TikTok Shop), organizada em torno de SKUs canônicos, anúncios, pedidos, faturamento, estoque, Full, reposição, compras, fornecedores, atendimento, diagnósticos, notificações e Copiloto.

> **Branch padrão `main` = V3 de produção desde 23/09/2026.** A V2 está preservada em `v2-legacy` / tag `v2-final`. `v3` não é a branch principal atual.

## Arquitetura

| Componente | Execução | Responsabilidade |
|---|---|---|
| `apps/web` | Next.js na Vercel | Interface, SSR e ações rápidas |
| `apps/api` | Hono no Google Cloud Run | Webhooks, OAuth, endpoints e agendamentos |
| `apps/worker` | Hono no Google Cloud Run | Cloud Tasks, sync, reconciliação e jobs |
| `packages/*` | Bibliotecas compartilhadas | DB, domínio, contratos, clients de marketplaces e observabilidade |
| `supabase/` | PostgreSQL/Supabase | Migrations, RLS, RPCs, ledger, Auth e dados |

O UpSeller é fonte ERP relevante para estoque, com regras de reconciliação próprias. O modelo e a disponibilidade dos canais não devem ser presumidos equivalentes.

## Desenvolvimento com agentes

**Comece por `AGENTS.md`.** É o roteador mínimo de contexto para Codex, Claude Code e outros agentes. Use somente a documentação específica de sua tarefa.

- Papéis e responsabilidades: `docs/AGENT_ROLES.md`.
- Agentes nativos do Claude Code: `.claude/agents/` (seleção por domínio).
- Política e princípios: `docs/PROMPT_MASTER.md` (parte do documento é planejamento histórico, não uma ordem para reconstruir o produto).
- Estado documentado: `docs/HANDOFF.md` (validar frescor contra GitHub/infraestrutura).
- Decisões: `docs/DECISIONS_INDEX.md` → trecho de `docs/DECISIONS.md`.
- Infraestrutura e rollout: `docs/DEPLOYMENT.md`.
- Testes: `docs/TESTING.md`.
- Métricas: `docs/METRICS.md`.

Não faça merge em `main` inadvertidamente: o frontend é publicado automaticamente na Vercel. Migrations de produção exigem o workflow com aprovações e deploy da API/worker tem fluxo próprio.

```bash
pnpm install
pnpm run check
pnpm run build
pnpm docs:check
```

Esses checks não substituem integração com banco local, E2E e validação dos serviços reais quando o domínio exigir.
