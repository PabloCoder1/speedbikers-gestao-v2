# Auditoria técnica — SpeedBikers Gestão V2

Data: 17/08/2026. Branch: `auditoria/otimizacao` (já existia, com working tree limpo; não foi necessário criar). Escopo lido: raiz, configurações, `src/`, `scripts/`, `supabase/` e `public/`, exceto `node_modules/` e `.next/`.

Este documento cobre duas fases: o diagnóstico e, depois de autorização explícita, a **aplicação** das correções — inclusive migrations executadas contra o Supabase de produção (`eeramcpouarfwagxigtz`, `sa-east-1`).

**Validação final:** `npx tsc --noEmit` limpo; `npm test` 58/58; `npm run build` compilou as 28 rotas; `npm run lint` código 0, com 10 warnings preexistentes de parâmetros obrigatórios de Server Action não usados (`src/features/ml-sync/actions.ts:41`, `:160`, `:209`, `:263`, `:490`). 50 migrations locais, 0 pendentes no remoto, working tree limpo.

---

## 0. A CORREÇÃO QUE OS DADOS DERRUBARAM

A instrução tratava como bug conhecido o uso de `unit_price * quantity` em vez de `total_amount` rateado. **Medi contra produção antes de reescrever, e a divergência é exatamente zero.**

| Janela | Pedidos | `sum(total_amount)` | `sum(unit_price × qty)` | Diferença |
|---|---|---|---|---|
| 7 dias | 7.128 | R$ 734.791,72 | R$ 734.791,72 | R$ 0,00 |
| 60 dias | 52.594 | R$ 5.800.306,61 | R$ 5.800.306,61 | R$ 0,00 |

Zero pedidos divergentes nos dois recortes. A razão é estrutural: `orders` e `order_items` têm **exatamente 328.211 linhas cada**. O Mercado Livre não entrega pedidos multi-linha — uma compra de vários itens vira vários pedidos ligados por `pack_id` (189.158 pedidos têm `pack_id`). Com uma linha por pedido, `unit_price × quantity` é identicamente igual a `total_amount`, e o rateio é matematicamente um no-op.

Consequência prática: **o rebuild histórico dos 328 mil pedidos não foi executado**, porque não mudaria número nenhum. Reescrevi a função mesmo assim — pelo filtro de data indexável, que é o ganho real, e para trocar a premissa (`total_amount` como âncora) caso o ML mude o formato. Verifiquei depois de aplicar: **zero dias históricos alterados**.

---

## 1. FALHAS ENCONTRADAS

| Severidade | Arquivo:linha | O que está errado | Consequência prática no negócio |
|---|---|---|---|
| crítica — **corrigida** | `20260810125948_add_resumable_listing_sync.sql:140-204` e mais 5 RPCs de claim | **Achado novo.** Seis funções de claim readquiriam um job com lease expirado sem incrementar contador algum. `retry_count` só cresce no `catch` do worker em Node; se a Function for morta pelos 60 s de `maxDuration` antes do `catch`, nada é persistido. Quatro claims já contavam certo (`ml_offer_refresh_job`, `ml_fulfillment_refresh_job`, `operational_alert_job`, `product_inventory_reconcile_job`). | Job preso em `running` para sempre, nunca atingindo `max_retries`, nunca virando falha, nunca alertando — consumindo uma Function por minuto. Corrigido em `d9fb6bf`. **Nenhum job estava preso no momento da correção** (verificado): a correção é preventiva. |
| crítica — **corrigida** | `src/lib/supabase/proxy.ts:102-107` | O Proxy exigia sessão em tudo exceto `/login` e o worker interno. O webhook do ML nunca envia cookie, então o POST recebia 307 para `/login` e nunca chegava ao handler. | Notificações de preço, promoção e Full não entravam nas filas; estados operacionais desatualizados apesar de o ML ter enviado o evento. Corrigido em `688f13d`, liberando **só** o caminho exato, com testes cobrindo os casos negativos. |
| ~~crítica~~ **não confirmada** | `20260813153823_align_gross_revenue...sql:208-217` | Receita por `unit_price * quantity`. **A medição da seção 0 mostra divergência zero.** | Nenhuma. O relatório anterior classificava isto como crítico; a medição contra produção não sustenta. |
| alta — **corrigida** | `src/features/ml-sync/sync-orders-preview.ts:1273-1295`, `sync-listings-preview.ts:957-1015` | Linhas filhas que sumiam de uma versão posterior seguiam com `is_current = true`. A varredura era decidida pelo número de linhas **filhas** recebidas — em anúncios dentro de `if (variationRows.length > 0)`, em pedidos inexistente. O caso que importa é justamente o de zero filhos. | Unidades e receita rateada atribuídas a itens fora do pedido; estoque e preço ligados a variações obsoletas. Corrigido em `dc6b002`, com testes de regressão. |
| alta — corrigida | `src/lib/date/sao-paulo.ts:59-97` | Limites de dia civil produzidos com operações UTC em pontos que representam datas de negócio. | Pedidos perto da meia-noite no dia errado. Corrigido em `2a0a14b`. |
| alta — corrigida | `src/features/ml-sync/sync-recent-orders.ts:386-437` | Teto de 12 páginas/600 pedidos, abandonando a continuidade da janela. | Em picos acima de 600 pedidos/24 h, pedidos podiam nunca ser importados. Corrigido em `e395400`. |
| alta — corrigida | `process-listings-sync-worker.ts:330-360` e 2 workers | Checkpoints/liberação de lease podiam falhar sem tratamento. | Worker reportava sucesso sem persistir estado. Corrigido em `4f569c0`, `de5b486`, `c85fa9b`. |
| média — **corrigida** | `src/app/api/mercado-livre/offer-prices-status/route.ts:83-146` | **Achado novo.** Carregava todos os `ml_listings` atuais e todos os `ml_offer_price_states` em páginas de 1.000 para produzir ~8 contagens em JavaScript. **Medido: 10.286 linhas por chamada.** | Corrigido em `205b197`. Medido, 5 execuções aquecidas: **mediana 119 ms contra 1.343 ms** — 11×. As seis contagens conferidas idênticas à lógica antiga. |
| média — **corrigida** | `20260817121000_add_compact_stock_read_models.sql:132-175` | A Central de Alertas serializava a lista inteira; filtro e corte aconteciam em JavaScript. **Medido: 6.456 alertas, 5.243 em aberto**, todos trafegados por carregamento. | Corrigido em `ad872d8`: escopo, severidade, busca e limite no SQL. |
| média — **corrigida** | `20260810183503_create_daily_sales_metrics.sql:182-194` | **Achado novo.** `get_dashboard_top_products` agrega por `organization_id` + faixa de `metric_date`; os índices existentes começam por `ml_account_id` e `product_id`. **180.306 linhas sem índice adequado.** | Corrigido em `1c55de0`. Evidência colateral: durante a auditoria, uma consulta org-wide por data em `orders` estourou o `statement_timeout`. |
| média — **corrigida** | 8 × `select("*")` em `src/app/api/stock/debug/route.ts` | Devolvia `raw_payload` de catálogo, relacionamentos e estados Full. | Corrigido em `8c8e918`: colunas explícitas conferidas contra o schema real via OpenAPI do PostgREST, com `?raw=1` preservando o payload bruto quando ele é a evidência procurada. |
| média — **corrigida** | 5 waterfalls em `get-dashboard-overview.ts`, `get-product-dashboard.ts`, `get-product-listings.ts` | Consultas independentes encadeadas. | Corrigido em `229e98f`: 8 consultas sequenciais viraram 3 grupos paralelos. |
| média | `src/features/dashboard/get-product-offer-history.ts:469-529` | Histórico inteiro carregado e transformado, cortado pelo `limit` só no Node. | Produtos antigos cada vez mais caros de abrir. **Não corrigido** — ver §3. |
| média | `20260810164405_create_orders_and_order_items.sql:45`, `:173` | `raw_payload` obrigatório, JSON integral de 328 mil pedidos e itens. | Storage, I/O e vacuum. **Não alterado** — política de retenção. Ver §3. |
| média | `src/features/ml-sync/sync-recent-orders.ts:198-210` | Contas sem `listings_full=succeeded` puladas com `continue`, sem registro. | Conta parece "sem movimento" em vez de bloqueada por pré-condição. **Não corrigido** — ver §3. |
| média | `package.json:15` | `exceljs` depende de `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq); o fix automático é semver-major. | **Não aplicado** — o downgrade quebraria a importação XLSX. Ver §3. |
| média | `20260814211000_add_stock_intelligence_workers.sql:777-784` | Cinco despachantes por minuto além dos de sync/preço. | Polling domina o banco com filas vazias. **Não alterado** — consolidação arquitetural. |
| **média — descoberta durante a verificação** | `src/features/ml-sync/sync-recent-orders.ts:47-88` | As métricas do **dia em curso** ficam defasadas. Ao rebuildar, `gmr` registrava 28 pedidos / R$ 2.201,67 quando `orders` já tinha **110 pedidos / R$ 9.532,98** — 4× a menos. Com uma conta por invocação do cron e intervalo mínimo de 4 min, cada conta é sincronizada a cada ~16 min na melhor hipótese. | O dashboard subestima o dia corrente entre sincronizações. Não é erro de cálculo: é latência estrutural do agendamento. **Não corrigido** — ver §3. |
| baixa | `src/integrations/mercado-livre/orders.ts:133-176` | Paginação por offset sobre resultado `date_desc`. | Pedidos novos durante a varredura deslocam o offset; sob pico, um pedido pode escapar entre páginas. |
| baixa — corrigida | `src/lib/supabase/admin.ts:1` | Faltava `import "server-only"` no ponto do segredo. | Corrigido em `9c2928d`. |
| baixa — corrigida | 5 cópias do helper de data | Lógica de "hoje em São Paulo" duplicada. | Corrigido em `c8d9f2a`. |
| baixa | `.env.local` vs `.env.example` | `APP_ENCRYPTION_KEY` existe no ambiente local mas não está documentado no `.env.example`. | Um ambiente novo sobe sem essa variável e só descobre em runtime. |

### Cobertura estrutural verificada

- **Rotas:** 28 páginas/handlers, todos autenticados (sessão + papel, `getAdminApiAccess`, `getStockMutationAccess`, ou segredo com `timingSafeEqual`). A única exceção era o webhook, agora corrigida deliberadamente.
- **RLS:** 44 tabelas públicas criadas, 44 com RLS habilitada (varredura multilinha, já que o SQL do projeto quebra os comandos em várias linhas). Nenhuma policy `using (true)` para `authenticated`, nenhuma recursiva.
- **Segredos:** nenhum versionado. Não existe `oauth-atual.txt`. `.env.local` coberto por `.gitignore:38-39`.
- **Tipos:** zero `any` em todo o `src/`.
- **Bundle:** nenhum import integral de lodash/date-fns/ícones. `exceljs`, `jszip` e `fast-xml-parser` só em módulos server-only. Todas as dependências em uso.
- **`use client`:** 17 arquivos, todos justificados. Nenhum removível.

---

## 2. O QUE FOI CORRIGIDO

**Aplicado nesta fase (código):**

- `688f13d` — `fix(webhook)`: libera o caminho exato do webhook no Proxy, com testes negativos para as rotas administrativas vizinhas.
- `dc6b002` — `fix(sync)`: invalida linhas de pedido e variações obsoletas, com testes de regressão.
- `8c8e918` — `perf(stock)`: colunas explícitas no endpoint de debug, com `?raw=1`.
- `d9fb6bf` — `fix(sync)`: contador de reaquisição de lease nas seis RPCs + reset nos workers.
- `205b197` — `perf(prices)`: cobertura de preços agregada em SQL.
- `c8d9f2a` — `fix(timezone)`: helper canônico de data.
- `229e98f` — `perf(dashboard)`: paraleliza consultas independentes.
- `9c2928d` — `fix(security)`: `server-only` no cliente privilegiado.

**Aplicado nesta fase (migrations executadas em produção):**

| Migration | Commit | O que faz |
|---|---|---|
| `20260817180000_bound_lease_reclamation` | `d9fb6bf` | `lease_reclaim_count` + dead-letter em 6 RPCs |
| `20260817181000_add_organization_product_metric_index` | `1c55de0` | Índice covering `(organization_id, metric_date)` |
| `20260817182000_make_sales_metrics_date_filter_sargable` | `71a41c5` | Filtro de data indexável + receita ancorada em `total_amount` |
| `20260817183000_paginate_operational_alerts` | `ad872d8` | `get_operational_alerts_page` + índice de recência |
| `20260817184000_add_offer_price_coverage` | `205b197` | `get_offer_price_coverage` |

**Da passagem anterior, verificados e mantidos:** `2a0a14b`, `5a10e7a`, `6e4c0e4`, `4f569c0`, `e395400`, `de5b486`, `c85fa9b`, `32f7915`, `b745a22`, `65f32c4`.

### Como cada mudança de banco foi verificada

- **Receita:** snapshot de `daily_account_metrics` e `daily_product_metrics` das 4 contas em 30 dias → aplicar → rebuild → diff linha a linha. **Zero dias históricos alterados.** Só o dia corrente mudou, por estar defasado, e depois bate exatamente com `orders`.
- **Cobertura de preços:** as seis contagens comparadas contra a implementação antiga — idênticas. Benchmark de 5 execuções aquecidas.
- **Alertas:** predicados validados contra as tabelas (5.243 abertos = 1.045 críticos + 2.503 atenção + 1.695 info).
- **Lease:** `claim_next_upseller_import` executada contra produção com fila vazia, confirmando que dead-letter, CTE e incremento referenciam colunas reais.

### Uma correção que fiz a mim mesmo

Minha primeira varredura das RPCs de claim disse "quatro funções sem contador" e classificou `claim_next_ml_offer_refresh_job` como uma delas. O script tinha um bug: casava também os `revoke ... on function`, e o último match sobrescrevia o correto. **São seis funções sem contador, e `ml_offer_refresh_job` não é uma delas** — ela já contava. A migration cobre as seis certas.

Também rebaixei o índice de `daily_account_metrics`, que eu havia proposto: com 1.478 linhas e crescimento de ~1.460/ano, seq scan é a escolha correta. Só `daily_product_metrics` (180.306 linhas) recebeu índice.

---

## 3. O QUE NÃO FOI CORRIGIDO E POR QUÊ

### 3.1 Rebuild histórico de receita — **desnecessário, não pendente**

Não é dívida: a medição da seção 0 e o diff pós-aplicação provam que nenhum dia fechado muda. Não há o que executar.

### 3.2 Defasagem do dia corrente (achado novo)

O sync recente processa **uma conta por invocação** com intervalo mínimo de 4 min. Com 4 contas, cada uma espera ~16 min. Entre execuções, o dashboard subestima o dia.

1. Decidir o alvo de frescor (ex.: no máximo 5 min de atraso).
2. Opção A, barata: processar todas as contas devidas na mesma invocação, respeitando o orçamento de 48 s por burst.
3. Opção B: aumentar a frequência do `pg_cron` para `orders_recent` e manter uma conta por vez.
4. Instrumentar: registrar em `sync_runs.metadata` a distância entre `now()` e o `date_created` mais recente importado.

Não corrigi porque muda o desenho do agendamento — mudança de arquitetura.

### 3.3 Histórico de ofertas paginado no Node

Criar RPC com `lag(...) over (partition by offer order by captured_at)` e limite no SQL, devolvendo no máximo `limit` eventos mais a linha anterior necessária à comparação; substituir a leitura integral de `get-product-offer-history.ts:469-517`. Não fiz porque exige redesenhar o contrato de comparação entre snapshots, com risco de alterar o que a tela mostra.

### 3.4 Retenção de `raw_payload`

Definir prazo e necessidade legal. Se descartável, particionar/arquivar e limpar incrementalmente — nunca um `UPDATE` global. Não alterado: é política de retenção com implicação fiscal.

### 3.5 Observabilidade de skips

Persistir resultado explícito para contas bloqueadas pela pré-condição, em vez do `continue` de `sync-recent-orders.ts:198-210`. Sugestão: código `listings_prerequisite_pending` em um read model, sem criar `sync_run` falso.

### 3.6 Consolidação dos despachantes

Cinco despachantes por minuto com filas vazias. Consolidar apenas o dispatch/early-exit. Mudança arquitetural.

### 3.7 Dependências

Não rodar `npm audit fix --force`. Testar um override de `uuid` compatível com `exceljs`, exercitando os fixtures XLSX de `import-parser.test.ts`; se incompatível, acompanhar o upstream.

### 3.8 Paginação por offset no ML

Migrar para paginação por `date_created` com cursor, eliminando o deslocamento de offset sob pico.

### 3.9 `.env.example`

Acrescentar `APP_ENCRYPTION_KEY`, presente no ambiente local e ausente do exemplo.

---

## 4. VELOCIDADE

### a) Ganhos no código da aplicação

| Item | Esforço | Ganho |
|---|---|---|
| Cobertura de preços em SQL (`205b197`) | feito | **Medido:** mediana 119 ms vs 1.343 ms (11×); 10.286 linhas por chamada eliminadas |
| Alertas filtrados no banco (`ad872d8`) | feito | **Medido em volume:** 5.243 alertas serializados → no máximo 250 |
| Paralelização dos dashboards (`229e98f`) | feito | **Medido em round-trips:** 8 sequenciais → 3 grupos. Latência: estimada |
| Debug com colunas explícitas (`8c8e918`) | feito | Elimina `raw_payload` de 3 tabelas na resposta padrão |
| Paginar histórico de ofertas no SQL | médio | Estimado alto para produtos antigos |

### b) Ganhos no banco

| Item | Esforço | Ganho |
|---|---|---|
| Índice organizacional (`1c55de0`) | feito | Estimado alto: 180.306 linhas passam a ter índice; INCLUDE permite index-only scan |
| Filtro de data sargável (`71a41c5`) | feito | Estimado alto no rebuild: `orders_account_date_idx` passa a ser utilizável |
| Contador de lease (`d9fb6bf`) | feito | Não é latência, é **capacidade**: elimina Functions consumidas em loop |
| Retenção de `raw_payload` | alto | Estimado alto em storage/I/O — `orders` e `order_items` são as maiores tabelas |
| Consolidar despachantes | médio | Estimado médio: o problema é frequência acumulada |

### c) Infraestrutura — o gargalo **não** é a Vercel

- **Região: descartado com dado.** `vercel.json:1-3` fixa `gru1`; o Supabase está em `sa-east-1`. Ambos São Paulo, sem salto inter-região. O suspeito número 1 não se sustenta.
- **Timeout:** `maxDuration = 60` com bursts internos encerrando em 48 s e `MAX_BATCHES_PER_INVOCATION`. A arquitetura respeita o limite. O problema real era **não se recuperar** quando o limite era atingido — e isso era de banco, agora corrigido.
- **Tempo real de rebuild medido:** 2,6 s a 8,3 s por conta em 30 dias — folga confortável dentro dos 60 s.
- **pg_cron:** usado corretamente. O que falta é consolidar o polling.
- **Sair da Vercel: não sustentado.** Todos os gargalos medidos eram agregação em JavaScript, índice ausente e polling — nenhum resolvido por trocar de host. Reconsiderar só se, após estas correções, o p95 do worker exceder 60 s de forma consistente; nesse caso migram-se **apenas os workers de sync**, e páginas, Server Actions e APIs interativas permanecem.

> Números marcados como **medido** vêm de execução real contra produção em 17/08/2026. Reduções de round-trip são contagens de código. Onde digo "estimado", não medi.

---

## 5. TOP 5 AÇÕES RESTANTES

As três ações críticas do diagnóstico anterior já foram executadas. O que resta, por retorno sobre esforço:

1. **Reduzir a defasagem do dia corrente** — esforço médio, retorno alto. É o maior erro visível hoje no dashboard: 28 pedidos exibidos contra 110 reais. §3.2.
2. **Definir retenção de `raw_payload`** — esforço alto, retorno alto. As duas maiores tabelas do banco, com limpezas históricas já entre as queries mais caras. §3.4.
3. **Paginar o histórico de ofertas no SQL** — esforço médio, retorno alto e crescente. §3.3.
4. **Consolidar os despachantes de polling** — esforço médio, retorno médio de custo SQL. §3.6.
5. **Resolver o alerta de `uuid`/`exceljs` com override testado** — esforço baixo, retorno de segurança. §3.7.
