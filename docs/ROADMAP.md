# Roadmap V3

As fases seguem a numeração definida no `docs/PROMPT_MASTER.md` §38. Elas foram **refinadas** com entregáveis e marcos, não renumeradas — alterar as fases silenciosamente é proibido.

Cada fase só é considerada concluída sob a Definition of Done do `docs/PROMPT_MASTER.md` §33.

## Referência oficial da visão final de UX/UI

O Figma **“Telas SpeedBikers Gestão”** é, desde 2026-08-31, a referência oficial da **visão final visual e de experiência** do produto. Ele não comprova implementação e não substitui as fontes de verdade já existentes:

- código e infraestrutura real dizem o que existe;
- este ROADMAP e o `docs/HANDOFF.md` dizem o que está planejado;
- o Figma diz como a experiência final deve se apresentar.

Uma tela desenhada no Figma nunca recebe `[x]` por existir no design. A implementação continua incremental e só fecha sob a Definition of Done. O alinhamento abaixo acrescenta escopo futuro sem reabrir fases concluídas.

---

## Fase 0 — Fundação

- [x] Google Cloud V3 preparado
- [x] Supabase V3 Dev preparado
- [x] Branch `v3` criada a partir do último commit de referência da V2
- [x] Branch V3 limpa e documentação inicial criada
- [x] Consolidar requisitos iniciais do produto e UX
- [x] Criar Prompt Mestre final inicial
- [x] Auditoria da V2 como referência (57 tabelas, ~90 funções, relatório de auditoria técnica)
- [x] Definir arquitetura detalhada de módulos e modelo de dados
- [x] Definir contratos iniciais entre web, API e worker
- [x] Definir estratégia detalhada de eventos/notificações e Copiloto
- [x] Registrar decisões D-011 a D-026 em `docs/DECISIONS.md`
- [x] Documentação especializada criada: `DATABASE`, `API`, `METRICS`, `MERCADO_LIVRE`, `NOTIFICATIONS`, `COPILOT`, `DEPLOYMENT`, `TESTING`
- [x] Responder as decisões pendentes A a H — registradas como D-027 a D-034
- [x] Confirmar documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md` — concluído em 2026-08-21 (D-041 a D-043), exceto visitas/Ads (Fase 5B)
- [x] Criar fundação técnica/monorepo
- [x] Criar projeto Vercel V3 conectado à branch `v3`
- [x] Conectar fundação técnica ao Supabase V3 Dev e Google Cloud sem criar domínio prematuramente

---

## Fase 1 — Fundação técnica

**Objetivo:** pipeline verde ponta a ponta, com zero domínio.

- [x] Monorepo pnpm + Turborepo com os três apps; packages criados conforme a necessidade (`config`, `contracts`, `observability`)
- [x] TypeScript estrito, ESLint, Vitest, `.env.example` completo e validação com Zod no boot
- [x] Supabase local (CLI/Docker) subindo e aplicando migrations
- [x] `apps/web` com login Supabase funcionando — entregue na Fase 2
- [x] `apps/api` publicado no Cloud Run, com healthcheck e autenticação OIDC
- [x] `apps/worker` publicado no Cloud Run, consumindo um job de teste via Cloud Tasks
- [x] Projeto Vercel V3 conectado à branch `v3`
- [x] CI no GitHub Actions: typecheck, lint, testes e build obrigatórios
- [x] Scripts `infra/` versionados criando filas e buckets (Scheduler e secrets ficam para as Fases 3 e 2)

**Marco — ATINGIDO em 2026-08-20:** um job atravessa `Cloud Scheduler -> api -> Cloud Tasks -> worker -> Postgres`, sem nenhuma regra de negócio envolvida. Verificado em produção: linha `system.ping / done / processed 1` gravada no Supabase Dev.

**Ressalva honesta:** a parte "e o `web` mostra o resultado" **não** foi entregue e foi movida para a Fase 2. Exibir `job_runs` hoje exigiria uma policy de leitura sem ninguém para autorizar — não existem usuários nem organizações ainda. Abrir leitura para `anon` só para cumprir o marco seria criar exatamente a brecha que a própria migration evita.

---

## Fase 2 — Core de dados

**Objetivo:** identidade, contas e o esqueleto do catálogo, com RLS desde a primeira tabela.

- [x] Organizações, perfis, papéis e `user_account_permissions`
- [x] Helpers de RLS `STABLE` e policies com teste negativo obrigatório
- [x] Contas Mercado Livre, credenciais cifradas e estados de OAuth
- [x] SKUs e componentes de kit (fornecedores adiados para a Fase 4 — a exportação do UpSeller não traz esse dado)
- [x] `sku_listing_links` com UNIQUE parcial para `variation_id` nulo. Anúncios/variações (`listings`) ficam para a Fase 3
- [x] Central de Vinculações: candidatos, resolução por match exato, confirmação humana
- [x] Importador de planilhas do UpSeller: upload, parse, conferência, confirmação e aplicação — catálogo, kits, vínculos e saldo (D-028)
- [x] ETL de carga inicial a partir da V2 (D-027) — **descartado por evidência medida** (D-040): vínculos/estoque/NF-e sem dado irreprodutível na V2; compras (1 pedido) adiado para a Fase 4
- [x] `sync_runs`, `sync_errors` e freshness por conta — schema e RLS prontos; preenchimento real é Fase 3

**Marco:** o ADMIN conecta as contas e o sistema mostra SKU vinculado a MLB, com o catálogo carregado do UpSeller.

---

## Fase 3 — Mercado Livre e histórico

**Objetivo:** dados frescos e confiáveis, com linha do tempo.

- [x] Cliente `@sb/mercado-livre` com backoff, jitter, `Retry-After` e paginação por cursor — concluído em 2026-08-21: OAuth (authorize/exchange/refresh, confirmado contra a fonte oficial), cliente HTTP autenticado com backoff+jitter e classificação de erro (`retryable`/`retryable_eventual`/`not_retryable`), paginador offset genérico. 43 testes, `access_token`/`refresh_token`/`client_secret` nunca vazam em erro (verificado por teste)
- [x] Webhook com ACK rápido, zero chamada de rede e teste negativo nas rotas vizinhas — concluído em 2026-08-21: allowlist de IP (D-043/D-045), payload validado por Zod, resolve a conta por `seller_id` e enfileira `sync.webhook.received` na fila da conta. 25 testes novos, incluindo prova de que `/internal` e `/v1` continuam exigindo sua própria autenticação com a allowlist ativa
- [x] Conexão OAuth de conta (connect + callback), tokens cifrados em repouso — concluído em 2026-08-21: pré-requisito não nomeado explicitamente no checklist original, mas necessário antes de qualquer sincronização real (sem conta `CONNECTED`, não há token para chamar o Mercado Livre). `POST /v1/ml-accounts/connect` + `GET /oauth/mercado-livre/callback`, cifra AES-256-GCM (D-046). Ver `docs/HANDOFF.md`
- [x] Reconciliação por janela via Cloud Scheduler — concluído em 2026-08-21: `POST /internal/schedule/reconcile` (dedupe por hora cheia) + handler `sync.orders.window` no worker, com renovação de token, checkpoint por `sync_runs.latest_record_at` e escrita real em `sync_runs`/`sync_errors`. Persistência estruturada dos pedidos fica para o próximo item, de propósito
- [x] Backfill retomável em fila de prioridade baixa — concluído em 2026-08-21: `backfill.orders` avança em pedaços de 7 dias, auto-encadeado pelo próprio `worker` (checkpoint em `ml_accounts.backfill_covered_until`, nunca offset persistido), disparado automaticamente ao conectar uma conta. Cobre de `connected_at` para trás até os 12 meses de retenção do Mercado Livre; dali para frente é a reconciliação por janela que assume
- [x] Persistência de pedidos com `pack_id` como entidade de análise — concluído em 2026-08-21: `orders`/`order_items` (migration `20260821040000`), gravados por `sync.orders.window` e `backfill.orders`. `sku_id` resolvido e congelado na persistência (D-020). Achado durante a implementação: `date_last_updated` ≠ `last_updated` no exemplo oficial de `/orders/search` — checkpoint corrigido para usar o campo certo antes de qualquer deploy real (D-048)
- [x] Motor de diff e `domain_events` com `dedup_key` — concluído em 2026-08-21: `domain_events` (migration `20260821050000`, L2 append-only), primeiro detector `order.cancelled` (`packages/domain/src/events/`) chamado inline em `persist-order.ts` a cada order persistida. `order.returned` fica de fora — depende da API de Reclamações e Devoluções, não integrada. `events.detect` (job separado para o caminho do webhook) continua não implementado, de propósito
- [x] Tela de Saúde da Sincronização — concluída em 2026-08-21: `/sincronizacao` (`apps/web/app/sincronizacao/page.tsx`), leitura direta do Supabase sob RLS (Modelo A), sem rota nova na `api`. Por conta: status de conexão e frescor de pedidos (`classifySyncFreshness`, `packages/domain/src/events/freshness.ts`, puro e testado) calculado de `sync_runs.latest_record_at` + contagem de `sync_errors` nas últimas 24h. Seção de eventos recentes lista `domain_events` — primeiro consumidor real da observabilidade construída ao longo da fase

**Fase 3 CONCLUÍDA em 2026-08-21.** Todos os oito itens do checklist prontos e testados. Verificada num navegador real (`/sincronizacao`, login ADMIN de verdade) — o banco Dev não tem nenhuma conta Mercado Livre conectada ainda, então a tela mostra corretamente os dois estados vazios; os cards com dado (frescor calculado, lista de eventos) foram verificados por build + typecheck + lint + revisão de código, seguindo o mesmo padrão visual já testado visualmente em `/vinculacoes`, não por captura de tela com dado real — ver `docs/HANDOFF.md`.

**CORREÇÃO EM 2026-08-25 (D-091): este marco NUNCA foi atingido em produção.** Medido em 30 dias de log de requisição do Cloud Run: `/webhooks/mercado-livre` recebeu UMA requisição no período, e foi um teste interno. O Mercado Livre nunca entregou uma notificação — nem `orders_v2`, nem `post_purchase`, nem `questions`. **O frescor dos pedidos vem, desde sempre, da reconciliação de hora em hora**, que funciona e por isso escondeu a ausência do caminho principal. Falta configurar a URL de callback e os tópicos no painel de aplicações do Mercado Livre (`docs/DEPLOYMENT.md`, passo externo). O texto abaixo descreve o que o CÓDIGO faz — que está implementado e testado —, não o que acontece hoje em produção.

**MARCO ATINGIDO DE VERDADE EM 2026-08-27 (D-101), revertendo a correção acima.** O usuário configurou o painel (URL de callback exata + todos os tópicos) e o webhook recebeu tráfego real pela primeira vez na história do projeto: ~100 notificações em 2h, de 9 tópicos (`stock-locations` 45, `shipments` 23, `payments` 7, `orders_v2` 3, `post_purchase` 3). **E o primeiro tráfego real quebrou três contratos que nunca tinham rodado** — exatamente o que D-091 previa: `GET /orders/{id}` não traz `date_last_updated` (48 retries em 2h para 3 pedidos), ZodError classificado como retryable num erro determinístico, e sub-recursos de claim (`/claims/{id}/actions-history`) fora do padrão aceito. Corrigidos e comprovados em produção (`worker-00028-m2p`): o fast path drenou os retries e processou 13 pedidos reais + 2 claims, com zero `job_failed` na janela. **Pedidos frescos em segundos passam a valer de verdade**, com a reconciliação de hora em hora de volta ao papel de rede de segurança em vez de único caminho. Ver D-101 em `docs/DECISIONS.md`.

~~**Marco atingido de verdade em 2026-08-22, com o Fast Path do webhook implementado.**~~ Pedidos ficariam frescos **em segundos** no caminho feliz (`sync.webhook.received` → `GET /orders/{id}` → `persistOrder`), com a reconciliação por janela como rede de segurança (até 1h, papel que já tinha). Entre 2026-08-21 e 2026-08-22 o marco original ("em minutos") esteve tecnicamente incorreto — o job era enfileirado mas não tinha handler registrado, descartado após esgotar tentativas; achado em revisão e corrigido na mesma sessão, sem nunca ter sido regressão (`events.detect`, citado como "não implementado, de propósito" no item acima, é a peça que faltava — o Fast Path não usa esse job separado, chama `persistOrder` direto, que já roda o motor de diff inline, mesmo padrão de `sync.orders.window`). Linha do tempo do ANÚNCIO especificamente fica para quando `listings` for construído (não estava no checklist desta fase) — a tela já está pronta para mostrar esse recurso assim que existir.

- [x] **Fast Path do webhook** — concluído em 2026-08-22: `apps/worker/src/handlers/webhook-received.ts`, só `topic = orders_v2` tem consumidor (outros tópicos fazem ACK sem trabalho, sem consumidor ainda). Junto: `dedupeKey` do webhook ganhou sufixo de janela de minuto (`apps/api/src/webhook.ts`, mesma classe de risco que D-051 já corrigiu para o recompute — sem a janela, uma mudança de status real no MESMO recurso minutos depois colidiria com o nome de task que o Cloud Tasks reteve por até 24h e seria descartada)

**Desbloqueada em 2026-08-21** — documentação oficial do Mercado Livre confirmada (`docs/MERCADO_LIVRE.md`, D-041 a D-043).

---

## Fase 5A — Métricas de venda e dashboards Geral/Conta

**Executada antes da Fase 4.** É a tela âncora (D-033) e não depende do estoque.

- [x] `metric_definitions` e as métricas de venda de `docs/METRICS.md` — concluído em 2026-08-21: seis definições canônicas, espelho imutável no banco e RLS de leitura para membros
- [x] `daily_listing_metrics` e os dois rollups, com teste de equivalência — concluído em 2026-08-21: três projeções L3 sob RLS, bucket `sku_id IS NULL`, razões geradas em `numeric` e um único cálculo `GROUPING SETS` que refaz contagens distintas diretamente em cada grão; 98 testes de integração verdes
- [x] Recálculo incremental por chave suja e rebuild completo — concluído em 2026-08-21: RPC transacional compartilhada, advisory lock por conta, handler `analytics.recompute`, dirty key conta/dia com janela de minuto (D-051), rebuild idempotente testado sem execução histórica no Dev enquanto o backfill estiver incompleto
- [x] Dashboards Geral e por Conta, com filtros de período e comparação — concluído em 2026-08-21: `/vendas` (única tela — Geral e por Conta são a mesma `get_sales_summary`, variando só `p_ml_account_id`), presets 7/15/30/60/90 dias + personalizado, comparação com o período anterior mostrando as mesmas seis métricas duas vezes (sem sintetizar `variacao_percentual_periodo`, pendente da Fase 5B)
- [x] Design system e estados de loading, erro, vazio e stale — concluído em 2026-08-21, na mesma tela: `loading.tsx` (Suspense), banner de erro (`role="alert"`), vazio distinto de "nunca calculado" (não finge R$ 0,00), frescor reaproveitando `classifySyncFreshness`. Paleta e tokens `--sb-*` já usados desde a Fase 2; nenhum componente novo em `packages/ui` foi necessário (regra de contenção: só vira package quando dois apps importam)

**Fase 5A CONCLUÍDA em 2026-08-21.** Os dois itens restantes do checklist prontos e verificados rodando (login real, Supabase Dev real, sem erro). Ver `docs/HANDOFF.md`.

**Marco atingido, mecanicamente:** você abre a V3 em vez da V2 para olhar vendas — o caminho completo (filtro → RPC → RLS → tela) funciona ponta a ponta. **Ressalva honesta:** os quatro backfills de 12 meses ainda não terminaram, então nenhuma janela real tem dado histórico suficiente para comparar visualmente com a V2 ainda — isso é completude de dado, não de funcionalidade, e não bloqueava o fechamento da fase pelos mesmos critérios já usados para a Fase 3.

**Depende de:** Fase 3. **Nenhuma métrica de estoque aparece aqui** — elas chegam na Fase 5B.

---

## Fase 4 — Estoque e compras

**Objetivo:** estoque auditável. É aqui que a V3 vira ferramenta de trabalho.

- [x] Ledger `stock_movements` com `idempotency_key` UNIQUE — concluído em 2026-08-21: L2 append-only (mesmo mecanismo de `domain_events`/`sync_runs`), `location_kind` restrito a LOCAL/RESERVADO/TRANSITO (Full fica fora, D-018), `movement_type` com os 12 valores aprovados. Nenhum código de aplicação escreve ainda — schema primeiro, mesmo padrão incremental já usado em `sync_runs`/`orders`
- [x] Dedução por venda aplicada na persistência do pedido — concluído em 2026-08-21: `@sb/domain/inventory` (`computeSaleDeductions`, puro) decide o que deduzir; `apps/worker/src/handlers/persist-order.ts` chama a cada order persistida. Venda válida = `paid`/`partially_refunded` (mesma semântica de D-050); KIT deduz os COMPONENTES, nunca o próprio kit (`docs/DATABASE.md` secao 4); item sem vínculo não deduz nada, resolve sozinho quando o vínculo nascer. Chave de idempotência não inclui status — reprocessar em qualquer status válido não deduz duas vezes. **Achado em revisão (2026-08-22, não bloqueia):** o retorno de erro de `orders.upsert`/`order_items.insert` em `persist-order.ts` não é checado explicitamente antes de seguir para a dedução — não é a não-atomicidade já decidida em D-019 (aceita de propósito), é um `.error` do Supabase client que passa despercebido em vez de abortar com retry. Vale um `if (error) throw` pontual quando alguém tocar esse arquivo de novo
- [x] Reversão por cancelamento e devolução — concluído em 2026-08-22 para CANCELAMENTO (D-052): `computeCancellationReversals` (`@sb/domain/inventory`) reverte os movimentos `VENDA_ML` já gravados no ledger, não recalcula dos itens atuais — imune a vínculo trocado entre venda e cancelamento. DEVOLUÇÃO fica de fora de propósito, mesmo motivo já registrado para `order.returned`: depende da API de Reclamações e Devoluções, não integrada
- [x] Projeção `inventory_balances` — concluído em 2026-08-21: mantida por trigger na mesma transação de cada `stock_movements` (correta por construção, não por recálculo assíncrono); `private.compute_inventory_balances_from_ledger` soma o ledger do zero e serve de base ao job de conferência
- [x] **Conferência automática ledger × projeção, com evento crítico na divergência** — concluído em 2026-08-23 (D-056): `compute_inventory_balances_from_ledger` movida para `public` (mesmo ajuste já feito em `compute_erp_snapshot_balances`), job `maintenance.verify-ledger-integrity` (Cloud Scheduler diário) compara contra `inventory_balances` e emite `stock.balance.diverged` na divergência — nunca grava `stock_movements` (divergência aqui é bug, não drift de processo, diferente da reconciliação contra o UpSeller)
- [x] **Ajuste manual de estoque (tela/ação)** — concluído em 2026-08-23: RPC `create_manual_stock_adjustment` (`security definer`, ADMIN/GESTOR — mesmo nível de NF-e, mexe no ledger direto), tela `/estoque` (saldo por SKU, LOCAL/RESERVADO/TRANSITO) + `/estoque/[skuId]/ajuste`. `stock_movements` ganhou coluna `reason` (obrigatória para `AJUSTE_MANUAL`, nula para todo movimento automático) — não existia antes, nenhum movimento tinha "motivo" próprio até este ser o primeiro sem outro registro por trás
- [x] NF-e/XML: upload, parse, conferência, confirmação humana, movimentos, `content_hash` UNIQUE — concluído em 2026-08-22: schema e parse prontos desde a etapa anterior; fechado com rota de upload (`POST /v1/nfe-imports`), tela de conferência (`/notas-fiscais`) com vínculo humano por item (`link_document_item`, RPC `security definer`, mesmo padrão de `resolve_link_candidate`), confirmação (`POST /v1/nfe-imports/:id/apply`) e aplicação (`nfe.import.apply`, `computeNfeApplicationMovements` em `@sb/domain/inventory`, gera `ENTRADA_NFE`/`SAIDA_NFE`). Diferente do importador do UpSeller: exige 100% dos itens vinculados antes de liberar a confirmação — uma NF-e é um documento fiscal fechado, não tolera aplicação parcial (`apps/api/src/nfe-import.ts`, `confirmNfeApply`)
- [x] Full por conta como snapshot espelhado do ML, com eventos por diff — concluído em 2026-08-22 para itens sem variação: schema, detector de diff, job de captura (`sync.fulfillment.snapshot`) e gatilho automático (`POST /internal/schedule/fulfillment`, Cloud Scheduler a cada 6h). Caso com variação fica de fora de propósito — a doc oficial não mostra o path exato de `inventory_id` dentro de `variations[]` (`docs/MERCADO_LIVRE.md` secao 2.7), REGRA ABSOLUTA proíbe presumir. **Limite conhecido, hoje só em comentário no código:** a captura pagina até ~1000 SKUs vinculados por conta antes de parar — contas com catálogo maior teriam cauda não capturada. Sem prazo até existir uma conta real perto do limite; registrado aqui para não se perder
- [x] Reservado e em trânsito — **RESERVADO VOLTOU A `[x]` EM 2026-08-29 (D-134), com a execução LIDA**: `balances_reconciled` às 20:51:01Z devolveu `snapshot_rows: 6744` (não mais 1.000), `skus_compared: 3372` e `adjustments: 3300`, e `inventory_balances` passou de **zero** para **exatamente 300 linhas RESERVADO** (686 unidades) — o número previsto por D-131. Integridade conferida: projeção × soma do ledger dá zero divergências em 3.472 chaves. Registro do que estava aqui: **RESERVADO NUNCA FUNCIONOU EM PRODUÇÃO, descoberto em 2026-08-28 (D-131).** `compute_erp_snapshot_balances` era um `union all` que emitia os 3.372 LOCAL antes do primeiro RESERVADO, sem `order by`; com o teto de 1.000 linhas do PostgREST, a metade RESERVADO era decapitada **sempre**. Medido: **zero** linhas RESERVADO em `inventory_balances` e **zero** ajustes RESERVADO em quatro dias, contra 300 linhas de snapshot com reservado ≠ 0 (686 unidades). Como este job é a ÚNICA fonte de movimento RESERVADO, o item estava marcado `[x]` sobre uma funcionalidade que nunca rodou. Corrigido por D-131 (paginação) + D-132 (alvo rolado); **RESERVADO nasce na primeira rodada corrigida — e só vira `[x]` de novo quando essa execução for LIDA (regra de D-109)**. TRANSITO segue válido e independente. Texto original preservado abaixo: ~~as duas metades concluídas: RESERVADO em 2026-08-22, TRANSITO em 2026-08-23 (D-055).** Maturidade diferente, mesma implementação de fundo: nenhum código grava `location_kind = 'RESERVADO'` fora da reconciliação contra o UpSeller (item abaixo, ÚNICA fonte — "Ocupado" no ERP vira RESERVADO); TRANSITO nasce do ciclo do pedido de compra (`ENTRADA_TRANSITO` ao marcar `ORDERED`, `RECEBIMENTO_TRANSITO` ao `RECEIVED`/`CANCELLED` em trânsito) — as colunas de trânsito do UpSeller continuam vindo zeradas em 100% do export real (`docs/UPSELLER.md` secao 6), então TRANSITO nunca dependeu de reconciliação, só do ciclo interno do pedido~~
- [~] 🔴 **Reconciliação contra o snapshot do UpSeller** (D-029) — **estava CORROMPENDO o saldo em vez de reconciliar, de 25 a 28/08/2026; dois defeitos independentes corrigidos em D-131 e D-132.** (1) As duas leituras vinham truncadas em 1.000 linhas (contra 6.744 e 2.524), o ledger ausente virava zero e o snapshot inteiro era reaplicado todo dia — SKU com saldo **4×** o real, e 1.628 SKUs nunca semeados, 1.627 deles negativos. (2) O alvo era o retrato cru, então o job **desfazia a venda de cada dia** enquanto ninguém reimportasse a planilha; agora o alvo é `snapshot + movimentos posteriores à captura` (`compute_erp_target_balances`), o que também torna o job idempotente entre dias. **Só volta a `[x]` quando a rodada de 2026-08-29 for lida e o saldo conferido contra o ERP.** Implementação original, preservada: ~~concluído em 2026-08-22: `compute_erp_snapshot_balances` (snapshot mais recente por SKU) comparado contra `inventory_balances` via `computeReconciliationAdjustments` (`@sb/domain/inventory`, puro), job `maintenance.reconcile-balances` disparado diariamente por organização (`POST /internal/schedule/maintenance`, Cloud Scheduler). Evento `stock.balance.diverged` exigiu D-054 (`domain_events.ml_account_id` nullable — estoque é organizacional, não pertence a uma conta ML)~~
- [x] **Mercado Livre — Pós-venda (Claims/Returns, `order.returned`)** — concluído em 2026-08-23 (D-057): tópico `post_purchase` do webhook ganhou consumidor (`claim-return.ts`), reversão de estoque quando a devolução chega em `status="delivered"` (produto fisicamente de volta), escopada ao ITEM devolvido (não ao pedido inteiro, diferente da reversão por cancelamento). Devolução PARCIAL de um item fica de fora de propósito — sem caso real para calibrar rateio, sai como evento crítico `needsManualReview` em vez de reversão calculada; `/estoque` (ajuste manual) é o caminho até então
- [x] Pedidos de compra: ciclo, histórico por evento, nacional versus importado — concluído em 2026-08-22: `suppliers`/`purchase_orders`/`purchase_order_items`/`purchase_order_events`, ciclo `DRAFT->APPROVED->ORDERED->RECEIVED` (+`CANCELLED`), RPCs `security definer` (mesmo padrão de `resolve_link_candidate`/`link_document_item`), telas `/fornecedores` e `/compras`. "Nacional versus importado" não ganhou coluna nova — a tela puxa `skus.is_imported`, já existente desde a Fase 2. **Escopo desta fatia**: recebimento tudo-ou-nada (sem `PARTIALLY_RECEIVED`); sem geração de `stock_movements` ainda (schema/ciclo primeiro, é o que destrava TRANSITO — ver item acima); sem tela de edição do rascunho (RPC `update_purchase_order_draft` já pronta). Desenhado com base no schema real da V2 (D-040: 1 pedido real, fornecedor Navetec, 5 itens, 8 eventos), mesmo princípio de evidência medida já usado em D-037/D-039/D-048/D-053
- [x] Exportação do pedido de compra em Excel (principal) e PDF (D-034) — concluído em 2026-08-23: usuário liberou implementar com layout PRÓPRIO ("faça do jeito que você achar bem profissional"), a ajustar quando o modelo oficial chegar — ver `docs/HANDOFF.md`
- [x] **Geração de `stock_movements` (`ENTRADA_TRANSITO`/`RECEBIMENTO_TRANSITO`) a partir do ciclo do pedido de compra** — concluído em 2026-08-23 (D-055): TRANSITO nasce ao marcar o pedido `ORDERED` (compromisso de compra assumido, não confirmação do fornecedor — a V3 não tem como observar isso sem integração) e fecha ao `RECEIVED` ou ao `CANCELLED` enquanto `ORDERED`. NÃO gera LOCAL — isso continua sendo exclusivo da NF-e (`ENTRADA_NFE`), desacoplado de propósito. Item sem `sku_id` vinculado não gera movimento, mesmo padrão de `computeSaleDeductions`/`computeNfeApplicationMovements`
- [x] **Tela de edição do pedido em `DRAFT`** — concluído em 2026-08-23: `/compras/[id]/editar`, reaproveita `PurchaseOrderForm`/`ItemRow` de `novo/` (mesmo formulário, agora pré-preenchido, apontando para `update_purchase_order_draft` em vez de `create_purchase_order`). Link "Editar" só aparece com o pedido em `DRAFT`
- [ ] **Recebimento parcial de pedido de compra** (hoje é tudo-ou-nada) — categoria **D, evolução futura sem bloquear a Fase 4**. A visão final prevê o ciclo `RASCUNHO -> APROVADO/ENVIADO -> PEDIDO/CONFIRMADO quando aplicável -> EM_TRANSITO -> RECEBIDO_PARCIALMENTE -> RECEBIDO | CANCELADO`. A máquina atual não será alterada sem decisão arquitetural própria sobre quantidades por item, idempotência, trânsito e eventos.

**Marco — ATINGIDO em 2026-08-23.** O estoque responde "por que este número é este" movimento a movimento (ledger auditável, D-006/D-019), e a divergência contra o ERP é visível em vez de silenciosa (D-029). Todos os itens reais do checklist fechados — só resta recebimento parcial de pedido de compra, decisão de escopo deliberada (D-040), não bloqueio.

---

## Fase 5B — Analytics de estoque, sortimento e tráfego

- [x] **Sincronização de listings/anúncios** — concluído em 2026-08-23 (D-058): tabela `listings` ÚNICA (não as três originalmente conceituadas — achado ao inspecionar o banco real da V2: o espelho completo de anúncio nunca teve uso real lá, só a versão focada em preço), job `sync.listings.snapshot` (Cloud Scheduler a cada 6h, por conta), enumeração via `sku_listing_links` (itens já vinculados a SKU, sem variação). "Dashboards de SKU e de Anúncio" abaixo continua pendente — este item era só a sincronização, o pré-requisito
- [ ] Cobertura, ruptura, vendas perdidas estimadas — **cobertura e ruptura concluídas em 2026-08-23**: `/cobertura` lista todo SKU com estoque local ou venda nos últimos 30 dias (janela fixa, sem seletor nesta fatia), com dias de cobertura (`estoque local ÷ venda média diária`) e sinalização de ruptura (sem estoque local, mas com venda no período). Tudo somado em SQL (`get_stock_coverage`, RPC `security invoker`), nunca em JS, por `docs/ARCHITECTURE.md` seção 21. **"Vendas perdidas estimadas" ADIADO (D-061, achado em 2026-08-23)** — testado contra o banco real antes de implementar: as 2.194 SKUs com movimento local na organização de demonstração estão TODAS em ruptura e NENHUMA jamais teve saldo positivo no ledger (só `VENDA_ML`/`CANCELAMENTO_ML` existem, nunca `ENTRADA_NFE` — o backfill trouxe histórico de venda, nunca saldo inicial). Sem um ponto positivo no ledger, "quando a ruptura começou" é indefinido — não é lacuna de código, é lacuna de completude do backfill; fica para quando houver saldo inicial importado ou histórico orgânico suficiente em produção. **REAVALIADO em 2026-08-27 (varredura de alinhamento): a condição está substancialmente satisfeita desde 2026-08-25** — a reconciliação diária contra o UpSeller (D-029, 896 AJUSTE_RECONCILIACAO sobre 1000 SKUs) é funcionalmente o "saldo inicial importado por SKU" que D-061 pedia, de fonte confiável; rupturas iniciadas DEPOIS do primeiro ajuste têm início detectável no ledger. Limitações que restam: profundidade de histórico (~dias, crescendo), cobertura parcial (SKU fora do snapshot do UpSeller segue sem ponto de partida) e a cadência de importação de planilhas (snapshot velho pode mascarar o cruzamento). Implementável agora — a mecânica melhora sozinha com o tempo; aguarda priorização, não mais dado
- [x] **Curva ABC e filtros de Full** — concluído em 2026-08-23: `/curva-abc` classifica todo SKU com receita nos últimos 90 dias em A/B/C (Pareto 80/15/5), com um filtro "somente sem estoque em Full" que cruza com o último snapshot conhecido de `fulfillment_stock_snapshots` — junta as duas metades do item de checklist numa tela só (achar SKU de alta venda que depende 100% de estoque local). Tudo somado/ranqueado em SQL (`get_sku_abc_curve`), nunca em JS, por `docs/ARCHITECTURE.md` seção 21
- [x] **Dashboards de SKU e de Anúncio** — concluído em 2026-08-23: `/anuncios` ganhou colunas de venda (unidades e receita, 30 dias) cruzando `listings` com `daily_listing_metrics` via `get_listing_sales`; `/skus/[skuId]` (novo, "Dashboard de SKU") resume estoque LOCAL/RESERVADO/TRANSITO/Full e venda somada de um SKU via `get_sku_dashboard`, com os anúncios vinculados listados abaixo — link a partir de `/estoque` e de cada linha de `/anuncios`. Tudo somado em SQL, nunca em JS, por `docs/ARCHITECTURE.md` seção 21
- [ ] Visitas, conversão e Ads (D-032) — **visitas e conversão concluídas em 2026-08-23** (D-059): `/anuncios` ganhou colunas "Visitas" e "Conversão" via `get_listing_traffic` (full outer join entre `daily_listing_visits`, novo, sincronizado diariamente de `GET /items/{id}/visits/time_window`, e `daily_listing_metrics`). Conversão = pedidos ÷ visitas, calculada em SQL, `NULL` (não `Infinity`) sem visita no período. **Ads ADIADO** — exige `advertiser_id` próprio por conta com elegibilidade condicionada (reputação, tempo de conta, mínimo de vendas), sem evidência de que a conta Mercado Livre da Speed Bikers tenha o produto habilitado; integração do tamanho de Claims/Returns ou listings, escopo próprio quando houver evidência real de necessidade. **Marco desta fase ATINGIDO em 2026-08-25** — a validação com dado real de produção que faltava foi feita no Checkpoint pré-Fase 7: `v3-listing-visits-snapshot` rodou na cadência esperada (7h/SP) e as 3 contas ML completaram com `items_failed: 0` (945+984+808 itens), 429 intermitente do Mercado Livre absorvido pelo retry existente. O texto anterior ("Marco ainda não atingido") ficou desatualizado entre 2026-08-25 e a correção, apesar de o próprio Checkpoint mais abaixo neste arquivo já registrar a confirmação
- [x] **Busca Universal / Command Palette** e **Filtros salvos** — requisitos formais em `docs/PRODUCT_REQUIREMENTS.md` (linhas 20, 26, 150-152) que nunca tinham sido copiados para o roadmap; achado em revisão, 2026-08-22. **Busca Universal concluída em 2026-08-23** (D-060): `Ctrl+K`/`Cmd+K` em qualquer tela autenticada busca SKU, anúncio, conta, fornecedor e pedido de compra via `search_entities` (RPC, `UNION ALL`, sem full-text search). Pedido de VENDA do Mercado Livre e "ação" (Central de Ações, ainda não existe) ficam de fora — sem destino de navegação real hoje. **"Filtros salvos" concluído em 2026-08-23** (D-062): presets por USUÁRIO e por TELA (`params jsonb` = os query params da URL), integrado em `/vendas` (o filtro mais rico — período + conta); outras telas filtradas podem adotar o mesmo componente (`apps/web/components/saved-filters.tsx`) sem migration nova. Achado no caminho: GRANT de tabela nova concede INSERT/UPDATE/DELETE a `authenticated` por padrão neste projeto Supabase, mesmo sem GRANT explícito — corrigido aqui, auditoria de tabelas mais antigas com o mesmo padrão sinalizada à parte
- [x] **Playwright nos fluxos críticos** — concluído em 2026-08-24 (D-069): login, página do produto (Dashboard de SKU), conferência de NF-e (vínculo humano via `link_document_item`) e pedido de compra (criação do zero pela UI). Detalhe completo no Checkpoint pré-Fase 7 (P0) abaixo.

**Marco:** o diagnóstico passa a distinguir queda de tráfego de queda de conversão.

**Depende de:** Fase 4.

---

## Fase 6 — Diagnóstico e Ações

- [x] **Baseline, desvio e detecção estatística sem machine learning** — concluído em 2026-08-24 (D-063): `get_sku_sales_baseline` unifica os três métodos aprovados (média móvel, desvio padrão, mesmo dia da semana) num só cálculo — baseline por SKU é a média/desvio de `units_sold` nas últimas 8 ocorrências do MESMO dia da semana, amostra mínima de 4. Testado contra o catálogo real antes de implementar (anomalias reais encontradas: SKU `630006` alta, SKU `220201` queda)
- [x] **Correlação com `domain_events` datados** — concluído em 2026-08-24 (D-063): causas candidatas vêm de eventos com `entity_type='sku'` (hoje só `stock.depleted`/`stock.replenished` têm essa forma com dado real — `order.*`/`listing.*` ficam de fora, sem correlação direta disponível ainda)
- [x] **Contrato de diagnóstico com evidências e confiança** — concluído em 2026-08-24 (D-063): `diagnoseSalesAnomaly` (`packages/domain/src/diagnostics`) produz o contrato fixo de `docs/ARCHITECTURE.md` secao 16 (`escopo, periodo, direcao, confianca, evidencias[], causas_candidatas[], proximos_passos[]`), consumido por `/diagnostico` (novo)
- [x] **Central de Ações unificando problema e oportunidade** — concluído em 2026-08-24 (D-064): `actions` (tabela única, severidade espelha confiança nesta fatia), job `diagnostics.detect-sales-anomalies` (diário, por organização, grava direto via `service_role` sem RPC, `estimated_impact_brl = |unitsDelta| x preço médio`), `update_action_status` (RPC para o navegador), tela `/acoes` (só itens abertos, ordenados por impacto — nunca por contagem)
- [x] **Decisões com `baseline_snapshot` e medição posterior em 7/15/30 dias** — concluído em 2026-08-24 (D-065): `action_decisions`/`action_outcomes`, `get_sku_decision_snapshot` (mesma função pro baseline e pro outcome, só muda `as_of`), `create_action_decision` (RPC para o navegador, captura o snapshot na hora), job `diagnostics.measure-decision-outcomes` (diário, decide via `computePendingOutcomeWindows` — pura — quais janelas já amadureceram). `/acoes` ganhou "Registrar decisão" e exibição de baseline/outcomes lado a lado. **Fecha o checklist inteiro da Fase 6.**

**Marco:** o sistema responde "por quê", com evidência e nível de confiança. **Atingido em 2026-08-24.**

**Depende de:** Fase 3 concluída — sem evento datado, diagnóstico é conjectura.

---

## Checkpoint de consolidação pré-Fase 7 — 2026-08-24

Este checkpoint NÃO é uma nova fase e NÃO altera a numeração definida pela D-033.

Objetivo: consolidar lacunas identificadas durante a revisão da implementação real antes de aprofundar a camada de IA.

Nenhuma funcionalidade concluída das Fases 0 a 6 deve ser removida ou reimplementada do zero.

### P0 — Confiabilidade antes da Fase 7

- [x] **Confirmar `maintenance.reconcile-balances` no próximo ciclo natural depois do fix que eliminou a lista excessiva de UUIDs no PostgREST** — confirmado em 2026-08-25: o ciclo natural das 9h/UTC falhou ("JWT issued at future" ao listar organizações, zero organizações escaneadas), mas o disparo manual (`gcloud scheduler jobs run`, autorizado pelo usuário) às 13h29/UTC do mesmo dia rodou limpo — `balances_reconciled`, 1000 SKUs comparados, 896 ajustes, zero erro — confirmando que a falha era transitória. Ver D-081 em `docs/DECISIONS.md`.
- [x] **Confirmar `sync.listing-visits.snapshot` com dado real e cadência normal, sem disparar jobs pesados simultaneamente** — confirmado em 2026-08-25: rodou às 7h/SP (cadência esperada), as 3 contas ML completaram com `items_failed: 0` (945+984+808 itens), 429 intermitente do Mercado Livre absorvido pelo retry já existente sem achado novo.
- [x] **Criar/fechar Playwright para os fluxos críticos que continuam pendentes da Fase 5B** — concluído em 2026-08-24 (D-069): os quatro fluxos de `docs/TESTING.md` (login, página do produto, conferência de NF-e, pedido de compra), rodando de verdade contra Supabase local na CI (job "e2e", commits `4276bb0`/`a0b0694`/`56c60cd`). "Confirmar aplicação" da NF-e ficou fora de propósito — depende de `apps/api` + Cloud Tasks + `apps/worker`, infraestrutura que não existe no Supabase local da esteira.
- [x] **Auditar os serviços implantados contra a infraestrutura real antes de declarar deploy concluído: Web, API, Worker, migrations e Cloud Scheduler** — concluído em 2026-08-24 (D-070): tudo em dia, medido contra a infraestrutura real, não presumido. Web (Vercel) rastreando `v3` automaticamente. API/Worker (Cloud Run) sem código não-deployado desde a última revisão. 43/43 migrations locais == remotas no Supabase Dev, sem drift. Os 9 jobs esperados do Cloud Scheduler existem, habilitados, todos dispararam hoje. **Atenção ao reusar este número**: 9 era o esperado em 2026-08-24. Desde então nasceram `v3-support-questions-reconcile` (D-089), `v3-support-messages-reconcile` (D-097) e `v3-check-ai-budget` (D-100) — **uma auditoria nova deve esperar 13** (número corrigido em 2026-08-29/D-134: o texto dizia 12 e esquecia `v3-support-claims-reconcile`, de D-108; `infra/cloud-scheduler.sh` tem 13), e conferir contra `infra/cloud-scheduler.sh`, nunca contra este texto — que é exatamente o erro que este parágrafo já tinha cometido duas vezes.
- [x] Corrigir documentação de deploy para refletir exatamente o mecanismo real utilizado; não afirmar CI/CD automático de Cloud Run enquanto ele não existir — concluído em 2026-08-24 (`docs/DEPLOYMENT.md` seção 7 já distingue Vercel automático de Cloud Run manual).
- [x] **Revisar GRANTs das tabelas antigas de escrita exclusiva por RPC/service_role, seguindo o achado D-062** — concluído em 2026-08-24 (D-066): 23 tabelas tinham INSERT/UPDATE/DELETE concedido a `authenticated` por padrão (achado medido via `has_table_privilege`, não presumido) — RLS já protegia (nenhuma tinha policy de escrita para `authenticated`), mas o GRANT em si era superfície desnecessária. Corrigido, testado em transação `begin/rollback` antes de aplicar. 5 tabelas com escrita legítima (`ml_accounts`, `organization_members`, `profiles`, `sku_listing_links`, `user_account_permissions`) ficaram de fora de propósito.
- [x] **Corrigir tratamento explícito de `.error` em persistências críticas onde o Supabase client puder continuar o fluxo depois de falha** — concluído em 2026-08-24 (D-067): levantamento sistemático achou 34 pontos em 3 níveis, todos corrigidos e testados. **Nível 1** (9 pontos, risco de corromper dado de negócio — dedução/reversão de estoque em `persist-order.ts`/`claim-return.ts`, itens de pedido de compra apagados ao editar/exportar). **Nível 2** (10 pontos, UI mostra "sem dado" em vez de "erro ao carregar" em `/vendas`/`/anuncios`/`/diagnostico`/`/acoes`/`/sincronizacao`, e observabilidade de sincronização silenciosamente incompleta no worker). **Nível 3** (13 arquivos — buscas client-side sem `error` desestruturado, e `membership.error`/`organization_id === null` tratados como o mesmo caso em 6 arquivos, inclusive `shell.tsx` que roda em toda página autenticada).

### P0 — Pré-requisito das notificações

- [x] **Implementar motor determinístico de diff de estado de anúncio antes de criar notificações de mudanças** — concluído em 2026-08-24 (D-072): `detectListingEvents` (`packages/domain/src/events/listing-events.ts`), pura, testada sem banco — mesmo padrão de `detectFulfillmentEvents`.
- [x] **Emitir inicialmente `domain_events` para mudanças comprovadamente observáveis: preço, título, status e quantidade disponível** — concluído em 2026-08-24 (D-072): `listing.price.changed`, `listing.title.changed`, `listing.status.paused`/`.reactivated` (as duas únicas transições catalogadas), `listing.available_quantity.changed` (catálogo novo). Wiring em `ml-listings-fetch.ts`.
- [ ] Pesquisar documentação oficial atual antes de adicionar foto principal, descrição, promoção, catálogo ou outros estados. **Nota de alinhamento (2026-08-27): não é esquecimento — nunca foi executado, e ficou MAIS BARATO desde D-101**: o webhook vivo entrega os tópicos `items`/`items_prices`/`public_offers`/`price_suggestion`/`catalog_*` de verdade, e `GET /missed_feeds` (retenção 2 dias) permite auditar corpos reais — evidência que não existia quando o item foi escrito. Segue aberto aguardando execução
- [x] **Garantir `dedup_key` e idempotência dos eventos de anúncio** — concluído em 2026-08-24 (D-072): chave leva `syncedAt` (os quatro campos oscilam livremente ao longo da vida do anúncio, diferente de `order.cancelled`), testado que reprocessar o mesmo par de estados produz a mesma chave.
- [x] **Garantir que reprocessamento do mesmo snapshot não gere mudança falsa** — concluído em 2026-08-24 (D-072): testado que "nada mudou" produz zero eventos, e a UNIQUE de `domain_events.dedup_key` absorve qualquer reenvio da mesma transição.
- [x] Somente depois conectar esses eventos a `notifications` — **concluído em 2026-08-24 (D-073)**, migration `20260824190000_create_notifications.sql`: `notifications`/`notification_recipients`/`notification_preferences`, fan-out por trigger `AFTER INSERT` em `domain_events`. A caixa ficou desmarcada até 2026-08-25 afirmando que a migration não existia — falsa desde D-073, e toda a metade "Notificações" da Fase 7 (D-074 a D-076) foi construída em cima dela.

### P1 — Alinhamento com requisitos funcionais já aprovados

> Alinhamento (2026-08-27, a pedido do usuário): os 7 itens abertos abaixo NÃO são esquecimento nem bloqueio — são fila deliberada que ficou atrás da Fase 7/7B na priorização. Nenhum depende de decisão de produto pendente; qualquer um pode ser puxado quando o usuário priorizar. O próprio arquivo já registra: "Itens P1 e P2 podem continuar evoluindo incrementalmente".

- [ ] Implementar filtros de Conta / Origem / Marca nas telas em que fizerem sentido, preservando a distinção entre estoque físico compartilhado e Full por conta.
- [ ] Impedir mistura de SKU Nacional e Importado no mesmo pedido de compra.
- [x] Criar fluxo de vinculação manual `Conta + MLB + variation_id? -> SKU` sem exigir `link_candidate` prévio — concluído em 2026-08-28 (D-119). Escrita direta sob RLS (a policy `sku_listing_links_write_permitted` existia desde a Fase 2 e nunca teve chamador), validação pura testada, conflito das DUAS formas (anúncio inteiro × variação) detectado — os índices são parciais e disjuntos, e a mistura levaria o estoque Full para o SKU errado. **Destravado por D-117**, que mediu por que isto deixou de ser cosmético: 3.679 anúncios que já venderam sem vínculo nenhum e `link_candidates` estruturalmente incapaz de recebê-los. **Lacunas declaradas**: não existe histórico de vínculo nem caminho para DESFAZER — próxima fatia, e as duas precisam nascer juntas.
- [ ] Criar alias reutilizável `Fornecedor + código do produto -> SKU` quando um vínculo for confirmado.
- [ ] Evoluir o Dashboard de SKU para abas/progressive disclosure — **primeira migração feita em 2026-08-31 (D-169); o item segue ABERTO de propósito, porque o próprio item manda "migrar incrementalmente" e faltam 6 das 11 abas.** Entregue: `Visão geral | Estoque | Anúncios | Histórico | Diagnóstico` na URL (`?aba=`), com progressive disclosure de verdade — cada aba dispara SOMENTE as suas consultas (a página saiu de 5 consultas fixas para 1–3). Valor fora do conjunto fechado cai para a Visão geral antes de tocar o banco. Vendas ficou como dois números na Visão geral, não como aba. **Primeira tela do projeto VISTA RENDERIZADA** (ensaio local com screenshot de cada aba).
  - **O que falta, e por quê** — nenhuma das seis está bloqueada por falta de dado, o que muda quem pode puxá-las: `Full` (dado em `fulfillment_stock_snapshots` por SKU+conta), `Decisões` (alcança o SKU por `actions.sku_id`), `Preços` (`listing.price.changed`) e `Tráfego` (`daily_listing_visits` por anúncio) precisam de **consulta agregada por SKU** — somar em JS dentro da tela violaria a regra de agregação em SQL. `Vendas` como aba própria só se ganhar recorte além dos dois números. `Atendimento` é a única sem caminho pronto: `support_cases` não tem vínculo de SKU (liga por anúncio).
- [x] Reorganizar a navegação em grupos, evitando todas as telas no mesmo nível — feito em 2026-08-24 (`e1ea084`, ver D-068): COMERCIAL, ESTOQUE, INTELIGÊNCIA, GESTÃO. ADMINISTRAÇÃO e "Produtos" ficam de fora até existirem páginas reais.
- [x] Substituir a Home de construção pela Home orientada a “o que precisa da minha atenção hoje?” — feito em 2026-08-27 (D-105), **a pedido do usuário depois de abrir a Home publicada e ver sete afirmações falsas** (`PENDENTE` em quatro itens entregues na Fase 4, "Nada começado" nas Fases 5B/6/7). A correção não foi atualizar a lista: foi eliminá-la. Todo número da tela nova vem de consulta ao mesmo dado das telas reais, então não há como divergir de novo. Primeira fatia com quatro contadores (ações abertas, atendimentos abertos, em mediação, notificações não lidas); ruptura, Full, alterações de anúncio e decisões aguardando medição entram quando cada um tiver consulta agregada própria.
- [ ] Adicionar as entidades novas que já possuem destino real à Busca Universal, incluindo Central de Ações quando aplicável.

### P2 — Backlog registrado, sem bloquear a Fase 7

- [ ] Avaliar exportação XML estruturada própria do pedido de compra, mantendo Excel/PDF já implementados e sem confundir XML interno com NF-e.
- [ ] Implementar DANFE/PDF como fallback de NF-e quando houver necessidade real e fonte confiável.
- [ ] Reavaliar recebimento parcial de pedido de compra quando o uso real justificar.
- [ ] Reavaliar vendas perdidas estimadas quando o ledger tiver saldo inicial/histórico positivo confiável.
- [ ] Reavaliar Ads somente quando uma conta real comprovar elegibilidade e necessidade.

### Evolução contínua do diagnóstico

A conclusão da Fase 6 representa a primeira versão operacional do motor, não o fim da evolução das evidências.

Depois que novas fontes estiverem disponíveis, expandir gradualmente a correlação para:

- visitas;
- conversão;
- preço;
- mudanças de listing;
- Full;
- promoções;
- catálogo;
- Ads quando disponível.

Manter sempre:

`confiabilidade dos dados -> métricas -> eventos -> diagnóstico -> ação -> IA`

### Critério para iniciar a Fase 7

A implementação da Fase 7 pode começar quando os itens P0 necessários ao recurso escolhido estiverem confiáveis.

Em especial, notificações de alteração de anúncio NÃO devem ser implementadas antes do motor de diff/eventos correspondente.

Itens P1 e P2 podem continuar evoluindo incrementalmente sem reabrir ou invalidar fases anteriores.

## Fase 7 — Notificações e Copiloto

- [x] **Regras evento -> notificação, severidade e agrupamento por janela** — persistência e regra de destinatário concluídas em 2026-08-24 (D-073): `notifications`/`notification_recipients`, fan-out via trigger em `domain_events`, permissão por conta aplicada na geração. Severidade já vinha de `@sb/domain/events` desde a Fase 0. **Agrupamento por janela concluído em 2026-08-24 (D-075)** — `apps/web/components/notification-toasts.tsx`, `(event_type, ml_account_id)` numa janela de 5 minutos. Item fechado por completo.
- [x] **Realtime, toasts no canto inferior direito e Central de Notificações** — **Central de Notificações (lista + lido/não lido) concluída em 2026-08-24 (D-074)**, `apps/web/app/notificacoes`. **Realtime + toasts concluídos em 2026-08-24 (D-075)**, `apps/web/components/notification-toasts.tsx` — `postgres_changes` filtrado por usuário, agrupamento por `(event_type, ml_account_id)` numa janela de 5 minutos, canto inferior direito. Item fechado por completo.
- [x] **Preferências por usuário** — schema (`notification_preferences`, D-073) e UI (`apps/web/app/notificacoes/preferencias`, D-076) concluídos em 2026-08-24. **Correção D-076**: a regra de aplicação mudou de lugar — não filtra mais a criação de `notification_recipients` (bug de D-073 que também suprimia a Central de Notificações), passou a ser avaliada só na entrega em tempo real (`apps/web/lib/notification-preferences.ts`). Item fechado por completo.
- [x] **Registro de ferramentas do Copiloto e orquestração com streaming** — **registro de ferramentas concluído em 2026-08-25 (D-077)**: `packages/contracts/src/copilot-tools.ts` (schema Zod de entrada/saída), `POST /v1/copilot/query` (`apps/api/src/copilot.ts`), três ferramentas de vendas (`sales_summary`/`sales_period_comparison`/`sales_account_comparison`), leitura sob RLS real via `UserClient` novo (`@sb/db`). **Modelo/orçamento decididos em 2026-08-25 (D-082)** — primeira ferramenta com LLM (`narrate_sku_diagnosis`) já implementada e deployada, ver item "O que aconteceu?" abaixo. **Planner e streaming concluídos em 2026-08-28 (D-114)**: `POST /v1/copilot/chat` com tool use sobre as três ferramentas de vendas (argumentos validados pelo MESMO Zod de `/query` — argumento inventado vira tool_result de erro, nunca consulta), streaming SSE delta a delta e UI de chat em `/copiloto`. Sem histórico multi-turno (evolução com decisão própria de custo). Item fechado por completo.
- [x] **`ai_runs` com custo e escopo** — concluído em 2026-08-25 (D-077), migration `20260825120000_create_ai_runs.sql`. Toda chamada ao Copiloto grava ferramenta(s), escopo e latência; `llm_used`/`cost_usd` prontos para quando o LLM existir. **Custo real gravado desde D-082** (`narrate_sku_diagnosis`), não mais sempre `false`/`null`.
- [ ] **Ação contextual "O que aconteceu?"** — **primeira fatia concluída em 2026-08-25 (D-078)**: botão no Dashboard de SKU (`/skus/[skuId]`), mesmo motor de `/diagnostico`/Central de Ações, sob demanda para um SKU só (`get_sku_sales_baseline` ganhou `p_sku_id` opcional). **Narração por IA implementada e deployada em 2026-08-25 (D-082)**: botão "Narrar com IA", Claude Haiku 4.5 narra o contrato já calculado. **Continua pendente**: KPIs/gráficos do Dashboard de Vendas e nível de conta — dependem de sinais de diagnóstico que ainda não existem (só vendas por SKU hoje).
- [x] **Sugestões de features estruturadas** — **captura + Central de Sugestões concluídas em 2026-08-25 (D-079)**: `apps/web/app/sugestoes`, `feature_suggestions`, sete estados de triagem, texto original preservado íntegro. **Modelo/orçamento decididos em 2026-08-25 (D-082)** — a pendência de decisão que travava este item foi resolvida; **estruturação por IA concluída em 2026-08-28 (D-112)**: `structure_feature_suggestion` preenche os nove campos sob a RLS do chamador (a policy de D-079 decide), `original_text` estruturalmente fora do UPDATE, exibição na Central num `<details>` com o texto original sempre visível acima. Item fechado por completo.
- [x] **Simulador de decisão onde houver base matemática** — concluído em 2026-08-25 (D-080): cobertura/ruptura/quantidade necessária no Dashboard de SKU (`/skus/[skuId]`), mesma fórmula já em produção desde D-058 (`get_stock_coverage`), resolvida para cada incógnita em `@sb/domain`. **Margem aproximada fica de fora** — sem custo consolidado por SKU (`docs/METRICS.md`), não há base matemática confiável ainda.

**Marco:** o sistema fala com você, citando escopo e evidência.

---

## Fase 7B — Central de Atendimento / SAC Mercado Livre

Extensão da Fase 7 (D-071): reaproveita a arquitetura de notificações e o
Copiloto já aprovados ali, em vez de reabri-los. Registrada como subfase
própria — não é um item de checklist da Fase 7 — por volume: novo domínio
(`support`), integração ML nova em boa parte (perguntas/mensagens pesquisadas
em D-083; claims/returns confirmados em D-057, `docs/MERCADO_LIVRE.md`
seções 2.10/2.12), um caso de uso novo do Copiloto (sugestão de resposta) e uma
feature sem precedente direto no projeto (Base de Conhecimento Validada).

Ordem incremental vigente (pesquisa iniciada em 2026-08-25; ajustar só com
nova decisão registrada):

- [x] Pesquisa oficial das APIs de Perguntas e Mensagens — concluída em 2026-08-25 (D-083, `docs/MERCADO_LIVRE.md` secao 2.12): leitura/resposta, payloads, webhooks, paginação, rate limits, anexos e fontes de SLA confirmados; nenhum código/migration
- [x] Modelo unificado de atendimento — concluído em 2026-08-25 (D-084, `docs/DATABASE.md`): case por pergunta/conversa pós-venda/claim; mediação e devolução como facetas do claim; transcript, vínculos múltiplos, deadlines por fonte, estados internos, auditoria, RLS e idempotência definidos; nenhum código/migration
- [x] Núcleo read-only de banco — concluído localmente em 2026-08-25 (D-085): seis tabelas `support_*`, RLS/GRANTs, constraints, índices, tipos gerados e 38 testes de integração; sem migration remota, integração externa, webhook ou UI
- [x] Núcleo isolado de Perguntas — concluído localmente em 2026-08-25 (D-086): contratos/fixtures documentados, mapper puro e persistência idempotente de case/mensagens/links; cobre respondida, banida, moderada, atualização e reprocessamento; ainda sem rede/job/webhook/UI/evento/resposta
- [x] Handler unitário de detalhe de Pergunta — concluído localmente em 2026-08-25 (D-087): `GET /questions/{id}?api_version=4`, token/retry existentes, validação de organização+seller e job `sync.support.questions`; sem produtor de webhook/reconciliação/UI/evento/resposta
- [x] Produtor de webhook do tópico `questions` — concluído em 2026-08-25 (D-088): o ACK (`apps/api/src/webhook.ts`) roteia por tópico e enfileira `sync.support.questions` com `{ mlAccountId, questionId }` na fila da conta, preservando ACK rápido, zero chamada de rede e a mesma regra de dedupe por recurso + janela de minuto. **Primeira ingestão real do domínio `support`** — até aqui nenhum código de SAC recebia tráfego. `resource` fora de `/questions/{id}` responde 200 e sai no log em vez de virar job vazio. Sem reconciliação, Scheduler, UI, `domain_events` ou resposta
- [x] Reconciliação de Perguntas — concluída em 2026-08-25 (D-089): job `sync.support.questions.reconcile`, por conta, a cada 6h, paginando `GET /my/received_questions/search?status=UNANSWERED`. Fecha a lacuna de "notificação perdida = pergunta perdida para sempre" que D-088 deixou aberta. **O recorte por status não é escolha de escopo, é o que a API permite**: a leitura oficial de 2026-08-25 confirmou que este endpoint não tem filtro por data e não garante ordenação, então "última janela" não é expressável. `sync_runs.resource` ganhou `questions` (migration `20260825180000`) — a varredura tem janela/contagem/frescor reais, ao contrário do fetch por ID de D-087
- [x] Ingestão read-only (perguntas, mensagens, reclamações, devoluções, mediações) — **FECHADO em 2026-08-27 (D-108)**, com os três canais cobertos por webhook E reconciliação: perguntas (D-088/D-089), mensagens pós-venda (D-097) e reclamações/devoluções/mediações (envelope D-104, transcript D-106, prazos D-107, reconciliação D-108). **D-104 (2026-08-27)**: o claim vira `support_cases` canal `CLAIM` pelo caminho de webhook que já existia (`claim-return.ts` já buscava o claim desde D-057), com mediação e devolução como facetas do mesmo case. Corrigiu D-084 no caminho: **mediação é `stage = "dispute"`, não `type = "mediations"`** — o campo antigo marcaria reclamação comum como crítica. **Transcript concluído em 2026-08-27 (D-106)**: `GET /claims/{id}/messages` com `external_message_key` por FINGERPRINT — o payload não traz `id` de mensagem, a hipótese que D-084 previu. **Prazos concluídos em 2026-08-27 (D-107)**: `support_case_deadlines` sai do vazio com as duas fontes remotas (`detail.due_date` e `available_actions[].due_date`), só ações do vendedor, com cancelamento das que deixam de existir. Destravado por D-107 e entregue em D-115: o filtro de SLA na Caixa de Entrada. Segue fora: a detecção de `BREACHED` como mudança de estado (exige job com relógio) — "vencido" é computado na leitura pelas métricas. **Comportamento "respondida fora da V3" corrigido em 2026-08-27 (D-102)**: pergunta respondida pelo app do ML resolve o case automaticamente (guardado — triagem humana nunca é sobrescrita), conversa respondida vira AGUARDANDO_CLIENTE, e inbound novo REABRE para NOVO (a regra adiada em D-086). Ressalva registrada em D-097: a varredura de mensagens só enxerga conversas **não lidas** (`/messages/unread` é o único endpoint de listagem que existe), então uma conversa já lida pelo app do Mercado Livre entra pelo webhook, não pela reconciliação
- [x] Caixa de entrada unificada — **primeira fatia concluída em 2026-08-25 (D-090)**: `apps/web/app/atendimento`, leitura direta sob RLS (Modelo A), filtros por **conta, tipo e status interno**, padrão "abertos" (bate com o índice parcial `support_cases_open_inbox_idx`). Uma tela só, não seis: D-084 já decidiu que Perguntas/Mensagens/Reclamações/Mediações/Devoluções são FILTROS sobre a mesma projeção. **Filtros por prioridade, responsável, SKU, pedido, período e SLA ficam para a fatia seguinte** — os três entregues são os que o HANDOFF registrava como escopo desta etapa; prioridade e responsável só ganham utilidade junto da triagem, e SLA depende de `support_case_deadlines`, que nenhuma ingestão preenche ainda
- [x] Triagem interna (assumir, mudar status, resolver/reabrir) — concluída em 2026-08-26 (D-094): RPC `triage_support_case` (`security definer`) atualiza o case e acrescenta `support_case_events` na MESMA transação, com autorização por acesso à conta + papel ADMIN/GESTOR/OPERADOR refeita por dentro. `resolved_at` derivado do status (a interface não precisa conhecer a constraint). 11 testes de integração + 1 E2E pela UI real
- [ ] Notificações de atendimento — **primeira fatia em 2026-08-27 (D-110)**: `support.claim.disputed` (`importante`), emitido pela reconciliação quando observa mediação aberta nascida depois da época `max(deploy, connected_at)` — chave terminal, zero migration, severidade CALIBRADA com dado real (17 mediações novas/dia mataram o `critico` proposto). **Segue aberto**: `customer_replied` (melhor candidato — a RPC de D-102 já devolve se a transição aplicou), `sla_at_risk` (espera o job com relógio de D-107), perguntas/mensagens (severidade condicional sem limiar definido) e `opened` (35/dia medidos — adiado com o número registrado). Situação linha a linha em `docs/API.md` secao 9
- [x] Detalhe do atendimento (conversa + contexto) — concluído em 2026-08-26 (D-095): `/atendimento/[caseId]` com transcript de `support_messages`, vínculos, prazos com a fonte, histórico de auditoria e a mesma triagem da lista. `body_state` renderizado como texto explícito, nunca como bolha em branco. Pré-requisito do envio, não o envio
- [x] Resposta manual pelo sistema — concluída em 2026-08-26 (D-096): `POST /v1/support/cases/:caseId/reply` valida e enfileira `support.reply.send`; o worker revalida o estado remoto NA HORA, posta em `/answers` e registra em `support_reply_attempts`. **A primeira escrita do projeto no Mercado Livre**, e o único job deliberadamente NÃO retryable depois do POST — um 5xx ali pode significar que a resposta chegou ao comprador
- [x] Templates e respostas rápidas — concluído em 2026-08-28 (D-111): `reply_templates` compartilhado pela organização (ADMIN/GESTOR gerenciam via RLS direta, padrão D-079), picker na caixa de resposta que PRÉ-PREENCHE (nunca envia; texto novo troca o `clientRequestId` de D-096) e página `/atendimento/templates`. SEM placeholders de propósito: `{nome}` exigiria o nome do comprador, que a V3 não tem de forma confiável (D-083) — substituir por dado errado numa mensagem ao cliente é pior que não substituir
- [x] Copiloto sugerindo respostas — concluído em 2026-08-28 (D-112): ferramenta `suggest_support_reply` no motor de D-077, contexto SÓ via `support_case_links`, sugestão entra na caixa de D-096 pelo `applyTemplate` de D-111 e o texto sugerido viaja no envio para `support_reply_attempts.suggested_text` (a auditoria que D-096 previu). Envio continua comando privilegiado com confirmação humana — o Copiloto nunca envia
- [x] Base de Conhecimento Validada — concluída em 2026-08-28 (D-113): `knowledge_entries` consultada por SQL determinístico (nunca RAG), qualquer membro sugere e a POLICY força nascer SUGERIDO, só ADMIN/GESTOR validam (constraint exige quem/quando — confirmação anônima não existe), sem DELETE (erro vira REJEITADO/OBSOLETO). O VALIDADO por SKU vinculado + geral entra como evidência no prompt de `suggest_support_reply`
- [x] Métricas de SAC — primeira versão operacional em 2026-08-28 (D-115): oito definições canônicas em `docs/METRICS.md` §5B ANTES da tela, RPC `get_support_metrics` (security invoker, soma 100% em SQL, RLS decide o escopo), tela `/atendimento/metricas`. "Tempo de resolução" deliberadamente fora: created_at é relógio de ingestão e resolved_at mistura relógios — claim backfilled daria duração NEGATIVA; entra quando houver opened_at remoto por case. Junto: o filtro "Prazo em risco" na Caixa de Entrada (o que D-090 cortou por tabela vazia e D-107 destravou)
- [x] Detecção de padrões -> Central de Ações — concluído em 2026-08-28 (D-116): `detectSupportPatterns` (puro), ≥3 reclamações ABERTAS no mesmo SKU vira ação `reclamacoes_recorrentes` com impacto = soma REAL dos pedidos vinculados (nunca estimado; sem pedido = null). Snapshot e não série, deliberadamente: baseline de claims exigiria histórico que só existe desde 28/08. dedup por SKU sem data — condição persistente atualiza a MESMA ação, humano que resolveu não reabre. ZERO job novo: o gatilho diário de D-064 enfileira as duas detecções
- [x] Integração com Diagnóstico como fonte de evidência adicional — concluído em 2026-08-28 (D-116): `diagnoseSalesAnomaly` ganhou `supportSignal` opcional (aditivo, com teste de identidade) — reclamação aberta é EVIDÊNCIA sempre e causa candidata SÓ na queda (não explica venda subindo), com "abrir a Caixa de Entrada deste SKU" nos próximos passos. Ligado nos dois chamadores (job diário e /diagnostico), degradando para "sem sinal" em falha

**Automação autônoma de resposta está explicitamente fora desta fase.** Só
seria avaliada no futuro para casos extremamente seguros e repetitivos, com
decisão arquitetural própria e métricas de confiança — não nesta etapa.

**Marco:** o usuário atende as contas Mercado Livre sem sair da Speed Bikers
Gestão, com sugestão de resposta revisável pelo Copiloto e conhecimento
operacional reutilizável.

**Depende de:** Fase 7 concluída (notificações e Copiloto) e pesquisa oficial
das APIs de Perguntas/Mensagens antes de qualquer código de integração.

---

## Subfases acrescentadas em 2026-08-28 (D-120)

Trinta blocos de features trazidos pelo usuário, auditados contra o código real e o banco de produção antes de virarem checklist. Requisitos em `docs/PRODUCT_REQUIREMENTS.md` ("Consolidação de requisitos — 2026-08-28"); achados e ordem em `docs/DECISIONS.md` D-120.

**Nenhuma fase existente foi renumerada** — as subfases seguem o precedente de D-071, que acrescentou a 7B sem tocar na numeração de `docs/PROMPT_MASTER.md` §38.

**Ordem de execução proposta:** `4B → 5C → 5D → 6B → 9`, com a **Fase 8 intercalável a qualquer momento** (backup/restore verificado não conflita com nada disto e é o único risco que cresce a cada dia de uso real).

A ordem não é preferência: é a Regra de Progressão deste arquivo. Quase todas as features pedidas ficam no fim da cadeia `confiabilidade → métricas → eventos → diagnóstico → ações → IA`, e a auditoria encontrou os problemas no começo dela.

---

### Fase 4B — Confiabilidade do catálogo e do estoque

**Por que primeiro:** 80% das features pedidas leem SKU, vínculo ou saldo local. Os três estão medidos como incompletos ou contaminados. Construir dashboards e sugestão de compra sobre isso é produzir decisão errada com aparência de certeza.

- [x] **Enumerar o catálogo real do vendedor** — código concluído em 2026-08-28 (D-121): pesquisa oficial primeiro (§2.14), depois `scanSellerItems`+`getItemsBatch` e o fetcher reescrito. `search_type=scan` obrigatório (o teto de 1.000 é real), duas fases (a busca só devolve IDs), varredura drenada inteira antes de escrever (scroll expira em 5 min). Anúncio sem vínculo passa a existir em `listings` com `sku_id` nulo. **NÃO deployado** — pela regra de D-109, só estará verificado quando uma execução for LIDA
- [x] ~~Abrir `link_candidates` para o Mercado Livre~~ — **decidido DIFERENTE em 2026-08-28 (D-122), depois de painel independente**: a fila é DERIVADA de `listings` (`get_unlinked_listings`, anti-join por qualquer forma de vínculo), não materializada em candidatos. `link_candidates` existe para referências SEM CASA; desde D-121 anúncios do ML têm casa. Correção que veio junto: `listings.sku_id IS NULL` **não** é "sem vínculo" — dos 1.917, **1.013 já têm vínculo de variação**; sem vínculo nenhum são **904** (658 ativos). DISMISS persistente fica de fora, com gatilho declarado
- [x] **Sincronizar anúncios COM variação** — concluído em 2026-08-28 (D-123 + D-124). **D-123**: `get_listing_sales`/`get_listing_traffic` pararam de filtrar `variation_id is null` e devolveram **R$ 469.593,20 (15,4% da receita, 460 anúncios)** a `/anuncios`; soma por anúncio bate com `daily_account_metrics` em exatamente R$ 0,00. **D-124**: visitas passam a enumerar `listings` com status ativo — **menos 327 chamadas/dia e mais 1.539 anúncios ativos cobertos** (a estimativa de D-123 de "+1.900 chamadas" assumia o catálogo inteiro; filtrar por ativo inverteu a conta). **Full fica de fora por schema**: `fulfillment_stock_snapshots.sku_id` é NOT NULL, então anúncio sem vínculo não entra — mudar isso é decisão sobre o significado do snapshot, registrada e não feita
- [x] **Vinculação manual livre** — concluída em 2026-08-28 (D-119)
- [x] **Desfazer vínculo + histórico auditável de vínculo** — concluído em 2026-08-28 (D-125 + D-126). **D-125**: `sku_listing_link_events` append-only e três RPCs; remoção FÍSICA (soft delete quebraria `resolveSku` e o anti-join); e **fechado um furo aberto desde a Fase 2** — `authenticated` tinha DELETE/INSERT/UPDATE com policy `for all`. **D-126**: supressão no importador (vínculo removido à mão não volta pela planilha, vira `UNRESOLVED` e NÃO abre candidato) e `RETARGETED` na reescrita in-place, que é a mutação mais frequente da tabela e não deixava rastro. **Segue aberto**: o botão na interface — as Server Actions existem
- [x] **Tela de integridade de vinculações** com reconciliação INDEPENDENTE por conta — concluída em 2026-08-28 (D-128): `get_link_integrity` mede anúncios, vinculados, sem vínculo, % e candidatos abertos, mais a coluna decisiva **`vendidos_sem_vinculo`, derivada das VENDAS** — a única que não vem do pipeline auditado. Medido hoje: **650 anúncios venderam sem vínculo (R$ 1.551.817,14 em 90 dias) com a fila de candidatos ZERADA nas quatro contas** — a divergência que o requisito pedia para detectar, agora nomeada na tela
- [x] 🔴 **Decidir o estoque sentinela** — **RESPONDIDO pelo usuário em 2026-08-28: é o estado real do UpSeller, é estoque virtual** (número alto para o anúncio não pausar). Tratado em D-127: `skus.stock_is_virtual` como CONFIGURAÇÃO, porque não há sinal derivável — armazém é um só, o export não marca, e a hipótese "base menos vendas" foi testada e reprovada (correlação 0,291). `get_stock_coverage` recusa número para SKU virtual em vez de mostrar "2.000 dias". **Nova pré-condição da 5D**: a ferramenta de marcação em lote (2.306 SKUs com a assinatura de base 1.000/10.000) — com sugestão medida, confirmada por gente, nunca aplicada sozinha
- [~] **Vínculo fornecedor → SKU** — **eixo de nomeação entregue em D-129 e CAMINHO DE PREENCHIMENTO entregue em D-133** (`/produtos` preenche `supplier_brand` em lote, com `MANUAL` blindando contra re-derivação); **a FK segue aberta.** Achado que destrava: `skus.brand` **não é marca, é a categoria do UpSeller** (66% em 'MANETE') e o importador a sobrescreve a cada planilha — por isso a marca real virou `skus.supplier_brand` + `supplier_brand_source` (`DERIVED`/`MANUAL`), fora do alcance do importador. **1.280 de 3.554 semeados; 2.274 em branco de propósito**, para preenchimento manual. `skus.supplier_id` **não** foi criado: `suppliers` tem UMA linha (PLASMOTO, nascida de um pedido real) e criar 19 fornecedores vazios seria inventar entidade — marca de catálogo e entidade de compra não são a mesma coisa
- [x] 🔴 **Consertar o truncamento de 1.000 linhas do PostgREST** — achado e corrigido em 2026-08-28 (D-131 + D-132), enquanto se preparava a ferramenta de marcação em lote. Defeito de CLASSE: `max_rows = 1000` corta a resposta **sem erro**, e cinco pontos do código liam mais que isso sem paginar. Estrago: saldo de estoque corrompido (65% negativo por falta de semeadura, 35% inflado até 4×), RESERVADO nunca criado, **6.324 alertas críticos falsos** do próprio job que deveria vigiar isso, snapshot do Full pela metade, e duas telas contando em JavaScript sobre amostra arbitrária. Helper `readAllPages` + testes de regressão que falham contra a versão anterior. **Reparo do dado entra na rodada de 2026-08-29** — hoje as chaves de idempotência já foram usadas e o job pularia 657 SKUs em silêncio
- [x] **Ferramenta de marcação em lote de `stock_is_virtual`** — **entregue em 2026-08-28 (D-133): a tela `/produtos`**, depois de painel independente de 9 agentes (5 leitores, 3 desenhos, 1 juiz). O achado que decidiu o desenho: `applyProducts` **INSERE** SKU novo, então todo SKU que a próxima planilha criar nasce `stock_is_virtual = false` e ficaria indistinguível de um já examinado — por isso a **data da decisão** virou coluna própria e `false` deixou de significar duas coisas. Três estados (VIRTUAL/FISICO/INDEFINIDO, o terceiro é o que faz o Desfazer existir), retorno POR LINHA (APLICADO/JA_DECIDIDO/NAO_ENCONTRADO — sem ele "412 marcados" pode significar 8), teto de 500, painel de conferência dizendo a CONSEQUÊNCIA. **Zero linhas semeadas.** 🟡 **Falta o ensaio operacional**: marcar 5 SKUs, conferir em `/cobertura`, só então o lote grande — o caminho `stock_is_virtual = true` de `get_stock_coverage` nunca rodou com dado real. (item original: pré-condição da 5D, aberta em D-127) — **destravada por D-129, com a chave corrigida**: a assinatura sentinela é **Off Racer 82,4% contra Navetec 0,4%**, e não 'MANETE' como parecia. Sugestão medida, confirmada por gente, nunca aplicada sozinha

---

### Fase 5C — Dashboards operacionais e filtros padronizados

**Depende de:** 4B para os itens que envolvem anúncio e estoque. Os de venda pura podem andar antes.

- [x] **Vendas**: taxas do ML, margem operacional por pedido, pedidos/valor cancelados, taxa de cancelamento, SKUs distintos vendidos, visão "hoje". Definições em `docs/METRICS.md` 5C — **"receita líquida" é nome vetado**. **COMPLETO em 2026-08-31 (D-157→D-166)**: a margem fechou em D-166 (`get_sales_margin_summary` — só pedidos COBERTOS, cobertura declarada, zero cobertura = recusa; componentes catalogados). **FASE 5C 100% COMPLETA.** **Cinco entregues em 2026-08-31 (D-157)**: taxas_ml, pedidos/valor cancelados, taxa de cancelamento e SKUs distintos — RPC `get_sales_expanded_summary` (168 ms medidos, sem índice novo), seção própria em `/vendas` com a ressalva de cada métrica visível no card, catálogo espelhado. **Visão "hoje" entregue em seguida (D-158)**: `get_sales_today_summary` (19 ms) lê `orders` ao vivo E sinaliza — seção "Hoje — dia em andamento" com "última venda registrada às HH:MM"; as quatro fórmulas canônicas, nenhuma métrica nova; teste de integração é mini-prova de equivalência L1×L3 sobre o mesmo fixture. **Margem operacional: as FONTES foram persistidas em D-165** (`orders.shipping_id` na persistência + varredura diária `sync.order-financials` com as lições de D-156 embutidas; NULL = não observado, nunca zero; sem backfill — precedente D-149). **Resta a métrica em si**: RPC + tela sobre janela COBERTA, declarando cobertura e a lista do que não entra (5C.1)
- [x] **Gráfico com métrica trocável** (faturamento/unidades/pedidos/packs) — concluído em 2026-08-29 (D-136). A premissa foi CONFERIDA antes de escrever e estava certa: `get_sales_daily_series` devolve as quatro desde 2026-08-21 e três eram descartadas no cliente. Métrica na URL (`?metric=`), tela segue Server Component, default fora da URL para não mudar o que `/vendas` limpo mostra. Cada entrada carrega o ID da definição de `docs/METRICS.md` 5.2 — nenhuma métrica nova inventada. ⚠️ **Tela não vista renderizada**: exige sessão e o agente não entra credencial; tipos, lint, 6 testes e `next build` passam. **Comparação com período anterior no gráfico entregue em seguida (D-137)**, com as três decisões que faltavam: escala compartilhada, alinhamento por OFFSET DE DIA (o índice estava certo por sorte — 30/30 dias hoje) e legenda condicional
- [x] **Anúncios como dashboard** — concluído em 2026-08-29 (D-138). 🔴 **A tela mostrava 1.000 de 5.085 anúncios em silêncio** — SEXTA ocorrência da classe de D-131, nascida com D-121 (o catálogo real fez `listings` passar do teto de 1.000). Corrigido pelo precedente de `/estoque`: pivô, filtros, ordenação e CONTAGEM no Postgres (`get_listings_dashboard`), janela declarada, e a tela dizendo sempre a faixa e o total. Filtros de conta, estado, vínculo e busca, todos na URL. `link_state` distingue vínculo por variação de sem vínculo (D-122: 1.013 contra 904 — a tela antiga mostrava travessão nos dois). `EXPLAIN` reprovou a 1a versão e levou de **1.123 ms a 137 ms**. ⚠️ Tela não vista renderizada; `types.ts` editado à mão por falta de token (dívida declarada). **Filtros de Full/estoque/venda ficam de fora**, com gatilho registrado
- [x] **Estoque enriquecido** — concluído em 2026-08-29 (D-139): marca real, categoria, custo, Full (último snapshot por conta), data de criação e último movimento, com filtros de marca/busca/só-negativo e janela paginada. Colunas escolhidas por preenchimento MEDIDO. 🔴 **Origem NÃO entrou**: `is_imported` diz que 187 dos 228 SKUs NAVETEC são nacionais — segunda coluna fiscal a contradizer a rota de compra, depois de `origin_code` (D-129). 🔴 **Valor de estoque continua bloqueado**, mas a razão mudou: a questão do sentinela foi respondida (D-127) e a ferramenta existe (D-133) — faltam os **1.089 SKUs com assinatura sentinela e ZERO classificados**. Destrava com o ensaio de `/produtos`. `EXPLAIN` reprovou duas versões: 1.646 ms para 132 ms, e a segunda causa era o mapa de visibilidade defasado pelo reparo de D-134 (lição: reparo em massa exige `VACUUM ANALYZE`)
- [x] **Curva ABC com escopo e critério** — concluído em 2026-08-29 (D-140). Escopo de conta entra nas DUAS pontas do RPC (conjunto e denominador), então a curva é RECALCULADA, nunca filtrada — remedido hoje: 743 SKUs multi-conta, **476 (64,1%) mudam de classe**, e escopar numa conta muda a classe de 189. Critério trocável (faturamento/unidades/pedidos, cada um com o ID do catálogo), períodos 30/60/90. 🔴 **SÉTIMA ocorrência do truncamento de 1.000 linhas, e a primeira a corromper uma ESTATÍSTICA**: a tela somava as classes em JavaScript sobre 1.000 de 1.492 linhas e exibia **classe C = 298 quando o real era 790**; o filtro "sem Full" via 699 de 1.180. Contagens agora são janela sobre o conjunto filtrado inteiro, no Postgres. `EXPLAIN`: 102 ms, sem índice novo
- [x] **Filtros padronizados** — concluído em 2026-08-29 (D-141), e só agora com dor MEDIDA: `pillStyle` estava copiado em **5 telas**, `buildHref` com reset de página em **3** e o cálculo de janela paginada em **3**. Extraídos para `lib/filters.ts` e `components/filter-pill.tsx`. Compartilha-se a MECÂNICA, nunca o vocabulário — `marca`, `criterio` e `vinculo` continuam de cada tela, porque um resolvedor genérico aceitaria qualquer coisa e não validaria nada. Os 36 testes existentes passaram **sem uma linha alterada**, o que prova que o comportamento não mudou
- [x] **Saúde da sincronização** — concluído em 2026-08-30 (D-143). Por conta E recurso, com veredito de frescor CONTRA A CADÊNCIA real de cada job (visits é diário; messages, 10 min — um limiar único carimbaria "atrasada" uma sincronização saudável). Backfill separado, sem selo de atraso e sem porcentagem inventada — mostra o cursor `backfill_covered_until`, lido pela 1ª vez. Lado PROCESSADO em tabela própria. 🔴 **A medição prévia achou dois problemas de produção que a tela antiga escondia**: `visits` com **123 falhas em 145 execuções (85%, 429)** e `fulfillment` com **zero rodadas `done` em 130**. Corrigir o rate limit é fatia de worker — esta entrega a visibilidade. **FASE 5C COMPLETA** (resta só o item de Vendas do PRD como evolução)

---

### Fase 5D — Reposição e compra inteligente

**Depende de:** 4B inteira. A questão de negócio foi respondida (D-127: é estoque virtual deliberado), e o bloqueio virou **pré-condição técnica nomeada** — a marcação em lote de . Sugestão de compra sobre SKU não marcado continua sendo ficção; a diferença é que agora o sistema sabe dizer isso.

- [x] **Configuração de reposição** — concluído em 2026-08-30 (D-144): `replenishment_settings` em três escopos exclusivos (padrão da org > marca `supplier_brand` > SKU, o mais específico vence), resolvedor puro em `@sb/domain/purchasing` que devolve `null` sem configuração — e a sugestão RECUSA em vez de inventar default. ZERO linhas semeadas (D-127/D-133). `demandWindowDays = lead + cobertura + segurança` — a armadilha do PRD virou função nomeada. Tela `/reposicao/configuracoes` (escrita ADMIN/GESTOR sob RLS). SKU sem marca só casa com o padrão da org — 64% não têm marca e cair em política errada em silêncio seria pior
- [x] **Tendência determinística** — concluído em 2026-08-30 (D-145). Fórmula canônica em `@sb/domain` (janelas NÃO sobrepostas: 30d recentes vs (30,90]; limiares ±25% fixados APÓS medição: 239/174/152), com DUAS recusas de desenho (amostra < 12un/90d; histórico < 84/90 dias). 🔴 **A primeira medição achou junho com 13/30 dias recomputados** — 86% dos SKUs pareciam "crescendo" por artefato, e TODA tela de 90d lia junho/julho errados. Reparado com `rebuild_daily_sales_metrics` (junho: 1.903 → 21.224 unidades). Coluna Tendência em `/cobertura` com decomposição no tooltip. Definição normativa em `docs/METRICS.md` §5D
- [x] **Definição de "estoque real aproveitável"** — concluído em 2026-08-30 (D-146): `LOCAL + FULL + TRÂNSITO`, RESERVADO fora (o Disponível do UpSeller já o exclui — verificado no modelo, não suposto). SKU virtual RECUSA o total; LOCAL negativo entra NEGATIVO (unidades devidas não somem da conta). Canônica em `@sb/domain` (`computeUsableStock`), normativa em `METRICS.md` §5D.2, coluna com decomposição no tooltip em `/estoque`. Sem migration — a RPC de D-139 já devolvia as quatro parcelas
- [x] **Sugestão de compra auditável** — concluído em 2026-08-30 (D-147): `max(0, ceil(taxa_30d × janela − aproveitável))`, composição canônica das três fatias anteriores em `@sb/domain` (`computePurchaseSuggestion`, reusando `simulateRequiredQuantity` de D-080), com as QUATRO recusas se propagando em lista (config/virtual/histórico/amostra) e a decomposição visível por linha em `/reposicao` (tooltip: taxa × janela = projetado − aproveitável = comprar N). RPC entrega só INGREDIENTES (90 ms medidos); a fórmula nunca roda em SQL. Normativa em `METRICS.md` §5D.3. Com a configuração vazia a tela nasce recusando para todos — é o contrato
- [x] **Estados operacionais calculados** — concluído em 2026-08-30 (D-148): os cinco estados sobre a régua `cobertura = aproveitável ÷ taxa_30d` (fórmula de D-080), com TODOS os limiares vindos da política de D-144 — nenhuma constante inventada. EXCESSO exige o teto (`max_coverage_days`, o "buffer máximo" do PRD que D-144 não implementara): sem teto, nunca é afirmado. CHECK no banco garante teto ≥ janela. Recusa nova SEM_DEMANDA_RECENTE (taxa zero = cobertura indefinida, nunca "infinita"). Coluna Estado em `/reposicao`, campo Teto em `/reposicao/configuracoes`. Normativa em `METRICS.md` §5D.4
- [x] **Custo de simulação separado do custo cadastrado** — concluído em 2026-08-30 (D-149): `sku_cost_history` append-only alimentada por TRIGGER na própria `skus` (nenhum caminho de escrita muda o custo sem historiar; sem backfill — o registro começa em 30/08 e a tela declara). O invariante do PRD virou teste: pedido com custo próprio não toca o cadastrado nem gera história (`purchase_order_items.unit_cost` nunca escreve de volta). No `/compras/novo` o cadastrado entra como SUGESTÃO rotulada e editável; histórico com proveniência no Dashboard de SKU
- [x] **Priorização de compras** — concluído em 2026-08-30 (D-150): ordenação lexicográfica SEM pesos (estado operacional > classe ABC > cobertura > venda 30d), rodando em SQL como a PRIMEIRA derivação da fórmula canônica de `@sb/domain` com teste de EQUIVALÊNCIA linha a linha na CI. Recusa fica no meio da ordem de propósito (pendência humana); crescimento e valor são colunas para o julgamento, não chaves. A equivalência achou e corrigiu bug real de float em D-080 (unidade fantasma no ceil). ABC pela própria `get_sku_abc_curve` via join, nunca reimplementada. 196 ms medidos. Normativa em `METRICS.md` §5D.5
- [x] **Da cobertura para o pedido de compra** — concluído em 2026-08-30 (D-151): seleção por checkbox em `/reposicao` (só linhas com sugestão defensável), pedido nasce pré-carregado em `/compras/novo` (quantidade sugerida + custo cadastrado como sugestão editável) como RASCUNHO — a aprovação humana é o ciclo de D-055. "Não misturar nacional e importado" como AVISO honesto, nunca bloqueio: D-129 mediu que `is_imported` (fiscal) contradiz a rota de compra em parte do catálogo. **FASE 5D COMPLETA** (D-144→D-151)

---

### Fase 6B — Diagnóstico narrado, timeline e ações acionáveis

**Depende de:** 5C para os sinais novos. A narração em si já tem motor (D-082).

- [x] **Correlação alcançar eventos de anúncio e pedido** — concluído em 2026-08-30 (D-152): RPC `get_sku_correlated_events` única para os TRÊS consumidores (tela, painel do SKU, worker) mapeia `listing.*` via `listings(conta, item_id)` e `order.*` via `order_items` congelados (D-020). Vocabulário FECHADO de anúncio — `available_quantity.changed` excluído de propósito (91% do ruído, consequência de venda, não causa). Causas clássicas com leitura própria. 34 ms medidos
- [x] **Timeline de evidências** — concluído em 2026-08-31 (D-153): seção "Linha do tempo" no Dashboard de SKU via `get_sku_timeline` (os mesmos 3 caminhos de mapeamento de D-152, mas vocabulário ABERTO — história não edita o passado, `available_quantity.changed` entra AQUI e fica fora da correlação, contraste fixado em teste). Diff só para formatos documentados (`formatEventDiff`); últimos 50 com corte declarado. 70 ms medidos no pior caso
- [x] **IA explicando a AÇÃO** — concluído em 2026-08-31 (D-155): ferramenta `narrate_action` no motor de D-082 (Haiku 4.5, orçamento D-100), botão "Explicar com IA" na linha de `/acoes`. O input é só `{ actionId }` — a ação já vive no banco, a `api` a relê sob a RLS do usuário (autorização e dado no mesmo ato) e o prompt nasce da MESMA `describeActionEvidence` que a tela renderiza (movida para `@sb/domain` quando a `api` virou o segundo consumidor). Vocabulário obrigatório do PRD imposto no system prompt em cinco seções rotuladas, seção sem dado declara ausência, "causa verdadeira" proibida por instrução. **FASE 6B COMPLETA** (D-152→D-155)
- [x] **Atalhos operacionais na Central de Ações** — concluído em 2026-08-31 (D-154): `actionShortcuts` (puro, testado) com a regra inversa da dor — só tela que EXISTE, com o filtro que ela realmente tem. Venda anômala: Dashboard do SKU + anúncios + reposição; reclamações: Caixa de Entrada SEM fingir filtro por SKU (não existe). De passagem, o próximo passo do diagnóstico prometia exatamente esse filtro inexistente — corrigido no domínio
- [x] **Ruído antes da inteligência** — fechado com MEDIÇÃO em 2026-08-30 (D-152): `stock.balance.diverged` em ZERO nas últimas 24h — D-134/D-135 o eliminaram na ORIGEM (reparo do saldo + separação adjusted/diverged). Topo atual do ruído: `listing.available_quantity.changed`, 1.267 notificações/24h (91% do total, informativo) — segue como DECISÃO DE PRODUTO do usuário, já sinalizada

---

### Fase 9 — Escrita no Mercado Livre: republicação oficial

**Depende de:** 4B (saber quais anúncios existem), 6B (recomendar com evidência) e do motor de alterações de anúncio. É a **primeira escrita destrutiva do projeto** — hoje só existe uma escrita no ML, e é responder pergunta.

- [x] **Pesquisa oficial** — concluída em 2026-08-28 (`docs/MERCADO_LIVRE.md` secao 2.16): endpoint, pré-condições, uma republicação por pai, `parent_item_id`, tags, herança de visitas/vendas, **variação renovada**, e o vácuo sobre Full, catálogo, idempotência e reputação. *(O checkbox estava `[ ]` com o texto dizendo "concluída" — inconsistência corrigida em D-159.)*
- [x] **Modelo pai → filho** e a operação rastreável por estados, com idempotência própria — concluído em 2026-08-31 (D-159): máquina de estados pura em `@sb/domain/listings` (9 estados; RELISTING só nasce de CLOSED ou de retry humano; `RELIST_FAILED` = pai fechado sem filho, o estado que exige gente) e a idempotência como CONSTRAINT (`listing_relists_one_live_per_parent`, índice único parcial cujo predicado espelha `RELIST_REOPENABLE_STATES` — equivalência fixada em teste; filho único; CHECK de coerência filho×estado). Histórico append-only com ator (`listing_relist_events`, FKs RESTRICT pelas lições D-099/D-149). Sem chamada ao ML, sem UI — modelo primeiro, de propósito
- [x] **Preflight** que nunca fecha o anúncio quando uma pré-condição crítica falha — concluído em 2026-08-31 (D-160–D-162): `evaluateRelistPreflight` é puro, total e FAIL-SAFE; D-161 captura o snapshot na criação; D-162 repete o preflight NA HORA da execução antes de fechar o pai. Tag `relist`, Full, catálogo, encadeamento não documentado e snapshot ilegível/incompleto são tratados sem presumir segurança.
- [~] **Snapshot antes da ação** e remapeamento obrigatório de variações depois — snapshot ✓ (D-161, capturado na criação); **executor até RELISTED ✓ (D-162)**: re-preflight NA HORA → fechar → POST → confirmar filho (só por id ≠ pai — resposta ambígua é RELIST_FAILED), re-entrante por estado (persistido ANTES do ato que descreve; retomada em RELISTING vira RELIST_FAILED — repetir o POST poderia criar dois filhos; POST falho nunca re-tenta, padrão D-096), transições por CAS. **REMAPEAMENTO entregue em D-163** (`complete_listing_relist_remap`, transação única service_role-only): vínculo de ITEM preserva o link_id e troca a referência (evento `REFERENCE_REMAPPED` com `previous_item_id`); variação renovada vira candidato `source=RELIST` na Central de Vinculações (decisão humana; `seller_custom_field` só como pista) com os vínculos antigos suprimidos contra a planilha velha; projeção do filho nasce em `listings` já com o SKU. RELISTED retoma pelo remapeamento no executor — item completo
- [x] **Bloqueio inicial de Full e Catálogo** — ✓ D-160 (`FULL_BLOQUEADO`/`CATALOGO_BLOQUEADO`), re-avaliado na execução (D-162)
- [x] **Permissão específica** imposta no backend, e confirmação humana explícita — ✓ D-161/D-162: ADMIN/GESTOR + escopo por conta nas DUAS rotas, e a execução é um segundo ato humano separado do pedido (`POST .../relist/:id/execute`)
- [x] **Medição 7/15/30 dias** reaproveitando `action_decisions`/`action_outcomes` (D-065) — concluído em 2026-08-31 (D-164), e o reuso foi LITERAL: ao atingir REMAPPED, o worker registra uma ação `republicacao` (nasce RESOLVIDA — registro de ato consumado, não pendência para triar) + a decisão de D-065 com baseline capturado NA HORA e `created_by` = o humano que pediu a republicação; o job diário existente mede as janelas sozinho (ele enumera todas as decisões, sem filtro de status — zero máquina nova). Garantia idempotente no ramo REMAPPED do executor; filho sem SKU (pai de variações) nasce com baseline vazio, nunca inventado. Linguagem "após a republicação", nunca causal. **FASE 9 COMPLETA NO BACKEND** (D-159→D-164); a superfície visual é a trilha própria da visão de UX, e o primeiro relist real segue sendo ensaio humano deliberado

- [ ] **Experiência visual final da republicação** — categoria **A, alinhamento da Fase 9 com o Figma**, sem duplicar o fluxo existente: ação secundária; modal/drawer de segurança; preflight e riscos visíveis; indicação de Full, catálogo e variações; confirmação humana em dois atos; progresso por estado; relação MLB pai → filho; remapeamento/sincronização; acompanhamento 7/15/30. A primeira versão visual não promete ganho de exposição, reputação ou venda e não autoriza a IA a executar.

---

## Trilhas da visão final — escopo acrescentado em 2026-08-31

Esta seção formaliza a visão final sem renumerar fases existentes nem transformar experiência futura em bloqueio retroativo. Classificação: **A** já planejado/alinhado ao Figma; **B** backend existente, falta principalmente experiência; **C** feature nova formal; **D** evolução futura não bloqueante; **E** dependente de dado, API ou decisão futura.

### Trilha 5E — Inteligência operacional e dashboards 360º

Subfase incremental posterior às bases 5C/5D/6B. Não reabre seus marcos concluídos.

#### Dashboard 360º individual do Anúncio — B/C — ✅ PRIMEIRA VERSÃO em 2026-08-31 (D-168)

`/anuncios/[itemId]` (link no item_id da lista): cabeçalho com conta/status/preço/disponível/SKU-linkado/frescor, cards de vendas+tráfego 30 dias sobre `get_listing_dashboard_summary` (soma do grão listing, poucos ms por índice de grão; conversão NULL sem visita), seção Full honesta ("sem vínculo de SKU" quando não rastreável), ações relacionadas e a linha do tempo DESTE anúncio (recorte por entidade da timeline de D-153, não duplicata — sem linguagem causal). Consultas em paralelo por construção (o risco "N+1 por aba" morre no desenho). **Em SEÇÕES, não abas** — as abas do Figma são a evolução registrada, igual ao item P1 do Dashboard de SKU. **Desvios declarados do DoD:** sem abas Diagnóstico/Decisões nesta fatia (dependem dos read models próprios) e sem Playwright (tela de leitura pura; e2e segue reservado aos fluxos críticos de D-069).

- **Objetivo/problema:** dar a cada anúncio um destino individual, hoje inexistente, reunindo estado, desempenho, evidências e decisões sem cruzamento manual de listas.
- **Reutiliza:** `listings`, métricas por anúncio, `daily_listing_visits`, Full, `domain_events`, correlação/timeline de D-152/D-153, diagnóstico, `actions`, `action_decisions` e `action_outcomes`.
- **Falta:** rota e read model escopados por conta; cabeçalho com título/MLB/SKU/conta/status/preço/estoque/Full/frescor; abas `Visão Geral | Vendas | Tráfego | Preço | Full | Histórico | Diagnóstico | Decisões`; timeline correlacionada por tempo.
- **Definition of Done:** RLS por conta; métricas canônicas; loading/erro/vazio/stale; timeline sem linguagem causal; links para SKU, ações e decisões; Playwright de autorização/isolamento; performance medida.
- **Riscos:** confundir correlação com causalidade, duplicar timeline do SKU, afirmar “saúde” sem definição e criar N+1 por aba.
- **Fora da primeira versão:** score inventado, Ads sem elegibilidade, escrita/relist inline e causalidade por IA.

#### Central de Inteligência de Preços — C/E — 🟡 PRIMEIRA VERSÃO em 2026-08-31 (D-172); a análise antes/depois segue ABERTA

`/precos` (nav COMERCIAL): toda mudança de preço observada, com anúncio, SKU, conta, de/para, delta absoluto e proporcional, filtros na URL (direção/conta/busca/período) e paginação com contagem sobre o conjunto filtrado. Os eventos `listing.price.changed` já existiam desde a Fase 5B e não apareciam em tela nenhuma.

- **O que falta, e por quê:** a análise antes/depois e a definição de "impacto observado" **não entraram, e não por falta de código**: a série de eventos começa em 24/08/2026 e as visitas por anúncio são esporádicas (média de 4,9 dias observados em 31, medido em D-170), então não existe janela comparável dos dois lados de cada mudança. Afirmar impacto sobre isso seria a "atribuição causal indevida" que o próprio item lista como risco. O que falta é **tempo de série**, e o item permanece aberto por isso. Alertas/oportunidades determinísticos também ficam para essa etapa.

- **Objetivo/problema:** transformar mudanças de preço dispersas em análise comercial antes/depois ligada a SKU, anúncio, ação e decisão.
- **Reutiliza:** preço atual de `listings`, `listing.price.changed`, vendas/visitas/conversão, diagnóstico, Central de Ações, decisões/outcomes e histórico de custo.
- **Falta:** read model de janelas comparáveis; tela `PREÇOS`; filtros; definição canônica de “impacto observado”; alertas/oportunidades determinísticos.
- **Definition of Done:** preço anterior/atual e instante rastreáveis; janelas declaradas; métricas antes/depois; custo ausente aparece como ausência; ações/deep-links; testes e performance.
- **Riscos:** atribuição causal indevida, janelas incompletas e margem sem base.
- **Fora da primeira versão:** precificação automática, escrita remota de preço e margem/rentabilidade sem custo defensável.

#### Central Full — B/C — 🟡 PRIMEIRA VERSÃO em 2026-08-31 (D-173); análise antes/depois segue ABERTA

`/full` (nav ESTOQUE): saldo no Full por conta e SKU **no grão certo** (soma dos buckets `inventory_id`, janela de frescor de 3 dias), com venda de 30 dias, estoque local da organização em coluna separada e situação determinística — `Saudável | Parado | Ruptura | Fora do Full`, com o critério de cada uma escrito na tela. Filtros na URL e paginação com contagem.

- **O achado que veio antes da tela:** o Full é por BUCKET (um por variação) e duas leituras da casa colapsavam por `(sku, conta)`, ficando com um bucket só. Medido: **15,6% das unidades a menos** (7.098 contra 8.408), 246 pares com mais de uma variação e **12 SKUs que a Curva ABC declarava "sem Full" tendo Full** — a fila de trabalho mandava enviar ao Full item que já estava lá. Corrigido na Curva ABC e no Dashboard de Anúncio junto.
- **O que falta:** análise antes/depois da entrada no Full (a série tem 10 dias) e "potencial de envio" como número — a tela mostra que há saldo local, mas **não sugere quanto enviar**, porque política logística (custo, lote mínimo, prazo) não existe no sistema. "Curva A sem Full" **não foi reimplementada**: já existe em `/curva-abc?semFull=1` e a Central aponta para lá, em vez de criar cópia divergente.

- **Objetivo/problema:** oferecer operação própria de Full, não apenas uma coluna dispersa.
- **Reutiliza:** `fulfillment_stock_snapshots`, eventos de Full, Curva ABC, estoque aproveitável, cobertura, vendas, diagnóstico, ações, decisões e outcomes.
- **Falta:** tela `FULL`; read models por conta/SKU; critérios para Curva A sem Full, ruptura Full e potencial de envio; análise antes/depois da entrada no Full.
- **Definition of Done:** quantidade/frescor por conta; filtros; critérios visíveis; histórico; comparação não causal; links para SKU, cobertura e ação; performance medida.
- **Riscos:** soma cega com estoque físico, snapshot stale e sugestão sem política logística.
- **Fora da primeira versão:** envio automático, promessa de venda e otimização por IA.

#### Estoque → Movimentações — B — ✅ CONCLUÍDO em 2026-08-31 (D-167)

`/estoque/movimentacoes` (nav ESTOQUE): extrato do ledger com filtros na URL (tipo/local/origem/busca/período), paginação com contagem sobre o conjunto filtrado (classe D-131), e o contexto humano que o risco "IDs sem contexto" pedia — SKU linkado, origem traduzida (Pedido ML N, NF-e, Reconciliação UpSeller, Pedido de compra), motivo e ator do ajuste manual. Somente leitura por construção (zero Server Action). O EXPLAIN reprovou DUAS versões (685 ms → 210 ms → **64 ms**, zero temp): `count(*) over ()` e depois a CTE dupla materializavam 225k linhas; página e contagem viraram subconsultas independentes sobre o índice novo `stock_movements_org_timeline_idx`. Sem filtro de conta DE PROPÓSITO: estoque físico é da organização (regra do PRD). Playwright não incluído (a tela é leitura pura; os fluxos críticos de D-069 seguem sendo o critério) — desvio declarado do DoD original.

- **Objetivo/problema:** tornar o ledger existente utilizável para responder “por que o saldo mudou?”.
- **Reutiliza:** `stock_movements` e referências de NF-e, compra, venda, cancelamento, devolução, ajuste e reconciliação; filtros/paginação existentes.
- **Falta:** rota/read model paginado; busca e filtros por SKU, período, tipo, origem, referência e conta quando aplicável; apresentação do motivo e contexto.
- **Definition of Done:** instante, quantidade, tipo, origem, referência e motivo claros; filtros na URL; RLS; paginação sem truncamento; UI/Playwright; ledger somente leitura.
- **Riscos:** IDs sem contexto, estoque físico atribuído a conta, consulta cara e escrita acidental em dado append-only.
- **Fora da primeira versão:** alterar/apagar movimentos, recalcular saldo no navegador e exportar sem necessidade medida.

#### Dashboard individual do Fornecedor — B/E — 🟡 PRIMEIRA VERSÃO em 2026-09-01 (D-174); abas Custos/Histórico seguem ABERTAS

`/fornecedores/[supplierId]` (link no nome, na lista): cadastro do parceiro, pedidos de compra linkados, e **"SKUs já comprados"** — derivado dos itens dos pedidos, que é o único vínculo fornecedor→produto REAL. Cancelado aparece em card próprio, nunca somado nem escondido.

- **A ausência que o item mandava não fingir, medida:** `supplier_product_links` **nunca foi criada** e `skus.supplier_brand` é MARCA (19 valores para 3.550 SKUs), sem FK para `suppliers`. Não há catálogo de produtos por fornecedor — a tela diz isso em vez de inventar a aba `Produtos` completa.
- **O que falta:** `Custos` como aba própria (hoje o custo aparece por SKU comprado, do último pedido) e `Histórico` de eventos do relacionamento — ambos esperam volume: a base tem **1 fornecedor e 1 pedido**, e o pedido está cancelado. Uma aba de tendência sobre isso seria gráfico de um ponto.

- **Objetivo/problema:** reunir parceiro, pedidos, custos e histórico sem fingir relação fornecedor→SKU inexistente.
- **Reutiliza:** `suppliers`, pedidos/itens/eventos de compra, custos e `supplier_brand` apenas como eixo distinto.
- **Falta:** rota; abas `Visão Geral | Produtos | Pedidos | Custos | Histórico`; modelagem real fornecedor→SKU antes de afirmar completude em Produtos.
- **Definition of Done:** ausências declaradas; pedidos/custos rastreáveis; marca nunca tratada como FK; RLS/testes; navegação pela lista.
- **Riscos:** confundir marca com entidade de compra, inventar cadastro e agregar custos incompatíveis.
- **Fora da primeira versão:** fornecedores inferidos, CNPJ/prazo fictício e escolha automática.

### Trilha 7C — Aprendizado humano/supervisionado do Copiloto — C

- **Objetivo/problema:** converter correções humanas úteis em conhecimento reutilizável sem a IA aprender sozinha.
- **Reutiliza:** Base de Conhecimento Validada, seus estados, RBAC, auditoria e ferramentas determinísticas.
- **Falta:** oferta explícita do candidato com `Não | Revisar | Registrar/Sugerir`; preservar resposta, correção, contexto e origem; revisão antes da validação.
- **Definition of Done:** nada gravado sem ação humana; sugestão com proveniência; papéis existentes validam; conflitos são sinalizados; Copiloto afirma apenas conhecimento validado; testes de permissão/auditoria.
- **Riscos:** opinião virar fato, dado pessoal/transitório, duplicidade e promoção automática.
- **Fora da primeira versão:** fine-tuning, embeddings/RAG, validação automática e resposta autônoma.

### Trilha 8A — Administração e operação da plataforma

Complementa a Fase 8; suas telas não substituem hardening, backup/restore nem verificação externa.

#### Administração de Usuários e Permissões — B/C — 🟡 PRIMEIRA VERSÃO em 2026-09-01 (D-175); convite/ativação segue ABERTO

`/usuarios` (nav GESTÃO): membros, papel de cada um e acesso por conta, com edição para ADMIN. O que sustenta a tela é tudo de banco — as policies `*_admin_writes` (que já existiam), o **trigger `guard_last_admin`** contra lockout e a auditoria append-only `organization_access_events`.

- **A parte que já existia, medida antes de escrever:** as policies já restringiam escrita a ADMIN, então não foi preciso criar RPC de autorização — a tela escreve direto sob RLS (padrão de D-119) e apenas traduz a recusa do banco.
- **O que faltava era invariante e história:** a policy autorizava o ADMIN a rebaixar a si mesmo, deixando a organização sem administrador; e não havia registro de quem mudou o acesso de quem.
- **Convite/ativação NÃO entrou:** criar usuário exige a Admin API do Auth com `service_role`, que a `web` não tem (e não deve ter). É rota da `api` com decisão de produto própria — quem convida, e-mail, expiração — e fazê-la agora decidiria isso por baixo do pano.
- **Achado registrado como fatia própria:** `private.has_role` não filtra organização, então ADMIN de uma organização ganharia poder de ADMIN em outra onde seja apenas membro. Afeta **21 policies** e 8 funções; inofensivo hoje (uma organização), grave quando houver a segunda.

- **Objetivo/problema:** administrar membros, papéis e acesso por conta sem operação manual de banco.
- **Reutiliza:** organizações, `profiles`, `organization_members`, papéis, `user_account_permissions` e helpers RLS/RBAC.
- **Falta:** UI; fluxo aprovado de convite/ativação; comandos transacionais para papel/escopo; auditoria.
- **Definition of Done:** só ADMIN altera; proteção do último ADMIN; backend/RLS efetivos; testes negativos multi-org/conta; histórico de mudanças.
- **Riscos:** escalada de privilégio, lockout e segurança apenas visual.
- **Fora da primeira versão:** grupos complexos, ACL arbitrária por feature e substituição das policies.

#### Central de Integrações — C/E

- **Objetivo/problema:** centralizar estado e ações seguras de Mercado Livre, UpSeller, IA, Supabase, Google Cloud, webhooks e futuras integrações.
- **Reutiliza:** contas ML/OAuth, `sync_runs`/`sync_errors`, importações UpSeller, `ai_runs`, webhook e configurações existentes.
- **Falta:** catálogo/adaptadores de status; distinção conexão × sincronização × configuração; reconectar/configurar com autorização.
- **Definition of Done:** status e atividade de fonte real; erro sanitizado; zero secret; ações autorizadas; “não verificável” em vez de verde presumido.
- **Riscos:** confundir saúde de integração com plataforma, expor metadados e declarar saúde só por haver configuração.
- **Fora da primeira versão:** painel de secrets, provisionamento cloud e conectores sem necessidade.

#### Administração → Saúde do Sistema — C/E — 🟡 PRIMEIRA VERSÃO em 2026-09-01 (D-176); coletores de nuvem seguem FORA

`/saude` (nav GESTÃO, restrita a ADMIN): commit da web × commit da API com veredito `CURRENT | OUTDATED | UNKNOWN`, migration aplicada (versão, nome, contagem, lida do schema privado) e última execução de cada job com idade e falhas em 24h.

- **Nada deriva de documentação**, como o DoD exige: o commit vem do `/health` e das variáveis de build, a migration vem do banco, os jobs vêm de `job_runs`. `UNKNOWN` aparece como UNKNOWN, com o motivo — nunca como "tudo certo".
- **Sem permissões novas de nuvem**, o risco que o item nomeia: em vez de perguntar ao Cloud Scheduler quais jobs existem, a tela observa o **efeito** (`job_runs` mostra o que rodou). Um scheduler que existe e nunca dispara é indistinguível de um ausente para quem depende do resultado.
- **O commit implantado só existe depois do próximo deploy:** `APP_COMMIT` passou a ser injetado pelo `infra/deploy-cloud-run.sh` nos dois serviços, e a revisão que está no ar hoje é anterior a isso — até lá a tela mostra UNKNOWN dizendo exatamente essa razão.
- **Falta:** comparar migrations esperadas (do repositório) com aplicadas, e o estado de filas/scheduler — ambos exigem coletor autenticado ou artefato de build, que não entraram nesta versão.

- **Objetivo/problema:** detectar drift entre estado esperado e infraestrutura real, separado da Saúde da Sincronização.
- **Reutiliza:** `/health`, metadados de build/deploy, scripts `infra/`, schedulers esperados, migrations e observabilidade.
- **Falta:** contrato seguro de versão para Web/API/Worker/DB/Scheduler/filas; commit esperado; coletores autenticados; `CURRENT | OUTDATED | UNKNOWN`.
- **Definition of Done:** commits esperado/implantado, deploy/erro, migrations e jobs esperados/reais quando verificáveis; `UNKNOWN` se medir falhar; nada deriva de documentação; testes de drift/indisponibilidade.
- **Riscos:** permissões cloud excessivas, cache mascarando drift, tela stale e vazamento de IDs.
- **Fora da primeira versão:** deploy, migration, rollback ou recriação de scheduler pela UI.

#### Administração → Configurações — B/C

- **Objetivo/problema:** dar entrada coerente às configurações distribuídas sem duplicar verdade.
- **Reutiliza:** reposição, preferências de notificação, contas ML, orçamento do Copiloto e organização.
- **Falta:** landing com `Organização | Reposição | Notificações | Mercado Livre | IA/Copiloto | Operação | Preferências`; decidir entre embutir ou apontar para a tela dona.
- **Definition of Done:** um dono por configuração; links/permissões corretos; zero cópia divergente; ausência/erro; acessibilidade.
- **Riscos:** tabela genérica sem semântica, UI/regra duplicada e controle sem autorização.
- **Fora da primeira versão:** mover tudo, flags genéricas e edição de secrets.

### Itens existentes apenas alinhados — A/D/E

- **Dashboard final de Vendas — A/E:** permanece na 5C. Preserva KPIs, visão hoje, escopo por conta, comparação e gráfico já entregues. Só margem operacional depende de frete/descontos; “receita líquida” segue vetado.
- **Dashboard de SKU com abas — A:** permanece no P1, sem duplicata; detalhado no próprio item.
- **Republicação — A:** permanece na Fase 9; alinhamento visual acrescentado ali.
- **Tráfego / Ads — A/E:** visitas/conversão permanecem na 5B; `INTELIGÊNCIA → TRÁFEGO / ADS` é visão futura, mas Ads depende de elegibilidade e necessidade reais.
- **Recebimento parcial — D:** permanece na Fase 4; ciclo visual alinhado sem alterar a máquina atual.

### Ordem recomendada para as novas trilhas

1. **Antes delas:** deploy/validação do `HEAD`; atos humanos de `/produtos` e `/reposicao/configuracoes`; remapeamento e medição da Fase 9 conforme aprovação; verificação de backup da Fase 8.
2. **Experiência sobre dados prontos:** Movimentações; Dashboard 360º do Anúncio; abas do Dashboard de SKU.
3. **Centrais analíticas:** Preços e Full; Fornecedor somente até o limite do relacionamento real.
4. **Administração/hardening:** Usuários; Saúde do Sistema; Integrações; Configurações — Saúde sobe se o risco de drift voltar a crescer.
5. **IA no fim:** aprendizado supervisionado depois de a Base de Conhecimento ser exercitada com uso real.
6. **Dependências:** margem, Ads e recebimento parcial só após dado, elegibilidade ou decisão próprios.

---

## Fase 8 — Hardening e produção

- [ ] Migrar `infra/` de scripts para Terraform
- [ ] Projeto Supabase de produção e Cloud Run de produção
- [ ] Testes de carga e revisão de `pg_stat_statements`
- [ ] Backup e restore verificados — **medição parcial em 2026-08-31 (D-159)**: a metade do SCHEMA já é provada todo dia (CI e o ambiente local recriam as 93 migrations do zero); o buraco é o DADO. Se o projeto Supabase tem backup automático depende do PLANO, que nem o MCP nem a API expõem — **ato do usuário**: Dashboard → Database → Backups do projeto `speedbikers-gestao-v3-dev`, e relatar o que existe (diário? PITR? nada?) antes de qualquer máquina própria de backup ser construída
- [ ] Revisão de segurança e de secrets
- [ ] Rollout da V3

---

## Regra de progressão

Não iniciar features de domínio antes de concluir a arquitetura detalhada e registrar as decisões relevantes.

Não inverter a ordem **confiabilidade dos dados -> métricas corretas -> histórico/eventos -> analytics -> diagnóstico -> ações -> IA** para produzir interface inteligente sobre dados frágeis.

A ordem de execução é **0 -> 1 -> 2 -> 3 -> 5A -> 4 -> 5B -> 6 -> 7 -> 7B -> 4B -> 5C -> 5D -> 6B -> 9** (D-033; 7B acrescentada por D-071; 4B/5C/5D/6B/9 acrescentadas por D-120, sem renumerar nada). **A Fase 8 é intercalável a qualquer momento** — backup/restore verificado não conflita com nenhuma delas e é o único risco que cresce a cada dia de uso real.

As trilhas **5E, 7C e 8A** registram a visão final acrescentada em 2026-08-31 e não entram retroativamente nessa sequência histórica nem reabrem seus marcos. Sua ordem própria está na seção “Trilhas da visão final” e começa somente depois das prioridades operacionais correntes.

A Fase 5A antecede a Fase 4 porque o dashboard de vendas não usa estoque, e a Fase 3 já entrega pedidos confiáveis. A Fase 5B só vem depois da Fase 4 pelo motivo oposto: **dashboard sobre estoque não confiável é pior que dashboard nenhum**, porque produz decisão errada com aparência de certeza.

---

## Próximo passo imediato

> Reescrito em 2026-08-31 (D-155). A versão anterior tinha parado em D-134/D-135, apontando como "próximo passo" a agregação de ruído (resolvida por outro caminho em D-135) e a abertura da 5C — as Fases 5C, 5D e 6B fecharam inteiras desde então. **Esta seção é a que mais envelhece no repositório: reescrevê-la é parte de fechar qualquer etapa, não uma tarefa separada.**

**Fase 6B COMPLETA (D-152→D-155).** Da fila declarada por D-120 (`4B → 5C → 5D → 6B → 9`), resta a **Fase 9** (republicação oficial de anúncio — a primeira escrita destrutiva no ML), com a **Fase 8 intercalável** (backup/restore verificado é o único risco que cresce a cada dia de uso real).

**Antes de abrir a Fase 9, os dois interruptores HUMANOS da 5D seguem desligados** — e são atos do usuário por decisão registrada (D-127/D-144), não do agente:

1. 🟡 **O ensaio operacional de `/produtos`** (D-133): marcar os 5 SKUs candidatos já separados no HANDOFF, conferir em `/cobertura` (devem sair com cobertura VAZIA e rótulo "estoque virtual"), só então o lote grande (~1.089 SKUs com assinatura sentinela). Sem isso, valor de estoque (D-139) e a qualidade da sugestão de compra seguem bloqueados.
2. 🟡 **Preencher `/reposicao/configuracoes`** (D-144): sem configuração, `/reposicao` recusa para todos — é o contrato.

**Decisão de produto pendente sinalizada desde D-135**: `listing.available_quantity.changed` é 91% das notificações (informativo, legítimo) — silenciar, agregar ou manter é escolha do usuário.

~~O **rate limit de `visits`** (85% de falha 429, medido em D-143)~~ — **corrigido em 2026-08-31 (D-156)**: checkpoint pela própria `daily_listing_visits` (cada tentativa soma progresso em vez de recomeçar; o teto de 8 tentativas da fila deixou de arriscar a cauda), espaçamento de 150 ms entre chamadas e enumeração paginada (a 8ª ocorrência da classe D-131, ainda latente: 857 ativos medidos contra o teto de 1.000). **Aguarda deploy do worker e a leitura da rodada seguinte** (regra de D-109 — a confirmação é a queda das ~22 execuções falhas/dia).

~~O item de **Vendas** do PRD que restou da 5C~~ — **seis das sete métricas entregues em 2026-08-31 (D-157 + D-158, visão "hoje" incluída)**; resta só a margem operacional, bloqueada pela persistência de frete/desconto.

~~Abrir a **Fase 9** pela modelagem pai→filho~~ — **aberta em 2026-08-31 (D-159)**: modelo, máquina de estados e idempotência por constraint entregues. **A próxima fatia da Fase 9 é o preflight** (nunca fechar o pai quando pré-condição crítica falha: tag `relist` já presente, Full, catálogo — os bloqueios que a pesquisa mandou impor).

**Outras candidatas**: a **Fase 8** (a metade do DADO do backup espera o relato do Dashboard — ver o item da fase); A margem operacional fechou em D-166 — **o item de Vendas e a Fase 5C estão 100% completos**.

**Registro histórico do que esta seção dizia antes (D-120):**

**Fase 7B COMPLETA (D-116)** e o Copiloto fechado (D-114). Depois disso, quatro etapas:

- **D-117** — dois defeitos P0 achados por auditoria: a Central de Ações quebraria inteira na primeira ação de SAC (`evidence` tem duas formas, a tela lia uma, sem consultar `kind`), e o envio de resposta não checava a CONTA. `private.has_role` sem escopo de organização ficou registrado, não corrigido: 32 sítios, e a verificação adversarial refutou a exploração hoje (1 organização, medido).
- **D-118** — a CI vermelha de D-117 expôs dois defeitos latentes que não eram dela: `knowledge_entries` repetindo o `on delete set null` que D-099 tinha acabado de eliminar, e um teste de escopo que **nasceu impossível de passar** (pedia zero onde a fixture garante 1 desde D-085), o que corrige o registro de D-115.
- **D-119** — vinculação manual livre, o item P1 mais antigo aberto. A revisão adversarial achou 16 defeitos no código recém-escrito, três decisivos — entre eles a feature nascendo MORTA em qualquer organização com 2+ membros.
- **D-120** — os trinta blocos de features do usuário viraram roadmap, depois de auditoria: cinco subfases novas (4B, 5C, 5D, 6B, 9), sem renumerar nada.

**O próximo passo é a Fase 4B**, e não por preferência: a auditoria mediu que 80% das features pedidas leem SKU, vínculo ou saldo local, e os três estão incompletos ou contaminados. O primeiro item é **enumerar o catálogo real do vendedor** — hoje a V3 não sabe quais anúncios existem.

~~**Duas questões de negócio ABERTAS bloqueiam parte da fila** (D-120)~~ — **ambas respondidas pelo usuário em 2026-08-28.** (1) O estoque sentinela **é o estado real do UpSeller, é estoque virtual** deliberado → D-127. (2) "Importado" é **rota de compra por fornecedor**, não origem fiscal → confirmado com número em D-129: `origin_code` da NF-e contradiz a regra em **707 SKUs** e por isso **não serve** como fonte de Nacional/Importado; o eixo é `supplier_brand`.

**Pendências operacionais:** ~~deploy do `apps/api`~~ — feito em 2026-08-28 (`api-00027-lsp`), junto do worker (`worker-00041-x4q`, D-121). Sobre a **CI**: D-130 mediu que ela estava **vermelha desde 2026-08-27** — o teste-guarda de GRANTs de D-098 nunca passou, e como ele só roda na CI (`test` exclui `*.integration.test.ts`), seis commits foram entregues lendo "check 29/29" como se fosse verde. As duas causas foram corrigidas na migration `20260828200541` e as consultas dos testes devolvem zero linhas contra o banco real; **falta a confirmação pela própria CI** (repositório privado, sem token na sessão). 🔴 **Achado de D-132 que vira pendência própria: não existe job de import do ERP.** `erp_stock_snapshots` tem **um único dia** (2026-08-21) e `infra/cloud-scheduler.sh` tem 13 jobs `v3-*`, nenhum de import. O alvo rolado para a frente (D-132) faz o saldo parar de ser apagado, mas ele só melhora quando a planilha do UpSeller for reimportada — quanto mais velho o retrato, mais a V3 depende do próprio ledger. Decidir entre reimportação manual periódica e job próprio é questão em aberto. Seguem abertas: e o **primeiro envio real de resposta** a um comprador (🟡, ato irreversível que deve ser humano e deliberado).
