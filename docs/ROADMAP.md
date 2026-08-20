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
- [ ] Confirmar documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md`
- [ ] Criar fundação técnica/monorepo
- [ ] Criar projeto Vercel V3 conectado à branch `v3`
- [ ] Conectar fundação técnica ao Supabase V3 Dev e Google Cloud sem criar domínio prematuramente

---

## Fase 1 — Fundação técnica

**Objetivo:** pipeline verde ponta a ponta, com zero domínio.

- [x] Monorepo pnpm + Turborepo com os três apps; packages criados conforme a necessidade (`config`, `contracts`, `observability`)
- [x] TypeScript estrito, ESLint, Vitest, `.env.example` completo e validação com Zod no boot
- [ ] Supabase local (CLI/Docker) subindo e aplicando migrations
- [ ] `apps/web` com login Supabase funcionando
- [x] `apps/api` publicado no Cloud Run, com healthcheck e autenticação OIDC
- [x] `apps/worker` publicado no Cloud Run, consumindo um job de teste via Cloud Tasks
- [x] Projeto Vercel V3 conectado à branch `v3`
- [x] CI no GitHub Actions: typecheck, lint, testes e build obrigatórios
- [x] Scripts `infra/` versionados criando filas e buckets (Scheduler e secrets ficam para as Fases 3 e 2)

**Marco:** um job atravessa `api -> Cloud Tasks -> worker -> Postgres` e o `web` mostra o resultado, sem nenhuma regra de negócio envolvida.

---

## Fase 2 — Core de dados

**Objetivo:** identidade, contas e o esqueleto do catálogo, com RLS desde a primeira tabela.

- [ ] Organizações, perfis, papéis e `user_account_permissions`
- [ ] Helpers de RLS `STABLE` e policies com teste negativo obrigatório
- [ ] Contas Mercado Livre, credenciais cifradas e estados de OAuth
- [ ] SKUs, componentes de kit, marcas e fornecedores
- [ ] Anúncios, variações e `sku_listing_links` com UNIQUE parcial para `variation_id` nulo
- [ ] Central de Vinculações: candidatos, resolução por match exato, confirmação humana
- [ ] Importador de planilhas do UpSeller: batches, linhas, promoção em chunks, catálogo e kits (D-028)
- [ ] ETL de carga inicial a partir da V2: vínculos, estoque, NF-e e compras (D-027)
- [ ] `sync_runs`, `sync_errors` e freshness por conta

**Marco:** o ADMIN conecta as contas e o sistema mostra SKU vinculado a MLB, com o catálogo carregado do UpSeller.

---

## Fase 3 — Mercado Livre e histórico

**Objetivo:** dados frescos e confiáveis, com linha do tempo.

- [ ] Cliente `@sb/mercado-livre` com backoff, jitter, `Retry-After` e paginação por cursor
- [ ] Webhook com ACK rápido, zero chamada de rede e teste negativo nas rotas vizinhas
- [ ] Reconciliação por janela via Cloud Scheduler
- [ ] Backfill retomável em fila de prioridade baixa
- [ ] Persistência de pedidos com `pack_id` como entidade de análise
- [ ] Motor de diff e `domain_events` com `dedup_key`
- [ ] Tela de Saúde da Sincronização

**Marco:** pedidos frescos em minutos e linha do tempo do anúncio disponível.

**Depende de:** confirmação da documentação oficial do Mercado Livre.

---

## Fase 5A — Métricas de venda e dashboards Geral/Conta

**Executada antes da Fase 4.** É a tela âncora (D-033) e não depende do estoque.

- [ ] `metric_definitions` e as métricas de venda de `docs/METRICS.md`
- [ ] `daily_listing_metrics` e os dois rollups, com teste de equivalência
- [ ] Recálculo incremental por chave suja e rebuild completo
- [ ] Dashboards Geral e por Conta, com filtros de período e comparação
- [ ] Design system e estados de loading, erro, vazio e stale

**Marco:** você abre a V3 em vez da V2 para olhar vendas.

**Depende de:** Fase 3. **Nenhuma métrica de estoque aparece aqui** — elas chegam na Fase 5B.

---

## Fase 4 — Estoque e compras

**Objetivo:** estoque auditável. É aqui que a V3 vira ferramenta de trabalho.

- [ ] Ledger `stock_movements` com `idempotency_key` UNIQUE
- [ ] Dedução por venda aplicada na persistência do pedido
- [ ] Reversão por cancelamento e devolução
- [ ] Projeção `inventory_balances` e job de conferência contra a soma do ledger
- [ ] NF-e/XML: upload, parse, conferência, confirmação humana, movimentos, `content_hash` UNIQUE
- [ ] Full por conta como snapshot espelhado do ML, com eventos por diff
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

**Fase 1 — fundação técnica.** Não cria nenhuma tabela de domínio e não depende de nenhuma decisão pendente.

Frente paralela: confirmar a documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md`. Ela bloqueia a Fase 3.
