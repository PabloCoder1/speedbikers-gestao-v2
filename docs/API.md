# Contratos — web, api e worker

> Dono documental de: fronteiras entre os apps, rotas da `api`, tipos de job, catálogo de eventos e convenções de erro.
> Arquitetura geral em `docs/ARCHITECTURE.md`. Tabelas em `docs/DATABASE.md`.
> Status: **contratos aprovados; rotas e jobs das Fases 1 a 3 implementados conforme as marcações deste documento.** Itens de fases futuras continuam conceituais.

---

## 1. As três regras de fronteira

Resolvem a maioria das dúvidas futuras sem consulta:

1. **Se precisa de um segredo que o usuário não pode ver, não é o `web`.**
2. **Se pode demorar mais que um clique, não é a `api` — é um job.**
3. **Se um humano está esperando na tela, não é o `worker`.**

| | `web` | `api` | `worker` |
|---|---|---|---|
| Leitura de dados | Supabase direto sob RLS | `service_role` | `service_role` |
| Escrita | Server Actions, escopo do usuário, só banco | Comandos privilegiados | Persistência de sync |
| Chama o Mercado Livre | Nunca | Sim (OAuth, comandos pontuais) | Sim (sync) |
| Trabalho longo | Nunca | Nunca — enfileira | Sim, até 15 min |
| Rota pública | Sim | Webhook e OAuth callback | Nenhuma |

---

## 2. Rotas da `api`

Todas as rotas são versionadas sob `/v1`, exceto webhook e callback do OAuth, cujos caminhos são fixados por configuração externa.

### Públicas, com autenticação própria

| Rota | Método | Autenticação | Papel |
|---|---|---|---|
| `/webhooks/mercado-livre` | POST | Validação própria da origem | ACK rápido, grava notificação, enfileira. **Zero chamada de rede.** Desde 2026-08-25 (D-088) o ACK roteia por tópico: `questions` vira `sync.support.questions` com `{ mlAccountId, questionId }`; todo o resto continua em `sync.webhook.received`. Uma regra de dedupe só (`ml-webhook:{resource}:{janela-minuto}`) para os dois. `questions` com `resource` fora de `/questions/{id}` responde 200 sem enfileirar e sai como `ml_webhook_unroutable_resource` no log |
| `/oauth/mercado-livre/callback` | GET | `state` de CSRF | Conclui a autorização da conta — **implementado em 2026-08-21** |

**Regra crítica do webhook:** o caminho é liberado **explicitamente e apenas ele**, com teste negativo nas rotas vizinhas. *Motivo, medido na V2:* o proxy exigia sessão, o webhook não envia cookie, e as notificações de preço, promoção e Full morriam em silêncio num 307 para `/login`.

**Implementado em 2026-08-21** (`apps/api/src/webhook.ts`, `apps/api/src/ip-allowlist.ts`). Contrato de resposta:

| Situação | Status | Corpo |
|---|---|---|
| Origem fora da allowlist de IP (D-043) | 403 | `{ error: { code: "forbidden" } }` |
| Payload não é JSON ou falha o schema | 400 | `{ error: { code: "invalid_payload" } }` |
| `seller_id` sem conta correspondente | 200 | `{ received: true, processed: false }` |
| Sucesso — resolvido e enfileirado | 200 | `{ received: true, processed: true }` |

400 em payload inválido é aceitável mesmo com o reenvio automático do Mercado Livre (até 1h): ou é ruído pontual e a próxima tentativa também falha sem custo real, ou é o schema desatualizado — caso em que os retries **ajudam** a expor o problema em vez de escondê-lo. Já "conta desconhecida" recebe 200 propositalmente: reenviar não cria a conta que falta, então retornar erro só gastaria o orçamento de 8 tentativas do Mercado Livre à toa (`docs/MERCADO_LIVRE.md` secao 2.5). Sem tabela de landing para a notificação crua — o corpo da própria Cloud Task é o registro durável (D-044). IP do cliente extraído do penúltimo elemento de `X-Forwarded-For` (D-045).

**`GET /oauth/mercado-livre/callback` — implementado em 2026-08-21** (`apps/api/src/ml-accounts.ts`). Autenticação própria: `state` de CSRF, consumido atomicamente (um único `UPDATE ... WHERE consumed_at IS NULL`, não `SELECT` + `UPDATE`). A autorização usa PKCE S256: `POST /v1/ml-accounts/connect` envia somente o `code_challenge`; o callback recupera o `code_verifier` cifrado e o inclui na troca do token (D-049). Contrato de resposta:

| Situação | Status | Corpo |
|---|---|---|
| `state` ausente na querystring | 400 | `{ error: { code: "invalid_payload" } }` |
| `state` desconhecido, expirado ou já consumido | 400 | `{ error: { code: "invalid_state" } }` |
| ADMIN negou o consentimento no Mercado Livre (`?error=...`) | 400 | `{ error: { code: "rejected" } }` |
| Troca de `code` por token falhou | 400 | `{ error: { code: "rejected" } }` |
| Sucesso — conta `CONNECTED`, credenciais cifradas gravadas | 200 | `{ connected: true, mlAccountId }` |

Em qualquer falha depois da troca de código, a conta é marcada `status = 'ERROR'` com `last_error` preenchido — nunca fica presa em `PENDING` sem explicação. Tokens e verifier PKCE são cifrados com AES-256-GCM antes de tocar o banco (D-046, D-049); nunca aparecem em log, mesmo em erro (`apps/api/src/ml-accounts.test.ts` prova isso). State criado antes de D-049 não tem verifier e é recusado com instrução para reiniciar a conexão.

### Autenticadas por JWT do usuário (Supabase)

| Rota | Método | Papel mínimo | Descrição |
|---|---|---|---|
| `/v1/ml-accounts/connect` | POST | ADMIN | Inicia autorização de conta — **implementado em 2026-08-21**, devolve `{ authorizationUrl }` |
| `/v1/sync/run` | POST | GESTOR | Dispara sincronização manual — **enfileira e responde** |
| `/v1/erp-imports` | POST | GESTOR | Recebe o arquivo do UpSeller, guarda no bucket, registra o lote e **enfileira** o parse |
| `/v1/erp-imports/:id/apply` | POST | GESTOR | Confirmação humana da conferência: move o lote `PARSED` para `APPLYING`, grava quem confirmou e **enfileira** a aplicação |
| `/v1/nfe-imports` | POST | GESTOR | **Implementado em 2026-08-22** — recebe o XML da NF-e, guarda no bucket, registra o documento e **enfileira** o parse. Substitui o par `/v1/documents/nfe/preview`/`commit` do desenho original: mesmo papel mínimo do UpSeller (GESTOR, não OPERADOR — NF-e também reescreve o ledger), mesmo padrão de nomes (`erp-imports`) |
| `/v1/nfe-imports/:id/apply` | POST | GESTOR | **Implementado em 2026-08-22** — confirmação humana: move o documento `PARSED` para `APPLYING` e **enfileira** a aplicação. Recusa se `resolved_items < total_items` — diferente do UpSeller, não tolera aplicação parcial (`apps/api/src/nfe-import.ts`, `confirmNfeApply`) |
| `/v1/purchase-orders/:id/approve` | POST | GESTOR | Transição de ciclo |
| `/v1/diagnostics/run` | POST | ANALISTA | Enfileira diagnóstico |
| `/v1/copilot/query` | POST | qualquer autenticado | **Implementado em 2026-08-25 (D-077/D-082)** — `{ tool, input }`, devolve `{ tool, escopo, confianca, data }`. Quatro ferramentas: três de curto-circuito (sem LLM) + `narrate_sku_diagnosis` (com LLM, D-082). Streaming SSE e o planner por linguagem natural ainda não existem, ver detalhe abaixo |

A `api` **verifica o JWT e reavalia a autorização no servidor**. Não confiar na interface para autorização.

**`POST /v1/copilot/query` — implementado em 2026-08-25 (D-077)** (`apps/api/src/copilot.ts`). Corpo `{ tool: "sales_summary" | "sales_period_comparison" | "sales_account_comparison" | "narrate_sku_diagnosis", input: {...} }` — schemas em `@sb/contracts` (`docs/COPILOT.md` secao 4). Resposta de sucesso: `{ tool, escopo, confianca: "alta", data }`, onde `escopo` é o `input` já validado (`docs/COPILOT.md` secao 5: "a resposta sempre mostra o escopo e o período efetivamente usados") e `data` é a saída tipada da ferramenta.

Cada ferramenta lê sob a RLS do usuário de verdade — `apps/api` ganhou um segundo tipo de cliente Supabase (`UserClient`, `@sb/db`, `createUserClient`), instanciado com a chave publicável + o mesmo JWT do request, não `service_role`. `get_sales_summary` é `security invoker`: rodar via `service_role` devolveria dado de todas as organizações (RLS bypassada), e reimplementar `has_account_access` em código seria a duplicação que `docs/ARCHITECTURE.md` secao 7 já proíbe para fórmulas de métrica — ver `docs/DECISIONS.md` D-077.

**`narrate_sku_diagnosis` — implementada em 2026-08-25 (D-082)**, primeira ferramenta que chama LLM de verdade (Claude Haiku 4.5). Corpo `{ diagnosis: <contrato de SalesAnomalyDiagnosis>, impactBrl }` — o diagnóstico já vem CALCULADO pelo chamador (`apps/web`, `diagnoseSku`, D-078); a `api` não recalcula, só revalida sob RLS que o usuário alcança o `skuId` do contrato antes de narrar (`select id from skus where id = ...`), depois pede ao modelo para narrar citando só o que está no contrato. `ai_runs.llm_used=true` e `cost_usd` gravado com o custo REAL (tokens de entrada/saída devolvidos pela Anthropic, não estimado) — ver `docs/COPILOT.md` secao 9/10.

Contrato de erro: `400 invalid_payload` (input não bate com o schema da ferramenta), `502 tool_failed` (a RPC falhou, ou o SKU não foi encontrado sob a RLS do usuário, ou a chamada à Anthropic falhou), `401`/`403` iguais ao resto da `api`.

**Só o caminho de curto-circuito desta primeira fatia** (`docs/COPILOT.md` secao 2: "se a ferramenta já respondeu por completo... o LLM NÃO é chamado") — o chamador informa `tool` explicitamente, não existe planner que escolha a ferramenta a partir de linguagem natural. Resposta é JSON síncrono, não SSE: sem LLM narrando nada nesta fatia, não há token a transmitir em stream. Planner, streaming de verdade e UI de chat ficam para quando o modelo/orçamento forem decididos (`docs/COPILOT.md` secao 10, pendência que continua aberta).

Toda chamada grava `ai_runs` (`docs/DATABASE.md`) — `llm_used: false` e `cost_usd: null` em toda linha desta fase, campos prontos para quando o LLM existir.

### CORS

Liberado **apenas em `/v1/*`**, com allowlist explícita de origem vinda de `WEB_ORIGINS`. Nunca `*`.

O webhook e as rotas `/internal/*` ficam de fora: Cloud Tasks, Cloud Scheduler e o Mercado Livre não são navegador, e liberar origem neles ampliaria a superfície sem serventia. Há teste negativo provando isso.

`credentials` fica **desligado**: a autorização viaja no header `Authorization`, não em cookie. Sem cookie no jogo, não há CSRF a mitigar.

O upload da planilha vai do navegador **direto** para a `api`, sem passar pela Vercel — o arquivo não atravessa a função de página só de passagem, e o limite de corpo dela deixa de importar.

### Internas, autenticadas por OIDC de service account

| Rota | Chamada por | Descrição |
|---|---|---|
| `/internal/jobs/:type` | Cloud Tasks | Entrega de job ao `worker` |
| `/internal/schedule/reconcile` | Cloud Scheduler | Janela de reconciliação — **implementado em 2026-08-21**, no máximo uma vez por hora útil (dedupe por hora cheia) |
| `/internal/schedule/fulfillment` | Cloud Scheduler | Captura de estoque Full por conta — **implementado em 2026-08-22**, a cada 6h (dedupe por hora cheia) |
| `/internal/schedule/maintenance` | Cloud Scheduler | Reconciliação de estoque contra o UpSeller (D-029) — **implementado em 2026-08-22**, diário, por ORGANIZAÇÃO (não por conta ML). Expurgo continua sem dono |
| `/internal/schedule/ledger-integrity` | Cloud Scheduler | Conferência ledger × projeção (D-056) — **implementado em 2026-08-23**, diário, por ORGANIZAÇÃO |
| `/internal/schedule/listings` | Cloud Scheduler | Sincronização de listings/anúncios (D-058) — **implementado em 2026-08-23**, a cada 6h, por CONTA |
| `/internal/schedule/listing-visits` | Cloud Scheduler | Sincronização de visitas por anúncio (D-032/D-059) — **implementado em 2026-08-23**, DIÁRIO (não 6h — visita não é dado operacional urgente), por CONTA |
| `/internal/schedule/sales-anomaly-actions` | Cloud Scheduler | Detecção de anomalia de venda, Central de Ações (D-064) — **implementado em 2026-08-24**, DIÁRIO, por ORGANIZAÇÃO |

Sem segredo compartilhado (D-024).

**`POST /internal/schedule/reconcile` — implementado em 2026-08-21** (`apps/api/src/reconcile.ts`). Lista `ml_accounts` com `status = 'CONNECTED'` (todas as organizações — rota de manutenção do sistema, não escopada por uma) e enfileira `sync.orders.window` para cada uma, dedupe por `sync-orders:{slug}:{hora-cheia-ISO}` — chamar mais de uma vez na mesma hora não gera trabalho extra. Devolve `{ accountsScanned, enqueued, deduplicated }`. O cálculo da janela em si (`from`/`to`, checkpoint) é do worker, não desta rota — ver `docs/MERCADO_LIVRE.md` secao "Reconciliação".

**`POST /internal/schedule/fulfillment` — implementado em 2026-08-22** (`apps/api/src/fulfillment-schedule.ts`). Mesmo formato de `/internal/schedule/reconcile`: lista `ml_accounts` `CONNECTED` e enfileira `sync.fulfillment.snapshot` para cada uma, dedupe por `full:{slug}:{hora-cheia-ISO}`. Devolve `{ accountsScanned, enqueued, deduplicated }`. Cadência no Cloud Scheduler é a cada 6h (`infra/cloud-scheduler.sh`), não a cada hora como pedidos — Full muda mais devagar e cada execução do worker já varre todos os itens da conta (duas chamadas HTTP por item sem variação), então rodar com mais frequência gastaria orçamento de rate limit (D-042) sem necessidade real.

**`POST /internal/schedule/listings` — implementado em 2026-08-23** (D-058, `apps/api/src/listings-schedule.ts`). Mesmo formato de `/internal/schedule/fulfillment`: lista `ml_accounts` `CONNECTED` e enfileira `sync.listings.snapshot` para cada uma, dedupe por `listings:{slug}:{hora-cheia-ISO}`, cadência a cada 6h.

**`POST /internal/schedule/listing-visits` — implementado em 2026-08-23** (D-032/D-059, `apps/api/src/listing-visits-schedule.ts`). Mesmo formato de `/internal/schedule/listings`, mas dedupe por `listing-visits:{slug}:{dia-de-negócio}` (não hora cheia) — cadência DIÁRIA: visita não é dado operacional urgente como estoque/preço, e `fetchListingVisits` já busca `last=3` dias a cada rodada, absorvendo uma execução perdida sem esperar o dia seguinte.

**`POST /internal/schedule/sales-anomaly-actions` — implementado em 2026-08-24** (D-064, `apps/api/src/sales-anomaly-actions-schedule.ts`). Mesmo formato de `/internal/schedule/ledger-integrity`: lista `organizations` e enfileira `diagnostics.detect-sales-anomalies` para cada uma, dedupe por `detect-sales-anomalies:{organization_id}:{dia-de-negócio}` — por ORGANIZAÇÃO (SKU é organizacional, D-006), não por conta ML.

---

## 3. Tipos de job

Payloads tipados em `@sb/contracts/jobs`. Todo handler é **idempotente**.

| Tipo | Fila | Nome da task (dedupe) |
|---|---|---|
| `sync.orders.window` | `ml-sync-<conta>` | `sync-orders:{conta}:{janela}` — **implementado em 2026-08-21** |
| `sync.order.refresh` | `ml-sync-<conta>` | `order:{conta}:{order_id}` |
| `sync.listings.snapshot` | `ml-sync-<conta>` | `listings:{conta}:{janela}` — **implementado em 2026-08-23** (D-058), substitui o sketch original `sync.listings.page`/`listings:{conta}:{cursor}`: uma execução varre TODOS os itens sem variação JÁ vinculados a um SKU (via `sku_listing_links`, mesmo mecanismo de Full), não paginação por cursor — mesmo formato de `sync.fulfillment.snapshot`. Payload `{ mlAccountId }`. **Gatilho automático**: `POST /internal/schedule/listings` + Cloud Scheduler a cada 6h (`infra/cloud-scheduler.sh`, job `v3-listings-snapshot`) |
| `sync.listing-visits.snapshot` | `ml-sync-<conta>` | `listing-visits:{conta}:{dia-de-negócio}` — **implementado em 2026-08-23** (D-032/D-059): varre os mesmos itens sem variação de `sync.listings.snapshot`, buscando `GET /items/{id}/visits/time_window?last=3&unit=day` por item e gravando uma linha por dia devolvido em `daily_listing_visits` (upsert por `ml_account_id,item_id,metric_date`). `resource: "visits"` — primeiro uso do valor, exigiu alargar o CHECK de `sync_runs`/`sync_errors` (`docs/DATABASE.md`). Payload `{ mlAccountId }`. **Gatilho automático**: `POST /internal/schedule/listing-visits` + Cloud Scheduler DIÁRIO (`infra/cloud-scheduler.sh`, job `v3-listing-visits-snapshot`) |
| `sync.fulfillment.snapshot` | `ml-sync-<conta>` | `full:{conta}:{janela}` — **implementado em 2026-08-22**: uma execução varre TODOS os itens sem variação da conta (via `sku_listing_links`), não um `inventory_id` por task. O sketch original (`full:{conta}:{inventory_id}`) presumia granularidade por item, que dependeria de uma tabela `listings` — hoje ela existe (D-058), mas com outro propósito (estado do anúncio, não estoque); a implementação real de Full continua usando o vínculo já existente e dedupe por conta+janela, mesmo formato de `sync-orders:{conta}:{janela}`. Payload `{ mlAccountId }`. **Gatilho automático implementado em 2026-08-22**: `POST /internal/schedule/fulfillment` + Cloud Scheduler a cada 6h (`infra/cloud-scheduler.sh`, job `v3-fulfillment-snapshot`) |
| `analytics.recompute` | `analytics-recompute` | `recompute:{account-uuid}:{data-negocio}:{janela-minuto-UTC}` — **implementado em 2026-08-21**; payload incremental `{ mode, mlAccountId, metricDate }` ou rebuild `{ mode, mlAccountId, dateFrom, dateTo }` |
| `events.detect` | `analytics-recompute` | `detect:{entidade}:{id}` — **não implementado**: o motor de diff hoje roda inline dentro de `sync.orders.window`/`backfill.orders` (`persist-order.ts`), não como job separado. Este tipo existiria para o caminho do webhook (`sync.webhook.received` decidir o que buscar e enfileirar `events.detect` por entidade) — trabalho futuro, ver `docs/HANDOFF.md` |
| `backfill.orders` | `backfill` | `backfill-orders:{conta}:{checkpoint}` — **implementado em 2026-08-21**, `{conta}` é o slug e `{checkpoint}` é `start` no primeiro pedaço ou o `to` ISO do pedaço anterior |
| `maintenance.reconcile-balances` | `maintenance` | `reconcile-balances:{organization_id}:{data-negocio}` — **implementado em 2026-08-22**, por organização (não por conta ML). Payload `{ organizationId }`. Compara `compute_erp_snapshot_balances` contra `inventory_balances`, gera `AJUSTE_RECONCILIACAO` + `stock.balance.diverged` por divergência (D-029) |
| `maintenance.verify-ledger-integrity` | `maintenance` | `verify-ledger-integrity:{organization_id}:{data-negocio}` — **implementado em 2026-08-23**, por organização. Payload `{ organizationId }`. Compara `compute_inventory_balances_from_ledger` (recomputo do zero) contra `inventory_balances` (projeção mantida por trigger); só emite `stock.balance.diverged`, NUNCA grava `stock_movements` — divergência aqui é bug, não drift de processo (D-056) |
| `diagnostics.detect-sales-anomalies` | `maintenance` | `detect-sales-anomalies:{organization_id}:{data-negocio}` — **implementado em 2026-08-24** (D-064), por organização. Payload `{ organizationId }`. Roda `get_sku_sales_baseline` + `diagnoseSalesAnomaly` em duas passadas (mesmo padrão de `/diagnostico`), busca `get_sku_average_prices` só para os SKUs em anomalia, e grava/atualiza em `actions` (`ON CONFLICT (organization_id, dedup_key) DO UPDATE`, `dedup_key = "sales_anomaly:{sku_id}:{as_of}"`) direto via `service_role`, sem RPC |
| `actions.measure-outcome` | `maintenance` | `outcome:{decision_id}:{offset}` |
| `erp.import.parse` | `maintenance` | `erp-parse:{batch_id}` |
| `erp.import.apply` | `maintenance` | `erp-apply:{batch_id}` |
| `nfe.import.parse` | `maintenance` | `nfe-parse:{document_id}` — **implementado em 2026-08-22** (mesma etapa que corrigiu D-053). Handler condicional a `DOCUMENTS_BUCKET` estar configurado (`apps/worker/src/index.ts`), mesmo raciocínio de `erp.import.parse`/`ERP_IMPORTS_BUCKET` |
| `nfe.import.apply` | `maintenance` | `nfe-apply:{document_id}` — **implementado em 2026-08-22**: gera `stock_movements` (`ENTRADA_NFE`/`SAIDA_NFE`) a partir dos itens já vinculados a um SKU (`computeNfeApplicationMovements`, `@sb/domain/inventory`). Recusa se `resolved_items < total_items` mesmo tendo sido checado na confirmação — dupla checagem, mesmo padrão das RPCs `security definer` |
| `sync.webhook.received` | `ml-sync-<conta>` | `ml-webhook:{resource}:{janela-minuto-UTC}` — **implementado em 2026-08-22** (Fast Path). Dois tópicos têm consumidor: `orders_v2` (extrai `order_id` de `/orders/{id}`, busca `GET /orders/{order_id}` e persiste com `persistOrder`, reaproveitado de `sync.orders.window`) e `post_purchase` (claims/devoluções, D-057 — a menção a "só `orders_v2`" ficou desatualizada de 2026-08-23 até ser corrigida em D-088). Outros tópicos fazem ACK sem trabalho. **`questions` deixou de passar por aqui em 2026-08-25 (D-088)** — o ACK roteia direto para `sync.support.questions`. Sufixo de janela de minuto (D-051) — sem ele, a mudança de status seguinte no MESMO recurso, minutos depois, colidiria com o nome de task que o Cloud Tasks reteve por até 24h e seria descartada |
| `sync.support.questions` | `ml-sync-<conta>` | `ml-webhook:{resource}:{janela-minuto-UTC}` — **implementado em 2026-08-25** (D-087 o handler, D-088 o produtor). Payload `{ mlAccountId, questionId }`. Busca `GET /questions/{question_id}?api_version=4`, valida organização do envelope + `seller_id` remoto, mapeia (D-086) e persiste em `support_cases`/`support_messages`/`support_case_links` idempotentemente. Produtor único hoje é o webhook `questions`; a reconciliação por `GET /my/received_questions/search` continua etapa própria. Compartilha a regra de dedupe do ACK: pergunta e resposta do mesmo `question_id` no mesmo minuto colapsam numa busca só (o detalhe traz os dois) |

**O nome da task é o mecanismo de dedupe.** Para analytics, a janela de minuto é parte do ID (D-051): coalesce o burst por 60 segundos sem tentar reutilizar no mesmo dia um ID que o Cloud Tasks pode reter por até 24 horas.

Todo job registra em `job_runs`: início, fim, resultado, erro, itens processados.

---

## 4. Catálogo de eventos

`event_type` segue `dominio.entidade.acao`. Toda emissão calcula `dedup_key` determinístico.

| Evento | Severidade padrão | Origem |
|---|---|---|
| `listing.price.changed` | informativo (fixo nesta etapa) | diff — **implementado em 2026-08-24 (D-072)**. Elevar por magnitude fica para quando houver dado real de variação de preço — ver `packages/domain/src/events/listing-events.ts` |
| `listing.title.changed` | informativo | diff — **implementado em 2026-08-24 (D-072)** |
| `listing.picture.changed` | informativo | diff |
| `listing.description.changed` | informativo | diff |
| `listing.available_quantity.changed` | informativo | diff — **implementado em 2026-08-24 (D-072)**, catálogo novo (não existia antes) |
| `listing.status.paused` | importante | diff — **implementado em 2026-08-24 (D-072)**. Só a transição PARA `paused`; outras transições de status (`closed`, `under_review`, etc.) não têm evento ainda |
| `listing.status.reactivated` | informativo | diff — **implementado em 2026-08-24 (D-072)**. Só `paused -> active` |
| `listing.promotion.started` | importante | diff |
| `listing.promotion.ended` | importante | diff |
| `listing.catalog.won` | importante | diff |
| `listing.catalog.lost` | crítico | diff |
| `listing.fulfillment.entered` | importante | diff |
| `listing.fulfillment.exited` | importante | diff |
| `stock.depleted` | crítico | ledger / snapshot |
| `stock.replenished` | informativo | ledger / snapshot |
| `stock.balance.diverged` | crítico | job de conferência — reconciliação contra o UpSeller (D-029) OU integridade ledger×projeção (D-056); `before`/`after.checkedAgainst` distingue as duas origens |
| `order.cancelled` | importante | sync — **implementado em 2026-08-21** |
| `order.returned` | importante | sync — **implementado em 2026-08-23 (D-057)**, `apps/worker/src/handlers/claim-return.ts` |
| `sync.delayed` | importante | sync |
| `sync.failed` | crítico | sync |

A severidade final é calculada por **regra versionada** em `@sb/domain/events` (`packages/domain/src/events/catalog.ts`), não fixada na interface. Consumo em `docs/NOTIFICATIONS.md` — **ainda não construído**: `domain_events` emite, mas nada lê ainda (nem notificação, nem Central de Ações). Os quatro eventos de `listing.*` (preço, título, status, quantidade disponível) fecham o pré-requisito crítico da Fase 7 registrado em `docs/HANDOFF.md` — a emissão existe, falta só a camada de notificação em cima.

---

## 5. Contrato de diagnóstico

Saída única, consumida pela Central de Ações, pelo Copiloto e pela ação contextual "O que aconteceu?":

```text
{
  escopo:            { contas[], sku?, mlb?, periodo },
  evidencias:        [ { tipo, valor, fonte, ocorrido_em } ],
  causas_candidatas: [ { hipotese, suporte[], peso } ],
  confianca:         0..1,
  proximos_passos:   [ { rotulo, link } ]
}
```

Regra: `causas_candidatas` só pode referenciar itens presentes em `evidencias`. A IA narra o contrato; não o produz.

---

## 6. Convenções de erro

Resposta de erro uniforme:

```text
{ error: { code, message, details?, request_id } }
```

- `code` é estável e legível por máquina; `message` é para humano.
- **`request_id` sempre presente** e correlacionado com o log estruturado.
- Erro nunca vaza segredo, token, nem SQL.

Classificação para retry, aplicada pelo cliente do Mercado Livre e pelos handlers:

| Classe | Exemplos | Comportamento |
|---|---|---|
| Retryable | 429, 5xx, timeout de rede | Backoff com jitter, honra `Retry-After` |
| Retryable com tolerância | 404 por consistência eventual | Retry limitado |
| Não retryable | 401, 403, payload inválido | Falha imediata, registra em `sync_errors` |

---

## 7. Versionamento

- Contratos vivem em `@sb/contracts`, validados por Zod nas duas pontas.
- Mudança incompatível exige nova versão de rota ou de tipo de job; jobs já enfileirados precisam continuar processáveis.
- Tipos do banco são **gerados** a partir do schema, nunca escritos à mão.

---

## 8. Pendências

- Rotas de visitas, conversão e Ads entram na Fase 5B (D-032).
- Payloads exatos do Mercado Livre dependem da confirmação da documentação oficial — ver `docs/MERCADO_LIVRE.md`.
- Exportação de pedido de compra: **Excel é o formato principal**, PDF secundário, XML adiado (D-034). Modelos a solicitar antes da Fase 4.
- Rotas de importação do UpSeller (upload e aplicação) detalhadas. A conciliação contra `inventory_balances` (D-029) fica para a Fase 4 — o ledger ainda não existe.

---

## 9. Central de Atendimento / SAC (Fase 7B, integração externa ainda pendente)

> Registrado em 2026-08-24 (D-071). A pesquisa oficial foi concluída em D-083, o modelo unificado foi aprovado em D-084 e o núcleo de banco foi implementado localmente em D-085 (`docs/DATABASE.md`). D-086 implementou contrato/mapper e a porta de persistência de Perguntas, mas não registrou rota/job. Ainda não há chamada externa, webhook de SAC, UI ou resposta.

Rotas prováveis, seguindo as três regras de fronteira da secao 1 — responder ao Mercado Livre exige segredo (credencial da conta) e pode ter latência, então é comando privilegiado da `api`, nunca escrita direta do `web`:

| Rota (provável) | Método | Papel mínimo | Descrição |
|---|---|---|---|
| `POST /v1/support/cases/:id/reply` | POST | ADMIN, GESTOR ou OPERADOR com acesso à conta | Envia a resposta confirmada pelo humano — **comando privilegiado**, revalida estado/ações do Mercado Livre e grava `support_reply_attempts`; mesmo padrão de `/v1/nfe-imports/:id/apply` |
| `POST /v1/support/knowledge` | POST | a confirmar | Confirma um item de conhecimento sugerido como `VALIDADO` |

Triagem local (assumir, atribuir responsável, mudar status, resolver/reabrir) não chama o Mercado Livre e deve ser uma RPC transacional sob RLS/autorização — atualiza `support_cases` e acrescenta `support_case_events` juntos. Não precisa de uma rota HTTP própria na primeira fatia.

Jobs prováveis, mesmo formato de `sync.listings.snapshot`/`sync.listing-visits.snapshot` — ingestão read-only primeiro, resposta depois:

| Tipo (provável) | Fila | Descrição |
|---|---|---|
| ~~`sync.support.questions`~~ | `ml-sync-<conta>` | **Saiu do estado provável em 2026-08-25** — ver a linha real na secao 3. Consome o webhook `questions` desde D-088; a reconciliação por `GET /my/received_questions/search?api_version=4` continua não implementada |
| `sync.support.messages` | `ml-sync-<conta>` | Consome webhook `messages` (`actions=created/read`, `resource=message_id`) e reconcilia por `GET /messages/unread?role=seller&tag=post_sale` |
| `sync.support.claims` | `ml-sync-<conta>` | Reaproveita o que D-057/secao 2.10 já confirmou (claims/returns), estendendo para persistência de UI, não só reversão de estoque |

`sync.support.questions` foi o primeiro a sair do estado provável: D-087
implementou a fatia restrita a um `questionId` (detalhe remoto, contrato D-086,
mapper e persistência) e D-088 registrou o produtor via webhook. **A
reconciliação por busca continua etapa própria** e não deve ser simulada dentro
do mesmo handler — sem ela, uma notificação perdida pelo Mercado Livre é uma
pergunta que a V3 nunca vê.

Catálogo de eventos proposto, seguindo `dominio.entidade.acao` (secao 4) — nomes conceituais, a confirmar contra os estados reais que a API devolver:

| Evento (proposto) | Severidade padrão |
|---|---|
| `support.question.received` | informativo |
| `support.message.received` | informativo / importante |
| `support.claim.opened` | importante |
| `support.claim.updated` | informativo |
| `support.mediation.opened` | crítico |
| `support.return.updated` | importante |
| `support.customer_replied` | importante |
| `support.sla_at_risk` | crítico |

Este catálogo continua propositalmente menor que `support_case_events`: auditoria interna (`ASSIGNEE_CHANGED`, `INTERNAL_STATUS_CHANGED`, refresh técnico de prazo etc.) não gera automaticamente `domain_events`/notificações. Antes de implementar cada linha, definir a transição exata e a `dedup_key` correspondente. Mediação é faceta de claim (`type: mediations`); devolução é outra faceta possível; mensagem comum e mensagem de claim continuam transcripts de cases distintos (D-084).

`sync_runs.resource`/`sync_errors.resource` (hoje `orders`/`listings`/`fulfillment`/`visits`) precisaria crescer de novo para acomodar sincronização de SAC — mesmo CHECK que já cresceu uma vez para caber `visits` (`docs/DATABASE.md`).
