# Roadmap V3

As fases seguem a numeração definida no `docs/PROMPT_MASTER.md` §38. Elas foram **refinadas** com entregáveis e marcos, não renumeradas — alterar as fases silenciosamente é proibido.

Cada fase só é considerada concluída sob a Definition of Done do `docs/PROMPT_MASTER.md` §33.

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

**Marco atingido de verdade em 2026-08-22, com o Fast Path do webhook implementado.** Pedidos ficam frescos **em segundos** no caminho feliz (`sync.webhook.received` → `GET /orders/{id}` → `persistOrder`), com a reconciliação por janela como rede de segurança (até 1h, papel que já tinha). Entre 2026-08-21 e 2026-08-22 o marco original ("em minutos") esteve tecnicamente incorreto — o job era enfileirado mas não tinha handler registrado, descartado após esgotar tentativas; achado em revisão e corrigido na mesma sessão, sem nunca ter sido regressão (`events.detect`, citado como "não implementado, de propósito" no item acima, é a peça que faltava — o Fast Path não usa esse job separado, chama `persistOrder` direto, que já roda o motor de diff inline, mesmo padrão de `sync.orders.window`). Linha do tempo do ANÚNCIO especificamente fica para quando `listings` for construído (não estava no checklist desta fase) — a tela já está pronta para mostrar esse recurso assim que existir.

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
- [x] Reservado e em trânsito — **as duas metades concluídas: RESERVADO em 2026-08-22, TRANSITO em 2026-08-23 (D-055).** Maturidade diferente, mesma implementação de fundo: nenhum código grava `location_kind = 'RESERVADO'` fora da reconciliação contra o UpSeller (item abaixo, ÚNICA fonte — "Ocupado" no ERP vira RESERVADO); TRANSITO nasce do ciclo do pedido de compra (`ENTRADA_TRANSITO` ao marcar `ORDERED`, `RECEBIMENTO_TRANSITO` ao `RECEIVED`/`CANCELLED` em trânsito) — as colunas de trânsito do UpSeller continuam vindo zeradas em 100% do export real (`docs/UPSELLER.md` secao 6), então TRANSITO nunca dependeu de reconciliação, só do ciclo interno do pedido
- [x] **Reconciliação contra o snapshot do UpSeller, com movimento `AJUSTE_RECONCILIACAO` e evento crítico** (D-029) — concluído em 2026-08-22: `compute_erp_snapshot_balances` (snapshot mais recente por SKU) comparado contra `inventory_balances` via `computeReconciliationAdjustments` (`@sb/domain/inventory`, puro), job `maintenance.reconcile-balances` disparado diariamente por organização (`POST /internal/schedule/maintenance`, Cloud Scheduler). Evento `stock.balance.diverged` exigiu D-054 (`domain_events.ml_account_id` nullable — estoque é organizacional, não pertence a uma conta ML)
- [ ] **Mercado Livre — Pós-venda (Claims/Returns, `order.returned`)** — integrar a API de Reclamações e Devoluções, detectar `order.returned` (hoje só existe como nota solta em dois lugares: linha do motor de diff na Fase 3 e na reversão por cancelamento acima) e aplicar reversão de estoque simétrica à de cancelamento (`computeCancellationReversals`). Promovido de nota solta para item próprio em 2026-08-22 (achado em revisão) — sem prazo, depende da API estar disponível para a conta
- [x] Pedidos de compra: ciclo, histórico por evento, nacional versus importado — concluído em 2026-08-22: `suppliers`/`purchase_orders`/`purchase_order_items`/`purchase_order_events`, ciclo `DRAFT->APPROVED->ORDERED->RECEIVED` (+`CANCELLED`), RPCs `security definer` (mesmo padrão de `resolve_link_candidate`/`link_document_item`), telas `/fornecedores` e `/compras`. "Nacional versus importado" não ganhou coluna nova — a tela puxa `skus.is_imported`, já existente desde a Fase 2. **Escopo desta fatia**: recebimento tudo-ou-nada (sem `PARTIALLY_RECEIVED`); sem geração de `stock_movements` ainda (schema/ciclo primeiro, é o que destrava TRANSITO — ver item acima); sem tela de edição do rascunho (RPC `update_purchase_order_draft` já pronta). Desenhado com base no schema real da V2 (D-040: 1 pedido real, fornecedor Navetec, 5 itens, 8 eventos), mesmo princípio de evidência medida já usado em D-037/D-039/D-048/D-053
- [x] Exportação do pedido de compra em Excel (principal) e PDF (D-034) — concluído em 2026-08-23: usuário liberou implementar com layout PRÓPRIO ("faça do jeito que você achar bem profissional"), a ajustar quando o modelo oficial chegar — ver `docs/HANDOFF.md`
- [x] **Geração de `stock_movements` (`ENTRADA_TRANSITO`/`RECEBIMENTO_TRANSITO`) a partir do ciclo do pedido de compra** — concluído em 2026-08-23 (D-055): TRANSITO nasce ao marcar o pedido `ORDERED` (compromisso de compra assumido, não confirmação do fornecedor — a V3 não tem como observar isso sem integração) e fecha ao `RECEIVED` ou ao `CANCELLED` enquanto `ORDERED`. NÃO gera LOCAL — isso continua sendo exclusivo da NF-e (`ENTRADA_NFE`), desacoplado de propósito. Item sem `sku_id` vinculado não gera movimento, mesmo padrão de `computeSaleDeductions`/`computeNfeApplicationMovements`
- [x] **Tela de edição do pedido em `DRAFT`** — concluído em 2026-08-23: `/compras/[id]/editar`, reaproveita `PurchaseOrderForm`/`ItemRow` de `novo/` (mesmo formulário, agora pré-preenchido, apontando para `update_purchase_order_draft` em vez de `create_purchase_order`). Link "Editar" só aparece com o pedido em `DRAFT`
- [ ] **Recebimento parcial de pedido de compra** (hoje é tudo-ou-nada) — decisão de escopo deliberada, não bloqueio; entra quando o volume real de uso mostrar que vale a pena

**Marco:** o estoque responde "por que este número é este" movimento a movimento, e a divergência contra o ERP é visível em vez de silenciosa.

---

## Fase 5B — Analytics de estoque, sortimento e tráfego

- [ ] **Sincronização de listings/anúncios** (pré-requisito não nomeado explicitamente até 2026-08-22, achado em revisão) — `docs/DATABASE.md` já modela `listings`/`listing_variations`/`listing_price_states`, mas nenhum job os popula a partir do Mercado Livre; "Dashboards de SKU e de Anúncio" abaixo depende disso existir primeiro
- [ ] Cobertura, ruptura, vendas perdidas estimadas
- [ ] Curva ABC e filtros de Full
- [ ] Dashboards de SKU e de Anúncio
- [ ] Visitas, conversão e Ads (D-032)
- [ ] **Busca Universal / Command Palette** e **Filtros salvos** — requisitos formais em `docs/PRODUCT_REQUIREMENTS.md` (linhas 20, 26, 150-152) que nunca tinham sido copiados para o roadmap; achado em revisão, 2026-08-22
- [ ] Playwright nos fluxos críticos

**Marco:** o diagnóstico passa a distinguir queda de tráfego de queda de conversão.

**Depende de:** Fase 4.

---

## Fase 6 — Diagnóstico e Ações

- [ ] Baseline, desvio e detecção estatística sem machine learning
- [ ] Correlação com `domain_events` datados
- [ ] Contrato de diagnóstico com evidências e confiança
- [ ] Central de Ações unificando problema e oportunidade
- [ ] Decisões com `baseline_snapshot` e medição posterior em 7/15/30 dias

**Marco:** o sistema responde "por quê", com evidência e nível de confiança.

**Depende de:** Fase 3 concluída — sem evento datado, diagnóstico é conjectura.

---

## Fase 7 — Notificações e Copiloto

- [ ] Regras evento -> notificação, severidade e agrupamento por janela
- [ ] Realtime, toasts no canto inferior direito e Central de Notificações
- [ ] Preferências por usuário
- [ ] Registro de ferramentas do Copiloto e orquestração com streaming
- [ ] `ai_runs` com custo e escopo
- [ ] Ação contextual "O que aconteceu?"
- [ ] Sugestões de features estruturadas
- [ ] Simulador de decisão onde houver base matemática

**Marco:** o sistema fala com você, citando escopo e evidência.

---

## Fase 8 — Hardening e produção

- [ ] Migrar `infra/` de scripts para Terraform
- [ ] Projeto Supabase de produção e Cloud Run de produção
- [ ] Testes de carga e revisão de `pg_stat_statements`
- [ ] Backup e restore verificados
- [ ] Revisão de segurança e de secrets
- [ ] Rollout da V3

---

## Regra de progressão

Não iniciar features de domínio antes de concluir a arquitetura detalhada e registrar as decisões relevantes.

Não inverter a ordem **confiabilidade dos dados -> métricas corretas -> histórico/eventos -> analytics -> diagnóstico -> ações -> IA** para produzir interface inteligente sobre dados frágeis.

A ordem de execução é **0 -> 1 -> 2 -> 3 -> 5A -> 4 -> 5B -> 6 -> 7 -> 8** (D-033).

A Fase 5A antecede a Fase 4 porque o dashboard de vendas não usa estoque, e a Fase 3 já entrega pedidos confiáveis. A Fase 5B só vem depois da Fase 4 pelo motivo oposto: **dashboard sobre estoque não confiável é pior que dashboard nenhum**, porque produz decisão errada com aparência de certeza.

---

## Próximo passo imediato

**Fase 2 concluída** (2026-08-21) — identidade, contas, catálogo, importador do UpSeller com aplicação e Central de Vinculações, e o schema de observabilidade de sincronização. Ver `docs/HANDOFF.md` para o estado verificado.

**Fase 3 — Mercado Livre e histórico — CONCLUÍDA** (2026-08-21). Os oito itens do checklist prontos: cliente `@sb/mercado-livre`, webhook, conexão OAuth de conta, reconciliação por janela, backfill retomável, persistência estruturada de pedidos, motor de diff/`domain_events` e a Tela de Saúde da Sincronização (`/sincronizacao`) — ver `docs/HANDOFF.md`.

**Fase 5A — Métricas de venda e dashboards Geral/Conta — CONCLUÍDA** (2026-08-21). Os cinco itens do checklist prontos: `metric_definitions`, fato + rollups diários, recálculo incremental/rebuild, e o Dashboard `/vendas` (Geral e por Conta na mesma tela, filtro de período, comparação, os quatro estados) — ver `docs/HANDOFF.md`.

Pela ordem de execução da D-033 (`0 -> 1 -> 2 -> 3 -> 5A -> 4 -> 5B -> 6 -> 7 -> 8`), a próxima fase é **4 — Estoque e compras**. **Bloqueio real, já registrado desde a sessão de arquitetura:** os pedidos de compra precisam de modelos de exportação em Excel e PDF fornecidos pelo usuário — "solicitar antes do início da Fase 4" (`docs/HANDOFF.md`, seção "Pendência operacional aberta"; D-034). O ledger de estoque (`stock_movements`, dedução por venda, reversão) não depende desses modelos e pode começar antes; a exportação do pedido de compra especificamente, sim.
