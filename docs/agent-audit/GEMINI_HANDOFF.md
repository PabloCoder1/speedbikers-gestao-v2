# Handoff Gemini → Codex Sentinel V2 (`2026-11-19`)

Checkpoint completo das entregas feitas pelo **Gemini Sentinel** enquanto o **Codex Sentinel V2** esteve temporariamente indisponível. Nenhuma branch anterior do Codex, da `main`, da `v3` ou da frente do Claude Code foi apagada ou reescrita; todo o trabalho está linearmente isolado na branch `agent/gemini-sentinel`.

## 1. Git, branch e worktree

| Item | Estado verificado |
|---|---|
| **Base sincronizada (FF)** | `codex/sentinel-db-331-20261119` (`e0bedddf`), incorporando linearmente `origin/main` (`1ff173ca`, PRs `#328`/`#332`/`#333`/`#334`/`#335`), a rodada anterior do Gemini (`679cd74d..58fc91fb`, `D-732..D-746`) e os avanços do Codex (`D-747..D-759`, `D-767..D-769`) |
| **Branch Gemini** | `agent/gemini-sentinel` (`872d9079..73f886e3` + commit final de checkpoint documental) |
| **Worktree Gemini** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2\.worktrees\gemini-sentinel` |
| **Branches Codex (intocadas)** | `codex/sentinel-audit` (`e524f346`), `codex/sentinel-integration-20261119` (`f5df5ab4`), `codex/sentinel-db-331-20261119` (`e0bedddf`); worktree `C:\Users\usuario\.codex\worktrees\sentinel-speedbikers-20261111` intocada |
| **Pasta raiz original** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2` em `v3` (`9642d921`, intocada) |
| **Remotos / `main`** | `origin/main` em `1ff173ca`; **sem** push, merge, escrita remota ou deploy em produção/Dev |

### Respeito à frente reservada ao Claude Code

Nenhum arquivo de `/compras`, `/reposicao`, pedidos de importação já realizados, análise de compras, recebimento/estoque em trânsito, migrations `20261117100000*–120000*` / `20261118210000*–211000*`, worktrees (`.claude/worktrees/compras-inteligente`, `.claude/worktrees/pedidos-ja-feitos`, `.claude/worktrees/custo-do-banco`) ou branches do Claude (`feat/compras-reposicao-inteligente` em `d451cfd9`, `feat/importacoes-pedidos-ja-feitos` em `24c8da20`, `sentinel/custo-do-banco` em `db695e82`) foi alterado.

## 2. Commits entregues sobre `e0bedddf` (`872d9079..73f886e3`)

Os 18 commits da rodada inicial do Gemini (`679cd74d..58fc91fb`, `D-732..D-746`) já foram incorporados pelo Codex em `codex/sentinel-audit` (`e524f346`) e `codex/sentinel-db-331-20261119` (`e0bedddf`). Sobre `e0bedddf`, o Gemini entregou seis fatias reproduzidas pré-correção e validadas integralmente:

| Commit | Decisão / Achado | Escopo e correção |
|---|---|---|
| `872d9079` | `D-770` / `A110` | **API — Edição de itens de NF-e e Saída Manual (`D-766`):** `document-items.ts` separa erro transitório de banco (`status: "failed"`, HTTP 500) de ausência real (`not_found`, HTTP 404) e exige `.select("id").maybeSingle()` em `DELETE`/`UPDATE` de `document_items` e no `UPDATE` condicional de recontagem em `documents` (`status = 'PARSED'`, devolvendo `rejected` 409 em corrida); `manual-exit.ts` fatia `.in("id", lote)` em lotes paralelos de `100` UUIDs; `app.ts` exige `/^\d+$/` em `:itemId`. Reproduzido (`7 failed | 126 passed (133)`). |
| `7f71c63d` | `D-771` / `A111` | **Web — Saída Manual e edição de item da NF-e (`D-766`):** fecha os últimos dois `getSession()` sem proteção em cliente (`saida-manual-form.tsx`, `item-quantity.tsx`) via `lerTokenDeSessao`; valida JSON em `200 OK` (`respostaDeSaidaValida`, `respostaDeEdicaoDeItemValida`); fatia `.in()` em lotes paralelos de `100` em saldos/importação/detalhe; protege transporte em `try/catch/finally`, eleva importação até `1.000` chaves distintas sem falso erro de SKU inexistente e protege `Enter`/`Escape`. +3 contratos (`saida-manual.test.ts`) + regressão E2E `D-771` em `e2e/nota-fiscal.spec.ts`. |
| `9646d3e8` | `D-772` / `A112` | **Worker — Estoque Shopee, catálogo ML e trava de hidratação Shopee:** `shopee-stock.ts` pagina `shopee_order_items` e `stock_movements` além de 1.000 linhas via `readAllPages` (evita reverter SKU/quantidade errados em cancelamentos) e fatia `.in()` em `100` UUIDs / `200` pedidos; `ml-listings-fetch.ts` fatia `inexistentes` e `itemIds` em `200`; `shopee-items-hydrate.ts` move `soltar()` para `finally` com log `shopee_items_hydrate_unlock_failed`. Reproduzido (`5 failed | 51 passed (56)`). |
| `3de8774f` | Checkpoint Docs | Checkpoint documental intermediário (`D-770..D-772`, `401/401` E2E). |
| `61047db1` | `D-773` / `A113` | **Marketplaces — Clientes HTTP (`@sb/shopee`, `@sb/tiktok-shop`, `@sb/mercado-livre`):** HTTP `200` com HTML/corpo não-JSON (proxy/CDN) agora lança `ShopeeApiError`/`TikTokShopApiError` com `errorClass: "retryable"` em vez de `ZodError`/`not_retryable` (impedindo abortar sync e suprimir pedidos/itens Shopee por 24 h como `fora_do_contrato`); parâmetros de query nunca sobrescrevem credenciais/assinatura (`partner_id`, `sign`, `access_token`, `app_key`, `app_secret`); cliente ML cancela `response.body` antes do retry em `429`/`5xx` evitando vazamento de socket keep-alive. Reproduzido (`5 failed | 43 passed (48)`). |
| `07c06d94` | `D-774` / `A114` | **Web — 7 rotas de exportação + CSV OWASP:** `/anuncios/exportar`, `/curva-abc/export/xlsx` e `/precos/export/xlsx` falham fechado com HTTP `502` quando `ml_accounts`/`marketplace_accounts` falha (sem derrubar silenciosamente o filtro de conta nem exportar "Por conta" sem colunas; Curva ABC multicanal também deixa de consultar `ml_accounts` sem uso); todas as rotas CSV devolvem `503` em erro de `get_current_membership` em vez de `403` ("sem organização"); `csvCell` neutraliza fórmulas precedidas por espaço, tab ou CR (`/^[\t\r ]*[=+\-@]|^[\t\r]/`). Reproduzido (`5 failed | 5 passed (10)`). |
| `73f886e3` | `D-775` / `A115` | **Segurança API + Worker — Auth multi-org, OIDC `email_verified` e unlock Shopee:** `apps/api/src/auth.ts` lê `.limit(2)` em `organization_members`, recusa usuário com 2+ organizações (`403`, sem escolha arbitrária), devolve `503` em erro do banco ou 5xx/rede do Auth e rejeita Bearer vazio/com espaços; `apps/api/src/oidc.ts` exige `email_verified === true` e Bearer estrito (`/^\S+$/`); `apps/worker/src/handlers/shopee-orders-sync.ts` protege o unlock no `finally` com `try/catch` para não mascarar erro original nem interromper enfileiramento. Reproduzido (`6 failed | 17 passed (23)`). |

## 3. Verificação completa executada após o último código (`73f886e3`)

- **Integração (`@sb/db` + PostgreSQL isolado `127.0.0.1:56421/56422`):** `supabase db reset --no-seed` aplicou todas as **326 migrations**; **16 arquivos / 1.213 testes passaram** (`test:integration`).
- **Embeds PostgREST (`@sb/db run check:embeds`):** **39 projeções com embed, todas aceitas**.
- **Check completo (`pnpm run check`):** **37/37 tarefas passaram** (**338 arquivos / 4.231 testes unitários**): `@sb/web` 148/1.555, `@sb/worker` 68/1.093, `@sb/api` 43/561, `@sb/domain` 46/738, `@sb/mercado-livre` 14/162, `@sb/shopee` 8/38, `@sb/observability` 3/35, `@sb/db` 6/28, `@sb/tiktok-shop` 1/11, `@sb/contracts` 1/10.
- **Build (`pnpm run build`):** **10/10 tarefas passaram** (`Next.js 16.4.6`).
- **7 guardas estáticas de `@sb/web`:** `check:waterfalls` (115), `check:server-actions` (27), `check:table-styles` (52), `check:control-styles` (542), `check:loading` (59), `check:navegacao-suave` (206) e `check:settings-vocabulary` (17 termos / 11 telas) — todos aprovados.
- **Auditoria de dependências (`pnpm audit --prod --audit-level high`):** saída `0` (`1` moderado transitivo em `uuid`).
- **Documentação (`pnpm docs:check`):** aprovada (`677` decisões únicas em `docs/DECISIONS_INDEX.md`, `HANDOFF.md` dentro do budget de 25 KB).
- **Playwright E2E completo (`pnpm --filter @sb/web run e2e` após `db reset --no-seed` + `e2e:seed`):** **401 de 401 passaram (15.7m)** nos projetos `chromium` e `loja-live` (zero falhas, zero skips).
- **Progresso de fechamento (`node scripts/report-closure-progress.mjs`):** **137/226 pontos = 60,6% (24/43 entregas = 55,8%)**, restando **39,4% (89/226 pontos / 19 entregas)** concentrados nos gates externos e de publicação (Dev pausado para registro de timestamps finais de 4 migrations, CI remota, proteção da `main`, pipeline de migrations na VM `sb-db`, backup/restore recorrente, Monitoring, SMTP/Auth, `P02` na VM, estoque Shopee/TikTok e aceite pós-deploy).

## 4. Stack Supabase local isolada e armadilhas desta máquina

- Stack isolada (`project_id = "sb-gemini-sentinel"`): `C:\Users\usuario\.gemini\antigravity\brain\d84e98cb-78a0-4959-aec4-676b69410daa\scratch\sb-gemini` (APIs em `56421`, Postgres em `56422`, `supabase/migrations` ligada por NTFS junction à worktree — **não versionada no Git**, parada ao final da rodada).
- Armadilhas confirmadas neste Windows:
  1. Processo externo (`gmaps-ui-pt`) escuta em `127.0.0.1:8080` → sempre exportar `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080` antes de `@sb/web` build/E2E.
  2. `apps/web/lib/supabase/server.ts` lê `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (além de `NEXT_PUBLIC_SUPABASE_ANON_KEY`): sem ela o `next start` do Playwright falha com timeout. Exportar também `DB_URL`, `SUPABASE_DB_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
  3. Sempre rodar `supabase db reset --no-seed` entre `test:integration` e `e2e:seed` (`auth.users.confirmation_token`).
  4. Nunca rodar `eslint`/`build` do monorepo em paralelo com o Playwright E2E ou `test:integration` na mesma worktree/DB.

## 5. Como o Codex Sentinel pode retomar e integrar

```bash
# 1. Conferir os commits do Gemini sobre codex/sentinel-db-331-20261119 (e0bedddf)
git log --oneline codex/sentinel-db-331-20261119..agent/gemini-sentinel

# 2. Na worktree do Codex, incorporar linearmente em codex/sentinel-db-331-20261119 (ou nova branch candidata):
git merge --ff-only agent/gemini-sentinel
```

- **Pendências restantes (fora do escopo do Claude):**
  1. Quando o Supabase Dev (`nmgccyqquwxecqffsidr`) voltar a ficar ativo: registrar as 4 migrations pendentes da Sentinel (`D-750`, `D-752`, `D-767`, `D-768`) com timestamps definitivos pós-`20261118211000` (conforme `D-769`), regenerar tipos em coordenação com compras e rodar a CI remota do candidato integrado (`V01`).
  2. Atos do dono e ambiente remoto ([STATE_AND_COMPLETION_2026-11-18.md](STATE_AND_COMPLETION_2026-11-18.md)): proteção da branch `main` (`S05`), workflow de migrations para a VM `sb-db` (`I05`), dump recorrente + alerta (`I03`), Monitoring/uptime checks (`I04`), Auth/SMTP (`S04`), benchmark representativo na VM (`P02`), estoque Shopee/TikTok (`M03`/`M04`/`M05`) e deploy coordenado (`migrations -> worker -> API -> web`, `V02`/`V03`).
