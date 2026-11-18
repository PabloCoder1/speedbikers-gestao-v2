# Handoff Gemini → Codex Sentinel V2 (`2026-11-18`)

Checkpoint completo das entregas feitas pelo **Gemini Sentinel** enquanto o **Codex Sentinel V2** esteve temporariamente indisponível. Nenhuma branch anterior foi apagada ou reescrita; todo o trabalho está isolado na branch `agent/gemini-sentinel`.

## 1. Git, branch e worktree

| Item | Estado verificado |
|---|---|
| **Base usada** | `codex/sentinel-audit` (`76a27296543899119bb43dd87e1a2c29e1490c5e`), preservada intacta |
| **Branch Gemini** | `agent/gemini-sentinel` (commits `679cd74d..HEAD`) |
| **Worktree Gemini** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2\.worktrees\gemini-sentinel` |
| **Worktree Codex** | `C:\Users\usuario\.codex\worktrees\sentinel-speedbikers-20261111` (intocada) |
| **Pasta raiz original** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2` em `v3` (`9642d921`, intocada) |
| **Remotos / `main`** | `origin/main` em `d6169205`; **sem** push, merge ou deploy em produção/Dev |

### Respeito à frente reservada ao Claude Code

Nenhum arquivo de `/compras`, `/reposicao`, pedidos de importação já realizados, análise de compras, recebimento/estoque em trânsito, migrations `20261117100000*–120000*` / `20261118210000*–211000*`, worktrees (`.claude/worktrees/compras-inteligente`, `.claude/worktrees/pedidos-ja-feitos`, `.claude/worktrees/custo-do-banco`) ou branches do Claude (`feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`) foi alterado.

## 2. Commits entregues nesta etapa (`679cd74d..8af66328` + docs finais)

| Commit | Decisão / Achado | Escopo e correção |
|---|---|---|
| `679cd74d` | `D-732` / `A90` | **Web — Notificações e Preferências:** `updatePreference`, `deletePreference` e `markNotificationRead` passam a exigir retorno da chave afetada (`.select`), recusando zero linhas (RLS / remoção concorrente) sem anunciar sucesso nem revalidar a rota. `PreferenceRow` limpa erro do modal ao cancelar ou fechar via `Esc` (`fecharConfirmacao`). 9 contratos em `notificacoes-resultados.test.ts` + 3 novas regressões E2E. |
| `4c493535` | `D-733` / `A90` | **Web — Sugestões e Atendimento:** `updateSuggestionStatus` passa a exigir `.select("id")` e recusa zero linhas sem revalidar; `SuggestionDetail` recebe `key={selecionada.id}` e envolve `handleStatusChange` em `try/catch/finally`. Os 5 componentes clientes de `/atendimento`, `/atendimento/conhecimento` e `/atendimento/templates` (`TriageCell`, `KnowledgeRow`, `NewKnowledgeForm`, `NewTemplateForm`, `TemplateRow`) tratam rejeições de transporte em `try/catch/finally` preservando campos/confirmações; `TemplateRow` limpa alerta ao cancelar/alternar. 3 contratos em `sugestoes-resultados.test.ts` + novas regressões em `sugestoes.spec.ts`, `conhecimento.spec.ts`, `atendimento.spec.ts` e novo `e2e/templates.spec.ts`. |
| `5e55e5dc` | `D-734` / `A91` | **Worker — ML conta e credencial:** `ml-token.ts` separa erro de banco em `ml_credentials` e na reserva de lock como `retryable: true` (em vez de devolver `retryable: false` / texto de corrida). Helper compartilhado `resolveMlAccountRead` (`apps/worker/src/handlers/ml-account-read.ts`) corrige 10 handlers ML (`webhook-received`, `backfill-orders`, `sync-orders-window`, `sync-ads-campaigns`, `sync-fulfillment-snapshot`, `sync-listings-snapshot`, `sync-listing-visits-snapshot`, `sync-support-claims-reconcile`, `sync-support-messages-reconcile`, `sync-support-questions-reconcile`) para retornar `{ status: "failed", retryable: true }` em erro transitório de `ml_accounts`, preservando `done, 0` apenas quando `data === null` sem erro. 20 testes em `ml-account-read.test.ts` + 3 em `ml-token.test.ts`. |
| `c55ae28d` | `D-735` / `A92` | **API — Confirmação de ERP e NF-e:** Extrai `confirmAndEnqueueApply` (`apps/api/src/confirm-import-apply.ts`) para `confirmApply` (`erp-import.ts`) e `confirmNfeApply` (`nfe-import.ts`). Exige `.select("id").maybeSingle()` na transição `PARSED -> APPLYING` para rejeitar corridas de 0 linhas (409) antes de enfileirar; se `enqueuer.enqueue` falhar, executa compensação condicional (`PARSED`, `applied_by: null`) antes de relançar. +4 testes em `erp-import.test.ts` e `nfe-import.test.ts`. |
| `5b26f5fe` | `D-736` / `A93` | **Worker — Paginação > 1.000 e RPC memoizada:** Extrai `chunk` / `LOOKUP_CHUNK = 200` (`apps/worker/src/chunk.ts`). `erp-import-apply.ts` passa `sku_listing_link_events` (`REMOVED`/`HUMAN`) e `link_candidates` (`OPEN`) para `readAllPages` com `.order("id")`. `measure-decision-outcomes.ts` pagina `action_decisions` e chunks de 200 IDs em `action_outcomes`, fatia `.in` em `actions` por 200, faz upsert em lotes de 500 e memoiza `get_sku_decision_snapshot` por `sku_id` na execução. +4 testes cobrindo 1.250 decisões, 1.350 outcomes, memoização e 1.006 remoções humanas. |
| `8af66328` | `D-737` / `A03` | **Dependências Web — Next.js 16.4.6:** Atualiza `next` de `16.4.1` para `16.4.6` (`apps/web/package.json` + `pnpm-lock.yaml`), fechando `GHSA-mfr8-8qww-v76h` e `GHSA-vc7v-qv4w-wrv8` e eliminando o aborto `SecurityFatalError` no `next build`. Audit `--prod --audit-level high` passa com apenas 1 moderado transitivo residual (`uuid <11.1.1` em `@google-cloud/storage > gaxios` e `exceljs`). |

*(Commit final desta sessão atualiza este handoff e os arquivos de `docs/` após as baterias completas.)*

## 3. Verificação executada após o último código (`8af66328`)

- **Integração (`@sb/db` + PostgreSQL local isolado em `127.0.0.1:56421/56422`):** 11 arquivos / **1.160 testes passaram** (`test:integration` após `supabase db reset`).
- **Embeds PostgREST (`@sb/db run check:embeds`):** **39 projeções com embed, todas aceitas**.
- **Check completo (`pnpm run check` = `turbo run typecheck lint test`):** **37/37 tarefas passaram** (`@sb/web` 139 arquivos / 1.489 testes; `@sb/worker` 68 arquivos / 1.042 testes; `@sb/api` 39 arquivos / 513 testes; `@sb/domain` 43 arquivos / 690 testes; `@sb/mercado-livre` 14 arquivos / 161 testes; `@sb/shopee` 8 arquivos / 36 testes; `@sb/db` 6 arquivos / 28 testes; `@sb/observability` 3 arquivos / 35 testes; `@sb/contracts` 1 arquivo / 10 testes; `@sb/tiktok-shop` 1 arquivo / 10 testes).
- **Build (`pnpm run build`):** **10/10 tarefas passaram** (`Next.js 16.4.6` na primeira tentativa, sem `SecurityFatalError`).
- **7 guardas estáticas de `@sb/web`:** `check:waterfalls`, `check:server-actions`, `check:table-styles`, `check:control-styles`, `check:loading`, `check:navegacao-suave` e `check:settings-vocabulary` passaram.
- **Auditoria de dependências (`pnpm audit --prod --audit-level high`):** saída `0` (`1` moderado em `uuid`).
- **Docs (`pnpm docs:check`):** executado antes e depois da edição documental final.
- **Playwright E2E (`apps/web` contra API offline `http://127.0.0.1:18080`, pois há serviço externo local na `8080` nesta máquina):**
  - Rodada completa (`pnpm --filter @sb/web run e2e`): **371 de 373** no projeto `chromium` passaram (incluindo todas as novas regressões de `notificacoes-preferencias`, `notificacoes`, `sugestoes`, `conhecimento`, `templates` e `atendimento`); **2** casos existentes (`faturamento-multicanal.spec.ts:99` e `sugestoes.spec.ts:122`) expiraram o timeout de 5s sob carga contínua (`Carregando a tela…` e `Enviando…`), pulando os 20 testes dependentes de `loja-live`.
  - Repetição imediatamente após `supabase db reset --no-seed` + `e2e:seed`: `e2e/faturamento-multicanal.spec.ts` + `e2e/sugestoes.spec.ts` passaram **13/13** (33.7s) e `--project loja-live --no-deps` passou **20/20** (55.7s).

## 4. Stack Supabase local isolada e armadilhas desta máquina

- Stack isolada do Gemini (`project_id = "sb-gemini-sentinel"`): `C:\Users\usuario\.gemini\antigravity\brain\d84e98cb-78a0-4959-aec4-676b69410daa\scratch\sb-gemini` (APIs em `56421`, Postgres em `56422`, `supabase/migrations` ligada por NTFS junction à worktree — **não versionada no Git**).
- Armadilhas confirmadas neste ambiente Windows:
  1. Há processo externo (`gmaps-ui-pt`) escutando em `127.0.0.1:8080`. Sempre exportar `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080` antes do `next build` para testes E2E.
  2. `rls-embed-nullability.integration.test.ts` lê `DB_URL`, enquanto os demais testes `@sb/db` leem `SUPABASE_DB_URL`. Exportar ambas apontando para o Postgres isolado (`postgresql://postgres:postgres@127.0.0.1:56422/postgres`).
  3. Sempre rodar `supabase db reset --no-seed` entre `test:integration` e `e2e:seed` (`auth.users.confirmation_token`).

## 5. Como o Codex Sentinel pode retomar e integrar

```bash
# 1. Conferir os commits do Gemini a partir de codex/sentinel-audit
git log --oneline codex/sentinel-audit..agent/gemini-sentinel

# 2. Na worktree do Codex, se desejar incorporar linearmente em codex/sentinel-audit:
git merge --ff-only agent/gemini-sentinel
```

- Antes de descartar a worktree `.worktrees\gemini-sentinel`, pare a stack isolada do Gemini com:
  `pnpm exec supabase stop --workdir "C:\Users\usuario\.gemini\antigravity\brain\d84e98cb-78a0-4959-aec4-676b69410daa\scratch\sb-gemini"`
- **Pendências prioritárias restantes (fora do escopo do Claude):**
  1. Revisão e resolução de colisões (`D-720..D-725`, `D-760..D-764`, ancestralidade de migrations candidatas) antes de integrar PR #330, PR #331 e `codex/sentinel-audit`+`agent/gemini-sentinel`.
  2. Portas externas / atos do dono descritos em [STATE_AND_COMPLETION_2026-11-18.md](STATE_AND_COMPLETION_2026-11-18.md): proteção de branch `main`, pipeline de migrations para VM `sb-db`, restore ensaiado, uptime/alertas Monitoring, SMTP/Auth/reconciliação pós-corte e deploy coordenado (`worker -> API -> web`).
  3. Varreduras adicionais de páginas Web/API menos críticas (ex.: contagem `.length` em `/sugestoes` quando a tabela crescer, paginação preventiva caso alguma lista operacional passe de 1.000 itens).
