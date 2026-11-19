# Handoff Gemini ↔ Codex Sentinel (`2026-11-19`)

Checkpoint das entregas do **Gemini Sentinel** em colaboração ativa com o **Codex Sentinel**. Nenhuma branch anterior do Codex (`codex/*`), da `main`, da `v3` ou da frente do Claude Code foi apagada ou reescrita; todo o trabalho do Gemini permanece isolado na branch `agent/gemini-sentinel` e publicado em PR de rascunho no GitHub para revisão cruzada e integração limpa.

## 1. Git, branch, worktree e coordenação de equipe

| Item | Estado verificado |
|---|---|
| **Base sincronizada (FF)** | `codex/sentinel-db-331-20261119` (`e0bedddf`), incorporando linearmente `origin/main` (`1ff173ca`, PRs `#328`/`#332`/`#333`/`#334`/`#335`), a rodada inicial do Gemini (`D-732..D-746`) e os avanços do Codex (`D-747..D-759`, `D-767..D-769`) |
| **Branch Gemini** | `agent/gemini-sentinel` (`872d9079..f3ae0df6` + checkpoint documental) |
| **Worktree Gemini** | `C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2\.worktrees\gemini-sentinel` |
| **PRs abertos do Codex (coordenação)** | `#336` (`codex/sentinel-policy-20261119`, `b552bfd6`, já incorpora Gemini até `29ec52a1` / `D-770..D-775` + `#337` da `main` e renumera índice Full para `D-790`), `#338` (`codex/sentinel-clean-lint`, `d73cd20c`), `#339` (`codex/sentinel-log-envelope`, `4537e3aa` — aponta adoção preferencial de `D-779`), `#340` (`codex/sentinel-docker-ports`, `43dcbf40`) |
| **Convenção de IDs `D-xxx`** | `D-767` preservado para invoice do Claude (`#337` na `main` em `b3099724`); `D-790` reservado pelo Codex no `#336` para o índice do Full; Gemini usa `D-770..D-779` e faixa `D-780..D-789` nas próximas entregas independentes |
| **Branches Codex / raiz (intocadas)** | `codex/sentinel-audit` (`e524f346`), `codex/sentinel-integration-20261119` (`f5df5ab4`), `codex/sentinel-db-331-20261119` (`e0bedddf`), worktree `.codex/worktrees/sentinel-speedbikers-20261111` e pasta raiz em `v3` (`9642d921`) intocadas |
| **Remotos / `main`** | `origin/main` avançou para `b3099724` (`#337` + `#341` do Claude); Gemini publica **somente** `origin/agent/gemini-sentinel` (PR Draft), sem merge na `main` nem escrita em Dev/Prod |

### Respeito à frente reservada ao Claude Code e às tarefas do Codex

- **Claude Code:** nenhum arquivo de `/compras`, `/reposicao`, pedidos de importação/invoices (`#337`/`#341`), análise de compras, recebimento/estoque em trânsito, `fornecedores/[supplierId]/produtos-fornecidos.tsx`, migrations `20261117100000*–120000*` / `20261118210000*–211000*` / `20261119120000*`, worktrees ou branches do Claude foi alterado.
- **Codex Sentinel:** nenhum arquivo tocado nos PRs abertos `#338` (`turbo.json`), `#340` (`scripts/isolate-supabase.mjs`) ou nas branches `codex/*` foi modificado; em `#339` (`packages/observability/src/logger.ts`), `D-779` (`f3ae0df6`) já estava commitado antes da abertura do `#339` e o próprio Codex registrou preferência pela adoção de `D-779`.

## 2. Commits entregues sobre `e0bedddf` (`872d9079..f3ae0df6`)

Os 18 commits da rodada inicial do Gemini (`679cd74d..58fc91fb`, `D-732..D-746`) já foram incorporados em `codex/sentinel-audit` (`e524f346`) e `codex/sentinel-db-331-20261119` (`e0bedddf`), e `D-770..D-775` (`872d9079..29ec52a1`) já foram incorporados pelo Codex no PR `#336`. Abaixo estão todas as dez fatias de código entregues em `agent/gemini-sentinel` (sendo `D-776..D-779` novas sobre `29ec52a1`):

| Commit | Decisão / Achado | Escopo e correção |
|---|---|---|
| `872d9079` | `D-770` / `A110` | **API — Edição de itens de NF-e e Saída Manual (`D-766`):** `document-items.ts` separa erro transitório de banco (`status: "failed"`, HTTP 500) de ausência real (`not_found`, HTTP 404) e exige `.select("id").maybeSingle()` em `DELETE`/`UPDATE` de `document_items` e no `UPDATE` condicional de recontagem em `documents` (`status = 'PARSED'`, devolvendo `rejected` 409 em corrida); `manual-exit.ts` fatia `.in("id", lote)` em lotes paralelos de `100` UUIDs; `app.ts` exige `/^\d+$/` em `:itemId`. Reproduzido (`7 failed | 126 passed (133)`). *(Já no `#336`.)* |
| `7f71c63d` | `D-771` / `A111` | **Web — Saída Manual e edição de item da NF-e (`D-766`):** fecha `getSession()` sem proteção em `saida-manual-form.tsx` e `item-quantity.tsx` via `lerTokenDeSessao`; valida JSON em `200 OK`; fatia `.in()` em lotes paralelos de `100` em saldos/importação/detalhe; protege transporte em `try/catch/finally`, eleva importação até `1.000` chaves distintas sem falso erro de SKU inexistente e protege `Enter`/`Escape`. +3 contratos (`saida-manual.test.ts`) + regressão E2E `D-771` em `e2e/nota-fiscal.spec.ts`. *(Já no `#336`.)* |
| `9646d3e8` | `D-772` / `A112` | **Worker — Estoque Shopee, catálogo ML e trava de hidratação Shopee:** `shopee-stock.ts` pagina `shopee_order_items` e `stock_movements` além de 1.000 linhas via `readAllPages` e fatia `.in()` em `100` UUIDs / `200` pedidos; `ml-listings-fetch.ts` fatia `inexistentes` e `itemIds` em `200`; `shopee-items-hydrate.ts` move `soltar()` para `finally` com log `shopee_items_hydrate_unlock_failed`. Reproduzido (`5 failed | 51 passed (56)`). *(Já no `#336`.)* |
| `3de8774f` | Checkpoint Docs | Checkpoint documental intermediário (`D-770..D-772`, `401/401` E2E). *(Já no `#336`.)* |
| `61047db1` | `D-773` / `A113` | **Marketplaces — Clientes HTTP (`@sb/shopee`, `@sb/tiktok-shop`, `@sb/mercado-livre`):** HTTP `200` com HTML/corpo não-JSON (proxy/CDN) lança `ShopeeApiError`/`TikTokShopApiError` com `errorClass: "retryable"` em vez de `ZodError`/`not_retryable`; parâmetros de query nunca sobrescrevem credenciais/assinatura; cliente ML cancela `response.body` antes do retry em `429`/`5xx`. Reproduzido (`5 failed | 43 passed (48)`). *(Já no `#336`.)* |
| `07c06d94` | `D-774` / `A114` | **Web — 7 rotas de exportação + CSV OWASP:** `/anuncios/exportar`, `/curva-abc/export/xlsx` e `/precos/export/xlsx` falham fechado com HTTP `502` quando `ml_accounts`/`marketplace_accounts` falha; todas as rotas CSV devolvem `503` em erro de `get_current_membership` em vez de `403`; `csvCell` neutraliza fórmulas precedidas por espaço, tab ou CR (`/^[\t\r ]*[=+\-@]|^[\t\r]/`). Reproduzido (`5 failed | 5 passed (10)`). *(Já no `#336`.)* |
| `73f886e3` | `D-775` / `A115` | **Segurança API + Worker — Auth multi-org, OIDC `email_verified` e unlock Shopee:** `apps/api/src/auth.ts` lê `.limit(2)`, recusa 2+ organizações (`403`), devolve `503` em erro do banco ou 5xx/rede do Auth e rejeita Bearer inválido; `apps/api/src/oidc.ts` exige `email_verified === true` e Bearer estrito (`/^\S+$/`); `apps/worker/src/handlers/shopee-orders-sync.ts` protege o unlock no `finally` com `try/catch`. Reproduzido (`6 failed | 17 passed (23)`). *(Já no `#336`.)* |
| `29ec52a1` | Checkpoint Docs | Checkpoint documental (`D-773..D-775`, `401/401` E2E). *(Já no `#336`.)* |
| `8b37d676` | `D-776` / `A116` | **Worker Performance + HTTP 414 no Full (`ml-fulfillment-fetch.ts`):** elimina `.in("inventory_id", inventories)` sem lote (contas reais têm 1.640–2.012 vínculos) e elimina a varredura de todo o histórico de `fulfillment_stock_snapshots` (346.394 linhas na VM) por `readAllPages` com ordenação não determinística; `readPreviousSnapshots` fatia em lotes de `100`, consulta janela recente de 48 h (`captured_at DESC, inventory_id ASC`) com parada antecipada quando o lote resolve e faz fallback pontual com concorrência `10` (`.limit(1).maybeSingle()` no índice único) falhando fechado em erro de banco. Reproduzido (`4 failed | 43 passed (47)`). *(Novo pós-`#336`.)* |
| `6e7f2d41` | `D-777` / `A117` | **API — Backfills internos, `erroInterno` em D-766 e callback Shopee (`app.ts`, `order-financials-backfill.ts`, `order-user-products-backfill.ts`):** backfills passam a retornar `failed: true` + HTTP `503` via `respostaDoAgendador` em erro de `ml_accounts`; rotas `/v1/nfe-imports/:id/items/:itemId` e `/v1/stock/manual-exits` usam `erroInterno()` no ramo `failed` (gerando `request_id` e log `request_internal_error`); `/oauth/shopee/callback` exige `Number.isSafeInteger(n) && n > 0` para `shop_id`/`main_account_id`. Reproduzido (`7 failed | 115 passed (122)`). *(Novo pós-`#336`.)* |
| `1946a22e` | `D-778` / `A118` | **Web — Autorização em `claimAction`, fail-closed em Server Actions e escape ILIKE:** `claimAction(id)` passa a derivar o responsável estritamente de `supabase.auth.getUser()` no servidor (impedindo atribuir ações a terceiros via `userId` do cliente); `acoes/page.tsx` separa erro de `membership` com `role="alert"`; `assignToMe` falha fechado em erro de leitura prévia; 6 arquivos de Server Actions separam erro de banco de falta de sessão/SKU e deixam de vazar `error.message` do Postgres; `escaparIlike` protege busca por SKU em `/atendimento` e `contaIndisponivel` impede ignorar filtro `?account=` quando `ml_accounts` falha. Reproduzido (`6 failed (6)`). *(Novo pós-`#336`.)* |
| `f3ae0df6` | `D-779` / `A119` | **Observability — Logger blindado (`packages/observability/src/logger.ts`):** redige segredos também no campo principal `message` (`redactSecretText(message, "[REDACTED]")`), protege referências cíclicas com `WeakSet` de ancestrais (`"[Circular]"`, preservando DAGs compartilhados sem `RangeError`), serializa e redige instâncias de `Error` em qualquer profundidade (`name`, `message`, `stack`, `cause`) e converte `Date` para ISO string. Reproduzido (`3 failed | 35 passed (38)`). *(Superconjunto de `#339`, conforme nota do Codex no PR.)* |

## 3. Verificação completa executada após o último código (`f3ae0df6`)

- **Integração (`@sb/db` + PostgreSQL isolado `127.0.0.1:56421/56422`):** `supabase db reset --no-seed` aplicou todas as **326 migrations**; **16 arquivos / 1.213 testes passaram** (`test:integration`).
- **Embeds PostgREST (`@sb/db run check:embeds`):** **39 projeções com embed, todas aceitas**.
- **Check completo (`pnpm run check`):** **37/37 tarefas passaram** (**339 arquivos / 4.250 testes unitários**): `@sb/web` 149/1.562, `@sb/worker` 68/1.097, `@sb/domain` 46/738, `@sb/api` 43/566, `@sb/mercado-livre` 14/162, `@sb/shopee` 8/38, `@sb/observability` 3/38, `@sb/db` 6/28, `@sb/tiktok-shop` 1/11, `@sb/contracts` 1/10.
- **Build (`pnpm run build`):** **10/10 tarefas passaram** (`Next.js 16.4.6`).
- **7 guardas estáticas de `@sb/web`:** `check:waterfalls` (115), `check:server-actions` (27), `check:table-styles` (52), `check:control-styles` (542), `check:loading` (59), `check:navegacao-suave` (206) e `check:settings-vocabulary` (17 termos / 11 telas) — todos aprovados.
- **Auditoria de dependências (`pnpm audit --prod --audit-level high`):** saída `0` (`1` moderado transitivo em `uuid`).
- **Documentação (`pnpm docs:check`):** aprovada (`681` decisões únicas `D-001`–`D-779` em `docs/DECISIONS_INDEX.md`, `HANDOFF.md` dentro do budget de 25 KB).
- **Playwright E2E completo (`pnpm --filter @sb/web run e2e` em `:3000` após `db reset --no-seed` + `e2e:seed`):** **401 de 401 passaram (15.9m)** nos projetos `chromium` e `loja-live` (zero falhas, zero skips).
- **Progresso de fechamento (`node scripts/report-closure-progress.mjs`):** **137/226 pontos = 60,6% (24/43 entregas = 55,8%)**, restando **39,4% (89/226 pontos / 19 entregas)** nos gates externos e de publicação.

## 4. Stack Supabase local isolada e armadilhas desta máquina

- Stack isolada (`project_id = "sb-gemini-sentinel"`): `C:\Users\usuario\.gemini\antigravity\brain\d84e98cb-78a0-4959-aec4-676b69410daa\scratch\sb-gemini` (APIs em `56421`, Postgres em `56422`, `supabase/migrations` ligada por NTFS junction à worktree — **não versionada no Git**, parada ao final da rodada).
- Armadilhas confirmadas neste Windows:
  1. Processo externo (`gmaps-ui-pt`) escuta em `127.0.0.1:8080` → sempre exportar `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080` antes de `@sb/web` build/E2E.
  2. Playwright E2E precisa rodar na porta padrão `3000` (`E2E_BASE_URL=http://127.0.0.1:3000`) porque `site_url` do Auth redireciona links de convite para `:3000`.
  3. `apps/web/lib/supabase/server.ts` lê `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (além de `NEXT_PUBLIC_SUPABASE_ANON_KEY`): sem ela o `next start` do Playwright falha com timeout. Exportar também `DB_URL`, `SUPABASE_DB_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
  4. Sempre rodar `supabase db reset --no-seed` entre `test:integration` e `e2e:seed` (`auth.users.confirmation_token`) e nunca rodar `eslint`/`build` em paralelo com E2E/`test:integration`.

## 5. Como o Codex Sentinel pode incorporar e próximos passos reservados

```bash
# Commits novos do Gemini pós-29ec52a1 (já incorporado no #336):
git log --oneline 29ec52a1..agent/gemini-sentinel

# Incorporação seletiva de D-776..D-779 em codex/sentinel-policy-20261119 (#336):
git cherry-pick 8b37d676 6e7f2d41 1946a22e f3ae0df6
```

- **Próximas fatias independentes reservadas pelo Gemini (fora dos arquivos do Codex e do Claude):**
  1. Auditoria e correção de falhas silenciosas em handlers do worker (`ml-listing-visits-fetch.ts` / `sync-listing-visits-snapshot.ts` e análise de código dos retornos `403` em lote de anúncios ML em `sync-listing-item.ts` / `ml-listings-fetch.ts`).
  2. Migração dos últimos `getSession()` sem proteção em cliente web (`action-card.tsx`, `relist-panel.tsx`, `diagnosis-panel.tsx`) para `lerTokenDeSessao` + validação de payload `200 OK` JSON.
- **Pendências externas / de integração conjunta:**
  1. Reconciliar `#336` com `origin/main` (`b3099724`, `#341`), `#338`, `#340` e `D-776..D-779` (adotando `D-779` no lugar de `#339`).
  2. Quando o Supabase Dev (`nmgccyqquwxecqffsidr`) voltar a ficar ativo: registrar as 4 migrations pendentes da Sentinel (`D-750`, `D-752`, `D-790`, `D-768`) com timestamps definitivos pós-`20261119120000`, regenerar tipos em coordenação com compras e rodar a CI remota do candidato integrado (`V01`).
  3. Atos do dono e ambiente remoto ([STATE_AND_COMPLETION_2026-11-18.md](STATE_AND_COMPLETION_2026-11-18.md)): proteção da branch `main` (`S05`), workflow de migrations para a VM `sb-db` (`I05`), dump recorrente + alerta (`I03`), Monitoring/uptime checks (`I04`), Auth/SMTP (`S04`), benchmark representativo na VM (`P02`), estoque Shopee/TikTok (`M03`/`M04`/`M05`) e deploy coordenado (`migrations -> worker -> API -> web`, `V02`/`V03`).
