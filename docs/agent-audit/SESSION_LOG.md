# Registro de sessão

## 11/11/2026 · Primeira execução

- **Base de trabalho.** `codex/sentinel-audit` em worktree isolada, criada de `origin/main` no commit `d6169205ca0ea51d615d2e70cd0b944b5c491adb`. O checkout original está em `v3`, `9642d921`, com trabalho staged e unstaged de Configurações e SAC.
- **Correções concluídas localmente.** Atualização de Next.js, Zod, Hono, adaptador Node e parser XML nos manifests e no lockfile. Diagnóstico do webhook Shopee com metadados permitidos. Server Actions de Sugestões usando tipos do schema. O [handoff](../HANDOFF.md) registra os incidentes operacionais.
- **Validação.** `pnpm run check` passou com 37 tarefas, `pnpm run build` com 10 e `pnpm docs:check` aprovou o contexto. Os dez documentos e 172 links locais foram conferidos. Instalação, lint e Playwright foram serializados após conflitos na resolução de tipos e nos arquivos temporários do navegador. Teste do webhook passou em 11 casos, incluindo reprodução vermelha e verde. Auditoria de produção passou no corte alto e caiu de nove avisos para dois moderados. As sete guardas estáticas da web e os 38 embeds PostgREST passaram. Smoke tests locais confirmaram o adaptador Hono por HTTP e a leitura de XML de NF-e pelo worker.
- **Banco local.** Replay de 305 migrations em stack exclusiva, 1.135 testes de integração aprovados, reset local separado para o seed do Playwright. A stack de teste foi encerrada. [Catálogo local e limites do remoto](DATABASE_MAP.md).
- **Playwright.** 19 casos de Sugestões, Configurações, login, cabeçalhos, navegação e Web Vitals passaram. O spec de Sugestões repetido com o novo caso de envio e triagem passou em três casos, somando 20 casos distintos cobertos.
- **Branches.** 12 remoções verificadas, 123 preservadas e seis em análise por aliases residuais. `main`, `v3` e `v2-legacy` seguem presentes. [Inventário com SHAs](BRANCH_AUDIT.md)
- **Em aberto.** Recuperação de produção, acesso ao Supabase remoto, proteção da `main`, medição em carga representativa, correção transacional de OAuth e recuperação de respostas pendentes no SAC. [Plano](PLAN.md) · [Achados](FINDINGS.md) · [Candidatos](CLEANUP_CANDIDATES.md)
- **Próxima ação.** Após a reativação pelo responsável, repetir `GET /health` da API, confirmar Scheduler e Tasks e consultar a atividade recente em `job_runs` de produção. A05 pode avançar no Supabase local com um teste que sincronize dois callbacks até a etapa de gravação da mesma loja.

### Skills

| Recurso | Revisão e uso |
|---|---|
| `systematic-debugging`, `verification-before-completion` | Instaladas no perfil Codex a partir de [Superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2), commit `22f0b463e7a5e579904dd6211a520321035526f7`. Depuração por reprodução e verificação com teste |
| `security-review` | Instalada no perfil Codex de [Sentry Skills](https://github.com/getsentry/skills/tree/e94f22214528d69899d09c627b3315ddc3544816/skills/security-review), commit `e94f22214528d69899d09c627b3315ddc3544816`. Rastreio de entradas públicas e dados que chegam ao log |
| `openai-docs`, `skill-installer`, `skill-creator` | Disponíveis no host. Catálogo OpenAI examinado em `49f948faa9258a0c61caceaf225e179651397431`. Instalador local usado com referências fixas, sem executar scripts dos pacotes instalados. As skills instaladas passam a ser descobertas em novos turnos. [Catálogo OpenAI](https://github.com/openai/skills) · [Formato oficial](https://learn.chatgpt.com/docs/build-skills) |
| `supabase`, `supabase-postgres-best-practices` | Já instaladas. Orientaram inspeção de RLS, permissões, catálogo e migrations. [Supabase Database](https://supabase.com/docs/guides/database/overview) · [Changelog](https://supabase.com/changelog.md) |
| `vercel:react-best-practices` | Já disponível no host. A fonte oficial foi conferida em `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`. [Vercel Agent Skills](https://github.com/vercel-labs/agent-skills) |

O mapa, o plano e o registro dão continuidade a esta auditoria. Skills locais serão consideradas se surgir uma rotina que exija instruções reaproveitáveis além dessas fontes.
