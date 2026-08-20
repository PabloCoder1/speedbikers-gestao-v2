# Decisões — Speed Bikers Gestão V3

Este arquivo registra decisões já aprovadas para evitar que agentes futuros reabram escolhas sem motivo.

## D-001 — Mesmo repositório, branch V3 limpa

**Decisão:** manter `PabloCoder1/speedbikers-gestao-v2` como repositório único. A `main` preserva a V2 e a `v3` é reconstruída de forma limpa.

**Motivo:** preservar histórico e permitir consulta à V2 sem carregar código/migrations antigas para a nova implementação.

## D-002 — Repositório é a memória oficial

**Decisão:** código + migrations + documentação versionada são a fonte de verdade. Conversas e memória de IA não substituem o repositório.

## D-003 — Infraestrutura principal

**Decisão:**

- Frontend: Next.js na Vercel.
- Banco/Auth/RLS: Supabase V3 Dev em São Paulo (`sa-east-1`).
- Backend pesado/workers/webhooks/jobs: Google Cloud em São Paulo (`southamerica-east1`).
- Código: GitHub.

## D-004 — SKU como entidade central

**Decisão:** SKU canônico é entidade principal de produto. MLB é anúncio/canal e pode mapear para SKU, inclusive por `variation_id`.

## D-005 — Dados antes de IA

**Decisão:** IA interpreta evidências; SQL, regras e cálculos determinísticos fornecem fatos e métricas sempre que possível.

## D-006 — Estoque auditável

**Decisão:** estoque deve ser baseado em movimentos/ledger auditáveis e idempotentes. Vendas, cancelamentos, devoluções e documentos não podem ser aplicados duas vezes.

## D-007 — UX com progressive disclosure

**Decisão:** evitar telas infinitas e excesso de informação. Preferir abas, drill-down, drawers, tooltips, filtros e hierarquia visual.

Paleta inicial:

- `#FFFFFF`
- `#0F1158`
- `#373993`
- `#E83736`
- `#CCC5D5`
- `#655D89`
- `#F8E523`

## D-008 — Eventos e notificações

**Decisão:** alterações relevantes em anúncios e operação devem ser persistidas como eventos. Notificações em tempo real respeitam permissões, severidade e agrupamento para evitar avalanche de popups.

## D-009 — Copiloto contextual

**Decisão:** o assistente integrado deve usar contexto da tela e dados autorizados para responder sobre produto, conta, estoque, compras e desempenho. Também poderá estruturar sugestões de features enviadas pelos usuários.

## D-010 — Evitar infraestrutura prematura

**Decisão:** não adicionar Redis, Kafka, Kubernetes, Elasticsearch ou microserviços adicionais sem gargalo medido ou requisito comprovado.

---

# Decisões de arquitetura — aprovadas em 2026-08-19

As decisões D-011 a D-026 foram aprovadas na sessão de arquitetura da Fase 0 e estão detalhadas em `docs/ARCHITECTURE.md`. Várias delas corrigem problemas **medidos** na V2; a evidência está citada quando existe.

## D-011 — Monorepo pnpm + Turborepo

**Decisão:** monorepo único com pnpm workspaces e Turborepo. Três apps (`web`, `api`, `worker`), sete packages, `supabase/` na raiz.

**Motivo:** pnpm resolve duplicação de dependência entre um Next.js e dois serviços Node; Turborepo evita rodar typecheck do repositório inteiro a cada mudança, com configuração mínima. `supabase/` fica na raiz por convenção da CLI.

**Alternativas:** npm workspaces sem Turborepo (sem cache, CI cresce rápido); Nx (mais poderoso, curva e configuração maiores); repositórios separados (tipos compartilhados virariam pacote publicado).

**Regra de contenção:** um diretório só vira package quando **dois** apps o importam.

**Supersessão:** o `docs/PROMPT_MASTER.md` §6 apresenta uma lista conceitual de packages (`database`, `analytics`, `diagnostics`, `shared`, `types`, `validation`) declarando-a explicitamente "a ser confirmada antes da implementação". Esta decisão é essa confirmação. A lista definitiva está em `docs/ARCHITECTURE.md` §7 e o mapeamento é: `database` -> `@sb/db`; `analytics` e `diagnostics` -> subpaths de `@sb/domain`; `types` e `validation` -> `@sb/contracts`; `shared` -> dividido entre `@sb/observability` e `@sb/config`; `mercado-livre` mantido. Em caso de conflito, prevalece `docs/ARCHITECTURE.md`.

## D-012 — Modelo A: `web` lê o Supabase diretamente sob RLS

**Decisão:** `apps/web` lê o Supabase diretamente sob RLS e executa Server Actions para escritas simples no escopo do usuário. Tudo que exige segredo, sistema externo ou trabalho longo passa por `apps/api`.

**Motivo:** evita um salto de rede em toda leitura, evita duplicar autorização em dois lugares e mantém o RLS como rede de segurança real.

**Alternativa considerada:** Modelo B (BFF — todo dado via `api`). Vantagem: uma única porta de autorização e API pública de graça. Desvantagem: latência extra em toda leitura, autorização duplicada, RLS vira decoração.

**Impacto aceito:** a qualidade das policies de RLS passa a ser a segurança do sistema. Teste negativo de RLS torna-se obrigatório (ver `docs/TESTING.md`).

## D-013 — `api` e `worker` como dois serviços Cloud Run

**Decisão:** dois serviços separados a partir do mesmo monorepo. `api` com `min-instances=1`, timeout curto, concorrência alta. `worker` sem rota pública, timeout longo, concorrência baixa, escala a zero.

**Motivo:** os perfis de execução são opostos. Serviço único obrigaria a escolher a pior configuração para ambos e faria backfill pesado competir com o ACK do webhook.

**Alternativa:** serviço único com duas rotas (um build, um log) — rejeitada pelo acima. Meio-termo disponível se o custo de build incomodar: uma imagem publicada em dois serviços com configurações diferentes.

**Regra:** um worker com roteamento por tipo de job, **não** um worker por domínio. A separação que importa é de fila.

## D-014 — Cloud Tasks é a fila; o Postgres registra o executado

**Decisão:** Cloud Tasks como fila de jobs (4 filas: `ml-sync`, `analytics-recompute`, `backfill`, `maintenance`). O Postgres grava `job_runs` como log auditável, **não** como fila. `pg_cron` permanece apenas para manutenção do banco.

**Motivo, medido na V2:** seis RPCs de claim readquiriam lease sem incrementar contador — job preso em `running` para sempre, nunca virando falha, nunca alertando, consumindo uma Function por minuto. Somavam-se cinco despachantes `pg_cron` por minuto varrendo filas quase sempre vazias. Cloud Tasks elimina lease, claim, contador de retry, despachante e dead-letter artesanal, e entrega dedupe por nome de task, limite de taxa e concorrência por fila, e retry com backoff independente de o processo sobreviver.

**Alternativas:** Supabase Queues/pgmq (fila consultável por SQL, mas exige puxador, ou seja, polling de volta, e não tem controle de taxa por conta); tabela + `pg_cron` como na V2 (é o desenho que falhou); Pub/Sub (sem dedupe por chave nem controle de taxa).

**Desvantagem aceita:** a fila deixa de ser consultável por SQL. Mitigada por `job_runs`.

## D-015 — Payload bruto no Cloud Storage, nunca em coluna do Postgres

**Decisão:** payload cru do Mercado Livre vai para o Cloud Storage (`raw/ml/{recurso}/{yyyy-mm}/{id}.json`), com lifecycle. Nenhuma coluna `raw_payload` em tabela operacional.

**Motivo, medido na V2:** `raw_payload` era coluna obrigatória dentro de `orders` e `order_items`, as duas maiores tabelas do banco, com 328.211 linhas cada. A auditoria classificou como problema de storage, I/O e vacuum, e não conseguiu resolver porque virou questão de retenção em aberto.

**Vantagem:** tabelas operacionais magras, vacuum barato, e a retenção vira regra declarativa do bucket em vez de migration destrutiva.

**Desvantagem:** investigar payload antigo exige buscar no Storage em vez de um `select`.

**Prazo de retenção:** definido em **D-030** — 90 dias em classe quente, depois classe fria.

## D-016 — Um `domain_events` com `before`/`after`; sem tabelas de snapshot

**Decisão:** uma tabela `domain_events` append-only carregando `before` e `after` no payload, com `dedup_key` UNIQUE. Sem tabelas de snapshot separadas.

**Motivo:** o estado atual já vive em L1; o que falta é o que mudou e quando. Snapshot completo a cada varredura duplica L1 e cresce sem limite. A V2 mantinha três tabelas de snapshot.

**Desvantagem:** consulta pontual ("qual era o preço no dia X") exige replay dos eventos daquele anúncio. Barato no volume real; se virar consulta quente, uma série diária em L3 resolve — só depois de medido.

**Escopo:** isto **não é event sourcing**. L1 continua sendo a verdade e é atualizado diretamente.

## D-017 — Um fato diário por anúncio + dois rollups derivados

**Decisão:** `daily_listing_metrics` como fato no grão `(ml_account_id, mlb_id, variation_id, metric_date)`, com `daily_sku_metrics` e `daily_account_metrics` como rollups. Os três saem do **mesmo código**, com teste de equivalência na CI.

**Motivo:** o fato sozinho não atende dashboard de conta em 90 dias (~720 mil linhas por consulta). Rollups derivados do mesmo código evitam que as camadas divirjam.

**Recálculo:** incremental por chave suja, com task nomeada `recompute:{conta}:{sku}:{data}` e dedupe da fila. Rebuild completo disponível e testado.

## D-018 — Full é espelho do Mercado Livre, não ledger

**Decisão:** o estoque Full é armazenado como snapshots reportados pelo ML (`fulfillment_stock_snapshots`), com histórico. Não existe ledger de Full.

**Motivo:** um ledger só é confiável se observamos **todos** os movimentos. Recebimento no CD, avaria, inventário e transferência interna do ML não são visíveis para nós. Ledger de Full garante divergência permanente contra a fonte.

**Consequência:** eventos de Full (entrou, saiu, rompeu, repôs) saem do **diff entre snapshots**. Local, Full por conta, reservado e em trânsito são quatro estados com quatro autoridades diferentes, e a interface nunca os soma cegamente.

## D-019 — Ledger é o único escritor do estoque local

**Decisão:** `stock_movements` é a única fonte de verdade do estoque local, com `idempotency_key` UNIQUE. `inventory_balances` é projeção recomputável, com job de conferência que compara projeção contra a soma do ledger e emite evento crítico na divergência.

**Motivo:** atende D-006 (estoque auditável) de forma verificável, e a constraint UNIQUE torna a dupla movimentação **fisicamente impossível**, não apenas improvável.

**Decisão associada:** a venda vira linha no ledger **no momento em que o pedido é persistido**, não calculada na leitura. *Motivo, medido na V2:* a dedução calculada na leitura consumiu seis migrations em dois dias brigando com timeout.

## D-020 — SKU resolvido e gravado na persistência do pedido

**Decisão:** ao persistir um pedido, o worker resolve o `sku_id` pelo vínculo vigente e **grava o `sku_id` na linha do item**, junto com qual vínculo foi usado.

**Motivo:** a história fica estável. Revincular um MLB amanhã não reescreve silenciosamente o faturamento do trimestre passado.

**Alternativa rejeitada:** resolver o SKU por join na leitura. Vantagem: correção instantânea sem reprocesso. Desvantagem: todo relatório histórico muda sozinho quando alguém mexe num vínculo, e a variação fica inexplicável — inaceitável num sistema de gestão.

**Consequência:** corrigir um vínculo errado exige reprocessamento explícito dos pedidos afetados.

## D-021 — Copiloto por tool calling determinístico

**Decisão:** o Copiloto orquestra ferramentas determinísticas tipadas e registradas. Nenhuma SQL é gerada por LLM. Permissões são aplicadas na camada de ferramenta, não no prompt. Toda chamada é registrada em `ai_runs` com custo, latência, ferramentas e escopo. Quando a ferramenta responde por completo, a UI renderiza o resultado e o LLM não é chamado.

**Motivo:** cumpre a regra de custo e confiança do `docs/PROMPT_MASTER.md` §30 e elimina injeção de SQL, vazamento entre contas e consulta acidental de tabela inteira.

**Escopo excluído:** sem RAG, sem embeddings, sem pgvector, sem memória de conversa persistida além da sessão, e **sem ferramenta de escrita** — o Copiloto lê e explica, não altera preço nem cria pedido.

## D-022 — Infraestrutura por scripts `gcloud` versionados; Terraform na Fase 8

**Decisão:** `infra/` contém scripts `gcloud` versionados e comentados. Terraform entra apenas na Fase 8, quando existir ambiente de produção.

**Motivo:** Terraform brilha com múltiplos ambientes e múltiplas pessoas. Com um ambiente e um operador, é uma linguagem a mais, um state a gerenciar e um modo novo de quebrar deploy, antes de existir uma linha de domínio.

**Desvantagem:** script não detecta drift. Se alguém alterar pelo console, o script não avisa.

**Porta de saída:** os recursos são poucos e conhecidos; migrar para Terraform na Fase 8 é trabalho de um dia.

## D-023 — Catálogo de métricas normativo

**Decisão:** `docs/METRICS.md` é normativo e há uma tabela `metric_definitions` no banco. **Todo número exibido na interface carrega o ID da sua definição**, e o tooltip mostra fórmula, fonte, granularidade, timezone e tratamento de cancelamento.

**Motivo:** garante por construção, e não por disciplina, que a mesma métrica significa a mesma coisa nas quatro telas.

## D-024 — OIDC serviço-a-serviço

**Decisão:** chamadas de Cloud Scheduler e Cloud Tasks para `api`/`worker` são autenticadas por OIDC de service account. Sem segredo compartilhado.

**Motivo:** a V2 usava `SYNC_WORKER_SECRET`; rotacionar exigia coordenar deploy em dois lugares. OIDC no Cloud Run é configuração, não código.

**Regra associada:** o webhook do Mercado Livre é superfície pública com autenticação própria e caminho explicitamente liberado, com **teste negativo nas rotas vizinhas**. *Motivo:* na V2 o proxy exigia sessão, o webhook não envia cookie, e as notificações morriam em silêncio num 307 para `/login`.

## D-025 — Três ambientes: local, development, production

**Decisão:** `local` (Supabase CLI em Docker), `development` (Supabase V3 Dev + Cloud Run dev + Vercel Preview) e `production` (criado na Fase 8). Preview da Vercel aponta para o Supabase Dev. Sem staging separado.

**Motivo:** staging só se justifica quando houver produção com usuário real dependendo de estabilidade.

**Desvantagem:** migration destrutiva num PR afeta quem estiver testando no Dev. Mitigada pela exigência de justificativa e plano de rollback já prevista no `docs/PROMPT_MASTER.md` §11.

**Regra associada:** validação de variáveis de ambiente com Zod no boot dos três apps. A V2 perdeu `APP_ENCRYPTION_KEY` do `.env.example` e só descobriria em runtime.

## D-026 — Vitest com descoberta automática e quatro regras de teste

**Decisão:** Vitest como runner, com descoberta automática de arquivos. Playwright a partir da Fase 5.

**Motivo:** a V2 usava `node --test` e acumulou 48 caminhos de teste listados à mão em uma única linha do `package.json` — não escala e garante esquecimento.

**Quatro regras não negociáveis, cada uma extraída de bug real da V2:**

1. toda garantia de idempotência tem teste "rode duas vezes, espere um efeito";
2. todo policy de RLS tem teste negativo;
3. toda fórmula duplicada em SQL tem teste de equivalência com a versão de `@sb/domain`;
4. toda rota pública nova tem teste negativo nas rotas vizinhas.

---

# Decisões de produto e escopo — respondidas em 2026-08-19

As decisões abaixo respondem os itens **A** a **H** que estavam pendentes ao fim da sessão de arquitetura. Nenhuma segue aberta.

## D-027 — Carga inicial: backfill do ML mais ETL do insubstituível

**Decisão:** pedidos e anúncios são rebaixados novamente do Mercado Livre. Vêm da V2 por ETL versionado apenas o que não existe em nenhuma outra fonte: **vínculos SKU-MLB, ledger e saldos de estoque, NF-e aplicadas e pedidos de compra**.

**Motivo:** os 328 mil pedidos são reconstituíveis a partir da API; o trabalho humano de vinculação e o histórico de estoque, documentos e compras não são. Migrar tudo importaria também o modelo antigo e o risco de trazer dado inconsistente.

**Impacto:** existirão tabelas e scripts de migração temporários, isolados em `supabase/migrations` e `infra/`, com a origem V2 registrada em cada linha migrada para permitir auditoria e reversão.

**Alternativas:** migração completa por ETL (traz o modelo antigo junto); V3 completamente limpa (perde o trabalho manual); V2 e V3 convivendo (dobra a operação e cria ambiguidade sobre qual é a verdade).

## D-028 — UpSeller permanece como ERP; a V3 reconstrói o importador

**Decisão:** o UpSeller continua sendo o ERP das contas do Mercado Livre. A V3 reconstrói o importador de planilhas, e o estoque das duas pontas é mantido alinhado. Movimentos manuais de entrada e saída são lançados **nos dois sistemas**.

**Motivo:** decisão do negócio. O objetivo declarado é que a V3 seja hoje análise e operação e possa, no futuro, assumir também o papel de ERP.

**Consequência arquitetural — a mais importante desta rodada:** o desenho precisa suportar o dia em que a V3 vira o sistema de registro, sem reescrita. Portanto:

- o **ledger da V3 é completo e autossuficiente** desde o início; ele não é um espelho do UpSeller, é um registro próprio de movimentos;
- o UpSeller entra como **fonte de alinhamento por snapshot**, em tabelas próprias, e nunca escreve direto em `inventory_balances`;
- quando a V3 assumir como ERP, o que sai é a importação e a conciliação, não o modelo de estoque.

**Impacto:** o domínio `catalog` cresce. Entram tabelas de importação (batches, linhas, promoção em chunks), catálogo e kits importados, snapshots de estoque do ERP, aliases de loja e candidatos de vínculo. Referência funcional na V2: 13 tabelas `upseller_*`, mais um bucket privado de Storage e dois workers.

## D-029 — Em divergência de estoque, o UpSeller vence, com ajuste auditável

**Decisão:** quando o saldo do ledger da V3 divergir do snapshot importado do UpSeller, o valor do UpSeller prevalece. A V3 **gera um movimento `AJUSTE_RECONCILIACAO` no próprio ledger** e emite evento crítico.

**Motivo:** o lançamento manual acontece em dois sistemas, e uma hora alguém esquece um lado. Sem regra explícita, o saldo diverge em silêncio e o erro só aparece como ruptura ou venda de item inexistente.

**O que torna essa decisão segura:** o ajuste é uma **linha de ledger**, não uma sobrescrita. O saldo passa a bater e a diferença fica auditável, com origem, data e responsável. Estoque nunca é corrigido por `UPDATE` silencioso.

**Uso operacional:** a frequência e o tamanho dos ajustes viram métrica de saúde. Ajuste grande e recorrente indica processo humano falhando, não erro de software — e é sinal de que a V3 está pronta para assumir como ERP.

**Alternativas:** fila de conferência humana (mais seguro, porém cria trabalho recorrente e mantém o saldo errado até alguém resolver); V3 vence (contradiz o UpSeller ser o sistema de registro hoje).

## D-030 — Retenção do payload bruto: 90 dias quente mais arquivamento frio

**Decisão:** o bucket de L0 mantém 90 dias em classe quente e move o restante para classe fria por lifecycle.

**Motivo:** investigação real acontece sobre dado recente. Pagar storage quente por payload que se lê uma vez por trimestre é desperdício, e descartar impede reprocessar o histórico quando o Mercado Livre mudar um campo.

**Implementação:** regra de lifecycle do bucket, declarativa. Sem rotina de expurgo em código.

## D-031 — `organization_id` em todas as tabelas

**Decisão:** manter `organization_id` em toda tabela de domínio, mesmo havendo hoje uma única empresa.

**Motivo:** é a chave natural de toda policy de RLS e o primeiro campo da maioria dos índices compostos. O custo é de poucos bytes por linha. A assimetria decide: remover depois é trivial, adicionar depois é reescrever as migrations e toda a RLS.

## D-032 — Visitas, conversão e Ads entram na Fase 5B

**Decisão:** essas fontes entram junto com os analytics, na Fase 5B, e não antes.

**Motivo:** são fontes novas do Mercado Livre, com custo próprio de sincronização e de rate limit. Sincronizá-las antes de existir tela que as consuma gasta orçamento de API sem retorno. Conversão só faz sentido com vendas já confiáveis.

**Consequência:** até a Fase 5B, o diagnóstico não distingue queda de tráfego de queda de conversão, e deve declarar isso explicitamente em vez de inferir.

## D-033 — Tela âncora: Dashboard de vendas Geral e por Conta

**Decisão:** a tela que define o sucesso da V3 no dia a dia é o Dashboard de vendas Geral e por Conta. Em função disso, **a Fase 5 é dividida**:

- **Fase 5A — métricas de venda e dashboards Geral/Conta.** Depende apenas de pedidos confiáveis e do catálogo vinculado. **Executada logo após a Fase 3, antes da Fase 4.**
- **Fase 5B — cobertura, ruptura, Curva ABC, Full, visitas, conversão e Ads.** Depende do estoque, portanto vem depois da Fase 4.

**Motivo:** o dashboard de vendas não depende do ledger de estoque. Manter todo o analytics depois da Fase 4 atrasaria a tela que faz o usuário trocar de sistema, sem nenhum ganho de confiabilidade.

**Compatibilidade com o `docs/PROMPT_MASTER.md` §37:** a ordem `confiabilidade dos dados -> métricas corretas -> analytics` é preservada. A Fase 3 entrega pedidos confiáveis; a 5A apenas não espera pelo estoque, que ela não usa. Nenhuma métrica de estoque aparece antes da Fase 4. Isto é refinamento documentado das fases, não alteração silenciosa.

## D-034 — Exportação de pedido de compra: Excel é o formato principal

**Decisão:** o formato principal de exportação do pedido de compra é **XLSX**. PDF é secundário. **XML fica adiado** até existir um layout real a atender.

**Motivo:** é o formato que a operação efetivamente usa com fornecedores. Inventar um XML que nenhum fornecedor consome seria trabalho sem consumidor.

**Pendência operacional:** os modelos de referência (Excel e PDF) serão fornecidos pelo usuário mediante solicitação, **antes do início da Fase 4**.

---

# Decisões de infraestrutura

## D-036 — Uma fila do Cloud Tasks por conta do Mercado Livre

**Decisão:** cada conta do Mercado Livre tem a própria fila, `ml-sync-<conta>`. Não existe uma fila `ml-sync` compartilhada.

**Motivo:** o limite de taxa e de concorrência do Cloud Tasks é **por fila**, não por conta. A D-014 escolheu Cloud Tasks tendo o respeito ao rate limit por conta como uma das justificativas; realizar isso exige uma fila por conta. Uma fila compartilhada faria o backfill de uma conta consumir o orçamento de requisições das outras — e a V2 registrou 17 respostas HTTP 429 em 24 h entre 4 contas **sem backfill em execução**.

**Precisão sobre a D-014:** a D-014 descrevia a fila base como `ml-sync`. Esta decisão substitui esse nome. As demais filas (`analytics-recompute`, `backfill`, `maintenance`) continuam únicas, porque não falam com API externa limitada por conta.

**Impacto operacional:** conectar uma conta passa a incluir criar a fila dela. Executado por `bash infra/cloud-tasks-queues.sh <slug>`, e mais tarde pelo próprio fluxo de conexão de conta.

**Custo:** fila vazia não custa nada. O custo do Cloud Tasks vem do despacho, não da existência.

**Valores provisórios:** os limites de taxa das filas `ml-sync-*` estão provisórios até a confirmação da política de rate limit vigente do Mercado Livre — ver `docs/MERCADO_LIVRE.md` secao 1.

---

# Decisões do catálogo — respondidas em 2026-08-20

Levantadas pela análise da exportação real do UpSeller (`docs/UPSELLER.md`).

## D-037 — Vínculo de anúncio restrito ao Mercado Livre

**Decisão:** `sku_listing_links` é específica do Mercado Livre. A importação **descarta** as 3.274 linhas de Shopee, Kwai, Temu e TikTok.

**Motivo:** o Mercado Livre concentra 86% dos vínculos e é o único canal com sincronização, webhook e dashboards no escopo da V3. Modelar canal genérico traria complexidade sem consumidor.

**Desvantagem assumida, declarada:** se a Shopee virar relevante, a tabela central de vínculos precisará migrar **com dados dentro**. É o custo aceito em troca de um schema mais enxuto agora.

**Sinal para reavaliar:** qualquer canal fora do Mercado Livre passando a exigir métrica, sincronização ou decisão de compra.

## D-038 — O saldo do UpSeller é estoque real

**Decisão:** os saldos importados são tratados como estoque real. Sem marcação de "não gerenciado", sem limiar, sem supressão de métrica.

**Contexto medido:** 404 SKUs acima de 1.000 unidades concentram 68% do total; a mediana é 993 e o p99 é 9.999. Quatro retrovisores distintos marcam ~10.993 unidades cada.

**Consequência:** cobertura em dias, data estimada de ruptura e sugestão de compra usarão esses saldos. Se algum desses SKUs tiver saldo artificial, as três métricas ficam sem significado **nele** — e com aparência de certeza.

**Sinal para reavaliar:** sugestão de compra recomendando zero para item que de fato precisa reposição, ou cobertura em dias absurdamente alta em item de giro.

## D-039 — Marca vem da coluna `Categorias`, normalizada

**Decisão:** a marca é derivada de `Categorias`, com normalização de caixa e espaço (`Plasmoto` e `PLASMOTO` viram o mesmo valor). Fica em coluna de texto, não em tabela própria.

**Motivo:** é onde o dado está de fato, e o campo `Marca` do ERP está 90% vazio. Com 64 valores distintos, uma tabela `brands` só adicionaria join sem ganho — e o cadastro é editável depois.

**`ESTOQUE INATIVO` NÃO é lixo:** marca produto em encerramento, cujo estoque está sendo zerado para deixar de ser trabalhado. Vira uma coluna própria (`is_discontinued`), não uma marca. Descartá-lo perderia informação de negócio.

Categorias puramente numéricas (`999`) são ruído e não viram marca.

---

# Decisões de ferramental

## D-035 — TypeScript 6.0.3, não 7.x

**Decisão:** o monorepo fixa **TypeScript 6.0.3**, embora a versão `latest` no registry seja a 7.0.2.

**Motivo, verificado no registry em 2026-08-19:** `typescript-eslint@8.67.0` declara peer `typescript: ">=4.8.4 <6.1.0"`. O canal `canary` (`8.67.1-alpha.22`) declara exatamente o mesmo intervalo. Fixar a 7.x quebraria o lint com checagem de tipos em todos os packages.

**Impacto:** `pnpm install` avisa que "7.0.2 is available". O aviso é esperado e **não deve ser seguido**.

**Quando revisar:** quando `typescript-eslint` publicar peer que aceite 7.x. Verificar com `npm view typescript-eslint peerDependencies` antes de subir a versão.

**Alternativa rejeitada:** usar TypeScript 7 sem `typescript-eslint`, com apenas as regras nativas do ESLint. Perde-se toda a checagem de lint baseada em tipos, que é justamente a mais valiosa num projeto com regras de negócio em `@sb/domain`.

---

## Como adicionar nova decisão

Registrar:

- ID;
- contexto;
- decisão;
- motivo;
- alternativas consideradas quando relevante;
- impacto;
- data/commit quando útil.

Não reverter decisão existente silenciosamente. Registrar nova decisão que substitui a anterior e explicar o motivo.
