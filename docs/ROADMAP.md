# Roadmap V3

As fases seguem a numeração definida no `docs/PROMPT_MASTER.md` §38. Elas foram **refinadas** com entregáveis e marcos, não renumeradas — alterar as fases silenciosamente é proibido.

Cada fase só é considerada concluída sob a Definition of Done do `docs/PROMPT_MASTER.md` §33.

> **Itens concluídos aparecem resumidos** — título, data e `D-xxx`. O texto
> integral de cada um está em `docs/archive/roadmap/2026-09-02_detalhe-dos-itens-concluidos.md`,
> e o motivo de cada decisão continua em `docs/DECISIONS.md`. Itens abertos e
> parciais estão na íntegra, aqui.

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

- [x] Cliente `@sb/mercado-livre` com backoff, jitter, `Retry-After` e paginação por cursor — ✔ 2026-08-21
- [x] Webhook com ACK rápido, zero chamada de rede e teste negativo nas rotas vizinhas — ✔ 2026-08-21 · D-043/D-045
- [x] Conexão OAuth de conta (connect + callback), tokens cifrados em repouso — ✔ 2026-08-21 · D-046
- [x] Reconciliação por janela via Cloud Scheduler — ✔ 2026-08-21
- [x] Backfill retomável em fila de prioridade baixa — ✔ 2026-08-21
- [x] Persistência de pedidos com `pack_id` como entidade de análise — ✔ 2026-08-21 · D-020/D-048
- [x] Motor de diff e `domain_events` com `dedup_key` — ✔ 2026-08-21
- [x] Tela de Saúde da Sincronização — ✔ 2026-08-21

**Fase 3 CONCLUÍDA em 2026-08-21.** Todos os oito itens do checklist prontos e testados. Verificada num navegador real (`/sincronizacao`, login ADMIN de verdade) — o banco Dev não tem nenhuma conta Mercado Livre conectada ainda, então a tela mostra corretamente os dois estados vazios; os cards com dado (frescor calculado, lista de eventos) foram verificados por build + typecheck + lint + revisão de código, seguindo o mesmo padrão visual já testado visualmente em `/vinculacoes`, não por captura de tela com dado real — ver `docs/HANDOFF.md`.

**CORREÇÃO EM 2026-08-25 (D-091): este marco NUNCA foi atingido em produção.** Medido em 30 dias de log de requisição do Cloud Run: `/webhooks/mercado-livre` recebeu UMA requisição no período, e foi um teste interno. O Mercado Livre nunca entregou uma notificação — nem `orders_v2`, nem `post_purchase`, nem `questions`. **O frescor dos pedidos vem, desde sempre, da reconciliação de hora em hora**, que funciona e por isso escondeu a ausência do caminho principal. Falta configurar a URL de callback e os tópicos no painel de aplicações do Mercado Livre (`docs/DEPLOYMENT.md`, passo externo). O texto abaixo descreve o que o CÓDIGO faz — que está implementado e testado —, não o que acontece hoje em produção.

**MARCO ATINGIDO DE VERDADE EM 2026-08-27 (D-101), revertendo a correção acima.** O usuário configurou o painel (URL de callback exata + todos os tópicos) e o webhook recebeu tráfego real pela primeira vez na história do projeto: ~100 notificações em 2h, de 9 tópicos (`stock-locations` 45, `shipments` 23, `payments` 7, `orders_v2` 3, `post_purchase` 3). **E o primeiro tráfego real quebrou três contratos que nunca tinham rodado** — exatamente o que D-091 previa: `GET /orders/{id}` não traz `date_last_updated` (48 retries em 2h para 3 pedidos), ZodError classificado como retryable num erro determinístico, e sub-recursos de claim (`/claims/{id}/actions-history`) fora do padrão aceito. Corrigidos e comprovados em produção (`worker-00028-m2p`): o fast path drenou os retries e processou 13 pedidos reais + 2 claims, com zero `job_failed` na janela. **Pedidos frescos em segundos passam a valer de verdade**, com a reconciliação de hora em hora de volta ao papel de rede de segurança em vez de único caminho. Ver D-101 em `docs/DECISIONS.md`.

~~**Marco atingido de verdade em 2026-08-22, com o Fast Path do webhook implementado.**~~ Pedidos ficariam frescos **em segundos** no caminho feliz (`sync.webhook.received` → `GET /orders/{id}` → `persistOrder`), com a reconciliação por janela como rede de segurança (até 1h, papel que já tinha). Entre 2026-08-21 e 2026-08-22 o marco original ("em minutos") esteve tecnicamente incorreto — o job era enfileirado mas não tinha handler registrado, descartado após esgotar tentativas; achado em revisão e corrigido na mesma sessão, sem nunca ter sido regressão (`events.detect`, citado como "não implementado, de propósito" no item acima, é a peça que faltava — o Fast Path não usa esse job separado, chama `persistOrder` direto, que já roda o motor de diff inline, mesmo padrão de `sync.orders.window`). Linha do tempo do ANÚNCIO especificamente fica para quando `listings` for construído (não estava no checklist desta fase) — a tela já está pronta para mostrar esse recurso assim que existir.

- [x] **Fast Path do webhook** — ✔ 2026-08-22 · D-051

**Desbloqueada em 2026-08-21** — documentação oficial do Mercado Livre confirmada (`docs/MERCADO_LIVRE.md`, D-041 a D-043).

---

## Fase 5A — Métricas de venda e dashboards Geral/Conta

**Executada antes da Fase 4.** É a tela âncora (D-033) e não depende do estoque.

- [x] `metric_definitions` e as métricas de venda de `docs/METRICS.md` — concluído em 2026-08-21: seis definições canônicas, espelho imutável no banco e RLS de leitura para membros
- [x] `daily_listing_metrics` e os dois rollups, com teste de equivalência — ✔ 2026-08-21
- [x] Recálculo incremental por chave suja e rebuild completo — ✔ 2026-08-21 · D-051
- [x] Dashboards Geral e por Conta, com filtros de período e comparação — ✔ 2026-08-21
- [x] Design system e estados de loading, erro, vazio e stale — ✔ 2026-08-21

**Fase 5A CONCLUÍDA em 2026-08-21.** Os dois itens restantes do checklist prontos e verificados rodando (login real, Supabase Dev real, sem erro). Ver `docs/HANDOFF.md`.

**Marco atingido, mecanicamente:** você abre a V3 em vez da V2 para olhar vendas — o caminho completo (filtro → RPC → RLS → tela) funciona ponta a ponta. **Ressalva honesta:** os quatro backfills de 12 meses ainda não terminaram, então nenhuma janela real tem dado histórico suficiente para comparar visualmente com a V2 ainda — isso é completude de dado, não de funcionalidade, e não bloqueava o fechamento da fase pelos mesmos critérios já usados para a Fase 3.

**Depende de:** Fase 3. **Nenhuma métrica de estoque aparece aqui** — elas chegam na Fase 5B.

---

## Fase 4 — Estoque e compras

**Objetivo:** estoque auditável. É aqui que a V3 vira ferramenta de trabalho.

- [x] Ledger `stock_movements` com `idempotency_key` UNIQUE — ✔ 2026-08-21 · D-018
- [x] Dedução por venda aplicada na persistência do pedido — ✔ 2026-08-21 · D-050/D-019
- [x] Reversão por cancelamento e devolução — ✔ 2026-08-22 · D-052
- [x] Projeção `inventory_balances` — ✔ 2026-08-21
- [x] **Conferência automática ledger × projeção, com evento crítico na divergência** — ✔ 2026-08-23 · D-056
- [x] **Ajuste manual de estoque (tela/ação)** — ✔ 2026-08-23
- [x] NF-e/XML: upload, parse, conferência, confirmação humana, movimentos, `content_hash` UNIQUE — ✔ 2026-08-22
- [x] Full por conta como snapshot espelhado do ML, com eventos por diff — ✔ 2026-08-22
- [x] Reservado e em trânsito — ✔ 2026-08-29 · D-134/D-131/D-132/D-109/D-055
- [~] 🔴 **Reconciliação contra o snapshot do UpSeller** (D-029) — **estava CORROMPENDO o saldo em vez de reconciliar, de 25 a 28/08/2026; dois defeitos independentes corrigidos em D-131 e D-132.** (1) As duas leituras vinham truncadas em 1.000 linhas (contra 6.744 e 2.524), o ledger ausente virava zero e o snapshot inteiro era reaplicado todo dia — SKU com saldo **4×** o real, e 1.628 SKUs nunca semeados, 1.627 deles negativos. (2) O alvo era o retrato cru, então o job **desfazia a venda de cada dia** enquanto ninguém reimportasse a planilha; agora o alvo é `snapshot + movimentos posteriores à captura` (`compute_erp_target_balances`), o que também torna o job idempotente entre dias. **Só volta a `[x]` quando a rodada de 2026-08-29 for lida e o saldo conferido contra o ERP.** Implementação original, preservada: ~~concluído em 2026-08-22: `compute_erp_snapshot_balances` (snapshot mais recente por SKU) comparado contra `inventory_balances` via `computeReconciliationAdjustments` (`@sb/domain/inventory`, puro), job `maintenance.reconcile-balances` disparado diariamente por organização (`POST /internal/schedule/maintenance`, Cloud Scheduler). Evento `stock.balance.diverged` exigiu D-054 (`domain_events.ml_account_id` nullable — estoque é organizacional, não pertence a uma conta ML)~~ **AUDITADO EM 2026-09-03 (D-223): CONTINUA `[~]`, e a prova é que diz.** A condição deste item é dupla — "a rodada de 2026-08-29 lida **e o saldo conferido contra o ERP**". D-134 cumpre a primeira: leu a execução (`snapshot_rows` 6.744, `ledger_rows` 2.529, `skus_compared` 3.372, `adjustments` 3.300) e mediu **zero divergências em 3.472 chaves**. Mas isso é consistência INTERNA — projeção contra soma do ledger. **Conferir contra o ERP é abrir o UpSeller e comparar: ato humano**, movido para a lista de atos humanos do HANDOFF. (D-134 diz "fecha o item da Fase 4 que estava `[~]`" sobre **RESERVADO**, que é outro item e já está `[x]`.)
- [x] **Mercado Livre — ✔ 2026-08-23 · D-057
- [x] Pedidos de compra: ciclo, histórico por evento, nacional versus importado — ✔ 2026-08-22 · D-040/D-037/D-039/D-048/D-053
- [x] Exportação do pedido de compra em Excel (principal) e PDF (D-034) — ✔ 2026-08-23 · D-034
- [x] **Geração de `stock_movements` (`ENTRADA_TRANSITO`/`RECEBIMENTO_TRANSITO`) a partir do ciclo do pedido de compra** — ✔ 2026-08-23 · D-055
- [x] **Tela de edição do pedido em `DRAFT`** — ✔ 2026-08-23
- [ ] **Recebimento parcial de pedido de compra** (hoje é tudo-ou-nada) — categoria **D, evolução futura sem bloquear a Fase 4**. A visão final prevê o ciclo `RASCUNHO -> APROVADO/ENVIADO -> PEDIDO/CONFIRMADO quando aplicável -> EM_TRANSITO -> RECEBIDO_PARCIALMENTE -> RECEBIDO | CANCELADO`. A máquina atual não será alterada sem decisão arquitetural própria sobre quantidades por item, idempotência, trânsito e eventos. 🔵 **NÃO BLOQUEIA A V3** (D-223). V3.1+: a máquina de estados só muda com uso real que justifique.

**Marco — ATINGIDO em 2026-08-23.** O estoque responde "por que este número é este" movimento a movimento (ledger auditável, D-006/D-019), e a divergência contra o ERP é visível em vez de silenciosa (D-029). Todos os itens reais do checklist fechados — só resta recebimento parcial de pedido de compra, decisão de escopo deliberada (D-040), não bloqueio.

---

## Fase 5B — Analytics de estoque, sortimento e tráfego

- [x] **Sincronização de listings/anúncios** — ✔ 2026-08-23 · D-058
- [ ] Cobertura, ruptura, vendas perdidas estimadas — **cobertura e ruptura concluídas em 2026-08-23**: `/cobertura` lista todo SKU com estoque local ou venda nos últimos 30 dias (janela fixa, sem seletor nesta fatia), com dias de cobertura (`estoque local ÷ venda média diária`) e sinalização de ruptura (sem estoque local, mas com venda no período). Tudo somado em SQL (`get_stock_coverage`, RPC `security invoker`), nunca em JS, por `docs/ARCHITECTURE.md` seção 21. **"Vendas perdidas estimadas" ADIADO (D-061, achado em 2026-08-23)** — testado contra o banco real antes de implementar: as 2.194 SKUs com movimento local na organização de demonstração estão TODAS em ruptura e NENHUMA jamais teve saldo positivo no ledger (só `VENDA_ML`/`CANCELAMENTO_ML` existem, nunca `ENTRADA_NFE` — o backfill trouxe histórico de venda, nunca saldo inicial). Sem um ponto positivo no ledger, "quando a ruptura começou" é indefinido — não é lacuna de código, é lacuna de completude do backfill; fica para quando houver saldo inicial importado ou histórico orgânico suficiente em produção. **REAVALIADO em 2026-08-27 (varredura de alinhamento): a condição está substancialmente satisfeita desde 2026-08-25** — a reconciliação diária contra o UpSeller (D-029, 896 AJUSTE_RECONCILIACAO sobre 1000 SKUs) é funcionalmente o "saldo inicial importado por SKU" que D-061 pedia, de fonte confiável; rupturas iniciadas DEPOIS do primeiro ajuste têm início detectável no ledger. Limitações que restam: profundidade de histórico (~dias, crescendo), cobertura parcial (SKU fora do snapshot do UpSeller segue sem ponto de partida) e a cadência de importação de planilhas (snapshot velho pode mascarar o cruzamento). Implementável agora — a mecânica melhora sozinha com o tempo; aguarda priorização, não mais dado 🔵 **NÃO BLOQUEIA A V3** (D-223). **Cobertura ✅ e ruptura ✅ estão entregues**; só "vendas perdidas" segue aberta, e é **DEPENDENTE DE DADO** (D-061: o ledger não tem saldo inicial, então não há como saber quando a ruptura começou).
- [x] **Curva ABC e filtros de Full** — ✔ 2026-08-23
- [x] **Dashboards de SKU e de Anúncio** — ✔ 2026-08-23
- [ ] Visitas, conversão e Ads (D-032) — **visitas e conversão concluídas em 2026-08-23** (D-059): `/anuncios` ganhou colunas "Visitas" e "Conversão" via `get_listing_traffic` (full outer join entre `daily_listing_visits`, novo, sincronizado diariamente de `GET /items/{id}/visits/time_window`, e `daily_listing_metrics`). Conversão = pedidos ÷ visitas, calculada em SQL, `NULL` (não `Infinity`) sem visita no período. **Ads ADIADO** — exige `advertiser_id` próprio por conta com elegibilidade condicionada (reputação, tempo de conta, mínimo de vendas), sem evidência de que a conta Mercado Livre da Speed Bikers tenha o produto habilitado; integração do tamanho de Claims/Returns ou listings, escopo próprio quando houver evidência real de necessidade. **Marco desta fase ATINGIDO em 2026-08-25** — a validação com dado real de produção que faltava foi feita no Checkpoint pré-Fase 7: `v3-listing-visits-snapshot` rodou na cadência esperada (7h/SP) e as 3 contas ML completaram com `items_failed: 0` (945+984+808 itens), 429 intermitente do Mercado Livre absorvido pelo retry existente. O texto anterior ("Marco ainda não atingido") ficou desatualizado entre 2026-08-25 e a correção, apesar de o próprio Checkpoint mais abaixo neste arquivo já registrar a confirmação 🔵 **NÃO BLOQUEIA A V3** (D-223). **Visitas ✅ e conversão ✅ estão entregues** (D-059/D-170) — o checkbox aberto é só por causa de **Ads**, que é **FUTURO**: depende de `advertiser_id`, de elegibilidade real e de necessidade real (D-059). Um checkbox só para as três não deve dar a impressão de que as três faltam.
- [x] **Busca Universal / Command Palette** e **Filtros salvos** — ✔ 2026-08-22 · D-060/D-062
- [x] **Playwright nos fluxos críticos** — ✔ 2026-08-24 · D-069

**Marco:** o diagnóstico passa a distinguir queda de tráfego de queda de conversão.

**Depende de:** Fase 4.

---

## Fase 6 — Diagnóstico e Ações

- [x] **Baseline, desvio e detecção estatística sem machine learning** — ✔ 2026-08-24 · D-063
- [x] **Correlação com `domain_events` datados** — ✔ 2026-08-24 · D-063
- [x] **Contrato de diagnóstico com evidências e confiança** — ✔ 2026-08-24 · D-063
- [x] **Central de Ações unificando problema e oportunidade** — ✔ 2026-08-24 · D-064
- [x] **Decisões com `baseline_snapshot` e medição posterior em 7/15/30 dias** — ✔ 2026-08-24 · D-065

**Marco:** o sistema responde "por quê", com evidência e nível de confiança. **Atingido em 2026-08-24.**

**Depende de:** Fase 3 concluída — sem evento datado, diagnóstico é conjectura.

---

## Checkpoint de consolidação pré-Fase 7 — 2026-08-24

Este checkpoint NÃO é uma nova fase e NÃO altera a numeração definida pela D-033.

Objetivo: consolidar lacunas identificadas durante a revisão da implementação real antes de aprofundar a camada de IA.

Nenhuma funcionalidade concluída das Fases 0 a 6 deve ser removida ou reimplementada do zero.

### P0 — Confiabilidade antes da Fase 7

- [x] **Confirmar `maintenance.reconcile-balances` no próximo ciclo natural depois do fix que eliminou a lista excessiva de UUIDs no PostgREST** — ✔ 2026-08-25 · D-081
- [x] **Confirmar `sync.listing-visits.snapshot` com dado real e cadência normal, sem disparar jobs pesados simultaneamente** — ✔ 2026-08-25
- [x] **Criar/fechar Playwright para os fluxos críticos que continuam pendentes da Fase 5B** — ✔ 2026-08-24 · D-069
- [x] **Auditar os serviços implantados contra a infraestrutura real antes de declarar deploy concluído: Web, API, Worker, migrations e Cloud Scheduler** — ✔ 2026-08-24 · D-070/D-089/D-097/D-100/D-134/D-108
- [x] Corrigir documentação de deploy para refletir exatamente o mecanismo real utilizado; não afirmar CI/CD automático de Cloud Run enquanto ele não existir — ✔ 2026-08-24
- [x] **Revisar GRANTs das tabelas antigas de escrita exclusiva por RPC/service_role, seguindo o achado D-062** — ✔ 2026-08-24 · D-062/D-066
- [x] **Corrigir tratamento explícito de `.error` em persistências críticas onde o Supabase client puder continuar o fluxo depois de falha** — ✔ 2026-08-24 · D-067

### P0 — Pré-requisito das notificações

- [x] **Implementar motor determinístico de diff de estado de anúncio antes de criar notificações de mudanças** — ✔ 2026-08-24 · D-072
- [x] **Emitir inicialmente `domain_events` para mudanças comprovadamente observáveis: preço, título, status e quantidade disponível** — ✔ 2026-08-24 · D-072
- [ ] Pesquisar documentação oficial atual antes de adicionar foto principal, descrição, promoção, catálogo ou outros estados. **Nota de alinhamento (2026-08-27): não é esquecimento — nunca foi executado, e ficou MAIS BARATO desde D-101**: o webhook vivo entrega os tópicos `items`/`items_prices`/`public_offers`/`price_suggestion`/`catalog_*` de verdade, e `GET /missed_feeds` (retenção 2 dias) permite auditar corpos reais — evidência que não existia quando o item foi escrito. Segue aberto aguardando execução 🔵 **NÃO BLOQUEIA A V3** (D-223). **FUTURO** — os quatro eventos observáveis (preço, título, status, quantidade) já emitem desde D-072.
- [x] **Garantir `dedup_key` e idempotência dos eventos de anúncio** — ✔ 2026-08-24 · D-072
- [x] **Garantir que reprocessamento do mesmo snapshot não gere mudança falsa** — ✔ 2026-08-24 · D-072
- [x] Somente depois conectar esses eventos a `notifications` — ✔ 2026-08-24 · D-073/D-074/D-076

### P1 — Alinhamento com requisitos funcionais já aprovados

> Alinhamento (2026-08-27, a pedido do usuário): os 7 itens abertos abaixo NÃO são esquecimento nem bloqueio — são fila deliberada que ficou atrás da Fase 7/7B na priorização. Nenhum depende de decisão de produto pendente; qualquer um pode ser puxado quando o usuário priorizar. O próprio arquivo já registra: "Itens P1 e P2 podem continuar evoluindo incrementalmente".

- [ ] Implementar filtros de Conta / Origem / Marca nas telas em que fizerem sentido, preservando a distinção entre estoque físico compartilhado e Full por conta.
- [ ] Impedir mistura de SKU Nacional e Importado no mesmo pedido de compra.
- [x] Criar fluxo de vinculação manual `Conta + MLB + variation_id? -> SKU` sem exigir `link_candidate` prévio — ✔ 2026-08-28 · D-119/D-117
- [ ] Criar alias reutilizável `Fornecedor + código do produto -> SKU` quando um vínculo for confirmado.
- [ ] Evoluir o Dashboard de SKU para abas/progressive disclosure — **primeira migração feita em 2026-08-31 (D-169); o item segue ABERTO de propósito, porque o próprio item manda "migrar incrementalmente" e faltam 6 das 11 abas.** Entregue: `Visão geral | Estoque | Anúncios | Histórico | Diagnóstico` na URL (`?aba=`), com progressive disclosure de verdade — cada aba dispara SOMENTE as suas consultas (a página saiu de 5 consultas fixas para 1–3). Valor fora do conjunto fechado cai para a Visão geral antes de tocar o banco. Vendas ficou como dois números na Visão geral, não como aba. **Primeira tela do projeto VISTA RENDERIZADA** (ensaio local com screenshot de cada aba). **ESCOPO REDUZIDO EM 2026-09-03 (D-224): 11 abas → 9.** Saem `Tráfego` (pertence ao ANÚNCIO — visita é medida por `item_id`, e o Dashboard 360º de D-168 é o dono) e `Atendimento` (não existe vínculo confiável SKU → `support_case`: D-084 registra que um case tem vários SKUs, sem "principal"). **Conferido no código em 2026-09-03:** 8 das 9 existem — as cinco de D-169 mais `Full` (D-225) e `Preços` (D-226) por reuso de RPC existente, e `Vendas` (D-227) com a única RPC nova das abas, `get_sku_sales_breakdown` (total, por conta e por dia num round trip, via grouping sets; razões sobre as somas). **Falta só `Decisões`** — não bloqueada por dado (D-169), caminho medido no HANDOFF. Categoria **B** de D-223.
  - **O que falta, e por quê** — nenhuma das seis está bloqueada por falta de dado, o que muda quem pode puxá-las: `Full` (dado em `fulfillment_stock_snapshots` por SKU+conta), `Decisões` (alcança o SKU por `actions.sku_id`), `Preços` (`listing.price.changed`) e `Tráfego` (`daily_listing_visits` por anúncio) precisam de **consulta agregada por SKU** — somar em JS dentro da tela violaria a regra de agregação em SQL. `Vendas` como aba própria só se ganhar recorte além dos dois números. `Atendimento` é a única sem caminho pronto: `support_cases` não tem vínculo de SKU (liga por anúncio).
- [x] Reorganizar a navegação em grupos, evitando todas as telas no mesmo nível — ✔ 2026-08-24 · D-068
- [x] Substituir a Home de construção pela Home orientada a “o que precisa da minha atenção hoje?” — ✔ 2026-08-27 · D-105
- [x] Adicionar as entidades novas que já possuem destino real à Busca Universal, incluindo Central de Ações quando aplicável — ✔ 2026-09-02 · D-216. Entraram **atendimento** (`/atendimento/{id}`) e **NF-e** (`/notas-fiscais/{id}`); **anúncio** e **fornecedor** deixaram de cair na lista e passaram a apontar para a página individual, que existe desde D-168/D-174. **Central de Ações fica de fora com medição**, não com "ainda não existe": `/acoes` não tem rota por id nem lê `searchParams`, e a cláusula é "quando aplicável".

### P2 — Backlog registrado, sem bloquear a Fase 7

- [ ] Avaliar exportação XML estruturada própria do pedido de compra, mantendo Excel/PDF já implementados e sem confundir XML interno com NF-e. 🔵 **NÃO BLOQUEIA A V3** (D-223). V3.1+: Excel e PDF já existem; XML próprio não se constrói só para fechar checklist.
- [ ] Implementar DANFE/PDF como fallback de NF-e quando houver necessidade real e fonte confiável. 🔵 **NÃO BLOQUEIA A V3** (D-223). V3.1+: o fluxo oficial por XML já é operacional.
- [ ] Reavaliar recebimento parcial de pedido de compra quando o uso real justificar. 🔵 **NÃO BLOQUEIA A V3** (D-223). Mesmo item acima, na lista de backlog.
- [ ] Reavaliar vendas perdidas estimadas quando o ledger tiver saldo inicial/histórico positivo confiável. 🔵 **NÃO BLOQUEIA A V3** (D-223). **DEPENDENTE DE DADO**, mesmo motivo de D-061.
- [ ] Reavaliar Ads somente quando uma conta real comprovar elegibilidade e necessidade. 🔵 **NÃO BLOQUEIA A V3** (D-223). **FUTURO** — sem evidência de elegibilidade, não se integra.

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

- [x] **Regras evento -> notificação, severidade e agrupamento por janela** — ✔ 2026-08-24 · D-073/D-075
- [x] **Realtime, toasts no canto inferior direito e Central de Notificações** — ✔ 2026-08-24 · D-074/D-075
- [x] **Preferências por usuário** — ✔ 2026-08-24 · D-073/D-076
- [x] **Registro de ferramentas do Copiloto e orquestração com streaming** — ✔ 2026-08-25 · D-077/D-082/D-114
- [x] **`ai_runs` com custo e escopo** — ✔ 2026-08-25 · D-077/D-082
- [ ] **Ação contextual "O que aconteceu?"** — **primeira fatia concluída em 2026-08-25 (D-078)**: botão no Dashboard de SKU (`/skus/[skuId]`), mesmo motor de `/diagnostico`/Central de Ações, sob demanda para um SKU só (`get_sku_sales_baseline` ganhou `p_sku_id` opcional). **Narração por IA implementada e deployada em 2026-08-25 (D-082)**: botão "Narrar com IA", Claude Haiku 4.5 narra o contrato já calculado. **Continua pendente**: KPIs/gráficos do Dashboard de Vendas e nível de conta — dependem de sinais de diagnóstico que ainda não existem (só vendas por SKU hoje). 🔵 **NÃO BLOQUEIA A V3** (D-223). A primeira fatia está entregue (D-078/D-082); **expandir para outras superfícies é evolução**, não lançamento.
- [x] **Sugestões de features estruturadas** — ✔ 2026-08-25 · D-079/D-082/D-112
- [x] **Simulador de decisão onde houver base matemática** — ✔ 2026-08-25 · D-080/D-058

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

- [x] Pesquisa oficial das APIs de Perguntas e Mensagens — ✔ 2026-08-25 · D-083
- [x] Modelo unificado de atendimento — ✔ 2026-08-25 · D-084
- [x] Núcleo read-only de banco — ✔ 2026-08-25 · D-085
- [x] Núcleo isolado de Perguntas — ✔ 2026-08-25 · D-086
- [x] Handler unitário de detalhe de Pergunta — ✔ 2026-08-25 · D-087
- [x] Produtor de webhook do tópico `questions` — ✔ 2026-08-25 · D-088
- [x] Reconciliação de Perguntas — ✔ 2026-08-25 · D-089/D-088/D-087
- [x] Ingestão read-only (perguntas, mensagens, reclamações, devoluções, mediações) — ✔ 2026-08-27 · D-108/D-088/D-089/D-097/D-104/D-106/D-107/D-057/D-084/D-115/D-102/D-086
- [x] Caixa de entrada unificada — ✔ 2026-08-25 · D-090/D-084
- [x] Triagem interna (assumir, mudar status, resolver/reabrir) — ✔ 2026-08-26 · D-094
- [ ] Notificações de atendimento — **primeira fatia em 2026-08-27 (D-110)**: `support.claim.disputed` (`importante`), emitido pela reconciliação quando observa mediação aberta nascida depois da época `max(deploy, connected_at)` — chave terminal, zero migration, severidade CALIBRADA com dado real (17 mediações novas/dia mataram o `critico` proposto). **Segue aberto**: `customer_replied` (melhor candidato — a RPC de D-102 já devolve se a transição aplicou), `sla_at_risk` (espera o job com relógio de D-107), perguntas/mensagens (severidade condicional sem limiar definido) e `opened` (35/dia medidos — adiado com o número registrado). Situação linha a linha em `docs/API.md` secao 9 🔵 **NÃO BLOQUEIA A V3** (D-223). O núcleo existe (D-110); eventos adicionais evoluem depois.
- [x] Detalhe do atendimento (conversa + contexto) — ✔ 2026-08-26 · D-095
- [x] Resposta manual pelo sistema — ✔ 2026-08-26 · D-096
- [x] Templates e respostas rápidas — ✔ 2026-08-28 · D-111/D-079/D-096/D-083
- [x] Copiloto sugerindo respostas — ✔ 2026-08-28 · D-112/D-077/D-096/D-111
- [x] Base de Conhecimento Validada — ✔ 2026-08-28 · D-113
- [x] Métricas de SAC — ✔ 2026-08-28 · D-115/D-090/D-107
- [x] Detecção de padrões -> Central de Ações — ✔ 2026-08-28 · D-116/D-064
- [x] Integração com Diagnóstico como fonte de evidência adicional — ✔ 2026-08-28 · D-116

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

- [x] **Enumerar o catálogo real do vendedor** — ✔ 2026-08-28 · D-121/D-109
- [x] ~~Abrir `link_candidates` para o Mercado Livre~~ — ✔ 2026-08-28 · D-122/D-121
- [x] **Sincronizar anúncios COM variação** — ✔ 2026-08-28 · D-123/D-124
- [x] **Vinculação manual livre** — concluída em 2026-08-28 (D-119)
- [x] **Desfazer vínculo + histórico auditável de vínculo** — ✔ 2026-08-28 · D-125/D-126
- [x] **Tela de integridade de vinculações** com reconciliação INDEPENDENTE por conta — ✔ 2026-08-28 · D-128
- [x] 🔴 **Decidir o estoque sentinela** — ✔ 2026-08-28 · D-127
- [~] **Vínculo fornecedor → SKU** — **eixo de nomeação entregue em D-129 e CAMINHO DE PREENCHIMENTO entregue em D-133** (`/produtos` preenche `supplier_brand` em lote, com `MANUAL` blindando contra re-derivação); **a FK segue aberta.** Achado que destrava: `skus.brand` **não é marca, é a categoria do UpSeller** (66% em 'MANETE') e o importador a sobrescreve a cada planilha — por isso a marca real virou `skus.supplier_brand` + `supplier_brand_source` (`DERIVED`/`MANUAL`), fora do alcance do importador. **1.280 de 3.554 semeados; 2.274 em branco de propósito**, para preenchimento manual. `skus.supplier_id` **não** foi criado: `suppliers` tem UMA linha (PLASMOTO, nascida de um pedido real) e criar 19 fornecedores vazios seria inventar entidade — marca de catálogo e entidade de compra não são a mesma coisa 🔵 **NÃO BLOQUEIA A V3** (D-223) — **DEPENDENTE DE RELAÇÃO INEXISTENTE**: D-174 mediu que `supplier_product_links` nunca foi criada e `skus.supplier_brand` é MARCA, sem FK para `suppliers`. Só avança quando existir confirmação humana real que produza o vínculo.
- [x] 🔴 **Consertar o truncamento de 1.000 linhas do PostgREST** — ✔ 2026-08-28 · D-131/D-132
- [x] **Ferramenta de marcação em lote de `stock_is_virtual`** — ✔ 2026-08-28 · D-133/D-127/D-129

---

### Fase 5C — Dashboards operacionais e filtros padronizados

**Depende de:** 4B para os itens que envolvem anúncio e estoque. Os de venda pura podem andar antes.

- [x] **Vendas**: taxas do ML, margem operacional por pedido, pedidos/valor cancelados, taxa de cancelamento, SKUs distintos vendidos, visão "hoje". Definições em `docs/METR… — ✔ 2026-08-31 · D-157/D-166/D-158/D-165/D-156/D-149
- [x] **Gráfico com métrica trocável** (faturamento/unidades/pedidos/packs) — ✔ 2026-08-29 · D-136/D-137
- [x] **Anúncios como dashboard** — ✔ 2026-08-29 · D-138/D-131/D-121/D-122
- [x] **Estoque enriquecido** — ✔ 2026-08-29 · D-139/D-129/D-127/D-133/D-134
- [x] **Curva ABC com escopo e critério** — ✔ 2026-08-29 · D-140
- [x] **Filtros padronizados** — ✔ 2026-08-29 · D-141
- [x] **Saúde da sincronização** — ✔ 2026-08-30 · D-143

---

### Fase 5D — Reposição e compra inteligente

**Depende de:** 4B inteira. A questão de negócio foi respondida (D-127: é estoque virtual deliberado), e o bloqueio virou **pré-condição técnica nomeada** — a marcação em lote de . Sugestão de compra sobre SKU não marcado continua sendo ficção; a diferença é que agora o sistema sabe dizer isso.

- [x] **Configuração de reposição** — ✔ 2026-08-30 · D-144/D-127/D-133
- [x] **Tendência determinística** — ✔ 2026-08-30 · D-145
- [x] **Definição de "estoque real aproveitável"** — ✔ 2026-08-30 · D-146/D-139
- [x] **Sugestão de compra auditável** — ✔ 2026-08-30 · D-147/D-080
- [x] **Estados operacionais calculados** — ✔ 2026-08-30 · D-148/D-080/D-144
- [x] **Custo de simulação separado do custo cadastrado** — ✔ 2026-08-30 · D-149
- [x] **Priorização de compras** — ✔ 2026-08-30 · D-150/D-080
- [x] **Da cobertura para o pedido de compra** — ✔ 2026-08-30 · D-151/D-055/D-129/D-144

---

### Fase 6B — Diagnóstico narrado, timeline e ações acionáveis

**Depende de:** 5C para os sinais novos. A narração em si já tem motor (D-082).

- [x] **Correlação alcançar eventos de anúncio e pedido** — ✔ 2026-08-30 · D-152/D-020
- [x] **Timeline de evidências** — ✔ 2026-08-31 · D-153/D-152
- [x] **IA explicando a AÇÃO** — ✔ 2026-08-31 · D-155/D-082/D-100/D-152
- [x] **Atalhos operacionais na Central de Ações** — ✔ 2026-08-31 · D-154
- [x] **Ruído antes da inteligência** — ✔ 2026-08-30 · D-152/D-134/D-135

---

### Fase 9 — Escrita no Mercado Livre: republicação oficial

**Depende de:** 4B (saber quais anúncios existem), 6B (recomendar com evidência) e do motor de alterações de anúncio. É a **primeira escrita destrutiva do projeto** — hoje só existe uma escrita no ML, e é responder pergunta.

- [x] **Pesquisa oficial** — ✔ 2026-08-28 · D-159
- [x] **Modelo pai → filho** e a operação rastreável por estados, com idempotência própria — ✔ 2026-08-31 · D-159/D-099/D-149
- [x] **Preflight** que nunca fecha o anúncio quando uma pré-condição crítica falha — ✔ 2026-08-31 · D-160/D-162/D-161
- [x] **Snapshot antes da ação** e remapeamento obrigatório de variações depois — snapshot ✓ (D-161, capturado na criação); **executor até RELISTED ✓ (D-162)**: re-preflight NA HORA → fechar → POST → confirmar filho (só por id ≠ pai — resposta ambígua é RELIST_FAILED), re-entrante por estado (persistido ANTES do ato que descreve; retomada em RELISTING vira RELIST_FAILED — repetir o POST poderia criar dois filhos; POST falho nunca re-tenta, padrão D-096), transições por CAS. **REMAPEAMENTO entregue em D-163** (`complete_listing_relist_remap`, transação única service_role-only): vínculo de ITEM preserva o link_id e troca a referência (evento `REFERENCE_REMAPPED` com `previous_item_id`); variação renovada vira candidato `source=RELIST` na Central de Vinculações (decisão humana; `seller_custom_field` só como pista) com os vínculos antigos suprimidos contra a planilha velha; projeção do filho nasce em `listings` já com o SKU. RELISTED retoma pelo remapeamento no executor — item completo **AUDITADO EM 2026-09-03 (D-223): vira `[x]`.** O próprio texto já terminava em "item completo" e o código confirma — `complete_listing_relist_remap` na migration `20260831145457`, chamada em `relist-execute.ts:189`, com cobertura no teste de integração. O checkbox é que tinha ficado para trás.
- [x] **Bloqueio inicial de Full e Catálogo** — ✓ D-160 (`FULL_BLOQUEADO`/`CATALOGO_BLOQUEADO`), re-avaliado na execução (D-162)
- [x] **Permissão específica** imposta no backend, e confirmação humana explícita — ✔ D-161/D-162
- [x] **Medição 7/15/30 dias** reaproveitando `action_decisions`/`action_outcomes` (D-065) — ✔ 2026-08-31 · D-065/D-164/D-159

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

### Trilha 8B — Performance, Segurança, Confiabilidade e Contexto dos Agentes

Frente transversal aberta em 2026-09-01. **Não renumera nem reabre fase alguma**: complementa a Fase 8 (hardening) e a 8A (administração), atacando gargalos medidos em vez de suposições. A regra da trilha é uma só — `MEDIR → IDENTIFICAR → PRIORIZAR → CORRIGIR → TESTAR → REMEDIR → DOCUMENTAR`. Otimização sem antes/depois registrado em `docs/PERFORMANCE.md` não recebe `[x]`.

**Baseline medido contra o Dev em 2026-09-01** (usuário autenticado real, não `service_role`): `docs/PERFORMANCE.md`.

#### P0 — o que está errado agora

- [x] **P0-A — ✔ 2026-09-01 · D-177
- [x] **P0-B — Writes sem verificação em `persist-order.ts`** — ✔ 2026-09-01 · D-178/D-187. **O checkbox ficou aberto por engano, e a conferência foi no CÓDIGO, não no documento:** os três writes que o item nomeia estão embrulhados em `assertWritten` (`orders.upsert`, `order_items.upsert` e `order_items.delete` da cauda — o item dizia `insert`, que virou `upsert` em D-190), a varredura alcançou 7 sítios em 3 arquivos, e os três testes que o item exigia existem e passam: *falha ao gravar a order aborta antes de evento e de estoque*, *falha ao apagar a cauda aborta antes de deduzir estoque*, *falha ao gravar os itens aborta antes de deduzir estoque*.
- [x] **P0-C — ✔ 2026-09-01 · D-179
- [x] **P0-D — ✔ 2026-09-01 · D-180
- [x] **P0-E — ✔ 2026-09-01 · D-182
- [x] **Escopo de organização em duas FKs escolhidas pelo cliente** — ✔ D-182/D-180
- [x] **`get_system_health`: escopo de plataforma com guard de tenant** — ✔ 2026-09-02 · D-182/D-209
- [x] **`ml_accounts`: UPDATE/DELETE para `authenticated` sem consumidor, e sem trilha de auditoria** — ✔ 2026-09-02 · D-182/D-210
- [x] **`pg_default_acl`: o que D-182 deixou aberto** — ✔ 2026-09-02 · D-182/D-211
- [x] **P0-F — ✔ 2026-09-01 · D-181
- [x] **P0-G — ✔ 2026-09-01 · D-181
- [x] **P0-H — ✔ 2026-09-01 · D-183/D-181

#### P1 — depois que o P0 fechar

- [x] ~~Round trips de `persistOrder`: buscar vínculos, `kind` de SKU e componentes de KIT em lote, **em vez de por item**~~ — ✔ 2026-09-01 · D-184
- [x] **Fundir vínculo + `kind` + componentes num embed só** — ✔ 2026-09-01 · D-188/D-186
- [x] **Projeções do PostgREST que ainda não têm portão** — ✔ 2026-09-01 · D-191/D-188
- [x] ~~**Reduzir a população de casts sobre resultado de embed**~~ — ✔ 2026-09-01 · D-192
- [x] **Onde o cast É redundante, removê-lo — ✔ 2026-09-02 · D-200/D-192
- [x] **Os quatro casts que sobraram com defesa em jogo** — ✔ 2026-09-02 · D-206
- [x] **Lote de LEITURA por página de pedidos** em `fetchOrdersWindow` — ✔ 2026-09-01 · D-186/D-131
- [x] **Lote de ESCRITA por página** — ✔ 2026-09-01 · D-190/D-186/D-188/D-189/D-187
- [x] ~~**Medir uma chamada pelo pooler Postgres direto contra a mesma pelo PostgREST**~~ — ✔ 2026-09-01 · D-185
- [x] **Promover erro não-23505 a crítico** em `recordStockMovements` — ✔ 2026-09-01 · D-187
- [ ] **Reprocessar os 2 pedidos sem `order_items`** (`2000017347483988`, `2000017394032682`) — **medido em 2026-09-02 (D-208), e o item mudou de natureza.** O dano hoje é **zero**: os dois estão `delivered` desde julho, com **0** casos de atendimento, **0** eventos de devolução e **0** movimentos de reversão; a dedução de estoque está correta (`TP036` −1, `YD8JAK` −1). E o reprocessamento **não é ato pendente de aprovação: é ato sem mecanismo** — `sync.orders.window` e `backfill.orders` só aceitam `{ mlAccountId }`, e o cliente só tem `fetchOrdersWindow`; **não existe `GET /orders/{id}` no código**. Reconstruir a linha do movimento seria inventar dado (`item_id`, `variation_id` e preço só o ML tem). Construir o job para 2 linhas em 338.791 sem dano é a infraestrutura prematura que a missão proíbe — **fica aberto de propósito**, e o que tornava a falta perigosa já foi fechado por D-208 (a perda agora vira `order.return.unreversed`, `critico`, em `domain_events`, em vez de sumir num `logger.warn`). 🔵 **NÃO BLOQUEIA A V3** (D-223). **D-208 mediu o dano em ZERO** e mostrou que não existe mecanismo para reprocessar — o preventivo (`order.return.unreversed`, crítico) é que era a fatia, e está entregue. Não se constrói infraestrutura para reparar duas linhas sem dano.
- [x] **Read models para o que é consultado repetidamente** — ✔ 2026-09-02 · D-204/D-173
- [ ] Retenção de telemetria: `job_runs` só depois de reduzir a origem (P0-C), separando auditoria de negócio de telemetria operacional. **ENDEREÇADA em D-218/D-221/D-222**: a metade de TEMPO fechou (skip scan, 1.134 → 0,462 ms), e a de DISCO virou limpeza única de um defeito morto — migration `20260903120000`, 278.371 linhas. ⚠️ **Aguardando a CI aplicar no Dev** (130 de 131 em 2026-09-03). Nenhum mecanismo permanente de expurgo foi criado: o ritmo atual não justifica.
- [x] **Índices: triagem caso a caso** — ✔ 2026-09-02 · D-198
- [x] **Volume de escrita das métricas diárias** — ✔ 2026-09-02 · D-199
- [x] **Remedir o custo do Realtime** — ✔ 2026-09-02 · D-198
- [x] **Cloud Tasks × Cloud Run × limites do ML como um sistema só** — ✔ 2026-09-02 · D-201
- [x] **Falha "permanente" não é permanente** — ✔ 2026-09-02 · D-202
- [x] ~~**Espalhar a rajada do snapshot de visitas**~~ — ✔ 2026-09-02 · D-203/D-156
- [x] **Varredura sistemática da classe de truncamento de 1.000 linhas (D-131)** — ✔ 2026-09-01 · D-131/D-193
- [x] **Filtro de marcas de `/estoque` e `/reposicao`** — ✔ 2026-09-01 · D-194
- [x] **Frontend: waterfalls** — ✔ 2026-09-02 · D-195/D-185
- [x] **Frontend: N+1 e leituras em fila que a regex não via** — ✔ 2026-09-02 · D-197/D-195
- [x] **Frontend: dados carregados por aba não aberta** — ✔ 2026-09-02 · D-197
- [x] **Observabilidade: relatório de performance sobre o que já existe** — ✔ 2026-09-02 · D-205/D-198/D-179

#### P2 — produção

- [ ] Load tests, backup/restore verificado, Terraform, Supabase e Cloud Run de produção, rollout. ⚠️ **CHECKBOX AGREGADO — não representa trabalho além do que a Fase 8 detalha abaixo** (D-223). Os mesmos cinco assuntos aparecem item a item em "Fase 8 — Hardening e produção"; contar os dois seria contabilizar a mesma pendência duas vezes. Fica como índice, e o trabalho real é medido na Fase 8.
- [ ] **Atos externos** (não são código): branch protection da `v3` (hoje `protected: false`, CI não é tecnicamente obrigatória) e `Leaked Password Protection` no Auth do Supabase.

#### Definition of Done da trilha

Comportamento anterior preservado; bug com teste de regressão; migration versionada; RLS testada, cross-org quando pertinente; `check`, `build`, integração em banco recriado e Playwright verdes; advisor relido quando aplicável; **benchmark antes/depois em `docs/PERFORMANCE.md`**; `HANDOFF` atualizado sem virar diário; `D-xxx` quando houver decisão arquitetural.

### Ordem recomendada para as novas trilhas

1. **Antes delas:** deploy/validação do `HEAD`; atos humanos de `/produtos` e `/reposicao/configuracoes`; remapeamento e medição da Fase 9 conforme aprovação; verificação de backup da Fase 8.
2. **Experiência sobre dados prontos:** Movimentações; Dashboard 360º do Anúncio; abas do Dashboard de SKU.
3. **Centrais analíticas:** Preços e Full; Fornecedor somente até o limite do relacionamento real.
4. **Administração/hardening:** Usuários; Saúde do Sistema; Integrações; Configurações — Saúde sobe se o risco de drift voltar a crescer.
5. **IA no fim:** aprendizado supervisionado depois de a Base de Conhecimento ser exercitada com uso real.
6. **Dependências:** margem, Ads e recebimento parcial só após dado, elegibilidade ou decisão próprios.

---

## Fase 8 — Hardening e produção

- [ ] Migrar `infra/` de scripts para Terraform 🔵 **NÃO BLOQUEIA A V3** (D-223). V3.1+ / Infra (D-223): desejável para evoluir a infraestrutura, **não é blocker funcional**. Não elimina backup, restore, segurança, produção, load tests nem rollout.
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

**Esta seção foi aposentada em 2026-09-02 (D-215), e o motivo é estrutural.**

Ela era um segundo dono para a pergunta *"onde o projeto está agora?"* — e o
dono é o `docs/HANDOFF.md` desde D-177. Dois donos para o mesmo fato só
podem divergir, e divergiram: o texto mandava "abrir a Fase 9 pelo preflight",
que fechou em D-162/D-164, e o próprio parágrafo de abertura já avisava ser
*"a seção que mais envelhece no repo"*. Um aviso de que o texto mente não
conserta o texto.

**Onde procurar, agora:**

| Preciso de… | Leia |
|---|---|
| onde o projeto está e qual o próximo passo | `docs/HANDOFF.md` |
| por que uma decisão foi tomada | `docs/DECISIONS_INDEX.md` → `D-xxx` |
| o que falta em cada fase | os itens `[ ]` e `[~]` deste arquivo |

O texto anterior está inteiro em
`docs/archive/roadmap/2026-09-02_proximo-passo-imediato-aposentado.md`.
