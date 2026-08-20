# Handoff V3

> Última atualização: 2026-08-20 — **Fase 1 concluída**: corrente completa até o Postgres, verificada em produção.

## Estado atual

- Branch: `v3`
- Referência V2: commit `8573d971a5cd427702575b52ed249c53588ec5ca` da `main`
- V3 reconstruída como branch limpa, **sem código de aplicação e sem migrations**.
- Supabase V3 Dev: criado em São Paulo (`sa-east-1`), mantido **sem tabelas de domínio**.
- Google Cloud V3: fundação criada em São Paulo (`southamerica-east1`). Cloud Run, Cloud Tasks, Scheduler, Secret Manager e Storage ainda não provisionados.
- Vercel V3: **criado e no ar**, branch `v3`.
- Monorepo, CI e ambientes: criados. Falta o ambiente de produção (Fase 8).

## Última etapa concluída

**Arquitetura inicial da V3 aprovada** e registrada na documentação:

- `docs/ARCHITECTURE.md` — reescrito como mapa da arquitetura, com dono documental por assunto.
- `docs/DECISIONS.md` — decisões **D-011 a D-026** registradas com motivo, alternativas e evidência medida na V2.
- `docs/ROADMAP.md` — Fases 0 a 8 refinadas com entregáveis, marcos e dependências.
- Documentação especializada criada: `DATABASE.md`, `API.md`, `METRICS.md`, `MERCADO_LIVRE.md`, `NOTIFICATIONS.md`, `COPILOT.md`, `DEPLOYMENT.md`, `TESTING.md`.

## Auditoria da V2 realizada nesta sessão

A `main` foi consultada **apenas como referência**, sem cópia de código. O que foi levantado:

- **57 tabelas** e **~90 funções** no schema da V2.
- Volumes reais: 4 contas ML · 328.211 pedidos e 328.211 itens (o Mercado Livre não entrega pedido multi-linha; compra de vários itens vira vários pedidos ligados por `pack_id`, e 189.158 tinham um) · 180.306 linhas de métricas diárias por produto · ~5.243 alertas operacionais abertos · 17 respostas HTTP 429 em 24 h.
- O relatório de auditoria técnica da V2 (`auditoria/RELATORIO.md` na `main`) forneceu as evidências medidas que sustentam D-014, D-015, D-017, D-019 e D-026.

### Achado que a documentação da V3 não cobria: UpSeller

A V2 tem **13 tabelas `upseller_*`**, um bucket privado de Storage e dois workers dedicados. Na prática, **o catálogo de produtos, os kits, o estoque e a relação canal-SKU não nasciam no sistema — nasciam de planilhas XLSX exportadas do UpSeller** e promovidas em chunks.

O `docs/PRODUCT_REQUIREMENTS.md` menciona "planilha de estoque" apenas de passagem, na Central de Vinculações. Isso subdimensiona o que era, na V2, a fonte primária do catálogo. Virou a **decisão pendente B**.

### Segundo achado

A V2 **já tinha** diagnóstico por IA e oportunidades (`product_diagnostic_runs`, `product_market_research_runs`, `product_opportunities`, `organization_ai_settings`). O que ela **nunca teve** foi notificação em tempo real, Copiloto, sugestões de feature, memória de decisões e catálogo de métricas — esses cinco são genuinamente novos na V3.

---

## Decisões respondidas em 2026-08-19

Os oito itens **A** a **H** foram respondidos e registrados como **D-027 a D-034** em `docs/DECISIONS.md`. **Nenhuma decisão de produto segue aberta.**

| Item | Resposta | Decisão |
|---|---|---|
| **A** — migração de dados da V2 | Backfill do ML para pedidos e anúncios; ETL apenas do insubstituível (vínculos, estoque, NF-e, compras) | D-027 |
| **B** — UpSeller | Permanece como ERP; a V3 reconstrói o importador e mantém as duas pontas alinhadas | D-028 |
| **B2** — divergência de estoque | UpSeller vence, com movimento `AJUSTE_RECONCILIACAO` auditável e evento crítico | D-029 |
| **C** — retenção do payload bruto | 90 dias quente mais arquivamento frio, por lifecycle do bucket | D-030 |
| **D** — Modelo A | Confirmado | D-012 |
| **E** — `organization_id` | Manter em todas as tabelas | D-031 |
| **F** — visitas, conversão e Ads | Fase 5B | D-032 |
| **G** — tela âncora | Dashboard de vendas Geral e por Conta; Fase 5 dividida em 5A e 5B | D-033 |
| **H** — exportação de compra | Excel é o principal; PDF secundário; XML adiado | D-034 |

### As três consequências que mais alteraram o plano

**1. O UpSeller vira parte do núcleo, não um anexo (D-028, D-029).** Como o lançamento manual acontece nos dois sistemas, a reconciliação deixa de ser opcional. O ledger da V3 nasce **completo e autossuficiente** — não é espelho do UpSeller — e o ERP entra como fonte de alinhamento por snapshot. Isso preserva o caminho para a V3 assumir como ERP no futuro sem reescrita: o que sai naquele dia é a importação e a conciliação, não o modelo de estoque.

**2. A ordem das fases mudou (D-033).** A tela âncora é o Dashboard de vendas, que **não depende do estoque**. A Fase 5 foi dividida: **5A** (métricas de venda e dashboards Geral/Conta) roda logo após a Fase 3, antes da Fase 4; **5B** (cobertura, ABC, Full, visitas, Ads) roda depois da Fase 4. A ordem do `docs/PROMPT_MASTER.md` §37 é preservada, porque a Fase 3 já entrega pedidos confiáveis e nenhuma métrica de estoque aparece antes da Fase 4.

**3. O domínio `catalog` cresceu (D-028).** Entram tabelas de importação, catálogo e kits importados, snapshots de estoque do ERP, aliases de loja e candidatos de vínculo.

### Pendência operacional aberta

**Modelos de exportação do pedido de compra (Excel e PDF)** serão fornecidos pelo usuário mediante solicitação. **Solicitar antes do início da Fase 4.**

---

## Pendência técnica externa

Antes de congelar o capítulo de sincronização é preciso **confirmar a documentação oficial atual do Mercado Livre**: tópicos de webhook disponíveis, mecanismo oficial de recuperação de notificação perdida, política de rate limit vigente e modelo de autorização multi-conta.

Conforme `docs/PROMPT_MASTER.md` §9, nada disso será inventado. `docs/MERCADO_LIVRE.md` contém a lista de verificação e está marcado como pendente nesses pontos.

---

## Regra de início de sessão

Antes de alterar código, ler:

1. `README.md`
2. `AGENTS.md`
3. `docs/PROMPT_MASTER.md`
4. `docs/HANDOFF.md`
5. `docs/ROADMAP.md`
6. `docs/ARCHITECTURE.md`
7. `docs/PRODUCT_REQUIREMENTS.md`
8. `docs/AGENT_ROLES.md`
9. `docs/DECISIONS.md`
10. a documentação especializada do assunto da tarefa (`DATABASE`, `API`, `METRICS`, `MERCADO_LIVRE`, `NOTIFICATIONS`, `COPILOT`, `DEPLOYMENT`, `TESTING`)

Depois verificar branch, `git status` e commits recentes.

---

## Fase 1 em andamento

**Concluído:**

- Monorepo pnpm 11.22 + Turborepo 2.10.11 no ar; `pnpm install` limpo.
- `packages/config` com `tsconfig.base.json` estrito (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `packages/contracts` com o envelope de job e `toTaskName`, base da deduplicação de fila.
- ESLint 10.8.1 com `typescript-eslint` em modo `strictTypeChecked` e checagem com informação de tipos, no preset `@sb/config/eslint`.
- Separação `tsconfig.json` (typecheck, inclui testes) e `tsconfig.build.json` (build, exclui testes).
- TypeScript fixado na 6.0.3 por restrição do `typescript-eslint` — ver **D-035**.
- Telemetria anônima do Turborepo desativada.
- `packages/observability`: log estruturado JSON com `severity`/`message` (formato que o Cloud Logging interpreta), redação de segredo por nome de chave, e `measure` que só loga acima de 1.500 ms ou em falha.
- `apps/api` (Hono + Cloud Run): validação de ambiente com Zod no boot, `request_id` propagado do header ao log, `/health`, e envelope de erro padrão sem vazar interno.
- `apps/worker` (Hono + Cloud Run): registro de handlers por tipo de job, validação do envelope e **classificação de retry pelo status HTTP** — 200 conclui, 400 e 422 descartam, 503 repete com backoff.
- `esbuild` liberado explicitamente em `pnpm-workspace.yaml`: o pnpm 11 bloqueia scripts de instalação por padrão, e cada liberação ali é decisão de supply chain.

**Verificado:** `pnpm run check` verde nas 14 tarefas, **64 testes passando**, build gerando `dist` com `.d.ts` e sourcemaps, cache do Turborepo funcionando.

Verificado em execução, não só em teste: a `api` responde `GET /health` 200 e 404 no envelope padrão; o `worker` responde `system.ping` com 200 e tipo desconhecido com 400; ambiente inválido derruba o processo com exit 1 listando todos os problemas de uma vez.

**Ambiente local:** Node 24.18.1, npm 11.16.0, pnpm 11.22.0, git 2.55, **Docker Desktop 4.87 funcionando**, **Google Cloud SDK 581.0.0**. Falta só a CLI da Supabase, que entra como devDependency do repositório.

**Restrição de máquina:** 6,9 GB de RAM. A stack local completa do Supabase (cerca de dez containers) não cabe confortavelmente. Plano A: WSL limitado a 3 GB com 8 GB de swap e apenas os containers necessários. Plano B, se travar: testes de integração contra o Supabase V3 Dev na nuvem, em schema isolado. O conserto real é 16 GB de RAM — não bloqueia a Fase 1, mas vai pesar a partir da Fase 5.

**Google Cloud (`speedbikers-gestao-v3`, `southamerica-east1`):** billing habilitado, ADC criada, APIs habilitadas.

Provisionado: filas `analytics-recompute` (10/s, 20), `backfill` (1/s, 2) e `maintenance` (1/s, 1); buckets `raw-ml` (com ciclo STANDARD -> COLDLINE aos 90 dias), `erp-imports` e `documents`.

**Service accounts já existiam no projeto** e a convenção delas foi adotada, em vez de criar identidades paralelas: `v3-api-runtime`, `v3-worker-runtime`, `v3-tasks-invoker`, `v3-scheduler-invoker`. Papéis são concedidos no recurso (fila, bucket), nunca no projeto.

**No Windows:** usar `gcloud.cmd`, não `gcloud`. O wrapper `.ps1` é bloqueado pela política de execução do PowerShell (`Restricted` por padrão). Os scripts de `infra/` já tratam isso.

- `apps/web` (Next.js 16.3.1 + React 19.2.8): paleta oficial como tokens CSS, página de fundação, build estático verde.
- `.env.example` completo e versionado, com as variáveis futuras listadas mas comentadas — declarar segredo antes do uso só impede o desenvolvimento local.
- CI no GitHub Actions: `typecheck -> lint -> test -> build` mais um job que valida sintaxe e fim de linha dos scripts de `infra/`.
- `infra/` com `lib.sh`, `setup-dev.sh`, `cloud-tasks-queues.sh`, `storage-buckets.sh` e `README.md` — idempotentes, **executados**.
- **D-036**: uma fila do Cloud Tasks **por conta** do Mercado Livre. O limite de taxa do Cloud Tasks é por fila, não por conta, e a D-014 dependia disso.

- Supabase local inicializado: `supabase/config.toml` com Postgres 17, mesma major do projeto Dev (confirmado em 2026-08-19). `realtime`, `studio`, `storage` e `local_smtp` **desligados**, com o motivo de cada um escrito no topo do arquivo — a stack completa não cabe em 3 GB.
- CLI da Supabase 2.115.0 como devDependency do repositório, não global: a versão fica versionada junto com o schema.
- `packages/db` com o cliente privilegiado (`service_role`), validação de configuração e teste garantindo que a chave **nunca** aparece em mensagem de erro.
- **Vercel no ar**: projeto `speedbikers-gestao-v2-m71j`, Root Directory `apps/web`, com "Include source files outside of the Root Directory" habilitado — sem isso a Vercel não enxerga `pnpm-lock.yaml` e cai para `npm`, que não entende `workspace:*`. Deploy `READY` em https://speedbikers-gestao-v2-m71j.vercel.app
- Região das funções fixada em `gru1` por `apps/web/vercel.json`: o Supabase está em `sa-east-1` e o padrão da Vercel era `iad1`, ou seja, um salto EUA-Brasil em toda leitura.

**Supabase V3 Dev inspecionado diretamente:** ref `nmgccyqquwxecqffsidr`, `sa-east-1`, Postgres 17.6.1.155, `ACTIVE_HEALTHY`, **zero tabelas no schema public** — a documentação estava correta.

- **`api` e `worker` no ar no Cloud Run**, São Paulo. Imagem única parametrizada, construída pelo Cloud Build e marcada com o sha curto do commit — dá para responder "qual código está no ar" sem adivinhar.
  - `api`: pública (o webhook do Mercado Livre não envia credencial do Google), `min-instances=1`, rotas `/internal/` verificadas por OIDC na aplicação.
  - `worker`: **privado**, verificado — 403 sem credencial, 200 com token de identidade. Só `v3-tasks-invoker` invoca.
- **A corrente `Cloud Scheduler -> api -> Cloud Tasks -> worker` está fechada e comprovada em produção.** Job `v3-heartbeat` de hora em hora.
- **Deduplicação comprovada:** quatro disparos na mesma janela produziram um enfileiramento e três colapsos. É o mecanismo da chave suja (`docs/ARCHITECTURE.md` secao 10).

**Armadilha do ambiente, já resolvida nos scripts:** no Windows, usar o wrapper **POSIX** `gcloud`, nunca o `.cmd`. O `cmd.exe` trata `>`, `<`, `|`, `&` e espaço-com-asterisco como sintaxe mesmo entre aspas — destrói o cron `"0 * * * *"` e falha com uma mensagem sobre `'C:\Program'` que não aponta para a causa.

- **Supabase local no ar**, enxugado para 4 containers (db, auth, rest, kong). Desligados também `analytics` — sozinho consumia 564 MB de 2,8 GB — e `edge_runtime`. O container `vector`, em crash loop, dependia do analytics e saiu junto.
- **Primeira migration aplicada**: `job_runs` (L2, append-only imposto por trigger, RLS habilitada sem policies, GRANT mínimo para `service_role`). Validada localmente antes de ir ao Dev.
- **CI aplica migrations** (`--yes` é obrigatório: os comandos da CLI da Supabase pedem confirmação e travam em runner sem terminal).
- **Marco da Fase 1 atingido e verificado em produção**: `Cloud Scheduler -> api -> Cloud Tasks -> worker -> Postgres`, com a linha `system.ping / done / processed 1` no Supabase Dev.

**Falta para fechar a Fase 1:** apenas `apps/web` com login Supabase — e isso depende de `organizations`/`profiles`, que são Fase 2. Na prática a Fase 1 está concluída e essa linha migra para a Fase 2.

**Pendências conhecidas, não bloqueantes:**

- A chave `service_role` guardada no Secret Manager é a que apareceu em texto no chat; a rotação foi recomendada e ainda não foi feita. Banco vazio hoje; a partir da Fase 2 o risco é real.
- Os segredos da V2 (`MERCADO_LIVRE_*_CLIENT_SECRET`, `SYNC_WORKER_SECRET`, `ANTHROPIC_API_KEY`) continuam no projeto Vercel da V3, sem nenhum consumidor.
- O projeto Vercel antigo (`speedbikers-gestao-v2`) também observa este repositório e falha em todo push na `v3`, gerando um X vermelho falso no GitHub.

`packages/domain`, `mercado-livre` e `ui` não entram na Fase 1: só ganham conteúdo quando houver domínio, e criar package vazio contraria a regra de só promover a package o que dois apps importam.

## Próximo passo

**Concluir a Fase 1 — fundação técnica.** Monorepo pnpm e Turborepo, TypeScript estrito, lint, Vitest, CI, Supabase local, `apps/api` e `apps/worker` publicados no Cloud Run, projeto Vercel conectado à `v3`.

A Fase 1 **não cria nenhuma tabela de domínio**. O objetivo é um pipeline verde ponta a ponta: um job atravessa `api -> Cloud Tasks -> worker -> Postgres` e o `web` mostra o resultado, sem nenhuma regra de negócio envolvida.

Frente paralela, independente da Fase 1: confirmar a documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md`. Ela bloqueia a Fase 3, então quanto antes melhor.

## Bloqueios atuais

- **Nenhum bloqueio para a Fase 1.**
- Confirmação da documentação oficial do Mercado Livre bloqueia a Fase 3.
- Modelos de exportação do pedido de compra (Excel e PDF) precisam ser solicitados ao usuário antes da Fase 4.
