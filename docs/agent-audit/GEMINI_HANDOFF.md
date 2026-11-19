# Handoff Gemini → Codex Sentinel V2 (`2026-11-19`)

Checkpoint completo das entregas feitas pelo **Gemini Sentinel** enquanto o **Codex Sentinel V2** esteve temporariamente indisponível. Nenhuma branch anterior foi apagada ou reescrita; todo o trabalho está isolado na branch `agent/gemini-sentinel`.

## 1. Git, branch e worktree

| Item | Estado verificado |
|---|---|
| **Base usada** | `codex/sentinel-audit` (`76a27296543899119bb43dd87e1a2c29e1490c5e`), preservada intacta |
| **Branch Gemini** | `agent/gemini-sentinel` (`679cd74d..048b9774` + commit final de docs) |
| **Worktree Gemini** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2\.worktrees\gemini-sentinel` |
| **Worktree Codex** | `C:\Users\usuario\.codex\worktrees\sentinel-speedbikers-20261111` (intocada) |
| **Pasta raiz original** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2` em `v3` (`9642d921`, intocada) |
| **Remotos / `main`** | `origin/main` em `d6169205`; **sem** push, merge ou deploy em produção/Dev |

### Respeito à frente reservada ao Claude Code

Nenhum arquivo de `/compras`, `/reposicao`, pedidos de importação já realizados, análise de compras, recebimento/estoque em trânsito, migrations `20261117100000*–120000*` / `20261118210000*–211000*`, worktrees (`.claude/worktrees/compras-inteligente`, `.claude/worktrees/pedidos-ja-feitos`, `.claude/worktrees/custo-do-banco`) ou branches do Claude (`feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`) foi alterado.

## 2. Commits entregues (`679cd74d..048b9774` + checkpoints)

| Commit | Decisão / Achado | Escopo e correção |
|---|---|---|
| `679cd74d` | `D-732` / `A90` | **Web — Notificações e Preferências:** `updatePreference`, `deletePreference` e `markNotificationRead` exigem retorno da chave afetada (`.select`), recusando zero linhas sem anunciar sucesso nem revalidar. `PreferenceRow` limpa erro do modal ao cancelar/`Esc` (`fecharConfirmacao`). 9 contratos + 3 E2E. |
| `4c493535` | `D-733` / `A90` | **Web — Sugestões e Atendimento:** `updateSuggestionStatus` exige `.select("id")` e recusa zero linhas sem revalidar; `SuggestionDetail` recebe `key={selecionada.id}` e protege `handleStatusChange`. Cinco componentes de `/atendimento`, `/atendimento/conhecimento` e `/atendimento/templates` tratam transporte em `try/catch/finally`. |
| `5e55e5dc` | `D-734` / `A91` | **Worker — ML conta e credencial:** `ml-token.ts` marca erro de banco/lock como `retryable: true`. Helper `resolveMlAccountRead` (`apps/worker/src/handlers/ml-account-read.ts`) corrige 10 handlers ML para retornar `{ status: "failed", retryable: true }` em erro transitório de `ml_accounts`, preservando `done, 0` só para ausência sem erro. |
| `c55ae28d` | `D-735` / `A92` | **API — Confirmação de ERP e NF-e:** Extrai `confirmAndEnqueueApply` (`apps/api/src/confirm-import-apply.ts`) para `confirmApply` e `confirmNfeApply`, exigindo `.select("id").maybeSingle()` (`PARSED -> APPLYING`, 409 em corrida) e revertendo condicionalmente (`PARSED`, `applied_by: null`) se `enqueuer.enqueue` falhar. |
| `5b26f5fe` | `D-736` / `A93` | **Worker — Paginação > 1.000 e RPC memoizada:** Extrai `chunk` / `LOOKUP_CHUNK = 200` (`apps/worker/src/chunk.ts`); pagina `erp-import-apply.ts` e `measure-decision-outcomes.ts` além de 1.000 linhas com `.order("id")` e memoiza `get_sku_decision_snapshot` por `sku_id`. |
| `8af66328` | `D-737` / `A03` | **Dependências Web — Next.js 16.4.6:** Atualiza `next` para `16.4.6` (`apps/web/package.json` + `pnpm-lock.yaml`), fechando `GHSA-mfr8-8qww-v76h` e `GHSA-vc7v-qv4w-wrv8` e zerando erros altos/críticos em `pnpm audit --prod`. |
| `9c00b2fb` | Checkpoint Docs | Primeiro checkpoint documental Gemini → Codex (`D-732..D-737`). |
| `4747086f` | `D-738` / `A94` | **Worker — Detectores diários > 1.000 e lotes `.in`:** Pagina `get_sku_sales_baseline`, `get_sku_correlated_events`, `get_sku_average_prices` e `support_case_links` em `detect-sales-anomaly-actions.ts` e `detect-support-pattern-actions.ts`, com chunks de 200 (`.in`) e degradação total do sinal de SAC em erro de lote. Reproduzido pré-correção (`4 failed | 19 passed`); `@sb/worker` verde (68 arquivos / 1.048 testes). |
| `2508aa70` | `D-739` / `A94` | **Web — `/diagnostico` paginado > 1.000:** Extrai `apps/web/lib/diagnostico-leitura.ts` (`lerBaselineDoDiagnostico`, `lerEvidenciasDoDiagnostico`, `lerPrecosMediosDoDiagnostico`) reusando `lerPaginasDaRpc` com `{ count: "exact" }` só em `offset === 0` e lotes paralelos `.in` de 200 para SAC. Reproduzido (`4 failed | 1 passed`) e validado (5 novos contratos + `diagnostico.spec.ts`). |
| `92357ea6` | `D-740` / `A95` | **Web — Transporte em ações, painéis e 4 gavetas:** Extrai `useLeituraDeGaveta` (`apps/web/components/drawer.tsx`) para as 4 gavetas de inspeção e envolve chamadas assíncronas em `try/catch/finally` em `action-card.tsx`, `diagnosis-panel.tsx`, `vincular-anuncio.tsx` e `relist-panel.tsx`. Reproduzido em E2E (3 falhas) e validado (40/40 casos selecionados). |
| `fb4a8e1f` | `D-741` / `A95` | **Web — Sessão e JSON em OAuth, SAC e aplicação:** Extrai `lerTokenDeSessao` e `confirmarAplicacaoNaApi` (`apps/web/lib/chamar-api.ts`) e `iniciarConexaoOAuth` (`apps/web/app/(app)/contas/iniciar-conexao.ts`), protegendo `getSession()` e `response.json()` / `authorizationUrl` nos conectores de `/contas`, nos dois `confirm-apply-form.tsx` e no `reply-form.tsx` do SAC. Reproduzido em `e2e/contas.spec.ts` (ML + Shopee com `200 OK` HTML). |
| `ddb5e604` | Checkpoint Docs | Segundo checkpoint documental Gemini → Codex (`D-738..D-741`). |
| `c39f7114` | `D-742` / `A96` | **Worker — `relist.prepare` atômico e retry transitório:** Avalia `evaluateRelistPreflight` antes do `INSERT` (nascendo atomicamente em `PREFLIGHT_FAILED` ou `REQUESTED`, evitando ficar preso em `REQUESTED` após falha de `UPDATE` + `23505`), adiciona guarda prévia contra operação ativa antes de chamar o ML e retorna `retryable: true` para multiget vazio/`429`/`5xx`. Reproduzido pré-correção (`3 failed | 18 passed (21)`). |
| `fec9d87a` | `D-743` / `A97` | **API — Copiloto (regras, SAC, papel e limite SSE):** `runSkuReplenishment` filtra `replenishment_settings` pelos até 3 escopos aplicáveis (`D-680`, sem truncar > 1.000); `structure_feature_suggestion` valida `ADMIN`/`GESTOR` antes de gastar LLM; `runSuggestSupportReply` lê as 40 mensagens mais recentes do SAC (`desc` + `reverse`) e deduplica `skuIds`; `runCopilotChat` não emite `done` após erro de teto de rodadas e protege `emit` desconectado preservando `ai_runs`. Reproduzido pré-correção (`4 failed | 65 passed (69)`). |
| `d8a50aca` | `D-744` / `A98` | **API — Uploads ERP/NF-e, convites e validação de rotas:** `receiveUpload` e `receiveNfeUpload` checam `existing.error !== null` antes do bucket (`status: "error"` -> HTTP 500 `erroInterno`) e compensam falha de `enqueuer.enqueue` (`DELETE ... status='UPLOADED'` ou rollback `UPLOADED -> FAILED` no reenvio NF-e); `inviteOrganizationMember` deduplica `mlAccountIds`/`shopeeShopIds`; `app.ts` valida UUID em `/v1/ml-accounts/connect` e trata `parseBody()` malformado com HTTP 400. Reproduzido pré-correção (`9 failed | 171 passed (180)`). |
| `e6786d2c` | `D-745` / `A99` | **Web — Sessão, SSE EOF e link de convite nos 7 clientes restantes:** Fecha o inventário de `getSession()` sem proteção em `usuarios/convidar.tsx`, `usuarios/reemitir-link.tsx`, `copiloto/chat.tsx`, `sugestoes/suggestion-detail.tsx`, `faturamento/calculadora-preco.tsx`, `importacoes/nova/upload-form.tsx` e `notas-fiscais/nova/upload-form.tsx`; protege `conferirLojas` e valida JSON em `convidar.tsx` preservando `inviteLink`; extrai `extrairEventosSse` (`apps/web/lib/copilot-sse.ts`) com flush EOF/CRLF; +7 contratos unitários (`chamar-api.test.ts`, `copilot-sse.test.ts`). |
| `048b9774` | `D-746` / `A100` | **Worker — Parse/Apply ERP e NF-e:** `erp-import-parse.ts` e `nfe-import-parse.ts` barram `APPLYING` (sem apagar staging/vínculos em reentrega tardia) e verificam erros de `PARSING`/`DELETE`/`PARSED`; `erp-import-apply.ts` verifica erros de `markRows` e do `UPDATE` final `APPLIED`; `nfe-import-apply.ts` pagina `document_items` via `readAllPages` e verifica erro do `UPDATE` final `APPLIED`. Reproduzido pré-correção (`9 failed | 72 passed (81)`). |

## 3. Verificação completa executada após o último código (`048b9774`)

- **Integração (`@sb/db` + PostgreSQL isolado `127.0.0.1:56421/56422`):** `supabase db reset --no-seed`, **11 arquivos / 1.160 testes passaram** (`test:integration`).
- **Embeds PostgREST (`@sb/db run check:embeds`):** **39 projeções com embed, todas aceitas**.
- **Check completo (`pnpm run check`):** **37/37 tarefas passaram** (`@sb/web`: 142 arquivos / 1.501 testes; `@sb/worker`: 68 arquivos / 1.061 testes; `@sb/api`: 39 arquivos / 526 testes; `@sb/domain`: 43 arquivos / 690 testes; `@sb/mercado-livre`: 14 arquivos / 161 testes; `@sb/shopee`: 8 arquivos / 36 testes; `@sb/db`: 6 arquivos / 28 testes; `@sb/observability`: 3 arquivos / 35 testes; `@sb/contracts`: 1 arquivo / 10 testes; `@sb/tiktok-shop`: 1 arquivo / 10 testes).
- **Build (`pnpm run build`):** **10/10 tarefas passaram** (`Next.js 16.4.6`).
- **7 guardas estáticas de `@sb/web`:** `check:waterfalls` (111), `check:server-actions` (26), `check:table-styles` (46), `check:control-styles` (428), `check:loading` (56), `check:navegacao-suave` (193) e `check:settings-vocabulary` (17 termos / 11 telas) — todos aprovados.
- **Auditoria de dependências (`pnpm audit --prod --audit-level high`):** saída `0` (`1` moderado transitivo em `uuid`).
- **Playwright E2E completo (`pnpm --filter @sb/web run e2e` após `db reset` + `e2e:seed`):** **397 de 397 passaram (15.8m)** nos projetos `chromium` e `loja-live` (zero falhas, zero skips).
- **Progresso de fechamento (`node scripts/report-closure-progress.mjs`):** **129/226 pontos = 57,08% (22/43 entregas = 51,16%)**, restando **42,92% (97/226 pontos / 21 entregas)** majoritariamente dependentes de publicação, proteção da `main`, migrations na VM `sb-db`, SMTP/Auth real e validação pós-recuperação.

## 4. Stack Supabase local isolada e armadilhas desta máquina

- Stack isolada (`project_id = "sb-gemini-sentinel"`): `C:\Users\usuario\.gemini\antigravity\brain\d84e98cb-78a0-4959-aec4-676b69410daa\scratch\sb-gemini` (APIs em `56421`, Postgres em `56422`, `supabase/migrations` ligada por NTFS junction à worktree — **não versionada no Git**, parada ao final da rodada).
- Armadilhas confirmadas neste Windows:
  1. Processo externo (`gmaps-ui-pt`) escuta em `127.0.0.1:8080` → sempre exportar `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080` antes de `@sb/web` build/E2E.
  2. `apps/web/lib/supabase/server.ts` lê `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (além de `NEXT_PUBLIC_SUPABASE_ANON_KEY`): sem ela o `next start` do Playwright falha com timeout. Exportar também `DB_URL`, `SUPABASE_DB_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
  3. Sempre rodar `supabase db reset --no-seed` entre `test:integration` e `e2e:seed` (`auth.users.confirmation_token`).
  4. Nunca rodar `eslint`/`build` do monorepo em paralelo com o Playwright E2E na mesma worktree/DB.

## 5. Como o Codex Sentinel pode retomar e integrar

```bash
# 1. Conferir os commits do Gemini a partir de codex/sentinel-audit
git log --oneline codex/sentinel-audit..agent/gemini-sentinel

# 2. Na worktree do Codex, se desejar incorporar linearmente em codex/sentinel-audit:
git merge --ff-only agent/gemini-sentinel
```

- **Pendências restantes (fora do escopo do Claude):**
  1. Revisão integrada de PR #330, PR #331 e `codex/sentinel-audit` + `agent/gemini-sentinel` (colisões `D-720..D-725` / `D-760..D-764` e ordem das 17 migrations candidatas).
  2. Atos do dono e ambiente remoto ([STATE_AND_COMPLETION_2026-11-18.md](STATE_AND_COMPLETION_2026-11-18.md)): proteção da branch `main`, workflow de migrations para VM `sb-db`, backup/restore ensaiado, Monitoring/uptime checks, Auth/SMTP, medição representativa `P02` na VM e deploy coordenado (`worker -> API -> web`).
