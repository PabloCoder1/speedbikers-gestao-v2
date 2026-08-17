# Auditoria técnica — SpeedBikers Gestão V2

Data da auditoria: 17/08/2026. Branch: `auditoria/otimizacao`. Escopo lido: raiz, configurações, `src/`, `scripts/`, `supabase/` e `public/`, exceto `node_modules/` e `.next/`. A inspeção remota foi somente leitura e confirmou o projeto Supabase `eeramcpouarfwagxigtz`, em `sa-east-1`.

## 1. FALHAS ENCONTRADAS

| Severidade | Arquivo:linha | O que está errado | Consequência prática no negócio |
|---|---|---|---|
| crítica | `src/lib/supabase/proxy.ts:102-107`, `src/proxy.ts:10-12`, `src/app/api/mercado-livre/notifications/route.ts:13-26` | O Proxy protege tudo exceto `/login` e o worker interno. Assim, o webhook público do Mercado Livre também passa pelo Proxy e, sem cookie de usuário, recebe redirect para `/login` antes do handler. | Notificações de preço, promoção e Full podem não entrar nas filas; os estados operacionais ficam desatualizados apesar de o ML ter enviado o evento. Não foi alterado automaticamente porque é uma fronteira de autenticação/webhook. |
| crítica | `supabase/migrations/20260813153823_align_gross_revenue_with_ml_vendas_brutas.sql:208-217`, `supabase/migrations/20260813153823_align_gross_revenue_with_ml_vendas_brutas.sql:395-449` | A função vigente ainda calcula receita por `order_items.unit_price * quantity`; o valor oficial é `orders.total_amount`, rateado entre as linhas do pedido para métricas por produto. O filtro também converte cada `date_created` para `date`, dificultando o uso do índice existente. | Faturamento, ticket e receita por produto podem divergir do Mercado Livre; dashboards podem tomar decisões comerciais com números errados e o rebuild lê mais linhas do que deveria. A substituição proposta está em `auditoria/migrations-propostas.sql:25-221`. |
| alta | `src/features/ml-sync/sync-orders-preview.ts:1273-1349`, `src/features/ml-sync/sync-orders-preview.ts:1353-1378` | Cada linha recebida é marcada `is_current=true`, mas linhas antigas do mesmo pedido que desapareceram de uma versão posterior não são invalidadas. | Unidades e rateio de receita podem permanecer atribuídos a itens que já não compõem o pedido, inflando métricas de produto. |
| alta | `src/features/ml-sync/sync-listings-preview.ts:957-1015` | A invalidação de variações antigas só roda quando `variationRows.length > 0`. Se um anúncio deixa de ter variações, todas as antigas podem continuar `is_current=true`. | Estoque, preço e vínculo podem continuar associados a variações obsoletas, criando divergência por SKU. |
| alta — corrigida | `src/lib/date/sao-paulo.ts:59-97`, `src/features/ml-sync/actions.ts:413-418`, `src/features/ml-sync/actions.ts:618-634` | Limites de dia civil eram produzidos com operações UTC/`toISOString()` em pontos que representam datas de negócio. | Pedidos próximos da meia-noite podiam cair no dia errado e janelas de backfill podiam avançar/encerrar incorretamente, inclusive em datas históricas com horário de verão. Corrigido no commit `2a0a14b`. |
| alta — corrigida | `src/features/ml-sync/sync-recent-orders.ts:441-609`, `src/features/ml-sync/sync-recent-orders.ts:618-654` | O sincronismo recente tinha teto de 12 páginas/600 pedidos e abandonava a continuidade da mesma janela. | Em picos com mais de 600 pedidos em 24 horas, pedidos posteriores podiam nunca ser importados. Agora salva `partial`, cursor e janela, e retoma a mesma execução. Corrigido no commit `e395400`. |
| alta — corrigida | `src/features/ml-sync/process-listings-sync-worker.ts:330-360`, `src/features/ml-sync/process-orders-backfill-worker.ts:340-397`, `src/features/ml-sync/process-orders-dashboard-backfill-worker.ts:344-401` | Atualizações de checkpoint/liberação de lease podiam falhar sem que a falha de persistência fosse tratada; uma atualização de retry de listings também não estava protegida pelo `lease_id`. | O worker poderia informar progresso/sucesso sem ter persistido o estado correto, deixando corrida de workers ou jobs presos até expirar o lease. Corrigido nos commits `4f569c0`, `de5b486` e `c85fa9b`. |
| média — corrigida | `src/features/stock/persist-fulfillment-stock.ts:61-115` | A alteração de um estado Full enfileirava alertas produto a produto, criando round-trips dentro do conjunto afetado. | Atualizações de um mesmo inventory podiam consumir tempo desnecessário da Function e atrasar a fila operacional. A consulta de jobs ativos e o insert agora são em lote. Corrigido no commit `32f7915`. |
| média — corrigida | `src/features/ml-sync/sync-recent-orders.ts:147-184`, `src/features/ml-sync/sync-recent-orders.ts:198-212` | A seleção da próxima conta fazia duas queries de `sync_runs` por conta conectada. | A latência do cron crescia linearmente com o número de contas antes de qualquer chamada ao ML. Agora os runs são carregados uma vez e reduzidos por conta em memória. Corrigido no commit `b745a22`. |
| média — corrigida | `src/app/api/upseller/imports/[importId]/commit/route.ts:35-43` | O burst iniciado em background capturava a exceção, mas registrava somente um código fixo, sem a mensagem real. | Incidentes de importação ficavam sem diagnóstico acionável nos logs da Vercel. Corrigido no commit `65f32c4`. |
| média | `supabase/migrations/20260817121000_add_compact_stock_read_models.sql:132-175`, `src/features/stock/get-operational-alerts.ts:304-325` | A Central de Alertas agrega e serializa toda a lista correspondente ao filtro, sem limite ou cursor. O ambiente remoto tinha 6.339 alertas estimados na medição. | O payload e o tempo da página crescem sem limite; a tela tende a se aproximar do `statement_timeout` de 8 s conforme o histórico aumenta. A RPC paginada proposta está em `auditoria/migrations-propostas.sql:265-353`. |
| média | `src/features/dashboard/get-product-offer-history.ts:469-529`, `src/features/dashboard/get-product-offer-history.ts:678-706` | Todo o histórico de snapshots de um produto é carregado, transformado e só depois cortado pelo `limit` no Node. | Produtos antigos ficam progressivamente mais caros para abrir e transferem linhas que nunca aparecem na UI. |
| média | `src/app/api/stock/debug/route.ts:25-39`, `src/app/api/stock/debug/route.ts:61-80` | O endpoint de debug usa vários `select("*")` e devolve `raw_payload`, inclusive de relacionamentos e estados. É admin-only, mas o contrato traz muito mais do que a investigação normalmente precisa. | Diagnósticos podem gerar respostas grandes, pressionar memória/latência e expor dados brutos desnecessários a qualquer administrador. |
| média | `src/features/ml-sync/sync-recent-orders.ts:190-206` | Contas sem `listings_full=succeeded` são puladas sem persistir motivo, contador ou evento de observabilidade. | Uma conta pode ficar indefinidamente sem pedidos recentes e parecer apenas “sem movimento”, em vez de mostrar que a pré-condição de anúncios não foi satisfeita. |
| média | `package.json:15`, `package-lock.json:4905-4919`, `package-lock.json:8632-8640` | `npm audit` encontrou duas vulnerabilidades moderadas: `exceljs` depende de `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq). O fix automático oferecido rebaixa `exceljs` para 3.4.0 e é semver-major. | Há risco de supply chain/parsing; aplicar o downgrade cego pode quebrar a importação XLSX, uma operação crítica. |
| média | `supabase/migrations/20260810164405_create_orders_and_order_items.sql:45`, `supabase/migrations/20260810164405_create_orders_and_order_items.sql:173`, `src/features/ml-sync/sync-orders-preview.ts:1062`, `src/features/ml-sync/sync-orders-preview.ts:1341` | `raw_payload` é obrigatório e persiste o JSON integral para pedidos e itens. No banco medido, `orders` ocupa 846 MB e `order_items` 438 MB, muito acima das tabelas analíticas. | Aumenta storage, I/O, vacuum e custo de manutenção; limpezas manuais desses campos aparecem entre as queries mais caras do banco. É uma decisão de retenção/schema e não foi alterada. |
| média | `supabase/migrations/20260814211000_add_stock_intelligence_workers.sql:777-784`, `supabase/migrations/20260817160000_make_upseller_inventory_linking_continuous.sql:1042-1045` | Há cinco despachantes de estoque/reconciliação por minuto, além dos despachantes de sync/preço. `dispatch_due_stock_workers` acumulou 11m08s em 16.750 chamadas; cada chamada é rápida (~39,9 ms), mas a frequência representa 21,2% do tempo SQL amostrado. | O custo fixo de polling domina o banco quando as filas estão vazias e compete com queries de usuários. Isso pede consolidação arquitetural do dispatcher, não aumento de timeout. |
| baixa | `src/lib/supabase/admin.ts:1-29` | O módulo que lê `SUPABASE_SECRET_KEY` não declara `import "server-only"`; hoje seus consumidores auditados são server-only/Route Handlers, mas falta a barreira de compilação no próprio ponto do segredo. | Uma importação futura acidental em Client Component só seria detectada indiretamente, elevando risco de exposição da service role. |
| baixa | `src/features/dashboard/get-dashboard-overview.ts:102-160`, `src/features/dashboard/get-product-dashboard.ts:104-161`, `src/features/stock/get-product-stock-intelligence.ts:38-49` | A mesma lógica de “hoje em São Paulo” e deslocamento de `YYYY-MM-DD` está duplicada, apesar do helper canônico criado em `src/lib/date/sao-paulo.ts:59-97`. | Manutenção futura pode corrigir um fluxo e deixar outro divergente; não há erro atual de data nesses três trechos. |

Cobertura estrutural confirmada:

- Foram mapeados 28 arquivos de página/Route Handler. Os handlers administrativos validam sessão e papel; o worker interno valida segredo próprio em `src/app/api/internal/ml-sync/worker/route.ts:24-83`. A exceção funcional é o webhook bloqueado pelo Proxy descrito acima.
- O fluxo de background é `pg_cron` → função de despacho via `pg_net` (`supabase/migrations/20260810143342_enable_ml_sync_scheduler.sql:26-82`) → Route Handler interno (`src/app/api/internal/ml-sync/worker/route.ts:20-255`) → claim com lease → chamada ML → upsert/checkpoint/finalização. As filas de listings, backfill, preço, Full, UpSeller, alertas e reconciliação possuem expiração de lease; exemplos em `supabase/migrations/20260810125948_add_resumable_listing_sync.sql:142-204` e `supabase/migrations/20260814211000_add_stock_intelligence_workers.sql:390-506`.
- O schema versionado contém 44 tabelas públicas. Não foi encontrada tabela pública sem RLS habilitada: as tabelas-base ativam RLS em `supabase/migrations/20260807142931_create_identity_and_permissions.sql:280-286`, `supabase/migrations/20260810123042_create_products_listings_and_sync_runs.sql:451-461` e `supabase/migrations/20260810164405_create_orders_and_order_items.sql:290-294`; as tabelas operacionais, em `supabase/migrations/20260814210000_create_stock_intelligence_backend.sql:583-601`. Não foi encontrada policy recursiva ou `using (true)` para `authenticated`.
- Não foram encontrados segredos versionados, `oauth-atual.txt`, service role em Client Component, tipos `any` nas fronteiras TS, dependências declaradas sem uso evidente, imports integrais de lodash/date-fns/ícones ou `use client` removível com segurança. `.env.example` contém apenas nomes/placeholders; o cliente privilegiado lê a chave em runtime em `src/lib/supabase/admin.ts:3-21`.
- `dynamic = "force-dynamic"`/`no-store` aparecem em webhooks, uploads, status autenticado e integrações externas; nesses pontos a ausência de cache é intencional, por exemplo `src/app/api/mercado-livre/notifications/route.ts:7-25` e `src/app/api/upseller/imports/preview/route.ts:14-15`.

## 2. O QUE FOI CORRIGIDO

- `2a0a14b` — `fix(timezone): use Sao Paulo calendar boundaries`: criou helper IANA para dias civis de São Paulo, cobriu DST histórico com testes e substituiu limites UTC nos fluxos de pedidos.
- `5a10e7a` — `fix(analytics): use order totals in revenue diagnostics`: corrigiu seis scripts de diagnóstico para contar `orders.total_amount` uma vez por pedido.
- `6e4c0e4` — `perf(data-access): parallelize independent requests`: paralelizou profile/membership, carregamentos da página de contas, extremos do histórico e consultas independentes do backfill.
- `4f569c0` — `fix(sync): protect listing retry checkpoints`: protegeu a atualização de retry pela lease e validou a persistência.
- `e395400` — `fix(sync): resume recent order pagination`: tornou a paginação recente retomável depois do limite de burst.
- `de5b486` — `fix(workers): surface lifecycle persistence failures`: passou a tratar falhas ao salvar retry/checkpoint/release em nove workers.
- `c85fa9b` — `fix(sync): validate preview persistence errors`: validou erros de finalização/invalidação nos previews de anúncios e pedidos.
- `32f7915` — `perf(stock): batch alert job enqueueing`: eliminou o enqueue normal produto a produto após atualização de Full.
- `b745a22` — `perf(sync): batch recent run lookups`: substituiu duas queries por conta por uma leitura única dos runs relevantes.
- `65f32c4` — `fix(upseller): log background burst failures`: incluiu a causa real, limitada a 500 caracteres, no log do burst em background.
- `b628c3f` — `fix(audit): document database remediation proposals`: registrou, sem aplicar, a correção SQL de receita, dois índices candidatos e paginação de alertas em `auditoria/migrations-propostas.sql:1-353`.

As correções foram mantidas em commits separados por assunto. Nenhuma migration foi aplicada e nenhuma policy/OAuth/token foi alterada.

Validação final: `npm test` passou 48/48; `npx tsc --noEmit` passou; `npm run build` concluiu e gerou as 28 rotas; `npm run lint` terminou com código 0, sem erros e com 10 warnings de parâmetros obrigatórios de Server Actions não usados em `src/features/ml-sync/actions.ts:103-104`, `src/features/ml-sync/actions.ts:222-223`, `src/features/ml-sync/actions.ts:271-272`, `src/features/ml-sync/actions.ts:325-326` e `src/features/ml-sync/actions.ts:552-553`.

## 3. O QUE NÃO FOI CORRIGIDO E POR QUÊ

### Receita agregada no banco

Não foi aplicada porque altera função de banco e exige rebuild histórico. Passos:

1. Revisar com o financeiro a regra de rateio descrita em `auditoria/migrations-propostas.sql:13-23`: participação de `unit_price * quantity` no total do pedido, com fallback por quantidade.
2. Copiar apenas o bloco `auditoria/migrations-propostas.sql:25-221` para uma migration versionada nova.
3. Em staging/clone, comparar por dia `sum(orders.total_amount)` com `daily_account_metrics.gross_revenue` e conferir que produtos mapeados + parcela não mapeada recompõem o total.
4. Executar `EXPLAIN (ANALYZE, BUFFERS)` confirmando uso de `orders_account_date_idx`, existente em `supabase/migrations/20260810164405_create_orders_and_order_items.sql:100-104`.
5. Aplicar em produção e reconstruir o histórico em lotes pequenos por conta/faixa, usando a fila já existente; monitorar `statement_timeout` e diferenças antes/depois.

### Webhook do Mercado Livre

Não foi alterado porque é fronteira de autenticação e o pedido proíbe mudanças automáticas nesse fluxo. Passos:

1. Adicionar **somente** o path exato `/api/mercado-livre/notifications` à allowlist de `src/lib/supabase/proxy.ts:102-107`; não liberar `/api/mercado-livre/*`.
2. Preservar o limite de 64 KiB de `src/app/api/mercado-livre/notifications/route.ts:5-21` e a idempotência por notification key de `src/features/ml-sync/ingest-mercado-livre-notification.ts:70-91`.
3. Confirmar na documentação do ML o mecanismo vigente de autenticidade; se não houver assinatura verificável, manter validação estrita de `application_id`, seller/account e resource (`src/features/ml-sync/ingest-mercado-livre-notification.ts:144-175`) e adicionar rate limit/replay monitoring.
4. Criar teste de integração: POST sem cookie deve responder JSON 200/4xx do handler, nunca 307 para `/login`.

### Linhas atuais de pedidos e variações

Não foram alteradas porque a invalidação é uma mudança de semântica de persistência com impacto direto em métricas.

1. Para cada pedido processado, guardar as `line_key` observadas e, depois do upsert, marcar `is_current=false` nas demais linhas daquele `order_id`; inclusive quando a resposta tiver zero linhas. Fazer isso transacionalmente e condicionado ao mesmo `sync_run`.
2. Reconstruir somente as datas afetadas depois da invalidação; o rebuild atual é chamado em `src/features/ml-sync/sync-orders-preview.ts:1381-1441`.
3. Mover a invalidação de variações de `src/features/ml-sync/sync-listings-preview.ts:984-1014` para fora do teste `variationRows.length > 0`, usando os `listingIds` processados e `last_seen_sync_run_id`.
4. Adicionar regressões para “pedido perdeu uma linha” e “listing passou de N variações para zero”.

### Paginação de alertas e histórico de oferta

Não foi aplicada porque muda contratos SQL/UI.

1. Validar e promover `auditoria/migrations-propostas.sql:265-353` como migration; ela mantém o resumo global e pagina por `(last_seen_at,id)`.
2. Adaptar `src/features/stock/get-operational-alerts.ts:304-351` e a página para cursor/“carregar mais”; só depois retirar a RPC antiga.
3. Para o histórico de ofertas, criar uma RPC com `lag(...) over (partition by offer order by captured_at)` e limite no SQL, devolvendo no máximo `limit` eventos mais a linha anterior necessária para comparação; substituir a leitura integral de `src/features/dashboard/get-product-offer-history.ts:469-517`.

### Índices candidatos

Não foram criados porque a instrução exige proposta, não aplicação. Os dois comandos estão em `auditoria/migrations-propostas.sql:237-254`. Passos: repetir EXPLAIN no workload real, criar cada índice com `CONCURRENTLY` fora de transaction block, rodar `ANALYZE` e comparar buffers/tempo. Não remover índices marcados sem uso com base em uma única janela de estatísticas; vários são de jobs/imports esporádicos.

### Retenção de `raw_payload`

Não foi alterada porque é política de retenção/schema e pode afetar auditoria fiscal/suporte. Definir prazo e necessidade legal; se descartável, particionar/arquivar payload antigo e tornar a limpeza incremental. Não repetir um `UPDATE` global: na amostra remota, as cinco limpezas históricas de `orders.raw_payload` levaram em média ~74,8 s e as de `order_items`, ~33,7 s.

### Observabilidade de skips

Persistir um resultado explícito para contas bloqueadas pela pré-condição de listings, em vez do `continue` de `src/features/ml-sync/sync-recent-orders.ts:198-206`. Sugestão: código `listings_prerequisite_pending`, account id/code e timestamp em um evento/read model, sem criar um `sync_run` falso de pedidos.

### Segurança e dependências

1. Adicionar `import "server-only"` em `src/lib/supabase/admin.ts:1` e teste de boundary; não muda OAuth nem o armazenamento de token.
2. Não executar `npm audit fix --force`. Testar primeiro um override/upgrade de `uuid` compatível com `exceljs`, incluindo todos os fixtures XLSX de `src/features/upseller/import-parser.test.ts:1-128`; se incompatível, acompanhar atualização upstream ou substituir o parser em pacote separado.
3. Reduzir o endpoint `src/app/api/stock/debug/route.ts:25-39` a selects explícitos sem `raw_payload`, ou desabilitá-lo em produção após decidir o fluxo de suporte.

## 4. VELOCIDADE

### a) Ganhos no código da aplicação

- **Baixo esforço; ganho medido em round-trips, latência estimada baixa/média:** manter `b745a22`. A seleção de runs recentes caiu de até `2 × contas` queries para uma (`src/features/ml-sync/sync-recent-orders.ts:147-184`).
- **Baixo esforço; ganho estimado médio em bursts Full:** manter `32f7915`. O enqueue normal passou a uma consulta e um insert em lote (`src/features/stock/persist-fulfillment-stock.ts:77-114`).
- **Médio esforço; ganho estimado alto para produtos antigos:** paginar o histórico de ofertas no SQL; hoje o corte acontece apenas em `src/features/dashboard/get-product-offer-history.ts:697-706`.
- **Médio esforço; ganho estimado alto conforme alertas crescem:** migrar a Central de Alertas para `get_operational_alerts_page`; a RPC atual não limita linhas em `supabase/migrations/20260817121000_add_compact_stock_read_models.sql:162-174`.
- **Baixo esforço; ganho estimado baixo:** reutilizar `src/lib/date/sao-paulo.ts:59-97` nos três helpers duplicados. É manutenção/consistência, não gargalo atual.

### b) Ganhos no banco

Medições feitas com `supabase inspect db table-stats`, `index-stats` e `outliers` no projeto correto; são estatísticas acumuladas, não um benchmark isolado.

- **Médio esforço; ganho estimado alto no rebuild:** promover a função de `auditoria/migrations-propostas.sql:25-221`. Além da correção contábil, o predicado passa a comparar `date_created` diretamente com limites timestamptz, permitindo o índice `orders_account_date_idx`, que teve somente 26 scans na amostra apesar de `orders` ter ~328.096 linhas.
- **Baixo/médio esforço; ganho a confirmar por EXPLAIN:** os índices covering de `auditoria/migrations-propostas.sql:237-254` atendem agregações organizacionais por data. Não foram criados porque `daily_product_metrics` já tem 57 MB de índices para 31 MB de tabela; qualquer novo índice precisa provar redução de buffers.
- **Alto esforço; ganho estimado alto em storage/I/O:** implantar retenção/particionamento de `raw_payload`. Medido: `orders` 846 MB + 124 MB de índices; `order_items` 438 MB + 70 MB.
- **Médio esforço; ganho estimado médio:** consolidar despachantes vazios. Medido: `dispatch_due_stock_workers` 16.750 chamadas, ~39,9 ms/call; `dispatch_ml_sync_worker_task` 11.264, ~41,4 ms/call; `dispatch_ml_sync_worker` 10.012, ~39,0 ms/call. O problema é frequência acumulada, não uma chamada individual lenta.
- **Nenhum esforço recomendado:** não indexar `ml_accounts` só por registrar 11,3 milhões de seq scans; a tabela tem quatro linhas e 16 KiB (`supabase/migrations/20260807171539_create_ml_accounts_and_permissions.sql:13-87`). Seq scan é a escolha correta nesse volume.

### c) Ganhos de infraestrutura

- **Vercel versus Supabase — nenhum movimento recomendado:** Vercel está em `gru1` (`vercel.json:1-3`) e Supabase em `sa-east-1`, ambos São Paulo. Não há evidência de latência inter-região como gargalo atual.
- **Timeout de Functions — baixo esforço de monitoramento; ganho de confiabilidade:** o Route Handler declara `maxDuration=60` (`src/app/api/internal/ml-sync/worker/route.ts:20`) e os bursts internos encerram antes, por exemplo 48 s em `src/features/ml-sync/process-offer-prices-backfill.ts:12-12` e `src/features/ml-sync/process-fulfillment-stock-backfill.ts:15-15`. A arquitetura está coerente com o limite; monitorar p95/p99 e deadline reached.
- **pg_cron/worker — médio esforço; ganho estimado médio de custo SQL:** pg_cron e leases estão sendo usados corretamente, mas há polling fragmentado a cada minuto em `supabase/migrations/20260814211000_add_stock_intelligence_workers.sql:777-784`. Consolidar apenas o dispatch/early-exit, sem mover o dashboard.
- **Saída da Vercel — não sustentada pelos dados:** a evidência atual aponta para receita SQL incorreta, payload/retention e polling, não para limitação regional. Só considerar mover **workers de sync** para runtime persistente se, depois dessas correções, o p95 exceder consistentemente 60 s; páginas e APIs interativas permanecem na Vercel.

## 5. TOP 5 AÇÕES POR RETORNO SOBRE ESFORÇO

1. **Liberar com segurança o webhook exato no Proxy e adicionar teste 307/200** — esforço baixo; retorno crítico. Corrige a interrupção do fluxo que começa em `src/app/api/mercado-livre/notifications/route.ts:13-26`.
2. **Promover e validar a correção de receita, depois reconstruir em lotes** — esforço médio; retorno crítico. SQL pronto para revisão em `auditoria/migrations-propostas.sql:25-221`.
3. **Invalidar linhas antigas de pedidos e variações com testes de regressão** — esforço médio; retorno alto na integridade de unidades, estoque e rateio (`src/features/ml-sync/sync-orders-preview.ts:1273-1378`, `src/features/ml-sync/sync-listings-preview.ts:957-1015`).
4. **Paginar alertas no banco** — esforço médio; retorno alto de previsibilidade/latência. Proposta em `auditoria/migrations-propostas.sql:265-353`.
5. **Definir retenção de `raw_payload` e executar limpeza incremental** — esforço alto; retorno alto em storage/I/O. Os pontos de gravação estão em `src/features/ml-sync/sync-orders-preview.ts:1062` e `src/features/ml-sync/sync-orders-preview.ts:1341`.
