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

**Marco atingido:** pedidos frescos em minutos (reconciliação por janela + webhook) e histórico com `domain_events`. Linha do tempo do ANÚNCIO especificamente fica para quando `listings` for construído (não estava no checklist desta fase) — a tela já está pronta para mostrar esse recurso assim que existir.

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
- [x] Dedução por venda aplicada na persistência do pedido — concluído em 2026-08-21: `@sb/domain/inventory` (`computeSaleDeductions`, puro) decide o que deduzir; `apps/worker/src/handlers/persist-order.ts` chama a cada order persistida. Venda válida = `paid`/`partially_refunded` (mesma semântica de D-050); KIT deduz os COMPONENTES, nunca o próprio kit (`docs/DATABASE.md` secao 4); item sem vínculo não deduz nada, resolve sozinho quando o vínculo nascer. Chave de idempotência não inclui status — reprocessar em qualquer status válido não deduz duas vezes
- [x] Reversão por cancelamento e devolução — concluído em 2026-08-22 para CANCELAMENTO (D-052): `computeCancellationReversals` (`@sb/domain/inventory`) reverte os movimentos `VENDA_ML` já gravados no ledger, não recalcula dos itens atuais — imune a vínculo trocado entre venda e cancelamento. DEVOLUÇÃO fica de fora de propósito, mesmo motivo já registrado para `order.returned`: depende da API de Reclamações e Devoluções, não integrada
- [x] Projeção `inventory_balances` — concluído em 2026-08-21: mantida por trigger na mesma transação de cada `stock_movements` (correta por construção, não por recálculo assíncrono); `private.compute_inventory_balances_from_ledger` soma o ledger do zero e serve de base ao job de conferência. **Job agendado (Cloud Scheduler + evento crítico na divergência) ainda não construído** — não há nada real para conferir enquanto nenhum código grava movimento; entra quando a dedução por venda existir
- [ ] NF-e/XML: upload, parse, conferência, confirmação humana, movimentos, `content_hash` UNIQUE
- [x] Full por conta como snapshot espelhado do ML, com eventos por diff — concluído em 2026-08-22 para itens sem variação: schema, detector de diff, job de captura (`sync.fulfillment.snapshot`) e gatilho automático (`POST /internal/schedule/fulfillment`, Cloud Scheduler a cada 6h). Caso com variação fica de fora de propósito — a doc oficial não mostra o path exato de `inventory_id` dentro de `variations[]` (`docs/MERCADO_LIVRE.md` secao 2.7), REGRA ABSOLUTA proíbe presumir
- [ ] Reservado e em trânsito
- [ ] **Reconciliação contra o snapshot do UpSeller, com movimento `AJUSTE_RECONCILIACAO` e evento crítico** (D-029)
- [ ] Pedidos de compra: ciclo, histórico por evento, nacional versus importado
- [ ] Exportação do pedido de compra em Excel (principal) e PDF (D-034)

**Marco:** o estoque responde "por que este número é este" movimento a movimento, e a divergência contra o ERP é visível em vez de silenciosa.

**Solicitar ao usuário antes de começar:** modelos de exportação em Excel e PDF.

---

## Fase 5B — Analytics de estoque, sortimento e tráfego

- [ ] Cobertura, ruptura, vendas perdidas estimadas
- [ ] Curva ABC e filtros de Full
- [ ] Dashboards de SKU e de Anúncio
- [ ] Visitas, conversão e Ads (D-032)
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
