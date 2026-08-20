# Handoff V3

> Última atualização: 2026-08-20 — **Fase 1 concluída**; na Fase 2, o importador do UpSeller está completo ponta a ponta (upload → parse → conferência → confirmação → aplicação), commitado (`6881cbc`), publicado em `origin/v3` e implantado no Cloud Run Dev.

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

## Fase 2 em andamento

**Concluído:**

- **Identidade**: `organizations`, `profiles`, `organization_members` com papéis ADMIN/GESTOR/ANALISTA/OPERADOR/VISUALIZADOR. Aplicada no Dev pela CI.
- **Helpers de RLS** em schema `private` (`current_org_id`, `is_member_of`, `has_role`, `shares_org_with`), todos `stable` + `security definer` + `search_path = ''`. As três marcações são deliberadas — ver o comentário na migration.
- **Perfil criado automaticamente** por trigger em `auth.users`.
- **14 testes de integração de RLS** contra Postgres real, cobrindo isolamento entre organizações, negativa para `anon`, concessão de papel restrita a ADMIN da própria organização, e edição de perfil limitada ao dono.
- **CI sobe um Postgres real** e roda esses testes; o passo de migration no Dev depende deles.
- Linter de segurança do Supabase rodado: um WARN de `search_path` mutável corrigido por migration nova (a original já estava no Dev).

- **Catálogo**: `skus` (PRODUTO e KIT numa tabela só) e `sku_components`, modelados sobre a exportação real do UpSeller. `sku_key` normalizado por coluna gerada, `is_imported` derivado do código fiscal de origem, e triggers garantindo que só KIT tem componente e componente é sempre PRODUTO.
- **Contas Mercado Livre**: `ml_accounts`, `ml_credentials`, `ml_oauth_states` e `user_account_permissions`, mais o helper `has_account_access` (ADMIN alcança todas as contas da sua organização).
- **38 testes de integração** cobrindo identidade, catálogo, composição de kit e contas ML.
- `docs/UPSELLER.md` documenta a estrutura real das quatro exportações e a qualidade medida de cada campo.

**Armadilhas já pagas, não repetir:**

- `SET LOCAL` fora de transação é descartado em silêncio. Um teste de RLS escrito assim mede nada e passa — a primeira verificação manual reportou "todos veem tudo" por isso.
- Helper de RLS que lê a própria tabela protegida **precisa** de `security definer`, senão a policy chama o helper que consulta a tabela que aplica a policy: recursão infinita.
- `stable` em helper de RLS é decisão de performance: sem ela, a função é avaliada **por linha** em vez de por statement.
- **`middleware.ts` foi renomeado para `proxy.ts` no Next.js 16**, com o export chamado `proxy`. O arquivo antigo não roda e **não avisa** — toda rota ficaria desprotegida em silêncio. Confirmado na documentação empacotada em `node_modules/next/dist/docs`, como manda o `AGENTS.md`.
- Heredoc de shell comeu uma barra invertida no matcher do `proxy`: o escape duplo virou escape simples, e o que era "ponto literal" na expressão regular passou a significar "qualquer caractere". O lint pegou. Regra: arquivo com escape vai pela ferramenta de escrita, nunca por heredoc.
- `useSearchParams` sem limite de `<Suspense>` **quebra o build** do Next, não a execução. Só apareceu no `next build`, depois de `typecheck` e `lint` passarem — build faz parte da verificação.
- TypeScript descarta o estreitamento de uma **propriedade** dentro de callback. `if (batch.data === null) notFound()` não vale dentro do `.map`; copiar para um `const` local resolve.
- **O ramo da `api` no `deploy-cloud-run.sh` não ligava o segredo do Supabase**; só o do worker ligava. A assimetria ficou invisível enquanto a `api` não precisava da chave. O container recusou subir, o Zod nomeou a variável que faltava e o Cloud Run manteve a revisão anterior servindo — é exatamente o que a validação no boot existe para produzir.
- **O heredoc do shell come um nível de barra invertida:** a dupla chega como simples. Em Python, uma barra invertida no fim da linha é continuação de linha — o padrão de busca deixa de existir e o `replace` não casa nada, **sem erro nenhum**. Já custou três vezes (o matcher do `proxy`, e duas vezes esta própria linha). Regra: edição que envolva barra invertida usa a ferramenta de escrita, ou constrói o caractere com `chr(92)` e **verifica com `assert` que o padrão casou**.
- `parseDecimal` removia todo ponto como separador de milhar, transformando `174.90` em `17490` — cem vezes o valor, em silêncio, em todo preço e custo. A vírgula é quem decide: com vírgula presente ela é o decimal e o ponto é milhar; sem vírgula, o ponto É o decimal. Pego por teste antes de qualquer importação.
- `String(value)` sobre célula de planilha transforma objeto em `[object Object]` — texto que parece dado válido e não é. `cell()` trata string, número, booleano e `Date` explicitamente e devolve `null` para o resto.
- O `slug` de `ml_accounts` nomeia a fila `ml-sync-<slug>` do Cloud Tasks (D-036). A constraint restringe o charset ao que o Cloud Tasks aceita — descobrir isso na hora de provisionar sairia caro.
- Falha de `supabase db push` com apenas "Connecting to remote database..." e exit 1 foi **transitória**. O passo já roda com `--debug 2>&1` para que a próxima traga a mensagem real.
- **Espelho do bug do segredo do Supabase, agora no `worker`:** `deploy-cloud-run.sh` setava `ERP_IMPORTS_BUCKET` só no ramo da `api`, nunca no do `worker` — mas é o `worker` quem lê essa variável (`apps/worker/src/env.ts`, exigida desde o handler de parse). O deploy do worker falhava com "container failed to start… PORT=8080… allocated timeout" — mensagem do Cloud Run que **não menciona a variável**; a causa real só apareceu no Cloud Logging (`invalid_environment`, `ERP_IMPORTS_BUCKET: expected string, received undefined`). Consequência séria: **a revisão que estava servindo era anterior a essa exigência** — o handler `erp.import.parse` nunca tinha rodado de fato em Dev, silenciosamente. Corrigido no script; verificar sempre os dois ramos (`api`/`worker`) juntos quando uma env var nova entra em qualquer um dos dois.
- **`ON CONFLICT` não enxerga índice único parcial sem repetir o `WHERE` do índice** — e o PostgREST/`supabase-js` não expõe esse `WHERE` no `upsert()`. `sku_listing_links` tem três índices únicos parciais (a pegadinha do `variation_id` nulo, `docs/DATABASE.md` secao 4); um `upsert` comum contra eles falharia com "no unique or exclusion constraint matching". O comando de aplicação resolve por fora: `select` pela chave natural primeiro, depois `insert` (novo) ou `update` por `id` (existente) — nunca `upsert` direto nessa tabela. Verificado contra Postgres local: reaplicar o mesmo lote de vínculos duas vezes não duplica.

## Próximo passo

**Fase 2 — Core de dados.** Identidade, contas e catálogo, com RLS desde a primeira tabela.

**Concluído nesta sessão:** o comando de aplicação (upload → parse → conferência → confirmação → **aplicação**, ponta a ponta). O único item que falta para fechar a frente do importador é:

1. **ETL de carga inicial da V2** (D-027) — vínculos, estoque, NF-e e compras que não existem em nenhuma outra fonte.

**Ainda não commitado nesta máquina:** migration `20260820220000_erp_import_apply.sql`, os tipos regenerados de `packages/db/src/types.ts`, o comando de aplicação (`packages/domain/src/upseller/apply.ts` + `apps/worker/src/handlers/erp-import-apply.ts`), a rota `POST /v1/erp-imports/:id/apply` e o botão de confirmação no `web`. Migration já aplicada e testada localmente (integração de RLS verde, 60 testes) e via script pontual contra Postgres real — falta o commit e o push para a CI aplicar em Dev.

**Já no ar em Dev, `api` e `worker` verificados após o deploy:** rota `/v1/erp-imports/:id/apply` responde 401 sem token e 404 nas rotas vizinhas; `worker` reiniciado com `ERP_IMPORTS_BUCKET` correto e log `worker_started` confirmado no Cloud Logging — ver a armadilha registrada acima.

**Falta configurar (manual, precisa do painel):**

- `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` na Vercel.
- `NEXT_PUBLIC_API_URL` na Vercel, apontando para a `api` no Cloud Run.
- ~~`WEB_ORIGINS` na `api`~~ — **feito**, publicado pelo `infra/deploy-cloud-run.sh`.
- **Primeiro usuário**: criar no painel do Supabase e rodar `grant-role.ts`. Ver `docs/DEPLOYMENT.md` secao 10.

Ordem dentro da fase, do que não depende de nada para o que depende:

1. **Identidade** — `organizations`, `profiles`, `organization_members`, mais os helpers de RLS em schema `private`. Não depende de nada externo.
2. ~~**Contas Mercado Livre**~~ — **concluído**. Credenciais e states de OAuth ficam sem GRANT nenhum: inalcançáveis pela Data API em qualquer cenário.
3. ~~**Catálogo**~~ — **concluído**. `skus` e `sku_components` aplicados. Fornecedores adiados: a exportação não traz nenhum dado de fornecedor (as colunas `Vendedor` e `Link do Fornecedor` vêm vazias), e a fonte real será a NF-e na Fase 4.
4. **Vinculações** — `sku_listing_links` **concluído**, com os três índices parciais que resolvem a armadilha do `NULL` em `UNIQUE`. `listings` e `listing_variations` foram **adiados para a Fase 3**: não há fonte para eles até a sincronização existir, e o formato depende do que a API do ML devolve — criar agora seria adivinhar campo.
5. **Importador do UpSeller** e **ETL de carga inicial da V2** (D-027) — **em andamento**.
   - ✅ `packages/domain` criado com os parsers puros do UpSeller: normalização de unidade, marca a partir de `Categorias`, código fiscal de origem, decimal com vírgula ou ponto, e a classificação `MLB` / `MLBU` / variação repetida.
   - ✅ Mapeadores de linha para os quatro arquivos, **por nome de coluna, nunca por posição**: se o UpSeller inserir uma coluna, o mapeamento posicional deslocaria tudo em silêncio.
   - ✅ **Validado contra os arquivos reais**, não só contra fixture: 3.415 produtos, 272 componentes, 23.924 vínculos e 3.372 saldos processados com **zero linhas inválidas**. Todos os números conferem com a análise independente feita em Python.
   - ✅ **Fluxo completo escolhido** (upload → parse → conferência → confirmação → aplicação), não comando pontual.
   - ✅ Tabelas de staging: `erp_import_batches` (um lote por arquivo, com `content_hash` UNIQUE impedindo reaplicar o mesmo arquivo), `erp_import_rows` (linha normalizada, distinguindo `SKIPPED` de `INVALID`) e `erp_stock_snapshots` (fonte de alinhamento da D-029).
   - ✅ **Rota de upload** na `api`, com autenticação de usuário (papel vem do banco, nunca do token) e checagem de duplicata antes de tocar o bucket.
   - ✅ **Handler de parse** no worker: baixa do bucket, roda os mapeadores, grava em `erp_import_rows` e marca o lote como `PARSED`. **Não altera catálogo, estoque nem vínculo** — a separação é o que torna a conferência possível.
   - ✅ **Login no `web`**: `@supabase/ssr` com cliente de servidor e de navegador, proteção de rota, e papel lido do banco a cada renderização — nunca do token, que pode estar desatualizado depois de um rebaixamento.
   - ✅ **Tela de conferência**: lista de lotes e detalhe linha a linha, com filtro por `OK` / `Ignorada` / `Inválida`, paginação de 100 e resumo legível do que o parser entendeu de cada linha.
   - ✅ **Bootstrap do primeiro acesso**: migration com a organização Speed Bikers (UUID fixo) e `packages/db/src/bin/grant-role.ts` para conceder o primeiro papel. Ver `docs/DEPLOYMENT.md` secao 10.
   - ✅ **Tela de upload**: escolhe o tipo, envia direto do navegador para a `api` (CORS restrito a `/v1/*`, allowlist explícita), e leva para a conferência — inclusive quando o arquivo já tinha sido enviado antes, que é o caso mais útil de abrir.
   - ✅ **Atualização automática** enquanto o lote está sendo lido: o parse é assíncrono, e uma tela "Lendo o arquivo" parada faz qualquer um achar que travou.
   - ✅ **Comando de aplicação** — primeiro código que escreve em domínio. Rota `POST /v1/erp-imports/:id/apply` (`ADMIN`/`GESTOR`) confirma a conferência: move o lote `PARSED` para `APPLYING`, grava `applied_by` e enfileira `erp.import.apply` (fila `maintenance`). O handler do worker processa só as linhas `OK`, por `kind`:
     - **PRODUCTS**: upsert em `skus` por `(organization_id, sku_key)`. Se a chave já existe com outro `kind` (um PRODUTO virando KIT ou vice-versa), a linha falha em vez de trocar a natureza do SKU em silêncio.
     - **KITS**: cria o SKU-contêiner do kit (`kind = 'KIT'`) uma vez por chave, resolve o componente por `sku_key` e grava `sku_components`. Componente ainda não importado vira `UNRESOLVED`, não erro.
     - **STOCK**: upsert em `erp_stock_snapshots` por `(batch_id, sku_key, warehouse)`, com `sku_id` nulo quando o SKU ainda não existe — o saldo é registrado do mesmo jeito (D-038).
     - **LINKS**: cria a conta ML em `PENDING`/`created_by_import=true` quando a loja ainda não existe, resolve o SKU e grava `sku_listing_links`. Vínculo com `source = MANUAL` ou `RULE` (decisão humana) **nunca é sobrescrito** por uma reimportação.
     - Cada linha grava `apply_status` (`APPLIED`/`UNRESOLVED`/`FAILED`) e `apply_reason` em `erp_import_rows`; o lote grava `applied_rows`/`unresolved_rows` e vira `APPLIED`.
     - **Idempotência verificada contra Postgres real** (não só teste com fake): rodar o mesmo lote de vínculos duas vezes produz uma linha em `sku_listing_links`, não duas.
     - Tela de conferência ganhou o botão "Confirmar aplicação" (só aparece com o lote `PARSED`) e uma coluna de desfecho por linha depois de aplicado.
   - ⏳ Falta: ETL de carga inicial da V2 (D-027).

**Leitor de planilha escolhido:** `read-excel-file` (2,5 MB) em vez de `exceljs` (21,8 MB), porque o worker só lê. Medido nos arquivos reais: 23.925 linhas em 647 ms com 176 MB de RSS, folgado nos 512 MB do container. Usar `readSheet`, não o export padrão — na v9 o padrão devolve o array de planilhas.

**Números conferidos na validação ponta a ponta:** 20.650 vínculos de ML (13.299 com variação, 3.579 sem, 3.772 user products) e 3.274 descartados por decisão (D-037); 4 contas derivadas — `ml-speedbikers-loja-1`, `ml-speedbikers-loja-2`, `ml-sbmotos`, `ml-gmr`; 138 kits; 184 produtos descontinuados; 296 importados; 64 categorias reduzidas a **19 marcas**.

**Regra desta fase:** toda tabela nasce com RLS habilitada, GRANT mínimo explícito e **teste negativo** provando que quem não tem permissão não lê. Ver `docs/DATABASE.md` secao 5 e `docs/TESTING.md`.

Frente paralela, independente: confirmar a documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md`. Ela bloqueia a Fase 3.

## Bloqueios atuais

- Nenhum bloqueio para o ETL de carga inicial da V2 (D-027), última pendência da Fase 2.
- Confirmação da documentação oficial do Mercado Livre bloqueia a Fase 3.
- Modelos de exportação do pedido de compra (Excel e PDF) precisam ser solicitados antes da Fase 4.
