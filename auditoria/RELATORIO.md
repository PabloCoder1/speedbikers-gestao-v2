# Auditoria técnica — SpeedBikers Gestão V2

Data: 17/08/2026. Branch: `auditoria/otimizacao` (já existia e já estava com o working tree limpo; não foi necessário criar). Escopo lido: raiz, configurações, `src/`, `scripts/`, `supabase/` e `public/`, exceto `node_modules/` e `.next/`.

Esta auditoria confirmou de forma independente os achados registrados na passagem anterior desta mesma branch e acrescentou achados novos, com destaque para a reaquisição ilimitada de leases descrita no item 1.1.

Validação final: `npx tsc --noEmit` passou; `npm test` passou 48/48; `npm run build` compilou e gerou as 28 rotas; `npm run lint` terminou com código 0, sem erros, com 10 warnings preexistentes de parâmetros obrigatórios de Server Action não usados (`src/features/ml-sync/actions.ts:41`, `:160`, `:209`, `:263`, `:490`).

---

## 1. FALHAS ENCONTRADAS

| Severidade | Arquivo:linha | O que está errado | Consequência prática no negócio |
|---|---|---|---|
| crítica | `supabase/migrations/20260810125948_add_resumable_listing_sync.sql:140-204`, `supabase/migrations/20260810181227_add_orders_backfill_queue.sql:105-158`, `supabase/migrations/20260814172324_add_offer_prices_backfill_queue.sql:30-50`, `supabase/migrations/20260814211000_add_stock_intelligence_workers.sql:21-38` | **Achado novo.** As quatro RPCs de claim readquirem um job com lease expirado sem incrementar contador algum. `retry_count` só cresce no `catch` do worker em Node (ex.: `src/features/ml-sync/process-listings-sync-worker.ts:378-450`). Se a Function for morta pelo limite de 60 s (`src/app/api/internal/ml-sync/worker/route.ts:20`) antes do `catch`, nada é persistido; o lease expira em 120 s e o mesmo job é readquirido. `ml_offer_refresh_jobs` **não** tem o problema porque seu claim incrementa `attempt_count` (`supabase/migrations/20260814175119_finalize_offer_price_background_pipeline.sql:381-386`). | É exatamente o cenário de "job que trava": o run fica preso em `running` para sempre, nunca atinge `max_retries`, nunca vira falha e nunca dispara alerta. Um lote pesado que sempre estoura 60 s consome uma Function por minuto indefinidamente e bloqueia a fila daquele tipo, enquanto o painel mostra "sincronizando". SQL corretivo em `auditoria/migrations-propostas.sql:352-468`. |
| crítica | `src/lib/supabase/proxy.ts:102-107`, `src/proxy.ts:10-12`, `src/app/api/mercado-livre/notifications/route.ts:13-26` | O Proxy protege tudo exceto `/login` e o worker interno. O webhook público do Mercado Livre também passa pelo Proxy e, sem cookie de usuário, recebe redirect 307 para `/login` antes de chegar ao handler. | Notificações de preço, promoção e Full podem não entrar nas filas; os estados operacionais ficam desatualizados apesar de o ML ter enviado o evento. Não alterado automaticamente por ser fronteira de autenticação. |
| crítica | `supabase/migrations/20260813153823_align_gross_revenue_with_ml_vendas_brutas.sql:208-217`, `:395-449` | A função vigente calcula receita por `order_items.unit_price * quantity`; o valor oficial é `orders.total_amount`, rateado entre as linhas do pedido para métricas por produto. O filtro converte cada `date_created` para `date`, inviabilizando o índice existente. Confirmado que **nenhum** código TypeScript replica o cálculo errado — o bug está contido no banco. | Faturamento, ticket e receita por produto podem divergir do Mercado Livre; decisões comerciais tomadas sobre números errados. Substituição proposta em `auditoria/migrations-propostas.sql:25-221`. |
| alta | `src/features/ml-sync/sync-orders-preview.ts:1273-1295`, `:1299-1324` | Cada linha recebida é marcada `is_current=true`, mas linhas antigas do mesmo pedido que desapareceram de uma versão posterior não são invalidadas. | Unidades e rateio de receita podem permanecer atribuídos a itens que já não compõem o pedido, inflando métricas de produto. |
| alta | `src/features/ml-sync/sync-listings-preview.ts:957-1015` | A invalidação de variações antigas só roda dentro do `if (variationRows.length > 0)`. Se um anúncio deixa de ter variações, todas as antigas continuam `is_current=true`. | Estoque, preço e vínculo continuam associados a variações obsoletas, criando divergência por SKU. |
| alta — corrigida | `src/lib/date/sao-paulo.ts:59-97`, `src/features/ml-sync/actions.ts:413-418` | Limites de dia civil eram produzidos com operações UTC/`toISOString()` em pontos que representam datas de negócio. | Pedidos próximos da meia-noite podiam cair no dia errado; janelas de backfill podiam avançar/encerrar incorretamente, inclusive em datas com horário de verão. Corrigido em `2a0a14b`. |
| alta — corrigida | `src/features/ml-sync/sync-recent-orders.ts:386-437`, `:611-661` | O sync recente tinha teto de 12 páginas/600 pedidos e abandonava a continuidade da mesma janela. | Em picos com mais de 600 pedidos em 24 h, pedidos posteriores podiam nunca ser importados. Agora salva `partial`, cursor e janela, e retoma. Corrigido em `e395400`. |
| alta — corrigida | `src/features/ml-sync/process-listings-sync-worker.ts:330-360`, `process-orders-backfill-worker.ts:340-397`, `process-orders-dashboard-backfill-worker.ts:344-401` | Atualizações de checkpoint/liberação de lease podiam falhar sem tratamento; a atualização de retry de listings não estava protegida pelo `lease_id`. | Worker poderia reportar sucesso sem ter persistido estado, deixando corrida de workers ou jobs presos. Corrigido em `4f569c0`, `de5b486`, `c85fa9b`. |
| média | `src/app/api/mercado-livre/offer-prices-status/route.ts:83-146` | **Achado novo.** `loadPaged` carrega **todos** os `ml_listings` atuais e **todos** os `ml_offer_price_states` da organização, em páginas de 1.000, só para produzir contagens; os `filter`/`Set` de `:107-146` fazem em JavaScript uma agregação que é `count(*) filter (...)` em SQL. | O endpoint cresce linearmente com o catálogo e transfere dezenas de milhares de linhas para calcular ~8 números. É admin-only, mas cada chamada pressiona memória da Function e I/O do banco sem necessidade. |
| média | `supabase/migrations/20260810183503_create_daily_sales_metrics.sql:91-95`, `:182-194` vs. `src/features/dashboard/get-dashboard-overview.ts:333-363`, `:471-480` | **Achado novo (confirmado por leitura do DDL).** Os índices existentes são `(ml_account_id, metric_date desc)` e `(product_id, metric_date desc)`. O dashboard organizacional filtra por `organization_id` + faixa de `metric_date` **sem** `ml_account_id`; nenhum índice atende esse predicado. | A visão consolidada da organização — a tela inicial — não tem índice adequado e degrada conforme o histórico cresce. Índices candidatos em `auditoria/migrations-propostas.sql:237-254`. |
| média | `supabase/migrations/20260817121000_add_compact_stock_read_models.sql:132-175`, `src/features/stock/get-operational-alerts.ts:307-316` | A Central de Alertas agrega e serializa toda a lista do filtro, sem limite nem cursor. | Payload e tempo da página crescem sem teto; a tela tende ao `statement_timeout` conforme o histórico aumenta. RPC paginada proposta em `auditoria/migrations-propostas.sql:265-353`. |
| média | `src/features/dashboard/get-product-offer-history.ts:469-529`, `:678-706` | Todo o histórico de snapshots do produto é carregado e transformado, e só depois cortado pelo `limit` no Node. | Produtos antigos ficam progressivamente mais caros de abrir e transferem linhas que nunca aparecem na UI. |
| média | `supabase/migrations/20260810164405_create_orders_and_order_items.sql:45`, `:173`, `src/features/ml-sync/sync-orders-preview.ts:1006`, `:1285` | `raw_payload` é obrigatório e persiste o JSON integral de pedidos e itens. | Aumenta storage, I/O, vacuum e custo de manutenção. É decisão de retenção/schema e não foi alterada. |
| média | `src/features/ml-sync/sync-recent-orders.ts:198-210` | Contas sem `listings_full=succeeded` são puladas com `continue`, sem persistir motivo, contador ou evento. | Uma conta pode ficar indefinidamente sem pedidos recentes e parecer "sem movimento", em vez de mostrar que a pré-condição não foi satisfeita. |
| média | `src/app/api/stock/debug/route.ts:26-38`, `:62` | Oito `select("*")`, incluindo tabelas com `raw_payload`, devolvidos integralmente ao cliente. | Respostas grandes e dados brutos expostos a qualquer administrador. **Não alterado automaticamente**: aqui o handler devolve todas as colunas por design, então não se enquadra em "`select('*')` onde só poucas colunas são usadas"; recortar as colunas às cegas quebraria a ferramenta de suporte. Ver passo a passo em §3. |
| média | `package.json:15`, `package-lock.json` | `npm audit` reporta duas vulnerabilidades moderadas: `exceljs` depende de `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq). O fix automático rebaixa `exceljs` para 3.4.0 (semver-major). | Risco de supply chain; aplicar o downgrade cego quebraria a importação XLSX, que é operação crítica. |
| média | `supabase/migrations/20260814211000_add_stock_intelligence_workers.sql:777-784`, `supabase/migrations/20260817160000_make_upseller_inventory_linking_continuous.sql:1042-1045` | Cinco despachantes de estoque/reconciliação por minuto, além dos de sync/preço. | O custo fixo de polling domina o banco quando as filas estão vazias e compete com queries de usuários. Pede consolidação arquitetural do dispatcher. |
| baixa | `src/integrations/mercado-livre/orders.ts:133-176`, `src/features/ml-sync/sync-recent-orders.ts:588-603` | A paginação é por `offset` sobre um resultado ordenado por `date_desc`. Pedidos novos que chegam durante a varredura deslocam o offset. | Em janelas de pico, um pedido pode ser pulado entre duas páginas da mesma execução. Limitação conhecida de paginação por offset; só relevante sob alto volume. |
| baixa — corrigida | `src/lib/supabase/admin.ts:1` | O módulo que lê `SUPABASE_SECRET_KEY` não declarava `import "server-only"`. | Faltava a barreira de compilação no próprio ponto do segredo. Corrigido em `9c2928d`. |
| baixa — corrigida | `src/features/dashboard/get-dashboard-overview.ts`, `get-product-dashboard.ts`, `get-product-stock-intelligence.ts`, `sync-orders-preview.ts`, `actions.ts` | Cinco cópias da lógica de "hoje em São Paulo" e de deslocamento de `YYYY-MM-DD`, apesar do helper canônico testado. | Manutenção futura corrigiria um fluxo e deixaria os outros divergentes. Corrigido em `c8d9f2a`. |

### Cobertura estrutural verificada nesta passagem

- **Rotas:** 28 páginas/Route Handlers. Todos os handlers autenticam: sessão + papel `admin` (`health`, `promotions-debug`, `notifications-test`, `offer-prices-status`), `getAdminApiAccess()` (`stock/*`, `upseller/*`), `getStockMutationAccess()` (recebimentos NF-e), segredo próprio com `timingSafeEqual` no worker interno (`src/app/api/internal/ml-sync/worker/route.ts:26-81`). A única exceção funcional é o webhook bloqueado pelo Proxy.
- **Fluxo de sync:** `pg_cron` → despacho via `pg_net` → Route Handler interno → claim com lease → chamada ML → upsert/checkpoint/finalização. Todas as filas têm expiração de lease; o que falta é **contar** a reaquisição (item 1.1).
- **RLS:** 44 tabelas públicas criadas, 44 com `enable row level security` (verificado por varredura multilinha, já que o SQL do projeto quebra os comandos em várias linhas). Nenhuma policy `using (true)` para `authenticated` e nenhuma policy recursiva.
- **Segredos:** nenhum segredo versionado. Não existe `oauth-atual.txt`. `.env.local` existe no disco mas está coberto por `.gitignore:38-39`. `.env.example` contém apenas nomes. Nenhum uso de `SUPABASE_SECRET_KEY` em código que chega ao cliente.
- **Tipos:** zero ocorrências de `any` em todo o `src/` — as fronteiras do ML e do Supabase usam `unknown` com narrowing explícito.
- **Bundle:** nenhum import integral de lodash/date-fns/biblioteca de ícones. `exceljs`, `jszip` e `fast-xml-parser` são importados apenas por módulos server-only (`import-parser.ts`, `nfe-parser.ts`), nunca por Client Component. Todas as dependências de `package.json` estão em uso.
- **`use client`:** 17 arquivos, todos justificados (`usePathname`, `useState`/`useEffect` de polling, `useRouter`, handlers de formulário, error boundary). Nenhum removível.
- **`force-dynamic`/`no-store`:** aparecem em webhooks, uploads, status autenticado e chamadas à API do ML — nesses pontos a ausência de cache é intencional.

---

## 2. O QUE FOI CORRIGIDO

Correções desta passagem:

- **`c8d9f2a`** — `fix(timezone): reuse Sao Paulo calendar helper`: eliminou as cinco cópias de "hoje em São Paulo"/`shiftDate` em `actions.ts`, `get-dashboard-overview.ts`, `get-product-dashboard.ts`, `get-product-stock-intelligence.ts` e `sync-orders-preview.ts`, passando a usar `src/lib/date/sao-paulo.ts`.
- **`229e98f`** — `perf(dashboard): parallelize independent read queries`: dashboard geral (3 round-trips → 1), dashboard de produto (2 → 1) e anúncios do produto (3 → 1), preservando o tratamento de erro individual de cada consulta.
- **`9c2928d`** — `fix(security): mark privileged Supabase client as server only`: `import "server-only"` em `src/lib/supabase/admin.ts`.
- **`d89e490`** — `fix(audit): propose bounded lease reclamation for stuck runs`: registrou o diagnóstico e o SQL corretivo do achado crítico 1.1, sem aplicar.

Correções da passagem anterior, verificadas e mantidas:

- **`2a0a14b`** — `fix(timezone): use Sao Paulo calendar boundaries`
- **`5a10e7a`** — `fix(analytics): use order totals in revenue diagnostics`
- **`6e4c0e4`** — `perf(data-access): parallelize independent requests`
- **`4f569c0`** — `fix(sync): protect listing retry checkpoints`
- **`e395400`** — `fix(sync): resume recent order pagination`
- **`de5b486`** — `fix(workers): surface lifecycle persistence failures`
- **`c85fa9b`** — `fix(sync): validate preview persistence errors`
- **`32f7915`** — `perf(stock): batch alert job enqueueing`
- **`b745a22`** — `perf(sync): batch recent run lookups`
- **`65f32c4`** — `fix(upseller): log background burst failures`
- **`b628c3f`** / **`6b8e51e`** — documentação da auditoria

Nenhuma migration foi aplicada; nenhuma policy, fluxo de OAuth ou armazenamento de token foi alterado.

---

## 3. O QUE NÃO FOI CORRIGIDO E POR QUÊ

### 3.1 Reaquisição ilimitada de lease (achado crítico novo)

Não aplicado: exige coluna nova e alteração de quatro funções de banco.

1. Revisar em `auditoria/migrations-propostas.sql:352-468` se `lease_reclaim_count` deve ter teto próprio (sugestão) ou compartilhar `max_retries`.
2. Promover o bloco para uma migration versionada, replicando o padrão nas quatro RPCs (`listings_full`, `orders_backfill`, `offer_prices_backfill`, `upseller_import_batches`).
3. Em staging, matar a Function no meio de um lote e confirmar que após N reaquisições o run vai para `failed` com `error_code = 'lease_reclaim_exhausted'`.
4. Fazer os workers zerarem `lease_reclaim_count` junto com `retry_count` ao concluir um lote.
5. Criar alerta sobre `sync_runs` com esse `error_code` — são exatamente os jobs hoje invisíveis.
6. Antes de aplicar, rodar `select id, sync_type, started_at from public.sync_runs where status = 'running' and started_at < now() - interval '1 hour'` para inventariar quantos já estão presos.

### 3.2 Webhook do Mercado Livre

Não alterado: é fronteira de autenticação e o pedido proíbe mudanças automáticas nesse tipo de fluxo.

1. Adicionar **somente** o path exato `/api/mercado-livre/notifications` à allowlist de `src/lib/supabase/proxy.ts:102-107`. Não liberar `/api/mercado-livre/*`.
2. Preservar o limite de 64 KiB (`src/app/api/mercado-livre/notifications/route.ts:5-22`) e a idempotência por notification key (`src/features/ml-sync/ingest-mercado-livre-notification.ts:70-92`).
3. Manter a validação estrita de `application_id`, seller e resource (`:144-175`) e adicionar rate limit.
4. Teste de integração: POST sem cookie deve responder JSON do handler, nunca 307 para `/login`.

### 3.3 Receita agregada no banco

Não aplicada: altera função de banco e exige rebuild histórico.

1. Revisar com o financeiro a regra de rateio de `auditoria/migrations-propostas.sql:13-23`.
2. Copiar o bloco `:25-221` para uma migration versionada nova.
3. Em staging, comparar por dia `sum(orders.total_amount)` com `daily_account_metrics.gross_revenue`.
4. `EXPLAIN (ANALYZE, BUFFERS)` confirmando uso de `orders_account_date_idx` (`supabase/migrations/20260810164405_create_orders_and_order_items.sql:100-104`).
5. Aplicar e reconstruir o histórico em lotes por conta/faixa, monitorando `statement_timeout`.

### 3.4 Linhas atuais de pedidos e variações

Não alteradas: mudam a semântica de persistência e impactam métricas diretamente.

1. Guardar as `line_key` observadas por pedido e, após o upsert, marcar `is_current=false` nas demais linhas daquele `order_id` — inclusive quando a resposta tiver zero linhas. Transacional e condicionado ao mesmo `sync_run`.
2. Reconstruir apenas as datas afetadas (o rebuild já é chamado em `src/features/ml-sync/sync-orders-preview.ts:1330-1387`).
3. Mover a invalidação de variações para **fora** do teste `variationRows.length > 0` em `src/features/ml-sync/sync-listings-preview.ts:984-1014`, usando os `listingIds` processados.
4. Regressões para "pedido perdeu uma linha" e "listing passou de N variações para zero".

### 3.5 Paginação de alertas e histórico de oferta

Não aplicada: muda contratos SQL/UI.

1. Promover `auditoria/migrations-propostas.sql:265-353` como migration; ela mantém o resumo global e pagina por `(last_seen_at, id)`.
2. Adaptar `src/features/stock/get-operational-alerts.ts:307-316` e a página para cursor/"carregar mais"; só então retirar a RPC antiga.
3. Para o histórico de ofertas, criar RPC com `lag(...) over (partition by offer order by captured_at)` e limite no SQL, substituindo a leitura integral de `src/features/dashboard/get-product-offer-history.ts:469-517`.

### 3.6 Índices candidatos

Não criados: a instrução exige proposta, não aplicação. Comandos em `auditoria/migrations-propostas.sql:237-254`. Repetir EXPLAIN no workload real, criar cada índice com `CONCURRENTLY` fora de transaction block, rodar `ANALYZE` e comparar buffers/tempo.

### 3.7 Status de preços agregado em JavaScript

Não corrigido automaticamente: a correção correta é uma RPC nova (mudança de banco).

1. Criar `get_offer_price_coverage(target_organization_id uuid)` devolvendo em JSON o resumo global e o por conta, com `count(*) filter (where ...)` sobre o join `ml_listings × ml_offer_price_states`.
2. Substituir `loadPaged` em `src/app/api/mercado-livre/offer-prices-status/route.ts:83-146` por uma chamada à RPC.
3. As cinco contagens de `ml_offer_refresh_jobs` (`:176-187`) já são paralelas e são `head: true`; podem virar uma linha do mesmo JSON.

### 3.8 Endpoint de debug de estoque

Não alterado: o handler devolve todas as colunas por design (é ferramenta de investigação), então recortar colunas às cegas é regressão funcional, não otimização.

1. Levantar com quem usa o endpoint quais campos são realmente consultados.
2. Trocar os `select("*")` de `src/app/api/stock/debug/route.ts:26-38` e `:62` por listas explícitas **sem** `raw_payload`, mantendo um parâmetro `?raw=1` para quando o payload bruto for necessário.
3. Alternativa: desabilitar a rota em produção após definir o fluxo de suporte.

### 3.9 Retenção de `raw_payload`

Não alterada: é política de retenção com possível implicação fiscal/suporte. Definir prazo legal; se descartável, particionar/arquivar payload antigo com limpeza incremental. Não repetir `UPDATE` global.

### 3.10 Observabilidade de skips

Persistir resultado explícito para contas bloqueadas pela pré-condição de listings, em vez do `continue` de `src/features/ml-sync/sync-recent-orders.ts:198-210`. Sugestão: código `listings_prerequisite_pending` com account id/code e timestamp em um evento/read model, sem criar um `sync_run` falso.

### 3.11 Dependências

Não executar `npm audit fix --force`. Testar primeiro um override de `uuid` compatível com `exceljs`, exercitando todos os fixtures XLSX de `src/features/upseller/import-parser.test.ts`; se incompatível, acompanhar o upstream.

---

## 4. VELOCIDADE

### a) Ganhos no código da aplicação

| Item | Esforço | Ganho |
|---|---|---|
| Manter `229e98f` (paralelização dos dashboards) | já feito | **Medido em round-trips:** 8 consultas sequenciais viraram 3 grupos paralelos nas três telas mais abertas. Latência: estimada, redução de 2 RTTs no dashboard geral e de 1–2 nas telas de produto |
| Substituir `loadPaged` por RPC agregada em `offer-prices-status` (§3.7) | médio | Estimado alto: deixa de transferir todas as linhas de `ml_listings` e `ml_offer_price_states` a cada chamada |
| Paginar o histórico de ofertas no SQL (`get-product-offer-history.ts:697-706`) | médio | Estimado alto para produtos antigos |
| Migrar a Central de Alertas para `get_operational_alerts_page` | médio | Estimado alto e crescente conforme os alertas acumulam |
| Manter `b745a22` e `32f7915` | já feito | Medido em round-trips: `2 × contas` → 1 consulta; enqueue produto a produto → lote |

### b) Ganhos no banco

| Item | Esforço | Ganho |
|---|---|---|
| Promover a função de receita (`migrations-propostas.sql:25-221`) | médio | Estimado alto: além da correção contábil, o predicado passa a comparar `date_created` com limites `timestamptz`, tornando `orders_account_date_idx` utilizável |
| Índices organizacionais em `daily_account_metrics` e `daily_product_metrics` | baixo/médio | Estimado alto para a tela inicial. Os índices atuais começam por `ml_account_id`/`product_id` e não atendem o filtro `organization_id` + faixa de data. Confirmar por EXPLAIN antes: `daily_product_metrics` já carrega índice desproporcional ao tamanho da tabela |
| Contador de reaquisição de lease (§3.1) | médio | Não é ganho de latência e sim de **capacidade**: elimina Functions consumidas em loop por jobs que nunca terminam |
| Retenção/particionamento de `raw_payload` | alto | Estimado alto em storage e I/O; `orders` e `order_items` são de longe as maiores tabelas |
| Consolidar despachantes vazios | médio | Estimado médio: o problema é a frequência acumulada do polling, não uma chamada individual lenta |

Não indexar `ml_accounts`: a tabela tem quatro linhas; seq scan é a escolha correta.

### c) Ganhos de infraestrutura — o gargalo **não** é a Vercel

- **Região:** `vercel.json:1-3` fixa as Functions em `gru1` (São Paulo) e o projeto Supabase está em `sa-east-1` (São Paulo). O suspeito número 1 está descartado: não há salto inter-região. Esforço zero, nenhuma ação recomendada.
- **Timeout de Function:** o handler declara `maxDuration = 60` (`src/app/api/internal/ml-sync/worker/route.ts:20`) e os bursts internos encerram antes — 48 s em `process-offer-prices-backfill.ts:12` e `process-fulfillment-stock-backfill.ts:15`, com `MAX_BATCHES_PER_INVOCATION` limitando o trabalho por invocação. A arquitetura está coerente com o limite. **Porém**, o achado 1.1 mostra que quando o limite *é* atingido o sistema não se recupera: essa é a interação real entre Vercel e banco que precisa de correção, e ela é de banco, não de infraestrutura.
- **pg_cron/worker:** usados corretamente — `pg_cron` → `pg_net` → Route Handler → claim com lease. O defeito não é o padrão, é a falta do contador de reaquisição e o polling fragmentado a cada minuto.
- **Sair da Vercel: não sustentado pelos dados.** As evidências apontam para receita SQL incorreta, ausência de índice organizacional, agregação em JavaScript, retenção de payload e polling — nenhum deles resolvido por trocar de host. Só reconsiderar se, **depois** das correções de §3.1 e §4b, o p95 do worker exceder consistentemente 60 s; nesse caso migra-se apenas os **workers de sync** para runtime persistente, e páginas, Server Actions e APIs interativas permanecem na Vercel.

> Todos os números de latência acima são **estimativas**. As reduções de round-trip são contagens diretas de código, não medições de tempo. Nenhum benchmark foi executado contra o ambiente de produção nesta passagem.

---

## 5. TOP 5 AÇÕES POR RETORNO SOBRE ESFORÇO

1. **Contar a reaquisição de lease nas quatro RPCs de claim** — esforço médio, retorno crítico. É a diferença entre um job pesado falhar visivelmente e um job pesado consumir uma Function por minuto para sempre. SQL pronto em `auditoria/migrations-propostas.sql:352-468`; antes de aplicar, inventariar os runs já presos (§3.1 passo 6).
2. **Liberar no Proxy o path exato do webhook e adicionar teste 307/200** — esforço baixo, retorno crítico. Restaura o fluxo de notificações que hoje nunca chega ao handler (§3.2).
3. **Promover e validar a correção de receita, depois reconstruir em lotes** — esforço médio, retorno crítico. É o número que sustenta as decisões comerciais (§3.3).
4. **Criar os índices organizacionais de `daily_account_metrics` e `daily_product_metrics`** — esforço baixo, retorno alto. A tela inicial hoje não tem índice que atenda seu filtro (§3.6).
5. **Invalidar linhas antigas de pedidos e variações, com regressões** — esforço médio, retorno alto na integridade de unidades, estoque e rateio (§3.4).
