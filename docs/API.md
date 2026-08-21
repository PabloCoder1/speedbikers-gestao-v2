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
| `/webhooks/mercado-livre` | POST | Validação própria da origem | ACK rápido, grava notificação, enfileira. **Zero chamada de rede.** |
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
| `/v1/documents/nfe/preview` | POST | OPERADOR | Parse do XML, sem movimentar estoque |
| `/v1/documents/nfe/commit` | POST | OPERADOR | Confirma a conferência e gera movimentos |
| `/v1/purchase-orders/:id/approve` | POST | GESTOR | Transição de ciclo |
| `/v1/diagnostics/run` | POST | ANALISTA | Enfileira diagnóstico |
| `/v1/copilot/query` | POST | qualquer autenticado | Streaming SSE, escopo limitado pelas permissões |

A `api` **verifica o JWT e reavalia a autorização no servidor**. Não confiar na interface para autorização.

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
| `/internal/schedule/maintenance` | Cloud Scheduler | Conferência de saldo, expurgo |

Sem segredo compartilhado (D-024).

**`POST /internal/schedule/reconcile` — implementado em 2026-08-21** (`apps/api/src/reconcile.ts`). Lista `ml_accounts` com `status = 'CONNECTED'` (todas as organizações — rota de manutenção do sistema, não escopada por uma) e enfileira `sync.orders.window` para cada uma, dedupe por `sync-orders:{slug}:{hora-cheia-ISO}` — chamar mais de uma vez na mesma hora não gera trabalho extra. Devolve `{ accountsScanned, enqueued, deduplicated }`. O cálculo da janela em si (`from`/`to`, checkpoint) é do worker, não desta rota — ver `docs/MERCADO_LIVRE.md` secao "Reconciliação".

---

## 3. Tipos de job

Payloads tipados em `@sb/contracts/jobs`. Todo handler é **idempotente**.

| Tipo | Fila | Nome da task (dedupe) |
|---|---|---|
| `sync.orders.window` | `ml-sync-<conta>` | `sync-orders:{conta}:{janela}` — **implementado em 2026-08-21** |
| `sync.order.refresh` | `ml-sync-<conta>` | `order:{conta}:{order_id}` |
| `sync.listings.page` | `ml-sync-<conta>` | `listings:{conta}:{cursor}` |
| `sync.fulfillment.snapshot` | `ml-sync-<conta>` | `full:{conta}:{inventory_id}` |
| `analytics.recompute` | `analytics-recompute` | `recompute:{account-uuid}:{data-negocio}:{janela-minuto-UTC}` — **implementado em 2026-08-21**; payload incremental `{ mode, mlAccountId, metricDate }` ou rebuild `{ mode, mlAccountId, dateFrom, dateTo }` |
| `events.detect` | `analytics-recompute` | `detect:{entidade}:{id}` — **não implementado**: o motor de diff hoje roda inline dentro de `sync.orders.window`/`backfill.orders` (`persist-order.ts`), não como job separado. Este tipo existiria para o caminho do webhook (`sync.webhook.received` decidir o que buscar e enfileirar `events.detect` por entidade) — trabalho futuro, ver `docs/HANDOFF.md` |
| `backfill.orders` | `backfill` | `backfill-orders:{conta}:{checkpoint}` — **implementado em 2026-08-21**, `{conta}` é o slug e `{checkpoint}` é `start` no primeiro pedaço ou o `to` ISO do pedaço anterior |
| `maintenance.reconcile-balances` | `maintenance` | `reconcile:{data}` |
| `actions.measure-outcome` | `maintenance` | `outcome:{decision_id}:{offset}` |
| `erp.import.parse` | `maintenance` | `erp-parse:{batch_id}` |
| `erp.import.apply` | `maintenance` | `erp-apply:{batch_id}` |
| `sync.webhook.received` | `ml-sync-<conta>` | `ml-webhook:{resource}` |

**O nome da task é o mecanismo de dedupe.** Para analytics, a janela de minuto é parte do ID (D-051): coalesce o burst por 60 segundos sem tentar reutilizar no mesmo dia um ID que o Cloud Tasks pode reter por até 24 horas.

Todo job registra em `job_runs`: início, fim, resultado, erro, itens processados.

---

## 4. Catálogo de eventos

`event_type` segue `dominio.entidade.acao`. Toda emissão calcula `dedup_key` determinístico.

| Evento | Severidade padrão | Origem |
|---|---|---|
| `listing.price.changed` | informativo / importante | diff |
| `listing.title.changed` | informativo | diff |
| `listing.picture.changed` | informativo | diff |
| `listing.description.changed` | informativo | diff |
| `listing.status.paused` | importante | diff |
| `listing.status.reactivated` | informativo | diff |
| `listing.promotion.started` | importante | diff |
| `listing.promotion.ended` | importante | diff |
| `listing.catalog.won` | importante | diff |
| `listing.catalog.lost` | crítico | diff |
| `listing.fulfillment.entered` | importante | diff |
| `listing.fulfillment.exited` | importante | diff |
| `stock.depleted` | crítico | ledger / snapshot |
| `stock.replenished` | informativo | ledger / snapshot |
| `stock.balance.diverged` | crítico | job de conferência |
| `order.cancelled` | importante | sync — **implementado em 2026-08-21** |
| `order.returned` | importante | sync — depende da API de Reclamações e Devoluções, ainda não integrada |
| `sync.delayed` | importante | sync |
| `sync.failed` | crítico | sync |

A severidade final é calculada por **regra versionada** em `@sb/domain/events` (`packages/domain/src/events/catalog.ts`), não fixada na interface. Consumo em `docs/NOTIFICATIONS.md` — **ainda não construído**: `domain_events` emite, mas nada lê ainda (nem notificação, nem Central de Ações).

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
