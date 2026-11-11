# API, filas e jobs

A inspeção de 2026-11-11 usa o commit `d6169205` de `origin/main` como base. O inventário cobre as 43 rotas da API, as 2 rotas do worker, os 41 tipos de job registrados, os 18 gatilhos do Cloud Scheduler declarados no script (1 condicional) e o vigia do banco. As referências abaixo usam o código como índice. Contratos, semântica e operação estão em [API](../API.md), [Arquitetura](../ARCHITECTURE.md), [Deploy](../DEPLOYMENT.md) e [Testes](../TESTING.md).

## Fronteiras e diagnóstico

| Componente | Entrada e autorização | Onde confirmar |
|---|---|---|
| Web, Next.js/Vercel | Server Components, Server Actions e cliente Supabase sob RLS. Operações privilegiadas chamam a API. | `apps/web/lib/chamar-api.ts` e o consumidor de cada rota |
| API, Hono/Cloud Run público | `apps/api/src/app.ts` declara os caminhos e o bootstrap em `apps/api/src/index.ts` fornece as dependências. `/v1/*` usa token do Supabase, papel e organização em `organization_members`. Cada comando privilegiado confere o recorte do recurso porque `AdminClient` atravessa RLS. CORS permite apenas as origens configuradas. | `auth.ts`, `auth.test.ts` e `app.test.ts` no [diretório da API](../../apps/api/src/) |
| Cloud Scheduler → API | `/internal/*` verifica assinatura, audience e conta de serviço Google permitida. Uma falha declarada ao listar o recorte retorna 503. O script configura duas retentativas com backoff de 30 s a 120 s. | `oidc.ts` e `app.test.ts` na API, [cloud-scheduler.sh](../../infra/cloud-scheduler.sh) |
| Cloud Tasks → worker privado | `POST /internal/jobs` recebe `JobEnvelope` e payload, `GET /health` é o probe. IAM do Cloud Run exige a identidade invocadora. O boot do worker registra os handlers e integrações condicionais. | [Worker app](../../apps/worker/src/app.ts), [registro](../../apps/worker/src/index.ts), [envelope](../../packages/contracts/src/), [script de deploy](../../infra/deploy-cloud-run.sh) |
| Entrega de job | A API e o worker usam nome de task derivado da chave lógica. `ALREADY_EXISTS` deduplica por fila. O worker usa o contador de retentativas do cabeçalho. Sucesso, falha definitiva e envelope inválido encerram a entrega com 2xx. Falha transitória e tipo desconhecido retornam 503. | [Enqueuer da API](../../apps/api/src/enqueue.ts), [enqueuer do worker](../../apps/worker/src/enqueue.ts), [estados HTTP](../../apps/worker/src/job-outcome.ts), `enqueue.test.ts` e `worker/src/app.test.ts` |
| Trilha de investigação | `job_runs` registra cada entrega processada, `sync_runs` acompanha as rodadas de sync, `domain_events` materializa eventos de domínio. `/saude` e `/sincronizacao` são os consumidores operacionais. | `apps/worker/src/handlers/sync-runs.ts`, `packages/db/src/job-runs.ts` e `packages/db/scripts/report-health.mjs` |

`job_runs` é gravado em regime de melhor esforço. Falhas ao listar contas ou criar tasks e tipos de job que a revisão do worker ainda desconhece podem aparecer só no log do produtor ou do worker. Um Scheduler verde isolado não confirma ingestão.

## Entradas externas e saúde

| Rota da API | Primeiro módulo | Fluxo e verificação |
|---|---|---|
| `GET /health` | `app.ts` | Prova HTTP do processo e retorna `APP_COMMIT` quando injetado. Web lê em `lib/api-health.ts`. |
| `POST /webhooks/mercado-livre` | `ip-allowlist.ts`, `webhook.ts`, `account-directory.ts` | Último IP confiável de `X-Forwarded-For` na topologia Cloud Run direta. Resolve vendedor em cache com TTL e recarga única em andamento. `questions`, `messages` e `items` têm jobs próprios. Outros tópicos com consumidor passam por `sync.webhook.received`. Testes de IP, rota, cache e roteamento na API. |
| `POST /push/shopee` | `shopee-push.ts`, `@sb/shopee` | HMAC do corpo e endereço. Pedido e devolução disparam jobs da loja em `backfill`, com janela de 5 min. Assinatura recusada recebe ACK vazio e não acessa a loja nem enfileira. Cobertura em `shopee-push.test.ts`. |
| `GET /oauth/mercado-livre/callback` | `ml-accounts.ts` | Consome `ml_oauth_states`, usa PKCE, confere o vendedor em reconexão e cifra `ml_credentials`. Vincula `ml_accounts` e tenta disparar `backfill.orders`. Cobertura em `ml-accounts.test.ts`. |
| `GET /oauth/shopee/callback` | `shopee-shops.ts` | Consome `shopee_oauth_states`, consulta titularidade por ambiente e loja e grava `shopee_shops` e `shopee_credentials`. Cobertura em `shopee-shops.test.ts`. |
| `GET /oauth/tiktok-shop/callback` | `tiktok-shops.ts` | Consome `tiktok_oauth_states`, consulta lojas autorizadas e grava `tiktok_shops` e `tiktok_credentials`. A fatia no commit auditado contém a conexão OAuth. O registro do worker ainda não contém jobs TikTok. Cobertura em `tiktok-shops.test.ts`. |

Guias dos parceiros no projeto: [Mercado Livre](../MERCADO_LIVRE.md), [Shopee](../SHOPEE.md), [TikTok Shop](../TIKTOK_SHOP.md) e [Contratos multicanal](../MULTICHANNEL_CONTRACTS.md).

## Comandos da aplicação

Todos são `POST`. Os módulos da coluna API estão em [apps/api/src](../../apps/api/src/). Os consumidores de página ficam sob `apps/web/app/(app)`, salvo o cliente compartilhado e Server Actions da web.

| Caminho `/v1` | Papéis | Consumidor, módulo da API e persistência |
|---|---|---|
| `/support/cases/:caseId/reply` | ADMIN, GESTOR, OPERADOR | `atendimento/[caseId]/reply-form.tsx` → `support-reply.ts`, com permissão por conta → `support_reply_attempts` → `support.reply.send`. O envio ativo se restringe a Perguntas. |
| `/organization/invites` e `/organization/members/:userId/access-link` | ADMIN | `usuarios/convidar.tsx` e `usuarios/reemitir-link.tsx` → `invites.ts` → Supabase Auth e escopo de `organization_members`. |
| `/organization/members/:userId/suspension` | ADMIN | `/usuarios` → `member-suspension.ts` → banimento no Supabase Auth e evento em `organization_access_events`. |
| `/pricing/ml-shipping-quote` | Todos os cinco | `faturamento/calculadora-preco.tsx` → `pricing-quote.ts` → cotação síncrona no ML com cliente de retentativa limitada. Teste de rota simulado em `faturamento.spec.ts`. |
| `/listings/relist`, `/listings/relist/:relistId/execute` e `/listings/relist/:relistId/retry` | ADMIN, GESTOR | `anuncios/[itemId]/relist-panel.tsx` → `relist.ts` → `relist.prepare` ou `relist.execute` por conta. Execução e retry têm checagem de estado e escopo. |
| `/erp-imports` e `/erp-imports/:id/apply` | ADMIN, GESTOR | `/importacoes` → `erp-import.ts` → GCS e `erp_import_batches` → `erp.import.parse` ou `erp.import.apply`. |
| `/nfe-imports` e `/nfe-imports/:id/apply` | ADMIN, GESTOR | `/notas-fiscais` → `nfe-import.ts` → GCS e `documents` → `nfe.import.parse` ou `nfe.import.apply`. Depende do bucket de documentos. |
| `/ml-accounts/connect`, `/shopee/connect` e `/tiktok-shop/connect` | ADMIN | A conexão ML e Shopee tem botões em `/contas`. Módulos `ml-accounts.ts`, `shopee-shops.ts` e `tiktok-shops.ts` criam `state` de curta duração e retornam o link do parceiro. Não foi localizado chamador web da rota TikTok no commit base. |
| `/copilot/query` e `/copilot/chat` | Todos os cinco | `/acoes`, `/skus`, `/atendimento`, `/sugestoes` e `/copiloto` → `copilot.ts` ou `copilot-chat.ts`. O `UserClient` de leitura herda a RLS do usuário. Geração pelo cliente Anthropic e trilha em `ai_runs`. |

Os cinco papéis são ADMIN, GESTOR, ANALISTA, OPERADOR e VISUALIZADOR. `app.test.ts` exercita as barreiras HTTP, e os módulos de negócio têm suítes próprias para erro, recusa de escopo e efeitos.

## Gatilhos agendados e manuais

Cadência declarada em [cloud-scheduler.sh](../../infra/cloud-scheduler.sh), em `America/Sao_Paulo`. `ML` abaixo significa fila `ml-sync-<slug>` de uma conta conectada. Os produtores são módulos `*-schedule.ts` na API, exceto `reconcile.ts` e o heartbeat em `app.ts`. A coluna de job aponta os tipos do registro do worker.

| Caminho POST | Cron | Job e fila |
|---|---|---|
| `/internal/jobs/ping` | `0 * * * *` | `system.ping`, `maintenance` |
| `/internal/schedule/reconcile` | `0 * * * *` | `sync.orders.window`, ML |
| `/internal/schedule/metrics-refresh` | `35 * * * *` | `analytics.recompute`, `analytics-recompute`, hoje e ontem por conta |
| `/internal/schedule/fulfillment` | `0 */6 * * *` | `sync.fulfillment.snapshot`, ML |
| `/internal/schedule/maintenance` | `0 6 * * *` | `maintenance.reconcile-balances`, `maintenance` |
| `/internal/schedule/ledger-integrity` | `30 6 * * *` | `maintenance.verify-ledger-integrity`, `maintenance` |
| `/internal/schedule/ai-budget` | `0 9 * * *` | `maintenance.check-ai-budget`, `maintenance` |
| `/internal/schedule/listings` | `0 */6 * * *` | `sync.listings.snapshot`, ML |
| `/internal/schedule/listing-visits` | `0 7 * * *` | `sync.listing-visits.snapshot`, ML |
| `/internal/schedule/order-financials` | `30 9 * * *` | `sync.order-financials`, ML |
| `/internal/schedule/order-logistics` | `40 */6 * * *` | `sync.order-logistics`, ML |
| `/internal/schedule/ads` | `0 11 * * *` | `sync.ads.campaigns`, ML |
| `/internal/schedule/support-questions` | `*/10 * * * *` | `sync.support.questions.reconcile`, ML |
| `/internal/schedule/support-messages` | `*/10 * * * *` | `sync.support.messages.reconcile`, ML |
| `/internal/schedule/support-claims` | `15 * * * *` | `sync.support.claims.reconcile`, ML |
| `/internal/schedule/sales-anomaly-actions` | `0 8 * * *` | `diagnostics.detect-sales-anomalies`, `diagnostics.detect-support-patterns`, `diagnostics.sync-central-alerts` e `diagnostics.listing-sales-drop`, `maintenance` |
| `/internal/schedule/decision-outcomes` | `30 8 * * *` | `diagnostics.measure-decision-outcomes`, `maintenance` |
| `/internal/schedule/shopee-orders` | `20 * * * *`, condicional Shopee | `shopee.orders.sync` e `shopee.items.sync`, `backfill`. Catálogo com atraso de 5 min. |
| `/internal/backfill/order-financials` e `/internal/backfill/order-user-products` | Disparo manual OIDC | `backfill.order-financials` e `backfill.order-user-products` em `backfill`. Cada pedaço pode enfileirar o seguinte. |

As filas declaradas em [cloud-tasks-queues.sh](../../infra/cloud-tasks-queues.sh) são `analytics-recompute`, `backfill`, `maintenance` e uma `ml-sync-<slug>` por conta ML provisionada. O worker também produz tasks em `backfill` e `analytics-recompute`. Os números de concorrência e backoff desse script descrevem a criação de fila. O script preserva a configuração de filas existentes.

O vigia `vigiar-sincronizacao` é um `pg_cron` de 30 min, separado de Scheduler e Tasks. A migration [do vigia](../../supabase/migrations/20260928190000_vigia_da_sincronizacao.sql) define `private.vigiar_sincronizacao()` e a [migration multicanal](../../supabase/migrations/20261014200000_contas_dos_marketplaces_e_vigia_shopee.sql) estende a detecção às lojas Shopee. Confirmar a agenda no catálogo da instância antes de depender dela.

## Consumidores no worker e banco

Os arquivos nomeados nesta seção estão em [apps/worker/src/handlers](../../apps/worker/src/handlers/). Alguns jobs partilham persistência com o webhook ou a reconciliação. Os testes `*.test.ts` homônimos, onde presentes, usam mocks ou fixtures e a suite de [integração de banco](../../packages/db/src/) protege RLS, projeções e idempotência.

| Família de jobs | Handlers, efeitos e testes |
|---|---|
| `system.ping` | `router.ts`. Registro em `job_runs` pelo app, sem operação de domínio. |
| `sync.webhook.received`, `sync.orders.window`, `backfill.orders` | `webhook-received.ts`, `sync-orders-window.ts`, `backfill-orders.ts` e `persist-order.ts`. Pedidos e itens, ledger, eventos e cálculo de chaves sujas. A reconciliação usa o checkpoint de `sync_runs`. O caminho genérico aceita `orders_v2` e `post_purchase`. No processamento de pedido, pode consultar dados do envio associado. Testes de webhook, persistência, sync e idempotência. |
| `sync.order-financials`, `sync.order-logistics`, `backfill.order-financials`, `backfill.order-user-products` | Handlers de mesmo nome com hífen. Complementam `order_financials`, dados de envio e identificação histórica de SKU. `claim-return.ts` e `shipment-logistics.ts` preservam o grão do ledger e os efeitos de estorno. |
| `sync.listing.item`, `sync.listings.snapshot`, `sync.listing-visits.snapshot`, `sync.fulfillment.snapshot`, `sync.ads.campaigns` | Relê anúncio singular ou janela de catálogo, visitas, Full e Ads. Pontos de partida: `sync-listing-item.ts`, `ml-listings-fetch.ts`, `ml-listing-visits-fetch.ts`, `ml-fulfillment-fetch.ts` e `sync-ads-campaigns.ts`. Consumidores web incluem `/anuncios`, `/skus`, `/precos`, `/central` e `/faturamento`. |
| `sync.support.questions`, `sync.support.questions.reconcile`, `sync.support.messages`, `sync.support.messages.reconcile`, `sync.support.claims.reconcile` e `support.reply.send` | `sync-support-*.ts`, `persist-support-*.ts` e `send-support-reply.ts`. Gravam casos, vínculos, mensagens, prazos e tentativas. Reconciliação de perguntas pode programar releitura em `backfill`. A resposta revalida o estado remoto antes do POST. A UI lê a projeção sob RLS. |
| `relist.prepare`, `relist.execute` | `relist-prepare.ts`, `relist-execute.ts`. Estado e trilha em `listing_relists` e `listing_relist_events`. `complete_listing_relist_remap` conclui o remapeamento. Cobertura em testes do worker e `listing-relists.integration.test.ts`. |
| `erp.import.parse`, `erp.import.apply`, `nfe.import.parse`, `nfe.import.apply` | `erp-import-*.ts` e `nfe-import-*.ts` leem GCS, validam e materializam lotes, `documents`, `document_items` e movimentos de estoque. Os testes cobrem estado dos lotes, dados rejeitados e aplicação. |
| `analytics.recompute`, `maintenance.reconcile-balances`, `maintenance.verify-ledger-integrity`, `maintenance.check-ai-budget` | `analytics-recompute.ts` chama `recompute_daily_sales_metrics` ou `rebuild_daily_sales_metrics`. `reconcile-balances.ts` usa `compute_erp_target_balances`. `verify-ledger-integrity.ts` compara a projeção com o ledger. `check-ai-budget.ts` usa `get_ai_monthly_cost_usd`. |
| `diagnostics.detect-sales-anomalies`, `diagnostics.detect-support-patterns`, `diagnostics.sync-central-alerts`, `diagnostics.listing-sales-drop`, `diagnostics.measure-decision-outcomes` | `detect-sales-anomaly-actions.ts`, `detect-support-pattern-actions.ts`, `sync-central-alerts.ts`, `listing-sales-drop.ts` e `measure-decision-outcomes.ts`. Escrevem ações, alertas ou medições de decisões e abastecem a Central. RPCs de entrada incluem `registrar_vendas_anomalas` e `recalcular_queda_anuncios`. |
| `shopee.orders.sync`, `shopee.order-financials.sync`, `shopee.returns.sync`, `shopee.ads.sync`, `shopee.escrow-releases.sync` | `shopee-orders-sync.ts` usa trava por loja, `shopee_upsert_orders` e `shopee_advance_orders_synced_until`. Dele saem financeiro, devoluções, Ads, repasse e continuação. Handlers homônimos gravam `shopee_orders`, `shopee_returns`, `daily_shopee_ads_metrics` e `shopee_escrow_releases`. `shopee-stock.ts` projeta o efeito de estoque e `shopee-token.ts` controla renovação. |
| `shopee.items.sync`, `shopee.items.hydrate` | `shopee-items-sync.ts` e `shopee-items-hydrate.ts`. Listagem grava `shopee_items` e enfileira detalhe. Hidratação usa `shopee_items_details_pending`, `shopee_item_models` e alimenta o histórico de preços. Cobertura conjunta em `shopee-catalogo.test.ts`. |

Para revisar código morto, começar no produtor, seguir o tipo até o registro do worker e verificar payload, consumidor do banco, chamadas manuais e revisões implantadas. Jobs que tratam webhooks, autorreencadeamento ou reconciliação podem ter zero referência direta no frontend.

## Verificação operacional em 2026-11-11

- Cloud Run produção, `southamerica-east1`. A configuração de tráfego mostra `api-00038-qsf` e `worker-00056-wjk` com 100% cada, ambos com `APP_COMMIT=dc69d1fb`, ancestral 51 commits atrás de `d6169205`. O IAM de invocação do worker lista a conta de serviço do Cloud Tasks. A alocação de tráfego indica qual revisão receberia pedidos.
- Duas chamadas `GET /health` diretamente no serviço Cloud Run da API de produção retornaram **HTTP 503**. A segunda resposta tinha corpo HTML e servidor `Google,Frontend`. A API de faturamento do Google reportou `billingEnabled=False` em produção e Dev. As listagens de Scheduler e Tasks de produção retornaram `PERMISSION_DENIED` com motivo `BILLING_DISABLED`. Esses sinais confirmam indisponibilidade no endpoint verificado e impedem enumerar filas e agendamentos ativos. A duração do impacto e o estado do backlog permanecem desconhecidos. [Guia do Google Cloud para reativar faturamento](https://docs.cloud.google.com/billing/docs/how-to/modify-project#enable-billing).
- Dev: o inventário Cloud Run ainda mostra `api-00042-8wd` e `worker-00053-z26` como últimas revisões prontas. A configuração ou revisão de um serviço tampouco confirma que ele processa tarefas.
- O `SUPABASE_URL` configurado nas duas revisões de produção tem host `imvjfgnaprqsfjlnsyev.supabase.co`. Nas duas revisões de Dev, o host é `nmgccyqquwxecqffsidr.supabase.co`.
- Consultas realizadas somente em leitura. Nenhum webhook de marketplace, job de escrita ou rollout foi disparado durante a verificação.

## Pontos para a próxima investigação

- Depois de restabelecer a operação, conferir `/health`, filas e Scheduler no projeto explícito. Correlacionar o primeiro heartbeat e as primeiras reconciliações bem-sucedidas com `job_runs` e `sync_runs` antes de determinar a janela a recuperar. O procedimento de replay precisa respeitar as regras de deduplicação e os limites de cada parceiro.
- As verificações de titularidade em `shopee-shops.ts` e `tiktok-shops.ts` antecedem um upsert que pode mudar a organização em caso de corrida. Exercitar dois callbacks concorrentes com estados de organizações distintas, usando fixtures e banco isolado. A atualização de loja e credenciais deve ser atômica, e o conflito deve preservar o proprietário existente.
- Em `support-reply.ts`, a linha `PENDING` é gravada antes de criar a task. Uma falha da criação pode deixá-la sem entrega, pois o retry com a mesma chave responde `in_flight`. Em `send-support-reply.ts`, conferir também o erro devolvido pela escrita do estado terminal, preservando a regra de nunca repetir envio remoto ambíguo. Reproduzir os dois pontos com mocks de Cloud Tasks, persistência e ML.
