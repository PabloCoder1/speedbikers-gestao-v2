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

Conforme D-027, pedidos e anúncios **não** são migrados — são rebaixados novamente do Mercado Livre. Vem da V2 por ETL versionado apenas o que não existe em nenhuma outra fonte:

| Migrado | Motivo |
|---|---|
| Vínculos SKU-MLB confirmados | Trabalho humano, irreproduzível |
| Ledger e saldos de estoque | Não existe fora do banco da V2 |
| NF-e aplicadas e seus itens | Histórico com implicação fiscal |
| Pedidos de compra e seu histórico | Não existe fora do banco da V2 |

Regras do ETL:

- cada linha migrada registra a **origem V2** (tabela e chave), permitindo auditoria e reversão;
- as tabelas e scripts de migração são temporários e claramente marcados como tal;
- o ETL é idempotente: rodar duas vezes não duplica.

---

## 11. Pendências

| Pendência | Depende de | Efeito |
|---|---|---|
| Tabelas de visitas, conversão e Ads | Fase 5B (D-032) | Modelagem adiada por decisão, não por falta de definição |
| Estrutura exata das planilhas do UpSeller | Amostra real do arquivo | Necessária antes da Fase 2 |
| Campos do Mercado Livre em cada recurso | `docs/MERCADO_LIVRE.md` | Necessária antes da Fase 3 |

Nenhuma decisão de produto segue aberta. Ver `docs/DECISIONS.md` D-027 a D-034.
