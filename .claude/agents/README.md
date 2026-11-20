# Agentes Claude Code — Speed Bikers Gestão V3

Agentes nativos definidos nesta pasta podem ser invocados automaticamente por descrição da tarefa ou selecionados explicitamente por quem coordena a sessão.

| Agente | Foco |
|---|---|
| `sb-arquiteto` | arquitetura, dependências, plano |
| `sb-marketplaces` | OAuth/webhooks/jobs de ML, Shopee, TikTok |
| `sb-dados-estoque` | Supabase/RLS/ledger/UpSeller e SQL |
| `sb-compras-reposicao` | compras, reposição, fornecedores, importação e margem |
| `sb-analytics` | métricas, diagnóstico, Copiloto e rentabilidade |
| `sb-frontend-ux` | Next.js, design system, UX |
| `sb-qa-seguranca` | QA independente, performance e segurança |
| `sb-auditor-infra` | Sentinel, Git/PR, Vercel, Supabase e GCP |

`CLAUDE.md` orienta o agente principal; `AGENTS.md` é o roteador global; `docs/AGENT_ROLES.md` define responsabilidades e limites. Não são 8 serviços ou processos autônomos: são subagentes delegáveis do Claude Code.

Estas instruções **não** provam que os serviços cloud estão ativos. Toda afirmação de estado deve indicar data, fonte e commit/versão.
