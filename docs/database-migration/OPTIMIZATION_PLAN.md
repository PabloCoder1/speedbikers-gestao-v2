# Plano de otimização do banco

> Database Sentinel, 17/11/2026. Base: [SIZE_REPORT.md](SIZE_REPORT.md).
> Nada daqui foi aplicado no Dev nem em produção. Cada item vira migration
> versionada, com teste, na ordem da §4. A meta é parar o crescimento por
> telemetria. Dado de negócio fica intacto.

## 1. O que cresce sem necessidade, e por quê

### R1. `fulfillment_stock_snapshots`: 94% das linhas repetem a anterior

- **Medido:** a quantidade de 94,3% das linhas é igual à da captura anterior
  do mesmo inventário. A captura grava uma linha por inventário em toda
  rodada, ~9,3 mil linhas/dia em outubro, e ~96 MB/mês em disco.
- **Por que não basta gravar só a mudança:** nove RPCs leem o "Full atual" como
  `captured_at >= now() - 3 days` + `distinct on (ml_account_id, inventory_id)`
  (D-465, `20261015100000_full_atual_pelo_indice.sql`). Um inventário parado há
  4 dias sumiria das telas.
- **Proposta, em duas fases:**
  1. *Compactação do passado* (job de manutenção diário): fora da janela de
     **14 dias**, apagar a linha cuja quantidade é igual à da captura anterior
     do mesmo `(ml_account_id, inventory_id)`. A primeira linha de cada
     inventário e cada mudança ficam. Isso preserva a série reconstruível
     ("quanto havia no instante T" = a última linha com `captured_at <= T`).
  2. *Origem* (opcional, depois): tabela `fulfillment_stock_current` com o
     último valor por inventário, para as nove RPCs. A tabela de histórico
     passa a receber só mudanças. É um refactor de RPC e precisa de ensaio
     como `authenticated` em cada forma de chamada (D-305).
- **Antes de aplicar:** ler `get_sku_dashboard` e `get_stock_balances` (usam
  `fulfillment_stock_snapshots_sku_idx`) e o detector de eventos
  (`ml-fulfillment-fetch.ts`, que lê a última captura) e confirmar que nenhum
  deles conta capturas: "dias com ruptura" contados por linha mudariam.
- **Ganho em regime:** de ~96 MB/mês para ~45 MB fixos (14 dias) mais
  ~6 MB/mês de mudanças.

### R2. `notification_recipients`: 80% nunca lidas

- **Medido:** 80% das entregas têm `read_at` nulo, com ~4,2 destinatários por
  notificação. A maior parte vem de `listing.available_quantity.changed`, que o
  catálogo classifica como **informativo**
  (`packages/domain/src/events/catalog.ts`). A tela já trata esse volume como
  problema de produto (`20260923200000_notificacoes_triagem.sql`).
- **Causa:** o evento informativo vira notificação com destinatário. Ele
  devia ficar só em `domain_events`.
- **Proposta:** (a) **decisão do dono**: evento informativo não gera
  `notification_recipients`, ou gera só para quem ativou a preferência;
  (b) retenção de **60 dias** para entrega lida e de **90 dias** para não
  lida. A notificação em si fica.
- **Ganho:** com (a), a maior fonte de escrita da tabela some. Sem (a), (b)
  limita a tabela a ~2 meses (~150 MB com índices no ritmo atual).

### R3. `job_runs`: telemetria sem retenção

- **Medido:** `sync.webhook.received` com `status = done` é ~60% das linhas
  de outubro. A tabela é append-only por gatilho (`job_runs_no_delete`, D-221).
  A D-222 limpou o entulho uma vez e decidiu "não é política de retenção".
- **Proposta (pede nova decisão D-xxx, porque inverte a D-222):** função
  `private.expurgar_telemetria()` em `security definer`, agendada no
  `pg_cron`. Ela desliga o gatilho só na própria transação e apaga
  `status <> 'failed'` com mais de **30 dias**. Falha nunca sai. O teste de
  integração da D-221 (gatilho de pé depois) continua valendo. O webhook sem
  trabalho pode ter janela menor (7 dias): nenhuma tela lê mais que 7 dias
  dele (conferir em `system-health`).
- **Ganho:** ~70 MB/mês vira ~70 MB fixos.

### R4. `sync_runs`: o mesmo, em menor escala

Retenção de 90 dias, menos falha e `partial`. A tela `/sincronizacao` mostra a
cobertura recente. Antes, conferir se `latest_record_at` antigo é lido por
alguma RPC de cobertura (`20260921114355_catalog_sync_history_coverage.sql`).

### R5. Índice quase duplicado em `fulfillment_stock_snapshots`

`fulfillment_stock_snapshots_timeline_idx (ml_account_id, inventory_id,
captured_at desc)` tem as colunas da unique `(…, captured_at)`, que é toda
ASC. A migration `20260928160000` o deixou de fora de propósito: a
varredura reversa da unique dá DESC,DESC,DESC e não a ordem mista do
`distinct on`. **Proposta:** trocar a constraint por um **índice unique na
ordem do `distinct on`** e apagar o `timeline_idx`. Ganho de ~19,5 MB e uma
escrita de índice a menos por captura. Pede o ensaio que a migration de 28/09
pediu: as nove RPCs como `authenticated`, plano antes e depois. O
`ON CONFLICT` por colunas continua inferindo o índice unique.

### R6. `domain_events`: `listing.available_quantity.changed`

~44 mil eventos em 22 dias, ~90% do volume e ~41 MB/mês. Consumidores:
`get_sku_correlated_events`, `get_sku_timeline`, a formatação da tela de
notificações. **Não proponho retenção sem decisão do dono:** é a trilha de
auditoria da D-016 ("sem tabelas de snapshot"). Duas opções para ele:
(a) 180 dias só para este tipo de evento; (b) arquivar em Parquet/JSON no
Storage ou no Neon, de onde a tela de timeline leria sob demanda.

### R7. Payloads crus

- `shopee_orders.order_income` (37 MB comprimidos) guarda o retorno inteiro
  de `get_escrow_detail` ao lado das colunas extraídas
  (`20261013160000_financeiro_shopee.sql`). É **trilha de conciliação
  financeira**: fica. Se precisar de espaço, arquivar o de pedidos com
  `escrow` liberado há mais de 180 dias.
- `erp_import_rows.payload` (~14 MB): linha crua da planilha do UpSeller.
  Arquivável depois que o lote foi aplicado e conciliado há 90 dias. A D-030
  já previa "90 dias quente mais arquivamento frio" para payload bruto.

## 2. O que NÃO mexer

- `orders`, `order_items`, `ml_sales_lines`, `order_financials`,
  `shipping_sales`, `stock_movements`, `shopee_*` (exceto §R7), `support_*`:
  são faturamento, margem, conciliação, SAC e auditoria.
- `daily_*_metrics`: recalculáveis, mas as RPCs de 12 meses dependem delas
  para caber no `statement_timeout` (D-499).
- Índices de baixo uso aparente: sem `idx_scan` real, não há base.

## 3. Projeção depois de R1–R5

| | Agora (22/10) | Regime com R1–R5 |
|---|---:|---:|
| Negócio + métricas | ~634 MB | cresce ~70–110 MB/mês (Shopee subestimada) |
| Telemetria e histórico operacional | ~440 MB | ~300 MB fixos (R1 45 · R2 150 · R3 70 · R4 10 · resto) + `domain_events` crescendo ~41 MB/mês sem R6 |
| **Total** | **~1,09 GB** | **~0,95 GB no 1º mês, depois +110–150 MB/mês** |

A simulação física no container (R1–R5 aplicadas "em 22/10") baixou o
banco de 1.092 para **979 MB**. O ganho imediato é pequeno porque quase
toda a telemetria tem menos de 60 dias. O ganho grande é o crescimento
evitado: ~250 MB/mês.

**Conclusão: nenhuma otimização segura põe este banco abaixo de 500 MB, nem
de 350 MB.** A otimização serve para conter o custo de disco em qualquer
plano e para não estourar os 8 GB do Pro antes de ~4 anos.

## 4. Ordem

1. R5, o índice. **Escrita (D-720, `20261117182500`)**, testada e medida no
   backup: índices de 67 para 47 MB, planos iguais.
2. R3 e R4, a retenção de telemetria. **R3 escrita (D-721,
   `20261117182600`)**: retenção de 30 dias, agendamento como ato do dono.
   R4 (`sync_runs`) pendente.
3. R1 fase 1, a compactação do Full (ensaio das nove RPCs + leitura dos
   consumidores de série).
4. R2 (a): decisão do dono sobre notificação informativa. Depois R2 (b).
5. R6 e R7: só com decisão do dono e destino de arquivo definido.
