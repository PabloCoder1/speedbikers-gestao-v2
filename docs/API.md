# Contratos — web, api e worker

> Dono documental de: fronteiras entre os apps, rotas da `api`, tipos de job, catálogo de eventos e convenções de erro.
> Arquitetura geral em `docs/ARCHITECTURE.md`. Tabelas em `docs/DATABASE.md`.
> Status: **contratos conceituais aprovados.** Nenhuma rota foi implementada.

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
| `/oauth/mercado-livre/callback` | GET | `state` de CSRF | Conclui a autorização da conta |

**Regra crítica do webhook:** o caminho é liberado **explicitamente e apenas ele**, com teste negativo nas rotas vizinhas. *Motivo, medido na V2:* o proxy exigia sessão, o webhook não envia cookie, e as notificações de preço, promoção e Full morriam em silêncio num 307 para `/login`.

**Implementado em 2026-08-21** (`apps/api/src/webhook.ts`, `apps/api/src/ip-allowlist.ts`). Contrato de resposta:

| Situação | Status | Corpo |
|---|---|---|
| Origem fora da allowlist de IP (D-043) | 403 | `{ error: { code: "forbidden" } }` |
| Payload não é JSON ou falha o schema | 400 | `{ error: { code: "invalid_payload" } }` |
| `seller_id` sem conta correspondente | 200 | `{ received: true, processed: false }` |
| Sucesso — resolvido e enfileirado | 200 | `{ received: true, processed: true }` |

400 em payload inválido é aceitável mesmo com o reenvio automático do Mercado Livre (até 1h): ou é ruído pontual e a próxima tentativa também falha sem custo real, ou é o schema desatualizado — caso em que os retries **ajudam** a expor o problema em vez de escondê-lo. Já "conta desconhecida" recebe 200 propositalmente: reenviar não cria a conta que falta, então retornar erro só gastaria o orçamento de 8 tentativas do Mercado Livre à toa (`docs/MERCADO_LIVRE.md` secao 2.5). Sem tabela de landing para a notificação crua — o corpo da própria Cloud Task é o registro durável (D-044). IP do cliente extraído do penúltimo elemento de `X-Forwarded-For` (D-045).

### Autenticadas por JWT do usuário (Supabase)

| Rota | Método | Papel mínimo | Descrição |
|---|---|---|---|
| `/v1/ml-accounts/connect` | POST | ADMIN | Inicia autorização de conta |
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
| `/internal/schedule/reconcile` | Cloud Scheduler | Janela de reconciliação |
| `/internal/schedule/maintenance` | Cloud Scheduler | Conferência de saldo, expurgo |

Sem segredo compartilhado (D-024).

---

## 3. Tipos de job

Payloads tipados em `@sb/contracts/jobs`. Todo handler é **idempotente**.

| Tipo | Fila | Nome da task (dedupe) |
|---|---|---|
| `sync.orders.window` | `ml-sync` | `sync-orders:{conta}:{janela}` |
| `sync.order.refresh` | `ml-sync` | `order:{conta}:{order_id}` |
| `sync.listings.page` | `ml-sync` | `listings:{conta}:{cursor}` |
| `sync.fulfillment.snapshot` | `ml-sync` | `full:{conta}:{inventory_id}` |
| `analytics.recompute` | `analytics-recompute` | `recompute:{conta}:{sku}:{data}` |
| `events.detect` | `analytics-recompute` | `detect:{entidade}:{id}` |
| `backfill.orders` | `backfill` | `backfill-orders:{conta}:{checkpoint}` |
| `maintenance.reconcile-balances` | `maintenance` | `reconcile:{data}` |
| `actions.measure-outcome` | `maintenance` | `outcome:{decision_id}:{offset}` |
| `erp.import.parse` | `maintenance` | `erp-parse:{batch_id}` |
| `erp.import.apply` | `maintenance` | `erp-apply:{batch_id}` |
| `sync.webhook.received` | `ml-sync-<conta>` | `ml-webhook:{resource}` |

**O nome da task é o mecanismo de dedupe** e é o que faz a chave suja funcionar: cem vendas do mesmo SKU no mesmo dia produzem um recálculo.

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
| `order.cancelled` | importante | sync |
| `order.returned` | importante | sync |
| `sync.delayed` | importante | sync |
| `sync.failed` | crítico | sync |

A severidade final é calculada por **regra versionada** em `@sb/domain/events`, não fixada na interface. Consumo em `docs/NOTIFICATIONS.md`.

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
