# Modelo de dados — Speed Bikers Gestão V3

> Dono documental de: tabelas, colunas-chave, constraints, índices, RLS e regras de migration.
> Arquitetura geral em `docs/ARCHITECTURE.md`. Métricas derivadas em `docs/METRICS.md`.
> Status: **modelo conceitual aprovado**, incorporando as decisões D-027 a D-034. Nenhuma migration foi criada.

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
                  expires_at, consumed_at?
```

`backfill_covered_until` (migration `20260821030000`) é o checkpoint do backfill retomável — L1, mutável, não pertence a `sync_runs` (L2, histórico de cada execução, não de onde a próxima deve começar). `NULL` = nunca começou; `>= connected_at` = terminou, porque a reconciliação por janela já cobre dali para frente. `docs/HANDOFF.md` tem o desenho completo (pedaços de 7 dias, auto-encadeamento pelo `worker`).

Fluxo: o ADMIN cria a conta (`ml_accounts`) direto pelo `web`, sob RLS — é escrita simples de usuário, sem segredo envolvido. Conectar exige segredo (`client_secret` do Mercado Livre, chave de cifra dos tokens) e por isso passa pela `api`:

1. `POST /v1/ml-accounts/connect` (ADMIN) grava um `state` de uso único em `ml_oauth_states` (expira em 15 min) e devolve a `authorizationUrl`.
2. O navegador do ADMIN autoriza no Mercado Livre e é redirecionado para `GET /oauth/mercado-livre/callback` — rota pública, sem JWT nem OIDC, cuja única defesa é o `state` (mesmo espírito do webhook, D-043, mas com CSRF em vez de allowlist de IP).
3. O callback **consome o `state` atomicamente**: um único `UPDATE ... WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()`, não um `SELECT` seguido de `UPDATE` — duas chamadas concorrentes com o mesmo `state` (aba duplicada, retry do navegador) só deixam uma passar.
4. Troca o `code`, cifra `access_token`/`refresh_token` (AES-256-GCM, D-046) e grava em `ml_credentials` (`upsert` por `ml_account_id` — PK **não parcial**, diferente da armadilha de `sku_listing_links` descrita abaixo). Marca a conta `CONNECTED`.

**`ml_credentials` nunca recebe GRANT nem para `authenticated`** — só `service_role` alcança, em qualquer cenário (mesmo padrão de `ml_oauth_states`). O texto claro do token nunca existe fora do processo da `api` entre a resposta do Mercado Livre e a chamada de `encryptToken`.

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

**Fato medido na V2 que define a modelagem:** o Mercado Livre **não entrega pedido multi-linha**. `orders` e `order_items` tinham exatamente 328.211 linhas cada. Uma compra de vários itens vira **vários pedidos** ligados por `pack_id`, e 189.158 pedidos tinham um.

Consequências:

1. **Não construir rateio de `total_amount` entre itens.** A auditoria mediu divergência exatamente zero entre `sum(total_amount)` e `sum(unit_price * quantity)` em R$ 5,8 milhões e 52 mil pedidos. O rateio é matematicamente um no-op.
2. **`pack_id` é a unidade de compra real do cliente** e precisa ser cidadão de primeira classe. Frete, custo de embalagem e "quantos pedidos de verdade eu tive" só fazem sentido agrupados por pack. A V2 tinha o campo mas não a agregação.

`order_items.sku_id` é **resolvido e gravado na persistência** (D-020), junto com o registro de qual vínculo foi usado. Revincular um MLB depois não reescreve o faturamento passado.

Cancelamento e devolução **não sofrem `UPDATE` destrutivo**: mudam o status em L1 e emitem evento em L2, e é o evento que reverte o ledger.

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

Fluxo de conciliação:

```text
planilha do UpSeller -> erp_import_batches / erp_import_rows
   -> erp_stock_snapshots (saldo do ERP por SKU, com captured_at)
   -> comparação contra inventory_balances
   -> divergência? gera stock_movements tipo AJUSTE_RECONCILIACAO
                    + domain_events 'stock.balance.diverged' (crítico)
```

**O UpSeller vence, mas o ajuste é uma linha de ledger, nunca um `UPDATE` silencioso** (D-029). O saldo passa a bater e a diferença fica auditável, com origem, data e responsável.

**Uso operacional:** frequência e tamanho dos ajustes viram métrica de saúde. Ajuste grande e recorrente indica processo humano falhando, não erro de software — e é o sinal de que a V3 está pronta para assumir como ERP.

### `fulfillment_stock_snapshots` — Full

```text
(ml_account_id, inventory_id, sku_id, quantity, captured_at)
```

**Full é espelho do Mercado Livre, não ledger** (D-018). A autoridade é o ML. Eventos de Full (entrou, saiu, rompeu, repôs) saem do **diff entre snapshots consecutivos**.

Local, Full por conta, reservado e em trânsito são **quatro estados com quatro autoridades diferentes**. A interface nunca os soma cegamente num "estoque total" sem dizer o que ele contém.

### `documents` / `document_items` — NF-e

`content_hash` UNIQUE impede que o mesmo XML entre duas vezes.

Estados: `parsed` -> `applied`. **Parse e movimentação são atos distintos em momentos distintos.** Só a confirmação humana gera linhas do ledger, todas com `idempotency_key` derivada de `(document_id, item_index)`.

O arquivo vai para o Storage privado, nunca para coluna `bytea`.

### `domain_events` — o event store

```text
organization_id, ml_account_id, occurred_at,
event_type, entity_type, entity_id,
before jsonb, after jsonb,
severity, source (webhook | sync | user | system),
dedup_key UNIQUE
```

Uma tabela, sem tabelas de snapshot separadas (D-016). O catálogo de `event_type` vive em `docs/API.md`.

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
