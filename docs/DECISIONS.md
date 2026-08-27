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

**Recálculo:** incremental por chave suja de conta + dia, coalescida em janela de minuto conforme D-051. Rebuild completo disponível e testado.

**Implementação em 2026-08-21:** os três grãos saem de `private.compute_daily_sales_metrics`, uma única consulta com `GROUPING SETS`. O rollup de SKU mantém `ml_account_id` para preservar a autorização por conta e aceita `sku_id NULL` como bucket válido; `COUNT(DISTINCT pack/order)` é refeito diretamente em cada grão, nunca somado do anúncio.

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

## D-040 — ETL da V2 (D-027): descartado por evidência medida, exceto compras

**Contexto:** a D-027 presumiu, sem consultar o banco real da V2, que vínculos SKU-MLB, ledger de estoque e NF-e eram "trabalho humano irreprodutível" ou "não existe fora do banco da V2". Ao iniciar a Fase 2 do ETL, a inspeção direta do projeto Supabase `speedbikers-gestao-v2` (ref `eeramcpouarfwagxigtz`) mostrou outra realidade:

| Categoria | Suposição da D-027 | Medido na V2 em 2026-08-20 |
|---|---|---|
| Vínculos SKU-MLB | Trabalho humano, irreprodutível | `product_inventory_links`: 3.158 linhas, **100% `source = 'upseller'`, `confidence = 'exact'`** — zero linhas de origem manual. É a própria V2 reaplicando o export do UpSeller, a mesma fonte que o importador da V3 já lê (D-028), com mais cobertura (20.650 vínculos brutos de ML no export atual contra 3.158 aplicados na V2) |
| Ledger de estoque | Não existe fora do banco da V2 | `stock_movements` e `product_inventory_balances`: **0 linhas** cada. A V2 nunca passou a usar o próprio ledger |
| NF-e | Histórico com implicação fiscal | `stock_receipts`/`stock_receipt_items` (schema pronto: `access_key`, `invoice_number`, `protocol_status`): **0 linhas** cada. Funcionalidade nunca usada |
| Pedidos de compra | Não existe fora do banco da V2 | **1 pedido real** (fornecedor Navetec, criado em 2026-08-19), 5 itens, 8 eventos |

**Decisão:** a migração de vínculos, ledger e NF-e da V2 é **descartada** — não há nada de irreprodutível a trazer, e forçar a migração de `product_inventory_links` seria uma **regressão** (menos vínculos que o importador do UpSeller já produz na V3). A migração de pedidos de compra fica **adiada para a Fase 4**, quando `purchase_orders`/`purchase_order_items`/`purchase_order_events` existirem na V3 — o volume (1 pedido) é pequeno o suficiente para não justificar antecipar o schema.

**Motivo:** a D-027 foi escrita como projeção, antes de qualquer consulta ao banco. `docs/PROMPT_MASTER.md` §9 e a prática desta arquitetura de "teste da dor medida" (`docs/ARCHITECTURE.md` secao 1) pedem decisão sobre evidência, não suposição — o mesmo princípio que já corrigiu D-037 a D-039 a partir da leitura real do UpSeller.

**Impacto:** a Fase 2 não tem ETL da V2 para escrever. O item correspondente em `docs/ROADMAP.md` é encerrado por esta decisão, não por código. `docs/DEPLOYMENT.md` secao 8 (rollout da Fase 8) é ajustado para não prometer uma migração de vínculos/estoque/NF-e que não existe.

**Alternativa rejeitada:** migrar `product_inventory_links` mesmo assim, "por segurança". Rejeitada porque não há como distinguir, dentro dele, alguma linha eventualmente ajustada à mão de uma puramente derivada — o campo `source` não registra essa diferença, e todas as 3.158 linhas amostradas têm `confidence = 'exact'` e `source = 'upseller'`. Não existe sinal de curadoria humana a preservar.

---

# Decisões de infraestrutura

## D-036 — Uma fila do Cloud Tasks por conta do Mercado Livre

**Decisão:** cada conta do Mercado Livre tem a própria fila, `ml-sync-<conta>`. Não existe uma fila `ml-sync` compartilhada.

**Motivo:** o limite de taxa e de concorrência do Cloud Tasks é **por fila**, não por conta. A D-014 escolheu Cloud Tasks tendo o respeito ao rate limit por conta como uma das justificativas; realizar isso exige uma fila por conta. Uma fila compartilhada faria o backfill de uma conta consumir o orçamento de requisições das outras — e a V2 registrou 17 respostas HTTP 429 em 24 h entre 4 contas **sem backfill em execução**.

**Precisão sobre a D-014:** a D-014 descrevia a fila base como `ml-sync`. Esta decisão substitui esse nome. As demais filas (`analytics-recompute`, `backfill`, `maintenance`) continuam únicas, porque não falam com API externa limitada por conta.

**Impacto operacional:** conectar uma conta passa a incluir criar a fila dela. Executado por `bash infra/cloud-tasks-queues.sh <slug>`, e mais tarde pelo próprio fluxo de conexão de conta.

**Estado de implementação em 2026-08-21:** as quatro filas reais foram provisionadas pelo script. A criação automática permanece para a Fase 8, por uma identidade de provisionamento controlada; o runtime público da `api` não recebe `queueAdmin` só para eliminar esse passo raro.

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

# Decisões de integração Mercado Livre — respondidas em 2026-08-21

Levantadas pela pesquisa da documentação oficial que fecha a lista de verificação de `docs/MERCADO_LIVRE.md` secao 1 e desbloqueia a Fase 3.

## D-041 — Autorização multi-conta confirmada: OAuth padrão por conta, feito pelo ADMIN

**Contexto:** `docs/PROMPT_MASTER.md` §10 previa autorização centralizada pelo ADMIN "quando tecnicamente compatível com a integração", e `docs/ARCHITECTURE.md` secao 22 registrava isso como pendência de informação externa.

**Decisão:** confirmado na documentação oficial (`docs/MERCADO_LIVRE.md` secao 2.2) que não existe fluxo OAuth diferenciado para múltiplas contas — é o Authorization Code Grant padrão, repetido uma vez por conta. O ADMIN da Speed Bikers deve logar, uma vez por loja, com a credencial de administrador daquela conta específica no Mercado Livre (um operador/colaborador recebe `invalid_operator_user_id` e o grant fica inválido). Feito isso, a aplicação guarda `access_token`/`refresh_token` por conta no servidor e nenhum outro usuário interno reautentica.

**Motivo:** é exatamente o modelo que o schema da Fase 2 (`ml_accounts`, `ml_credentials`, `ml_oauth_states`) já suporta — a decisão fecha a pendência sem exigir mudança de schema.

**Impacto:** a tela de "Conectar conta" (Fase 3) é, por design, uma ação repetida por loja, executada pelo ADMIN — não uma autorização única "para todas as contas de uma vez".

## D-042 — Rate limit do Mercado Livre sem número oficial: filas mantêm valor conservador e ajustam por observação

**Contexto:** D-036 fixou uma fila do Cloud Tasks por conta ML com "valores provisórios até a confirmação da política de rate limit vigente".

**Decisão:** a documentação oficial (`docs/MERCADO_LIVRE.md` secao 2.3) confirma que o Mercado Livre não publica número fixo de requisições por minuto/hora nem cabeçalho de rate limit — o controle é por `client_id` + endpoint, com erro `429` e recomendação de backoff exponencial com jitter. Não há um valor a "confirmar" porque nenhum é publicado. As filas `ml-sync-<conta>` mantêm o valor conservador já provisionado, ajustado por observação real de `429` registrado em `sync_errors` durante a Fase 3.

**Motivo:** esperar por um número que a documentação declaradamente não publica bloquearia a Fase 3 sem ganho — é o princípio de "teste da dor medida" (`docs/ARCHITECTURE.md` secao 1) aplicado ao inverso: sem dado publicado, decide-se pelo conservador e mede-se depois.

**Impacto:** encerra a pendência de D-036. Nenhuma mudança de infraestrutura — os valores das filas continuam os já criados por `infra/cloud-tasks-queues.sh`.

## D-043 — Validação de origem do webhook por allowlist de IP

**Contexto:** `docs/ARCHITECTURE.md` secao 18 exige "caminho explicitamente liberado, com teste negativo nas rotas vizinhas" para o webhook público, sem definir o mecanismo de validação de origem.

**Decisão:** validar a origem da notificação do Mercado Livre pela **allowlist dos 8 IPs publicados** (`docs/MERCADO_LIVRE.md` secao 2.6). Não implementar verificação de assinatura HMAC — não existe mecanismo desse tipo documentado para o Mercado Livre (existe para Mercado Pago, produto diferente; a pesquisa confirmou o risco real de confundir os dois ao buscar "assinatura de webhook").

**Motivo:** é o único mecanismo de validação de origem que a documentação oficial oferece para este produto.

**Alternativa rejeitada:** aceitar a notificação sem checar origem, confiando só no formato do payload — mais fraco, sem necessidade já que existe allowlist publicada.

**Consequência aceita:** allowlist de IP é mais frágil que assinatura criptográfica (pode mudar sem aviso detalhado). Mitigação: revisar a lista periodicamente contra a documentação; a idempotência por `dedup_key`/dedupe de Cloud Tasks já limita o dano de um reprocessamento indevido, venha ele de origem legítima ou não.

---

# Decisões de implementação — webhook do Mercado Livre (2026-08-21)

## D-044 — Webhook: sem tabela de landing; o corpo da Cloud Task é o registro da notificação

**Contexto:** `docs/ARCHITECTURE.md` secao 10 e `docs/MERCADO_LIVRE.md` secao 3 descrevem o passo como "grava a notificação e cria uma Cloud Task", sem especificar onde a notificação é gravada. Nenhuma tabela para isso está documentada em `docs/DATABASE.md`.

**Decisão:** não criar tabela de landing. O corpo da Cloud Task (envelope + payload da notificação) É o registro durável até o worker processar — o mesmo padrão já usado por `erp.import.parse`/`erp.import.apply`, que também não têm uma tabela "recebido" separada do próprio job. Criado um novo tipo de job, `sync.webhook.received` (fila `ml-sync-<conta>`, dedupe `ml-webhook:{resource}`), registrado em `docs/API.md` secao 3.

**Motivo:** "zero chamada de rede" já é cumprido (nenhuma chamada ao Mercado Livre acontece no ACK); adicionar uma tabela extra só para guardar o que a própria fila já guarda de forma durável duplicaria estado sem necessidade — mesmo princípio de D-016 (sem tabela de snapshot quando o dado já existe em outro lugar).

**Impacto:** o handler do worker para `sync.webhook.received` (ainda não construído — depende do "Motor de diff e domain_events", item posterior do checklist da Fase 3) decide por `topic` o que buscar no Mercado Livre, e é aí que `sync_runs`/`sync_errors` nascem — a observabilidade começa no processamento, não no recebimento.

## D-045 — IP confiável do webhook é o penúltimo do `X-Forwarded-For`

**Contexto:** D-043 decidiu allowlist de IP como validação de origem do webhook, mas não definiu COMO extrair o IP real do cliente a partir do Cloud Run — nenhuma documentação do projeto cobria isso, e a "regra de nunca inventar comportamento de plataforma" pedia verificação antes de codificar.

**Decisão:** extrair o **penúltimo** IP da lista de `X-Forwarded-For` — o último é o próprio load balancer do Google, o primeiro é o que o cliente controla. Confirmado por leitura direta da documentação oficial do Google Cloud HTTPS Load Balancing (mesma infraestrutura de front-end que atende o Cloud Run): "the load balancer appends its values to the existing header" no formato `<existing>,<client-ip>,<load-balancer-ip>`, e "does not verify any IP addresses that precede" essa dupla.

**Motivo:** é a confirmação oficial mais próxima disponível — a página "Container runtime contract" do Cloud Run e a de headers do Cloud Functions não mencionam tratamento de `X-Forwarded-For`.

**Risco aceito, registrado explicitamente:** o texto confirmado é da documentação de HTTPS Load Balancing, não de uma página do Cloud Run rotulada como tal. `apps/api/src/ip-allowlist.ts` tem um comentário "PENDENTE" pedindo verificação contra o log real do Cloud Run em Dev (inspecionar o header numa chamada de teste real) antes de depender disto para bloquear tráfego em produção — mesma disciplina já usada em `packages/contracts/src/job.ts` para o limite de nome de task do Cloud Tasks.

**Alternativa rejeitada:** usar o PRIMEIRO IP da lista — erro comum que usaria exatamente o valor que o cliente forja livremente, tornando a allowlist inútil.

---

## D-046 — Cifra dos tokens do Mercado Livre: AES-256-GCM, chave em variável de ambiente

**Contexto:** `docs/ARCHITECTURE.md` secao 18 e a migration `20260820180000_create_ml_accounts.sql` já previam "tokens cifrados em repouso, chave no Secret Manager", mas nenhum documento escolhia o algoritmo nem o formato da coluna `text` de `ml_credentials.*_ciphertext`. Sem essa escolha, a conexão de conta (`POST /v1/ml-accounts/connect` + `GET /oauth/mercado-livre/callback`) não podia ser implementada — é o pré-requisito real da Fase 3 que nenhum item do checklist nomeava explicitamente.

**Decisão:** AES-256-GCM (`node:crypto`, sem dependência externa). Formato da coluna: `base64(iv[12] || authTag[16] || ciphertext)`, um único campo `text`, compatível com o schema já existente. A chave (32 bytes, base64) vem de `ML_TOKEN_ENCRYPTION_KEY` — variável de ambiente comum, resolvida pelo Secret Manager em produção e por `.env.local` localmente, mesmo padrão já usado por `SUPABASE_SERVICE_ROLE_KEY`. Validada no boot da `api` (Zod, decodifica e confere 32 bytes) — chave com tamanho errado derruba o processo no start, não na primeira tentativa real de conectar uma conta.

**Motivo:** GCM é AEAD — detecta chave errada ou ciphertext adulterado no próprio `decipher.final()`, sem exigir HMAC separado. IV aleatório por chamada (nunca reaproveitado) elimina a categoria de erro mais comum de cifra simétrica malfeita. `node:crypto` evita adicionar dependência para algo que a stdlib já cobre corretamente.

**Alternativa rejeitada:** confiar no Secret Manager também para versionamento de chave por linha — `ml_credentials.encryption_key_version` já existe no schema (default 1) para isso; a rotação em si fica fora de escopo até haver uma segunda versão de chave para rotacionar de verdade.

**Impacto:** `packages/mercado-livre/src/token-cipher.ts` (`encryptToken`/`decryptToken`/`loadEncryptionKey`) e `apps/api/src/ml-accounts.ts` (`startConnect`/`completeConnect`), implementados e testados nesta sessão — ver `docs/HANDOFF.md`. `ML_TOKEN_ENCRYPTION_KEY`, `MERCADO_LIVRE_CLIENT_ID`, `MERCADO_LIVRE_CLIENT_SECRET` e `MERCADO_LIVRE_REDIRECT_URI` entram no `.env.example` e no `envSchema` de `apps/api`.

> **Nota sobre a numeração (2026-08-27):** D-047 nunca existiu — a numeração pulou de D-046 para D-048 por engano na sessão original (confirmado via `git log -S "## D-047"`: nenhum commit jamais criou nem removeu essa entrada; as duas menções "D-047-adjacent" no texto de D-058 referenciam um número que nunca teve entrada própria). Buraco de numeração, não decisão apagada. O número fica reservado e sem uso para não renumerar todas as referências posteriores.

## D-048 — Checkpoint de pedidos usa `date_last_updated`, não `last_updated`

**Contexto:** implementando a persistência estruturada de pedidos (`orders`/`order_items`), o exemplo oficial de resposta de `/orders/search` (`developers.mercadolivre.com.br`, "Gerencie vendas → Orders", 2026-08-21) mostrou os dois campos na MESMA order com valores diferentes: `date_last_updated: "2020-02-14T02:55:49.811Z"` e `last_updated: "2019-05-28T15:16:04.000-04:00"`. Nenhuma prosa da página explica a diferença — só a descrição do filtro `order.date_last_updated.from/to`.

**Decisão:** o checkpoint de reconciliação/backfill (`sync_runs.latest_record_at`) usa `date_last_updated`, porque o nome bate com o filtro que a V3 já usa para selecionar a janela (`order.date_last_updated.from/to`). `last_updated` é gravado como coluna própria em `orders` (`docs/DATABASE.md`), sem função de checkpoint, até a diferença entre os dois campos ficar clara.

**Motivo:** usar o campo errado no checkpoint é o tipo de erro que não quebra teste nenhum e só aparece como pedido "sumido" meses depois — o nome que bate com o filtro é a escolha defensável na ausência de documentação explícita.

**Impacto:** corrigido em `apps/worker/src/handlers/ml-orders-fetch.ts` antes de qualquer deploy real ter rodado com o nome errado (achado durante o desenvolvimento, não em produção).

**Validação empírica concluída em Dev (2026-08-21):** depois das quatro conexões reais, milhares de pedidos apresentaram `date_last_updated` diferente de `last_updated` — a diferença ocorreu na grande maioria das linhas das quatro contas com dados. As quatro reconciliações por janela concluíram usando `date_last_updated` como checkpoint. A pendência deixa de bloquear produção; os dois campos continuam persistidos separadamente porque não são semanticamente intercambiáveis.

## D-049 — OAuth do Mercado Livre usa PKCE S256 e guarda o verifier cifrado

**Contexto:** as treze tentativas reais de conectar as quatro contas em Dev chegaram ao callback, mas o endpoint de token recusou todas com `invalid_request`; `ml_credentials` permaneceu vazia. A URL de autorização e a troca de token da V3 não enviavam PKCE. Redirect URI, client ID e referências de secrets estavam corretos; pelo código de erro e pela documentação oficial — que torna `code_challenge`/`code_challenge_method` e `code_verifier` obrigatórios quando PKCE está habilitado — a ausência de PKCE foi isolada como causa.

**Decisão:** usar PKCE S256 em toda autorização. A `api` gera um verifier base64url novo (32 bytes aleatórios) por state, envia somente `SHA-256(verifier)` na URL, cifra o verifier com a mesma chave AES-256-GCM de D-046 e o persiste em `ml_oauth_states.code_verifier_ciphertext`. O callback consome o state atomicamente, decifra o verifier e o envia na troca do código. States anteriores à migration são recusados com instrução para reiniciar a conexão.

**Motivo:** corrige a causa observada sem enfraquecer a aplicação externa. O verifier precisa sobreviver ao redirecionamento, mas não precisa ficar em texto claro nem passar pelo navegador; a infraestrutura de cifra e a tabela inacessível pela Data API já existiam.

**Alternativas rejeitadas:** desabilitar PKCE no painel do Mercado Livre (reduz a proteção e depende de alteração manual externa) e embutir o verifier no próprio `state` ou gravá-lo em texto claro (mistura responsabilidades ou expõe um segredo transitório sem necessidade).

**Impacto:** migration aditiva `20260821180000_add_ml_oauth_pkce_verifier.sql`; `packages/mercado-livre` passa a gerar o par PKCE e `apps/api/src/ml-accounts.ts` persiste/recupera o verifier. Nenhum token ou state existente é apagado; autorizações iniciadas antes da mudança precisam ser reiniciadas.

**Validação empírica concluída em Dev (2026-08-21):** as quatro contas terminaram uma autorização nova, cada uma com `seller_id` próprio, credenciais cifradas presentes e `last_error IS NULL`. Os states novos continham verifier PKCE e foram consumidos; as quatro reconciliações reais terminaram com sucesso. O OAuth deixa de ser pendência.

## D-050 — Métricas de venda usam status pago, receita bruta e compra por pack

**Contexto:** a Fase 5A precisava fechar o significado dos seis números de venda antes de criar fatos e rollups. A estrutura do Mercado Livre tem uma order por linha e usa `pack_id` para reunir a compra do cliente; reembolso parcial existe como status, mas a V3 ainda não integrou a fonte detalhada de devoluções/estornos.

**Decisão:** venda válida é `paid` ou `partially_refunded`; `receita_bruta` soma `orders.total_amount` e não desconta o reembolso parcial; a unidade de compra usa `pack_id` e cai para `order_id` quando o pack é nulo. A chave distinta é tipada (`pack:<id>`/`order:<id>`), o dia de negócio vem de `orders.date_created` em `America/Sao_Paulo`, e toda medida distinta ou razão é calculada diretamente no grão solicitado — nunca pela soma/média de rollups inferiores. Vendas com `sku_id IS NULL` continuam nos totais de conta e organização.

**Motivo:** separa três conceitos que a interface precisa nomear sem ambiguidade: linha/pedido do ML, compra do cliente e receita bruta. Também evita apagar faturamento só porque o vínculo de SKU ainda não foi resolvido.

**Alternativa rejeitada:** tratar `partially_refunded` como receita líquida sem persistir o valor e o momento do estorno. Isso inventaria precisão que a fonte atual não oferece. Receita líquida entra com outro ID quando a integração de devoluções/reembolsos existir.

**Impacto:** as seis definições completas passam a viver em `docs/METRICS.md` e no espelho `metric_definitions`; os fatos e rollups da próxima etapa devem implementar exatamente essa semântica.

## D-051 — Chave suja usa janela de minuto; ID diário fixo perde atualizações

**Contexto:** o desenho inicial nomeava a task como `recompute:{conta}:{sku}:{data}` e pretendia reutilizar esse mesmo ID ao longo do dia. A documentação oficial do Cloud Tasks, confirmada em 2026-08-21 (método `tasks.create`, atualizado em 2026-07-30), diz que o ID de uma task executada ou apagada pode levar **até 24 horas** para ficar disponível novamente. Depois do primeiro recálculo, uma venda posterior receberia `ALREADY_EXISTS` e desapareceria da fila — exatamente a classe de atraso que a chave suja deveria eliminar.

**Decisão:** a unidade materializada é conta + dia de negócio, porque `private.compute_daily_sales_metrics` recalcula anúncio, SKU e conta juntos. O ID da task inclui o UUID estável da conta e uma janela UTC de minuto: `recompute:{account-uuid}:{data-negocio}:{YYYY-MM-DDTHH:mmZ}`, com execução atrasada em 60 segundos. O slug não serve aqui porque só é único dentro da organização e a fila é compartilhada. Eventos do mesmo minuto colapsam; evento de minuto posterior sempre ganha ID novo e não encontra o tombstone anterior.

**Concorrência:** a RPC adquire `pg_advisory_xact_lock` por conta. Incrementais de minutos diferentes e rebuild da mesma conta são serializados; contas diferentes continuam paralelas. Os três INSERTs consomem um único CTE `MATERIALIZED`, portanto enxergam o mesmo snapshot de `orders`/`order_items`.

**Produtor:** o `worker` marca o dia sujo somente depois de uma janela de reconciliação persistir com sucesso e recebe `cloudtasks.enqueuer` apenas em `analytics-recompute` e `backfill`. O backfill histórico não marca métricas enquanto está incompleto; ao final, a RPC de rebuild cobre todo o intervalo.

**Impacto:** substitui somente a forma da chave de recálculo descrita originalmente em D-017; fato, rollups e semântica das métricas não mudam. `analytics.recompute` aceita modo incremental (um dia) e rebuild (intervalo), ambos idempotentes e baseados no mesmo cálculo SQL.

## D-052 — Reversão de estoque por cancelamento reverte o movimento gravado, não recalcula dos itens atuais

**Contexto:** segundo item do checklist da Fase 4, depois de `computeSaleDeductions`. `sku_id` é resolvido fresco a cada persistência de pedido (D-020) — o vínculo de um item pode mudar entre o momento da venda e o momento do cancelamento (correção humana na Central de Vinculações, por exemplo).

**Decisão:** `computeCancellationReversals` (`@sb/domain/inventory`) não recebe os itens do pedido. Recebe os movimentos `VENDA_ML` JÁ GRAVADOS em `stock_movements` para aquela order (`apps/worker/src/handlers/persist-order.ts` consulta antes de reverter) e produz um movimento `CANCELAMENTO_ML` por movimento existente, com `qty_delta` invertido e `idempotency_key` derivada (`cancelamento:{idempotency_key original}`). Quando o pedido está cancelado, a persistência pula inteiramente o recálculo de KIT/componentes — essa decomposição já está gravada no ledger, não precisa ser refeita.

**Motivo:** se a reversão recalculasse a partir dos itens atuais (mesmo padrão de `computeSaleDeductions`), um vínculo trocado depois da venda geraria uma reversão para o SKU **novo**, nunca deduzido, deixando o SKU **antigo** (o que realmente foi deduzido) sem reversão — o ledger fecharia errado em dois SKUs ao mesmo tempo. Reverter o que foi de fato lançado é a única forma de garantir soma zero por order, independente de o catálogo ter mudado depois.

**Alternativa rejeitada:** espelhar `computeSaleDeductions` (recalcular dos itens atuais, com chave de idempotência simétrica). Mais simples e mais parecida com a dedução, mas incorreta sempre que o vínculo mudou entre venda e cancelamento — cenário raro, mas real (é exatamente o que a Central de Vinculações existe para corrigir).

**Fora de escopo, de propósito:** devolução (`order.returned`) continua sem tratamento — mesmo motivo já registrado para o detector de eventos (`packages/domain/src/events/order-events.ts`): o Mercado Livre modela devolução pela API de Reclamações e Devoluções, não integrada. Reprocessar um pedido que foi cancelado e depois "descancela" no Mercado Livre (`pending_cancel` revertido para `paid`) também não re-deduz — a chave de venda original (`venda:{order}:{position}`) já foi usada e o `UNIQUE` recusaria uma nova dedução; cenário considerado raro o bastante para não tratar nesta etapa.

**Impacto:** `stock_movements` ganha `CANCELAMENTO_ML` como segundo tipo em uso (schema já previa desde a migration do ledger). `apps/worker/src/handlers/persist-order.ts` bifurca em duas rotas mutuamente exclusivas por status: cancelamento (reversão) ou venda válida (dedução) — nunca as duas na mesma chamada.

## D-053 — Direção da NF-e (ENTRADA/SAIDA) compara emit/dest contra o CNPJ da organização, nunca `ide/tpNF` sozinho

**Contexto:** achado ao analisar o PRIMEIRO XML real de NF-e recebido do usuário (2026-08-22) — uma compra de fornecedor real, `natOp="VENDA P/FORA DO ESTADO"`, `tpNF=1`, `emit`=fornecedor, `dest`=Speed Bikers. A implementação original do parser (`packages/domain/src/nfe/parse.ts`) fazia `tpNF === "0" ? "ENTRADA" : "SAIDA"` direto, seguindo a documentação oficial ("0 = entrada, 1 = saída") ao pé da letra.

**O erro:** `ide/tpNF` reflete a operação do **emitente** do documento, não da Speed Bikers. Uma nota de venda emitida por um fornecedor chega com `tpNF=1` ("saída" do lado de quem vendeu) — que é o OPOSTO de "entrada no nosso estoque". Usar `tpNF` direto classificaria toda compra de fornecedor como `SAIDA_NFE`, invertendo o sinal do movimento gerado no ledger. Este bug nunca chegou a gerar um `stock_movements` errado em produção — foi encontrado e corrigido antes da etapa de aplicação (que ainda não existe), mas seria uma inversão de estoque silenciosa se tivesse passado.

**Decisão:** a direção é decidida comparando `emit/CNPJ` e `dest/CNPJ` do XML contra o CNPJ da PRÓPRIA organização (`organizations.cnpj`, coluna nova, migration `20260822151922_add_nfe_party_fields.sql`): `dest` bate → `ENTRADA`; `emit` bate → `SAIDA`; nem um nem outro bate → erro (documento rejeitado, não adivinha). `ide/tpNF` deixou de ser usado na decisão — continua sendo lido e validado (`'0'` ou `'1'`), mas só como campo do documento, não como fonte de direção.

**Por que não usar os dois (tpNF E emit/dest) como conferência cruzada:** simplicidade, por ora — emit/dest é suficiente e inequívoco sozinho. Cruzar os dois exigiria decidir o que fazer numa divergência (log? erro? qual vence?), decisão sem evidência real para tomar ainda com um único XML de exemplo.

**Impacto:** `organizations` ganhou coluna `cnpj` (nullable — nada além de NF-e precisa dela hoje); populada com o CNPJ real da Speed Bikers, confirmado pelo próprio XML de exemplo. `documents` ganhou `recipient_cnpj`/`recipient_name` (o parser já devolvia `recipientCnpj`/`recipientName` desde o início, mas a migration original esqueceu de persistir — corrigido junto, mesma causa raiz). `nfe.import.parse` falha definitivamente (`not_retryable`) se a organização não tiver CNPJ cadastrado — não há como decidir a direção com segurança sem ele.

**Achado relacionado, mesmo XML real:** `packages/domain/src/nfe/parse.ts` usava `zod` sem declará-lo em `packages/domain/package.json` — funcionou localmente (resolução acidental do pnpm) e quebrou o CI (instalação limpa). Reescrito sem `zod`, com validação manual — `@sb/domain` continua com zero dependências de runtime (`docs/ARCHITECTURE.md` secao 7).

## D-054 — `domain_events.ml_account_id` aceita NULL para eventos organizacionais

**Contexto:** ao implementar a reconciliação de estoque contra o snapshot do UpSeller (D-029), o evento `stock.balance.diverged` (já catalogado desde a Fase 3, `packages/domain/src/events/catalog.ts`, nunca emitido até agora) precisava ser gravado em `domain_events` — mas a coluna `ml_account_id` era `NOT NULL` desde a migration original (`20260821050000_create_domain_events.sql`), e a policy de leitura (`domain_events_select_permitted`) usava exclusivamente `private.has_account_access(ml_account_id)`.

**O problema:** estoque não pertence a uma conta Mercado Livre. `stock_movements`/`inventory_balances` são inteiramente organizacionais (D-006), e um SKU pode estar vinculado a várias contas ML, a nenhuma, ou ter chegado via NF-e antes de qualquer anúncio existir. Escolher uma conta "representativa" para o evento seria arbitrário — qual conta, entre várias vinculadas ao mesmo SKU? — e enganoso, sugerindo uma relação causal que não existe.

**Decisão:** `domain_events.ml_account_id` passa a aceitar `NULL`. A policy de leitura ganha um segundo caminho: com conta, continua exigindo `has_account_access(ml_account_id)` como antes; sem conta, qualquer membro da organização vê (`is_member_of(organization_id)`, mesmo padrão já usado em `documents`/`stock_movements`). Todo evento hoje EXCETO `stock.balance.diverged` continua sempre preenchendo `ml_account_id` — a coluna aceita nulo, não passa a ser opcional por escolha de quem grava caso a caso.

**Impacto na tela `/sincronizacao`:** a seção "Eventos recentes" fazia `event.ml_accounts.label` sem checagem de nulo — corrigido para `event.ml_accounts?.label ?? "Estoque"`, já que o embed do Supabase retorna `null` quando `ml_account_id` é nulo.

**Alternativa rejeitada:** não gravar em `domain_events` para este caso, só no ledger (`stock_movements` com `AJUSTE_RECONCILIACAO`). Rejeitada porque D-029 e o catálogo já previam explicitamente um evento crítico para esta divergência — abandonar essa parte contradiria uma decisão já tomada sem motivo novo, só para evitar a migration.

## D-055 — TRANSITO nasce ao marcar o pedido de compra `ORDERED`, fecha em `RECEIVED`/`CANCELLED`; nunca gera LOCAL

**Contexto:** o ciclo do pedido de compra (`suppliers`/`purchase_orders`/`purchase_order_items`/`purchase_order_events`, D-040) existia desde 2026-08-22, mas não tocava o ledger — `docs/ROADMAP.md` registrava explicitamente a pergunta em aberto: "falta decidir QUANDO nasce TRANSITO (aprovação? confirmação de envio pelo fornecedor, que a V3 não tem como saber sem integração?)".

**Decisão:** TRANSITO nasce quando o pedido é marcado `ORDERED` (`mark_purchase_order_ordered`) — o compromisso de compra assumido pela própria organização, NÃO uma confirmação de despacho do fornecedor. Fecha (`RECEBIMENTO_TRANSITO`, `qty_delta` negativo) em duas situações: recebimento total (`receive_purchase_order`) ou cancelamento enquanto `ORDERED` (`cancel_purchase_order`, se `status = 'ORDERED'` no momento da chamada) — do ponto de vista do ledger, "o trânsito encerrou" é o fato relevante; o motivo (chegou vs. cancelado) já fica no histórico de `purchase_order_events`, que tem `event_type` próprio para cada caso. Pedido cancelado em `DRAFT`/`APPROVED` nunca abriu TRANSITO, então não gera reversão. Os dois `stock_movements` são gravados na MESMA transação SQL das RPCs (`security definer`, mesmo mecanismo que já grava `purchase_order_events`), não por um job assíncrono do worker.

**Por que `ORDERED`, não `APPROVED` ou uma confirmação externa:** `APPROVED` é só a decisão interna de comprar — nada foi comunicado ao fornecedor ainda, então "em trânsito" seria uma mentira. Esperar confirmação real de despacho do fornecedor exigiria uma integração que não existe e que a documentação oficial de nenhuma API cobre para fornecedores locais (diferente do Mercado Livre) — REGRA ABSOLUTA impede presumir esse formato. `ORDERED` é o único ponto do ciclo que reflete uma ação real e observável da própria Speed Bikers (o pedido foi de fato enviado ao fornecedor), sem depender de nada externo.

**Por que RECEIVED/CANCELLED-em-trânsito NÃO geram `stock_movements` em LOCAL:** receber fisicamente a mercadoria e processar a nota fiscal correspondente são atos distintos, que podem acontecer em momentos diferentes (a mercadoria pode chegar dias antes da NF-e ser processada, ou vice-versa) — `ENTRADA_NFE` (D-053) continua sendo a ÚNICA fonte de entrada em LOCAL por compra, desacoplada de propósito do ciclo do pedido. Acoplar as duas faria o pedido de compra "inventar" estoque físico sem o documento fiscal correspondente ter sido conferido.

**Vocabulário fechado, sem migration nova:** cancelamento-em-trânsito reusa o mesmo `movement_type = 'RECEBIMENTO_TRANSITO'` do recebimento normal, em vez de um tipo dedicado (`CANCELAMENTO_TRANSITO` inexistente) — os 12 valores de `stock_movements.movement_type` já eram fechados e aprovados (`docs/ARCHITECTURE.md`/`docs/DATABASE.md`); estender o CHECK sem evidência de necessidade real (só há 1 pedido histórico na V2, nunca cancelado em trânsito) contradiria o mesmo princípio de evidência medida já usado em D-037/D-039/D-040/D-048/D-053.

**Fora de escopo, de propósito:** item de pedido sem `sku_id` vinculado não gera movimento algum (nem em `ORDERED` nem em `RECEIVED`) — resolve sozinho quando o vínculo nascer, mesmo padrão já usado em `computeSaleDeductions`/`computeNfeApplicationMovements`, nenhum dos dois recalcula o passado. Recebimento parcial continua fora de escopo (D-040/`docs/ROADMAP.md`) — `receive_purchase_order` é tudo-ou-nada, então o `RECEBIMENTO_TRANSITO` também é.

**Impacto:** `mark_purchase_order_ordered`/`receive_purchase_order`/`cancel_purchase_order` (migration `20260823160629_purchase_order_transit_movements.sql`) ganham um `insert into stock_movements` cada, escrito direto em SQL — sem função pura nova em `@sb/domain`, porque o ciclo do pedido de compra já era inteiramente SQL (`security definer`), sem passar pelo `worker`/fila de jobs (diferente de venda/NF-e/reconciliação, que chegam por webhook ou upload). Testado via `packages/db/src/rls.integration.test.ts` (integração contra Postgres real), não `@sb/domain`, pela mesma razão.

## D-056 — Conferência ledger × projeção só detecta e alerta, nunca corrige; reusa `stock.balance.diverged`

**Contexto:** `docs/ROADMAP.md` Fase 4 previa "conferência automática ledger × projeção, com evento crítico na divergência" desde o schema original do ledger (`private.compute_inventory_balances_from_ledger`, criada em 2026-08-21 já como base para este job, nunca chamada por código nenhum até agora).

**Decisão 1 — nunca gera `stock_movements`:** diferente de `computeReconciliationAdjustments` (D-029, UpSeller × ledger), que grava `AJUSTE_RECONCILIACAO` para trazer o ledger da V3 a bater com o ERP externo, `computeLedgerIntegrityDivergences` (`@sb/domain/inventory`) só produz eventos, nunca movimentos. As duas fontes aqui (`stock_movements`, recomputado do zero, e `inventory_balances`, mantida por `private.apply_stock_movement`, um trigger na MESMA transação de cada INSERT) **não deveriam divergir nunca, por construção** — se divergirem, é porque o trigger foi pulado ou algo escreveu direto em `inventory_balances` (tecnicamente possível: o `GRANT` dá `update` a `service_role`, embora nenhum código hoje o exerça assim). Gravar mais uma linha de ledger não repara esse tipo de bug, só acrescenta mais uma fonte para desconfiar — o comportamento certo é alertar e deixar um humano investigar a causa raiz.

**Decisão 2 — reusa o `event_type` `stock.balance.diverged`, não cria um novo:** `docs/API.md` secao 4 já documentava esta linha com a fonte genérica "job de conferência" desde a Fase 0 (antes de qualquer um dos dois jobs existir) — o catálogo sempre tratou "estoque discordando entre duas fontes" como um conceito único, deixando a origem específica para o contexto do evento (`before`/`after`), não para o nome do tipo. Seguido aqui: os dois jobs emitem `stock.balance.diverged`, e `before`/`after` ganham `checkedAgainst: "ledger_vs_projection"` para quem for investigar distinguir das divergências do UpSeller (que não têm esse campo). Um `event_type` novo (`stock.ledger.integrity_failed`, cogitado) foi descartado por duplicar um catálogo que já cobria o caso.

**Achado técnico, reaproveitado da etapa anterior (D-029):** `private.compute_inventory_balances_from_ledger` tinha o MESMO problema já corrigido em `compute_erp_snapshot_balances` — `supabase/config.toml` só expõe `public`/`graphql_public` ao PostgREST, e o worker fala com o Postgres via `AdminClient` (PostgREST), nunca conexão direta. Movida para `public` (migration `20260823163058`, `DROP` + `CREATE` porque mudar de schema não é coberto por `CREATE OR REPLACE`), com `revoke ... from public, anon, authenticated` + `grant ... to service_role` — a segurança não depende do schema, o `GRANT` já bastava.

**Impacto:** `apps/worker/src/handlers/verify-ledger-integrity.ts` (job `maintenance.verify-ledger-integrity`), `apps/api/src/ledger-integrity-schedule.ts` (gatilho, por organização) + rota `POST /internal/schedule/ledger-integrity`, Cloud Scheduler diário (`v3-verify-ledger-integrity`, 30 minutos depois de `v3-reconcile-balances` para não competir por recurso). Fecha o item "Conferência automática ledger × projeção" do checklist da Fase 4.

## D-057 — Pós-venda (Claims/Returns): reversão só quando devolução TOTAL do item; parcial vira alerta, não cálculo

**Contexto:** `order.returned` era, desde a Fase 3, uma nota solta em `@sb/domain/events` ("depende da API de Reclamações e Devoluções, não integrada") — item próprio do checklist da Fase 4, último a fechar. A pesquisa ao vivo (`docs/MERCADO_LIVRE.md` secao 2.10, 2026-08-23) revelou um modelo mais rico do que a nota original presumia: claims e returns são dois recursos DISTINTOS, ligados por `related_entities`, com devolução podendo ser PARCIAL (por item, não só por pedido).

**Decisão 1 — reversão escopada ao ITEM, não ao pedido inteiro:** diferente de `computeCancellationReversals` (D-052, reverte TODOS os movimentos `VENDA_ML` de uma order), a devolução do Mercado Livre é por `item_id`/`variation_id` dentro de um pedido — `orders[].item_id` do recurso de devolução bate direto com `order_items.item_id`/`variation_id` (mesmo formato), permitindo localizar a POSIÇÃO do item sem depender de `sku_listing_links`. A chave de idempotência da venda original já é escopada por posição (`venda:{orderId}:{position}` — PRODUTO — ou `venda:{orderId}:{position}:{componentSkuId}` — KIT, `sale-deduction.ts`), então filtrar por prefixo dessa chave isola exatamente os movimentos daquele item (todos os componentes de um KIT juntos, nenhum de outra posição), sem precisar de nenhuma lógica nova de KIT no código de reversão — mesmo raciocínio de reuso já usado em D-052.

**Decisão 2 — devolução PARCIAL de um item não é revertida automaticamente:** reverter proporcionalmente (ex.: 2 de 5 unidades devolvidas, ou pior, um KIT com componentes de quantidades diferentes) exigiria uma regra de arredondamento/rateio sem nenhum caso real para calibrar — mesmo princípio de evidência medida já usado em D-037/D-039/D-053. Em vez de inventar a proporção, `computeReturnReversal` sai com `fullReversal: false`, zero movimentos gravados, e o evento `order.returned` carrega `needsManualReview: true` — o ajuste manual de estoque (`/estoque`, já implementado nesta mesma sessão) é o caminho até essa regra ter dado real para se basear. Reversão só acontece quando `return_quantity >= total_quantity` do item.

**Decisão 3 — gatilho é a FÍSICA (`status = "delivered"` da devolução), não o dinheiro:** o recurso de devolução separa `status` (do envio de volta) de `status_money` (retained/refunded/available). A V3 reverte estoque quando o produto **fisicamente retorna**, nunca quando o pagamento é devolvido — o dinheiro pode ser reembolsado antes (ex.: `refund_at: "shipped"`) sem o produto ainda ter chegado, e reverter estoque nesse momento inflaria o saldo local de algo que ainda está em trânsito de volta.

**Decisão 4 — reusa `stock.movement_type = DEVOLUCAO_ML` e `event_type = order.returned`, ambos já catalogados desde a Fase 4/3 original**, sem necessidade de migration nem de novo tipo — os dois já existiam no vocabulário fechado, só sem código que os gerasse.

**Detecção de devolução associada a um claim**: segue o mecanismo que a própria documentação oficial recomenda — checar `related_entities` do claim por `"return"` (não `claim.type === "return"`, que é mais restrito e não cobre `mediations` com devolução associada).

**Impacto:** `apps/worker/src/handlers/webhook-received.ts` ganha `post_purchase` como segundo tópico com consumidor (`orders_v2` era o único); `apps/worker/src/handlers/claim-return.ts` (novo) orquestra claim → return → reversão; `packages/domain/src/inventory/return-reversal.ts` (novo, puro) decide o quê reverter. Fecha o último item real do checklist da Fase 4 (recebimento parcial de pedido de compra segue adiado por decisão deliberada separada, não é bloqueio).

## D-058 — `listings` é UMA tabela (não três), projeção mutável — achado ao inspecionar o banco real da V2

**Contexto:** "Sincronização de listings/anúncios" era o pré-requisito não nomeado da Fase 5B ("Dashboards de SKU e de Anúncio" depende disso existir primeiro). O desenho conceitual original (`docs/ARCHITECTURE.md`/`docs/DATABASE.md` secao 2, escrito na Fase 0) previa TRÊS tabelas: `listings`, `listing_variations`, `listing_price_states` — nunca elaboradas em colunas, só citadas por nome.

**Achado, evidência medida (mesmo princípio de D-037/D-039/D-040/D-048/D-053/D-057):** antes de desenhar, inspecionei o banco real da V2 (`speedbikers-gestao-v2`, ref `eeramcpouarfwagxigtz`). Ela tinha justamente esse desenho ambicioso — `ml_listings`/`ml_listing_variations` (título, categoria, `health`, permalink, thumbnail, `raw_payload`, ~20 colunas cada) — e as duas tabelas tinham **ZERO linhas**: nunca chegaram a ser populadas de verdade. Em contraste, `ml_offer_price_states` (uma tabela MUITO mais estreita e focada — 40+ colunas, mas TODAS de mecânica de preço/promoção: `base_price`, `effective_price`, `winning_offer`, campos de promoção) tinha uso real (5.143 linhas, "price divergence diagnostics"). Uma terceira tentativa intermediária, `ml_offer_state_snapshots` (item_id/variation_id/seller_sku/title/status/price/quantities/health, sem o `raw_payload`/permalink/thumbnail pesados), também tinha zero linhas.

**Leitura do padrão:** a V2 tentou um espelho completo do anúncio DUAS vezes (uma ambiciosa, uma mais enxuta) e nenhuma das duas foi usada — só a tabela estritamente focada em PREÇO teve tração real. Isso sugere que o valor de negócio comprovado é rastrear preço/estado básico, não um espelho completo de metadado de anúncio.

**Decisão 1 — UMA tabela `listings`, não três:** grão `(ml_account_id, item_id)`, mesma granularidade já usada por `sku_listing_links`/`fulfillment_stock_snapshots` para o mesmo conceito (item + variação opcional) — evita o split em `listings`/`listing_variations` que a V2 tinha e nunca populou. Colunas enxutas: `item_id`, `sku_id` (resolvido no sync), `title`, `status`, `price`, `currency_id`, `available_quantity`, `category_id` — o suficiente para "Dashboard de Anúncio" e Curva ABC, sem replicar a tabela de 40 colunas de promoção (essa é diagnóstico, Fase 6/7, não dashboard, Fase 5B).

**Decisão 2 — projeção MUTÁVEL (upsert), não ledger append-only:** diferente de `stock_movements`/`domain_events`, não há evidência ainda de que histórico de MUDANÇA de listing (quando o título mudou, quando o preço mudou) seja necessário — isso vira relevante quando `domain_events` datados alimentar diagnóstico (Fase 6), momento em que os `event_type` já catalogados desde a Fase 0 (`listing.title.changed`, `listing.status.paused`, etc., ainda não emitidos por código nenhum) fariam sentido. Implementar o diff agora seria especular sem caso de uso concreto.

**Decisão 3 — enumeração via `sku_listing_links`, não `/users/{id}/items/search`:** mesmo mecanismo já usado por Full (D-047-adjacent) — sincroniza só itens JÁ vinculados a um SKU, não o catálogo completo do vendedor. "Descobrir anúncio novo automaticamente" é uma funcionalidade genuinamente diferente (mais próxima da Central de Vinculações) sem evidência ainda de ser o problema real.

**Decisão 4 — escopo limitado a itens SEM variação**, mesmo raciocínio já usado em Full (D-047-adjacent): a documentação oficial não mostra o formato exato de variação dentro da resposta de `/items` para codar esse ramo sem adivinhar (REGRA ABSOLUTA).

**Impacto:** `apps/worker/src/handlers/ml-listings-fetch.ts`/`sync-listings-snapshot.ts` (job `sync.listings.snapshot`), `apps/api/src/listings-schedule.ts` + rota `POST /internal/schedule/listings`, Cloud Scheduler a cada 6h (`v3-listings-snapshot`, mesmo raciocínio de rate limit conservador de Full, D-042). Migration `20260823172938_create_listings.sql`. UI/dashboard de anúncio propriamente dito (o item de checklist original da Fase 5B) fica para depois — este item era só a sincronização, o pré-requisito.

## D-059 — Visitas e conversão entram na Fase 5B; Ads fica ADIADO — evidência de esforço, não de dado

**Contexto:** D-032 previu "Visitas, conversão e Ads" como um item só da Fase 5B, sem detalhar as três fontes. Pesquisa ao vivo (`developers.mercadolivre.com.br`, "Visitas" e "Product Ads", 2026-08-23) revelou que as três NÃO são do mesmo tamanho de esforço.

**Visitas — endpoint simples, sem pré-requisito de conta:** `GET /items/{item_id}/visits/time_window?last=N&unit=day` devolve visita por dia por anúncio direto, sem enumeração de campanha nem enrollment prévio — mesmo padrão de `/items/{id}` (listings) e do snapshot de Full. Implementado nesta etapa.

**Conversão não precisa de fonte própria:** é derivada — `pedidos ÷ visitas` — de dados que já existem (`daily_listing_metrics`, orders) cruzados com a nova tabela de visitas. Nenhum endpoint de "conversão" existe na API do Mercado Livre; calculada em SQL (`get_listing_traffic`), nunca em JS (`docs/ARCHITECTURE.md` seção 21).

**Ads — ADIADO, esforço estrutural muito maior:** a API de Product Ads (`developers.mercadolivre.com.br/pt_br/product-ads-leitura`) exige um conceito de `advertiser_id` PRÓPRIO por conta+produto (`PADS`/`DISPLAY`/`BADS`), com elegibilidade condicionada (reputação amarela ou superior, 15+ dias de conta, mínimo de vendas, sem fatura vencida) — ou seja, a conta Mercado Livre da Speed Bikers pode nem estar habilitada para o Mercado Ads hoje, sem nenhuma evidência de que esteja. A cadeia de consulta é: listar `advertisers` → `campaigns` → `ads` → `metrics`, quatro recursos hierárquicos, não um endpoint só. Isso é uma integração nova e maior, do tamanho de Claims/Returns (D-057) ou listings (D-058), não um adendo a visitas. Implementar sem saber se a conta tem o produto habilitado seria construir contra uma API que pode nem responder dado real — mesmo princípio de evidência medida já usado em D-037/D-039/D-053/D-058, adaptado: aqui a "evidência" que falta é operacional (a conta está no programa?), não um dado histórico da V2.

**Decisão de cadência — DIÁRIA, não a cada 6h:** diferente de listings/Full (dado operacional, estoque/preço mudam e importam na hora), visita é um contador cumulativo de baixa urgência — ninguém decide nada de operação com visita de 6 em 6 horas. `fetchListingVisits` busca `last=3` dias a cada rodada (não só o dia corrente), absorvendo uma execução diária perdida sem esperar até o dia seguinte — troca simplicidade de operação por uma folga de reprocessamento, em vez de aumentar a frequência do job.

**Achado incidental:** `sync_runs.resource`/`sync_errors.resource` (CHECK constraint desde a Fase 2) nunca previu `'visits'` — só `orders`/`listings`/`fulfillment` foram antecipados quando o enum foi criado. Primeira vez nesta sessão que esse CHECK precisou ser alargado de verdade (`alter table ... drop/add constraint`), migration `20260823184120_create_daily_listing_visits.sql`.

**Impacto:** tabela `daily_listing_visits` (grão `ml_account_id, item_id, metric_date`, espelho direto do valor que o ML devolve, sem recomputar), RPC `get_listing_traffic` (`security invoker`, full outer join entre visitas e pedidos, mesmo padrão de `get_stock_coverage`). `apps/worker/src/handlers/ml-listing-visits-fetch.ts`/`sync-listing-visits-snapshot.ts` (job `sync.listing-visits.snapshot`), `apps/api/src/listing-visits-schedule.ts` + rota `POST /internal/schedule/listing-visits`, Cloud Scheduler diário (`v3-listing-visits-snapshot`). `/anuncios` ganha colunas "Visitas" e "Conversão". **O Marco da Fase 5B ainda não é atingido** — "distinguir queda de tráfego de queda de conversão" precisa das duas metades (visitas E conversão) na tela, que é exatamente o que esta etapa entrega; falta ainda validar com dado real de produção (nenhuma conta conectada tem sincronização de visitas rodada de verdade nesta sessão). Ads permanece como item de checklist separado, sem escopo definido até haver evidência de que a conta tem o produto habilitado.

## D-060 — Busca Universal (Command Palette): cinco entidades com destino real; "Filtros salvos" e Central de Ações ficam de fora

**Contexto:** "Busca Universal / Command Palette" e "Filtros salvos" eram um item só do checklist da Fase 5B (`docs/PRODUCT_REQUIREMENTS.md`, "Planejar uma busca/Command Palette para localizar rapidamente SKU, produto, MLB, conta, pedido, fornecedor, ação e outras entidades importantes"). São dois recursos de tamanho muito diferente — Busca Universal é um RPC + um componente cliente autocontido; "Filtros salvos" exigiria uma tabela nova E mudança em toda tela com filtro hoje (`/vendas`, `/curva-abc`, possivelmente mais), tocando código já shippado nesta sessão. Mesmo raciocínio de separação já usado em D-059 (Visitas vs. Ads).

**Decisão 1 — escopo de entidades limitado ao que tem destino de navegação REAL hoje:** o requisito original cita "SKU, produto, MLB, conta, pedido, fornecedor, ação". Verificado contra as rotas existentes (`apps/web/app`): SKU tem `/skus/[skuId]`; pedido de COMPRA tem `/compras/[id]`; conta (`/contas`), fornecedor (`/fornecedores`) e anúncio/MLB (`/anuncios`) só têm tela de LISTA, sem página por item — a busca leva a essas até a lista mesmo assim (útil, mas menos preciso). **Pedido de VENDA do Mercado Livre (`orders`) fica de fora**: não existe nenhuma página de detalhe ou lista por pedido na V3 — `/vendas` é dashboard agregado — então não há para onde levar o resultado; incluir o pedido na busca sem destino seria pior que não incluir. **"Ação" (Central de Ações) fica de fora**: não existe ainda, é Fase 6/7.

**Decisão 2 — `search_entities` como UNION ALL, não full-text search:** cinco subconsultas independentes (`sku`, `anuncio`, `conta`, `fornecedor`, `pedido_compra`), cada uma com `ilike` sobre 1-2 colunas e `limit 5`, dentro de um `security invoker` — RLS de cada tabela já é a barreira real, `organization_id` aqui é a mesma pré-filtragem explícita já usada nos outros RPCs desta sessão. Sem `tsvector`/extensão de full-text: o catálogo é pequeno o bastante (evidência: `ilike` sobre ~2 mil SKUs já responde instantaneamente no Dev) para não justificar a complexidade extra ainda.

**Decisão 3 — componente cliente, sem debounce:** `apps/web/components/command-palette.tsx` segue o mesmo padrão já estabelecido em `apps/web/app/compras/novo/item-row.tsx` (busca a cada tecla, mínimo de 2 caracteres, sem biblioteca de debounce) — `search_entities` já limita 5 por tipo, então o payload nunca é grande o bastante para justificar debounce. `Ctrl+K`/`Cmd+K` abre; clique no botão "Buscar…" no cabeçalho também abre — dois caminhos para a mesma ação, sem exigir descoberta do atalho.

**Impacto:** migration `20260823210917_create_search_entities_rpc.sql`. `apps/web/components/command-palette.tsx` (novo), `apps/web/components/shell.tsx` ganha a busca no cabeçalho (a organização já era resolvida ali, só passou a incluir `organization_id` na seleção, sem consulta nova). **"Filtros salvos" segue como item de checklist separado, sem escopo definido ainda** — precisa de uma tabela de presets por usuário/tela e mudança em cada tela filtrada existente, feito quando houver essa etapa dedicada.

## D-061 — "Vendas perdidas estimadas" fica ADIADO — o ledger não tem entrada de saldo inicial, então não há como detectar QUANDO uma ruptura começou

**Contexto:** último pedaço pendente de "Cobertura, ruptura, vendas perdidas estimadas" (`docs/ROADMAP.md`, Fase 5B) — a Cobertura/ruptura em si (`get_stock_coverage`) já estava concluída; faltava só estimar quanto se deixou de vender durante um período de ruptura contínua. A migration de Cobertura já registrava essa lacuna: "exige detectar período de ruptura contínua, não só o instante atual".

**Desenho original considerado**: reconstruir o saldo LOCAL histórico de cada SKU a partir do ledger (`stock_movements`, `sum(qty_delta) over (partition by sku_id order by occurred_at)`), achar o movimento mais recente em que o saldo cruzou de positivo para `<= 0` e nunca mais voltou a subir (início da ruptura em curso), e multiplicar a venda média diária ANTES desse ponto pelo número de dias em ruptura dentro da janela pedida — mesmo padrão de `full outer join`/janela já usado em outros RPCs desta sessão.

**Achado, evidência medida contra o banco real (mesmo princípio de D-037/D-039/D-040/D-048/D-053/D-057/D-058/D-059)**: antes de implementar, testei a consulta de "saldo histórico" contra a organização de demonstração (backfill real da V2). Resultado: **as 2.194 SKUs com movimento LOCAL na organização estão TODAS em ruptura hoje, e NENHUMA delas jamais teve saldo LOCAL positivo em nenhum ponto do ledger** — `max(running_balance) <= 0` para 100% do catálogo. Confirmando a causa: `select movement_type, count(*) from stock_movements where location_kind='LOCAL'` devolve só `VENDA_ML` (194.988) e `CANCELAMENTO_ML` (42) — **nenhuma entrada positiva existe no ledger** (`ENTRADA_NFE` ou qualquer outra). O backfill trouxe o HISTÓRICO DE VENDAS, mas nunca um saldo inicial/de abertura por SKU.

**Consequência para o algoritmo**: "quando a ruptura começou" é matematicamente indefinido quando o ledger nunca teve um ponto positivo — a única resposta possível seria "desde o primeiro movimento já registrado", que é a data do BACKFILL, não a data real em que o estoque zerou fisicamente. Implementar mesmo assim produziria um número tecnicamente calculável mas sem significado operacional nenhum (extrapolar venda perdida "desde novembro de 2025" para um SKU cujo saldo real de abertura nunca foi importado) — pior que não mostrar nada, porque parece dado real.

**Decisão: ADIADO, não implementado.** Isto não é uma lacuna de código da V3 — é uma lacuna de COMPLETUDE DE DADO no backfill (D-037/D-040 já registraram que os backfills de histórico não terminaram). Duas saídas possíveis no futuro, nenhuma delas de responsabilidade desta etapa: (1) um saldo inicial/de abertura ser importado por SKU (uma migration de dado, não de schema — a coluna/tipo de movimento já poderia reusar `AJUSTE_MANUAL` ou um novo tipo dedicado, mas SEM o dado de origem confiável isso seria advinhar), ou (2) esperar o ledger acumular histórico orgânico suficiente em produção real (a partir do primeiro `ENTRADA_NFE`/`AJUSTE_MANUAL` de cada SKU, transições reais de positivo→zero começam a existir e o algoritmo acima passa a fazer sentido).

**Impacto:** nenhuma migration, nenhum código novo — decisão de NÃO implementar, documentada para a próxima sessão não repetir a mesma investigação. `docs/ROADMAP.md` mantém o item com a razão específica em vez de "não iniciado".

## D-062 — Filtros salvos: por USUÁRIO, jsonb genérico, escrita só via RPC — achado de GRANT no caminho

**Contexto:** metade restante de "Busca Universal / Command Palette e Filtros salvos" (D-060 separou as duas por tamanho — Busca Universal ficou pronta primeiro). Nenhum requisito formal detalha o comportamento além de "Filtros salvos" citado como recurso obrigatório (`docs/PRODUCT_REQUIREMENTS.md`).

**Decisão 1 — presets são POR USUÁRIO, não compartilhados na organização:** é preferência pessoal (cada pessoa filtra `/vendas` do jeito que faz sentido pro que ela acompanha), sem necessidade de coordenar nomes entre pessoas diferentes nem de um dono/permissão de edição compartilhada. RLS filtra só por `created_by = auth.uid()`; `organization_id` na tabela é defesa em profundidade e futura auditoria, não o mecanismo de isolamento em si.

**Decisão 2 — `params jsonb` genérico, `screen` é o PATHNAME da tela:** um preset é literalmente os query params atuais da URL (`Object.fromEntries(searchParams.entries())`), guardados como estão — sem schema próprio por tela. `screen` (ex.: `/vendas`) dobra como chave de agrupamento e como alvo de `revalidatePath`, sem precisar de um mapa tela→rota separado. Reaproveitável em qualquer tela filtrada por query string sem migration nova — só chamar o mesmo componente com um `screen` diferente.

**Decisão 3 — escrita só via RPC (`create_saved_filter`/`delete_saved_filter`, `security definer`), leitura direta sob RLS:** mesmo padrão já estabelecido no resto do app (`create_supplier`, `resolve_link_candidate`, etc.) — mutação sempre por RPC com autorização refeita dentro da função, leitura simples de tabela direto do navegador/servidor sob RLS. `create_saved_filter` faz `INSERT ... ON CONFLICT (created_by, screen, name) DO UPDATE` — salvar de novo com o mesmo nome sobrescreve em vez de duplicar, sem precisar de uma RPC de "editar" separada.

**Achado — GRANT de tabela não é tão apertado quanto os comentários de outras migrations desta sessão presumiam:** ao verificar `has_table_privilege('authenticated', 'public.saved_filters', 'INSERT')` depois de só fazer `grant select ... to authenticated`, o resultado veio `true` — privilégios padrão deste projeto Supabase concedem INSERT/UPDATE/DELETE a `authenticated` em tabela nova, mesmo sem GRANT explícito nenhum. Conferido em `stock_movements` (tabela já existente, mesmo padrão de "só RPC escreve"): o mesmo é verdade lá — `has_table_privilege('authenticated', 'public.stock_movements', 'INSERT')` também é `true`, e a única RLS policy de lá é de SELECT. **Os dados continuam seguros** (RLS sem policy de escrita bloqueia por padrão, na prática, confirmado), mas o GRANT em si nunca foi apertado — `docs/DATABASE.md` §5 descreve o GRANT como a PRIMEIRA barreira, e isso não era verdade para `authenticated` em nenhuma tabela só-RPC-escreve desta sessão. Corrigido aqui com `revoke all on public.saved_filters from anon, authenticated` antes do `grant select`; uma tarefa de auditoria foi sinalizada (`spawn_task`) para revisar as tabelas já existentes com o mesmo padrão, fora do escopo desta etapa.

**Impacto:** migration `20260823235730_create_saved_filters.sql` (tabela `saved_filters` + as duas RPCs). `apps/web/components/saved-filters.tsx` (componente cliente reaproveitável) + `saved-filters-actions.ts` (Server Actions, D-012, mesmo padrão de `apps/web/app/vinculacoes/actions.ts`). Integrado em `/vendas` nesta etapa — a tela com o filtro mais rico (período + conta); outras telas filtradas (`/curva-abc`) podem adotar o mesmo componente depois, sem mudança de schema.

## D-063 — Diagnóstico de anomalia de venda: baseline por MESMO dia da semana, |z|>=2, correlação com `domain_events` de SKU

**Contexto:** primeira peça da Fase 6 (Diagnóstico e Ações) — `docs/ARCHITECTURE.md` secao 16 já especificava o pipeline (`janela+escopo -> coleta de sinais -> baseline e desvio -> candidatos a causa correlacionados com domain_events datados -> confiança -> [IA só no fim]`) e o contrato de saída (`{evidencias[], causas_candidatas[], confianca, escopo, periodo, proximos_passos[]}`) — não foi preciso inventar a forma, só implementar contra o que já estava aprovado.

**Decisão 1 — os "três métodos aprovados" (média móvel, desvio padrão, mesmo dia da semana anterior) viram UM método só:** baseline de um SKU num dia é a média + desvio padrão de `units_sold` no MESMO dia da semana, últimas 8 ocorrências. Isso controla sazonalidade semanal automaticamente (sábado nunca compara contra terça) sem precisar reconciliar três sinais paralelos — testado contra o catálogo real antes de implementar (achados concretos: SKU `630006` vendeu 4 unidades num domingo com baseline 1.17±0.41 — anomalia real de alta; SKU `220201` vendeu 0 com baseline 2.25±0.50 — queda real).

**Decisão 2 — amostra mínima de 4 ocorrências do mesmo dia da semana:** abaixo disso o desvio padrão é ruído, não sinal — o SKU nem aparece no resultado da RPC (não é "sem anomalia", é "sem base para julgar"). Limiar de anomalia `|z| >= 2` (confiança "média") e `|z| >= 3` (confiança "alta") — convenção estatística padrão (regra empírica ~95%/~99.7%), não um número calibrado com dado real desta sessão; revisitar se a prática mostrar muito falso positivo/negativo.

**Decisão 3 — divisão SQL agrega, domínio interpreta:** `get_sku_sales_baseline` (RPC, `security invoker`) só devolve números já agregados — média, desvio, amostra, valor atual (`docs/ARCHITECTURE.md` secao 21, zero agregação em JS). A decisão "isto é anomalia? qual a direção? qual a causa?" é `diagnoseSalesAnomaly`, pura, em `@sb/domain/diagnostics` — mesma divisão de trabalho já usada em `computeLedgerIntegrityDivergences` (D-056): SQL recomputa, TypeScript decide.

**Decisão 4 — correlação com `domain_events` escopada a eventos com `entity_type='sku'`:** verificado contra o banco real quais `event_type` têm essa forma hoje — `stock.depleted`/`stock.replenished` (`entity_id` = `sku_id`, 1.043 e 33 linhas reais respectivamente). `order.cancelled`/`order.returned` têm `entity_type='order'` (seria preciso um join via `order_items` para chegar ao SKU) e os `listing.*` estão catalogados mas NUNCA emitidos (D-058) — ambos ficam de fora desta fatia, não por decisão de escopo arbitrária, mas porque a correlação direta (`entity_id` já é o `sku_id`) é o que existe e tem dado real hoje. Janela de correlação: 3 dias antes até 1 dia depois do `as_of` — não calibrada com dado real, ajustável.

**Decisão 5 — `as_of` é ONTEM, não hoje:** mesmo raciocínio de frescor já usado em `/vendas` — `daily_sku_metrics` do dia corrente ainda está incompleto.

**Impacto:** migration `20260824013329_create_sku_sales_baseline_rpc.sql`. `packages/domain/src/diagnostics/sales-anomaly.ts` (novo módulo, `diagnoseSalesAnomaly` + tipos do contrato). `apps/web/app/diagnostico/page.tsx` (novo) — busca `get_sku_sales_baseline`, roda `diagnoseSalesAnomaly` em duas passadas (uma sem eventos para achar quais SKUs são anomalia, uma segunda só para esses SKUs já com os `domain_events` correlacionados — evita N+1). **"Central de Ações" (persistir o diagnóstico como item acionável) e "Decisões com `baseline_snapshot`" ficam para as próximas fatias da Fase 6** — dependem desta peça existir primeiro, é a ordem natural do checklist da própria fase.

## D-064 — Central de Ações: severidade espelha confiança, worker escreve direto (sem RPC), impacto é `|Δunidades| x preço médio`

**Contexto:** segunda peça da Fase 6 (Diagnóstico e Ações) — persistir o diagnóstico de [[D-063]] como item acionável em `docs/DATABASE.md` §4 `actions`, já desenhada desde a Fase 0. `docs/ARCHITECTURE.md` secao 16: "problema e oportunidade são o mesmo objeto com sinal invertido" (uma tabela só) e "priorização por impacto financeiro x urgência x confiança, nunca por contagem de alerta" (a V2 chegou a 5.243 alertas abertos).

**Decisão 1 — severidade espelha confiança nesta primeira fatia:** `severity = confidence` (`media`/`alta`). Não há ainda base evidencial para um limiar de severidade por valor em R$ — diferente do z-score de [[D-063]], que é convenção estatística padrão, um corte em R$ seria inventado sem dado. Revisitar quando houver histórico de `estimated_impact_brl` real para calibrar.

**Decisão 2 — impacto estimado é `|unitsDelta| x preço médio`:** `unitsDelta = currentUnitsSold - baselineMean` (novo campo em `SalesAnomalyDiagnosis`, `packages/domain/src/diagnostics/sales-anomaly.ts`) multiplicado pelo preço médio do SKU (`get_sku_average_prices`, janela de 30 dias terminando em `as_of` — mais larga que a janela de correlação de eventos de [[D-063]], de propósito: aqui o objetivo é um preço representativo, não um instante). `estimateImpactBrl` é uma função pura SEPARADA de `diagnoseSalesAnomaly`, chamada depois: preço só é buscado para os SKUs já confirmados como anomalia (evita N+1 no catálogo inteiro), mesma divisão de trabalho (SQL agrega, TypeScript decide) de [[D-063]]/D-056. Sem preço médio no período, o impacto é `null`, nunca `0` — impacto desconhecido é diferente de impacto zero.

**Decisão 3 — o worker escreve direto em `actions` via `service_role`, sem RPC:** mesmo padrão de `recordDomainEvents` — o worker já é confiável (a pergunta é "esta organização existe?", não "este usuário tem permissão?"). `update_action_status` (RPC `security definer`) existe para o navegador mudar status/assignee sob autorização de organização, não para o próprio backend gravar o diagnóstico. `ON CONFLICT (organization_id, dedup_key) DO UPDATE` com `dedup_key = "sales_anomaly:{sku_id}:{as_of}"` reprocessa o mesmo dia sem duplicar — e como `status`/`assignee_id` ficam DE FORA do payload do upsert, reprocessar não reabre nem desatribui uma ação que um humano já moveu (verificado manualmente contra o Dev antes de escrever o job: reinserir a mesma `dedup_key` com impacto diferente atualiza a mesma linha e preserva `status`).

**Decisão 4 — GRANT explícito para `authenticated` desde a criação, mesmo achado de [[D-062]]:** `revoke all on public.actions from anon, authenticated` antes de `grant select` — o padrão deste projeto Supabase concede INSERT/UPDATE/DELETE por padrão a `authenticated` em tabela nova, não só a `anon`.

**Impacto:** migration `20260824014953_create_actions.sql` (tabela `actions`, RLS select-only, `update_action_status`, `get_sku_average_prices`). `packages/domain/src/diagnostics/sales-anomaly.ts` (`unitsDelta` no contrato, `estimateImpactBrl`). `apps/worker/src/handlers/detect-sales-anomaly-actions.ts` (job `diagnostics.detect-sales-anomalies`, por ORGANIZAÇÃO — SKU é organizacional, D-006). `apps/api/src/sales-anomaly-actions-schedule.ts` + `/internal/schedule/sales-anomaly-actions`, cadência diária (`infra/cloud-scheduler.sh`, depois de `ledger-integrity`/`listing-visits` — sem urgência de horário, `daily_sku_metrics`/`domain_events` de ontem já estão completos a qualquer hora do dia seguinte). `apps/web/app/acoes/` (nova tela, Server Actions `claimAction`/`resolveAction`/`dismissAction`, só itens abertos, ordenado por impacto). **"Decisões com `baseline_snapshot` e medição posterior em 7/15/30 dias" fica para a próxima fatia da Fase 6** — depende de `actions` existir primeiro.

## D-065 — Memória de decisões: mesma função de snapshot para baseline e outcome, medição histórica fixa, ação sem SKU não bloqueia

**Contexto:** terceira e última peça da Fase 6 (Diagnóstico e Ações) — fecha o Marco da fase ("o sistema responde 'por quê', com evidência e nível de confiança"). `docs/PROMPT_MASTER.md` secao 29: "registrar decisões importantes realizadas a partir de diagnóstico/ação e depois permitir medir o resultado" — problema, decisão, responsável, data, mudança aplicada, resultado 7/15/30 dias depois. `docs/ARCHITECTURE.md` secao 16: "capturar o `baseline_snapshot` no momento da decisão é o que torna a medição posterior possível — sem ele, comparar depois é impossível."

**Decisão 1 — uma função SQL só para baseline e outcome, `get_sku_decision_snapshot(organization_id, sku_id, as_of)`:** o baseline (na hora da decisão) e cada outcome (7/15/30 dias depois) são o MESMO cálculo em datas diferentes — só muda `as_of`. Uma função `security invoker` evita duas implementações divergindo silenciosamente. Devolve `jsonb` (não uma tabela) porque o resultado é armazenado direto na coluna `baseline_snapshot`/`outcome_snapshot`, sem transformação no meio.

**Decisão 2 — `avg_price_7d` é receita/unidades no período (preço PONDERADO), não média de médias diárias:** mesmo raciocínio já usado em `average_selling_price` gerada (`docs/DATABASE.md` secao 3) — média de médias distorce quando o volume diário varia. `null` quando não há venda no período, nunca `0` — impacto desconhecido é diferente de impacto zero, mesmo raciocínio de [[D-064]] decisão 2.

**Decisão 3 — medição histórica FIXA, nunca recalculada:** `unique (action_decision_id, window_days)` + upsert com `ignoreDuplicates` no job `diagnostics.measure-decision-outcomes`. Uma vez que a janela de 7 dias foi medida, ela representa "o resultado 7 dias depois" PARA SEMPRE — recalcular depois (por exemplo, se o job reprocessar) mudaria a história e invalidaria qualquer comparação já vista. `computePendingOutcomeWindows` (pura, `packages/domain/src/diagnostics/decision-outcomes.ts`) decide quais janelas já amadureceram (idade em dias corridos >= janela) e ainda não foram medidas — mesma divisão SQL-agrega/TS-decide de [[D-063]]/[[D-064]].

**Decisão 4 — ação sem `sku_id` grava snapshot vazio (`{}`), não bloqueia a decisão:** o schema de `actions` permite `sku_id` nulo (embora hoje toda ação venha de anomalia de venda por SKU, [[D-063]]) — sem SKU não há o que fotografar, mas registrar a decisão sem medição numérica ainda é mais útil que impedir o registro. `create_action_decision` e o job do worker tratam esse caso do mesmo jeito.

**Decisão 5 — cadência diária, 30 minutos depois de `detect-sales-anomalies` (8h30):** só precisa rodar depois que as decisões do dia já foram tomadas por humanos, sem vantagem em rodar mais cedo — mesmo raciocínio de escalonamento de horário de todos os jobs de manutenção (`infra/cloud-scheduler.sh`).

**Achado no caminho — deploy de produção estava 36 commits atrasado:** ao verificar visualmente o trabalho da sessão anterior antes de começar esta peça, medi via `gcloud` (não presumi da documentação) que `worker`/`api` em produção rodavam código de 2026-08-22 e 5 jobs do Cloud Scheduler documentados como "rodando" nunca tinham sido criados de fato — nem `v3-detect-sales-anomalies` existia. Corrigido (deploy + criação dos jobs + 2 bugs de teste no CI que bloqueavam o deploy + 1 bug real de produção em `reconcile-balances`, URL longa demais contra o catálogo real) antes de começar esta peça — ver header do `docs/HANDOFF.md` para o relato completo.

**Impacto:** migration `20260824123358_create_action_decisions.sql` (`action_decisions`, `action_outcomes`, `get_sku_decision_snapshot`, `create_action_decision`). `packages/domain/src/diagnostics/decision-outcomes.ts` (`computePendingOutcomeWindows`, pura). `apps/worker/src/handlers/measure-decision-outcomes.ts` (job `diagnostics.measure-decision-outcomes`, por ORGANIZAÇÃO). `apps/api/src/decision-outcomes-schedule.ts` + `/internal/schedule/decision-outcomes`, cadência diária às 8h30 (`infra/cloud-scheduler.sh`). `apps/web/app/acoes/` ganhou `registerDecision` (Server Action) e exibição de decisões/outcomes por ação — comparação bruta lado a lado, nunca uma % sintetizada (mesmo raciocínio de `/vendas`). **Fecha o checklist inteiro da Fase 6.**

## D-066 — Auditoria de GRANTs de tabelas antigas (item P0 do Checkpoint pré-Fase 7): 23 tabelas com INSERT/UPDATE/DELETE revogado de `authenticated`

**Contexto:** [[D-062]] descobriu que toda tabela nova neste projeto Supabase nasce com INSERT/UPDATE/DELETE concedido a `authenticated` por padrão, mesmo sem GRANT explícito — corrigido ali só em `saved_filters` (a tabela que disparou o achado), com a auditoria das tabelas mais antigas sinalizada e adiada. O Checkpoint de Consolidação pré-Fase 7 (`docs/ROADMAP.md`, escrito por outra sessão em paralelo a esta) listou essa auditoria como item P0. Medido contra o Dev real (`has_table_privilege`) antes de escrever qualquer migration — não presumido das migrations.

**Achado:** das 37 tabelas do schema, 23 (criadas entre 2026-08-20 e 2026-08-22, todas ANTERIORES a D-062) tinham `auth_insert=true, auth_update=true, auth_delete=true` — `daily_listing_visits`, `listings`, `suppliers`, `purchase_orders`, `purchase_order_items`, `purchase_order_events`, `fulfillment_stock_snapshots`, `documents`, `document_items`, `stock_movements`, `inventory_balances`, `domain_events`, `orders`, `order_items`, `sync_runs`, `sync_errors`, `link_candidates`, `erp_import_batches`, `erp_import_rows`, `erp_stock_snapshots`, `skus`, `sku_components`, `organizations`. Nenhuma delas tinha policy de escrita para `authenticated` (confirmado em `pg_policies` antes de tocar em GRANT) — a RLS negava por padrão sem policy correspondente, então os dados nunca estiveram expostos. É aperto de superfície, não correção de vazamento: uma policy de escrita adicionada por engano no futuro, sem revisar o GRANT, viraria brecha real na hora.

**Decisão — excluir tabelas com escrita legítima direta por `authenticated`:** `ml_accounts`, `organization_members`, `profiles`, `sku_listing_links`, `user_account_permissions` têm policy `ALL`/`UPDATE` para `authenticated` de propósito (ADMIN gerencia conta/papel, usuário edita o próprio perfil, vínculo SKU↔anúncio é editado direto) — confirmado em `pg_policies` antes de decidir a lista final, para não revogar GRANT que o produto usa de verdade.

**Verificação:** sintaxe e efeito testados numa transação `begin/rollback` contra o Dev real antes de aplicar (`has_table_privilege` mostrou `auth_select=true, auth_insert=false` para as 23, depois do rollback voltou ao estado anterior). Aplicada de vez via `supabase db push`, reconfirmada fora de transação. RPCs `security definer` (o único caminho de escrita real dessas tabelas) não são afetadas por GRANT do chamador — rodam com o privilégio do dono da função, garantia estrutural do Postgres, não do `authenticated` que chama — confirmado pelos testes de integração existentes que exercitam escrita via RPC nessas tabelas, sem escrita de teste ao vivo em produção (evitar rastro desnecessário em tabelas append-only).

**Impacto:** migration `20260824132723_revoke_excess_authenticated_grants.sql`. Fecha o item "Revisar GRANTs das tabelas antigas de escrita exclusiva por RPC/service_role" do Checkpoint pré-Fase 7.

## D-067 — Auditoria de erro `.error` do Supabase client não abortado (item P0 do Checkpoint pré-Fase 7): 34 pontos achados, corrigidos os que arriscavam corromper dado de negócio

**Contexto:** item P0 do Checkpoint de Consolidação pré-Fase 7 (`docs/ROADMAP.md`): "corrigir pontos conhecidos onde `.error` do Supabase client não é explicitamente abortado antes de continuar a operação." Levantamento sistemático via agente de busca em `apps/web/app/**`, `apps/web/components/**`, `apps/web/lib/**`, `apps/api/src/**`, `apps/worker/src/handlers/**` — 74 arquivos que chamam `.from()`/`.rpc()`.

**Achado:** 34 pontos reais (agrupando padrões repetidos), quase todos concentrados fora de `apps/api/src` (que já checa erro em 100% dos casos). Priorizados em três níveis por impacto real:

- **Nível 1 — corrupção de dado de negócio (corrigido nesta etapa):** `apps/worker/src/handlers/persist-order.ts` (4 pontos: status anterior da order, `stock_movements` de uma reversão de cancelamento, resolução de `sku_listing_links`, `kind`/componentes de um KIT) e `claim-return.ts` (2 pontos: `stock_movements`/`order_items` de uma devolução) — uma falha de LEITURA nessas consultas, sem checagem, era indistinguível de "nada encontrado"/"lista vazia", e cada uma delas alimenta diretamente uma decisão de estoque: dedução pulada (overselling), reversão de cancelamento/devolução computada contra zero movimentos (estoque nunca creditado de volta), KIT tratado como PRODUTO sem componentes (componentes nunca deduzidos). `apps/web/app/compras/[id]/editar/page.tsx` (falha ao ler itens virava formulário com UM item em branco — salvar chama `update_purchase_order_draft`, que SUBSTITUI todos os itens, apagando os reais), `apps/web/app/compras/[id]/export/load.ts` (PDF/XLSX gerado com "0 itens" silenciosamente — documento que pode ir a um fornecedor), `apps/web/app/compras/[id]/page.tsx` (resumo do topo mostrava "0 itens, R$ 0,00" indistinguível de pedido vazio de verdade).
- **Nível 2 — UI enganosa em tela de decisão, sem escrita de dado errado:** `/vendas`, `/anuncios`, `/diagnostico`, `/acoes`, `/sincronizacao`, mais dois pontos em `apps/worker/src/handlers/sync-runs.ts` e três em `ml-*-fetch.ts` (falha de leitura reportada como sync bem-sucedida de 0 itens). **Adiado para uma próxima etapa** — real, mas não corrompe dado, só mostra "sem dado" em vez de "erro ao carregar".
- **Nível 3 — baixo impacto (busca client-side, dropdown, membership lookup):** 11 pontos, mesmo padrão repetido (`error` não desestruturado numa busca por texto). **Adiado** — degrada para "nada encontrado", já é o comportamento visível de uma busca vazia de verdade.

**Decisão — corrigir Nível 1 primeiro, nesta etapa; Níveis 2 e 3 ficam registrados para depois:** escopo de uma sessão não é infinito, e o critério de priorização do próprio produto (`docs/ARCHITECTURE.md`) é sempre corrigir o que decide errado antes do que só informa errado. `throw new Error(...)` nos handlers do worker (mesmo padrão de erro por exceção — `app.ts` do worker já converte qualquer exceção não capturada em `{status: "failed", retryable: true}`, `toOutcome`); retorno `null`/mensagem de erro explícita nas páginas/rotas do `web`, nunca um "0" ou lista vazia que pareça dado real.

**Impacto:** `apps/worker/src/handlers/persist-order.ts`, `persist-order.test.ts` (+5 testes), `claim-return.ts`, `claim-return.test.ts` (+2 testes). `apps/web/app/compras/[id]/editar/page.tsx`, `apps/web/app/compras/[id]/export/load.ts`, `apps/web/app/compras/[id]/page.tsx`.

**Atualização, mesma sessão: Nível 2 fechado.** Os 10 pontos de "UI enganosa em tela de decisão" (achados #10–19 do levantamento original) foram corrigidos:

- **Worker**: `sync-runs.ts` (`recordSyncRunSuccess`/`recordSyncRunFailure` ganharam um `Logger` — falha ao gravar `sync_runs`/`sync_errors` agora é LOGADA, nunca lançada: é observabilidade da sincronização, não o resultado dela, então abortar um job cuja sincronização já terminou só porque o LOG falhou trocaria um problema pequeno por um maior; 15 pontos de chamada atualizados). `ml-listings-fetch.ts`/`ml-listing-visits-fetch.ts`/`ml-fulfillment-fetch.ts` (falha ao ler `sku_listing_links` agora lança — sem isso virava "done, 0 processados", indistinguível de conta sem anúncio vinculado; o `try/catch` que já existia em cada `sync-*-snapshot.ts` chamador converte em falha de verdade). `sync-orders-window.ts` (`resolveWindowFrom`: falha ao ler o checkpoint agora lança, em vez de cair no fallback de janela larga — reprocessar mais que o necessário é pior que um retry).
- **Web**: `/vendas`, `/anuncios`, `/diagnostico`, `/acoes` — erro de uma query secundária (comparação de período, série diária, vendas/tráfego por anúncio, correlação de eventos, decisões/outcomes) agora se junta ao erro principal da página via `??`, em vez de description degradar silenciosamente pra "sem dado". `/sincronizacao` ganhou `healthCheckError` em `AccountHealth` — falha ao MEDIR frescor/contagem de erro não vira mais "Nunca sincronizado"/"0 erro(s)" (o oposto do que uma tela de saúde deveria fazer), mostra um alerta explícito.

**Impacto (Nível 2):** `apps/worker/src/handlers/sync-runs.ts`+`sync-runs.test.ts` (novo), `ml-listings-fetch.ts`+test, `ml-listing-visits-fetch.ts`+test, `ml-fulfillment-fetch.ts`+test, `sync-orders-window.ts`+test, `backfill-orders.ts`, `sync-listings-snapshot.ts`, `sync-listing-visits-snapshot.ts`, `sync-fulfillment-snapshot.ts`. `apps/web/app/vendas/page.tsx`, `apps/web/app/anuncios/page.tsx`, `apps/web/app/diagnostico/page.tsx`, `apps/web/app/acoes/page.tsx`, `apps/web/app/sincronizacao/page.tsx`.

**Atualização, mesma sessão: Nível 3 fechado — os 34 pontos do levantamento original estão todos corrigidos.** Duas famílias de achado, mesmo padrão em cada:

- **Busca por texto sem `error` desestruturado** (`document-item-row.tsx`, `item-row.tsx`, `candidate-row.tsx`, `command-palette.tsx`): falha de rede/RLS virava "nada encontrado", indistinguível de busca genuinamente vazia. Corrigido desestruturando `error` e mostrando uma mensagem curta ("Não foi possível buscar — tente de novo") só quando a busca falha de verdade, nunca quando só não achou nada.
- **`membership.error`/`organization_id === null` tratados como o mesmo caso** (`shell.tsx`, `curva-abc/page.tsx`, `diagnostico/page.tsx`, `contas/actions.ts`, `estoque/actions.ts`, `compras/actions.ts`): a mensagem "Sua conta não está associada a nenhuma organização" é sobre CADASTRO — mostrá-la numa falha de leitura transitória confunde o usuário sobre o que está errado de verdade. `shell.tsx` roda em TODA página autenticada — em vez de um banner grande e intrusivo (a falha aqui só desliga a busca e o rótulo de papel, não impede o resto da tela), ganhou um ⚠ pequeno com `title` explicando, ao lado do e-mail no cabeçalho.

**Impacto (Nível 3):** `apps/web/app/notas-fiscais/[id]/document-item-row.tsx`, `apps/web/app/compras/novo/item-row.tsx`, `apps/web/app/vinculacoes/candidate-row.tsx`, `apps/web/components/command-palette.tsx`, `apps/web/components/shell.tsx`, `apps/web/app/compras/novo/page.tsx`, `apps/web/app/compras/[id]/editar/page.tsx`, `apps/web/app/estoque/[skuId]/ajuste/page.tsx`, `apps/web/app/curva-abc/page.tsx`, `apps/web/app/diagnostico/page.tsx`, `apps/web/app/contas/actions.ts`, `apps/web/app/estoque/actions.ts`, `apps/web/app/compras/actions.ts`. **Fecha o item do Checkpoint pré-Fase 7 por completo.**

## D-068 — Navegação do Shell agrupada por categoria (item P1 do Checkpoint pré-Fase 7); colapso do dropdown virou regra CSS explícita, não UA stylesheet implícita

**Contexto:** pedido explícito do usuário (2026-08-24): a barra de navegação tinha 14 links soltos no mesmo nível, "fica muita bagunça" conforme mais telas nascem. Forneceu a estrutura alvo completa: VISÃO GERAL solto, depois COMERCIAL/ESTOQUE/INTELIGÊNCIA/GESTÃO/ADMINISTRAÇÃO como grupos — com instrução permanente de que toda tela nova entra no grupo certo daqui pra frente, nunca solta no nível de cima. Fecha também o item P1 do Checkpoint pré-Fase 7 "Reorganizar a navegação em grupos, evitando todas as telas no mesmo nível".

**Decisão — `<details>`/`<summary>` nativo, não componente client:** `Shell` (`apps/web/components/shell.tsx`) é Server Component assíncrono (lê `auth.getUser()` e `organization_members` direto do Supabase). Um dropdown client exigiria ou converter `Shell` inteiro pra client (perdendo a leitura direta) ou extrair um sub-componente client só pra isso. `<details>`/`<summary>` dá o mesmo resultado sem JS e sem fronteira client nova.

**Decisão — ADMINISTRAÇÃO e "Produtos" ficam de fora até existirem:** a lista do usuário incluía 5 telas de ADMINISTRAÇÃO e uma tela "Produtos" (catálogo de SKU como listagem própria, distinta de `/skus/{id}`) que ainda não existem. Um grupo vazio não serve pra nada — omitido, não stubado, com a regra documentada em JSDoc no topo do arquivo para quem construir essas telas depois. "Importações" (UpSeller) não estava na lista do usuário mas já existe e funciona — mantida em ESTOQUE por ser fluxo de catálogo/saldo; retirá-la seria regressão silenciosa de algo que já funciona.

**Achado durante a verificação visual — colapso do `<details>` não pode depender só da UA stylesheet:** ao testar no navegador de automação desta sessão, o conteúdo do dropdown (`<div>` com os links) tinha `display: block` mesmo com `open: false` no `<details>` — a regra padrão `details:not([open]) > *:not(summary) { display: none }` que todo navegador real implementa não estava sendo aplicada nesse ambiente específico. Verificado por `getComputedStyle` antes/depois de alternar `.open` programaticamente: o toggle em si funcionava (`.click()` no `<summary>` mudava `open` corretamente e o `read_page` refletia o grupo aberto), só o CSS implícito de colapso é que não podia ser assumido.

**Decisão — regra CSS autoral explícita em vez de confiar no default do navegador:** `apps/web/app/globals.css` ganhou `.sb-nav-group[open] > .sb-nav-group-menu { display: block }` / `.sb-nav-group > .sb-nav-group-menu { display: none }` por padrão, com as classes aplicadas em `shell.tsx`. Custo zero, remove qualquer dependência de comportamento implícito de motor de renderização, e o resultado passou a ser diretamente testável via `getComputedStyle` (confirmado: fechado = `display:none` e rect zerado, aberto = `display:block` com posição correta sob o `summary`).

**Nota sobre a ferramenta de automação usada para verificar:** o clique sintético do `computer` tool não disparava o toggle nativo do `<summary>` mesmo acertando as coordenadas certas (confirmado via `elementFromPoint`), mas `.click()` chamado no próprio contexto da página funcionava e o estado persistia. Interpretado como limitação do dispatcher de clique sintético desse ambiente sandbox com elementos de formulário nativos (categoria conhecida de quirk em automação de navegador), não como defeito do código — clique real de mouse/toque/teclado em navegador real usa exatamente o caminho de evento confiável que já foi confirmado funcionando.

**Impacto:** `apps/web/components/shell.tsx` (`NAV_GROUPS`, `NavGroupDropdown`, JSDoc com a regra permanente de onde entram telas novas). `apps/web/app/globals.css` (`.sb-nav-group`/`.sb-nav-group-menu`). Commit `e1ea084`. Fecha o item "Reorganizar a navegação em grupos" do Checkpoint pré-Fase 7 (ver D-067 para os outros itens do mesmo checkpoint fechados nesta sessão).

## D-069 — Playwright nos fluxos críticos (item P0 do Checkpoint pré-Fase 7 e da Fase 5B): login, página do produto, conferência de NF-e, pedido de compra

**Contexto:** `docs/TESTING.md` definia o escopo desde a Fase 1 ("E2E | Playwright | Login, página do produto, conferência de NF-e, pedido de compra | Fase 5") mas nunca tinha sido implementado — item registrado tanto no checklist da Fase 5B quanto no P0 do Checkpoint pré-Fase 7. Sem Docker disponível nesta máquina, `supabase start` não roda localmente — a implementação inteira foi escrita, tipada e lintada sem poder ser executada de ponta a ponta antes do push; a CI (que roda em runner com Docker) foi o verificador real, exatamente como já acontecia com os testes de integração de RLS.

**Decisão — seed mínimo, sem depender de dado pré-existente:** `apps/web/e2e/seed.ts` cria, via `service_role` contra o Supabase **local** (nunca Dev/produção — checagem explícita de env no início do script), o mínimo para os quatro fluxos: uma organização, um usuário ADMIN com senha fixa, um SKU com saldo LOCAL (`stock_movements`, ENTRADA_NFE de 50 unidades — a mesma projeção por trigger que alimenta `inventory_balances`, nunca somada em JS) e uma NF-e (`documents`/`document_items`) em PARSED com um item sem vínculo. "Pedido de compra" não precisou de seed: o formulário de `/compras/novo` aceita SKU em texto livre sem cadastro prévio (mesmo padrão de `document_items` — vínculo pendente é informação, não bloqueio), então o próprio teste cria um pedido do zero pela UI, cobrindo o caminho mais comum na prática.

**Decisão — 1 worker, sem paralelismo:** a suíte inteira compartilha a mesma organização/usuário seedados, e o spec de conferência de NF-e MUTA estado real (vincula um item). Rodar em paralelo arriscaria uma corrida entre testes, não entre features — desnecessário para 4 specs (`docs/TESTING.md` seção 3: "E2E amplo é caro de manter e frágil").

**Decisão — "Confirmar aplicação" da NF-e fica de fora:** aquele botão chama `apps/api` (`POST /v1/nfe-imports/:id/apply`), que enfileira em Cloud Tasks para o `apps/worker` processar. Essa infraestrutura não existe no Supabase local da esteira, e simulá-la (mock de Cloud Tasks, subir `apps/api`/`apps/worker` na CI só para isso) inflaria a suíte muito além do que os "fluxos críticos" pedem. O vínculo humano de item por SKU (`link_document_item`, RPC de verdade) já é o núcleo da tela de conferência.

**Achado no caminho — dois bugs de teste, não de produto, só visíveis na CI real:**

1. **Vitest coletava os specs do Playwright por engano.** Ambos usam `*.spec.ts` por padrão; `pnpm run test` (Vitest) importava os arquivos do Playwright, chamava `@playwright/test` fora do runner dele, e quebrava com "Playwright Test did not expect test() to be called here". Corrigido excluindo `e2e/**` do glob do Vitest em `apps/web/package.json`.
2. **`pnpm --filter web run build` pula o grafo do Turborepo.** Chama `next build` direto, sem construir `@sb/domain`/`@sb/db` primeiro — todo build falhava com "Module not found: Can't resolve '@sb/domain'". Corrigido trocando para `pnpm run build` (raiz), o mesmo comando que o job "check" já usava com sucesso.

Também achado, sem virar bug: os nomes de variável do `supabase status -o env` (`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`) não estão documentados em lugar nenhum do repositório — funcionaram de primeira, mas só a CI provou isso; `eval "$(pnpm exec supabase status -o env)"` seguido de remapeamento explícito para `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SERVICE_ROLE_KEY` no `$GITHUB_ENV` evita hardcodar as chaves de demonstração do Supabase CLI (que mudariam de formato sem aviso, como já mudou de anon/service_role JWT para publishable/secret).

**Verificação:** CI real, job "e2e" (`.github/workflows/ci.yml`) — sobe Supabase local, builda `apps/web` com as variáveis locais (embutidas no build, não em runtime — por isso o build acontece DEPOIS do Supabase local subir, nunca antes), roda o seed, roda os 5 testes contra `next start`. `migrations` no Supabase Dev passou a exigir esse job verde também (`needs: [check, scripts, integration, e2e]`), mesmo raciocínio de "nenhum deploy sem CI verde" já usado pelos outros jobs.

**Impacto:** `apps/web/playwright.config.ts` (novo), `apps/web/e2e/{seed,seed-output,constants,helpers}.ts` (novo), `apps/web/e2e/{login,sku-dashboard,nota-fiscal,pedido-compra}.spec.ts` (novo, 5 testes). `apps/web/package.json` (`@playwright/test`, `tsx`, scripts `e2e`/`e2e:seed`, exclusão do Vitest). `.github/workflows/ci.yml` (job `e2e`, `migrations` ganha nova dependência). Commits `4276bb0`, `a0b0694`, `56c60cd`. Fecha o item "Playwright nos fluxos críticos" do Checkpoint pré-Fase 7 e da Fase 5B.

## D-070 — Auditoria dos serviços implantados contra a infraestrutura real (item P0 do Checkpoint pré-Fase 7): tudo em dia

**Contexto:** item P0 do Checkpoint de Consolidação pré-Fase 7: "auditar os serviços implantados contra a infraestrutura real antes de declarar deploy concluído: Web, API, Worker, migrations e Cloud Scheduler." Existe justamente porque, no início desta sessão (ver header do `docs/HANDOFF.md`), a documentação afirmava deploy em dia enquanto `worker`/`api` reais estavam 36 commits atrasados e 5 jobs do Cloud Scheduler documentados como "rodando" nunca tinham sido criados — a regra "documentação não comprova deploy" nasceu desse incidente. Esta auditoria é a primeira verificação completa e deliberada desde a correção daquele incidente.

**Método — medir, nunca presumir:**

- **Web**: `vercel project ls`/`vercel ls`/`vercel inspect` contra o projeto real. Achado no caminho: o projeto Vercel certo se chama `speedbikers-gestao-v2-m71j` (não `speedbikers-gestao-v2`, que é a V2 antiga — `Root Directory: .`, criado 07/08, sem relação com este monorepo). O nome confuso vem de uma colisão de nome na criação (20/08): "speedbikers-gestao-v2" já estava em uso pelo projeto da V2, e a Vercel autogerou o sufixo "-m71j". Confirmado como o projeto certo por três sinais: `Root Directory: apps/web` (só faz sentido para o monorepo da V3), alias `-git-v3-` (rastreia a branch certa), e os 4 deploys de produção mais recentes batendo em minutos com os 4 commits desta sessão.
- **API/Worker**: `gcloud run services describe`/`revisions describe` para pegar a revisão real em produção (`api-00013-n55`, `worker-00018-26q`), depois `git log <commit-da-revisao>..HEAD -- apps/api` (e `-- apps/worker`) para confirmar que NENHUM commit tocou esses diretórios desde o último deploy — zero output em ambos, ou seja, nada para deployar.
- **Migrations**: `pnpm exec supabase migration list --linked` contra o Supabase Dev real — 43 pares `local`/`remote`, todos batendo, nenhum órfão de nenhum dos dois lados.
- **Cloud Scheduler**: `gcloud scheduler jobs list` comparado com a lista de 9 jobs esperada em `infra/cloud-scheduler.sh` (`v3-heartbeat`, `v3-reconcile-orders`, `v3-fulfillment-snapshot`, `v3-reconcile-balances`, `v3-verify-ledger-integrity`, `v3-listings-snapshot`, `v3-listing-visits-snapshot`, `v3-detect-sales-anomalies`, `v3-measure-decision-outcomes`) — todos os 9 existem, `ENABLED`, todos com `lastAttemptTime` de hoje (2026-08-24) e sem `status.code` de erro (Cloud Scheduler só popula esse campo em falha).

**Achado no caminho, sem virar ação — `sync.listing-visits.snapshot` bateu rate limit do Mercado Livre:** `gcloud logging read` contra `severity>=ERROR` do dia mostrou `job_failed` repetido para esse job type, `reason: "Mercado Livre respondeu 429 para GET /items/.../visits/time_window"`, `retryable: true`. Todas as ocorrências são de revisões ANTERIORES às desta sessão (`worker-00014-zvj`, `worker-00015-cmd`) — não é um achado novo, é a confirmação concreta do item já registrado como pendente ("confirmar `sync.listing-visits.snapshot` com dado real e cadência normal"). Cron é diário (`0 7 * * *`); só dá pra saber se persiste no ciclo de amanhã, 2026-08-25.

**Achado no caminho, descartado pelo próprio usuário:** log de `api` mostrou `ml_account_not_connected` às 16:51 de hoje, causa real `duplicate key value violates unique constraint "ml_accounts_org_seller_unique"` (`ml_accounts_org_seller_unique on (organization_id, seller_id) where seller_id is not null` — um seller do Mercado Livre só pode estar vinculado a UMA linha de `ml_accounts` por organização). Investigado o código (`apps/api/src/ml-accounts.ts:225-244`): a violação de constraint pós-OAuth cai no mesmo `if` genérico de "linha não encontrada", produzindo uma mensagem de erro que não distingue os dois casos. Perguntado ao usuário antes de qualquer ação (o erro era de ~30 min atrás, podia estar bloqueando trabalho em andamento) — resposta: foi ele mesmo, tentou conectar a conta "SB" estando no contexto da organização "Speed Bikers" por engano, comportamento esperado do sistema (a constraint fez o trabalho certo), só a mensagem de erro que poderia ser mais clara. Descartado a pedido explícito ("pode desconsiderar") — não virou tarefa.

**Impacto:** nenhuma mudança de código — auditoria confirmou que não havia nada para corrigir. `docs/ROADMAP.md` (item do Checkpoint pré-Fase 7 marcado concluído). Fecha o item "Auditar os serviços implantados" do Checkpoint pré-Fase 7 — restam só os dois itens que dependem de tempo passar (ciclo natural de 2026-08-25).

## D-071 — Central de Atendimento/SAC Mercado Livre vira Fase 7B; Copiloto sugere texto, nunca envia; Base de Conhecimento é SQL, não RAG

**Contexto:** pedido explícito do usuário (2026-08-24) para planejar uma Central de Atendimento/SAC integrada às contas Mercado Livre — caixa de entrada unificada (perguntas, mensagens, reclamações, devoluções, mediações), notificações de atendimento reaproveitando a Fase 7, Copiloto sugerindo respostas, Base de Conhecimento Validada por aprendizado operacional confirmado por humano, métricas, integração com Diagnóstico e Central de Ações. Tarefa deliberadamente só documental — sem código, sem migration, sem infraestrutura — com aprovação do usuário exigida antes de qualquer edição, protocolo seguido à risca (proposta apresentada em 8 pontos, aprovada, só então os arquivos foram tocados). Lidos os treze documentos-fonte (`README.md`, `AGENTS.md`, `docs/PROMPT_MASTER.md`, `docs/HANDOFF.md`, `docs/ROADMAP.md`, `docs/PRODUCT_REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/NOTIFICATIONS.md`, `docs/COPILOT.md`, `docs/MERCADO_LIVRE.md`, `docs/DECISIONS.md`) antes de propor qualquer mudança.

**Decisão 1 — Fase 7B, não item de checklist da Fase 7:** o pedido usa explicitamente a arquitetura de notificações e o Copiloto já aprovados na Fase 7 ("aproveitar a arquitetura... já planejada na Fase 7") — não pode vir antes dela. E é grande demais para ser um item dentro da Fase 7: domínio novo (`support`), integração ML nova em boa parte (Perguntas/Mensagens nunca pesquisadas; Claims/Returns/Mediações já confirmado, D-057), caso de uso novo do Copiloto, e uma feature sem precedente direto (Base de Conhecimento Validada). Mesmo padrão já usado pela Fase 5A/5B (D-033): refinamento sem renumeração, explicitamente autorizado pela própria nota no topo do `docs/ROADMAP.md` ("As fases... foram refinadas com entregáveis e marcos, não renumeradas"). `docs/ROADMAP.md` ganha a seção "Fase 7B" entre a Fase 7 e a Fase 8, e a "ordem de execução" passa a `0 -> 1 -> 2 -> 3 -> 5A -> 4 -> 5B -> 6 -> 7 -> 7B -> 8`.

**Decisão 2 — "Copiloto sugerindo respostas" NÃO é ferramenta de escrita:** `docs/COPILOT.md` seção 1/6 proíbe isso explicitamente ("Copiloto lê e explica; não executa ações", "sem ferramenta de escrita... não será cruzada sem decisão explícita registrada em `docs/DECISIONS.md`"). Essa é a decisão explícita: a sugestão de resposta é **geração de texto**, mesma categoria já aprovada de "estruturar ideia de feature" (`docs/COPILOT.md` seção 4, "Estruturação") — o Copiloto nunca chama uma tool que envia mensagem ao Mercado Livre. O envio em si é um **comando privilegiado** distinto, executado por `apps/api` só depois de confirmação humana explícita — mesmo padrão já usado por "confirmar NF-e"/"aprovar pedido de compra" (`docs/API.md` seção 2). Fluxo registrado em `docs/COPILOT.md` seção 11 e `docs/PRODUCT_REQUIREMENTS.md`.

**Decisão 3 — Base de Conhecimento Validada é tabela relacional consultada por ferramenta determinística, não RAG:** `docs/COPILOT.md` seção 6 exclui explicitamente "RAG, embeddings, pgvector". A leitura descuidada do pedido ("aprendizado operacional", "conhecimento reutilizável") poderia soar como uma feature de aprendizado do modelo — não é. Confirmação humana grava um fato estruturado (`sku_id`, tipo, conteúdo, fonte, status `SUGERIDO`/`VALIDADO`/`REJEITADO`/`OBSOLETO`); a ferramenta do Copiloto faz um `SELECT` nele, igual a qualquer outra ferramenta de consulta pontual já registrada. Só `VALIDADO` é tratado como informação confirmada; conflito entre dois itens é sinalizado para revisão humana, nunca sobrescrito em silêncio.

**Decisão 4 — domínio novo `support`:** dezenove contextos agora (era dezoito), `docs/ARCHITECTURE.md` seção 8. Lê `orders`/`skus`/`listings` só por read model declarado, como qualquer outro domínio (regra já existente: "escrita cruzada é proibida"); nunca escreve neles.

**Decisão 5 — tabelas conceituais nomeadas, sem migration:** `support_cases`, `support_messages`, `support_case_events`, `knowledge_entries`, `reply_templates` (`docs/DATABASE.md`) — nomes de partida, não fechados; "avaliar nomes definitivos durante a arquitetura" é instrução do próprio usuário para os status internos, aplicada aqui por extensão às tabelas.

**Achado no caminho — Claims/Returns/Mediações já têm pesquisa oficial (D-057), Perguntas/Mensagens nunca foram pesquisadas:** `docs/MERCADO_LIVRE.md` seção 2.9 já sinalizava isso ("`questions`/`messages` seguem Fase posterior") desde 2026-08-21, sem nunca ter virado seção própria. Criada a seção 2.12, deliberadamente vazia (mesma convenção do arquivo: "seção vazia é sinal de trabalho pendente, não de esquecimento"), com a lista exata do que falta confirmar antes de qualquer código: endpoint de leitura/resposta de perguntas e mensagens, payload do webhook `messages` (hoje só citado por nome), permissão de **escrita** (só leitura foi confirmada para Claims/Returns), SLA exposto pela API ou regra própria, e se mediação é um `type` dentro de Claims ou recurso próprio.

**Achado no caminho — `claim-return.ts` (D-057) é processamento efêmero, não persistência de UI:** o handler existente busca o claim/devolução ao vivo do Mercado Livre, calcula a reversão de estoque e não grava nenhum registro durável de "atendimento" consultável depois. Confirma que a Fase 7B precisa de persistência nova (`support_cases`/`support_messages`), não é só "ligar uma tela" em cima do que já existe.

**Impacto:** `docs/ROADMAP.md` (seção Fase 7B + ordem de execução), `docs/PRODUCT_REQUIREMENTS.md` (seção completa de requisitos SAC + grupo "Atendimento" na navegação), `docs/ARCHITECTURE.md` (domínio `support`), `docs/COPILOT.md` (seção 11), `docs/API.md` (seção 9, conceitual), `docs/DATABASE.md` (domínio `support` na lista L1 + linha na tabela de pendências), `docs/MERCADO_LIVRE.md` (seção 2.12 vazia + checklist + pendências), `docs/NOTIFICATIONS.md` (seção 10, nota curta), `docs/HANDOFF.md` (resumo operacional). Nenhum código, nenhuma migration, nenhuma infraestrutura — só documentação, como pedido.

## D-072 — Motor de diff de `listings`: fecha o pré-requisito crítico da Fase 7 (preço, título, status, quantidade disponível)

**Contexto:** `docs/HANDOFF.md` ("Pré-requisito crítico da Fase 7") registrava desde a Fase 0 que notificação de alteração de anúncio depende de um evento confiável — `estado anterior -> estado atual -> diff determinístico -> domain_event -> notification` — com quatro eventos candidatos (preço, título, status, quantidade disponível). O catálogo (`docs/API.md` secao 4, `packages/domain/src/events/catalog.ts`) já tinha `listing.price.changed`/`listing.title.changed`/`listing.status.paused`/`listing.status.reactivated` desde a Fase 0, mas nenhum código emitia nenhum deles — `listings` (D-058) é projeção MUTÁVEL (upsert), então o "antes" só existe até o upsert seguinte sobrescrevê-lo, e nada lia essa linha antes de sobrescrever.

**Achado no caminho — REGRA ABSOLUTA aplicada antes de codar `listing.status.paused`/`.reactivated`:** os valores reais do campo `status` nunca tinham sido confirmados contra a documentação oficial (`listing-schema.ts` só validava `status: z.string()`, sem enum) — implementar a distinção paused/reactivated exigia saber quais strings o Mercado Livre realmente usa. Pesquisado ao vivo em 2026-08-24 (`docs/MERCADO_LIVRE.md` secao 2.13, "Sincronização e modificação de publicações", atualizada 24/03/2026): `active` · `paused` (substatus `out_of_stock`/`paused_by_seller`) · `under_review` · `closed` · `payment_required` · `inactive`. **Achado crítico da pesquisa:** `available_quantity` chegar a 0 PAUSA o anúncio sozinho no Mercado Livre (substatus `out_of_stock`), e repor estoque REATIVA sozinho — mas só quando o motivo da pausa foi `out_of_stock`; pausa manual do vendedor (`paused_by_seller`) não reativa sozinha ao repor estoque. Sem essa pesquisa, o motor de diff teria sido implementado às cegas sobre um acoplamento real entre dois dos quatro campos monitorados.

**Decisão 1 — `listings.status` só distingue os DOIS status de topo já catalogados, não o substatus:** `paused` (qualquer motivo) e `active` — capturar `out_of_stock` vs `paused_by_seller` exigiria estender `listingItemSchema` e a migration de `listings`, fora do escopo de implementar o motor de diff sobre o dado já coletado. Registrado como limitação conhecida em `docs/MERCADO_LIVRE.md` secao 2.13, não como descuido.

**Decisão 2 — `listing.status.paused`/`.reactivated` cobrem só as transições já catalogadas, nada além:** `paused` fecha em CIMA de qualquer transição PARA `paused`; `reactivated` fecha só `paused -> active`. Outras transições (`active -> closed`, `active -> under_review`, etc.) não têm evento próprio — não inventado aqui, mesma REGRA ABSOLUTA.

**Decisão 3 — `dedup_key` leva `syncedAt` (quando o V3 observou), não um valor puro:** diferente de `order.cancelled` (transição essencialmente terminal, chave só por valor), os quatro campos de `listings` oscilam livremente ao longo da vida do anúncio — preço sobe e desce, status pausa e reativa repetidas vezes. Uma chave sem tempo colidiria e suprimiria uma segunda mudança real de volta ao mesmo valor. Mesmo padrão já usado em `fulfillment-events.ts` para `stock.depleted`/`stock.replenished`, que tem exatamente essa mesma característica de oscilação.

**Decisão 4 — `listing.price.changed` usa severidade fixa "informativo" nesta primeira versão:** o catálogo desde a Fase 0 já marcava a severidade como "condicional à magnitude da mudança, regra ainda não definida — não adivinhar aqui". Um limiar de magnitude continua não inventado; "informativo" é o lado conservador (mesma categoria de `title.changed`), evitando alarme para uma correção de centavos enquanto o limiar não existir. Elevar por magnitude fica para quando houver dado real de quanto os preços variam na prática.

**Decisão 5 — `listing.available_quantity.changed` é catálogo novo:** o evento nunca tinha sido catalogado (só existia como texto solto no pré-requisito do `docs/HANDOFF.md`, nunca como linha em `docs/API.md`/`catalog.ts`) — adicionado com severidade "informativo", nome seguindo o padrão `dominio.entidade.acao` já em uso, em vez do `listing.available_quantity_changed` (underscore) citado por engano no texto original do pré-requisito.

**Verificação:** `packages/domain/src/events/listing-events.ts` (puro, sem banco) com 13 testes cobrindo cada campo isolado, os dois disparando juntos (estoque zera e o anúncio pausa sozinho), transições de status fora do catálogo (nenhum evento), idempotência (mesmo par de estados = mesma chave) e chaves diferentes entre sincronizações diferentes. Wiring em `apps/worker/src/handlers/ml-listings-fetch.ts` (lê a linha anterior antes do upsert, `recordDomainEvents` best-effort depois) com 6 testes novos no nível do handler. `pnpm run test`/`typecheck`/`lint` limpos em `packages/domain` e `apps/worker`.

**Impacto:** `packages/domain/src/events/listing-events.ts` (novo) + teste, `packages/domain/src/events/catalog.ts` (`listing.available_quantity.changed`), `packages/domain/src/events/index.ts` (export). `apps/worker/src/handlers/ml-listings-fetch.ts` + teste. `docs/API.md` secao 4 (catálogo atualizado, `order.returned` também corrigido — estava marcado "ainda não integrada" apesar de implementado desde D-057), `docs/DATABASE.md` (`listings`), `docs/ROADMAP.md` (P0 "Pré-requisito das notificações"), `docs/HANDOFF.md` (resumo operacional), `docs/MERCADO_LIVRE.md` (secao 2.13, nova). Fecha o pré-requisito crítico da Fase 7 até `domain_event` inclusive — falta só conectar a `notifications` (schema ainda não implementado).

**Deploy confirmado, não só codificado:** commit `b23a8ae` publicado no worker (`infra/deploy-cloud-run.sh worker`) — `worker-00019-9jk`, servindo 100% do tráfego, imagem confirmada via `gcloud run revisions describe`. Zero linha `ERROR` nos logs nos 15 minutos seguintes ao deploy. `apps/api` não mudou nesta etapa, sem deploy necessário ali.

## D-073 — Persistência de notificações: fan-out por trigger em `domain_events`, não RPC nem código de aplicação

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 3) registrava "implementar persistência/regras de notificação" como o próximo passo depois de D-072 fechar a emissão de `domain_events` de anúncio. `docs/NOTIFICATIONS.md` já descrevia a cadeia completa (`domain_events -> severidade -> regra de destinatário -> notifications/notification_recipients -> Realtime -> toast/Central`) desde a Fase 0, mas nada do meio para frente existia — nem a tabela, nem a regra. `notification_preferences` já devia existir "desde a Fase 2" (`docs/NOTIFICATIONS.md` secao 6, "é coluna barata agora e migration chata depois") e nunca foi criada — corrigido junto.

**Decisão 1 — fan-out via trigger `AFTER INSERT` em `domain_events`, não RPC nem uma função chamada explicitamente por cada handler do worker:** mesmo raciocínio de `private.apply_stock_movement` (a projeção `inventory_balances` se mantém sozinha a cada `stock_movements` novo, `docs/DATABASE.md` secao 14). `domain_events` já tem múltiplos pontos de escrita (`persist-order.ts`, `claim-return.ts`, `ml-fulfillment-fetch.ts`, `ml-listings-fetch.ts`, e o que vier depois) — pedir para cada um lembrar de "também notificar" é exatamente a categoria de esquecimento que D-067 auditou a sessão inteira. Um trigger cobre todos, presentes e futuros, sem coordenação entre call sites. Sem `security definer` — mesmo padrão de `apply_stock_movement`: o worker já grava `domain_events` como `service_role`, privilégio suficiente para as duas tabelas novas.

**Decisão 2 — regra de destinatário reusa exatamente a semântica de `has_account_access`/D-054, só como conjunto:** evento organizacional (`ml_account_id` nulo) alcança todo membro da organização; evento de conta alcança ADMIN (sempre) mais quem tiver `user_account_permissions` para aquela conta. Não é uma regra nova — é a MESMA já usada para leitura de `domain_events`, só expressa como `select user_id ... where` em vez de um `exists` para o usuário corrente. Duas regras de acesso divergentes para o mesmo conceito seria o tipo de inconsistência que este projeto evita desde a D-012.

**Decisão 3 — `notification_preferences` com matching por especificidade, tabela vazia por enquanto:** granularidade por usuário/`event_type`/conta/severidade mínima (`docs/NOTIFICATIONS.md` secao 6). Sem UI para criar linha nenhuma ainda (item 6, posterior), a tabela nasce vazia e o fan-out trata "sem preferência" como "notificar" — default seguro que não exige a UI existir primeiro para o resto do pipeline funcionar. Quando mais de uma linha bate (curinga geral + específica), a mais específica vence — mesmo princípio de "a config mais próxima do caso concreto governa" já usado em outras camadas do projeto. Mesma pegadinha de `NULL` não colidir em `UNIQUE` simples já documentada para `sku_listing_links` (`docs/DATABASE.md` secao 4) — quatro índices únicos parciais, um por combinação de curinga, em vez de um `unique` ingênuo que deixaria um usuário cadastrar duas preferências "gerais" conflitantes.

**Decisão 4 — `notifications` não duplica `event_type`/`before`/`after`/`severity`:** essas colunas já vivem em `domain_events`; a tabela nova só referencia (`domain_event_id`, `unique`) e a leitura faz `join`. Evita a categoria de bug que a `metric_definitions`/`packages/domain/src/events/catalog.ts` já evita para métricas e severidade — duas fontes da mesma verdade divergindo cedo ou tarde.

**Decisão 5 — deliberadamente sem backfill:** `domain_events` já tinha linhas reais desde a Fase 3. Sem Central de Notificações para consumir ainda (item 4, posterior), backfilar histórico não tem benefício visível hoje e arrisca uma migration pesada contra tabela de produção real só para popular uma tela que não existe. A partir desta migration, todo `domain_event` NOVO gera notificação; histórico anterior fica só em `domain_events`, consultável do mesmo jeito de sempre.

**Achado no caminho, de passagem:** `packages/domain/src/diagnostics/sales-anomaly.ts` (D-063) tinha um comentário desatualizado dizendo `listing.*` "catalogado, nunca emitido" — falso desde D-072 (nesta mesma sessão). Corrigido o comentário em `docs/DATABASE.md`; a correlação de diagnóstico por `listing.*` continua fora de escopo (exigiria resolver `sku_listing_links` a partir do `item_id`), mas por decisão separada, não por o evento não existir mais.

**Limitação registrada — não verificado nesta máquina:** sem Docker disponível localmente, nem a migration nem os testes de integração novos puderam rodar contra um Postgres real antes do push — mesma situação já enfrentada em D-069 (Playwright). A CI (`integration` job, que sobe Supabase local com Docker) é o verificador real. Revisão estática cuidadosa feita antes do push: grants de `service_role` conferidos linha por linha contra as migrations existentes (`user_account_permissions` tem grant bundled numa declaração multi-tabela, fácil de não achar num grep ingênuo), lógica da subquery de preferência (curto-circuito de `enabled=false`, comparação de rank de severidade, `NULL` de `ml_account_id` não casando com conta específica) rastreada manualmente contra cada cenário de teste escrito.

**`packages/db/src/types.ts` regenerado** depois que a migration aplicou no Supabase Dev (CI confirmada verde): sem Docker nesta máquina para `--local`, usado `supabase gen types typescript --project-id nmgccyqquwxecqffsidr` contra o Dev real — diff conferido linha a linha antes de sobrescrever, só as três tabelas novas apareceram, nada mais mudou ou sumiu. Item 4 (Central de Notificações) já pode consultar as tabelas com tipo gerado.

**Impacto:** `supabase/migrations/20260824190000_create_notifications.sql` (novo — `notifications`, `notification_recipients`, `notification_preferences`, `private.fan_out_notification` + trigger, RLS, GRANTs). `packages/db/src/rls.integration.test.ts` (+27 testes: regra de destinatário, RLS de leitura/escrita, supressão por preferência, autogestão de preferência). `docs/DATABASE.md` (seção nova + correção de `listing.*` desatualizado), `docs/NOTIFICATIONS.md` (status + seções 1/5/6), `docs/ROADMAP.md` (Fase 7, dois itens parcialmente fechados), `docs/HANDOFF.md` (sequência recomendada, item 3 fechado). Fecha o item 3 da sequência — item 4 (Central de Notificações) é o próximo, e depende de `gen:types` rodar primeiro.

## D-074 — Central de Notificações: lista + lido/não lido, Server Action direta sob RLS, sem RPC

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 4) registrava "implementar Central de Notificações + estado lido/não lido" como o próximo passo depois de D-073 destravar o schema (`notifications`/`notification_recipients`/`notification_preferences`, tipos já regenerados). `docs/NOTIFICATIONS.md` secao 7 já descrevia o requisito ("histórico completo, com estado lido/não lido por usuário... link pra entidade afetada") desde a Fase 0; Realtime/toast/agrupamento por janela (item 5) e a UI de preferências (item 6) ficam de fora desta fatia, como o próprio HANDOFF já separava.

**Decisão 1 — marcar como lida é Server Action direta sob RLS, sem RPC:** `docs/ARCHITECTURE.md` secao 4 já cita nominalmente "marcar notificação lida" como exemplo de escrita simples no escopo do usuário — a policy `notification_recipients_update_own` (D-073) já restringe a atualização à própria linha, então `update ... where notification_id = X` (sem `user_id` no filtro do cliente) é seguro: a RLS descarta qualquer linha que não seja do usuário corrente mesmo sem o filtro explícito, mesmo raciocínio de `docs/API.md`/`ARCHITECTURE.md` sobre a RLS ser a segurança real, não a interface.

**Decisão 2 — a query parte de `notifications`, não de `notification_recipients`:** `notification_recipients` não tem `created_at` própria (só a chave composta `notification_id, user_id` e `read_at`), então ordenar por "mais recente primeiro" exige a coluna de `notifications`. Partir de `notifications` com `notification_recipients!inner(read_at)` embutido permite `.order("created_at").limit(100)` direto no PostgREST, sem ordenar em memória — mesmo padrão de `apps/web/app/compras/page.tsx`. O `!inner` não precisa de `.eq("user_id", ...)`: a policy `notification_recipients_select_own` já restringe o embed à própria linha do usuário.

**Decisão 3 — link pra entidade afetada só quando a rota de destino existe de verdade:** `entity_type = "sku"` usa o mesmo UUID de `skus.id` como `entity_id` (`packages/domain/src/events/fulfillment-events.ts`), que bate direto com a rota `/skus/[skuId]` já existente — vira link. `entity_type = "listing"` (MLB) e `"order"` (id do Mercado Livre) não têm tela de detalhe própria ainda — mostrado como texto, sem link morto. Não inventar uma rota que não existe.

**Decisão 4 — diff legível (`antes → depois`) só para os quatro tipos de evento cujo formato de `before`/`after` já está documentado e testado:** `listing.price.changed`/`title.changed`/`available_quantity.changed`/`status.paused`+`.reactivated` (`packages/domain/src/events/listing-events.ts`, chaves `price`/`title`/`availableQuantity`/`status`). Os demais tipos (`stock.*`, `order.*`, `sync.*`, `listing.promotion.*`/`catalog.*`/`fulfillment.*`) mostram só o rótulo do evento, sem tentar ler um `before`/`after` cujo formato não foi conferido nesta sessão — mesma REGRA ABSOLUTA de não inventar leitura de dado (`docs/MERCADO_LIVRE.md`), aplicada aqui ao formato interno do próprio evento.

**Decisão 5 — emblema de não lidas no `Shell`, contagem sem tratamento de erro visível:** `notification_recipients_select_own` já restringe a contagem à própria linha. Diferente da falha de `membership` no mesmo componente (D-067, Nível 3, que ganhou um `⚠` por arriscar mascarar perda de acesso/papel), uma falha aqui degrada para o emblema simplesmente não aparecer — não é dado de negócio que pode corromper decisão (estoque, pedido, papel), é só um contador de UI.

**Rótulos em português** (`apps/web/lib/labels.ts`, `eventTypeLabel`/`severityLabel`) traduzidos diretamente do catálogo já registrado em `docs/API.md` secao 4 — nenhum texto novo inventado, só tradução do que já existia. `statusTone` ganhou os três códigos de severidade (`informativo` sem destaque de propósito — não deve competir visualmente com `importante`/`crítico`) reaproveitando o `StatusPill` já existente, sem componente novo.

**Verificação:** `pnpm run typecheck`, `lint`, `test` (todos os pacotes) e `pnpm run build` (`apps/web`, Next.js 16/Turbopack) — todos verdes, rota `/notificacoes` aparece como `ƒ` (dinâmica) no output do build. CI confirmou mais que a revisão estática: o job `e2e` (Playwright contra Postgres real via Docker, login real) passou com a query nova do emblema de não lidas em `Shell` — esse componente roda em TODA página autenticada que os specs visitam (login, Dashboard de SKU, NF-e, pedido de compra), então essa query específica já rodou de verdade contra dado real, não só localmente sem Docker. **Limitação que permanece**: a tela `/notificacoes` em si (lista, botão "marcar como lida") não é visitada por nenhum spec Playwright existente, e esta sessão não tinha credencial de um usuário real para abrir a tela manualmente no navegador contra o Supabase Dev (`.env.local` de `apps/web` aponta pra lá, não pra localhost). A leitura/escrita reaproveita exatamente as policies (`notifications_select_via_recipient`, `notification_recipients_select_own`, `notification_recipients_update_own`) já cobertas pelos 27 testes de integração de D-073 — o risco não coberto por este trabalho é estritamente de renderização da tela nova, não de RLS.

**Impacto:** `apps/web/app/notificacoes/page.tsx` (novo), `apps/web/app/notificacoes/actions.ts` (novo — `markNotificationRead`/`markAllNotificationsRead`), `apps/web/app/notificacoes/notification-row.tsx` (novo), `apps/web/app/notificacoes/mark-all-button.tsx` (novo), `apps/web/lib/labels.ts` (`eventTypeLabel`/`severityLabel`, `statusTone` estendido), `apps/web/components/shell.tsx` (link "Notificações" com emblema de não lidas, nav ganha item solto novo). `docs/NOTIFICATIONS.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados para refletir item 4 fechado. Fecha o item 4 da sequência — item 5 (Realtime/toasts) é o próximo, e pode reaproveitar a mesma `NotificationRow`/rótulos já escritos aqui.

## D-075 — Realtime + toasts: pesquisa oficial confirmada ao vivo, agrupamento por janela com contador que sobrevive ao toast sumir

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 5) registrava "implementar Realtime/toasts" como o próximo passo depois de D-074 fechar a Central de Notificações. `docs/NOTIFICATIONS.md` secao 4 já descrevia a escolha de transporte (`postgres_changes` filtrado por `user_id` sobre `notification_recipients`) desde a Fase 0, mas com uma pendência explícita registrada: "confirmar a recomendação atual da Supabase para Realtime antes de implementar. A API mudou em ciclos recentes e não será assumida de memória." — a mesma disciplina de `docs/MERCADO_LIVRE.md` (REGRA ABSOLUTA), aplicada aqui a uma API de infraestrutura, não só a integrações externas de negócio.

**Decisão 1 — pesquisa ao vivo antes de escrever qualquer código**, contra `docs.supabase.com/guides/realtime/postgres-changes` (documentação oficial atual, não memória de treinamento): confirmado que `postgres_changes` autoriza CADA evento contra a RLS da tabela de origem, por assinante — a mesma `notification_recipients_select_own` (D-073) já usada na Central de Notificações (D-074) é suficiente, sem policy nova em `realtime.messages` (esse mecanismo de autorização mais recente da Supabase é só para Broadcast/Presence, que este projeto não usa e não precisa). O único passo de infraestrutura que faltava era a tabela entrar na publication `supabase_realtime` — confirmado também que a documentação oficial só recomenda migrar para `broadcast` acima de ~3000 assinantes concorrentes na mesma mudança, muito acima da realidade de "um punhado de usuários internos" já registrada em `docs/NOTIFICATIONS.md` secao 4 antes desta sessão. A pesquisa não inverteu nenhuma decisão anterior — confirmou que a escolha já registrada continuava certa, e resolveu a pendência formalmente.

**Decisão 2 — migration só adiciona a tabela na publication, sem tocar RLS:** `20260824200000_enable_realtime_notification_recipients.sql` é uma linha (`alter publication supabase_realtime add table public.notification_recipients;`). Nenhuma mudança de schema — não precisou regenerar `packages/db/src/types.ts` (diferente de D-073, que exigiu o roundtrip contra o Supabase Dev por causa de tabelas novas).

**Decisão 3 — agrupamento por janela com duas estruturas separadas, não uma:** `docs/NOTIFICATIONS.md` secao 3 é explícita ("requisito, não enfeite") sobre precisar de um contador de verdade, não um efeito cosmético. `groupsRef` (um `Map`, sobrevive ao componente re-renderizar) é a fonte da verdade do agrupamento — só expira 5 minutos depois do PRIMEIRO evento do grupo (`WINDOW_MS`). O estado React `toasts` é só o que está VISÍVEL agora — cada card some sozinho 8s depois do ÚLTIMO evento (`DISMISS_MS`), independente da janela de agrupamento. Consequência deliberada: o contador acumula a janela inteira mesmo que o card individual já tenha sumido da tela e reaparecido — "trinta alterações em cinco minutos" (o exemplo do próprio `docs/NOTIFICATIONS.md`) vira um contador de trinta de verdade, não um contador que reseta toda vez que o toast pisca.

**Decisão 4 — sem link pra entidade quando o grupo tem mais de um evento:** um toast agrupado (`count > 1`) representa vários eventos, possivelmente de entidades diferentes — linkar pra Central de Notificações em vez de uma entidade específica evita um link que mostra só o último evento como se fosse o resumo completo do grupo.

**Decisão 5 — leitura de `before`/`after`/entidade extraída para `apps/web/lib/event-format.ts`, compartilhada com a Central de Notificações (D-074):** a Central já tinha essa lógica (`formatEventDiff`/`entityHref`/`entityLabel`, só os quatro tipos de `listing.*` com formato documentado, mesma REGRA ABSOLUTA de não inventar leitura de `before`/`after` cujo formato não foi conferido). Os toasts precisam exatamente da mesma leitura — extrair evita duas implementações divergindo, e o módulo compartilhado ganhou 12 testes de unidade novos (`lib/event-format.test.ts`), cobertura que não existia antes por estar embutida dentro do componente de UI.

**Verificação:** `pnpm run typecheck`, `lint`, `test` (todos os pacotes, incluindo os 12 testes novos de `event-format.test.ts`) e `pnpm run build` (`apps/web`) — todos verdes. CI foi além da revisão estática: a migration aplicou com sucesso duas vezes (job `integração`, Postgres local subindo do zero com TODAS as migrations, e job `aplicar migrations no Supabase Dev`) e o log do job `e2e` confirma o serviço `supabase_realtime_speedbikers-gestao-v3` rodando durante os testes (listado entre os serviços ativos do Supabase local) — a infraestrutura que o transporte depende está de pé e funcional, não só declarada. **Limitação que permanece**: o handshake do WebSocket e a entrega ponta a ponta de um evento real não foram exercitados — nenhum spec Playwright existente insere um `domain_event` durante o teste (os specs de D-069 testam login/produto/NF-e/compra, não notificações), e esta sessão não tinha credencial de usuário real para abrir o navegador manualmente contra o Supabase Dev. A autorização por RLS que o transporte depende (`notification_recipients_select_own`) é a mesma já coberta pelos 27 testes de integração de D-073 — o risco não coberto por este trabalho é estritamente a integração ponta a ponta do transporte Realtime, não a autorização nem a infraestrutura.

**Impacto:** `supabase/migrations/20260824200000_enable_realtime_notification_recipients.sql` (novo). `apps/web/components/notification-toasts.tsx` (novo), montado em `apps/web/components/shell.tsx`. `apps/web/lib/event-format.ts` (novo, extraído de `notification-row.tsx`) + `apps/web/lib/event-format.test.ts` (novo, 12 testes). `docs/NOTIFICATIONS.md` (secoes 1/3/4), `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. Fecha o item 5 da sequência — item 6 (preferências por usuário, UI) é o próximo.

## D-076 — Preferências por usuário (UI) + correção de D-073: preferência nunca mais apaga a Central de Notificações

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 6) registrava "implementar preferências por usuário" como o último item pendente da metade "Notificações" da Fase 7. Schema e regra de matching (`notification_preferences`, especificidade "evento+conta > só um > nenhum vence") já existiam desde D-073; faltava só a UI (`docs/NOTIFICATIONS.md` secao 6).

**Achado ao construir a UI, antes de escrever qualquer componente**: a trigger `private.fan_out_notification` (D-073) filtrava a inserção de `notification_recipients` pela preferência do usuário (`enabled`/`min_severity`) — releitura cuidadosa de `docs/NOTIFICATIONS.md` secao 1 (dono documental desta regra) mostrou que isso contradiz o texto escrito ali desde a Fase 0: "'nem toda mudança precisa interromper alguém' acontece via `notification_preferences`... não por deixar de criar a notificação: o registro na Central de Notificações continua existindo para consulta, só o alerta em tempo real é que respeita a preferência de cada um." Reforçado pela secao 9 do mesmo arquivo ("notificação é efêmera na atenção, permanente no histórico") e pelo motivo histórico registrado ali (V2 chegou a 5.243 alertas abertos — o problema que este produto evita é alerta demais, nunca histórico perdido).

**Por que isso é uma correção, não uma preferência de estilo** (`docs/DECISIONS.md`, regra do rodapé: "não reverter decisão existente silenciosamente, registrar nova decisão que substitui a anterior e explicar o motivo"): implementação divergindo do próprio doc que a rege é exatamente a classe de bug que D-067 auditou a sessão inteira — não é "eu faria diferente" (proibido pela "Regra para agentes futuros" do `docs/HANDOFF.md`), é o código não fazer o que o requisito, escrito antes do código, sempre disse que devia fazer. **O bug era inerte até agora**: `notification_preferences` nascia vazia (sem UI pra criar linha nenhuma), então nenhum usuário real jamais perdeu visibilidade de um evento por causa disso — o momento exato em que este item constrói a UI é o único momento em que essa lacuna deixaria de ser inerte, então é também o momento certo de fechá-la.

**Decisão 1 — mover a aplicação da preferência da trigger (SQL) pro cliente (TypeScript), não deletar a funcionalidade:** migration `20260824210000_fix_notification_preferences_scope.sql` reescreve `private.fan_out_notification` removendo o filtro de preferência — `notification_recipients` volta a ser inserido incondicionalmente pra todo membro elegível por permissão de conta (regra de D-054/D-073, inalterada). A MESMA lógica de especificidade que existia em SQL (`order by (event_type is not null)::int + (ml_account_id is not null)::int desc`) foi reimplementada em `apps/web/lib/notification-preferences.ts` (`shouldNotify`), consumida só por `apps/web/components/notification-toasts.tsx` antes de decidir se mostra um toast. Existe em UM lugar só de cada vez — não ficou duplicada entre SQL e TypeScript.

**Decisão 2 — preferências carregadas uma vez por montagem do componente de toast, não por evento:** o volume esperado de linhas de preferência por usuário é pequeno (poucas regras, não centenas), e o custo de uma consulta por toast recebido não se paga. Tolerância aceita: se o usuário mudar a própria preferência numa aba enquanto outra está com o componente montado, a aba antiga só nota na próxima navegação — mesma tolerância já aceita pro resto do Realtime não ser fonte de verdade (`docs/HANDOFF.md`: "Realtime é mecanismo de entrega para o usuário conectado", nunca a fonte durável).

**Decisão 3 — identidade da regra (evento + conta) é fixa após criada, só severidade mínima e `enabled` são editáveis inline:** mudar QUAL evento/conta uma regra alcança é essencialmente criar outra regra; editar a política (quão sensível, ligada ou não) é o ajuste comum do dia a dia. `PreferenceRow` deixa a segunda categoria como `<select>`/checkbox direto na linha (Server Action por mudança), a primeira exige apagar e recriar via `NewPreferenceForm`.

**Decisão 4 — lista de `event_type` do formulário vem de `@sb/domain` (`EVENT_SEVERITY`), não uma cópia:** mesmo catálogo que atribui severidade — divergir seria a mesma classe de bug de duas fontes de verdade já evitada em `metric_definitions`/`packages/domain/src/events/catalog.ts` (D-073). Lista de contas vem de `ml_accounts` sob RLS (`ml_accounts_select_permitted`, `has_account_access`) sem filtro adicional no código — um usuário só vê (e só pode criar preferência para) contas que já tem acesso, automaticamente.

**Testes:** describe `"notification_preferences suprime o fan-out"` (`packages/db/src/rls.integration.test.ts`, D-073) renomeado pra `"notification_preferences NÃO suprime o fan-out — recipient sempre criado (correção 2026-08-24, D-076)"`, com as duas asserções que antes esperavam `not.toContain` agora esperando `toContain` — o teste passou a provar o comportamento oposto do que provava antes, documentando a correção no próprio nome do describe. `apps/web/lib/notification-preferences.test.ts` (novo, 7 testes): sem regra aplicável notifica por padrão, `enabled=false` suprime o toast, severidade abaixo do mínimo suprime o toast, regra mais específica vence sobre curinga geral, regra de outra conta não se aplica, curinga de conta (sem `event_type`) alcança qualquer tipo de evento daquela conta.

**Verificação:** `pnpm run typecheck`, `lint`, `test` (todos os pacotes, incluindo os 7 testes novos) e `pnpm run build` (`apps/web`) — todos verdes. Migration só corrige uma função (`create or replace`), sem schema novo. CI foi além de confirmar que a migration aplica: o job `integração` rodou o describe RENOMEADO/INVERTIDO contra Postgres real (do zero, com todas as migrations) e as duas asserções que agora esperam `toContain` (não mais `not.toContain`) passaram — prova de verdade, não só leitura estática do SQL, de que `notification_recipients` é criado incondicionalmente mesmo com preferência restritiva. `aplicar migrations no Supabase Dev` confirma a correção também aplicada lá. **Mesma limitação das entregas anteriores**: a tela `/notificacoes/preferencias` não foi aberta no navegador nesta sessão (sem credencial de usuário real contra o Supabase Dev) — a leitura/escrita reaproveita as policies já testadas (`notification_preferences_all_own`, D-073), o risco não coberto é estritamente de renderização.

**Impacto:** `supabase/migrations/20260824210000_fix_notification_preferences_scope.sql` (novo). `apps/web/app/notificacoes/preferencias/{page,actions,preference-row,new-preference-form}.tsx` (novos). `apps/web/lib/notification-preferences.ts` + `.test.ts` (novos). `apps/web/components/notification-toasts.tsx` (consulta a preferência antes do toast). `packages/db/src/rls.integration.test.ts` (describe renomeado + assinatura invertida). `docs/NOTIFICATIONS.md` (secoes 1/5/6, status), `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. **Fecha a metade "Notificações" da Fase 7 por completo** (itens 1-6 da sequência recomendada) — item 7 (Copiloto com ferramentas determinísticas) é o próximo, e é o início da segunda metade da Fase 7.

## D-077 — Copiloto: ferramentas determinísticas + `ai_runs`, sem LLM ainda (decisão de escopo deliberada)

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 7) registrava "iniciar Copiloto com ferramentas determinísticas" como o primeiro passo da metade "Copiloto" da Fase 7, depois de D-072 a D-076 fecharem a metade "Notificações". `docs/COPILOT.md` já descrevia a arquitetura completa desde a Fase 0 (tool calling sobre ferramentas tipadas, curto-circuito quando a ferramenta responde por completo, `ai_runs` para custo), mas com uma pendência explícita registrada na secao 10: "escolha do modelo e orçamento de custo por período."

**Decisão 1 — escopo desta fatia é só o que "ferramentas determinísticas" pede literalmente, nada do que depende de LLM:** o texto do item 7 já distingue "ferramentas determinísticas" (este item) do planner/narração por LLM (dependente da escolha de modelo). Implementar o registro de ferramentas, a execução sob permissão real e `ai_runs` não exige NENHUMA decisão de modelo/orçamento — só a parte que chamaria um LLM de verdade (planner por linguagem natural, narração de evidências, streaming SSE de token) depende disso. Separar as duas coisas evita duas armadilhas: (a) implementar tudo e silenciosamente inventar uma escolha de modelo/orçamento — decisão de custo recorrente real que não deve ser tomada sem confirmação explícita — ou (b) travar o item inteiro esperando uma decisão que na verdade só bloqueia metade do trabalho.

**Decisão 2 — cada ferramenta lê sob a RLS real do usuário, não RBAC reimplementado em código:** `docs/COPILOT.md` secao 3 regra 2 diz "permissão é aplicada na camada de ferramenta, não no prompt" — texto compatível com duas leituras (RLS automática, ou RBAC manual replicado em TypeScript). Investigação técnica antes de escrever código: `get_sales_summary` (a RPC que as três ferramentas reaproveitam) é `security invoker`, ou seja, ela HERDA os privilégios de quem a chama — rodá-la com `service_role` (o único cliente que `apps/api` tinha até agora, usado em toda rota de comando privilegiado) devolveria dado de TODAS as organizações, RLS completamente bypassada. Reimplementar `has_account_access` em TypeScript pra compensar seria a mesma categoria de duplicação que `docs/ARCHITECTURE.md` secao 7 já proíbe para fórmulas de métrica ("regra da fórmula única"). **Solução**: novo tipo de cliente, `UserClient` (`@sb/db`, `createUserClient`) — instanciado com a chave PUBLICÁVEL (não `service_role`) + o mesmo JWT que já veio no header `Authorization` do request, mesmo modelo A que `apps/web` já usa (`lib/supabase/server.ts`). A `api` não precisava reautenticar nada — o token do chamador já estava disponível, só faltava repassá-lo. `apps/api/src/auth.ts` ganhou `extractBearerToken`, exportado separado de `authenticate` porque as duas coisas (validar QUEM é o chamador, e criar um cliente que LÊ como ele) agora têm consumidores diferentes.

**Decisão 3 — as três primeiras ferramentas não agregam nada novo, só encapsulam `get_sales_summary` com contrato tipado:** `docs/COPILOT.md` secao 10 já apontava a tela âncora (`/vendas`, D-033) como onde as primeiras ferramentas deveriam nascer. `sales_summary` chama a MESMA RPC que `apps/web/app/vendas/page.tsx` já chama; `sales_period_comparison` reaproveita `previousBusinessDateRange` (`@sb/domain`, já usada na mesma tela) em vez de reimplementar "período anterior de igual tamanho"; `sales_account_comparison` só chama a RPC uma vez por conta. Nenhuma agregação nova, nenhuma fórmula nova — zero risco de divergência com o que a tela já mostra.

**Decisão 4 — contrato de resposta `{ tool, escopo, confianca, data }`, não o contrato de diagnóstico:** `docs/API.md` secao 5 já define um contrato DIFERENTE (`{ escopo, evidencias[], causas_candidatas[], confianca, proximos_passos[] }`) para o pipeline de diagnóstico ("O que aconteceu?", item 8, ainda não implementado) — `evidencias[]`/`causas_candidatas[]`/`proximos_passos[]` são conceitos de diagnóstico, não de consulta/comparação. Usar esse contrato aqui misturaria dois formatos com propósitos diferentes. O contrato desta fatia é mais simples, batendo com `docs/COPILOT.md` secao 5 ("a resposta sempre mostra o escopo e o período efetivamente usados"): `escopo` é o input já validado, `confianca` é sempre `"alta"` (determinístico nunca "inventa" — não existe confiança menor que alta neste caminho), `data` é a saída tipada da ferramenta.

**Decisão 5 — `ai_runs` grava toda chamada, mesmo sem LLM, e nunca impede a resposta de ir pro usuário:** `recordAiRun` (`@sb/db`) segue exatamente o padrão já estabelecido por `recordJobRun` — nunca lança. A ferramenta já calculou a resposta antes de `ai_runs` ser gravado; uma falha de observabilidade não pode transformar uma consulta que funcionou em erro 5xx (mesmo raciocínio já documentado para `job_runs`). `llm_used = false`/`cost_usd = null` em toda linha desta fase — campos prontos, não inventados, para quando o LLM existir.

**Verificação:** `pnpm run typecheck`, `lint`, `test` (todos os pacotes, incluindo `apps/api/src/copilot.test.ts` com 12 testes novos e `packages/db/src/{user-client,ai-runs}.test.ts` com 10 testes novos) e `pnpm run build` — todos verdes. Teste de integração RLS novo (`packages/db/src/rls.integration.test.ts`, describe `"ai_runs (observabilidade de custo do Copiloto, D-077)"`) não executável nesta máquina (sem Docker) — **confirmado pela CI depois do push**: job `integração` rodou os 255 testes do arquivo contra Postgres real, todos verdes, incluindo os seis casos do describe novo (próprio usuário, ADMIN da organização, sem papel elevado, outra organização, `anon`, insert direto negado) — prova de verdade das policies, não só leitura estática do SQL. Rota HTTP (`POST /v1/copilot/query`) não testada manualmente no navegador — não há UI consumindo ainda nesta fatia, então não há como haver essa verificação; a cobertura real é os testes de unidade da rota (`handleCopilotQuery`) e o teste de integração de RLS da tabela nova.

**Deploy confirmado, não só codificado** (mesmo padrão de D-065/D-072): `api-00014-8g5` (commit `e6dcb72`), 100% do tráfego, zero linha ERROR nos logs pós-deploy (`gcloud logging read`, janela de 15 min), `GET /health` respondendo com `startedAt` batendo o horário real do deploy — revisão nova de verdade, não resposta em cache de uma revisão antiga. `POST /v1/copilot/query` sem header `Authorization` devolve `401` (rota registrada, middleware de auth funcionando; caminho autenticado com sucesso não verificado ponta a ponta — mesma limitação de credencial de usuário real das entregas anteriores). Deploy exigiu preparo prévio: `SUPABASE_PUBLISHABLE_KEY` (env var nova, não segredo) precisou entrar em `infra/lib.sh`/`infra/deploy-cloud-run.sh` ANTES do deploy — sem ela `apps/api/src/env.ts` derrubaria o processo no boot (valida no start, não em runtime), o que teria quebrado TODAS as rotas existentes da `api`, não só a nova. Primeira tentativa de deploy falhou por faltar `MERCADO_LIVRE_CLIENT_ID` no ambiente local (não é segredo, mas precisa estar exportado para o script) — recuperado do próprio serviço `api` já publicado (`gcloud run services describe`) em vez de pedir de novo ao usuário, já que é um identificador público, não uma credencial secreta.

**Impacto:** `supabase/migrations/20260825120000_create_ai_runs.sql` (novo). `packages/db/src/user-client.ts` + `.test.ts` (novo, `createUserClient`), `packages/db/src/ai-runs.ts` + `.test.ts` (novo, `recordAiRun`), `packages/db/src/index.ts` (exports). `packages/contracts/src/copilot-tools.ts` (novo, schemas Zod das três ferramentas) + `index.ts`. `apps/api/src/copilot.ts` + `.test.ts` (novo), `apps/api/src/auth.ts` (`extractBearerToken` exportado), `apps/api/src/app.ts` (rota `POST /v1/copilot/query`), `apps/api/src/index.ts` (injeção de `copilot` deps), `apps/api/src/env.ts` + `env.test.ts` (`SUPABASE_PUBLISHABLE_KEY`). `packages/db/src/rls.integration.test.ts` (describe novo). `docs/API.md`, `docs/COPILOT.md`, `docs/DATABASE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. **Não fecha o item 7 por completo** — a parte determinística está pronta e testada; planner por linguagem natural, streaming SSE de verdade e UI de chat continuam bloqueados pela escolha de modelo/orçamento (`docs/COPILOT.md` secao 10), que é a próxima decisão real a resolver antes de continuar — não uma tarefa técnica a implementar sozinho.

## D-078 — Ação contextual "O que aconteceu?": primeira fatia, zero lógica nova

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 8) registrava "adicionar 'O que aconteceu?'" como o passo seguinte depois de D-077 fechar a parte determinística do Copiloto. `docs/PRODUCT_REQUIREMENTS.md` já descrevia o requisito desde a Fase 0: "KPIs, gráficos, produtos e contas relevantes poderão oferecer uma ação contextual para investigar alteração ou queda", retornando evidência principal, fatores secundários, relação temporal, impacto, confiança e próximos passos.

**Achado antes de escrever qualquer código**: o motor de diagnóstico já existia por completo e testado — `diagnoseSalesAnomaly`/`estimateImpactBrl` (`packages/domain/src/diagnostics/sales-anomaly.ts`, D-063) já produzem exatamente o contrato de diagnóstico (`docs/API.md` secao 5) e já são consumidos de duas formas: `/diagnostico` (tela dedicada, varre TODOS os SKUs da organização, um request) e o job diário da Central de Ações (D-064, mesmo cálculo, persistido em `actions`). O que faltava não era lógica de diagnóstico — era expor o MESMO cálculo, filtrado para UM SKU só, como uma ação embutida na tela onde o usuário já está olhando aquele SKU.

**Decisão 1 — Dashboard de SKU é a primeira (e única, nesta fatia) tela a ganhar o botão:** o motor de diagnóstico hoje só cobre sinal de VENDAS POR SKU (`get_sku_sales_baseline`) — não cobre KPIs agregados do Dashboard de Vendas (`/vendas`) nem diagnóstico por conta, que exigiriam sinais que não existem ainda (visitas, conversão, preço, estoque, Full, promoção, Ads, catálogo — já listados como lacuna pendente em `docs/HANDOFF.md`). Colocar o botão só onde o dado sustenta a resposta evita a mesma classe de problema que `docs/METRICS.md`/D-023 já proíbe: uma ação contextual que promete "o que aconteceu" e não tem evidência real para mostrar.

**Decisão 2 — `get_sku_sales_baseline` ganha `p_sku_id` opcional em vez de nascer uma RPC nova:** a alternativa óbvia seria duplicar a função com um filtro fixo por SKU. Rejeitada: seriam duas implementações da mesma fórmula (`docs/ARCHITECTURE.md` secao 7, "regra da fórmula única") que podem divergir com o tempo. Um parâmetro opcional, `null` por padrão, preserva o comportamento de TODOS os chamadores existentes (`/diagnostico`, o job da Central de Ações) sem exigir mudança neles — só quem passa `p_sku_id` explicitamente ganha o filtro. Mudar a ASSINATURA da função (não só o corpo) exige `drop function` explícito antes de recriar — `create or replace` sozinho criaria uma segunda função sobrecarregada em vez de substituir a original (mesma pegadinha já resolvida em `20260823163058_move_ledger_integrity_function_public.sql`).

**Decisão 3 — três estados explícitos, não um "sem anomalia" genérico:** `diagnoseSalesAnomaly` devolve `null` tanto para "amostra insuficiente" quanto para "dentro do padrão" — dois significados de negócio bem diferentes para o usuário ("não dá para comparar ainda" vs. "está tudo normal"). A Server Action distingue os dois ANTES de chamar a função pura (checando se a RPC devolveu linha nenhuma para o SKU — ela já filtra amostra mínima) em vez de alterar `diagnoseSalesAnomaly` para devolver um motivo — a função pura já é usada em produção (D-063/D-064) e seu contrato de retorno não precisa mudar para servir este caso novo.

**Decisão 4 — Server Action direta sob RLS, sem RPC de leitura nem rota de `api`:** mesma leitura que `/diagnostico`/`/vendas` já fazem, só que escopada a um SKU e disparada por clique em vez de no carregamento da página. Nenhuma chamada de IA, nenhum streaming — "O que aconteceu?" narrado por LLM é explicitamente opcional e posterior (`docs/COPILOT.md` secao 7: "a IA narra o contrato; não o produz"), fora de escopo desta fatia pela mesma razão que travou o planner do Copiloto em D-077 (decisão de modelo/orçamento pendente).

**Verificação:** `pnpm run typecheck`, `lint`, `test` e `pnpm run build` (monorepo completo) — todos verdes. Três testes de integração novos em `packages/db/src/rls.integration.test.ts` (describe `"get_sku_sales_baseline (Fase 6, Diagnóstico)"`, já existente): `p_sku_id` filtra para um SKU só, respeita a mesma amostra mínima do filtro geral, e o comportamento sem o parâmetro (todos os chamadores existentes) continua idêntico — não executável nesta máquina (sem Docker), **confirmado pela CI depois do push**: job `integração` rodou os 258 testes do arquivo contra Postgres real (255 anteriores + os 3 novos), todos verdes; job `aplicar migrations no Supabase Dev` confirmou a migration aplicando lá também. Nenhum teste de unidade novo para a Server Action (`diagnoseSku`) — mesmo padrão já estabelecido no projeto: Server Actions que só orquestram chamadas Supabase não têm teste próprio (`app/acoes/actions.ts`, `app/notificacoes/actions.ts`), a lógica de decisão testada é a função pura que elas chamam.

**Impacto:** `supabase/migrations/20260825130000_add_sku_filter_to_sales_baseline.sql` (novo). `apps/web/app/skus/[skuId]/actions.ts` (novo, `diagnoseSku`), `apps/web/app/skus/[skuId]/diagnosis-panel.tsx` (novo), `apps/web/app/skus/[skuId]/page.tsx` (botão integrado). `packages/db/src/rls.integration.test.ts` (+3 testes). `docs/PRODUCT_REQUIREMENTS.md`, `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. **Não fecha o item 8 por completo** — falta expandir para outras telas/sinais, trabalho incremental que depende de sinais de diagnóstico que ainda não existem, não de nenhuma decisão de produto pendente.

## D-079 — Sugestões de features: captura + Central de Sugestões, estruturação por IA continua pendente

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 9) registrava "adicionar sugestões estruturadas de features" como o passo seguinte depois de D-078. `docs/PRODUCT_REQUIREMENTS.md`/`docs/COPILOT.md` secao 8 já descreviam o requisito desde a Fase 0: usuários enviam ideias em texto livre, a IA gera uma versão estruturada (título, problema, objetivo, usuários impactados, fluxo sugerido, benefício esperado, critérios de aceite, dependências/riscos, complexidade) preservando o texto original, e uma Central de Sugestões com sete estados de triagem. Nada disso existia ainda — nem tabela, nem UI.

**Decisão 1 — mesma separação já usada em D-077/D-078: capturar e persistir agora, estruturar por IA quando o Copiloto tiver modelo:** dos dois pedaços do requisito, só um depende de LLM. "Usuários enviam ideias em texto livre" + "Central de Sugestões com estados de triagem" são um formulário e um fluxo de status — zero IA envolvida. "A IA gera... quando possível" é o pedaço que precisa do planner/modelo do Copiloto, ainda bloqueado pela mesma pendência de orçamento (`docs/COPILOT.md` secao 10) que já travou o item 7 por completo. Implementar só o que não depende da decisão pendente evita tanto inventar uma escolha de modelo sem autorização quanto travar o item inteiro esperando algo que só bloqueia metade dele.

**Decisão 2 — os nove campos estruturados entram no schema agora, nulos, sem UI de preenchimento manual:** alternativa rejeitada foi deixar as colunas de fora até a IA existir. Mesma lógica já registrada para `notification_preferences` (Fase 2) e `ai_runs` (D-077): é coluna barata agora e migration chata depois — quando o Copiloto tiver modelo, popular esses campos é só um `UPDATE`, sem alterar schema. **Sem UI de preenchimento manual** dos nove campos: o requisito atribui essa estruturação à IA especificamente ("a IA deve gerar"), não descreve um fluxo de humano digitando título/objetivo/critérios de aceite à mão — construir esse formulário rico seria inventar um requisito que não foi pedido.

**Decisão 3 — qualquer membro envia e lê; só ADMIN/GESTOR triagem:** "usuários autorizados poderão enviar" é vago sobre QUEM é autorizado. Interpretação adotada: enviar uma ideia de melhoria não é uma ação de risco (diferente de aprovar pedido de compra ou confirmar NF-e) — qualquer membro autenticado da organização pode. Mudar o ESTADO de uma sugestão (aprovar, planejar, recusar) é decisão de gestão de produto, restrita a ADMIN/GESTOR — mesma granularidade já usada em `purchase_orders`/`actions`. Leitura é compartilhada (qualquer membro vê todas as sugestões da organização, não só as próprias) — é uma central, não uma caixa de entrada privada.

**Decisão 4 — RLS direta, sem RPC, para as duas escritas:** inserir uma sugestão (`created_by = auth.uid()`) e mudar o status (`has_role(['ADMIN','GESTOR'])`) são exatamente o tipo de escrita simples no escopo do usuário que `docs/ARCHITECTURE.md` secao 4 já descreve como não precisando de RPC — mesmo padrão de `notification_preferences`/`notification_recipients` (D-073/D-076).

**Verificação:** `pnpm run typecheck`, `lint`, `test` e `pnpm run build` (monorepo completo) — todos verdes. Sete testes de integração novos em `packages/db/src/rls.integration.test.ts` (describe `"feature_suggestions (Sugestões de features, D-079)"`): inserção com texto preservado, usuário não insere em nome de outro, leitura compartilhada na organização, isolamento entre organizações, ANALISTA não muda status, ADMIN muda status de sugestão de outro membro, `anon` sem acesso nenhum — não executável nesta máquina (sem Docker).

**Bug real encontrado pela CI, corrigido em `3b468ca`:** o teste "ANALISTA não muda o status" originalmente esperava que o `UPDATE` REJEITASSE, mesmo padrão do `INSERT` barrado por `WITH CHECK` (teste imediatamente acima no mesmo describe). Errado: a cláusula `USING` de uma policy de `UPDATE` filtra quais linhas o comando consegue VER, não gera exceção quando nega — o resultado real é o `UPDATE` afetar ZERO linhas em silêncio, não uma promise rejeitada. Mesmo comportamento já documentado no próprio arquivo desde D-073 ("usuário não marca a notificação de outro usuário como lida" usa `RETURNING` + `toHaveLength(0)`, não `rejects.toThrow`) — só não copiei o padrão certo na primeira escrita. Corrigido para `RETURNING status` + `expect(rows).toHaveLength(0)`. CI confirmou os 265 testes do arquivo passando contra Postgres real depois da correção (258 anteriores + 7 novos). Nenhum teste de unidade novo para as Server Actions (`createSuggestion`/`updateSuggestionStatus`) — mesmo padrão já estabelecido: Server Actions que só orquestram uma escrita direta sob RLS não têm teste próprio neste projeto.

**Impacto:** `supabase/migrations/20260825140000_create_feature_suggestions.sql` (novo). `apps/web/app/sugestoes/{page,actions,new-suggestion-form,suggestion-row}.tsx` (novos). `apps/web/components/shell.tsx` (link "Sugestões" na nav, item solto). `apps/web/lib/labels.ts` (`featureSuggestionStatusLabel`, `statusTone` estendido). `packages/db/src/rls.integration.test.ts` (+7 testes). `docs/PRODUCT_REQUIREMENTS.md`, `docs/COPILOT.md`, `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. **Não fecha o item 9 por completo** — estruturação por IA depende da mesma decisão de modelo/orçamento que trava o item 7, não de trabalho técnico adicional.

## D-080 — Simulador de decisão: mesma fórmula já em produção, três incógnitas diferentes

**Contexto:** `docs/HANDOFF.md` ("Próxima sequência recomendada", item 10, o último da sequência) registrava "adicionar simuladores somente quando houver base matemática confiável". `docs/PRODUCT_REQUIREMENTS.md` já descrevia o requisito desde a Fase 0: cobertura com determinado estoque, data estimada de ruptura conforme premissa explícita, quantidade necessária para X dias de cobertura, e margem aproximada quando custos estiverem disponíveis — "toda simulação deve exibir as premissas e nunca ser apresentada como certeza".

**Achado antes de escrever qualquer código**: três das quatro perguntas do requisito são a MESMA fórmula já em produção desde D-058 (`get_stock_coverage`, `dias_de_cobertura = estoque_local ÷ venda_média_diária`), só resolvida para uma incógnita diferente cada vez — cobertura resolve para `dias`, ruptura resolve para `data` (dias × ritmo de venda, a partir de hoje), quantidade necessária resolve para `estoque` (dias desejados × ritmo de venda). Não havia métrica nova para inventar nem base matemática para validar — só álgebra sobre uma fórmula já testada e usada há dois meses.

**Decisão 1 — cálculo em `@sb/domain`, puro, rodando no CLIENTE, não numa RPC nova:** as três funções (`simulateCoverageDays`/`simulateRequiredQuantity`/`simulateRuptureDate`, `packages/domain/src/inventory/coverage-simulation.ts`) não fazem I/O — recebem números e devolvem números. Diferente de `get_sku_sales_baseline`/`get_stock_coverage` (que agregam sobre milhares de linhas, pertencem ao banco por `docs/ARCHITECTURE.md` secao 21), aqui a "agregação" já aconteceu — o usuário está simulando um CENÁRIO HIPOTÉTICO a partir de dois números que ele mesmo digita, não recalculando sobre dado bruto. Rodar no cliente via `useMemo` a cada tecla evita um round-trip ao servidor por ajuste de premissa, sem violar a regra da fórmula única (`docs/ARCHITECTURE.md` secao 7) — a fórmula SQL de `get_stock_coverage` continua sendo a "real" para o dado observado; a de `@sb/domain` é a mesma fórmula, documentada explicitamente como espelho, aplicada a um input hipotético.

**Decisão 2 — `get_stock_coverage` ganha `p_sku_id` opcional só para PRÉ-PREENCHER a premissa inicial, não para calcular a simulação:** o simulador precisa de um ponto de partida razoável (estoque atual, venda média real do SKU) em vez de nascer zerado. Buscar isso exigiria rodar `get_stock_coverage` para a organização inteira e filtrar em JavaScript (violaria a secao 21) ou dar ao RPC o mesmo filtro opcional já usado em `get_sku_sales_baseline` (D-078) — mesmo padrão, mesma razão, `drop function` explícito antes de recriar (mudança de assinatura, não `create or replace`).

**Decisão 3 — margem aproximada fica explicitamente FORA de escopo, não implementada com um valor aproximado:** confirmado via `docs/METRICS.md` ("margem depende de custo cadastrado por SKU") e busca nas migrations que a única coluna de custo existente é `purchase_order_items.unit_cost` — por PEDIDO de compra, não consolidada por SKU (um SKU comprado em pedidos diferentes, preços diferentes, não tem "o" custo). O próprio requisito já previa essa condição ("quando custos estiverem disponíveis") — implementar mesmo assim, usando o custo do pedido mais recente ou uma média arbitrária, seria inventar uma métrica sem base confiável, exatamente o que o requisito pede para evitar.

**Decisão 4 — premissas sempre visíveis e editáveis, nunca escondidas atrás de um botão "calcular":** requisito explícito ("nunca ser apresentada como certeza"). `SimulatorPanel` mostra os campos de estoque hipotético e venda média diária ao lado de cada resultado, pré-preenchidos com o dado real mas livremente editáveis — o resultado atualiza junto com o campo, não há estado "calculando" nem confirmação separada que sugira um cálculo autoritativo.

**Verificação:** `pnpm run typecheck`, `lint`, `test` e `pnpm run build` (monorepo completo) — todos verdes, incluindo 14 testes novos em `packages/domain/src/inventory/coverage-simulation.test.ts` (280 no total em `@sb/domain`, 266 anteriores + 14 novos): arredondamento, venda zero devolvendo `null` (nunca "infinito"), estoque zero com venda real devolvendo `0` (não `null` — são significados diferentes), rejeição de input negativo, arredondamento para cima na quantidade necessária, aritmética de data exata. Dois testes de integração novos em `packages/db/src/rls.integration.test.ts` (describe `"get_stock_coverage (D-058, Fase 5B)"`, já existente): `p_sku_id` filtra para um SKU só (mesmo resultado do teste sem filtro, agora isolado), e o comportamento sem o parâmetro continua trazendo o SKU entre todos da organização — não executável nesta máquina (sem Docker), **confirmado pela CI depois do push**: job `integração` rodou os 267 testes do arquivo contra Postgres real (265 anteriores + os 2 novos), todos verdes; job `aplicar migrations no Supabase Dev` confirmou a migration aplicando lá também.

**Impacto:** `packages/domain/src/inventory/coverage-simulation.ts` (novo), `coverage-simulation.test.ts` (novo), `inventory/index.ts` (+2 exports). `supabase/migrations/20260825150000_add_sku_filter_to_stock_coverage.sql` (novo). `apps/web/app/skus/[skuId]/simulator-panel.tsx` (novo), `page.tsx` (query paralela + painel integrado). `packages/db/src/rls.integration.test.ts` (+2 testes). `docs/PRODUCT_REQUIREMENTS.md`, `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md` atualizados. **Fecha o item 10, e com ele a sequência inteira de "Próxima sequência recomendada"** (itens 2-10) — o que resta do Copiloto/sugestões estruturadas (itens 7 e 9) segue bloqueado pela mesma decisão de modelo/orçamento pendente, não por falta de trabalho técnico.

## D-081 — Bug real de produção: get_sku_sales_baseline multiplicava linhas para SKU vendido em duas contas

**Contexto:** `docs/HANDOFF.md` ("Pendências técnicas imediatas", item 1) pedia para confirmar `maintenance.reconcile-balances` e a sincronização de visitas no ciclo natural do Cloud Scheduler, a partir de 2026-08-25 — item que fecharia o Checkpoint pré-Fase 7 por completo. Ao medir os logs reais de produção (não presumir, a própria regra que o checkpoint existe para impor), o job `diagnostics.detect-sales-anomalies` (Central de Ações, D-064, agendado diariamente às 8h/SP) apareceu com `job_failed`, `reason: "ON CONFLICT DO UPDATE command cannot affect row a second time"`, três tentativas seguidas, todas falhando.

**Achado:** o erro só pode acontecer se o upsert em `actions` (`onConflict: "organization_id,dedup_key"`, `apps/worker/src/handlers/detect-sales-anomaly-actions.ts`) recebesse duas linhas com o MESMO `dedup_key` no mesmo lote — e `dedup_key` é `sales_anomaly:${skuId}:${asOf}`, então só duas linhas para o MESMO SKU no MESMO dia explicariam. Rastreado até `get_sku_sales_baseline` (D-063): a tabela fonte, `daily_sku_metrics`, tem grão POR CONTA (`unique nulls not distinct (ml_account_id, sku_id, metric_date)`, `20260821182620_create_daily_sales_metrics.sql`) — um SKU vendido em duas contas Mercado Livre no mesmo dia gera duas linhas. As CTEs `weekday_history`/`current_day` da função liam essas linhas sem somar entre contas antes do join contra `baseline` (já agrupado por `sku_id`), multiplicando a saída. Conferidas as outras três funções que leem a mesma tabela (`get_stock_coverage`, `get_sku_dashboard`, `get_sku_abc_curve`) — todas já somavam corretamente por `sku_id` antes de qualquer outra coisa; `get_sku_sales_baseline` era a única exceção, mascarada desde 2026-08-24 até uma venda multi-conta de verdade acontecer.

**Decisão — corrigir a função (mesma assinatura, `create or replace`), não o handler que a chama:** a alternativa de deduplicar `rows` no `detect-sales-anomaly-actions.ts` antes do upsert (ex.: `Map` por `sku_id`) foi rejeitada — trataria o sintoma no consumidor em vez da causa na fonte, deixando `/diagnostico` (que também consome `get_sku_sales_baseline`, com o MESMO bug de duplicação/distorção silenciosa de média) sem correção. `docs/ARCHITECTURE.md` secao 21 ("zero agregação em JS") e a "regra da fórmula única" (secao 7) apontam para o mesmo lugar: a soma entre contas pertence à SQL que já é a fonte de verdade da métrica, não a uma camada de defesa no chamador.

**Efeito duplo do bug, não só o crash observado:** além de duplicar a linha de saída (o crash), a mesma falta de agregação inflava silenciosamente a amostra de "últimas 8 ocorrências do mesmo dia da semana" quando a venda multi-conta caía numa data histórica (não só no dia atual) — duas linhas da mesma data contando como duas ocorrências distintas, distorcendo média e desvio padrão sem nenhum erro visível. Sem este achado, `/diagnostico` continuaria mostrando números levemente errados para qualquer SKU vendido em mais de uma conta, sem sinal de que algo estava errado.

**Verificação:** `pnpm run typecheck`, `lint`, `test` e `pnpm run build` (monorepo completo) — todos verdes. Um teste de integração novo em `packages/db/src/rls.integration.test.ts` (describe `"get_sku_sales_baseline (Fase 6, Diagnóstico)"`, já existente): SKU vendido em duas contas no mesmo dia (uma ocorrência histórica dividida 6+4, o dia atual dividido 5+3) devolve exatamente UMA linha, `current_units_sold` somado (8), `sample_count` correto (4, não 5) — reproduz a condição exata que quebrou o upsert em produção. **Confirmado pela CI depois do push**: job `integração` rodou os 268 testes do arquivo contra Postgres real (267 anteriores + o novo), todos verdes; job `aplicar migrations no Supabase Dev` confirmou a migration aplicando lá também. **Confirmado contra dado real de produção, não só fixture**: `gcloud scheduler jobs run v3-detect-sales-anomalies` disparado manualmente depois da migration aplicada — `detect_sales_anomaly_actions_done` com 138 sinais avaliados e 25 ações persistidas, ZERO `job_failed`, ZERO log de severidade WARNING/ERROR na janela — o mesmo job que falhou três vezes seguidas mais cedo hoje completou limpo com o mesmo dado real que causou o crash original.

**Impacto:** `supabase/migrations/20260825160000_fix_sku_sales_baseline_multi_account_grain.sql` (novo). `packages/db/src/rls.integration.test.ts` (+1 teste, fixtures de segunda conta). `docs/DATABASE.md`, `docs/HANDOFF.md` atualizados. Nenhuma mudança em `apps/api`/`apps/worker` — a correção é inteiramente na função SQL, aplicada pela migration, sem deploy de Cloud Run necessário. **Checkpoint pré-Fase 7 fechado por completo em 2026-08-25** — os dois itens confirmados no mesmo dia, sem esperar o ciclo natural de amanhã: item "sincronização de visitas" — as 3 contas ML completaram `sync_listing_visits_snapshot_done` com `items_failed: 0`, apesar de 429 intermitente do Mercado Livre absorvido pelo retry existente (sem achado novo, já documentado em D-070). Item "reconcile-balances" — `triggerBalanceReconciliation` falhou no ciclo natural das 9h/UTC com "JWT issued at future" ao listar organizações (erro visível graças ao log de D-067, mas sem retry automático — `retryConfig.maxRetryDuration: "0s"` no Cloud Scheduler); em vez de esperar o ciclo de 2026-08-26, disparado manualmente (`gcloud scheduler jobs run v3-reconcile-balances`, autorização explícita do usuário) às 13h29/UTC do mesmo dia — rodou limpo, `balances_reconciled` com 1000 SKUs comparados e 896 ajustes, confirmando que a falha das 9h era transitória (a MESMA instância `api` já tinha feito outras duas chamadas ao Supabase bem-sucedidas segundos depois da falha original, evidência que já apontava nessa direção).

## D-082 — Copiloto: modelo, orçamento e política de custo decididos pelo usuário

**Contexto:** `docs/COPILOT.md` secao 10 registrava desde D-077 a única pendência genuína de produto que bloqueia tudo que depende de LLM no Copiloto (planner por linguagem natural, narração de evidências, streaming SSE de verdade, UI de chat, estruturação por IA das sugestões de feature de D-079) — decisão de custo recorrente real, que a regra do projeto exige confirmação explícita do usuário, mesmo em sessão autônoma. Com a "Próxima sequência recomendada" e o Checkpoint pré-Fase 7 fechados (D-081), essa era a única coisa que faltava para poder avançar.

**Decisão (usuário, 2026-08-25):**

- **Fornecedor/modelo: Anthropic Claude Haiku 4.5.** Escolhido para narração curta de um contrato de evidências já pronto e escolha entre poucas ferramentas registradas — não geração longa nem raciocínio complexo, então o modelo mais barato da família é suficiente. Achado no caminho: existe uma `ANTHROPIC_API_KEY` herdada da V2 no projeto Vercel, sem nenhum consumidor (`docs/HANDOFF.md` linha 768, registro histórico da Fase 1) — **decisão: NÃO reaproveitar**, gerar chave nova direto no Secret Manager do GCP para `apps/api` (padrão já usado por `SUPABASE_SERVICE_ROLE_KEY`/`MERCADO_LIVRE_CLIENT_SECRET`, `infra/lib.sh`), evitando depender de uma chave de origem/validade incerta e no lugar errado (Vercel/`apps/web`, quando o Copiloto roda inteiro em `apps/api`/Cloud Run).
- **Orçamento: R$100/mês.** Teto inicial conservador — sobe depois de observar uso real, mesmo raciocínio já aplicado a outras decisões de escopo mínimo deste projeto.
- **Política ao atingir o teto: AVISAR, não bloquear.** Chamadas de LLM continuam permitidas mesmo depois do teto ultrapassado — o usuário prioriza não interromper a experiência sobre o risco de exceder o orçamento combinado. Registrado explicitamente para não ser confundido com a alternativa mais conservadora (bloquear e cair no curto-circuito), que foi oferecida e não escolhida.

**Chave provisionada em 2026-08-25**, mesmo dia da decisão: `ANTHROPIC_API_KEY` criada no Secret Manager do projeto `speedbikers-gestao-v3` (`gcloud secrets create`, réplica automática), acesso concedido a `v3-api-runtime` (`roles/secretmanager.secretAccessor`) — só a `api`, o `worker` nunca chama a Anthropic. Reproduzível: `infra/lib.sh` ganhou `SECRET_ANTHROPIC_KEY`, `infra/setup-dev.sh` ganhou a concessão de IAM (mesmo padrão de `SECRET_SUPABASE_KEY`), `infra/deploy-cloud-run.sh` inclui o secret no `--set-secrets` do deploy da `api`. A chave em si nunca foi escrita em nenhum arquivo do repositório nem em texto persistente fora do Secret Manager.

**Primeira ferramenta com LLM implementada no mesmo dia: `narrate_sku_diagnosis`** — escolhida entre narração/planner/orçamento porque tem a menor superfície nova (só soma uma camada de texto sobre um pipeline já implementado e testado, D-078) e produz valor visível imediato. Preço do Haiku 4.5 conferido na documentação oficial da Anthropic no momento da implementação (não presumido de memória, que pode estar desatualizada): $1/MTok entrada, $5/MTok saída, sem cache/batch — fixado em código (`apps/api/src/anthropic-client.ts`), não em fórmula dependente de configuração externa.

**Decisão de design — a `api` REVALIDA a permissão do SKU mas NÃO recalcula o diagnóstico:** o contrato de diagnóstico chega no corpo do pedido já calculado por `apps/web` (D-078, que já roda sob RLS do usuário). A alternativa de re-executar `get_sku_sales_baseline`/correlação de eventos dentro da `api` foi rejeitada — duplicaria a agregação pesada só para narrar um resultado que o `web` já tem. Em vez disso, a `api` faz uma checagem leve (`select id from skus where id = <escopo.skuId>` sob a RLS do próprio `UserClient` do chamador) antes de chamar o LLM: garante que o usuário alcança aquele SKU (nunca vazamento entre organizações), sem garantir que os NÚMEROS do contrato batem com o banco em tempo real. O pior caso de um contrato forjado pelo cliente é o próprio usuário gastar crédito de LLM da própria organização narrando lixo sobre um SKU que ele já pode ver — não uma escalada de privilégio.

**Primeira vez que `apps/web` chama `apps/api` autenticado com sessão de usuário** para uma ação de LEITURA/narração (precedente já existia para escrita: `confirm-apply-form.tsx`/upload de planilha) — mesmo padrão adotado: fetch client-side, `access_token` da sessão Supabase do navegador no header `Authorization`, nunca a chave da Anthropic chega perto do `web`/Vercel.

**Verificação:** `pnpm run typecheck`, `lint`, `test` e `pnpm run build` (monorepo completo) — todos verdes, incluindo 8 testes novos (`apps/api/src/anthropic-client.test.ts`, 4 testes: cálculo de custo real, múltiplos blocos de texto, resposta vazia lança erro, parâmetros corretos passados ao SDK; `apps/api/src/copilot.test.ts`, +4 testes: RLS recusa SKU não encontrado sem chamar o LLM, narra citando o contrato, `ai_runs` grava `llm_used=true`/`cost_usd` real). `bash -n` limpo nos três scripts de infra editados, ordem `worker` antes de `api` inalterada, sem CRLF. **Verificação de UI, melhor do que o previsto**: dev server local sem erro de build/runtime, página `/login` carrega limpa, rota `/skus/[id]` redireciona corretamente para login sem sessão (nenhum erro 500). **Confirmado pela CI depois do push**: o job `e2e` (Playwright, login real, Postgres local) roda `sku-dashboard.spec.ts`, que visita `/skus/[skuId]` de verdade — a MESMA página que agora contém o `DiagnosisPanel` com o botão "Narrar com IA" — e passou (5/5 specs verdes), confirmando que o componente novo não quebra renderização nem hydration. **Não verificado**: o clique no botão em si e a chamada real à Anthropic (nenhum spec Playwright insere uma anomalia de venda no seed nem clica em "Narrar com IA" — só a carga inicial da página é exercitada). **Deployado e confirmado em 2026-08-25**: `api-00015-zzb` (commit `bf3ea66`), 100% do tráfego, zero linha ERROR nos logs pós-deploy. `api_started` sem erro no boot — confirma que a validação Zod de `ANTHROPIC_API_KEY` (`env.ts`) passou contra a chave real do Secret Manager. `GET /health` respondendo com `startedAt` batendo o horário exato do log de boot (revisão nova de verdade, não cache). `POST /v1/copilot/query` com `tool: "narrate_sku_diagnosis"` sem autenticação devolvendo `401 unauthorized` — rota registrada, middleware de auth funcionando (caminho autenticado com chamada real à Anthropic não testado ponta a ponta, sem credencial de usuário real disponível, mesma limitação de D-077).

**Impacto:** `apps/api/src/anthropic-client.ts` (novo), `copilot.ts` (nova ferramenta + dispatcher generalizado para `llmUsed`/`costUsd` reais), `env.ts` (+`ANTHROPIC_API_KEY`), `index.ts` (injeta o cliente). `packages/contracts/src/copilot-tools.ts`/`index.ts` (schemas do contrato de diagnóstico + nova tool). `apps/web/app/skus/[skuId]/diagnosis-panel.tsx` (botão "Narrar com IA"). `infra/lib.sh`, `infra/setup-dev.sh`, `infra/deploy-cloud-run.sh` (secret provisionável/deployável). `docs/API.md`, `docs/COPILOT.md`, `docs/DEPLOYMENT.md` atualizados. **Ainda pendente, sem bloqueio de decisão de produto**: planner por linguagem natural, streaming SSE de verdade, UI de chat, estruturação por IA das sugestões de feature (D-079), e o mecanismo que soma `ai_runs.cost_usd` do período e avisa o ADMIN ao ultrapassar o teto (o dado já é gravado desde esta entrega — falta o job que lê e avisa).

## D-083 — Fase 7B: APIs oficiais de Perguntas/Mensagens confirmadas; ingestão read-only antes de resposta

**Contexto:** primeiro item da ordem incremental da Fase 7B (D-071). `docs/MERCADO_LIVRE.md` secao 2.12 estava vazia de propósito: nenhum código ou modelo de dados de SAC poderia ser criado antes de confirmar endpoints, payloads, permissões, webhooks, limites e fontes de prazo vigentes.

**Pesquisa oficial (2026-08-25):** a permissão funcional "Comunicação pré e pós-venda" cobre comunicação pré/pós-compra e acesso a `questions`, `messages`, `claims` e `returns`; cada recurso ainda governa suas ações efetivamente disponíveis. Perguntas usam `GET /my/received_questions/search?api_version=4`/`GET /questions/{id}?api_version=4` e `POST /answers`; limite de 2.000 caracteres, webhook geral `questions` e métrica agregada de tempo de resposta, mas sem `due_date` individual. Mensagens usam recursos por pack/pedido e seller, webhook tipificado `messages` (`created`/`read`), redundância por `/messages/unread`, limite de 350 caracteres, pools separados de 500 rpm para leitura e escrita e anexos de até 25 MB. No MLB, a arquitetura de Agente de Mensageria exige o ID do agente no destinatário de determinados fluxos e pode bloquear a conversa após 48 horas úteis. Claims expõem prazo em `/detail`/`available_actions`, têm mensagens próprias e tratam mediação como `type: mediations`, não como recurso raiz separado.

**Decisão 1 — primeiro corte continua read-only:** webhook é o caminho principal; reconciliação de perguntas e conversas não lidas cobre perdas. A V3 persiste estado remoto idempotentemente e só depois constrói caixa de entrada. Resposta fica para etapa posterior, sempre comando privilegiado da `apps/api` após confirmação humana (D-071).

**Decisão 2 — ingestão de mensagens nunca marca como lida:** toda consulta de conversa feita pelo sincronizador usa `mark_as_read=false`. Marcar como lida é ação humana separada; um GET técnico não pode alterar silenciosamente o estado operacional no Mercado Livre.

**Decisão 3 — SLA tem fonte por canal:** pergunta não tem prazo individual remoto, então eventual SLA de pergunta é regra interna explicitamente rotulada; mensagem intermediada usa as 48 horas úteis documentadas quando aplicável; claim usa `detail.due_date` ou `available_actions[].due_date`. A V3 não transforma a métrica agregada `questions/response_time` em prazo individual inventado.

**Decisão 4 — identidade não depende do comprador em `from/to`:** no fluxo de Agente de Mensageria do MLB esses campos podem conter o ID do agente. O modelo deve se apoiar em conta + recurso remoto (question/message/claim) + pack/order, preservando `from/to` apenas como atributos do payload.

**Impacto:** `docs/MERCADO_LIVRE.md` secao 2.12 e tabela de endpoints preenchidas; `docs/API.md` deixa de tratar payloads como desconhecidos; primeiro item da Fase 7B marcado concluído em `docs/ROADMAP.md`; `docs/HANDOFF.md` aponta o modelo unificado de atendimento como próxima etapa. Também reconciliados marcadores stale de Fase 7/Copiloto e contagem de filas. Nenhum código, migration, segredo ou infraestrutura.

## D-084 — Modelo unificado de atendimento preserva a identidade de cada canal; mediação/devolução são facetas do claim

**Contexto:** segunda etapa incremental da Fase 7B, registrada no HANDOFF após D-083. A pesquisa oficial já tinha provado que perguntas, mensageria pós-venda e claims não compartilham o mesmo recurso, paginação, ciclo, prazo ou endpoint de resposta. Ao mesmo tempo, o produto exige uma única caixa de entrada, filtros por pedido/SKU e histórico operacional auditável. A tarefa desta decisão foi somente documental; nenhuma migration ou chamada externa foi criada.

**Decisão 1 — projeção unificada, identidade externa preservada:** `support_cases` tem três canais: `QUESTION` (uma pergunta, chave `question:{id}`), `POST_SALE_MESSAGE` (uma conversa por conta + pack, ou pedido fallback, chave `message:pack:{id}`/`message:order:{id}`) e `CLAIM` (um claim, chave `claim:{id}`). Constraint física futura: `(organization_id, ml_account_id, channel, external_case_key) unique`. `buyer_id`/`from/to` não participam da identidade (D-083).

**Decisão 2 — mediação e devolução não duplicam case:** `type = mediations` e a presença de `return` em `related_entities` são facetas do mesmo `CLAIM`; podem coexistir. As abas “Mediações” e “Devoluções” são filtros e podem mostrar a mesma linha. Mensagens do claim pertencem ao transcript desse claim. Conversa pós-venda comum e claim ligados ao mesmo pedido continuam cases distintos, relacionados por links — juntar os dois faria um status/prazo sobrescrever o outro.

**Decisão 3 — vínculo é muitos-para-muitos e tipado:** um pack pode reunir vários pedidos/SKUs; portanto `support_cases.order_id`/`sku_id` único seria perda de informação. `support_case_links` relaciona cases a `orders`, `skus` e `listings` com FKs reais e índices próprios; entidade externa sem tabela local usa par explícito de tipo/ID. A tabela exige exatamente um alvo por linha e unicidade parcial por tipo. `support` só lê esses domínios; nunca escreve neles.

**Decisão 4 — status interno fechado em cinco valores:** `NOVO`, `EM_ATENDIMENTO`, `AGUARDANDO_CLIENTE`, `AGUARDANDO_MERCADO_LIVRE`, `RESOLVIDO`. Não há `FECHADO` interno; fechamento remoto fica separado. Primeira projeção pode nascer resolvida se já respondida/encerrada, e nova atividade inbound reabre para `NOVO`. Fora disso, sync não sobrescreve decisão humana. Prioridade interna: `NORMAL`, `ALTA`, `CRITICA`. Triagem/resolução será transação única que atualiza case e acrescenta evento, autorizada a `ADMIN`/`GESTOR`/`OPERADOR` com acesso à conta; `ANALISTA`/`VISUALIZADOR` leem apenas.

**Decisão 5 — SLA é coleção com fonte, não coluna única:** `support_case_deadlines` permite `FIRST_RESPONSE`, `NEXT_ACTION`, `RESOLUTION`. Pergunta só terá prazo por política interna futura; mensagem intermediada preserva `MLB_AGENT_48_BUSINESS_HOURS`, sem fingir que 48 horas úteis são 48 horas corridas; claim usa `detail.due_date`/`available_actions[].due_date`. Prazo ausente continua ausente. A caixa de entrada usa o menor deadline ativo conhecido.

**Decisão 6 — transcript atual em L1, auditoria em L2:** `support_messages` é projeção mutável o suficiente para refletir status/moderação atual; `body_state` diferencia conteúdo vazio, banido, moderado ou indisponível. `support_case_events` é append-only e registra mudanças relevantes com `dedup_key`. Nem todo evento de auditoria vira `domain_event`: somente transições escolhidas são promovidas a `support.*`, evitando avalanche de notificações.

**Decisão 7 — idempotência física em todas as entradas:** cases por chave de canal, mensagens por `(support_case_id, external_message_key)`, deadlines por case/tipo/fonte/referência, anexos por mensagem/chave remota, eventos por `(organization_id, dedup_key)`. Webhook e reconciliação convergem por `upsert`; nunca fazem `SELECT` seguido de `INSERT`. ID de mensagem remoto é preferido; recurso sem ID confirmado exige fingerprint determinístico documentado depois de observar o payload real, nunca posição no array.

**Decisão 8 — resposta continua fora do primeiro corte e tem auditoria própria:** `support_reply_attempts` será append-only, um registro por `client_request_id`, com usuário, sugestão opcional, texto final, resultado e ID/erro remoto. Sucesso também gera mensagem outbound; falha não vira mensagem fictícia. Envio exige `ADMIN`/`GESTOR`/`OPERADOR` com acesso à conta, confirmação humana e refresh do estado/ações remotas pela `apps/api`. `knowledge_entries`, `reply_templates` e `support_reply_attempts` ficam fora da primeira migration read-only.

**Segurança e forma física aprovadas:** todas as tabelas do núcleo duplicam `organization_id`/`ml_account_id` com coerência garantida por FK composta ao case; RLS direta via `private.has_account_access`; `authenticated` só lê no primeiro corte, `service_role` ingere, `anon` não acessa. FKs recebem índices explícitos e a inbox usa índices compostos/parciais para abertos, conta, responsável e deadline. A checagem do changelog vigente do Supabase encontrou a mudança de 2026-04-28: tabelas novas deixam de receber exposição automática à Data API; os `GRANTs` explícitos da futura migration são a opção deliberada por tabela/papel, sem confiar no default da plataforma.

**Impacto:** modelo detalhado em `docs/DATABASE.md`; fronteira de domínio em `docs/ARCHITECTURE.md`; status, prazo e identidade em `docs/PRODUCT_REQUIREMENTS.md`; papel de resposta em `docs/API.md`; separação auditoria/notificação em `docs/NOTIFICATIONS.md`; contexto do Copiloto em `docs/COPILOT.md`; mapeamento externo em `docs/MERCADO_LIVRE.md`; checklist e HANDOFF avançam para a primeira migration read-only. Nenhum código, migration, segredo ou infraestrutura.

## D-085 — Núcleo read-only de atendimento nasce isolado da integração externa, com escopo físico por conta e eventos append-only

**Contexto:** D-084 aprovou o modelo unificado e registrou como próxima pequena etapa somente sua materialização física. O objetivo era provar identidade, segurança e idempotência antes de adicionar payloads do Mercado Livre, filas, webhooks, UI ou comandos de resposta. Essa separação segue o padrão já usado no projeto: schema e fronteiras primeiro; escrita real depois.

**Decisão 1 — primeira migration contém apenas as seis tabelas necessárias ao read model:** `20260825170000_create_support_read_model.sql` cria `support_cases`, `support_messages`, `support_case_links`, `support_case_deadlines`, `support_attachments` e `support_case_events`. `knowledge_entries`, `reply_templates` e `support_reply_attempts` permanecem fora; não existe envio de resposta nem Base de Conhecimento nesta fatia.

**Decisão 2 — coerência de organização e conta é estrutural, não responsabilidade do worker:** `support_cases` expõe a chave composta única `(id, organization_id, ml_account_id)` e mensagens, links, deadlines e eventos referenciam esse escopo completo. Anexos referenciam o mesmo escopo da mensagem. `support_case_links` exige exatamente um alvo e um trigger privado confirma que pedido/anúncio pertencem à mesma organização+conta e SKU à mesma organização. Um bug de mapper não consegue pendurar dado de outra conta no case.

**Decisão 3 — identidade e estados aprovados viraram constraints executáveis:** case é único por organização+conta+canal+chave remota; o prefixo da chave precisa concordar com o canal e o ID externo; mediação/devolução só existem em `CLAIM`; `RESOLVIDO` exige `resolved_at` e qualquer outro estado exige `resolved_at` nulo. Mensagens, deadlines, anexos e eventos têm as chaves idempotentes de D-084, incluindo `UNIQUE NULLS NOT DISTINCT` nos prazos para que referência nula também colida.

**Decisão 4 — auditoria L2 não aceita correção destrutiva:** `support_case_events` recebe apenas `SELECT`/`INSERT` pelo `service_role` e um trigger recusa `UPDATE`/`DELETE`, inclusive para o backend privilegiado. Corrigir uma projeção L1 não reescreve o histórico; uma nova observação precisa entrar como novo evento deduplicado.

**Decisão 5 — Data API recebe privilégio mínimo explícito:** RLS das seis tabelas usa `private.has_account_access(ml_account_id)`. `authenticated` tem somente `SELECT`; `anon` não tem acesso; `service_role` faz CRUD nas cinco projeções L1 e apenas leitura/inserção no histórico L2. A migration primeiro revoga de `anon`, `authenticated` e `service_role`, depois concede exatamente o necessário, sem depender dos defaults em transição da plataforma Supabase.

**Decisão 6 — próxima fatia é Perguntas sem adaptador de rede:** primeiro criar contratos/fixtures oficiais, mapper puro e persistência idempotente para pergunta e eventual resposta em `support_cases`/`support_messages`/links. A API externa, o job/fila, o webhook, `domain_events`, a UI e o envio continuam separados. Isso permite provar reprocessamento, conteúdo banido/moderado e pergunta já respondida sem misturar falha HTTP com falha de transformação ou banco.

**Verificação local:** cadeia completa aplicada do zero com `supabase db reset`; tipos regenerados com `pnpm --filter @sb/db run gen:types`; `supabase db lint --local --level warning` sem achados; 38 testes novos de integração, totalizando 305, cobrem RLS por conta/organização, `anon`, GRANTs, FKs de escopo, links tipados, constraints, duplicidade e append-only; `pnpm run check` e `pnpm run build` verdes. Nenhuma migration remota, deploy, secret ou chamada ao Mercado Livre foi executada.

**Impacto:** migration nova, tipos gerados e testes de integração em `packages/db`; documentação de banco, arquitetura, produto, API, Mercado Livre, notificações, Copiloto, ROADMAP e HANDOFF avança da modelagem para a primeira fatia de ingestão de Perguntas.

## D-086 — Perguntas ganham contrato externo, projeção pura e persistência idempotente antes do adaptador de rede

**Contexto:** D-085 registrou como próxima pequena etapa provar, isoladamente, como uma Pergunta do Mercado Livre vira o read model de atendimento. Misturar nessa prova chamada HTTP, refresh de token, fila, webhook e banco tornaria impossível separar erro de protocolo, transformação ou persistência. A etapa também precisava cobrir estados que não aparecem no caminho feliz — pergunta já respondida, texto banido, moderação e reentrega.

**Decisão 1 — o contrato do protocolo fica em `@sb/mercado-livre`:** `receivedQuestionSchema` e `receivedQuestionsPageSchema` validam os campos documentados da API v4, inclusive os sete estados oficiais (`ANSWERED`, `BANNED`, `CLOSED_UNANSWERED`, `DELETED`, `DISABLED`, `UNANSWERED`, `UNDER_REVIEW`) e a identidade do comprador por `buyer_id` ou `from.id`. Esse contrato não foi colocado em `@sb/contracts`, reservado aos DTOs internos entre apps. Fixtures documentadas vivem em `packages/mercado-livre/test/fixtures/questions`; não contêm payload real, segredo ou PII da Speed Bikers.

**Decisão 2 — transformação é função pura com relógio explícito:** `mapQuestionToSupportProjection(question, observedAt)` não acessa rede, banco nem relógio global. Produz a chave do case `question:{id}`, as chaves das mensagens `question:{id}:question`/`:answer`, estado remoto, atividade e dica de resposta. Pergunta é `INBOUND/CUSTOMER`; resposta é `OUTBOUND/SELLER`. Texto vazio em conteúdo `BANNED` continua uma mensagem com `body = null` e `body_state = BANNED`; `UNDER_REVIEW` vira `MODERATED`; resposta banida/desabilitada vira `UNAVAILABLE`. A V3 não inventa semântica de não lido ausente no payload: `remote_unread_count` nasce zero.

**Decisão 3 — dica local de resposta é conservadora, não autorização:** somente uma pergunta exatamente `UNANSWERED`, não deletada, sem `hold` e sem suspeita de spam recebe `remote_reply_state = ALLOWED`. Todos os demais estados ficam `BLOCKED` com motivo determinístico. Mesmo `ALLOWED` continuará sujeito a refresh remoto no futuro comando de envio.

**Decisão 4 — sincronização preserva triagem humana:** um recurso observado pela primeira vez já respondido/encerrado nasce `RESOLVIDO`; um novo `UNANSWERED` nasce `NOVO`. Em reprocessamentos, a persistência atualiza somente a projeção externa e preserva `internal_status`, `priority`, `assignee_id` e `resolved_at` já definidos por humano. A regra futura de reabertura por nova atividade inbound continua fora desta fatia porque exige evento/transação próprios, não pode ser inferida apenas de um snapshot.

**Decisão 5 — identidade é UPSERT e links convergem do externo para o tipado:** `persistSupportQuestion` cria o case com UPSERT `ignoreDuplicates` pela chave composta de D-084 e depois atualiza somente campos externos; assim uma triagem humana concorrente também não pode ser perdida. Mensagens fazem UPSERT por `(support_case_id, external_message_key)` e todo retorno `.error` é verificado. O `item_id` sempre é preservado como link externo `LISTING` quando o anúncio ainda não existe localmente; quando `listings` resolve a mesma conta+MLB, a persistência troca o fallback pelo link tipado e acrescenta SKU quando disponível. Reprocessar o mesmo payload não duplica case, mensagens ou links. Como os índices únicos de `support_case_links` são parciais, os links usam `INSERT` e absorvem apenas `23505`; `onConflict` da Data API não expressa com segurança o predicado desses índices.

**Decisão 6 — a fatia permanece deliberadamente desconectada:** não existe chamada à API do Mercado Livre, job/registro no router, fila, webhook de SAC, reconciliação, `domain_events`, UI ou resposta. A próxima etapa será um adaptador de detalhe `GET /questions/{id}?api_version=4` e um handler invocável por `questionId`, reutilizando refresh/retry e a persistência já provada; o produtor via webhook e a varredura de reconciliação continuam etapas posteriores.

**Verificação local:** 13 testes do contrato/mapper (66 no pacote Mercado Livre), 5 testes stateful da persistência (272 no worker) e 1 teste adicional contra Postgres real para UPSERT repetido de case/mensagem (306 testes de integração de banco). Reset completo do Supabase, `pnpm exec supabase db lint --local --level warning`, `pnpm run check` e `pnpm run build` passaram; nenhuma chamada externa, migration remota, deploy ou segredo foi usado.

**Impacto:** `@sb/mercado-livre` passa a ser dono do contrato/normalização de Perguntas; o worker ganha uma porta de persistência ainda não roteada; DATABASE, ARCHITECTURE, PRODUCT_REQUIREMENTS, API, MERCADO_LIVRE, ROADMAP e HANDOFF avançam para o primeiro adaptador de rede unitário.

## D-087 — Detalhe de uma Pergunta entra por job próprio, com identidade da conta validada antes da escrita

**Contexto:** D-086 comprovou contrato, transformação e persistência sem rede. A próxima etapa registrada era conectar somente uma Pergunta ao Mercado Livre, mantendo produtor de webhook e reconciliação fora para que falhas de autenticação/HTTP pudessem ser testadas sem misturar descoberta ou paginação.

**Decisão 1 — o adaptador fixa endpoint e versão no pacote da integração:** `fetchReceivedQuestion` chama `GET /questions/{question_id}` com `api_version=4`, passa o token pelo header do cliente comum e valida a resposta com `receivedQuestionSchema`. O adaptador não reimplementa retry, backoff ou classificação HTTP; reutiliza `MercadoLivreClient`. O teste usa HTTP mock real do cliente e prova path, query, método, Authorization e contrato.

**Decisão 2 — `sync.support.questions` processa exatamente um ID:** o worker registra um handler com payload `{ mlAccountId, questionId }`. Ele resolve a conta, reutiliza `ensureAccessToken`, busca o detalhe, chama o mapper D-086 e persiste pela porta idempotente existente. Ainda não há produtor: nenhum webhook, Scheduler ou busca de reconciliação cria esse job nesta etapa.

**Decisão 3 — a identidade remota é conferida antes da persistência:** `mlAccountId` precisa pertencer à `organizationId` do envelope e `question.seller_id` precisa coincidir com o `seller_id` da conta conectada. Isso impede que um ID de pergunta válido, mas pertencente a outro vendedor, seja materializado sob a conta errada. Conta ausente/desconectada conclui sem trabalho; conta `CONNECTED` sem seller ou credenciais é erro definitivo.

**Decisão 4 — retry segue a natureza da falha:** 429/5xx e demais `MercadoLivreApiError` retryable retornam falha transitória; 4xx classificados como definitivos e payload remoto fora do schema não repetem; falha de leitura/persistência no banco e erro de rede desconhecido repetem para convergir. O corpo da pergunta e tokens nunca entram nos logs.

**Decisão 5 — `job_runs` basta para esta fatia unitária:** não foi alargado o CHECK de `sync_runs.resource`. Um fetch por ID, sem varredura/checkpoint/freshness, já é observado pelo `job_runs` comum. `sync_runs`/`sync_errors` para `questions` nasce junto da reconciliação, quando existir execução com janela, contagem e frescor semanticamente reais.

**Escopo deliberadamente ausente:** produtor do tópico `questions`, pesquisa `/my/received_questions/search`, paginação/scan, Scheduler, UI, `domain_events` e resposta. A próxima pequena etapa é fazer o ACK de webhook existente enfileirar `sync.support.questions` somente quando `topic=questions` e `resource=/questions/{id}`, preservando ACK rápido e dedupe por janela de minuto; reconciliação continua posterior.

**Verificação local:** 1 teste novo de HTTP/contrato no pacote Mercado Livre (14 no arquivo de Perguntas) e 13 testes do handler, cobrindo caminho feliz, payload, banco, conta, organização, seller, credenciais, retry remoto, resposta inválida e reentrega de persistência. Typecheck, lint e testes direcionados passaram; a validação completa e o build ficam registrados no HANDOFF ao fechamento.

**Validação completa concluída em 2026-08-25, ao versionar a fatia:** `pnpm run check` (29/29 tarefas — typecheck, lint e testes de todos os pacotes, incluindo os 285 do `worker` e os 202 da `api`) e `pnpm run build` (8/8) verdes no monorepo inteiro. **Diferente das entregas anteriores, desta vez a verificação de banco foi local, não só pela CI** — o Docker passou a estar disponível nesta máquina (29.7.2), então `supabase db reset` aplicou a cadeia completa de 52 migrations do zero, os 306 testes de integração de `packages/db/src/rls.integration.test.ts` rodaram contra Postgres real aqui, e `supabase db lint --local --level warning` não achou nada. O registro de D-069 a D-082 dizendo "não executável nesta máquina (sem Docker)" descreve a restrição que valia até 2026-08-24; ela não vale mais.

**Impacto:** primeira chamada externa read-only do domínio `support`, ainda sem tráfego porque nenhum produtor existe. API, ARCHITECTURE, DATABASE, PRODUCT_REQUIREMENTS, MERCADO_LIVRE, ROADMAP e HANDOFF avançam para integrar o tópico de webhook.

## D-088 — O produtor do tópico `questions` mora no ACK da `api`, não no worker que consome `sync.webhook.received`

**Contexto:** D-087 registrou `sync.support.questions` no worker, mas sem nenhum produtor — o job existia e nunca era criado. `docs/HANDOFF.md` registrava como próxima etapa "fazer somente o tópico `questions` do receptor de webhook já existente enfileirar o job já pronto", explicitamente sem reconciliação, Scheduler, UI, `domain_events` ou resposta. O formato do tópico já estava confirmado por leitura oficial em D-083 (`docs/MERCADO_LIVRE.md` secao 2.12): tópico geral `questions`, `resource: "/questions/{question_id}"`, sem array `actions`, disparado tanto para pergunta quanto para resposta.

**Decisão 1 — "receptor de webhook" é `apps/api/src/webhook.ts`, não `apps/worker/src/handlers/webhook-received.ts`.** A frase do HANDOFF admitia as duas leituras, e o handler do worker até parece o lugar natural: ele já roteia por tópico (`orders_v2`, `post_purchase`) e o `questions` cairia ao lado dos dois. **Tecnicamente só a `api` funciona:** o worker recebe `cloudtasks.enqueuer` apenas em `backfill` e `analytics-recompute` (`docs/ARCHITECTURE.md` secao 11, exceção registrada em 2026-08-21 e deliberadamente estreita), nunca em `ml-sync-<conta>` — que é exatamente a fila onde este job precisa entrar para respeitar o rate limit por conta (D-036). Implementar no worker teria passado em todo teste de unidade e falhado com erro de permissão só contra o Cloud Tasks real, em produção. Ambiguidade resolvida por leitura da regra de IAM, não por preferência de arquitetura.

**Decisão 2 — o ACK extrai o `questionId` em vez de repassar a notificação inteira.** O payload enfileirado é `{ mlAccountId, questionId }`, exatamente o contrato que o handler de D-087 já valida — não `{ ...notification, mlAccountId }`, o formato genérico de `sync.webhook.received`. Custa um `exec` de regex no caminho do ACK (nenhuma chamada de rede, a regra que importa continua respeitada) e evita um segundo parse do mesmo `resource` do outro lado da fila. Também mantém o handler ignorante de webhook: ele continua servindo qualquer produtor futuro (a reconciliação por busca vai enfileirar o mesmo contrato) sem saber de onde o ID veio.

**Decisão 3 — uma regra de dedupe só para os dois tipos de job.** `ml-webhook:{resource}:{janela-minuto-UTC}` continua sendo a chave, inalterada, agora servindo `sync.webhook.received` e `sync.support.questions`. Dois tópicos nunca disputam o mesmo `resource` — é justamente o formato do `resource` que identifica o tópico — então não há colisão possível entre tipos. Uma chave por tipo de job seria uma segunda regra de dedupe para manter em sincronia sem nenhum problema real a resolver. **Consequência boa, não acidental:** como o tópico dispara para pergunta E resposta com o MESMO `resource`, e o detalhe (`GET /questions/{id}`) traz as duas, as duas notificações dentro do mesmo minuto colapsam numa busca só. O sufixo de minuto (D-051) garante que a resposta chegando minutos depois da pergunta ainda gera task nova — que é o caso comum, não a exceção.

**Decisão 4 — `resource` fora do formato documentado não vira job vazio.** Um `questions` cujo `resource` não casa `^/questions/(\d+)$` sai como `unroutable_resource`: ACK 200 (reenviar não muda o formato, e devolver erro faria o Mercado Livre gastar 8 tentativas em 1h à toa, `docs/MERCADO_LIVRE.md` secao 2.5) mais um `logger.warn`. A alternativa — deixar cair no `sync.webhook.received` genérico, que faz ACK sem trabalho para tópicos sem consumidor — funcionaria, mas esconderia a anomalia atrás de um job que "termina com sucesso" processando zero itens. Mesma classe de problema que D-067 auditou a sessão inteira: falha indistinguível de "nada a fazer".

**Decisão 5 — `Number.isSafeInteger` antes de aceitar o ID.** O payload do job valida `questionId` como inteiro positivo (`z.number().int().positive()`), e um `resource` com dígitos demais passaria nessa validação **já tendo perdido precisão** no `Number()` — viraria uma busca por uma pergunta que não existe, com 404 do Mercado Livre e nenhum sinal de onde o número errado nasceu. Guarda de uma linha, com teste próprio.

**Achado no caminho, corrigido junto:** a linha de `sync.webhook.received` em `docs/API.md` secao 3 ainda dizia "Só `topic = orders_v2` tem consumidor hoje" — desatualizada desde D-057 (2026-08-23), que deu consumidor a `post_purchase`.

**Verificação:** `pnpm run check` (29/29 tarefas) e `pnpm run build` (8/8) verdes no monorepo. 19 testes novos, todos sem rede: 17 em `apps/api/src/webhook.test.ts` (contrato do payload enfileirado, tipo numérico do `questionId`, colapso de pergunta+resposta no mesmo minuto, resposta minutos depois não descartada, seis formatos inválidos de `resource` via `it.each`, ID fora do inteiro seguro, cinco tópicos vizinhos sem regressão, conta desconhecida vencendo o roteamento) e 2 em `apps/api/src/app.test.ts` (atravessando a rota real com allowlist de IP: `processed: true` com job certo, e `processed: false` sem enfileirar no caso inválido). Os testes negativos de rotas vizinhas de D-026 regra 4 continuam cobertos pelos casos já existentes — `/webhooks/outra-coisa` 404, `/internal` exigindo OIDC e `/v1` exigindo JWT mesmo vindo de IP da allowlist. **Nenhuma chamada real ao Mercado Livre** foi feita.

**Deployado e confirmado em 2026-08-25**, autorizado explicitamente pelo usuário (`docs/DEPLOYMENT.md` secao 7 — Cloud Run nunca teve CI/CD automático). **A ordem `worker` antes de `api` é obrigatória, não estilo:** assim que a `api` sobe, ela passa a enfileirar `sync.support.questions`; se o worker ainda não tivesse o handler registrado, esses jobs esgotariam as tentativas do Cloud Tasks e seriam descartados em silêncio — exatamente o bug que a Fase 3 já teve uma vez (`sync.webhook.received` enfileirado sem handler, `docs/ROADMAP.md` Fase 3).

Evidência medida, não presumida: `worker-00020-6xp` e `api-00016-5qd`, ambos servindo 100% do tráfego, imagem `a9d13bd` (o próprio HEAD, sem sufixo `-dirty`) nos dois. `worker_started` limpo no boot; zero linha `ERROR` nos dois serviços na janela pós-deploy (`gcloud logging read severity>=ERROR`). `GET /health` respondeu `startedAt: 2026-08-25T18:20:20Z` contra um relógio de 18:21:10Z — revisão nova de verdade, não resposta em cache de uma revisão antiga. `POST /webhooks/mercado-livre` de origem fora da allowlist devolveu `403`: a rota está no ar e a validação de origem de D-043 continua funcionando. **O caminho feliz não é testável daqui** — exigiria originar a chamada de um dos 8 IPs publicados do Mercado Livre, que é justamente o que a allowlist impede. A confirmação real virá da primeira pergunta de verdade chegando numa das contas conectadas.

**Impacto:** `apps/api/src/webhook.ts` (`routeJob`, `QUESTION_RESOURCE_PATTERN`, `unroutable_resource`, `jobType` no outcome e no log). `apps/api/src/webhook.test.ts` (+17), `apps/api/src/app.test.ts` (+2). `docs/API.md` (secao 2, secao 3 com a linha real do job, secao 9 saindo do estado provável), `docs/MERCADO_LIVRE.md` (secao 2.12), `docs/ROADMAP.md` (Fase 7B), `docs/HANDOFF.md`. **Primeira ingestão real do domínio `support`** — até aqui nenhum código de SAC recebia tráfego. A reconciliação por `GET /my/received_questions/search` continua a lacuna aberta mais importante da Fase 7B: sem ela, uma notificação não entregue é uma pergunta perdida, e a própria documentação oficial recomenda a busca como redundância do webhook.

## D-089 — Reconciliação de Perguntas recorta por `status=UNANSWERED` porque a API não oferece filtro de data nem ordenação garantida

**Contexto:** desde D-088 o webhook `questions` é o ÚNICO caminho de ingestão do domínio `support`. Uma notificação que o Mercado Livre não entregue é uma pergunta que a V3 nunca vê — e a documentação oficial recomenda a busca como redundância do webhook (a mesma lógica que `/messages/unread` cumpre para mensagens, `docs/MERCADO_LIVRE.md` secao 2.12). `docs/HANDOFF.md` registrava esta como a próxima etapa e a lacuna mais séria da Fase 7B.

**Pesquisa oficial ao vivo antes de escrever código** (REGRA ABSOLUTA, `docs/PROMPT_MASTER.md` §9): D-083 tinha confirmado o endpoint e o payload, mas não os parâmetros de busca. Lida a página oficial `developers.mercadolivre.com.br/pt_br/perguntas-e-respostas` em 2026-08-25 (última atualização 05/06/2025), o payload de exemplo de `/my/received_questions/search` declara ele mesmo o que aceita:

- `available_filters`: `item`, `from`, `totalDivisions`, `division` e **`status`** (os sete valores já catalogados). **Não existe filtro por data.**
- `available_sorts`: `item_id`, `from_id`, `date_created`, `seller_id` — mas a resposta padrão traz `"sorts": []`, então **a ordenação default não é documentada**.
- `total`, `limit` e `questions[]` no topo; `offset` dentro de `filters`.
- `search_type=scan` continua sem aparecer para este endpoint, confirmando a ressalva que D-083 já tinha registrado.

**Decisão 1 — o recorte é `status=UNANSWERED`, e isso é imposto pela API, não uma escolha de escopo.** Sem filtro por data e sem ordem garantida, "reconciliar os últimos N dias" é literalmente inexpressável: não dá para pedir uma janela, nem para confiar que as primeiras páginas trazem as mais recentes. Restavam duas saídas: varrer o histórico inteiro da conta a cada rodada, ou recortar por um filtro oficial. `status` é filtro oficial, e `UNANSWERED` recorta exatamente o caso operacional que importa — alguém esperando resposta que a V3 nunca viu. O conjunto ainda é limitado pelo próprio Mercado Livre, que remove perguntas sem resposta há mais de 7 meses.

**Lacuna que essa decisão aceita, explicitamente:** uma pergunta que o webhook perdeu E que alguém respondeu pelo app do Mercado Livre não é recuperada — ela não está mais `UNANSWERED`. É buraco de HISTÓRICO, não de operação. Fechá-lo exigiria varrer os sete status a cada rodada; entra quando houver evidência real de que acontece, mesmo princípio de evidência medida de D-037/D-039/D-053/D-058/D-061.

**Decisão 2 — a varredura persiste direto, sem enfileirar um job por pergunta.** O `questions[]` da busca carrega o MESMO objeto que `GET /questions/{id}` devolve — foi exatamente para isso que D-086 escreveu `receivedQuestionSchema` como "contrato do detalhe e de cada entrada de `questions[]` nas buscas". Enfileirar `sync.support.questions` por ID encontrado custaria N chamadas extras contra uma API limitada por rate limit, para buscar dado que já está em mãos. Some-se que o worker não tem `cloudtasks.enqueuer` em `ml-sync-<conta>` (`docs/ARCHITECTURE.md` secao 11, o mesmo achado de D-088): ele nem poderia enfileirar ali.

**Decisão 3 — job SEPARADO de `sync.support.questions`, não uma flag no mesmo handler.** Payload diferente (`{ mlAccountId }` contra `{ mlAccountId, questionId }`), semântica de erro diferente (uma varredura que falha contra um ID que falha) e só um dos dois alimenta `sync_runs`. Juntar os dois num handler com um `if` produziria exatamente o tipo de função com dois modos que fica impossível de raciocinar depois.

**Decisão 4 — `sync_runs.resource` finalmente ganha `questions`.** D-087 registrou explicitamente a decisão de NÃO alargar esse CHECK, porque um fetch por ID vindo do webhook não tem janela, contagem nem frescor — `job_runs` bastava. A reconciliação tem os três: varre um conjunto, processa N itens e produz o "última vez que reconciliamos esta conta" que a tela de Saúde da Sincronização mostra. Migration `20260825180000`, mesmo formato do alargamento de `'visits'` (`20260823184120`). O vocabulário continua FECHADO — há teste provando que um `resource` fora da lista ainda é recusado — e `SyncResource` (`apps/worker/src/handlers/sync-runs.ts`) é o espelho em TypeScript que precisa andar junto; o typecheck pegou essa divergência sozinho.

**Decisão 5 — teto de páginas, e truncar é PARCIAL, nunca `done`.** 20 páginas x 100 = 2.000 perguntas por execução. Sem teto, uma conta com um número absurdo de perguntas em aberto varreria a API até o rate limit. Bater o teto não é erro — é sinal: sai no log, no resultado e no `sync_runs` como `partial` com o motivo. Reportar `done` sobre um recorte seria a mesma categoria de mentira que D-067 auditou a sessão inteira. Falha ao persistir e pergunta recusada por `seller_id` divergente também viram `partial`, contadas separadamente.

**Decisão 6 — cadência de 6h com sufixo de bloco na chave de dedupe.** Mais frequente que visitas (D-059, diária — visita é contador cumulativo; pergunta não respondida é alguém esperando), menos que de hora em hora (o webhook já entrega em segundos no caminho feliz). A chave leva `{dia}:{bloco-6h}` porque um ID fixo por dia seria retido pelo Cloud Tasks por até 24h e faria as rodadas seguintes do MESMO dia serem descartadas como `ALREADY_EXISTS` — exatamente a armadilha de D-051.

**Decisão 7 — a identidade de cada pergunta é conferida contra o `seller_id` da conta, como em D-087.** Aqui é ainda mais barato que lá: o payload já está em mãos. Uma pergunta de outro vendedor é contada e logada, nunca escrita sob a conta errada. Erro de rede no meio da paginação SOBE para o job classificar — uma reconciliação que falha no meio e reporta sucesso parcial silencioso seria pior que não ter reconciliação nenhuma.

**Verificação:** `pnpm run check` (29/29) e `pnpm run build` (8/8) verdes. 33 testes novos, nenhum tocando a rede real: 3 em `packages/mercado-livre/src/questions.test.ts` (endpoint/query exatos, incluindo prova de que `search_type` NÃO vaza; campos extras da busca ignorados sem recusar; item fora do contrato recusado), 11 em `ml-support-questions-fetch.test.ts` (paginação por offset, fim por página curta e não por `total`, seller divergente, falha isolada por item, texto da pergunta nunca no log, erro subindo no meio da paginação, truncamento no teto), 13 em `sync-support-questions-reconcile.test.ts` (fronteiras de conta/token, `partial` nos três motivos, classificação de retry) e 6 em `apps/api/src/support-questions-schedule.test.ts` (mesma chave no mesmo bloco de 6h, chaves diferentes entre blocos). Mais 3 no nível de rota/banco: 2 em `app.test.ts` (a rota `/internal/schedule/support-questions` exige OIDC como as vizinhas — D-026 regra 4) e 2 em `rls.integration.test.ts` (aceita `questions`, recusa `inventado`). **Banco verificado localmente contra Postgres real**: `supabase db reset` aplicou as 53 migrations do zero, 308 testes de integração verdes, `supabase db lint --local --level warning` limpo. `bash -n infra/cloud-scheduler.sh` limpo.

**Deployado e confirmado em 2026-08-25**, autorizado pelo usuário, na ordem obrigatória **worker → api → Scheduler**: o worker precisa ter o handler antes de a api enfileirar (mesma armadilha de D-088), e o job do Scheduler só pode nascer depois da rota existir, senão dispararia contra 404 até o próximo deploy. `worker-00021-28q` e `api-00017-p8f`, imagem `7272948` nos dois, 100% do tráfego, zero linha ERROR pós-deploy, `/health` com `startedAt` 23s antes da consulta. `v3-support-questions-reconcile` criado (`20 */6 * * *`, `America/Sao_Paulo`), **elevando a contagem esperada de jobs do Cloud Scheduler de 9 para 10**. `POST /internal/schedule/support-questions` devolve `401` sem OIDC contra o serviço REAL, igual à vizinha `/internal/schedule/listing-visits`. **Não observado ainda**: a primeira execução natural (18h20 de SP) — nenhum disparo manual foi feito, porque faria chamadas reais ao Mercado Livre contra as 3 contas conectadas sem autorização para isso.

**Impacto:** `supabase/migrations/20260825180000_add_questions_sync_resource.sql` (novo). `packages/mercado-livre/src/questions.ts` (`fetchReceivedQuestionsPage`) + `index.ts` + teste. `apps/worker/src/handlers/ml-support-questions-fetch.ts` e `sync-support-questions-reconcile.ts` (novos) + testes, `sync-runs.ts` (`SyncResource`), `index.ts` (registro do job). `apps/api/src/support-questions-schedule.ts` (novo) + teste, `app.ts` (rota + dep), `index.ts` (injeção), `app.test.ts`. `infra/cloud-scheduler.sh` (`v3-support-questions-reconcile`). `docs/MERCADO_LIVRE.md` secao 2.12 (filtros/sorts/paginação confirmados), `docs/API.md`, `docs/DATABASE.md`, `docs/ROADMAP.md`, `docs/HANDOFF.md`.

## D-090 — Caixa de Entrada é UMA tela com filtros, não seis rotas; e o login perdia a query string de qualquer tela filtrada

**Contexto:** primeira tela do SAC (`docs/HANDOFF.md`, próxima etapa registrada). Desde D-089 a ingestão de Perguntas funciona por webhook e por reconciliação — e ninguém conseguia VER o que estava sendo ingerido. `docs/ROADMAP.md` Fase 7B pedia "caixa de entrada unificada, com filtros por conta/tipo/status/prioridade/SLA".

**Decisão 1 — uma rota (`/atendimento`), não uma por canal.** `docs/PRODUCT_REQUIREMENTS.md` listava "Perguntas", "Mensagens", "Reclamações", "Mediações" e "Devoluções" como itens de navegação próprios — mas isso foi escrito ANTES de D-084, que decidiu que os três canais são a mesma projeção (`support_cases`) e que mediação/devolução são FACETAS do claim (`is_mediation`/`has_return`), não canais. Cinco rotas seriam cinco cópias da mesma tabela com um `where` diferente. Viraram pílulas de filtro. `docs/PRODUCT_REQUIREMENTS.md` foi corrigido para não continuar prometendo uma navegação que a própria modelagem já tinha invalidado.

**Decisão 2 — leitura direta sob RLS, sem rota na `api`.** Modelo A (D-012): nenhum segredo envolvido, read model indexado, exatamente a categoria que `docs/ARCHITECTURE.md` secao 4 descreve. A ordenação (`last_activity_at desc`) e o filtro padrão ("abertos", `internal_status <> 'RESOLVIDO'`) foram escolhidos para casar com `support_cases_open_inbox_idx`, o índice parcial que D-085 criou justamente para esta consulta.

**Decisão 3 — três filtros agora (conta, tipo, status), não os seis do requisito.** Prioridade e responsável só ganham utilidade junto da triagem (que é a fatia seguinte: transação que muda o case E acrescenta `support_case_events`, D-084) — filtrar por um campo que ninguém consegue mudar ainda é enfeite. SLA depende de `support_case_deadlines`, e nenhuma ingestão preenche essa tabela hoje: um filtro de prazo sobre tabela vazia mostraria "nada encontrado" para todo mundo, que é pior que não existir. Os três entregues são os que o HANDOFF registrava como escopo.

**Decisão 4 — a escolha de QUAL referência de produto mostrar é apresentação, e mora numa função pura.** Um case pode ter vários vínculos — D-084 fez `support_case_links` muitos-para-muitos exatamente para não eleger um "SKU principal" arbitrário no banco. Mas uma linha de tabela precisa de um texto só. `resolveSupportCaseReference` (`apps/web/lib/support-case-reference.ts`, 8 testes) resolve a ordem: SKU (único com rota real, `/skus/[skuId]`) > anúncio resolvido em `listings` (traz o título) > `item_id` externo (o fallback que D-086 sempre preserva) > pedido. Anúncio não vira link: `/anuncios` é lista, não tem página por item — mesmo critério de D-074 de não inventar rota que não existe.

**Achado ao escrever o teste E2E — bug real, e não era só desta tela: o login descartava a query string.** `apps/web/proxy.ts` fazia `login.searchParams.set("next", pathname)` — só o CAMINHO. Toda tela filtrada guarda o filtro em query param (`/vendas?days=90&account=x`, `/curva-abc`, e os presets de "Filtros salvos" de D-062 são literalmente uma URL com query). Abrir um link filtrado sem sessão levava a pessoa, depois de entrar, para a tela SEM o filtro, sem nenhum sinal de que algo se perdeu. Pior: `request.nextUrl.clone()` mantinha os params da tela de origem soltos na própria URL de `/login`. Corrigido: `next` leva `pathname + search`, e a query da origem é zerada antes.

**Correção adjacente, no mesmo caminho de código — `next` não podia levar para fora.** Quem LÊ o `next` é o formulário de login, a partir da URL do navegador: qualquer pessoa monta `/login?next=https://...` e manda o link. Sem checagem, a vítima sairia do sistema logo depois de digitar a senha, na tela em que mais confia. `safeNext` (`apps/web/lib/safe-next.ts`, 9 testes) aceita só caminho interno — rejeita URL absoluta, protocolo-relativa (`//evil`, que passa numa checagem ingênua de primeiro caractere), `/\evil` e esquema executável. Isso já era explorável antes desta mudança; não foi introduzido aqui, mas também não faria sentido deixar em pé estando dentro das três linhas que eu já estava tocando.

**Verificação — e desta vez a tela em si foi exercitada.** D-074, D-075 e D-076 fecharam cada um com a MESMA ressalva ("a tela não é visitada por nenhum spec e não foi aberta manualmente"): três entregas seguidas com o risco de renderização descoberto. Esta tem 3 specs Playwright novos (`apps/web/e2e/atendimento.spec.ts`) rodando contra Postgres real com login real, e o seed do E2E ganhou uma conta ML e dois `support_cases` (um NOVO com vínculo tipado, um RESOLVIDO com fallback externo — dois estados porque o filtro padrão é "abertos", e com um só não daria para provar que o RESOLVIDO fica de fora). **8/8 specs verdes localmente** (3 novos + os 5 de D-069, sem regressão). O embed de `support_case_links` atravessa a **FK COMPOSTA** `(support_case_id, organization_id, ml_account_id)` — verificado por `curl` direto no PostgREST local antes de escrever a tela, porque embed por FK composta é exatamente o tipo de coisa que não se presume. `pnpm run check` 29/29 e `build` 8/8 verdes; 17 testes de unidade novos.

**Armadilha registrada para quem escrever spec depois:** `getByRole("alert")).toHaveCount(0)` NUNCA vale num app Next.js — o framework mantém um `#__next-route-announcer__` com `role="alert"` em toda página (live region que anuncia o título na navegação client-side). Custou uma investigação; a asserção certa é pelo texto do banner.

**Confirmado em produção em 2026-08-25** (Vercel publica `apps/web` automaticamente no push): `GET /atendimento?status=RESOLVIDO` sem sessão devolve `307` para `/login?next=%2Fatendimento%3Fstatus%3DRESOLVIDO`. Uma medição, duas provas — a rota está no ar, e a correção do redirect vale em produção: a query string sobrevive dentro do `next` e os params da origem não vazam soltos na URL de login. O caminho autenticado não foi aberto no navegador contra o Dev (sem credencial de usuário real nesta sessão), mas ele é exatamente o que os 3 specs Playwright exercitam com login real contra Postgres real.

**Escopo deliberadamente ausente:** triagem (assumir/mudar status/resolver), envio de resposta, `domain_events support.*`, sugestão do Copiloto, detalhe do atendimento com transcript, e paginação (teto de 100 linhas com aviso na tela, entra quando o volume real pedir).

**Impacto:** `apps/web/app/atendimento/page.tsx` (novo). `apps/web/lib/support-case-reference.ts` + `.test.ts` (novos), `apps/web/lib/safe-next.ts` + `.test.ts` (novos), `apps/web/lib/labels.ts` (quatro mapas de atendimento + `statusTone`), `apps/web/components/shell.tsx` (grupo ATENDIMENTO), `apps/web/proxy.ts` (query string no `next`), `apps/web/app/login/login-form.tsx` (`safeNext`). `apps/web/e2e/{seed,seed-output}.ts` + `atendimento.spec.ts`. `docs/PRODUCT_REQUIREMENTS.md` (navegação corrigida), `docs/ROADMAP.md`, `docs/HANDOFF.md`. Só `apps/web` — deploy automático pela Vercel, sem Cloud Run envolvido.

## D-091 — O webhook do Mercado Livre NUNCA foi chamado: o marco do Fast Path da Fase 3 nunca foi verdade em produção

**Contexto:** o usuário reportou (2026-08-25) que a Caixa de Entrada recém-entregue (D-090) não mostrava nenhuma pergunta, enquanto o UpSeller exibia uma pendente na conta "Speedbikers (loja 1)". Investigação por medição, não por leitura de código.

**Achado 1 — em 30 dias de log de requisição do Cloud Run, `/webhooks/mercado-livre` recebeu UMA requisição, e foi um teste meu:**

```
2026-08-25T18:21:11Z  403  2804:14d:...   ← curl de verificação do deploy de D-089
(nenhuma outra em 720h)
```

Não é específico de `questions`: **nunca chegou `orders_v2`, `post_purchase`, nada.** O Mercado Livre jamais entregou uma notificação à V3.

**Consequência que ninguém tinha percebido:** `docs/ROADMAP.md` Fase 3 declara o marco *"Pedidos ficam frescos em segundos no caminho feliz"* desde 2026-08-22 (D-044, Fast Path). **Isso nunca aconteceu.** O frescor dos pedidos vem, desde sempre, da reconciliação de hora em hora — que funciona (`reconcile_triggered, accounts_scanned: 4` a cada hora cheia) e, por funcionar, escondeu a ausência total do caminho principal. É o caso exemplar de rede de segurança mascarando a falha do mecanismo que ela deveria apenas complementar.

**Causa raiz — um passo manual que nunca foi documentado nem executado:** a URL de callback e os tópicos assinados vivem no painel de aplicações do Mercado Livre. Nenhum script de `infra/` configura isso (nem poderia — não há API pública para tal), e `docs/DEPLOYMENT.md` não tinha o passo. A regra do projeto "documentação não comprova deploy" nasceu para pegar exatamente esta classe de divergência, mas falhou aqui por um motivo pior: **a documentação nem mencionava que existia algo a verificar.** Corrigido — `docs/DEPLOYMENT.md` ganhou a configuração externa obrigatória, com a URL exata e os tópicos.

**Risco encadeado, ainda aberto:** `apps/api/src/ip-allowlist.ts` continua com o `PENDENTE` de D-045. A regra "o IP confiável é o penúltimo do `X-Forwarded-For`" foi INFERIDA da documentação de HTTPS Load Balancing do Google e nunca foi verificada contra uma chamada real — porque nenhuma chegou. Se estiver errada, **toda notificação toma 403 no instante em que o painel for configurado**, e o Mercado Livre não avisa: desiste após 8 tentativas em 1h. O `webhook_origin_rejected` também não registra o header recebido nem o IP extraído, então hoje um 403 indevido seria silencioso na investigação.

**Achado 2 — a reconciliação funciona, e o Mercado Livre diz que não há perguntas.** Disparo manual autorizado pelo usuário (`gcloud scheduler jobs run v3-support-questions-reconcile`, 20h07/UTC): `support_questions_schedule_triggered` com 4 contas, 4 jobs enfileirados, e os 4 concluíram `sync_support_questions_reconcile_done` com `items_processed: 0`, `items_failed: 0` e **`remote_total: 0`** — sem erro, sem 429, sem 403. `remote_total` é o `total` que o PRÓPRIO Mercado Livre devolveu para `GET /my/received_questions/search?api_version=4&status=UNANSWERED`. Ou seja: a metade da V3 (token, HTTP, contrato, retry, persistência) está provada ponta a ponta contra a API real; o remoto é que respondeu vazio.

**Duas hipóteses, deliberadamente NÃO decididas no chute:**

- **(a) permissão** — as 4 contas foram autorizadas em 2026-08-21, antes de Perguntas existir no projeto. D-083 confirmou que `questions` depende da permissão funcional "Comunicação pré e pós-venda". Sem ela, o Mercado Livre pode devolver lista vazia em vez de erro, e a correção seria acrescentar a permissão e REAUTORIZAR as quatro contas;
- **(b) filtro** — `status` aparece nos `available_filters` da resposta oficial, mas isso é a documentação descrevendo a si mesma, não comportamento observado.

**Como as duas se separam, sem adivinhação:** quando a primeira página de `UNANSWERED` volta vazia, uma chamada extra SEM o filtro, registrando apenas o `total` (nenhum conteúdo, nenhum dado de comprador). `total > 0` sem filtro ⇒ é o filtro; `total = 0` nos dois ⇒ não enxergamos pergunta alguma ⇒ é permissão.

**Achado operacional no caminho — disparo manual queima o bloco de dedupe do dia.** Depois de deployar a sonda (`worker-00022-d88`), o re-disparo manual voltou `enqueued: 0, deduplicated: 4`: a chave é `{conta}:{dia}:{bloco-6h-UTC}`, e 20h07 e 20h46 caem no mesmo bloco. O dedupe fez o que devia — mas a consequência é que a execução natural seguinte no MESMO bloco também é descartada, então a rodada das 18h20 de SP não aconteceu. Isso vale para qualquer job com dedupe por dia/bloco (D-065 e D-081 dispararam manualmente jobs com chave `{organização}:{data-negócio}` e simplesmente não esbarraram no caso). Não é bug: é o preço, já aceito em D-051, de usar o nome da task como mecanismo de dedupe. Fica registrado para ninguém interpretar "o cron não rodou" como falha.

**CONCLUÍDO em 2026-08-26 — as duas hipóteses estavam erradas, e a sonda provou isso.** Execução natural das 03h20/UTC: as quatro contas voltaram vazio na busca filtrada, e a sonda registrou o `total` SEM filtro por conta — `27387997: 3142`, `118570204: 4361`, `463776938: 3073`, `272371352: 4777`.

- **(a) permissão está DESCARTADA**: enxergamos entre 3.073 e 4.777 perguntas por conta. Os tokens de 2026-08-21 têm acesso a `questions`; **nenhuma reautorização é necessária**.
- **(b) filtro está DESCARTADA**: a execução seguinte, às 09h20/UTC, trouxe `1+1+1+3 = 6` perguntas reais com `status=UNANSWERED`. O filtro funciona.

**A resposta era a mais simples e eu não a tinha considerado seriamente: `total: 0` era verdade.** Não havia pergunta em aberto nos instantes medidos. A rodada das 03h20/UTC (00h20 de SP) passou 2 minutos ANTES da primeira das seis chegar (00h22 de SP); as seis caíram entre 00h22 e 05h14 e a rodada das 06h20 pegou todas. Lição registrada: diante de um "zero" inesperado, a hipótese de que o zero é correto merece o mesmo peso das hipóteses de falha — a sonda foi valiosa justamente por medir em vez de escolher entre duas explicações que eu já tinha formulado.

**Sobre a pergunta que o ERP mostrava pendente em 2026-08-25 às 16h59:** não é determinável retroativamente por que ela não estava `UNANSWERED` às 17h07. A explicação mais provável é que já tinha sido respondida (o UpSeller da operação tem "Auto Resposta" ligada), mas isso é inferência, não medição, e fica marcado como tal.

**Sonda REMOVIDA em 2026-08-26**, como D-091 previa desde a primeira linha ("temporária por desenho"). Ela custava uma chamada extra à API do Mercado Livre em toda execução sem perguntas em aberto — que é o caso comum — e a dúvida que justificava esse custo acabou. `fetchReceivedQuestionsPage` voltou a exigir `status` obrigatório: uma busca sem filtro varre milhares de linhas, e nenhum chamador da ingestão deve conseguir pedir isso sem querer.

**Pipeline confirmado ponta a ponta com dado real de produção:** 6 perguntas reais de 4 contas, ingeridas pela reconciliação e visíveis na Caixa de Entrada (D-090). D-086, D-087, D-089 e D-090 estão validados contra a API real, não só contra fixture.

**O webhook continua não configurado** (verificado em 2026-08-26: a única requisição ao endpoint em 30 dias segue sendo o teste interno). É por isso que essas perguntas levaram até 6 horas para aparecer em vez de segundos — a reconciliação está cobrindo, mas como rede de segurança, não como caminho principal.

**Impacto:** `docs/DEPLOYMENT.md` (passo de configuração externa, novo), `docs/ROADMAP.md` (marco da Fase 3 corrigido — não pode continuar afirmando o que nunca aconteceu), `docs/HANDOFF.md` (dois achados nas pendências imediatas), `docs/MERCADO_LIVRE.md` (secao 2.12, o que a reconciliação realmente observou).

## D-092 — Os ~9.800 "erros" diários do Postgres eram a idempotência funcionando; o problema era enterrarem o erro de verdade

**Contexto:** o usuário mostrou o painel do Supabase com **9.848 erros e 0 warnings em 24h** sobre 10.135 linhas de log, com as últimas horas quase inteiramente vermelhas.

**Diagnóstico, medido:** `recordStockMovements` e `recordDomainEvents` faziam `INSERT` puro e absorviam o `23505` no cliente. Cada inserção repetida era **rejeitada pelo Postgres**, e cada rejeição vira uma linha ERROR no log do banco. A reconciliação horária reprocessa a mesma janela de pedidos — medido nos logs do worker: entre 190 e 332 pedidos por hora somando as 4 contas, média ≈ 265, o que dá ≈ 6.400 pedidos reprocessados por dia. Cada um tenta reinserir os movimentos de estoque dos seus itens, todos colidindo com `idempotency_key`. Isso explica a ordem de grandeza dos 9.848 quase exatamente.

**Ou seja: não havia nada quebrado.** Era a garantia de D-019 funcionando — `idempotency_key` UNIQUE tornando a dupla movimentação fisicamente impossível.

**Mas também não era inofensivo, e é por isso que virou decisão.** 9.848 erros esperados por dia é ruído no qual um erro de verdade desaparece. É a mesma classe de problema que D-067 auditou a sessão inteira: não um dado errado, uma falha que ninguém consegue ver. Com o log nesse estado, o painel de erros do Supabase não serve para nada.

**Decisão — `ON CONFLICT DO NOTHING` em vez de `INSERT` + absorver 23505 no cliente.** `.upsert(row, { onConflict: "...", ignoreDuplicates: true })` nas duas gravações. **A garantia não muda**: a constraint UNIQUE continua existindo e continua sendo o que impede a dupla movimentação. O que muda é o Postgres pular em silêncio em vez de gritar. `ignoreDuplicates` é DO NOTHING, nunca DO UPDATE — reescrever um movimento existente seria exatamente o que o ledger append-only existe para impedir.

**A troca mexe na garantia mais crítica do projeto, então não foi aceita por leitura de documentação.** Se o alvo de conflito estivesse errado e a PRIMEIRA inserção virasse no-op, o sintoma seria o estoque parar de ser registrado **em silêncio**. Criado `packages/db/src/idempotent-writes.integration.test.ts`: contra Postgres + PostgREST reais, pelo MESMO cliente que o worker usa, prova que gravar duas vezes produz uma linha e nenhum erro, que `inventory_balances` aplica o movimento **uma vez** (o trigger, que é o que vira estoque errado se rodar duas vezes), e que um payload diferente com a mesma chave **não sobrescreve** o original. O job `integração` da CI ganhou as variáveis do Supabase local, que a suíte de RLS não precisava por falar `pg` direto.

**Decisão 2 — cadência da reconciliação de Perguntas: 6h → 10 minutos.** Pedido do usuário ("faça as perguntas aparecerem assim que caírem"). O raciocínio original de D-089 ("o webhook entrega em segundos, isto é só a rede de segurança") dependia de uma premissa que D-091 derrubou: **o webhook nunca foi chamado**. Enquanto o painel do Mercado Livre não for configurado, a varredura é o ÚNICO caminho, e uma pergunta podia levar 6 horas para aparecer. Custo: 4 contas × 6 execuções/hora = 24 chamadas/hora, cada uma uma página pequena filtrada — contra as ~945 por conta por execução da sincronização de visitas.

**Decisão 3 — a chave de dedupe passou a ter janela de MINUTO, e isso era obrigatório, não cosmético.** Com `{dia}:{bloco-6h}`, as seis execuções de uma hora colapsariam numa só e a cadência nova não teria efeito nenhum. Como efeito colateral, some o achado operacional de D-091: um disparo manual não "queima" mais a rodada natural seguinte. Dois testes de regressão cobrem os dois casos.

**Achado grave no caminho — a allowlist do webhook rejeitaria 100% das notificações reais.** `extractClientIp` devolve `undefined` quando o `X-Forwarded-For` tem **menos de duas entradas**, e a evidência de que é esse o caso real veio do único teste que já bateu no endpoint: o log de `webhook_origin_rejected` de 2026-08-25 saiu **sem o campo `ip`**, o que só acontece nesse ramo. É o `PENDENTE` de D-045 se materializando: a regra do penúltimo IP foi inferida da documentação de HTTPS Load Balancing e nunca foi exercitada. **Consequência prática: se o painel fosse configurado hoje, toda notificação tomaria 403 e o Mercado Livre desistiria após 8 tentativas, em silêncio.** Ainda NÃO corrigido — corrigir sem ver o header real seria repetir o erro de inferir. O log ganhou `webhook_forwarded_for_unparsed` com o header cru, para que uma única chamada de teste depois do deploy revele o formato verdadeiro e a correção seja feita sobre evidência.

**Deployado e confirmado em 2026-08-26**: `worker-00023-pfs`, `api-00018-7cq` e o Scheduler em `*/10 * * * *`. A reconciliação rodou às 12h00 e 12h10 com 4 contas cada, ingerindo 1 pergunta real em cada rodada.

**Observação que a cadência nova revelou, não bloqueante:** duas das quatro contas voltaram `job_failed` com "refresh do token em andamento por outra execução" às 12h00 — a trava de `refresh_locked_until` (D-046, existe porque o `refresh_token` é de uso único). É `retryable` e se resolveu sozinha em ~11 segundos, com as quatro contas concluindo. Com 6 execuções/hora a disputa fica mais provável, especialmente no minuto :00, quando os jobs horários também rodam. Cada ocorrência sai como ERROR no log — ironicamente, um pouco do ruído que esta mesma decisão foi limpar. Não corrigido aqui: é comportamento pré-existente, se cura sozinho, e cada conta só renova o token a cada ~6h, então a frequência é limitada. Fica registrado para quem for mexer em cadência de novo.

**Impacto:** `apps/worker/src/handlers/stock-movements.ts`, `domain-events.ts`. `apps/api/src/support-questions-schedule.ts` + teste (+2 de regressão), `app.ts` (log do header cru). `infra/cloud-scheduler.sh` (cron). `packages/db/src/idempotent-writes.integration.test.ts` (novo). `.github/workflows/ci.yml`. Fakes de teste do worker atualizados para aceitar `upsert` — nenhum deles verificava o verbo, só o que foi gravado.

## D-093 — A allowlist do webhook era contornável por um header, e rejeitaria toda notificação legítima: o IP confiável é o ÚLTIMO do `X-Forwarded-For`

**Contexto:** D-092 acrescentou o log do `X-Forwarded-For` cru justamente para que a correção do `PENDENTE` de D-045 saísse de evidência, não de inferência. Duas chamadas ao endpoint REAL de produção, depois do deploy, resolveram a questão — e revelaram um problema pior do que o previsto.

**Medição, contra `https://api-rrquw5upla-rj.a.run.app/webhooks/mercado-livre`:**

| Enviado pelo cliente | Header que a `api` recebeu | Resultado |
|---|---|---|
| nada | `2804:14d:...` (só o IP do cliente) | 403 — `extractClientIp` devolvia `undefined` |
| `X-Forwarded-For: 54.88.218.97` | `54.88.218.97,2804:14d:...` | **200 — ACEITO** |

**Os dois casos concordam: o Cloud Run ACRESCENTA o IP real ao final.** O cliente controla tudo que vem antes e nada do que vem depois.

**Dois defeitos, opostos, na mesma linha de código:**

1. **Toda notificação legítima seria rejeitada.** `parts.length < 2 → undefined`: uma entrada só era tratada como "não deu para ler o header", mas é o caso NORMAL — o Mercado Livre não manda `X-Forwarded-For`, então o header chega com uma entrada. Configurar o painel hoje resultaria em 403 em 100% das notificações, e o Mercado Livre desistiria após 8 tentativas em silêncio.
2. **E qualquer pessoa conseguia entrar forjando um header.** Lendo o PENÚLTIMO, a posição lida como confiável era exatamente a que o cliente escreve. **Verificado em produção**: uma chamada com `X-Forwarded-For: 54.88.218.97` da minha própria máquina atravessou a allowlist e chegou a `ml_webhook_unknown_account` — parou só porque o `user_id` do payload de teste não existia, não pela autenticação.

**Por que a regra antiga parecia certa:** D-045 a derivou da documentação do Google **HTTPS Load Balancing**, que descreve `<existing>,<client-ip>,<lb-ip>` — ali o balanceador acrescenta o próprio IP por último, e o penúltimo é de fato o cliente. **O Cloud Run em URL própria tem outra topologia**: não há esse último elemento. O `PENDENTE` de D-045 avisava exatamente disso ("o texto confirmado é da documentação de HTTPS Load Balancing, não de uma página específica do Cloud Run") e pedia a verificação que só agora foi feita. A lição não é "a inferência foi descuidada" — ela foi registrada como incerta desde o primeiro dia. É que **uma incerteza registrada continua sendo uma incerteza até alguém medir**, e esta ficou dez meses de pé porque a ausência de tráfego real escondia os dois sintomas.

**Decisão — o IP confiável é o ÚLTIMO elemento, e uma entrada só é válida.** É a única posição que o cliente não controla.

**Verificação:** dois testes de regressão nomeados como tal (`ip-allowlist.test.ts` e `app.test.ts`), provando que `54.88.218.97,<ip-do-atacante>` é RECUSADO e que uma entrada só é aceita. Os fixtures de todo o `app.test.ts` foram corrigidos para o formato real do Cloud Run — estavam todos em `<ip>,169.254.1.1`, formato que nunca existiu neste ambiente. `check` 29/29 e `build` 8/8 verdes.

**Nota sobre o método:** a segunda medição foi um teste de contorno da autenticação contra o próprio sistema do usuário, feito para verificar um controle de segurança dele. A requisição foi única, o payload não correspondia a nenhuma conta real e o efeito foi nulo (`unknown_account`).

**Deployado e confirmado em 2026-08-26** (`api-00019-n7w`): a MESMA requisição forjada que devolvia 200 agora devolve **403**. A falha está fechada em produção.

**Impacto:** `apps/api/src/ip-allowlist.ts`, `ip-allowlist.test.ts`, `app.test.ts`. Fecha o `PENDENTE` de D-045.

## D-094 — Triagem do atendimento é RPC transacional, e não escrita direta sob RLS

**Contexto:** próxima etapa registrada no `docs/HANDOFF.md`. A Caixa de Entrada (D-090) é só leitura — ninguém consegue assumir um atendimento, mudar status ou resolver. Sem isso, duas pessoas respondem a mesma pergunta.

**Decisão 1 — RPC, a exceção deliberada ao padrão de escrita do `web`.** O resto da tela lê e escreve direto sob RLS (D-012). A triagem não pode: precisa atualizar `support_cases` **E** acrescentar `support_case_events` na MESMA transação (D-084 decidiu que o histórico é append-only e que "nada importante depende apenas do estado visual da interface"). Duas escritas separadas do navegador não têm como ser atômicas, e um case que muda de status sem o evento perde quem decidiu e quando. `triage_support_case` é `security definer` e refaz as duas autorizações por dentro: acesso à CONTA (`has_account_access`, a mesma regra da leitura) e papel `ADMIN`/`GESTOR`/`OPERADOR` — `ANALISTA`/`VISUALIZADOR` leem e não triam.

**Decisão 2 — `resolved_at` é derivado do status, não pedido à interface.** A constraint `support_cases_resolution_coherent` exige `resolved_at` preenchido em `RESOLVIDO` e **nulo em qualquer outro estado**. Se a tela precisasse mandar o campo, reabrir um atendimento resolvido falharia por uma constraint que a interface não tem por que conhecer. A RPC calcula: entrando em `RESOLVIDO` preenche (preservando o valor original numa segunda triagem), saindo dele limpa.

**Decisão 3 — parâmetro nulo é "não mexer"; desatribuir exige pedido explícito.** `p_clear_assignee`, separado. Sem isso não haveria como distinguir "não mudei o responsável" de "quero liberar" — e liberar um atendimento assumido por engano é operação real, diferente de `update_action_status` (D-064), que registrou explicitamente não ter "desatribuir".

**Decisão 4 — o responsável precisa ser da MESMA organização.** Sem a checagem, daria para pendurar o atendimento em alguém de fora, que depois o veria na própria lista. É a mesma classe de fronteira que a validação de `seller_id` cumpre na ingestão (D-087).

**Decisão 5 — chamada que não muda nada não gera evento.** Histórico append-only só tem valor se cada linha for uma decisão real; um select que reenvia o mesmo status viraria ruído no lugar onde se procura "quem mexeu nisso".

**Decisão 6 — a interface NÃO esconde o controle de quem não pode triar.** Esconder daria a impressão de que a tela é a barreira, que é o que `docs/ARCHITECTURE.md` secao 18 proíbe presumir. Quem não tem permissão recebe a mensagem da própria RPC ao tentar.

**Defeito latente encontrado ao escrever os testes, NÃO corrigido aqui:** `support_case_events.actor_user_id` é `references profiles(id) on delete set null` — e um SET NULL é um UPDATE, que o trigger append-only da própria tabela **recusa**. Consequência em produção: **um usuário que já triou não pode ser removido do sistema**, e o erro que aparece fala de append-only, não de "usuário em uso". Apareceu porque a limpeza global da suíte de integração quebrou; contornado com um ator dedicado fora do padrão de limpeza (mesma técnica de D-065). A correção real é uma decisão à parte — o precedente do projeto para ator de auditoria é `on delete restrict` (`stock_movements.created_by`), que torna o bloqueio explícito mas não o remove; a alternativa é a linha de auditoria não depender do usuário ainda existir. Registrado no HANDOFF.

**Verificação:** 11 testes de integração contra Postgres real (`rls.integration.test.ts`, 323 no total) cobrindo caminho feliz com evento gravado, `resolved_at` preenchido e limpo, atribuir/liberar, no-op sem evento, e as cinco fronteiras de recusa (papel, acesso à conta, status inválido, responsável de outra organização, atribuir+desatribuir juntos) mais `anon`. **E um teste E2E** (`atendimento.spec.ts`, 9 no total, todos verdes) que atravessa a cadeia inteira pela UI real com login real: clique → Server Action → RPC → transação. `check` 29/29 e `build` 8/8 verdes. Tipos regenerados contra o banco local (+45 linhas, só a função nova).

**Impacto:** `supabase/migrations/20260826120000_create_support_case_triage.sql` (novo). `apps/web/app/atendimento/actions.ts` e `triage-cell.tsx` (novos), `page.tsx` (coluna Triagem, embed de `profiles`). `packages/db/src/types.ts`, `rls.integration.test.ts` (+11), `apps/web/e2e/atendimento.spec.ts` (+1).

## D-095 — Detalhe do atendimento: a conversa aparece, e `body_state` nunca vira bolha em branco

**Contexto:** próxima etapa registrada no `docs/HANDOFF.md`, e pré-requisito do envio de resposta — a Caixa de Entrada (D-090) mostra QUE existe um atendimento, mas não o que a pessoa perguntou. `support_messages` guarda o transcript desde D-086 e nenhuma tela o consumia.

**Decisão 1 — `body_state` é renderizado como texto explícito, nunca como ausência.** É a regra sutil de D-086: o Mercado Livre devolve texto **vazio** em conteúdo `BANNED`, e `UNDER_REVIEW` vira `MODERATED`. Mostrar uma bolha em branco apagaria duas informações de uma vez — que existiu uma mensagem ali, e por que ela não está visível. Estado diferente de `AVAILABLE` vira o rótulo em itálico, visualmente distinto do que a pessoa escreveu. Coberto por E2E com uma mensagem banida no seed.

**Decisão 2 — atendimento inexistente e atendimento de outra conta dão o MESMO 404.** A RLS já esconde o que o usuário não alcança, e `maybeSingle` devolve `null` nos dois casos. Distinguir ("existe mas você não pode ver") revelaria a existência de um atendimento de outra conta — o mesmo raciocínio que faz a tela de login não dizer se o e-mail existe.

**Decisão 3 — a fonte do prazo é exibida junto do prazo.** D-084 é explícito: prazo ausente nunca vira estimativa apresentada como oficial, e toda exibição informa a fonte. A seção só aparece quando há prazo — nenhuma ingestão preenche `support_case_deadlines` hoje, e uma seção vazia permanente seria promessa sem lastro.

**Decisão 4 — `support_case_events.event_type` ganhou vocabulário PRÓPRIO de rótulos**, separado de `domain_events.event_type`. São coisas diferentes: só transições escolhidas viram `domain_events support.*` (D-084), enquanto o histórico do atendimento registra tudo, inclusive o que nunca notifica. Misturar os dois mapas faria um código novo de um aparecer traduzido pelo outro.

**Decisão 5 — a triagem é a MESMA `TriageCell` da lista.** Sem componente novo e sem segunda implementação: a autorização real está na RPC de D-094, e duplicar o controle criaria duas superfícies para manter em sincronia.

**Escopo deliberadamente ausente:** envio de resposta (comando privilegiado da `apps/api`, D-071/D-084), sugestão do Copiloto, anexos e paginação do transcript (teto de 50 eventos no histórico; a conversa não tem teto porque uma pergunta tem duas mensagens).

**Verificação:** `check` 29/29, `build` 8/8 (`/atendimento/[caseId]` aparece como rota dinâmica), **10 specs E2E verdes** contra Postgres real com login real — o novo atravessa lista para detalhe e prova o texto real da pergunta, a mensagem banida nomeada, o link do SKU e a seção de histórico. O seed do E2E ganhou o transcript, incluindo de propósito uma mensagem `BANNED`: sem ela, a regra mais sutil da tela não teria cobertura.

**Impacto:** `apps/web/app/atendimento/[caseId]/page.tsx` (novo), `apps/web/app/atendimento/page.tsx` (linha vira link), `apps/web/lib/labels.ts` (quatro mapas novos), `apps/web/e2e/{seed,seed-output}.ts` e `atendimento.spec.ts` (+1). Só `apps/web` — deploy automático pela Vercel.

## D-096 — Envio de resposta: a primeira escrita do projeto no Mercado Livre, e o único job que NÃO pode retentar

**Contexto:** última peça registrada da Fase 7B. A Caixa de Entrada (D-090), a triagem (D-094) e o detalhe (D-095) tornaram o atendimento visível e gerenciável; faltava responder. Tudo no projeto até aqui, sem exceção, só LIA do Mercado Livre.

**Decisão 1 — a `api` autoriza e registra; o `worker` envia.** Não é atalho: é o mesmo desenho de todo comando privilegiado do projeto — `/v1/nfe-imports/:id/apply` e `/v1/erp-imports/:id/apply` também validam e enfileiram — e `docs/ARCHITECTURE.md` secao 5 é explícito que a `api` nunca faz trabalho longo inline. Um envio são DUAS chamadas remotas (revalidar e postar). O ganho concreto: o `ensureAccessToken` com a trava do `refresh_token` de uso único (D-046) continua existindo num lugar só, no worker. Duplicá-lo na `api` criaria dois refreshes concorrentes invalidando o token um do outro — exatamente o que a trava existe para impedir.

**Decisão 2 — `support_reply_attempts` nasce PENDING ANTES da chamada remota, e transiciona UMA vez.** É um refinamento explícito de D-084 decisão 8, que fala em "uma linha imutável". Escrever a linha só DEPOIS tornaria imutabilidade e auditoria incompatíveis: uma queda entre o POST e o INSERT deixaria uma resposta já entregue ao comprador SEM registro nenhum, e a tentativa seguinte mandaria a segunda cópia. O que D-084 protege continua protegido — `final_text`, `suggested_text`, `requested_by` e `client_request_id` nunca mudam, e nada é apagado; um trigger recusa DELETE e qualquer UPDATE que não seja PENDING → terminal. "Resultado incerto" deixa de ser conceito e vira estado observável: **uma linha parada em PENDING significa exatamente "não sabemos se saiu"**, e existe índice parcial para encontrá-las.

**Decisão 3 — `retryable: false` depois do POST, mesmo em 5xx.** É a diferença deste job para todos os outros do projeto e a decisão mais importante desta entrega. Num sync, 5xx significa "tente de novo"; num `POST /answers`, 5xx pode significar que a resposta CHEGOU ao comprador. Retentar produziria duas respostas. Falhas ANTES do POST (token, revalidação) continuam retryable, porque nada saiu — e nesse caso a tentativa nem é resolvida, segue PENDING para a próxima entrega. Reenviar de verdade exige nova confirmação humana, com `clientRequestId` novo, e quem confirma vê antes que a anterior falhou.

**Decisão 4 — revalidação do estado remoto NA HORA, sempre.** `support_cases.remote_reply_state` é dica conservadora calculada na última sincronização (D-086, decisão 3). Entre ela e o clique, a pergunta pode ter sido respondida por outra pessoa, deletada ou retida. O worker refaz `GET /questions/{id}` e recusa se não estiver `UNANSWERED`, `hold` ou `deleted_from_listing` — e registra o motivo na tentativa.

**Decisão 5 — o `clientRequestId` é gerado no NAVEGADOR, não na `api`.** Um id novo a cada request não deduplicaria nada; a garantia inteira contra resposta duplicada mora nessa chave. O formulário mantém o mesmo id enquanto o texto não muda, então duplo-clique, F5 e retry de rede convergem para a MESMA tentativa. A `api` reconhece a chave e devolve o estado real (`already_sent`, `in_flight`, `previously_failed`) em vez de enviar de novo — e a corrida no INSERT (23505) também não enfileira.

**Decisão 6 — a mensagem outbound vem de RELER o Mercado Livre, não do que achamos que mandamos.** Depois do envio o worker refaz o `GET` e persiste com o mapper de D-086. O transcript passa a refletir o que o Mercado Livre registrou de fato, e nenhuma projeção é duplicada dentro da `api`. Falha nessa releitura NÃO desfaz o envio nem falha o job: a resposta saiu e está registrada; a reconciliação de 10 minutos (D-092) traz a mensagem.

**Decisão 7 — OPERADOR responde.** Atender é o trabalho dele (D-084). ANALISTA e VISUALIZADOR leem e não respondem, e a rota devolve 403 — coberto por teste.

**Escopo deliberadamente ausente:** sugestão do Copiloto (a coluna `suggested_text` já existe e é aceita pelo contrato, mas nada a preenche), templates e respostas rápidas, anexos, e resposta a mensagens pós-venda e reclamações — canais que nem ingestão têm.

**Verificação:** `check` 29/29 e `build` 8/8 verdes. **29 testes de unidade novos** nas duas metades — 14 na `api` (fronteira de organização como `not_found` e não "sem permissão", canal não-Pergunta, os três estados de idempotência, corrida 23505, texto nunca logado) e 15 no worker (ordem revalidar-antes-de-postar, tentativa já resolvida não reenvia, os quatro estados remotos que bloqueiam, **5xx no POST não retryable**, falha de revalidação retryable sem resolver a tentativa, falha de re-sync não derruba o job). Mais 5 testes de rota em `app.test.ts` (503, 401, 403 para ANALISTA, 400 sem `clientRequestId`, 200 enfileirando na fila da conta) e 15 asserções de integração da tabela.

**Verificação que NÃO foi feita, e por quê:** o envio real a uma pergunta de verdade. Postar uma resposta a um comprador real é irreversível e não é algo a fazer para validar código — a confirmação vai vir do primeiro uso humano deliberado. **E o Docker não subiu nesta máquina na sessão de fechamento**, então migration, testes de integração e E2E foram verificados pela CI, não localmente — a mesma situação de D-069 a D-082, registrada aqui para não parecer que houve verificação local que não houve.

**Impacto:** `supabase/migrations/20260826140000_create_support_reply_attempts.sql` (novo). `packages/mercado-livre/src/questions.ts` (`postQuestionAnswer`) + `index.ts`. `apps/api/src/support-reply.ts` + `.test.ts` (novos), `app.ts` (rota), `index.ts`, `app.test.ts`. `apps/worker/src/handlers/send-support-reply.ts` + `.test.ts` (novos), `index.ts` (registro). `apps/web/app/atendimento/[caseId]/reply-form.tsx` (novo) e `page.tsx` (seção Responder + tentativas), `lib/labels.ts`. `packages/db/src/{types,rls.integration.test}.ts`, `apps/web/e2e/atendimento.spec.ts` (+2).

## D-097 — Ingestão de Mensagens pós-venda: a conversa como unidade, e um contrato permissivo de propósito

**Contexto:** a Caixa de Entrada existia desde D-090, mas só Perguntas chegavam nela. Mensagem pós-venda — o canal onde o cliente pergunta do pedido que JÁ comprou — não tinha ingestão nenhuma. Era o buraco maior do SAC.

**Decisão 1 — a unidade de ingestão é a CONVERSA, nunca a mensagem solta.** O webhook do tópico `messages` entrega o ID de UMA mensagem, e seria natural persistir só ela. Não dá: `conversation_status` — de onde sai o estado de resposta do case — vive no envelope da conversa, não na mensagem. Um case criado a partir de uma mensagem isolada nasceria sem saber se a conversa aceita resposta e sem as mensagens anteriores. Então o webhook resolve `mensagem → pack/pedido` com `GET /messages/{id}` e só depois lê a conversa inteira. Custa um GET a mais e é o que faz o transcript ser verdadeiro.

**Decisão 2 — o contrato é ESTRITO na estrutura e PERMISSIVO nos valores, porque as duas páginas oficiais discordam entre si.** Lendo ao vivo "Gestão de mensagens pós-venda" e "Mensagens pendentes" no mesmo dia, a MESMA resposta aparece com `from.user_id` número numa e string na outra; `status` `"available"` numa e `"IN_MODERATION"` na outra; moderação em `source` numa e `by` na outra; `to` presente numa e ausente na outra; `message_resources[].name` `"sellers"` numa e `"seller"` na outra. Um enum fechado transformaria variação cosmética do Mercado Livre em perda de atendimento — então normalizamos na comparação em vez de enumerar, e um `status` desconhecido atravessa em vez de derrubar a conversa. O que continua rígido é a forma: sem `id`, sem `from.user_id` numérico, a mensagem é recusada.

**Decisão 3 — `mark_as_read=false` é fixo no adaptador, não parâmetro.** A página "Mensagens pendentes" apresenta o GET SEM esse parâmetro **como a forma de marcar mensagens como lidas**. Ou seja: a diferença entre ler e alterar o estado operacional do vendedor é um parâmetro de query. Expor a flag ao chamador seria criar o acidente — não existe caso de uso da ingestão que queira `true`. É D-083 decisão 2 virando código.

**Decisão 4 — o ID do Agente de Mensageria NUNCA vira cliente.** Desde 02/02/2026 no MLB, ler uma conversa intermediada devolve `from.user_id` do AGENTE (`3037675074`), não do comprador. Tratá-lo como cliente criaria um "comprador" único compartilhado por toda a operação. O mapper classifica os seis IDs de agente publicados como `MERCADO_LIVRE_AGENT` — direção continua INBOUND, porque funcionalmente é o comprador falando — e `customer_external_id` fica **null** quando o único interlocutor é o agente. Null é a resposta certa, não uma falha.

**Decisão 5 — o webhook IGNORA `actions: ["read"]`.** O tópico dispara tanto para `created` quanto para `read`. `read` avisa que a contraparte leu; não há conteúdo novo, e a V3 nem persiste `date_read`. Buscar a conversa inteira nesse caso gastaria um GET do pool compartilhado de 500 rpm para gravar o que já estava gravado — e numa conversa ativa `read` chega tanto quanto `created`, dobrando o custo sem mudar uma linha do banco. Ausência de `actions` é tratada como conteúdo novo: perder mensagem é pior que um GET a mais.

**Decisão 6 — a reconciliação varre "não lidas", e o recorte é limitação da API, não escolha.** Não existe endpoint que liste todas as conversas de uma conta, nem filtro por data — só `/messages/unread`. Consequência aceita conscientemente e escrita no código: **uma conversa que alguém já leu pelo app do Mercado Livre não é trazida por esta varredura**; ela entra pelo webhook quando houver mensagem nova. Fingir cobertura total seria mentir sobre o que a integração faz. Cadência de 10 minutos, igual à de Perguntas e pelo mesmo motivo medido: enquanto o painel não for configurado, o webhook não chega (D-091) e esta é a ÚNICA porta de entrada.

**Decisão 7 — vínculo por PEDIDO, e um pack tem vários.** A Pergunta se liga a um anúncio; a conversa se liga a pedidos. Para um pack, todos os `orders.pack_id` correspondentes viram `support_case_links` com `link_source: 'ORDER_DERIVED'`. Se o pedido ainda não foi sincronizado, fica um vínculo externo rastreável que a próxima passagem substitui — mesma coreografia de D-086 com anúncios, e pela mesma razão: remover o fallback antes do vínculo tipado abriria uma janela com o case apontando para lugar nenhum.

**Decisão 8 — zeros à esquerda são normalizados.** O exemplo oficial traz `message_resources[].id` como `"000011122344"`. Sem normalizar, `00123` e `123` seriam duas `external_case_key` para o mesmo pack — dois cases para a mesma conversa.

**Escopo deliberadamente ausente:** **envio** de mensagem pós-venda (`POST /messages/packs/...`), anexos, o fluxo de contato iniciado pelo vendedor (`action_guide`, motivos permitidos) e a ingestão de reclamações/devoluções/mediações. A tela de detalhe já mostra a conversa porque D-090/D-095 foram escritas genéricas por canal; o formulário de resposta segue restrito a `QUESTION`, que é o único canal com envio implementado (D-096).

**Verificação:** `check` 29/29 e `build` 8/8 verdes. **60 testes novos** — 28 no contrato (`packages/mercado-livre`), incluindo os fixtures VERBATIM das duas páginas oficiais divergentes, o descarte de `email`/`name`, o agente nunca virando cliente e `mark_as_read=false` fixo; 14 no handler por conversa; 10 na reconciliação; 9 na porta de persistência. Mais 4 testes de roteamento de webhook, 2 de rota de agendamento e 1 asserção de integração do CHECK alargado. **O Docker não subiu nesta máquina**, então migration, integração e E2E ficam por conta da CI — dito aqui para não parecer verificação local que não houve.

**Verificação em produção, 2026-08-27:** implantado (`worker-00026-nrp`, `api-00021-gmw`) e disparado à mão. **4 contas, 14 conversas e 150+ mensagens ingeridas, zero falhas** — o que também confirmou que a permissão "Comunicação pré e pós-venda" está concedida (sem ela seria 403 em toda a varredura). A contagem cresceu sozinha entre duas medições, com o tráfego real do dia.

**Defeito encontrado SÓ com dado de produção — e a consequência que ele revelou.** `conversation_status.status_date` volta praticamente no instante da consulta. Como o mapper o incluía num `max()` com os horários das mensagens, TODAS as conversas ficavam com `last_activity_at` igual ao segundo da sincronização, e a Caixa de Entrada — que ordena por `last_activity_at desc` — perdia a noção de recência. Corrigido: `status_date` é fallback para conversa SEM mensagem, nunca concorrente delas.

**O reparo expôs um limite operacional da decisão 6 que vale registrar:** as linhas escritas pelo código com defeito **não se auto-corrigiram**. A reconciliação só enxerga conversas NÃO LIDAS, então uma conversa já lida fica fora do alcance da varredura — e com ela, fora do alcance de qualquer correção de mapper. As 9 linhas afetadas foram reparadas com o mesmo valor que o código calcula (`max(support_messages.occurred_at)`), derivado de dado já gravado, não inventado. **Generalizando: um bug de mapeamento em Mensagens não é curável por "rodar a sincronização de novo"** — ao contrário do que vale para Pedidos ou Perguntas. Qualquer correção futura aqui precisa prever o reparo do histórico.

**Impacto:** `packages/mercado-livre/src/messages.ts` + `.test.ts` + `test/fixtures/messages/` (6 fixtures oficiais), `index.ts`. `apps/worker/src/handlers/{persist-support-conversation,sync-support-messages,sync-support-messages-reconcile}.ts` + testes, `sync-runs.ts` (`SyncResource`), `index.ts`. `apps/api/src/{webhook,app,index}.ts`, `account-reconcile-schedule.ts` (motor extraído) e `support-messages-schedule.ts` (novos), `support-questions-schedule.ts` (passa a usar o motor comum). `supabase/migrations/20260826180000_add_messages_sync_resource.sql`. `infra/cloud-scheduler.sh` (`v3-support-messages-reconcile`). `packages/db/src/rls.integration.test.ts`.

## D-098 — GRANTs excessivos reintroduzidos depois de D-066: revoga e ganha um teste-guarda permanente

**Contexto:** D-066 mediu e revogou INSERT/UPDATE/DELETE de `authenticated` em 23 tabelas que os privilégios padrão do projeto expunham sem policy de escrita. Dois dias depois, quatro migrations novas (`notifications`/`notification_recipients` em D-073, `ai_runs` em D-077, `feature_suggestions` em D-079) recriaram exatamente o mesmo padrão — deram só os GRANTs intencionais sem revogar o default, e GRANTs são aditivos. As sete tabelas de support (D-085/D-096) nasceram limpas (revoke na criação). Achado na varredura de pendências de 2026-08-27, junto com uma contradição documental: a migration `20260825170000` afirma em comentário que "Supabase 2026 não expõe tabela nova por default" — o oposto do achado MEDIDO de D-062/D-066, sem que nenhum documento registre qual vale.

**Decisão 1 — revogar nas quatro tabelas** (migration `20260827130000_revoke_excess_authenticated_grants_round2.sql`), preservando o que policy cobre: `notification_recipients` mantém UPDATE (marcar lida), `feature_suggestions` mantém INSERT/UPDATE (enviar/triagem), `notification_preferences` fica intocada (CRUD intencional). Revoke é idempotente — se o comentário da 20260825170000 estiver certo e não houver grant excessivo, vira no-op inofensivo.

**Decisão 2 — a auditoria pontual vira INVARIANTE:** teste de integração novo (`rls.integration.test.ts`, describe "guarda de GRANTs") que falha para QUALQUER tabela de `public` com privilégio de escrita para `authenticated` sem policy correspondente (`has_table_privilege` × `pg_policies`). É a lição real deste episódio: D-066 auditou um estoque e o padrão voltou em 48 horas — só um teste que roda a cada CI segura a porta. De quebra, o teste decide empiricamente a contradição documental acima a cada execução, seja qual for o default do engine do momento.

**Verificação:** typecheck/lint/test/build (monorepo completo) verdes. **Confirmado pela CI**: job `integração` rodou os 337 testes de `rls.integration.test.ts` contra Postgres real, incluindo o teste-guarda — que passou COM a migration de revoke aplicada, provando empiricamente que depois dela nenhuma tabela de `public` dá escrita a `authenticated` sem policy; migration aplicada no Supabase Dev (job `aplicar migrations`).

**Impacto:** migration nova, +1 teste de integração. Nenhuma mudança de comportamento para usuário — RLS já negava as escritas; é aperto de superfície, como D-066.

## D-099 — Ator de tabela append-only: `on delete restrict`, fechando D-094 e o gêmeo que D-094 não viu

**Contexto:** D-094 registrou o defeito latente de `support_case_events.actor_user_id` (`on delete set null` numa tabela cujo trigger append-only recusa o UPDATE que o próprio SET NULL dispara — deletar um usuário que já triou falhava com a mensagem ENGANOSA "support_case_events e append-only: UPDATE nao e permitido") e deixou a correção como decisão à parte. A varredura de 2026-08-27 achou o gêmeo não citado: `purchase_order_events.actor_user_id` (D-034, 20260822234353) tem exatamente a mesma combinação SET NULL + triggers `no_update`/`no_delete` — dormente desde 2026-08-22.

**Decisão — `on delete restrict` nas duas FKs** (migration `20260827140000_fix_append_only_actor_fk_on_delete.sql`), seguindo o precedente interno unânime das quatro colunas de ator que já evitavam a armadilha: `stock_movements.created_by` (cujo comentário documenta o problema desde 2026-08-21), `purchase_order_items.created_by`, `action_decisions.created_by` e `support_reply_attempts.requested_by` (que cita D-094 nominalmente). `restrict` NÃO torna o usuário removível — linha de auditoria não sobrevive sem o ator, o bloqueio é o comportamento correto — o que muda é o diagnóstico: "violates foreign key constraint" em vez do erro de append-only apontando para o lugar errado. A alternativa (auditoria sem FK de usuário, como `domain_events`) reescreveria o contrato das duas tabelas — maior que a dor.

**Verificação:** dois testes de integração novos (describe "ator de tabela append-only"): um de COMPORTAMENTO (ator dedicado fora do padrão de limpeza — mesma técnica de D-094 — referenciado por um `purchase_order_event`; o DELETE do profile falha com erro de FK e NÃO com erro de append-only) e um de CATÁLOGO (`pg_constraint.confdeltype = 'r'` nas duas FKs, cobrindo `support_case_events` sem montar um caso completo). **Confirmado pela CI** (337 testes verdes contra Postgres real; migration aplicada no Supabase Dev). **A primeira rodada da CI reprovou por um erro de FIXTURE que é a própria lição da decisão** (`459b976`): os testes passaram todos, mas o `afterAll` global quebrou porque o `purchase_order` fixture tinha `created_by = ADMIN_SB` (usuário que a limpeza apaga) — `purchase_orders.created_by` é `restrict` e o pedido é permanente (o DELETE cascatearia para `purchase_order_events`, que o trigger append-only recusa). Corrigido apontando o `created_by` para o mesmo ator dedicado permanente — a armadilha de ator-referenciado-por-linha-imortal existe em DUAS colunas do fixture, não numa.

**Impacto:** migration nova (+2 testes). `ADD CONSTRAINT` revalida as linhas existentes — inofensivo, todo ator é válido ou nulo. Fecha a pendência aberta de D-094.

## D-100 — Aviso de orçamento de IA: a pendência mais antiga do projeto, fechada com um evento mensal deduplicado

**Contexto:** D-082 (2026-08-25) decidiu teto de R$100/mês com política "avisa, não bloqueia" — e o mecanismo nunca foi implementado: `ai_runs.cost_usd` acumulava o custo real de cada chamada desde o mesmo dia, mas nada somava o mês nem avisava ninguém. `docs/HANDOFF.md` registrava como "pendência mais antiga do projeto"; na prática o gasto com a Anthropic era ilimitado e não observado.

**Decisão 1 — a soma é SQL, a interpretação é pura, o aviso é um `domain_event`:** RPC nova `get_ai_monthly_cost_usd` (migration `20260827150000`, `security invoker`, intervalo half-open, usa o índice `(organization_id, created_at)` que existe desde a criação da tabela) + `evaluateAiBudget` (`@sb/domain/events/ai-budget.ts`, pura, 7 testes) + handler `maintenance.check-ai-budget` no worker + gatilho `/internal/schedule/ai-budget` na api + job `v3-check-ai-budget` no Cloud Scheduler (diário, 9h SP — **a contagem esperada de jobs passa de 11 para 12**: D-097 já havia criado o 11º, `v3-support-messages-reconcile`; a nota original desta entrada dizia "10 para 11" por contagem defasada, corrigida ao rodar `cloud-scheduler.sh` e contar os jobs reais). Emite `ai.budget.exceeded` (severidade "importante" — "avisa, não bloqueia" não é criticidade de dado errado), que o fan-out de D-073 transforma em notificação durável + toast sem nenhum código novo de entrega.

**Decisão 2 — um aviso por organização por mês, sem estado novo:** o `dedup_key` do evento embute organização e mês (`ai-budget:{org}:{YYYY-MM}` — `domain_events.dedup_key` é UNIQUE GLOBAL, a organização precisa estar na chave). O job roda todo dia; do segundo dia acima do teto em diante, o INSERT deduplica em silêncio (`ignoreDuplicates`, D-092). No mês seguinte a chave muda sozinha. Mesmo modelo do `dedup_key` diário de `stock.balance.diverged`, só que mensal.

**Decisão 3 — teto em USD com conversão administrativa fixa:** D-082 fixou o teto em reais, mas `cost_usd` é USD e o projeto não tem (nem quer — três testes de entrada de infraestrutura) API de câmbio. `AI_MONTHLY_BUDGET_USD` (env var do worker, default 18 = R$100 a ~5,5 R$/US$, conservador) com o MESMO default no `envSchema` e no `infra/lib.sh` — esquecer a variável num ramo do script de deploy (risco já materializado três vezes no projeto) não derruba o boot. Como a política é "avisa, não bloqueia", imprecisão de câmbio só desloca o momento do aviso.

**Decisão 4 — desvio consciente do "avisa o ADMIN" de D-082:** evento organizacional (`ml_account_id` nulo) alcança TODOS os membros pelo fan-out de D-073, não só ADMIN. Restringir por papel exigiria regra por tipo de evento na trigger genérica — acoplamento que não vale para a organização única real de hoje, onde o ADMIN está entre os poucos membros. Quem não quiser o aviso silencia por `notification_preferences` (D-076). Registrado como desvio, não esquecimento.

**Verificação:** typecheck/lint/test/build (monorepo completo) verdes — 7 testes novos de domínio (`evaluateAiBudget`: teto exato não avisa, dedup por mês/organização, teto inválido lança), 7 do handler (custo como string do PostgREST, soma nula = zero, evento organizacional sem `ml_account_id`, dedup mensal na chave), 5 do gatilho da api, 3 do envSchema. **CI confirmou** a migration aplicando contra Postgres zerado (job `integração`, 337 testes verdes) e no Supabase Dev (job `aplicar migrations`). `packages/db/src/types.ts` regenerado contra o Dev real (`--project-id`, mesmo caminho de D-073) logo depois — o cast `as never` temporário do handler durou um commit e já foi removido. **Deployado e OPERACIONAL desde 2026-08-27** (autorização durável de deploy concedida pelo usuário no mesmo dia): `worker-00027-662`/`api-00022-dbf` (tag `839e29d`), job `v3-check-ai-budget` criado (`0 9 * * *`), disparo manual validou ponta a ponta em produção — `ai_budget_schedule_triggered` → `ai_budget_checked` com `month_cost_usd: 0.005192`, `budget_usd: 18`, `exceeded: false` (o custo real acumulado das narrações de D-082 até aqui: meio centavo de dólar).

**Impacto:** migration + RPC novas; `@sb/domain` (+`evaluateAiBudget`, +`ai.budget.exceeded` no catálogo); worker (handler + env var); api (gatilho + rota); `apps/web/lib/labels.ts` (rótulo); `infra/cloud-scheduler.sh` (11º job), `infra/deploy-cloud-run.sh`/`lib.sh` (env var). Fecha o item 10 das "Pendências técnicas imediatas" do HANDOFF (código completo; operação pendente de deploy autorizado).

## D-101 — O webhook VIVE: a primeira hora de tráfego real revelou três contratos errados

**Contexto:** o usuário configurou o painel do Mercado Livre (URL de callback exata + TODOS os tópicos marcados) e, em 2026-08-27 ~13h/UTC, o webhook recebeu tráfego real pela primeira vez na história do projeto — ~100 notificações/2h de 9 tópicos (`stock-locations` 45, `shipments` 23, `payments` 7, `orders_v2` 3, `post_purchase` 3...). Fecha o achado de D-091 ("o webhook NUNCA foi chamado") e destrava o marco da Fase 3 de verdade. E, exatamente como D-091 previa, o primeiro tráfego real quebrou o que nunca tinha rodado: três falhas distintas nos logs, todas de CONTRATO.

**Achado 1 — `GET /orders/{id}` NÃO traz `date_last_updated` (48 tentativas de retry em 2h para 3 pedidos):** o ZodError de produção tinha exatamente UM path. O formato por id difere do `/orders/search` (reconciliação), que sempre o traz — a dualidade que D-048 documentou sem saber que era condicional ao endpoint. Como o fast path nunca tinha executado com pedido real, o schema só conhecia o formato do search. **Correção:** `date_last_updated` opcional no `orderSchema`; `persistOrder` deriva `lastUpdatedAt = date_last_updated ?? last_updated ?? date_created` — cascata só de campos do PRÓPRIO pedido, nunca `now()` (o relógio continua sendo o do Mercado Livre). O checkpoint da reconciliação (`ml-orders-fetch.ts`) ganhou a guarda conservadora: sem o campo, NÃO avança (checkpoint adiantado pula janela e perde pedido; parado só reprocessa, idempotente).

**Achado 2 — ZodError classificado como retryable no fast path:** o catch antigo tratava tudo que não era `MercadoLivreApiError` como retryable — mas erro de contrato é determinístico, repetir devolve o mesmo payload e falha igual; o retry só acumulou as 48 tentativas. **Correção:** `classifyFetchFailure` — ZodError vira `not_retryable` (a reconciliação por janela é a rede de segurança), mesmo tratamento que `sync-support-messages.ts` já dava desde D-097.

**Achado 3 — o ML também notifica SUB-recursos de claim** (`/post-purchase/v1/claims/{id}/actions-history`, 8 falhas not_retryable): o padrão só aceitava `/claims/{id}` exato. **Correção:** o padrão aceita sufixos e o handler processa o claim PAI — a notificação continua significando "algo mudou neste claim".

**Achado 4 — 4 detalhes de mensagem reprovados no contrato de D-097, e o reason genérico escondia ONDE:** "detalhe de mensagem fora do contrato esperado", sem path. **Não corrigido o contrato — instrumentado:** o reason agora carrega os `issues` do Zod (path/código/mensagem, nunca o conteúdo da mensagem). Corrigir sem saber o campo seria adivinhar (REGRA ABSOLUTA); a próxima notificação real traz a evidência.

**Verificação:** typecheck/lint/test/build (monorepo completo) verdes — 4 testes novos (ZodError not_retryable; order sem `date_last_updated` aceita pelo schema E persistida; fallback em cascata até `date_created`; sub-recurso de claim processa o pai). **Deployado e comprovado em produção em 2026-08-27** (`worker-00028-m2p`, tag `ece7cb7`, sob a autorização durável de deploy): nos primeiros minutos, o fast path drenou os retries pendentes e processou 13 pedidos reais (`webhook_fast_path_done`) + 2 claims (`webhook_fast_path_claim_done` — incluindo `5565782531`, um dos que falhava no `/actions-history`), com ZERO `job_failed` de `sync.webhook.received` na janela. O marco da Fase 3 — pedidos frescos em segundos — funciona de verdade pela primeira vez.

**Impacto:** `apps/worker/src/handlers/{order-schema,persist-order,webhook-received,sync-support-messages,ml-orders-fetch}.ts` (+4 testes). Nenhuma migration. **Fecha o item 5 🔴 do HANDOFF** (painel configurado — ação do usuário — e tráfego real confirmado) e a "primeira observação pendente" do item 3.

## D-102 — Respondida fora da V3 não fica "NOVO" para sempre: transição automática guardada pela atividade remota

**Contexto:** pergunta direta do usuário: "se a pergunta/mensagem já foi respondida via outra plataforma ela não deve aparecer ali como novo — já tem isso no sistema?". Investigado contra o código real: **só parcialmente**. Pergunta que JÁ chega respondida na primeira ingestão nasce `RESOLVIDO` (D-086); mas um case que entrou aberto e foi respondido DEPOIS pelo app do Mercado Livre ficava `NOVO` na Caixa de Entrada indefinidamente — a re-ingestão atualizava só a projeção remota (`external_status: ANSWERED`, resposta no transcript), nunca o status interno, que só a triagem humana movia (D-094). Conversas de mensagens: pior — sempre nasciam `NOVO` e nada as movia. Era exatamente a regra que D-084 previu ("nova atividade inbound reabre para NOVO"; "fechamento remoto fica separado") e D-086 adiou "porque exige evento/transação próprios".

**Decisão 1 — RPC transacional `apply_support_remote_transition`** (migration `20260827170000`), no molde de `triage_support_case`: UPDATE do case + `support_case_events` na MESMA transação (D-084 decisão 6). A regra "sync não sobrescreve decisão humana" vira o GUARD `p_expected_statuses` — fora do estado esperado, devolve `false` sem erro (corrida com triagem é cenário normal). `security invoker` + grant só a `service_role`: só o worker reage a dado remoto; quem clica usa a triagem. `source` aceita `WEBHOOK`/`RECONCILIATION`/`SYSTEM` e recusa `USER` de propósito.

**Decisão 2 — a decisão de QUAL transição é pura, em `@sb/domain/support`** (`evaluateQuestionRemoteTransition`/`evaluateConversationRemoteTransition`, 11 testes): pergunta respondida/encerrada remotamente → `NOVO`→`RESOLVIDO` (dedup `auto-resolve:{caseId}`, sem timestamp — pergunta resolve uma vez, webhook e reconciliação convergem); conversa com o vendedor respondendo por último → `NOVO`→`AGUARDANDO_CLIENTE` (não `RESOLVIDO`: conversa não tem "respondida" terminal, e AGUARDANDO_CLIENTE é semanticamente exato — a bola está com o cliente); cliente respondendo por último → `AGUARDANDO_CLIENTE`/`RESOLVIDO`→`NOVO` (a reabertura adiada em D-086; dedup com timestamp — cada rodada é um fato). Empate de timestamp conta como "vendedor respondeu", evitando oscilação. `occurredAt` sempre do relógio do Mercado Livre, nunca `now()`.

**Decisão 3 — o encanamento roda em TODA ingestão**, nos dois persists (`persist-support-question`/`persist-support-conversation`), com `source` propagada pelos 5 chamadores (webhook=WEBHOOK, reconciliação=RECONCILIATION, releitura pós-envio D-096=SYSTEM). Efeito colateral desejado: responder PELA V3 também resolve a pergunta/move a conversa automaticamente quando ninguém triou.

**Verificação:** typecheck/lint/test/build verdes — 11 testes puros novos (`@sb/domain`), 2 de encanamento (persists chamam a RPC com os args da decisão), 5 de integração contra Postgres real (transição aplica com evento atômico source WEBHOOK sem ator; case triado NÃO é tocado e não ganha evento; reabertura limpa `resolved_at` satisfazendo a constraint; `source USER` recusada; `authenticated` sem execute). **CI confirmou** (342 testes de integração, migration no Dev), types regenerado (cast durou dois commits), **deployado** (`worker-00029-kkv`, depois `worker-00030-kjd` com D-103) — zero falha de support na revisão final.

**Impacto:** migration + RPC novas; `@sb/domain/support` (módulo novo); os 2 persists e 5 handlers do worker; 7 arquivos de teste. A Caixa de Entrada não muda de código — passa a mostrar a verdade porque o estado agora acompanha a atividade remota. Fecha o gap da pergunta do usuário e a pendência de reabertura de D-086.

## D-103 — A instrumentação de D-101 pagou-se em horas: `seller_max_message_length` chega como ZERO

**Contexto:** D-101 instrumentou as falhas de contrato de mensagens para logarem os `issues` do Zod, porque 4 detalhes reprovavam sem dizer onde. Minutos depois do deploy do worker com D-102, o log mostrou o campo exato: `seller_max_message_length` com `too_small: expected number to be >0` — o payload REAL do webhook traz **0** (provável "vendedor não pode responder"), e o schema exigia `.positive()`.

**Decisão — `nonnegative`, e nada além disso:** o campo é validado mas NUNCA consumido por lógica nenhuma (grep confirma: só existe no schema). O `.positive()` original era suposição sobre um campo não usado, violando a própria regra de D-097 ("contrato estrito na estrutura, permissivo nos valores"). Aceitar o valor observado é o fix inteiro; atribuir semântica ao 0 (bloquear resposta?) seria inferência sem fonte — fica para quando o campo for consumido de verdade, com pesquisa própria.

**Verificação:** teste novo com o payload real (`seller_max_message_length: 0` aceito), 103 testes do pacote verdes, typecheck/lint/test/build completos verdes. **Deployado e comprovado em produção** (`worker-00030-kjd`, tag `8ea332f`): na rodada seguinte, ZERO `job_failed` — as conversas que reprovavam ingeriram (`sync_support_messages_done`, via reconciliação E via webhook ao vivo) e as 4 contas completaram a varredura de 10 min.

**Impacto:** `packages/mercado-livre/src/messages.ts` (+1 teste). Fecha o "Achado 4" de D-101.

## D-104 — Claims na Caixa de Entrada, e a mediação NÃO é `type = "mediations"`

**Contexto:** próximo item aberto na ordem incremental da Fase 7B — ingestão read-only de reclamações/devoluções/mediações. O levantamento mostrou a etapa muito mais barata do que parecia: a pesquisa oficial já estava confirmada (`docs/MERCADO_LIVRE.md` 2.10/2.12), o slot `CLAIM` de `support_cases` existia vazio desde D-085 (com a constraint `external_case_key = 'claim:' || external_case_id` e as colunas `is_mediation`/`has_return`), a Caixa de Entrada já oferecia o filtro "Reclamações" retornando vazio, e `claim-return.ts` **já buscava o claim** desde D-057 para reverter estoque. Faltava só a projeção no meio.

**Decisão 1 — mediação é `stage = "dispute"`, corrigindo D-084.** `docs/DATABASE.md` registrava "Mediação (`claim.type = 'mediations'`)". A leitura oficial ao vivo (2026-08-27) contradiz: a mesma página define `type: "mediations"` como a reclamação comum "entre comprador e vendedor", e `stage: "dispute"` como a "etapa de mediação onde intervém um representante do Mercado Livre". **O próprio exemplo oficial prova**: `type: "mediations"` junto de `stage: "claim"`, encerrado pelo vendedor, sem mediação nenhuma. Seguir D-084 literalmente marcaria reclamações comuns como mediação e — como o modelo prevê "mediação crítica" — encheria a Caixa de Entrada de `CRITICA` falso, exatamente a avalanche que a arquitetura existe para evitar (a V2 chegou a 5.243 alertas). `docs/DATABASE.md` foi corrigido, não contornado.

**Decisão 2 — a projeção vem ANTES dos early returns de `claim-return.ts`, e a ordem é o ponto todo.** Aquele handler retorna cedo quando o claim não tem devolução física — e reclamação sem devolução (mediação, disputa de pagamento) é justamente o que o SAC precisa mostrar. Depois do early return, só apareceriam claims que já reverteram estoque.

**Decisão 3 — SAC não derruba estoque; estoque continua derrubando tudo.** Dois domínios num handler só foi escolha deliberada (aprovada pelo usuário): o claim já está carregado, e re-buscá-lo gastaria chamada contra uma API limitada. O risco de acoplamento é contido pela assimetria — falha ao projetar o atendimento é logada e engolida (a próxima notificação reconverge, a persistência é idempotente), enquanto falha de estoque continua propagando e sendo repetida pelo Cloud Tasks. Estoque é dado financeiro em produção desde D-057; SAC é projeção de leitura.

**Decisão 4 — sem carimbo de tempo do Mercado Livre, NÃO projeta.** `support_cases.last_activity_at` é `not null`, e a alternativa seria o instante da consulta — precisamente o defeito que D-097 encontrou em produção, achatando a ordenação inteira da Caixa de Entrada. O mapper devolve `null`, o handler loga e segue. `last_updated ?? date_created`, nunca `now()`. Os dois campos entraram como **opcionais** no schema pela lição de D-101 (`GET /orders/{id}` não trazia `date_last_updated` apesar do exemplo): exigi-los transformaria uma ausência em ZodError que derrubaria a reversão de estoque já em produção.

**Decisão 5 — `evaluateClaimRemoteTransition` leva timestamp na `dedupKey`, diferente de PERGUNTA.** Um claim pode reabrir (a doc oficial descreve o estágio `recontact`, "uma das partes entra em contato após o fechamento"). Com a chave fixa que PERGUNTA usa, o segundo fechamento colidiria com o evento do primeiro e seria descartado, deixando o case preso em `NOVO` com o claim fechado no Mercado Livre. Sem isso, a etapa recriaria o bug que D-102 acabou de corrigir.

**Decisão 6 — pedido não sincronizado vira vínculo EXTERNO, não erro.** `support_case_links.order_id` tem FK real para `orders`; um claim de pedido fora da janela de backfill derrubaria a ingestão. Mesmo fallback de D-086 para anúncio, promovido a tipado quando o pedido chega.

**Verificação:** `pnpm run check` **29/29** e `build` **8/8** verdes localmente. **33 testes novos** — 16 do mapper puro (com o exemplo oficial VERBATIM como fixture, incluindo o caso que prova a correção de D-084), 6 da transição de claim em `@sb/domain`, 9 da persistência (idempotência, triagem humana preservada, fallback de pedido, promoção do vínculo) e 4 do wiring (projeta sem devolução; projeta claim que não é de pedido; falha de SAC não impede reversão; claim sem data é pulado e o estoque segue). Regressão do caminho de D-057 verde.

**Escopo deliberadamente fora:** transcript do claim (`GET /claims/{id}/messages`) e prazos (`GET /claims/{id}/detail` → `due_date`) — dois fetches novos com contrato próprio, fatia seguinte. Um case de claim sem transcript cai no estado vazio que a tela de D-095 já trata.

**Impacto:** `apps/worker/src/handlers/{claim-schema,claim-support-projection,persist-support-claim,claim-return}.ts`, `packages/domain/src/support/remote-transition.ts` (+4 arquivos de teste). **Nenhuma migration** — o schema de D-085 já previa o canal. **NÃO deployado.**

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
