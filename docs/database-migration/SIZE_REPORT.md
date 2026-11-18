# Tamanho do banco — medição física

> Medido em 17/11/2026 pelo Database Sentinel. **Fonte: o backup de 22/10/2026
> restaurado num PostgreSQL 17.6 isolado** (imagem
> `public.ecr.aws/supabase/postgres:17.6.1.159`, container descartável
> `sentinel-dbsize`). A produção (`imvjfgnaprqsfjlnsyev`) e o Dev
> (`nmgccyqquwxecqffsidr`) estão `INACTIVE` (pausados), então não houve
> medição remota.
>
> **É uma estimativa por baixo.** Restaurar um dump reescreve as tabelas
> sem *bloat*: na produção, as linhas mortas, o WAL e o espaço que o
> autovacuum ainda não devolveu ficam por cima destes números. Também
> faltam as escritas posteriores a 22/10.
>
> O repositório é público: aqui só entram tamanhos em MB, sem contagem de
> pedidos nem receita. As contagens por tabela ficaram fora do Git.

## 1. Dump não é banco

| Medida | Valor |
|---|---|
| Arquivo `.backup.gz` | 161 MB |
| SQL descompactado (blocos `COPY`) | 904 MiB |
| **Banco restaurado (`pg_database_size`)** | **1.092 MB** |
| Schema `public` (dados + TOAST + índices) | 1.073 MB |
| …dos quais índices | 410 MB (38%) |
| `pg_catalog` | 16 MB |
| `auth`, `storage`, `realtime`, `cron`, `vault`, `supabase_migrations` | < 4 MB juntos |
| Storage (`imvjfgnaprqsfjlnsyev.storage.zip`) | 2 objetos, 55 KB (avatares) |

O banco restaurado é **20% maior que o SQL**, porque os índices não estão no
dump. A cota do Supabase Free é de **500 MB de banco**.

## 2. Por tabela (as 30 maiores do `public`)

| Tabela | Total MB | Heap | TOAST | Índices | Classe |
|---|---:|---:|---:|---:|---|
| `orders` | 143,5 | 92,5 | 0 | 50,9 | negócio |
| `order_items` | 114,5 | 87,1 | 0 | 27,3 | negócio |
| `fulfillment_stock_snapshots` | 113,3 | 46,7 | 0 | 66,6 | histórico operacional |
| `notification_recipients` | 95,9 | 35,1 | 0 | 60,8 | telemetria |
| `job_runs` | 84,8 | 61,4 | 0 | 23,3 | telemetria |
| `ml_sales_lines` | 69,3 | 45,4 | 0 | 23,9 | derivado (projeção de pedidos) |
| `domain_events` | 66,3 | 37,9 | 0 | 28,3 | histórico operacional |
| `shopee_orders` | 58,9 | 6,9 | 48,9 | 3,1 | negócio (`order_income` cru = 37 MB) |
| `daily_listing_metrics` | 49,4 | 30,0 | 0 | 19,3 | métrica derivada |
| `daily_sku_metrics` | 45,4 | 23,6 | 0 | 21,8 | métrica derivada |
| `stock_movements` | 30,9 | 13,6 | 0 | 17,2 | negócio (ledger) |
| `shipping_sales` | 25,6 | 19,5 | 0 | 6,0 | negócio |
| `erp_import_rows` | 24,7 | 20,5 | 0 | 4,2 | importação UpSeller |
| `notifications` | 21,9 | 10,1 | 0 | 11,7 | telemetria |
| `order_financials` | 17,4 | 11,1 | 0 | 6,2 | negócio |
| `daily_listing_visits` | 16,6 | 9,3 | 0 | 7,2 | métrica |
| `sync_runs` | 13,4 | 8,9 | 0 | 4,5 | telemetria |
| `support_messages` | 13,0 | 8,0 | 0,1 | 4,9 | SAC |
| `actions` | 8,8 | 7,4 | 0 | 1,4 | operacional |
| `shopee_order_items` | 6,7 | 5,2 | 0 | 1,5 | negócio |
| `listings` | 6,5 | 5,7 | 0,3 | 0,5 | cadastro |
| `erp_stock_snapshots` | 5,6 | 1,8 | 0 | 3,8 | importação |
| `sku_listing_links` | 5,4 | 3,0 | 0 | 2,3 | cadastro |
| `shipment_packages` | 4,3 | 3,5 | 0 | 0,8 | negócio |
| `listing_sales_drop` | 4,3 | 2,9 | 0 | 1,4 | derivado |
| `support_cases` | 4,0 | 1,9 | 0 | 2,0 | SAC |
| `shopee_escrow_releases` | 3,3 | 1,7 | 0 | 1,6 | financeiro |
| `support_case_events` | 3,0 | 1,8 | 0 | 1,2 | SAC |
| `support_case_links` | 2,7 | 1,3 | 0 | 1,3 | SAC |
| `daily_ads_campaign_metrics` | 2,3 | 1,4 | 0 | 0,8 | métrica |

As outras ~100 tabelas somam menos de 15 MB.

### Por classe de dado

| Classe | MB | Pode sair do banco principal? |
|---|---:|---|
| Negócio: pedidos, itens, financeiro, estoque, SAC, cadastro | ~520 | Não. Faturamento, margens, comparativos e conciliação leem 12 meses |
| Telemetria e histórico operacional: `job_runs`, `sync_runs`, `notification_recipients`, `notifications`, `fulfillment_stock_snapshots`, `domain_events`, `erp_*`, `actions` | ~440 | Em parte: retenção e compactação |
| Métricas diárias derivadas | ~114 | Recalculáveis, mas as telas dependem delas para não estourar o `statement_timeout` |

**Só a classe de negócio já passa da cota do Free.**

## 3. Maiores índices

| Índice | MB | Nota |
|---|---:|---|
| `notification_recipients_pkey` | 25,0 | (notification_id, user_id) |
| `notification_recipients_user_created_idx` | 19,6 | |
| `fulfillment_stock_snapshots_timeline_idx` | 19,5 | Quase duplicado da unique: ver OPTIMIZATION_PLAN §R5 |
| `fulfillment_stock_snapshots_unique` | 19,5 | |
| `fulfillment_stock_snapshots_sku_idx` | 17,7 | |
| `notification_recipients_user_unread_idx` | 16,3 | Parcial `read_at is null`: 80% das linhas nunca foram lidas |
| `job_runs_last_per_type_idx` | 14,5 | |
| `orders_account_freshness_idx` | 14,0 | |
| `orders_date_created_idx` | 13,9 | |

O uso real dos índices (`pg_stat_user_indexes.idx_scan`) é **desconhecido**,
porque um banco restaurado não tem estatística de leitura. Nenhum índice foi
marcado como inútil.

## 4. Crescimento

Bytes de linha (`pg_column_size`) por mês de criação, multiplicados pela
razão disco/linha de cada tabela. Ritmo de **1 a 22/10/2026**, extrapolado
para 30 dias:

| Tabela | MB/mês em disco |
|---|---:|
| `fulfillment_stock_snapshots` | ~96 |
| `notification_recipients` | ~78 |
| `job_runs` | ~70 |
| `domain_events` | ~41 |
| `stock_movements` | ~21 |
| `notifications`, `daily_listing_visits`, `sync_runs` | ~12 cada |
| `orders` + `order_items` | ~20 |
| `support_*` | ~17 |
| demais | ~40 |
| **Total** | **~420 MB/mês** |

- Cerca de **70% do crescimento é telemetria e histórico operacional**, e não
  venda.
- O volume de `orders`/`order_items` de setembro é o *backfill* de 12 meses
  (handler `backfill.orders`, 365 dias); o ritmo orgânico é o de outubro.
- A Shopee entrou ao vivo em 16/10, então o crescimento dela está
  **subestimado** (seis dias na janela).
- `shopee_orders` não entrou na tabela de crescimento: ela não tem coluna de
  criação reconhecida pelo script. **Desconhecido.**

## 5. Não medido

| Item | Motivo |
|---|---|
| Tamanho atual da produção, *bloat*, *dead tuples*, WAL | Projeto pausado |
| Uso de índices e tabelas mais lidas | Estatística não sobrevive ao restore |
| Escritas de 22/10 até a pausa | Fora do backup |
| Data da pausa | Não exposta pelo MCP; define o prazo de 90 dias para retomar (ASSESSMENT §3) |

## 6. Como reproduzir

Scripts no scratchpad da sessão (não versionados: leem dado real):
`copy_sizes.awk` (bytes por bloco `COPY`), `measure.sql`, `growth.sql`,
`columns.sql`, `redundancy.sql`, `indexes.sql`, `simulate.sql`. O
procedimento está em [SESSION_LOG.md](SESSION_LOG.md).
