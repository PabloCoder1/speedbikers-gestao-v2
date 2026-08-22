# Modelo de dados — Speed Bikers Gestão V3

> Dono documental de: tabelas, colunas-chave, constraints, índices, RLS e regras de migration.
> Arquitetura geral em `docs/ARCHITECTURE.md`. Métricas derivadas em `docs/METRICS.md`.
> Status: **modelo conceitual aprovado; schema implementado até a Fase 3 e catálogo de métricas da Fase 5A.** As demais tabelas de fases futuras continuam conceituais até sua migration correspondente.

---

## 1. Camadas

| Camada | Natureza | Mutabilidade | Onde vive |
|---|---|---|---|
| **L0 — Bruto** | Payload cru do Mercado Livre | Imutável | Cloud Storage, `raw/ml/{recurso}/{yyyy-mm}/{id}.json` |
| **L1 — Operacional** | Estado atual | `INSERT` / `UPDATE` | Postgres |
| **L2 — Histórico** | Append-only | **Nunca `UPDATE`** | Postgres |
| **L3 — Analítico** | Derivado | Recomputável por completo | Postgres |

L0/L1/L2/L3 é vocabulário, não framework. Não existe schema `l0`; a camada define nomenclatura, expectativa de mutabilidade e política de índice.

---

## 2. Tabelas por domínio

### L1 — Operacional

```text
identity        organizations · profiles · organization_members · user_account_permissions
ml-accounts     ml_accounts · ml_credentials (cifrado) · ml_oauth_states
catalog         skus · sku_components · brands
erp-sync        erp_import_batches · erp_import_rows · erp_product_catalog · erp_kits
                erp_stock_snapshots · erp_store_aliases        (UpSeller — D-028)
suppliers       suppliers · supplier_product_links
listings        listings · listing_variations · listing_price_states
linking         sku_listing_links · link_candidates
sales           orders · order_items
inventory       inventory_balances · fulfillment_stock_snapshots
documents       documents · document_items
purchasing      purchase_orders · purchase_order_items
actions         actions · action_decisions · action_outcomes
notifications   notifications · notification_recipients · notification_preferences
feedback        feature_suggestions
meta            metric_definitions
```

`metric_definitions` é a exceção global deliberada à D-031: metadado canônico, idêntico entre organizações, espelhado de `docs/METRICS.md` e alterado somente por migration. Usuário autenticado só lê se tiver vínculo com alguma organização; `anon` não lê e nenhum papel da aplicação escreve.

### L2 — Histórico (append-only)

```text
domain_events          before/after, dedup_key UNIQUE, severity, source
stock_movements        idempotency_key UNIQUE — único escritor do estoque local
purchase_order_events
sync_runs · sync_errors · job_runs · ai_runs
```

### L3 — Analítico (recomputável)

```text
daily_listing_metrics    fato: (ml_account_id, mlb_id, variation_id, metric_date)
daily_sku_metrics        rollup
daily_account_metrics    rollup
purchase_planning · abc_classification
```

---

## 3. Os três constraints que sustentam o sistema

```sql
stock_movements.idempotency_key                      UNIQUE
domain_events.dedup_key                              UNIQUE
sku_listing_links (ml_account_id, mlb_id, variation_id)  UNIQUE
```

São garantias **físicas**, não validações de aplicação:

1. **`stock_movements.idempotency_key`** — a mesma venda, webhook ou NF-e não conseguem movimentar estoque duas vezes, por mais que a fila reentregue o job. Toda fila entrega ao menos uma vez; a constraint é o que torna isso seguro.
2. **`domain_events.dedup_key`** — reprocessar um job não duplica evento. Importa porque evento duplicado vira notificação duplicada na tela do usuário.
3. **`sku_listing_links`** — um anúncio/variação resolve para um SKU e apenas um, sem ambiguidade.

---

## 4. Entidades centrais

### `skus` — a entidade canônica

Identidade: `(organization_id, sku_key)` UNIQUE, com `sku_key = upper(btrim(sku))`. O SKU original é preservado em `sku` e a chave normalizada em `sku_key`. Esse desenho vem da V2 e está correto.

Atributos estruturados, não tags: `brand_id`, `supplier_id`, `origin` (enum `NACIONAL` / `IMPORTADO`), custos. O lead time de compra é **função da origem**.

`sku_components` modela kits: um SKU de kit referencia SKUs componentes com quantidade.

### `sku_listing_links` — o vínculo

```text
(ml_account_id, mlb_id, variation_id) -> sku_id
+ source (manual | regra | importacao)
+ confidence, confirmed_by, confirmed_at
```

**Pegadinha obrigatória:** `variation_id` nulo representa o anúncio sem variação, e `NULL` não colide com `NULL` em UNIQUE no Postgres. São necessários **dois índices únicos parciais**: um para `variation_id is null`, outro para `variation_id is not null`. É o erro número um desta modelagem.

**Identificadores nativos do Mercado Livre a capturar desde o início:** os anúncios carregam `inventory_id` e `user_product_id`. A V2 os extraiu do payload e indexou; eles amarram anúncio a Full e agrupam variações, poupando trabalho manual de vinculação.

### `link_candidates` — Central de Vinculações

Referência de anúncio cujo SKU ainda não existe no catálogo (`docs/PROMPT_MASTER.md` secao 15). Hoje a única fonte é a importação do UpSeller (`source = 'ERP_IMPORT'`, `source_row_id` aponta para `erp_import_rows`); outras fontes (NF-e, código de fornecedor) entram quando existirem.

```text
sku_key, ref_kind, item_id, variation_id, user_product_id, channel_sku   -- mesma forma de sku_listing_links
status (OPEN | RESOLVED | DISMISSED)
resolved_sku_id, resolved_by, resolved_at, resolution_method (EXACT_MATCH | MANUAL)
```

As colunas de referência **duplicam** o que já está no `jsonb` de `erp_import_rows.payload`, de propósito — mesmo motivo de `erp_import_rows.sku_key`: permitir a confirmação sem reabrir o jsonb dentro de uma função SQL.

**Duas RPCs `security definer`** (`resolve_link_candidate`, `dismiss_link_candidate`) são o único caminho de escrita. A confirmação é atômica em duas tabelas — cria a linha em `sku_listing_links` e fecha o candidato na mesma transação — e refaz a autorização internamente nos mesmos termos da policy de escrita de `sku_listing_links`, porque `security definer` ignora GRANT e RLS.

**Match exato roda sozinho**, sem tela: depois de qualquer aplicação do importador, o worker relê os candidatos `OPEN` da organização sobre as mesmas linhas de origem — se o SKU passou a existir, o vínculo é criado e o candidato fecha com `resolution_method = 'EXACT_MATCH'`, sem intervenção humana.

### `ml_accounts` / `ml_credentials` / `ml_oauth_states` — conexão Mercado Livre

Schema criado na Fase 2; **conexão real (OAuth connect + callback) é Fase 3**, concluída em 2026-08-21 junto com a reconciliação por janela.

```text
ml_accounts       label, slug (nomeia a fila ml-sync-<slug>, D-036), seller_id?, nickname?,
                  status (PENDING | CONNECTED | REVOKED | ERROR), connected_at?, last_error?,
                  backfill_covered_until?
ml_credentials    access_token_ciphertext, refresh_token_ciphertext, encryption_key_version,
                  access_token_expires_at, scopes[], refresh_locked_until?
ml_oauth_states   state (PK), organization_id, ml_account_id, created_by?, redirect_to?,
                  code_verifier_ciphertext?, expires_at, consumed_at?
```

`backfill_covered_until` (migration `20260821030000`) é o checkpoint do backfill retomável — L1, mutável, não pertence a `sync_runs` (L2, histórico de cada execução, não de onde a próxima deve começar). `NULL` = nunca começou; `>= connected_at` = terminou, porque a reconciliação por janela já cobre dali para frente. `docs/HANDOFF.md` tem o desenho completo (pedaços de 7 dias, auto-encadeamento pelo `worker`).

Fluxo: o ADMIN cria a conta (`ml_accounts`) direto pelo `web`, sob RLS — é escrita simples de usuário, sem segredo envolvido. Conectar exige segredo (`client_secret` do Mercado Livre, chave de cifra dos tokens) e por isso passa pela `api`:

1. `POST /v1/ml-accounts/connect` (ADMIN) gera PKCE S256, grava um `state` de uso único e o `code_verifier` cifrado em `ml_oauth_states` (expira em 15 min), e devolve a `authorizationUrl` com somente o `code_challenge`.
2. O navegador do ADMIN autoriza no Mercado Livre e é redirecionado para `GET /oauth/mercado-livre/callback` — rota pública, sem JWT nem OIDC, cuja única defesa é o `state` (mesmo espírito do webhook, D-043, mas com CSRF em vez de allowlist de IP).
3. O callback **consome o `state` atomicamente**: um único `UPDATE ... WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()`, não um `SELECT` seguido de `UPDATE` — duas chamadas concorrentes com o mesmo `state` (aba duplicada, retry do navegador) só deixam uma passar.
4. Decifra o `code_verifier`, troca o `code` com PKCE, cifra `access_token`/`refresh_token` (AES-256-GCM, D-046) e grava em `ml_credentials` (`upsert` por `ml_account_id` — PK **não parcial**, diferente da armadilha de `sku_listing_links` descrita abaixo). Marca a conta `CONNECTED`.

**`ml_credentials` nunca recebe GRANT nem para `authenticated`** — só `service_role` alcança, em qualquer cenário (mesmo padrão de `ml_oauth_states`). O texto claro do token nunca existe fora do processo da `api` entre a resposta do Mercado Livre e a chamada de `encryptToken`; o verifier PKCE também fica cifrado e nunca vai ao navegador (D-049).

### `sync_runs` / `sync_errors` — observabilidade de sincronização

Schema criado na Fase 2; **preenchimento real começou em 2026-08-21**, com a reconciliação por janela (`sync.orders.window`, `apps/worker/src/handlers/sync-orders-window.ts`) — primeiro código a escrever nestas tabelas. Mesmo padrão L2 append-only de `job_runs` (mesma migration de referência), com uma diferença deliberada: `job_runs` nasceu **sem política de leitura** porque `organizations` ainda não existia; `sync_runs`/`sync_errors` já nascem com policy de leitura, porque agora existe quem autorizar — é observabilidade **para o usuário** (`docs/ARCHITECTURE.md` secao 10), não só para depuração interna.

```text
sync_runs    organization_id, ml_account_id, job_id, resource, channel,
             status, reason, items_processed, latest_record_at,
             started_at, finished_at
sync_errors  organization_id, ml_account_id, sync_run_id?, resource,
             error_class, message, occurred_at
```

`resource` (`orders` | `listings` | `fulfillment`) e `channel` (`webhook` | `reconciliation` | `backfill`) só nomeiam o que já está aprovado em `docs/ARCHITECTURE.md` e `docs/MERCADO_LIVRE.md` secao 3 — nenhum campo de payload do Mercado Livre foi antecipado.

`latest_record_at` é o dado que sustenta a tela de Saúde da Sincronização: a distância entre `now()` e o registro mais recente que uma execução efetivamente trouxe, não `finished_at` — uma sincronização pode terminar sem trazer nada novo.

**Armadilha paga:** `ml_account_id` referencia `ml_accounts` com `on delete restrict`, não `cascade`. Numa tabela append-only, um `cascade` é fisicamente impossível de completar — o `DELETE` disparado pela cascata esbarra na mesma trigger que bloqueia `DELETE` direto, e a exclusão inteira falha. `restrict` torna isso explícito: apagar uma conta com histórico de sync falha alto, em vez de a cascata quebrar no meio com um erro que não aponta para a causa. Na prática nunca dispara — contas são desativadas por `status = 'REVOKED'`, nunca apagadas.

### `orders` / `order_items` — vendas

**Implementado em 2026-08-21** (migration `20260821040000_create_orders.sql`), gravado por `sync.orders.window` e `backfill.orders` — `apps/worker/src/handlers/persist-order.ts`.

**Fato medido na V2 que define a modelagem:** o Mercado Livre **não entrega pedido multi-linha**. `orders` e `order_items` tinham exatamente 328.211 linhas cada. Uma compra de vários itens vira **vários pedidos** ligados por `pack_id`, e 189.158 pedidos tinham um.

Consequências:

1. **Não construir rateio de `total_amount` entre itens.** A auditoria mediu divergência exatamente zero entre `sum(total_amount)` e `sum(unit_price * quantity)` em R$ 5,8 milhões e 52 mil pedidos. O rateio é matematicamente um no-op.
2. **`pack_id` é a unidade de compra real do cliente** e precisa ser cidadão de primeira classe. Frete, custo de embalagem e "quantos pedidos de verdade eu tive" só fazem sentido agrupados por pack. A V2 tinha o campo mas não a agregação.

```text
orders       id (PK, id nativo do Mercado Livre — sem uuid surrogate), organization_id,
             ml_account_id, pack_id?, status, status_detail?, date_created,
             date_closed?, date_last_updated, last_updated?, total_amount,
             paid_amount?, currency_id, buyer_id?, tags[], cancel_reason?
order_items  id (uuid), order_id, organization_id, ml_account_id, position,
             item_id, variation_id?, title, seller_sku?, quantity, unit_price,
             sale_fee?, currency_id, sku_id?, sku_listing_link_id?
```

`status` tem CHECK com os 9 valores confirmados na documentação oficial (`confirmed`, `payment_required`, `payment_in_process`, `partially_paid`, `paid`, `partially_refunded`, `pending_cancel`, `cancelled`, `invalid`).

**`date_last_updated` × `last_updated` (D-048):** o exemplo oficial de `/orders/search` traz os dois campos na mesma order com valores diferentes, sem explicação na prosa. O checkpoint de sincronização (`sync_runs.latest_record_at`) usa `date_last_updated` — bate o nome com o filtro `order.date_last_updated.from/to`. `last_updated` é gravado à parte, sem função de checkpoint. Pendente de verificação empírica em Dev.

`order_items` **não tem id próprio do Mercado Livre** — o array não traz identificador estável por linha. Reprocessar um pedido substitui TODAS as linhas (`delete` + `insert` por `order_id`), mesmo padrão de `erp_import_rows`; `position` (índice no array) sustenta a unicidade.

`order_items.sku_id` é **resolvido e gravado na persistência** (D-020), junto com `sku_listing_link_id` — qual vínculo foi usado. Revincular um MLB depois não reescreve o faturamento passado.

**Estado atual, honesto:** `orders` é **mutável** (L1) — um `UPDATE` em lugar quando o status muda, sem emitir evento ainda. "Cancelamento e devolução não sofrem `UPDATE` destrutivo: mudam o status em L1 e emitem evento em L2" é o desenho **alvo**, que o motor de diff/`domain_events` (próximo item do checklist da Fase 3) é quem constrói — persistir a estrutura veio primeiro de propósito, mesmo padrão incremental já usado em `sync_runs`.

**Não atômico entre as duas tabelas** (upsert de `orders`, depois delete+insert de `order_items` — três chamadas separadas). Aceito: o pedido é reprocessado a cada janela de reconciliação, uma falha no meio se autocorrige na próxima varredura — não é o tipo de escrita humana única que precisa da atomicidade de uma RPC `security definer`.

### `daily_listing_metrics` / `daily_sku_metrics` / `daily_account_metrics` — vendas diárias

**Implementado em 2026-08-21** (migration `20260821182620_create_daily_sales_metrics.sql`) como L3 recomputável, sem executar ainda o rebuild histórico enquanto o backfill de pedidos estiver incompleto.

```text
daily_listing_metrics  (ml_account_id, mlb_id, variation_id?, metric_date)
daily_sku_metrics      (ml_account_id, sku_id?, metric_date)
daily_account_metrics  (ml_account_id, metric_date)
```

As três tabelas guardam os mesmos componentes canônicos: `units_sold`, `gross_revenue`, `orders_count` e `purchases_count`. `average_ticket` e `average_selling_price` são colunas geradas com divisão em `numeric` e arredondamento explícito de duas casas — a aplicação não escreve nem agrega essas razões em JavaScript.

`private.compute_daily_sales_metrics(organization_id, date_from, date_to, ml_account_id?)` produz os três grãos em uma única consulta com `GROUPING SETS`. Isso é a implementação física de D-017/D-050: `COUNT(DISTINCT order_id)` e a chave tipada `pack:<id>`/`order:<id>` são recalculados diretamente em cada grão. O teste de integração prova deliberadamente que somar `purchases_count` de anúncios pode dar `3`, enquanto o grão da conta correto dá `2` para as mesmas vendas.

`daily_sku_metrics` mantém `ml_account_id` para a RLS continuar respeitando permissões por conta. `sku_id IS NULL` é um bucket válido, com `UNIQUE NULLS NOT DISTINCT`; faturamento sem vínculo nunca desaparece. Pelo mesmo motivo, `variation_id IS NULL` participa da unicidade do fato de anúncio.

Authenticated tem somente `SELECT`, filtrado por `private.has_account_access(ml_account_id)` nas três tabelas. Escrita é exclusiva da `service_role`; o cálculo compartilhado fica no schema `private`, é `security invoker`, usa `search_path` vazio e não é exposto a `anon`/`authenticated`.

**Materialização implementada em 2026-08-21** (migration `20260821184047_create_sales_metrics_recompute.sql`): `public.recompute_daily_sales_metrics` substitui atomicamente um dia de uma conta; `public.rebuild_daily_sales_metrics` faz o mesmo para um intervalo inclusivo. As duas são `security invoker`, executáveis somente por `service_role`, e chamam `private.refresh_daily_sales_metrics`.

A função privada adquire advisory lock transacional por conta, apaga o intervalo e reinsere os três grãos a partir de um único CTE `MATERIALIZED`. Assim, duas dirty keys concorrentes não disputam UNIQUE e os três rollups enxergam o mesmo snapshot de L1. Se o intervalo deixa de ter venda válida, o DELETE permanece e nenhuma linha vazia é inventada — teste de integração cobre explicitamente a remoção da projeção obsoleta.

### `stock_movements` — o ledger

```text
sku_id, location_kind, qty_delta, movement_type,
source_type, source_id,
idempotency_key UNIQUE,
occurred_at, created_by
```

Tipos: `ENTRADA_NFE` · `SAIDA_NFE` · `VENDA_ML` · `CANCELAMENTO_ML` · `DEVOLUCAO_ML` · `AJUSTE_MANUAL` · `AJUSTE_RECONCILIACAO` · `TRANSFERENCIA` · `RESERVA` · `LIBERACAO_RESERVA` · `ENTRADA_TRANSITO` · `RECEBIMENTO_TRANSITO`.

`AJUSTE_RECONCILIACAO` é gerado automaticamente pela conciliação contra o ERP (D-029) e nunca por ação direta de usuário.

**A venda vira linha no ledger no momento em que o pedido é persistido**, não calculada na leitura. *Motivo, medido na V2:* a dedução calculada na leitura consumiu seis migrations em dois dias brigando com timeout (`materialize_stock_movement_views_to_fix_timeout`, `revert_sale_deductions_from_stock_signals_exact`, `push_date_filter_into_sale_deductions`, `drive_sale_deductions_from_recent_orders`, `materialize_stock_sale_deductions`, `serialize_stock_sale_deductions_refresh`). O custo é pago uma vez na escrita e a leitura vira soma indexada.

Venda de SKU de kit gera movimentos dos componentes.

### `inventory_balances` — projeção

Projeção recomputável do ledger. Existe um **job de conferência** que compara a projeção contra `sum(qty_delta)` e **emite evento crítico na divergência**. Sem esse job, a projeção diverge em silêncio e o erro aparece como reclamação de cliente.

### `erp_stock_snapshots` — alinhamento com o UpSeller

O UpSeller permanece como ERP (D-028) e movimentos manuais são lançados nos dois sistemas. Isso exige um mecanismo de alinhamento explícito, porque uma hora alguém esquece um lado.

**O princípio que sustenta o desenho:** o ledger da V3 é **completo e autossuficiente**, não é espelho do UpSeller. O ERP entra como **fonte de alinhamento por snapshot**, em tabelas próprias, e **nunca escreve direto em `inventory_balances`**. No dia em que a V3 assumir como ERP, o que sai é a importação e a conciliação — o modelo de estoque permanece intacto.

**Fluxo de conciliação — implementado em 2026-08-22** (migration `20260822193916_reconcile_balances.sql`, job `maintenance.reconcile-balances`):

```text
planilha do UpSeller -> erp_import_batches / erp_import_rows
   -> erp_stock_snapshots (saldo do ERP por SKU, com captured_at)
   -> compute_erp_snapshot_balances (snapshot mais recente por SKU, LOCAL/RESERVADO)
   -> comparação contra inventory_balances (@sb/domain/inventory, computeReconciliationAdjustments)
   -> divergência? gera stock_movements tipo AJUSTE_RECONCILIACAO
                    + domain_events 'stock.balance.diverged' (crítico, sem conta — D-054)
```

**O UpSeller vence, mas o ajuste é uma linha de ledger, nunca um `UPDATE` silencioso** (D-029). O saldo passa a bater e a diferença fica auditável, com origem, data e responsável.

**RESERVADO nasce inteiramente desta reconciliação** — nenhum outro código grava `location_kind = 'RESERVADO'` (venda/cancelamento/NF-e são sempre `LOCAL`). "Disponível" do UpSeller mapeia para LOCAL, "Ocupado" mapeia para RESERVADO (`docs/UPSELLER.md` secao 6). **TRANSITO fica de fora de propósito** — as colunas de trânsito do export real vêm zeradas em 100% das linhas (o recurso existe no ERP e não é usado); depende de Pedidos de Compra existir como fonte própria. Por isso "Reservado e em trânsito" e esta reconciliação são o MESMO item do checklist (`docs/ROADMAP.md`), não dois.

`compute_erp_snapshot_balances` vive no schema **`public`**, não `private` — achado ao implementar: `supabase/config.toml` expõe só `schemas = ["public", "graphql_public"]` ao PostgREST, e o worker fala com o Postgres via `@supabase/supabase-js` (PostgREST), nunca conexão direta. Uma função em `private` é inalcançável dali, GRANT correto ou não. Segurança não depende do schema — `GRANT` restrito a `service_role` (`revoke ... from public, anon, authenticated`) já impede qualquer usuário. O mesmo problema afeta `private.compute_inventory_balances_from_ledger` (nunca usada — registrado em `docs/ROADMAP.md` para quando o job de conferência ledger×projeção for implementado).

Gatilho: `POST /internal/schedule/maintenance` (`apps/api/src/balance-reconcile-schedule.ts`) + Cloud Scheduler diário (`infra/cloud-scheduler.sh`, job `v3-reconcile-balances`) — **por ORGANIZAÇÃO, não por conta ML** (D-006), diferente de `sync.orders.window`/`sync.fulfillment.snapshot`.

**Uso operacional:** frequência e tamanho dos ajustes viram métrica de saúde. Ajuste grande e recorrente indica processo humano falhando, não erro de software — e é o sinal de que a V3 está pronta para assumir como ERP.

### `fulfillment_stock_snapshots` — Full

**Schema implementado em 2026-08-22** (migration `20260822122526_create_fulfillment_stock_snapshots.sql`). Job de captura (`sync.fulfillment.snapshot`, `apps/worker/src/handlers/ml-fulfillment-fetch.ts`/`sync-fulfillment-snapshot.ts`) e detector de diff (`detectFulfillmentEvents`, `@sb/domain/events`) implementados na sequência, mesma sessão — ver `docs/HANDOFF.md`. **Escopo atual: só itens sem variação** (`sku_listing_links.variation_id IS NULL`) — itens com variação exigem confirmar contra a API real onde `inventory_id` aparece dentro de `variations[]`, ainda não verificado. **Disparo automático implementado em 2026-08-22**: `POST /internal/schedule/fulfillment` (`apps/api/src/fulfillment-schedule.ts`) + Cloud Scheduler a cada 6h (`infra/cloud-scheduler.sh`, job `v3-fulfillment-snapshot`) — cadência menor que a reconciliação de pedidos, de propósito (ver `docs/API.md`).

```text
organization_id, ml_account_id,
inventory_id, item_id, variation_id,
sku_id (congelado na captura, D-020),
quantity, captured_at
```

**Full é espelho do Mercado Livre, não ledger** (D-018). A autoridade é o ML. Eventos de Full (entrou, saiu, rompeu, repôs) saem do **diff entre snapshots consecutivos**. `inventory_id` vem de `GET /items/{item_id}` (`docs/MERCADO_LIVRE.md` secao 2.7); a enumeração de quais `item_id`/`variation_id` existem por conta usa `sku_listing_links` (`ref_kind = 'ITEM'`), sem depender de uma tabela `listings` própria — essa continua fora do escopo da Fase 4. RLS por `has_account_access(ml_account_id)`, mesmo padrão de `domain_events`/`sync_runs` (Full é por conta, não por organização inteira — diferente de `stock_movements`, que é local e organização-wide).

Local, Full por conta, reservado e em trânsito são **quatro estados com quatro autoridades diferentes**. A interface nunca os soma cegamente num "estoque total" sem dizer o que ele contém.

### `documents` / `document_items` — NF-e

**Fluxo completo implementado em 2026-08-22** (migration `20260822145800_create_documents.sql` + `20260822161237_create_link_document_item_rpc.sql`): `upload -> PARSE -> conferência -> confirmação -> aplicação`, mesmo fluxo do importador do UpSeller de ponta a ponta. `content_hash` UNIQUE impede que o mesmo arquivo entre duas vezes; `access_key` UNIQUE (44 dígitos, quando presente) cobre o caso de dois ARQUIVOS diferentes carregando a mesma nota.

Estados: `UPLOADED -> PARSING -> PARSED -> APPLYING -> APPLIED` (mais `FAILED`/`CANCELLED`, mesma forma de `erp_import_batches`). **Parse e movimentação são atos distintos em momentos distintos** — o parse (`nfe.import.parse`, `apps/worker/src/handlers/nfe-import-parse.ts`) só grava `document_items`, nunca `stock_movements`. Só a confirmação humana gera linhas do ledger, via `nfe.import.apply` (`computeNfeApplicationMovements`, `@sb/domain/inventory`) — `ENTRADA_NFE` soma, `SAIDA_NFE` subtrai, `source_type = 'DOCUMENT'`.

`document_items.sku_id` nasce sempre nulo — vínculo é humano, por documento, na tela de conferência (`/notas-fiscais/:id`, `docs/NFE.md` secao 3: sem cadastro fornecedor→SKU reutilizável ainda, limitação conhecida, não descuido). O vínculo passa pela RPC `security definer` `link_document_item` (mesmo padrão de `resolve_link_candidate`) — `authenticated` só tem `SELECT` direto nas duas tabelas. **Diferente do importador do UpSeller: a confirmação da aplicação (`confirmNfeApply`, `apps/api/src/nfe-import.ts`) exige `resolved_items === total_items`** — uma NF-e é documento fiscal fechado, aplicar parcialmente deixaria estoque físico recebido/enviado sem registro, em silêncio, e sem o mecanismo de resolução automática futura que a Central de Vinculações tem para o UpSeller.

O arquivo vai para o Storage privado (`DOCUMENTS_BUCKET`, ainda não provisionado no GCP), nunca para coluna `bytea`. Parser: `packages/domain/src/nfe/parse.ts` (puro, recebe o objeto já convertido de XML, não a string bruta) + `fast-xml-parser` no worker (`apps/worker/src/nfe-xml-reader.ts`) — mesmo split de `read-excel-file`/`@sb/domain/upseller`.

### `domain_events` — o event store

**Implementado em 2026-08-21** (migration `20260821050000_create_domain_events.sql`). L2 append-only, mesmo mecanismo de `job_runs`/`sync_runs` (trigger recusa `UPDATE`/`DELETE`).

```text
organization_id, ml_account_id (nullable, D-054), occurred_at,
event_type, entity_type, entity_id,
before jsonb, after jsonb,
severity (informativo | importante | critico),
source (webhook | sync | user | system),
dedup_key UNIQUE
```

**`ml_account_id` aceita `NULL` desde 2026-08-22 (D-054)** — para eventos organizacionais sem conta ML associada (hoje só `stock.balance.diverged`, da reconciliação contra o UpSeller). A policy de leitura reflete isso: com conta, `has_account_access(ml_account_id)` como sempre; sem conta, `is_member_of(organization_id)`. Todo evento com conta real continua sempre preenchendo a coluna — não é opcional por escolha de quem grava.

Uma tabela, sem tabelas de snapshot separadas (D-016). O catálogo de `event_type` vive em `docs/API.md` secao 4, espelhado executável em `packages/domain/src/events/catalog.ts` — divergência entre os dois é bug, mesma regra de `docs/METRICS.md`/`metric_definitions`.

**Motor de diff — primeiro detector, `order.cancelled`** (`packages/domain/src/events/order-events.ts`, chamado por `apps/worker/src/handlers/persist-order.ts` a cada order persistida): compara o `status` gravado ANTES do upsert contra o novo. Transição para `cancelled`/`pending_cancel` emite evento; já estando cancelado, não reemite (idempotente por natureza, antes até do `UNIQUE` do banco). `occurred_at` usa `orders.date_last_updated` — quando a mudança aconteceu de verdade, não quando o V3 notou (pode ser um backfill de meses atrás).

`order.returned` (do catálogo) fica de fora de propósito: devolução no Mercado Livre é modelada via `order_request.return`/API de Reclamações e Devoluções, que `orders` ainda não persiste — implementar exigiria essa API, fora do escopo desta etapa.

`dedup_key` é determinístico por natureza do evento (ex.: `order.cancelled:{id}:{status}`), não por timestamp — a mesma transição detectada duas vezes (sobreposição de janela de reconciliação, corrida entre execuções) produz a mesma chave, e o `UNIQUE` absorve o reenvio sem duplicar.

### `actions` — Central de Ações

Problema e oportunidade são o mesmo objeto com sinal invertido; separar duplicaria toda a UI.

```text
kind, severity, confidence, estimated_impact_brl,
scope (ml_account_id, sku_id, mlb_id),
evidence jsonb, recommendation,
assignee_id, status, created_by (system | user)
```

`action_decisions` guarda `baseline_snapshot jsonb` **capturado no momento da decisão** — sem ele a medição posterior é impossível. `action_outcomes` é preenchida por job agendado em 7, 15 e 30 dias.

---

## 5. RLS

**RLS habilitada em toda tabela exposta à Data API.** Nenhuma policy `using (true)` para `authenticated`.

### A RLS não é a primeira barreira — o `GRANT` é

Ordem real de avaliação: **privilégio de tabela primeiro, policy de RLS depois.** Uma tabela sem `GRANT` nega acesso a todos os papéis, inclusive à `service_role` — que ignora RLS, mas **não** ignora a falta de privilégio.

*Verificado na prática ao criar `job_runs`:* sem `GRANT`, a leitura pela Data API respondeu `42501 permission denied for table job_runs` até para a `service_role`, e o worker teria falhado em produção.

Consequências para toda tabela nova:

- conceder explicitamente o mínimo — `grant select, insert on <tabela> to service_role`, sem `update`/`delete` quando a tabela for append-only, de modo que o privilégio acompanhe o contrato em vez de depender só do trigger;
- `revoke all ... from anon, authenticated` por padrão. Quem for abrir leitura na Fase 2 precisará conceder `select` de forma deliberada — e essa concessão é o momento certo de decidir quem pode ver o quê;
- **RLS habilitada sem nenhuma policy é uma configuração válida e segura**: significa que nada passa pela Data API, e só a `service_role` (com `GRANT`) escreve.

Helpers, todos marcados `STABLE`:

```sql
current_org_id()            -- organização do usuário autenticado
has_account_access(uuid)    -- lê user_account_permissions
has_role(text[])            -- papel do usuário na organização
```

**Marcar `STABLE` corretamente é decisão de performance, não de estilo.** Funções de RLS entram no plano de toda consulta. Marcada `VOLATILE`, cada leitura vira chamada por linha — o modo mais comum de um sistema com RLS ficar lento de forma invisível. Os índices precisam suportar os predicados dos helpers.

**Toda policy nasce com teste negativo** (ver `docs/TESTING.md`): usuário sem permissão **não** vê.

**A fronteira entre domínios é imposta por `GRANT`, não por convenção de pasta.** Se `analytics` puder escrever em `inventory_balances`, a auditoria de estoque morre.

`service_role` é usada apenas por `api` e `worker`.

---

## 6. Índices

- Índice desenhado a partir da **consulta real**, nunca genérico. *Motivo, medido na V2:* uma consulta org-wide por data estourou `statement_timeout` porque os índices existentes começavam por outra coluna; 180.306 linhas ficaram sem índice adequado.
- `organization_id` é a chave de partição lógica e o primeiro campo da maioria dos índices compostos.
- Índices parciais para os predicados quentes (`where is_current`, `where status in (...)`).
- `EXPLAIN (ANALYZE, BUFFERS)` obrigatório em toda RPC nova antes do merge.
- Revisar `pg_stat_statements` ao fim de cada fase.

---

## 7. Particionamento

**Não particionar agora.** Com ~1.000 pedidos/dia, `orders` cresce ~350 mil linhas/ano — volume que o Postgres atende com índice correto. A auditoria da V2 mostrou que o problema nunca foi volume, e sim índice ausente e agregação em JavaScript.

Reavaliar particionamento por medição, começando por `domain_events`, que é a tabela com crescimento menos limitado.

O payload bruto não entra nessa conta porque não vive no Postgres (D-015).

---

## 8. Regras de migration

1. **Nenhuma alteração estrutural fora de migration versionada.** Nunca SQL manual no dashboard.
2. Migrations pequenas e revisáveis.
3. Migration destrutiva exige justificativa, impacto e estratégia de rollback ou recuperação.
4. Toda tabela nova nasce com RLS, teste negativo e índice justificado.
5. Aplicação por CI, nunca à mão. Ver `docs/DEPLOYMENT.md`.
6. Fórmula duplicada em SQL exige teste de equivalência com `@sb/domain` (D-026).

---

## 9. Convenções

- Nomes de tabela em `snake_case`, plural.
- `id uuid primary key default gen_random_uuid()`.
- `created_at` / `updated_at` `timestamptz not null default now()`, com trigger de `updated_at`.
- Dinheiro e médias em `numeric`, com **arredondamento explícito antes de cruzar para o JavaScript**. *Motivo, medido na V2:* `numeric` virando `double` e depois `ceil` produziu 25 divergências em 76 linhas na sugestão de compra.
- Enum de domínio como `text` com `check`, não `enum` nativo — alterar `enum` do Postgres é migration cara.
- Timezone de negócio: `America/Sao_Paulo`, com helper canônico único. A V2 teve bug de limite de dia por fazer conta em UTC, e chegou a ter cinco cópias do mesmo helper.

---

## 10. Carga inicial a partir da V2

Conforme D-027, pedidos e anúncios **não** são migrados — são rebaixados novamente do Mercado Livre.

A D-027 também previa ETL de vínculos, estoque e NF-e da V2. A **D-040** descartou essa parte depois de inspecionar o banco real: `product_inventory_links` (vínculos) é 100% derivado do próprio UpSeller sem nenhuma curadoria humana distinta do que o importador da V3 já produz; `stock_movements`/`product_inventory_balances` (ledger) e `stock_receipts` (NF-e) estão vazios — funcionalidade que existia no schema da V2 e nunca foi usada.

| Categoria | Situação |
|---|---|
| Vínculos SKU-MLB | Não migrado — sem dado irreprodutível (D-040) |
| Ledger e saldos de estoque | Não migrado — tabelas vazias na V2 (D-040) |
| NF-e aplicadas e seus itens | Não migrado — tabelas vazias na V2 (D-040) |
| Pedidos de compra e seu histórico | Adiado para a Fase 4 — existe 1 pedido real na V2, mas as tabelas de destino (`purchase_orders` e afins) só nascem naquela fase |

Se a migração de compras acontecer na Fase 4, a regra permanece: cada linha migrada registra a **origem V2** (tabela e chave), o script é temporário e claramente marcado como tal, e o ETL é idempotente.

---

## 11. Pendências

| Pendência | Depende de | Efeito |
|---|---|---|
| Tabelas de visitas, conversão e Ads | Fase 5B (D-032) | Modelagem adiada por decisão, não por falta de definição |
| Estrutura exata das planilhas do UpSeller | Amostra real do arquivo | Necessária antes da Fase 2 |
| Campos do Mercado Livre em cada recurso | `docs/MERCADO_LIVRE.md` | Necessária antes da Fase 3 |

Nenhuma decisão de produto segue aberta. Ver `docs/DECISIONS.md` D-027 a D-034.
