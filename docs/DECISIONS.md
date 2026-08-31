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

**Impacto:** `apps/worker/src/handlers/{claim-schema,claim-support-projection,persist-support-claim,claim-return}.ts`, `packages/domain/src/support/remote-transition.ts` (+4 arquivos de teste). **Nenhuma migration** — o schema de D-085 já previa o canal.

**Deployado em 2026-08-27**: `worker-00031-6vh`, imagem `b17e745-dirty`, 100% do tráfego. Só o worker — `git log <revisão-anterior>..HEAD -- apps/api` veio VAZIO, então implantar a `api` seria movimento sem motivo (mesma checagem de D-070). **Verificado por comportamento**: zero linha `ERROR`, zero `WARNING`, zero `job_failed` na revisão nova, que já está processando tráfego real de webhook (`sync.webhook.received`). O sufixo `-dirty` na tag é benigno e vale registrar para não assustar auditoria futura: a única alteração não commitada era uma linha do `.gitignore` (`.claude/settings.local.json`), nenhum código de aplicação.

**O caminho de claim ainda NÃO foi exercitado por dado real.** Nenhum `claim_support_case_persisted` apareceu no intervalo observado — coerente com a medição de D-101, em que `post_purchase` foi 3 de ~100 notificações em 2h. A primeira projeção real deve aparecer quando um claim tiver movimento; até lá, o caminho feliz só foi exercitado contra teste.

## D-105 — O painel de construção mentia em sete pontos, e a correção não é atualizá-lo: é não ter lista escrita à mão

**Contexto:** o usuário abriu a Home publicada e mostrou o painel de progresso da construção (`apps/web/app/page.tsx`, a rota `/` desde a Fase 1). Ele dava **`PENDENTE` para NF-e/XML, Reservado/trânsito, Reconciliação ERP e Pedidos de compra** — os quatro entregues na Fase 4, concluída em 2026-08-23 — e **"Nada começado" para as Fases 5B, 6 e 7**, as três concluídas. Sete afirmações falsas numa tela que existe para informar estado. O pedido foi explícito: "tem que ir atualizando isso aqui, para estarmos sempre alinhado, ou remover de uma vez".

**Decisão — remover a lista, não atualizá-la.** O painel carregava, em comentário no próprio arquivo, a regra que passou a violar: *"Uma página de status que mente é pior que página nenhuma."* Atualizá-lo resolveria hoje e falharia de novo na próxima etapa, porque a fonte era uma constante `PHASES` mantida à mão — o mesmo defeito estrutural que já forçou correções em `docs/HANDOFF.md` e `docs/ROADMAP.md` nesta mesma sessão. **Todo número da tela nova vem de CONSULTA** ao mesmo dado que as telas reais leem: não existe lista para manter, logo não existe como divergir.

**Decisão 2 — a rota `/` vira a Home orientada à atenção, não um redirect.** Um redirect para `/vendas` seria mais barato, mas o nav do `Shell` tem "Visão Geral" apontando para `/`, e ele viraria duplicata do link "Vendas". Além disso o requisito já existia aberto em P1 (`docs/ROADMAP.md`) e em `docs/PRODUCT_REQUIREMENTS.md` ("Home orientada à atenção"): a rota inicial "deve deixar de ser uma página de progresso de construção quando a base funcional estiver suficientemente madura". Está.

**Decisão 3 — quatro contadores nesta fatia, e só.** Ações abertas, atendimentos abertos, atendimentos em mediação e notificações não lidas — as quatro sobre tabelas já provadas (`actions` D-064, `support_cases` D-085/D-104, `notification_recipients` D-073). Ruptura, SKU de alta importância sem Full, alterações de anúncio e decisões aguardando medição ficam de fora porque cada um exige consulta agregada própria; o próprio requisito manda "criar apenas quando houver dado real para sustentá-la". Contagens usam `head: true`, sem trafegar linha.

**Decisão 4 — falha de leitura vira "—", nunca zero** (D-067): um erro de query mostrando `0 ações abertas` é pior que a página antiga, porque some com o problema em vez de anunciá-lo. Cada card carrega `failed` próprio, então uma consulta quebrada não apaga as outras três.

**Achado ao escrever:** o link do card de mediação usava `?channel=CLAIM`, mas o filtro real da Caixa de Entrada lê **`?canal=`** (`apps/web/app/atendimento/page.tsx`). O parâmetro errado seria ignorado em silêncio e o card levaria à lista sem filtro — conferido contra o código, não presumido.

**Decisão 5 — `/` saiu da lista de rotas públicas, e o achado veio de VERIFICAR o deploy.** Logo após publicar, `curl` na raiz devolveu **200 sem sessão**: a proxy tinha `/` em `PUBLIC_EXACT`, com a justificativa escrita no próprio arquivo — *"`/` e o painel de progresso do projeto: conteudo estatico, nenhum dado do negocio"*. A justificativa estava correta e acabara de deixar de valer, porque a tela nova lê `actions`/`support_cases`/`notification_recipients`. Mantida a exceção, um visitante anônimo cairia numa tela de dado de negócio exibindo "Sua conta não está associada a nenhuma organização". A exceção saiu junto com a página estática que a sustentava; `PUBLIC_EXACT` fica vazio e documentado, porque `/` é prefixo de tudo e jamais pode migrar para `PUBLIC_PREFIXES`. Spec E2E novo cobre a regressão — sem ele, alguém reintroduz a rota sem perceber que a página por trás mudou de natureza.

**Verificação:** `pnpm run check` **29/29** e `build` **8/8** verdes. Só `apps/web`: sem migration, sem Cloud Run, deploy automático pela Vercel. **Confirmado em produção em 2026-08-27, medido e não presumido**: `GET /` devolve `307` para `/login?next=%2F` (antes devolvia `200` com o painel), `/login` responde `200`, e a busca pelo conteúdo antigo (`Fase 5B`, `Reconciliação ERP`, `Entrar no sistema`) devolve **zero ocorrências** na página publicada. O `next` preservado prova de quebra que a correção de redirect de D-090 continua valendo.

**Impacto:** `apps/web/app/page.tsx` reescrito (223 linhas de lista estática → tela dirigida por consulta), `apps/web/proxy.ts` (+1 spec E2E). Fecha o item P1 "Substituir a Home de construção pela Home orientada a 'o que precisa da minha atenção hoje?'".

## D-106 — Transcript do claim: sem `id` no payload, a chave TEM de ser fingerprint

**Contexto:** fatia seguinte de D-104 — o case de reclamação existia sem histórico, e a tela de detalhe (D-095) abria com transcript vazio. A pesquisa oficial ao vivo (2026-08-27, registrada em `docs/MERCADO_LIVRE.md` 2.12) foi feita ANTES do código e determinou o desenho inteiro.

**Decisão 1 — `external_message_key` é fingerprint `claim-msg:{sender_role}:{instante de envio}`.** O payload de `GET /claims/{id}/messages` **não tem `id` de mensagem**: é exatamente a hipótese que D-084 previu ao escrever "se o payload oficial não trouxer ID estável, usar fingerprint determinístico documentado — **nunca índice do array**". A proibição do índice não é estilo: a doc filtra em silêncio as mensagens moderadas da CONTRAPARTE, então a mesma conversa volta com um item a menos e todos os índices seguintes deslocados — o transcript se reembaralharia numa re-ingestão.

**Decisão 2 — o TEXTO fica FORA da chave.** Tentador para garantir unicidade, e errado: `status` pode virar `moderated` e o corpo mudar para a MESMA mensagem lógica. Com o texto na chave, moderar criaria linha nova em vez de atualizar a existente, duplicando a mensagem na tela. Sobra `sender_role` + instante; colisão exigiria o mesmo participante mandando duas mensagens no mesmo segundo, e aí a UNIQUE absorve — perder uma duplicata exata é melhor que embaralhar a conversa.

**Decisão 3 — direção sai do NOSSO papel, não de quem reclama.** `players[].type === "seller"` identifica a conta; `role` (complainant/respondent) inverte conforme o tipo do claim — em `cancel_sale` quem reclama é o vendedor. Usar `role` fixo marcaria nossas próprias mensagens como do cliente na metade dos casos.

**Decisão 4 — sem conseguir identificar nosso papel, INBOUND.** `direction` é `not null` e não tem `UNKNOWN`. Errar para OUTBOUND diria "já respondemos" e poderia suprimir atenção de um atendimento aberto; errar para INBOUND no máximo pede atenção a mais. O erro seguro é o que não esconde trabalho. `sender_kind` fica `UNKNOWN`, preservando a incerteza.

**Decisão 5 — o transcript nunca é apagado e reescrito, só acrescentado.** `delete`+`insert` faria o histórico ENCOLHER a cada rodada, porque a filtragem silenciosa de mensagens moderadas da contraparte remove itens da resposta — apagaríamos localmente uma mensagem que existiu de verdade.

**Decisão 6 — falha do transcript não custa o envelope.** É uma chamada a mais contra uma API limitada; erro degrada para lista vazia e loga `claim_transcript_fetch_failed`. Um case sem transcript ainda é um atendimento visível e triável — mesma assimetria de D-104 entre SAC e estoque, um nível abaixo.

**Limite honesto, herdado da API e registrado na doc:** a contagem de mensagens de um claim é um **piso, nunca um total**. Mensagem moderada da contraparte é filtrada sem deixar buraco visível — diferente de `BANNED` em Perguntas (D-086), onde a mensagem existe com corpo vazio. A UI não deve afirmar "N mensagens" como fato.

**Verificação:** `pnpm run check` **29/29**, **51 testes** nos arquivos de claim (18 novos: contrato do array nu com a fixture oficial verbatim, incluindo `reason` vindo como `""` E como `null` no MESMO exemplo; fingerprint estável sob moderação; papéis invertidos; mediador; fallback seguro; estados de corpo; descarte sem instante).

**Impacto:** `claim-schema.ts`, `claim-support-projection.ts`, `persist-support-claim.ts`, `claim-return.ts` (+testes). Nenhuma migration — `support_messages` já previa `MEDIATOR` como `sender_kind`.

## D-107 — Prazos do claim: duas fontes remotas, e o cancelamento é a parte que ninguém lembra

**Contexto:** `support_case_deadlines` existia vazia desde D-085, e por isso a Caixa de Entrada nem oferecia filtro de SLA (registrado em D-090 como corte deliberado: "filtro sobre tabela vazia é pior que filtro nenhum"). Esta fatia preenche a tabela para claims, usando só prazo REMOTO — D-084 é explícito: "usar o `due_date` remoto exato quando presente", nunca inventar SLA concorrente.

**Decisão 1 — as duas fontes que a API expõe, mapeadas para grãos diferentes.** `detail.due_date` (a "data limite para solucionar a reclamação") vira `RESOLUTION`/`ML_CLAIM_DETAIL`, um por case, com `source_reference` NULO — a UNIQUE é `nulls not distinct`, então a re-ingestão atualiza a MESMA linha em vez de empilhar. `players[].available_actions[].due_date` vira `NEXT_ACTION`/`ML_AVAILABLE_ACTION`, com o NOME da ação em `source_reference`: chave natural, estável, uma linha por tipo de ação.

**Decisão 2 — só as ações do VENDEDOR viram prazo.** `available_actions` existe para todos os participantes; listar o prazo do comprador ou do mediador criaria urgência falsa sobre trabalho de outra pessoa numa tela cuja função é dizer o que EU preciso fazer.

**Decisão 3 — o cancelamento é o que faz o filtro de SLA não mentir.** Uma ação some de `available_actions` quando deixa de estar disponível, normalmente porque já foi cumprida. Sem cancelar, a linha ficaria `ACTIVE` para sempre e a Caixa de Entrada mostraria prazo vencido inexistente — o oposto do propósito da tela. Toda ingestão cancela as linhas `ML_AVAILABLE_ACTION` ativas que não estão no payload atual. **Cancela, nunca apaga**: `CANCELLED` preserva que o prazo existiu.

**Decisão 4 — claim fechado cancela, não marca como cumprido.** `MET` afirmaria que o prazo foi respeitado, e a API não diz isso. `CANCELLED` diz a verdade disponível: o prazo não se aplica mais.

**Decisão 5 — `started_at` só existe onde a API o define.** Para `RESOLUTION` é a abertura do claim (por definição, quando aquele prazo começou). Para uma ação disponível a API não diz quando a janela abriu, e chutar viraria SLA falso — fica nulo.

**Degradação:** falha ao buscar `/detail` não custa nada além do prazo de resolução — as ações disponíveis vêm do claim que JÁ está em mãos, então continuam virando prazo. Loga `claim_detail_fetch_failed`. Mesma assimetria de D-104/D-106.

**Verificação:** `pnpm run check` **29/29**, **59 testes** nos arquivos de claim (8 novos, com o exemplo oficial de `/detail` verbatim). Nenhuma migration — a tabela e os quatro valores de `source` existem desde D-085.

**O que isto NÃO entrega:** o filtro de SLA na Caixa de Entrada e a detecção de prazo estourado (`BREACHED`), que exige um job com relógio. A tabela agora tem dado real para sustentar os dois.

## D-108 — Reconciliação de Reclamações: aqui existe janela de verdade, ao contrário de Perguntas

**Contexto:** último item aberto da ingestão read-only da Fase 7B. Desde D-104 só o webhook alimentava claims — **notificação perdida era claim perdido para sempre**, a mesma lacuna que D-089 fechou para Perguntas.

**Pesquisa oficial antes do código (REGRA ABSOLUTA), e ela mudou o desenho.** `GET /post-purchase/v1/claims/search` não estava documentado no projeto. A leitura ao vivo revelou uma API muito mais rica que a de Perguntas — e uma restrição séria.

**Decisão 1 — janela por `range=last_updated:after:...`, com checkpoint real.** D-089 registrou que a busca de Perguntas "não tem filtro por data e não garante ordenação", o que tornou "reconciliar a última janela" inexprimível e forçou o recorte por `status=UNANSWERED` — com a lacuna aceita de "respondida por fora nunca é recuperada". **Aqui nada disso se aplica**: há `range` por `last_updated` e `sort`. `sync_runs.latest_record_at` volta a ser o ponto de onde continuar, como nos jobs de pedido.

**Decisão 2 — o recorte por vendedor é exigência da API, não escolha nossa.** A doc é explícita ao chamar `status=opened` sozinho de "consulta não acotada e custosa", com "risco de rate limiting ou bloqueio da aplicação", e recomenda `players.user_id` + `players.role`. É o que usamos. Consulta só com paginação devolve 400 sistematicamente.

**Decisão 3 — os DOIS papéis são varridos.** O vendedor costuma ser `respondent`, mas em `cancel_sale` é ele quem reclama, e `players.role` é obrigatório junto de `players.user_id`. Varrer só `respondent` perderia silenciosamente uma categoria inteira. Dedupe por `id` evita ingerir duas vezes o claim que apareça nas duas varreduras.

**Decisão 4 — a ingestão completa foi EXTRAÍDA, não duplicada** (`ingest-support-claim.ts`). Webhook e varredura chamam a mesma cadeia envelope+transcript+prazos. Duplicar garantiria que um dia divergissem, e a divergência apareceria como "o claim que veio pelo webhook tem transcript, o que veio pela varredura não".

**Decisão 5 — cadência de 1 hora, não 10 minutos.** Perguntas/Mensagens usam 10 min porque D-092 mediu que o webhook **nunca tinha sido chamado**, então a varredura era o ÚNICO caminho. Para claims, D-101 mediu `post_purchase` chegando de verdade — aqui é rede de segurança. Somado a isso, cada claim custa TRÊS chamadas (busca + transcript + detalhe) e a própria doc alerta para o custo de consultas amplas de reclamação.

**Decisão 6 — o checkpoint NÃO avança em varredura parcial.** Avançar após truncar pularia definitivamente os claims não alcançados. Mesma guarda conservadora que D-101 aplicou ao checkpoint de pedidos. Há ainda 10 minutos de sobreposição no recuo, porque `after` é estrito e um claim atualizado no instante do corte cairia entre duas execuções.

**Decisão 7 — falha ao LER o checkpoint é `retryable`, nunca fallback para a janela larga.** Cair para 7 dias a cada erro transitório transformaria uma falha de leitura em varredura pesada repetida — exatamente o padrão que a doc chama de custoso.

**Detalhes do contrato registrados:** datas exigem milissegundos (400 sem eles); `offset + limit` deve ficar abaixo de 10000; `limit` máximo 100; o material oficial mostra o array ora em `data`, ora em `results`, e o schema aceita os dois (lição de D-097).

**Verificação:** `pnpm run check` **29/29**, 7 testes novos da varredura (dois papéis, filtros exigidos, dedupe, checkpoint, `data`/`results`, fim de paginação, chamadas por claim). Migration `20260827190000` alarga `sync_runs`/`sync_errors` para `claims` — quarta vez com esse formato.

**Impacto:** `ingest-support-claim.ts` (novo, extraído), `ml-support-claims-fetch.ts` (novo), `sync-support-claims-reconcile.ts` (novo), `claim-return.ts` (passa a reusar), `sync-runs.ts`, `apps/api/src/{support-claims-schedule.ts,app.ts,index.ts}`, `infra/cloud-scheduler.sh` (**13º job**). **Fecha o item "Ingestão read-only" da Fase 7B por completo.**

## D-109 — A reconciliação de D-108 nunca funcionou: `sort` foi suposição minha, e a evidência estava sendo jogada fora

**Contexto:** D-108 entrou em produção em 2026-08-27 declarada "deployada e verificada" — worker e api no ar, 13º job criado, zero ERROR nos logs de boot. **Nada disso era falso, e mesmo assim o job nunca funcionou uma única vez.** Uma revisão adversarial do desenho de notificações (workflow de 11 agentes) foi ler `sync_runs` e encontrou: `claims / reconciliation / failed / 28 runs / max_checkpoint = NULL`. Confirmado por consulta direta ao Dev: **100% de falha desde o primeiro minuto**, HTTP 400 do Mercado Livre, nas 4 contas.

**Por que a verificação de D-108 não pegou.** Ela mediu o que costuma bastar — boot sem warning, revisão servindo 100%, zero linha ERROR, 13 jobs no Scheduler — e **as quatro medições estavam certas**. O que faltou foi a única que importava para um job novo: **a primeira execução real**. Eu havia até escrito que ela "ainda não foi observada", e segui em frente. A lição não é "verificar mais", é: **um job agendado só está verificado quando uma execução dele foi lida**, e nenhum sinal de deploy substitui isso.

**Achado 1 — `sort=last_updated:asc` foi suposição, e é a causa provável.** A doc documenta o FORMATO de `sort` (`campo:asc`/`campo:desc`) mas **nunca diz quais campos são ordenáveis**; o único exemplo oficial usa `date_created:desc`. Eu inventei `last_updated:asc` ao escrever D-108 — exatamente o tipo de invenção que a REGRA ABSOLUTA existe para impedir, cometida no mesmo commit em que citei a REGRA ABSOLUTA. **Correção: o parâmetro sai.** Não é chute sobre a causa: é a remoção de uma suposição não verificada que a varredura nunca precisou, porque ela calcula o `max(last_updated)` percorrendo os resultados. Teste-guarda impede que volte sem verificação.

**Achado 2 — a evidência existia e era descartada.** `MercadoLivreApiError` **já carrega o corpo da resposta** (`http-client.ts`, `safeReadJson`), e o handler guardava só `error.message`. Resultado: 28 falhas dizendo "respondeu 400" sem dizer QUAL parâmetro foi recusado. A API documenta que o corpo do 400 enumera os filtros aceitos. **Correção: `describeFailure` anexa o corpo remoto ao `reason`** (limitado a 500 chars; corpo de erro do ML não carrega token nem conteúdo de mensagem). Mesmo molde do "Achado 4" de D-101 — instrumentar para corrigir sobre evidência em vez de adivinhar de novo.

**Por que as duas mudanças juntas, e não uma de cada vez:** a remoção do `sort` se justifica sozinha, independente de ser a causa — é uma suposição não verificada em produção. A instrumentação também se justifica sozinha, e é o que garante que a próxima execução **diga** a resposta se o 400 persistir. Se eu só instrumentasse, deixaria uma suposição conhecida no ar por mais uma hora.

**O que NÃO foi tocado, de propósito:** o `range=last_updated:after:...` sem `before`. A doc traz o formato como `range=campo:after:data,before:data`, o que sugere par obrigatório, MAS a lista oficial de exemplos inválidos mostra `range=last_updated:after:<data sem ms>` recusado **apenas pela falta de milissegundos** — o que implica que `after` sozinho é aceito. Ambíguo. Mexer nele agora seria uma terceira mudança simultânea e embaralharia o diagnóstico. Se o 400 persistir, o corpo instrumentado decide.

**Achado 3 — `status=opened` é exigência da API viva, contra a prosa da doc.** Com a instrumentação no ar, a execução seguinte entregou o corpo: `{"code":400,"error":"bad_request_error","message":"atLeastOneFilterProvided: at least one filter parameter must be provided"}`. A API **não conta `players.user_id` + `players.role` + `range` como filtro**, apesar de a doc listar os três entre os filtros aceitos E recomendar `players.*` como base para "reclamações de um vendedor". A doc também erra a forma do erro (documenta `invalid_query`, a API devolve `bad_request_error`). O que vale é o único exemplo de chamada que a doc publica como funcional — e ele inclui `status=opened`. Acrescentado. Consequência deliberada: claim FECHADO desde a última passada não é reconciliado; o fechamento chega pelo webhook, e um case aberto à toa continua visível na Caixa de Entrada, enquanto um claim aberto nunca visto seria invisível.

**Achado 4 — a BUSCA não devolve o mesmo objeto do DETALHE, e eu presumi que sim.** ZodError em 16 execuções: `data[N].related_entities` ausente. `GET /claims/{id}` traz o campo; `GET /claims/search` não — e o exemplo da própria doc lista os campos da busca sem ele, que eu li sem notar a ausência. **A parte que importa não é o schema, é a semântica**: `has_return` sai desse campo, e ausência significa "esta fonte não informou", não "não tem devolução". Por isso `hasReturn` virou `boolean | null`: na CRIAÇÃO `null` vira `false` (coluna `not null`, "não sei" começa como "não sinalizado"); no UPDATE, `null` **omite a coluna**. Sobrescrever com `false` faria a varredura APAGAR a devolução que o webhook já registrara — a reconciliação destruindo o dado que ela existe para proteger.

**RESOLVIDO E COMPROVADO EM PRODUÇÃO em 2026-08-27** (`worker-00037-t2f`), com três correções em sequência, cada uma revelada pela anterior. Medido depois do disparo manual autorizado:

| Métrica | Antes | Depois |
|---|---|---|
| `sync_runs` de `claims` | 28 `failed`, checkpoint NULL | `done`, checkpoint gravado |
| `support_cases` canal CLAIM | 24 | **268** |
| Em mediação (`is_mediation`) | — | **133** |
| Com devolução (`has_return`) | — | 29 |
| Mensagens de claim | — | **529** |
| `support_case_deadlines` | 9 | **263** |

**A cadeia D-104 → D-108 inteira só foi provada com dado real agora.** Envelope, transcript, prazos e reconciliação existiam há horas em produção sem nunca terem processado um lote de verdade. Os 29 `has_return` preservados confirmam que a regra de não sobrescrever funciona.

**Consequência para a fatia seguinte, e ela é grande:** o desenho de notificações foi feito medindo **5 claims em `stage='dispute'`** — número colhido enquanto a varredura estava quebrada. O real é **133**. Toda estimativa de volume daquele desenho está obsoleta, e um `support.claim.disputed` com severidade `critico` sem guarda de época teria produzido 133 notificações críticas na primeira varredura. **Refazer a medição antes de implementar** — é literalmente o que a primeira crítica bloqueante do workflow exigiu, por outro motivo.

**Impacto:** `ml-support-claims-fetch.ts` (remove `sort`, acrescenta `status`), `sync-support-claims-reconcile.ts` (`describeFailure`), `claim-schema.ts` (`related_entities` opcional), `claim-support-projection.ts` + `persist-support-claim.ts` (`hasReturn` tri-estado), `claim-return.ts` (guarda conservadora), +3 testes-guarda. Nenhuma migration.

## D-110 — Notificações de atendimento, fatia 1: um evento só, e a medição decidiu quase tudo

**Contexto:** primeiro item aberto da Fase 7B depois da ingestão fechada — "Notificações de atendimento — mesma cadeia `domain_events -> severidade -> notifications` da Fase 7, novos `event_type` prefixados `support.*`". O desenho passou por um workflow de 11 agentes (4 leitores paralelos do código real, 3 propostas independentes, 1 juiz, 3 críticos adversariais), que produziu um desenho consolidado E **3 falhas bloqueantes contra o próprio desenho** — e, de quebra, descobriu D-109 ao ler `sync_runs`. Depois de D-109 consertar a varredura, a medição foi refeita contra os 268 claims reais, e ela derrubou a calibração original.

**A medição que decidiu (2026-08-27, Supabase Dev, pós-D-109):** ~35-43 claims novos/dia; **17 mediações novas/dia** (`mediations/dispute`: 68 nascidos em 4 dias); 126 mediações ABERTAS no estoque; devoluções 15/dia; `recontact` raro de verdade (3 no total). O desenho original estimara "unidades por semana" para mediação — colhido enquanto a varredura estava quebrada.

**Decisão 1 — UM evento: `support.claim.disputed`, severidade `importante`.** O proposto em `docs/API.md` era `support.mediation.opened`/`critico`. Renomeado (a entidade do case é o claim; mediação é o `stage` — e o nome antigo sugeriria um case próprio de mediação, o erro que D-104 corrigiu) e **recalibrado: 17 críticos/dia esvaziaria o nível na primeira semana**; o catálogo executável reserva `critico` para dado errado/sincronização morta. Os requisitos autorizam a recalibração em letra: severidades são "regras conceituais iniciais, a calibrar depois com dado real". `critico` de atendimento fica reservado para `support.sla_at_risk`, que é raro e depende do job com relógio (D-107).

**Decisão 2 — `support.claim.opened` FICA FORA, com o número no registro: 35/dia.** `domain_events` é append-only e o fan-out ignora preferências (D-076) — toda emissão vira linha durável na Central para todo membro elegível, sem botão que desfaça. **Errar por menos é reversível (adicionar depois custa uma tarde); errar por mais não é** (~1.000 linhas/mês para sempre). Perguntas e mensagens também ficam fora — severidade condicional sem limiar definido, mesmo caso de `listing.price.changed` que o catálogo se recusa a adivinhar.

**Decisão 3 — quem emite é a RECONCILIAÇÃO, nunca o webhook.** A primeira falha bloqueante provou com dado real: o webhook observa o claim 1-2s após nascer, e 6 claims em 72min se auto-resolveram em minutos — um deles uma MEDIAÇÃO encerrada em 108s, que teria deixado um card crítico obsoleto e indeletável. A varredura horária só enxerga claim que continua ABERTO (`status=opened`, D-109), então **o assentamento vem da própria API, não de um timer**. Custo: até ~1h de latência no aviso; mediação dura dias.

**Decisão 4 — o silêncio da varredura fria é POR CLAIM, nunca por estado de execução.** As outras duas falhas bloqueantes mataram a trava original (`notify = checkpoint existe`) por dois caminhos independentes: ela desarmava para sempre enquanto a varredura nunca tivesse tido sucesso (exatamente o estado em que D-109 a encontrou), e rearmava com a mesma janela fria após um `partial`. A substituta é uma **época testada contra o NASCIMENTO do claim**: `date_created >= max(SUPPORT_EVENTS_EPOCH, ml_accounts.connected_at)`. Cobre primeira varredura, checkpoint congelado, pane prolongada e conta nova (o piso `connected_at` impede o despejo do backlog pré-conexão). As 126 mediações abertas do estoque nasceram antes da época — mudas para sempre, e visíveis na Caixa de Entrada com `priority='CRITICA'`, como sempre.

**Decisão 5 — chave TERMINAL `support.claim.disputed:{support_cases.id}`.** Uma mediação notifica uma vez na vida do case. Chave com timestamp produziria uma notificação POR VARREDURA para cada mediação aberta — 126/hora hoje. O `UNIQUE (dedup_key)` de `domain_events` é de coluna única e o UUID local o satisfaz; mesmo raciocínio de `auto-resolve:{caseId}` (D-102).

**Decisão 6 — comparação de época por INSTANTE, nunca lexicográfica.** O ML carimba com offset (`-04:00`) e a época é `Z`; comparar strings suprimiria um claim nascido `18:30-04:00` (=22:30Z) contra época de 21:00Z. Pego antes do teste; teste-guarda travando.

**Zero migration** — `entity_type` não tem whitelist (verificado em `pg_constraint` no banco vivo pelo workflow), o trigger de fan-out cobre qualquer INSERT, `notification_preferences.event_type` é texto livre. `entityHref` ganhou `support_case -> /atendimento/{id}` — **primeiro evento com destino clicável de detalhe real**.

**Verificação:** `check` 29/29; 9 testes puros novos (`support-events.test.ts`), 3 de emissão na varredura (emite pós-época; época futura silencia; reclamação comum não emite), 4 de `resolveNotifyEpoch`.

**Deployado e COMPROVADO em produção em 2026-08-28** (`worker-00038-t5j`; o primeiro comando de deploy foi perdido por erro interno da ferramenta e a revisão no ar foi CONFERIDA antes de refazer — estava em `cfe8318`/D-109, ou seja, o deploy não tinha acontecido; presumir teria deixado a fatia "entregue" sem estar no ar, o modo de falha exato de D-109). Disparo manual às 11:12Z, medido em seguida: **4 varreduras `done`, EXATAMENTE 1 evento emitido** — de um claim nascido às 10:49Z do próprio dia, 23 minutos antes, bem depois da época — **e ZERO das 126 mediações antigas notificou**. O fan-out gerou 1 notificação. A época silenciou o estoque e deixou passar o fato novo, no primeiro disparo real. O volume inicial fica ABAIXO dos 17/dia medidos e sobe em rampa: `disputed` exige nascido pós-época E já em `dispute`, e a escalada leva tempo — o despejo que o desenho original teria produzido virou uma rampa suave por construção.

**Fora desta fatia, com caminho apontado:** `support.customer_replied` é o melhor candidato à fatia 2 (a RPC de D-102 já devolve se a transição aplicou; exige chave não terminal e as três portas); `sla_at_risk` espera o job com relógio; agrupamento na Central e emissão a partir de ação humana continuam fora (a web não tem INSERT em `domain_events` e o fan-out não é security definer).

## D-111 — Templates de resposta: inserir é pré-preencher, nunca enviar

**Contexto:** próximo item da Fase 7B após as notificações (D-110). `reply_templates` era conceitual desde D-084/D-085. O HANDOFF já anotava: "o de menor risco e o que a operação provavelmente pede primeiro depois de responder algumas vezes à mão" — e a operação responde à mão desde D-096.

**Decisão 1 — compartilhado pela ORGANIZAÇÃO, gerenciado por ADMIN/GESTOR, lido por qualquer membro.** Diferente de `saved_filters` (preferência pessoal): o valor do template é a equipe convergir na mesma resposta. Escrita por **RLS direta com policy checando papel** (`private.is_member_of` + `private.has_role(['ADMIN','GESTOR'])`), o padrão de `feature_suggestions` (D-079) — sem transação multi-tabela não há o que justificar RPC `security definer`. Todo GRANT de escrita tem policy correspondente, o invariante que o guard de D-098 verifica.

**Decisão 2 — SEM placeholders nesta fatia, e o motivo está na tabela.** O requisito exemplifica `{nome}` — mas a V3 não tem o nome do comprador de forma confiável: `customer_external_id` é ID numérico e D-083 proíbe confiar em `from`/`to` (Agente de Mensageria). Substituir por dado errado **numa mensagem enviada a um cliente** é a pior versão de inventar dado. Registrado no `comment on table` para a próxima pessoa não "completar" o recurso sem ler isto.

**Decisão 3 — inserir é PRÉ-PREENCHER.** O requisito: "templates não devem substituir o contexto específico do atendimento". O picker preenche a caixa de D-096 e a pessoa edita e confirma como sempre; inserir template também **troca o `clientRequestId`** — texto novo é tentativa nova, a regra de idempotência de D-096 preservada. `applyTemplate` (puro, testado): campo vazio recebe o texto; rascunho existente ganha o template APÓS linha em branco (nunca apaga); estourou os 2000, **não insere e avisa** — truncar mandaria frase cortada a um cliente.

**Decisão 4 — `body` tem o MESMO teto da caixa de resposta (2000).** Template maior que o campo onde será colado é template que nunca cabe.

**Decisão 5 — `created_by … on delete set null`.** O template sobrevive ao autor sair; `restrict` travaria limpeza de usuários por uma coluna que aqui é contexto, não auditoria — a resposta ENVIADA continua auditada em `support_reply_attempts` (D-096), que é onde auditoria de envio mora.

**Ritual de migration**: aplicada via MCP no Dev, `list_migrations` conferido e o arquivo local **renomeado para a versão que o MCP registrou** (`20260828111752`) — divergência ali faria a CI re-aplicar e quebrar. Types regenerados; o gerador MCP omite o schema `graphql_public` que o arquivo atual carrega, então o bloco novo foi inserido cirurgicamente em vez de sobrescrever o arquivo (diff de 38 linhas, não de centenas).

**Correção de tabuleta no caminho**: o subtítulo da Caixa de Entrada dizia "só perguntas são sincronizadas" — congelado de D-090, falso desde D-097/D-108. Mesma classe do painel de construção (D-105).

**Verificação:** `check` **29/29**; 4 testes de `applyTemplate`, 9 testes de integração RLS novos (membro lê; outra organização não; ADMIN cria/edita com `updated_at` andando; ANALISTA recusado em criar/editar/apagar; UNIQUE de nome; `anon` sem GRANT). Integração roda na CI contra Postgres real.

**Impacto:** migration `20260828111752`, `packages/db/src/types.ts`, `apps/web/lib/apply-template.ts` (+teste), `apps/web/app/atendimento/templates/` (página nova, actions, 2 componentes), `reply-form.tsx` (picker), `[caseId]/page.tsx` (fetch sob RLS, falha degrada para "sem templates"), link na Caixa de Entrada. **Só `apps/web` + banco — sem Cloud Run.**

## D-112 — As duas ferramentas de geração do Copiloto: sugerir resposta e estruturar sugestão

**Contexto:** pedido explícito do usuário — "siga com o copiloto e tente acabar com o máximo de tarefas para conclusão dele". As pendências de IA do Copiloto eram três: **sugestão de resposta de atendimento** (Fase 7B, especificada em `docs/COPILOT.md` secao 11 desde D-071), **estruturação de sugestões de features** (Fase 7, colunas nulas desde D-079) e **planner/streaming/UI de chat** (Fase 7). Esta fatia fecha as duas primeiras — as duas são a mesma família de `narrate_sku_diagnosis` (D-082): contexto determinístico entra, texto revisável sai. A terceira fica fora com motivo (abaixo).

**Decisão 1 — duas ferramentas no MESMO motor de D-077, sem endpoint novo.** `suggest_support_reply` e `structure_feature_suggestion` entram em `TOOLS` de `POST /v1/copilot/query`: mesma validação Zod nas duas pontas, mesma execução sob a RLS do chamador via `UserClient`, mesmo registro em `ai_runs` com custo real — que o aviso de orçamento de D-100 já soma. Zero migration, zero rota.

**Decisão 2 — `suggest_support_reply` NÃO é ferramenta de escrita, e a auditoria fecha o ciclo.** O fluxo literal da secao 11: a ferramenta gera o texto, o humano revisa/edita na caixa de D-096, e o envio continua sendo o comando privilegiado com confirmação. Na UI, a sugestão entra pelo MESMO `applyTemplate` de D-111 (nunca apaga rascunho, recusa quando estoura o limite) e **troca o `clientRequestId`** (texto novo = tentativa nova). O texto sugerido fica no estado do form e **viaja no envio como `suggestedText`** — `support_reply_attempts.suggested_text` (que existia desde D-096 e nunca era preenchido) passa a registrar o sugerido E o final lado a lado: é o que permite medir quanto o humano precisou corrigir.

**Decisão 3 — o contexto do case atravessa SÓ `support_case_links`** (secao 11 é explícita: nunca coincidência de comprador). Transcript limitado a 40 mensagens, moderada vira rótulo `[mensagem banned]` (a regra de D-095 aplicada ao prompt: preservar que existiu, sem expor corpo). O system prompt proíbe inventar estoque/prazo/compatibilidade e manda dizer "será confirmado" quando o contexto não sustenta — a regra de compatibilidade que os requisitos destacam. Proíbe também placeholders como `{nome}` (mesmo motivo de D-111).

**Decisão 4 — `structure_feature_suggestion` persiste sob a RLS do CHAMADOR, sem RBAC duplicado.** O UPDATE dos nove campos roda com o `UserClient`; a policy `feature_suggestions_update_admin` (D-079) decide. RLS filtrando (zero linha) vira erro claro, nunca sucesso vazio. `original_text` **não entra no payload do UPDATE** — o requisito de preservação virou garantia estrutural, com teste provando que a chave não existe no payload. JSON do modelo é extraído com tolerância a cerca de markdown e validado por Zod; fora do formato → erro amigável e **zero campo meio-gravado**. `maxTokens` subiu a 1.024 só nesta ferramenta — 512 truncaria o JSON no meio, e JSON truncado é falha certa.

**Decisão 5 — planner/streaming/UI de chat FICAM FORA, e o motivo é de produto, não de preguiça.** As ferramentas atuais são todas CONTEXTUAIS — cada uma tem um botão no lugar exato onde o dado dela mora (Dashboard de SKU, caixa de resposta, Central de Sugestões). Um chat genérico com planner é uma porta de entrada NOVA, não a conclusão das existentes; `docs/COPILOT.md` secao 2 já manda o curto-circuito determinístico responder sem LLM sempre que a ferramenta basta. Construí-lo junto dobraria a fatia (SSE, estado de conversa, orquestração multi-turno) sobre duas features ainda não usadas em produção. Fica como o único item de IA aberto da Fase 7, com o desenho da secao 10 intacto.

**Verificação:** `check` **29/29**; 9 testes novos (`copilot-generation.test.ts`): case fora do alcance falha ANTES de gastar LLM; prompt carrega transcript/produto/canal e só o que veio do banco; moderada vira rótulo; system proíbe inventar e `{nome}`; estruturação persiste os nove campos sem tocar `original_text`; JSON cercado de markdown aceito; fora do formato → erro sem meia-gravação; RLS zero-linha → erro claro; `maxTokens` 1.024.

**Impacto:** `packages/contracts/src/copilot-tools.ts` (+schemas, 2 nomes novos), `apps/api/src/{copilot-generation.ts,copilot.ts,anthropic-client.ts}` (+testes), `apps/web` (`reply-form.tsx` com "Sugerir com IA" + auditoria; `/sugestoes` com "Estruturar com IA" + exibição dos nove campos num `<details>`, texto original sempre visível acima). O `as never` obsoleto de `/sugestoes` saiu no caminho (feature_suggestions entrou nos types em D-100). **Sem migration; deploy = api + web.**

## D-113 — Base de Conhecimento Validada: SQL determinístico, validação humana, e o Copiloto ganha evidência de verdade

**Contexto:** continuação do pedido "finalize o que falta do copiloto". A Base de Conhecimento era o pré-requisito da evidência de compatibilidade que a sugestão de resposta (D-112) declarava não ter — o prompt mandava dizer "será confirmado" para tudo.

**Decisão 1 — tabela relacional consultada por SQL, NUNCA RAG** (D-071 é explícito; `docs/COPILOT.md` secao 6: sem embeddings, sem pgvector). `knowledge_entries`: fato (`content`), tipo (`COMPATIBILIDADE`/`ESPECIFICACAO`/`POLITICA`/`OUTRO`), fonte, SKU opcional (nulo = conhecimento geral da operação), estados `SUGERIDO → VALIDADO/REJEITADO/OBSOLETO`.

**Decisão 2 — qualquer membro SUGERE; só ADMIN/GESTOR VALIDAM, e a policy força o nascimento como SUGERIDO.** O `with check` do INSERT exige `status = 'SUGERIDO'` — a barreira é o banco, não a UI. A constraint `validation_coherent` exige `confirmed_by`/`confirmed_at` em VALIDADO: **confirmação anônima não existe**. É a materialização do requisito "histórico de resposta não é automaticamente verdade" — a validação humana explícita é o que separa opinião de fato.

**Decisão 3 — sem DELETE para `authenticated`.** Conhecimento errado vira REJEITADO/OBSOLETO; apagar esconderia que a equipe já acreditou naquilo. "Ativo/inativo" do requisito é coberto pelos estados, sem coluna redundante.

**Decisão 4 — a consulta do Copiloto pega VALIDADO dos SKUs vinculados + gerais, e a falha degrada.** `suggest_support_reply` injeta no prompt um bloco "Conhecimento validado pela equipe" (limite 12, índice parcial no caminho quente); o system prompt passa a autorizar afirmar SÓ o que está nesse bloco. Erro na consulta = bloco vazio = "será confirmado" — evidência extra nunca derruba a sugestão.

**Decisão 5 — SKU por CÓDIGO na UI, resolvido no servidor.** Código que não resolve é erro explícito; vincular ao SKU errado seria pior que não vincular.

**Ritual de migration**: MCP → `list_migrations` → arquivo local na versão registrada (`20260828114602`) → bloco de types inserido cirurgicamente.

**Verificação:** `check` **29/29**; 2 testes novos no prompt da sugestão (conhecimento entra como evidência; ausência vira "(nenhum registro)"), 7 de integração RLS (membro lê/outra org não; qualquer membro sugere; nascer VALIDADO recusado pela POLICY; ANALISTA não valida; ADMIN valida com quem/quando; VALIDADO sem confirmador recusado pela constraint; DELETE inexistente).

**Impacto:** migration + types, `copilot-generation.ts` (consulta + prompt), `/atendimento/conhecimento` (página nova, actions, 2 componentes), link na Caixa de Entrada.

## D-114 — O chat do Copiloto: planner por tool use, streaming de verdade, e nenhuma SQL gerada por LLM

**Contexto:** o último item de IA aberto da Fase 7 — "planner por linguagem natural e o streaming de verdade" (pendente desde D-077, com modelo/orçamento decididos em D-082). Fecha, junto com D-112/D-113, o pedido "finalize o que falta do copiloto".

**Decisão 1 — o planner é tool use, e os argumentos passam pelo MESMO Zod de `/v1/copilot/query`.** `POST /v1/copilot/chat` recebe a pergunta em português; o modelo escolhe entre as TRÊS ferramentas determinísticas de D-077 (vendas, comparação de períodos, comparação de contas), e cada `tool_use` é validado pelo schema do contracts antes de executar — **um argumento inventado é recusado e vira `tool_result` de erro para o modelo corrigir**, nunca uma consulta malformada. A execução continua sob a RLS do usuário. Nenhuma SQL é gerada por LLM (`docs/COPILOT.md` secao 6, intacta).

**Decisão 2 — streaming SSE de verdade, sem fingir.** `AnthropicClient` ganhou `plan()` sobre `client.messages.stream`: cada delta de texto vai ao navegador NO INSTANTE em que o modelo o gera — inclusive o preâmbulo antes de uma consulta ("vou verificar…"), que é exatamente o feedback que um chat precisa. A alternativa considerada e rejeitada: gerar tudo e "pingar" o texto pronto em pedaços seria streaming de mentira. O SDK continua confinado ao wrapper (`MessageParam`/`Tool` importados só lá).

**Decisão 3 — o contexto que o modelo recebe é o que o USUÁRIO alcança.** O system prompt carrega a data de hoje em `America/Sao_Paulo` (o helper canônico `toSalesMetricDate`, não um `toISOString` solto) e a lista de contas lida sob a RLS do próprio chamador — o modelo não tem como citar conta que o usuário não vê, porque nunca soube que ela existe.

**Decisão 4 — teto de 4 rodadas, com aviso.** Pergunta razoável usa 1-2 consultas; estourar o teto emite um erro explícito ("tente uma pergunta mais direta"), nunca corte silencioso. Erro de ferramenta volta ao modelo como `tool_result` com `is_error` — o modelo explica o que falhou, o erro não some.

**Decisão 5 — as ferramentas de GERAÇÃO ficam fora do chat.** Narração de diagnóstico e as duas de D-112 são contextuais (têm botão onde o dado mora); receber `supportCaseId` por chat não é um caso de uso. O chat cobre o que os requisitos exemplificam como pergunta livre: "como estão as vendas?", "compare as contas".

**Decisão 6 — sem histórico multi-turno nesta fatia.** Cada pergunta é independente; o transporte (SSE + loop) já comporta memória de conversa quando ela for desenhada — com decisão própria sobre custo, porque histórico re-enviado é token pago a cada turno.

**Custo e observabilidade:** `ai_runs` grava a soma de TODAS as rodadas com `tool_names: ["copilot_chat", ...usadas]` — o aviso de orçamento de D-100 soma junto. `runCopilotChat` nunca lança: numa resposta SSE já iniciada não existe mais status HTTP, então erro vira evento `error`.

**Verificação:** `check` **29/29**; 7 testes do orquestrador (resposta direta em deltas; tool_use executa a ferramenta REAL e alimenta o modelo com o resultado; argumento inventado recusado pelo Zod sem derrubar a conversa; ferramenta desconhecida idem; teto de rodadas com aviso; system prompt com hoje+contas+proibição; custo somado em `ai_runs`).

**Impacto:** `anthropic-client.ts` (`plan` com streaming), `copilot-chat.ts` (novo), rota SSE em `app.ts` (mesma autenticação de `/query`), `apps/web/app/copiloto` (chat com parse de SSE sobre fetch), nav "Copiloto" no grupo Inteligência. **Sem migration.** Com D-112/D-113/D-114, o checklist de IA do Copiloto está integralmente coberto ou registrado: a única evolução apontada é memória multi-turno.

## D-115 — Métricas de SAC com definição canônica, e o filtro de SLA que D-107 destravou

**Contexto:** próximo item da Fase 7B ("Métricas de SAC, com definição canônica antes de exibir — mesmo princípio de `docs/METRICS.md`"), somado ao filtro de SLA da Caixa de Entrada que D-107 deixou "destravado, fatia própria" — os dois consomem o mesmo dado de prazos.

**Decisão 1 — as definições nasceram ANTES da tela, em `docs/METRICS.md` §5B**, com fórmula, fonte e ressalva por métrica. Oito métricas definidas: abertos (total e por canal), aguardando a loja, mediações abertas, prazos nas próximas 24h, prazos vencidos, novos no período (por canal), resolvidos no período, mediana de primeira resposta.

**Decisão 2 — "tempo médio de resolução" ficou FORA, e o motivo é de relógio, não de preguiça.** `created_at` é o instante da INGESTÃO local; `resolved_at` mistura relógios por desenho (triagem humana grava `now()`, o auto-resolve de D-102 grava o instante remoto do ML). Para um claim backfilled, `resolved_at − created_at` daria duração **NEGATIVA**. A métrica entra quando existir um `opened_at` remoto persistido por case. Verificado nas migrations antes de decidir, não presumido.

**Decisão 3 — primeira resposta é MEDIANA, só QUESTION/POST_SALE_MESSAGE, e os dois lados no relógio do ML.** `support_messages.occurred_at` é consistente entre INBOUND e OUTBOUND (relógio remoto dos dois lados) — a única dupla comparável do domínio hoje. CLAIM fica fora: o transcript é um piso (D-106) e mensagem de mediador é `SYSTEM`. Mediana e não média: um outlier de fim de semana não pode dobrar o número. Caso raro excluído e documentado: loja que falou ANTES do cliente.

**Decisão 4 — "vencido" é leitura, não estado.** `prazos_vencidos` = linhas `ACTIVE` com `due_at < now()`, computado NA CONSULTA. O job que marcaria `BREACHED` continua não existindo (D-107) e ler não muda estado — a métrica entrega o valor operacional sem fingir que a máquina de estados anda sozinha.

**Decisão 5 — ressalva de série gravada na PRÓPRIA tela**: "novas reclamações" avisa que a série só é confiável a partir de 28/08 (D-109 completou a ingestão; o primeiro dia contém o backfill de ~244). Número sem a ressalva seria um gráfico mentindo com aparência de precisão.

**Decisão 6 — o filtro "Prazo em risco" entra como quarta dimensão da Caixa de Entrada** (`?prazo=risco`): `support_case_deadlines!inner` com `ACTIVE` e `due_at ≤ now()+24h` (vencidos inclusos). O `!inner` só entra no select QUANDO o filtro está ativo — como inner join, ele excluiria da listagem normal todo case sem prazo. Era exatamente o filtro que D-090 cortou por "tabela vazia"; a tabela tem 263 prazos desde D-107.

**Medido contra o dado real antes da tela** (hábito de D-063): 351 abertos, 101 aguardando a loja, 130 mediações, **74 prazos nas próximas 24h, 20 vencidos**, mediana de primeira resposta 0,8h.

**Verificação:** `check` **29/29**; RPC `get_support_metrics` (`security invoker`, soma 100% em SQL — a RLS decide o escopo por chamador) com 3 testes de integração (uma linha; isolamento entre organizações — outra org conta ZERO dos nossos; `anon` sem EXECUTE). Migration `20260828120728` pelo ritual. Tela `/atendimento/metricas` + link no cabeçalho da Caixa.

**Impacto:** `docs/METRICS.md` §5B (normativo), migration + types, `/atendimento/metricas` (nova), Caixa de Entrada (filtro + link). **Fecha "Métricas de SAC" na primeira versão operacional e o filtro de SLA pendente de D-107.**

## D-116 — SAC vira sinal: padrões na Central de Ações e evidência no Diagnóstico. Fase 7B completa.

**Contexto:** os dois últimos itens da Fase 7B, pedidos juntos pelo usuário — "Detecção de padrões → Central de Ações" e "Integração com Diagnóstico como fonte de evidência adicional". São o mesmo tema com dois consumidores, e a regra do requisito governa ambos: **agregado, nunca por atendimento individual; nunca por palavra solta em mensagem**.

**Decisão 1 — a regra do padrão é um SNAPSHOT, não uma série, e isso é honestidade estatística.** `detectSupportPatterns` (puro, `@sb/domain/diagnostics`): **≥ 3 reclamações ABERTAS simultaneamente no mesmo SKU** vira ação. "Aumento anormal de mediações" exigiria baseline histórico — e a série de claims só existe desde 2026-08-28 (D-109). Um limiar sobre estado presente é verdadeiro com qualquer profundidade de histórico; um z-score sobre 3 dias seria estatística de mentira. A evolução para baseline entra quando a série tiver corpo.

**Decisão 2 — o impacto é dinheiro OBSERVADO, não estimado**: soma de `orders.total_amount` dos pedidos vinculados aos claims do SKU (via `support_case_links`) — valor em risco de reembolso real. Sem pedido vinculado, impacto é `null`, nunca zero. Mediação envolvida sobe a severidade para `alta` (dinheiro e reputação já em disputa).

**Decisão 3 — `dedup_key` por SKU, SEM data**: a condição é persistente, e cada dia que durar atualiza a MESMA ação (o upsert de D-064 preserva status/responsável — humano que resolveu não é reaberto). Chave com data criaria uma ação nova por dia para o mesmo problema: a avalanche da V2 em câmera lenta. O mesmo case vinculado duas vezes ao SKU conta UMA vez (Set por `support_case_id`) — re-ingestão não fabrica padrão.

**Decisão 4 — ZERO job novo no Scheduler**: o gatilho diário de D-064 (`v3-detect-sales-anomalies`) passa a enfileirar as DUAS detecções por organização, com handlers e dedupe keys separados (falha e retry independentes). Ambas são "diagnóstico diário por organização" — um 14º job só duplicaria cron e rota para o mesmo momento do dia. A contagem esperada do Scheduler CONTINUA 13.

**Decisão 5 — no Diagnóstico, reclamação aberta é EVIDÊNCIA sempre e causa candidata SÓ na queda.** `diagnoseSalesAnomaly` ganhou o 5º parâmetro opcional `supportSignal` (aditivo — teste prova comportamento idêntico sem ele): reclamações abertas entram nas evidências em qualquer direção (fato observado é fato), e viram causa candidata (`support.claims.open`) apenas quando `direcao === 'queda'` — reclamação não explica venda subindo. Na queda, os próximos passos ganham "abrir a Caixa de Entrada filtrada por este SKU". O `occurredAt` da causa é o instante da ANÁLISE, explicitado na descrição — é um estado observado, não um evento pontual.

**Decisão 6 — o sinal de SAC degrada, nunca derruba**: nos dois chamadores (job diário e `/diagnostico`), falha ao ler os claims vira "sem sinal de SAC" com log — evidência ADICIONAL por definição não pode impedir o diagnóstico que já funcionava.

**Verificação:** `check` **29/29**; 5 testes do módulo puro de padrões, 4 da extensão do diagnóstico (incluindo a prova de aditividade), 5 do handler (impacto real somado; mediação sobe severidade; dedupe de case duplicado; falha retryable — nunca "done, 0 padrões"), trigger atualizado com testes ajustados.

**Impacto:** `@sb/domain/diagnostics/{support-patterns.ts,sales-anomaly.ts}`, `apps/worker` (handler novo + sinal no existente + derivação ORDER_DERIVED), `apps/api` (trigger enfileira ambos), `/diagnostico` (sinal na tela). Sem migration. **FASE 7B COMPLETA** — todos os itens do checklist entregues ou registrados com motivo.

**Deployado e COMPROVADO em produção em 2026-08-28** (`worker-00039-dn5`/`api-00026-w56`, depois `worker-00040-gjg` com a correção abaixo). A verificação pós-deploy achou um buraco ESTRUTURAL que nenhum teste pegou: o job rodou `done` com zero ações porque **claims tinham 359 vínculos de PEDIDO e NENHUM de SKU** — o persist de D-104 nunca derivara o SKU, e `ORDER_DERIVED` existia no CHECK desde D-085 sem uso. Corrigido na mesma sessão: `linkOrder` deriva os SKUs de `order_items` (o `sku_id` congelado de D-020), e a varredura horária reparou o estoque sozinha — **27 links de SKU nasceram na primeira passada**, sem backfill manual. Medido depois: 24 SKUs com claim aberto, máximo de **2 por SKU** — três SKUs a UM claim do limiar. **Zero ações é o resultado CORRETO do dado real de hoje**: o detector está armado e a primeira ação nasce quando o padrão existir de verdade. Cobertura parcial registrada: item de pedido sem `sku_id` resolvido não deriva (correto por D-020 — o vínculo nasce e a próxima varredura completa).

## D-117 — Dois defeitos P0 achados por auditoria: a Central de Ações quebrada pela própria ação de SAC, e o envio de resposta sem fronteira de conta

**Contexto:** auditoria ampla pedida pelo usuário em 2026-08-28, antes de planejar features novas. Ela mediu o banco de produção em vez de acreditar nas telas, e achou defeitos em código **já implantado** — dois deles corrigidos aqui, um terceiro registrado com plano próprio (ver Decisão 3). Cada defeito passou por verificação adversarial (agentes instruídos a REFUTAR, não a confirmar) antes de qualquer linha ser escrita.

**Decisão 1 — `actions.evidence` é uma união de formatos, e a Central de Ações lia como se fosse um só.** `detect-sales-anomaly-actions` grava `{direcao, z_score, units_delta, evidencias, causas_candidatas}`; `detect-support-pattern-actions` (D-116, anteontem) grava `{evidencias, reclamacoes_abertas}`. A tela declarava a primeira forma como interface única, fazia `row.evidence as ActionEvidence` sem validação e **nem consultava `kind`** — que existe na tabela desde D-064 e é o discriminante real.

Consequências medidas, não presumidas:

- **`action-row.tsx:181` lançava `TypeError` em `causas_candidatas.length`.** Não existe `error.tsx` em lugar nenhum de `apps/web` — o throw sobe até o boundary embutido do Next e **derruba a rota inteira**, levando junto as 183 ações de venda que funcionam. Vale no SSR (500) e na navegação macia.
- **`direcao` ausente não lançava — MENTIA.** `undefined === "queda"` é `false`, então a linha caía no ramo `else`: fundo verde e rótulo "Alta". Uma ação de reclamações recorrentes se apresentaria como oportunidade de venda em alta.
- **O defeito era auto-sustentável.** A `dedup_key` do padrão de SAC não tem data (D-116, decisão 3), então a ação persiste enquanto a condição durar — e os botões de resolver/descartar ficam na linha da página que quebrou. Sem acesso ao banco, não havia recuperação pela interface.

A correção não é uma guarda de nulo: é uma **fronteira**. `apps/web/lib/action-evidence.ts` (puro, testado, mesmo padrão de `event-format.ts`) expõe `describeActionEvidence(kind, raw)` — função **total**, que nunca lança, para qualquer `kind` e qualquer payload. `direcao` fora de `{queda, alta}` vira `null` e a tela mostra "—"; o fundo passa a ser por **tom** (`problema`/`oportunidade`/`neutro`), não por direção; a coluna "Direção" virou "Tipo", mostrando o `kind` legível com a direção como sublinha quando existir. Um `kind` novo criado no worker degrada para uma linha sem direção — nunca para uma tela quebrada.

**Estava ARMADO, não dormente:** o handler está registrado e é enfileirado diariamente. Medido em 2026-08-28: 24 SKUs com claim aberto, máximo de **2 por SKU**, limiar 3 — **três SKUs a um claim da quebra**.

**Decisão 2 — o envio de resposta não checava a CONTA, só organização e papel.** `POST /v1/support/cases/:caseId/reply` usa `AdminClient` (`service_role`, bypassa RLS) e conferia em código apenas `organization_id` + papel. Mas atendimento é escopado por conta: a policy de leitura (`support_cases_select_permitted`) e a RPC de triagem (`triage_support_case`, D-094) exigem `has_account_access` — só o envio, **a única escrita real do projeto no Mercado Livre**, não exigia. Um GESTOR/OPERADOR sem permissão na conta responderia ao comprador dela por chamada direta à API, sendo que a RLS o impede até de LER o case.

A checagem vem em **código, não pela RPC**: `private.has_account_access` resolve `auth.uid()`, que é NULL sob `service_role` — chamá-la pelo `AdminClient` devolveria `false` sempre. Espelha a função: ADMIN alcança toda conta da própria organização; os demais exigem linha em `user_account_permissions`. Ausência responde `not_found`, nunca "sem permissão" — mesmo silêncio já usado na fronteira de organização, porque a segunda resposta confirmaria que o case existe.

**Decisão 3 — `private.has_role` sem escopo de organização fica REGISTRADO, não corrigido aqui.** A função filtra só por `user_id` e papel, sem organização: composta como `is_member_of(org) and has_role(['ADMIN'])`, as duas condições podem ser satisfeitas por **organizações diferentes**. A verificação adversarial refutou a exploração *hoje* e a refutação foi confirmada por medição direta: **1 organização, 1 membro, 0 permissões por conta** em produção. Com uma única organização o conjunto de vínculos de qualquer usuário é um singleton, e `has_role` é semanticamente idêntico a uma checagem escopada.

Não corrigir agora é decisão de escopo, não descuido: são **32 sítios de chamada em 25 objetos e 14 arquivos**, com a assinatura mudando — fatia própria, com um teste-guarda multi-organização (que hoje FALHA e não existe na suíte) como passo zero. **O defeito arma sozinho, sem mudança de código, no dia do segundo tenant ou do primeiro usuário adicionado a duas organizações.**

**Impacto:** `apps/web/lib/action-evidence.ts` (novo, 7 testes), `apps/web/app/acoes/{page,action-row}.tsx`, `apps/api/src/support-reply.ts` (+2 testes), fakes de `app.test.ts`/`support-reply.test.ts`. **Sem migration, sem mudança de schema.** `check` 29/29.

## D-118 — A CI vermelha de D-117 expôs dois defeitos que não eram meus: a terceira ocorrência do padrão de D-099 e um teste que nasceu impossível de passar

**Contexto:** o push de D-117 deixou a CI vermelha em `@sb/db test:integration` — duas falhas em `packages/db/src/rls.integration.test.ts`. Nenhuma delas tem relação com o que D-117 mudou (`apps/web`, `apps/api`): eram latentes, e a regra do projeto ("uma etapa não está concluída enquanto não estiver commitada e com CI verde", item 4 das Pendências) obriga a fechá-las antes de seguir.

**Decisão 1 — `knowledge_entries.created_by`/`confirmed_by` viram `on delete restrict`.** É a **terceira ocorrência do defeito que D-099 corrigiu**, e nasceu no dia SEGUINTE (D-113): coluna de ator com `on delete set null`. Aqui a colisão é mais direta que nas duas anteriores — `knowledge_entries_validation_coherent` exige `confirmed_by is not null` quando `status = 'VALIDADO'`, então o SET NULL dispara um UPDATE que a própria constraint recusa. **D-113 escreveu que "confirmação anônima não existe" e deixou uma FK que tentava criar exatamente isso.**

O sintoma era desproporcional à causa: `delete from auth.users` no `afterAll` falhava com `violates check constraint`, **abortando a limpeza inteira** e deixando resíduo para a rodada seguinte. `restrict` mantém o bloqueio (linha de auditoria não sobrevive sem o ator) e devolve o diagnóstico certo — mesmo raciocínio, mesma redação e mesmo precedente de D-099. Migration `20260828132701`, aplicada pelo ritual. A limpeza da suíte passou a apagar `knowledge_entries` antes dos usuários, na mesma ordem que já usa para `sku_components`/`skus`.

**Decisão 2 — o teste de escopo de `get_support_metrics` pedia um número impossível.** A asserção era `expect(alheios.abertos_total).toBe(0)`, com o comentário "as fixtures de support criam cases só na ORG_SB". **O comentário é falso desde D-085**: a fixture cria `CASE_OTHER` em `ORG_OUTRA` com `internal_status = 'NOVO'` — e `abertos_total` conta exatamente `internal_status <> 'RESOLVIDO'`, sem janela. O vizinho sempre viu 1. O teste nasceu em D-115 já quebrado e **não pode nunca ter passado** — o que corrige o registro de D-115, que afirmava "3 testes de integração da RPC" verdes.

Investigado antes de corrigir: `private.has_account_access` **está corretamente escopada** (junta `organization_members` pela organização da CONTA), então não é o defeito de escopo de D-117/decisão 3 se manifestando. O vizinho enxergar o próprio case é o comportamento certo.

A correção não é trocar `0` por `1`: é trocar a propriedade errada pela certa. "Zero para o vizinho" nunca foi a garantia — a garantia é **igualdade**: o vizinho conta exatamente os cases DELE, nem um a mais. O esperado passa a ser derivado do banco em vez de fixado, então a fixture pode crescer sem falsear o teste, e uma segunda asserção prova que ele conta MENOS que nós.

**Impacto:** migration `20260828132701` (só `on delete`, sem mudança de tipo — `types.ts` inalterado), `packages/db/src/rls.integration.test.ts` (limpeza + asserção). `check` 29/29 local; **a suíte de integração exige Postgres real e só pôde ser verificada pela CI** — Docker não estava disponível na máquina desta sessão.

## D-119 — Vinculação manual livre: o requisito P1 mais antigo aberto, e o que a revisão adversarial mudou nele

**Contexto:** item P1 do Checkpoint pré-Fase 7, aberto desde 2026-08-24 e listado em `docs/HANDOFF.md` ("Lacunas funcionais confirmadas") — *"criar fluxo de vinculação manual `Conta + MLB + variation_id? → SKU` sem exigir `link_candidate` prévio"*. A auditoria de 2026-08-28 (D-117) provou por que ele deixou de ser cosmético: **`link_candidates` está vazia, o gerador tem uma fonte só (a planilha do UpSeller) e o schema PROÍBE que um anúncio do Mercado Livre vire candidato** (`check source in ('ERP_IMPORT')`). Medido: 3.679 anúncios que já venderam não têm vínculo nenhum, e 21,8% dos itens vendidos nos últimos 30 dias saem com `sku_id` nulo — R$ 699.733,15. Sem este fluxo, não existia caminho pela interface para consertar um só deles.

**Decisão 1 — escrita DIRETA sob RLS, sem RPC.** Uma tabela só, sem transação multi-tabela: mesmo padrão de `reply_templates` (D-111) e `feature_suggestions` (D-079). A policy `sku_listing_links_write_permitted` existe desde a Fase 2 e **nunca teve um chamador** — nenhum código de `apps/web` escrevia nesta tabela. `resolve_link_candidate` continua RPC porque escreve em DUAS tabelas na mesma transação; aqui não há candidato para fechar.

**Decisão 2 — a validação de entrada é módulo puro e testado** (`apps/web/lib/manual-link.ts`), espelhando as constraints reais: `MLB[0-9]+` com normalização de caixa/espaço, variação só numérica, campo vazio virando `NULL` (nunca string vazia — "anúncio inteiro" é semanticamente diferente de "variação"). O erro fala a língua do operador em vez de devolver violação de CHECK crua.

**A revisão adversarial (27 agentes: 4 lentes independentes, cada achado verificado por um cético) achou 16 defeitos confirmados no código que eu tinha acabado de escrever, e 3 mudaram o resultado:**

**(a) A feature nascia MORTA para o público dela.** `organization_members.select(...).maybeSingle()` sem `.eq("user_id")`: a policy `organization_members_select_same_org` é `is_member_of(organization_id)` — devolve **uma linha por colega**, não a sua. E o `maybeSingle` do postgrest-js 2.112.3 **converte `length > 1` em erro PGRST116** (verificado no bundle instalado, `dist/index.cjs:471-481`). Em qualquer organização com dois membros a ação falharia 100% das vezes com "tente de novo" — mensagem que culpa falha transitória por condição permanente, a classe exata que D-067 auditou. Produção tem 1 membro hoje, então passaria despercebido até o segundo usuário. Corrigido com `.eq("user_id", userId).limit(1)`, mesma semântica de `private.current_org_id()`. **O mesmo defeito existe em 6 outros arquivos** (`compras`, `contas`, `estoque`, `sugestoes`, `atendimento/templates`, `atendimento/conhecimento`) — passe próprio, não misturado aqui.

**(b) Conflito entre as duas FORMAS não era detectado.** Os índices únicos são parciais e **disjuntos**: "anúncio inteiro" e "variação X" do mesmo item nunca colidem no banco. Checar só a própria forma deixava passar um estado incoerente com consequência concreta — `ml-listings-fetch` e `ml-fulfillment-fetch` enumeram justamente os vínculos SEM variação e atribuem o **estoque Full do item ao SKU desse vínculo**. Um vínculo de anúncio inteiro sobre um anúncio que só vende por variação não resolve venda nenhuma (o pedido sempre traz a variação) e ainda leva o Full para o SKU errado. Agora a ação lê TODOS os vínculos do item numa consulta e recusa a mistura, explicando qual lado corrigir.

**(c) A recusa instruía uma ação impossível.** A mensagem dizia "desfaça o vínculo atual antes de criar outro" — e **não existe caminho para desfazer vínculo em lugar nenhum do produto** (zero `update`/`delete` de `sku_listing_links` em `apps/web`). Prometer um caminho inexistente é pior que declarar o limite; a mensagem passou a dizer o que é verdade.

Também corrigidos na mesma passagem: `auth.getUser()` descartava `.error` (sessão expirada virava "sem organização"); candidato `OPEN` para a mesma referência agora é detectado e o operador é mandado para o botão da linha, que fecha o candidato na mesma transação; estado vazio quando o usuário não alcança conta nenhuma; e a busca de SKU, que era cópia literal de 29 linhas de `candidate-row.tsx`, virou o hook `useSkuSearch`.

**Decisão 3 — a policy de escrita ganhou teste sob usuário real.** Todos os testes existentes de `sku_listing_links` inseriam pelo `client` superuser: provavam CHECK e índices, **nunca a policy**. Três testes novos: ADMIN escreve; ANALISTA é recusado (afiado por acidente do fixture — ANALISTA_SB TEM permissão nesta conta, então a recusa isola exatamente a dimensão de PAPEL); ADMIN de outra organização não escreve na conta alheia.

**Verificado contra o banco real antes do commit**, em transação revertida: o INSERT sob RLS como o usuário de produção passa policy e trigger, gravando `source='MANUAL'` com autor e data; e a colisão devolve `23505` no índice `sku_listing_links_item_only_unique` — o código exato que o tratamento de corrida espera.

**Lacunas DECLARADAS, não silenciadas:**

- **"Manter histórico auditável" do requisito NÃO é cumprido.** Não existe tabela append-only de eventos de vínculo, e `domain_events` é escrita só por `service_role`. O que existe é o estado atual (`source`/`confirmed_by`/`confirmed_at`). Trocar ou remover um vínculo não deixaria rastro — e é justamente por isso que remover não foi construído aqui.
- **Não existe desfazer vínculo.** Consequência: um vínculo manual errado só se corrige por SQL. É a próxima fatia natural deste fluxo, e ela precisa nascer junto do histórico.
- **A varredura de anúncios continua enumerando `sku_listing_links`** — vincular à mão faz o anúncio entrar em `listings`/Full/visitas, mas descobrir anúncios que ninguém vinculou ainda depende de `/users/{id}/items/search`, não integrado (D-117).

**Impacto:** `apps/web/lib/manual-link.ts` (novo, 13 testes), `apps/web/components/use-sku-search.ts` (novo, extraído), `apps/web/app/vinculacoes/{actions,page,manual-link-form,candidate-row}.tsx`, 3 testes de RLS. **Sem migration.** `check` 29/29.

## D-120 — Trinta blocos de features viram roadmap: o que a auditoria mediu antes de aceitar qualquer um deles

**Contexto:** o usuário trouxe trinta blocos de features, melhorias e correções para a V3, pedindo explicitamente que **nada fosse implementado** antes de comparar com o que já existe, identificar o que é bug, o que é melhoria e o que é novo, e propor ordem. A regra que governou a resposta foi a do próprio projeto: **medir, não presumir**. Sete auditorias de código em paralelo, duas pesquisas na documentação oficial do Mercado Livre e reconciliação independente contra o banco de produção.

**Decisão 1 — a auditoria mudou a prioridade, e isso é o principal resultado.** Quase todas as features pedidas ficam no fim da cadeia `confiabilidade → métricas → eventos → diagnóstico → ações → IA`. Os achados estão no começo dela. Construir na ordem pedida seria decorar uma casa com a fundação trincada — o que a Regra de Progressão deste repositório proíbe nominalmente.

Cinco achados sustentam a reordenação, todos medidos em 2026-08-28:

- 🔴 **A Central de Vinculações não funciona, e é pior do que a desconfiança do usuário.** `link_candidates` tem **zero linhas** e nunca teve nenhuma. O gerador tem uma fonte só (a planilha do UpSeller) e o schema **PROÍBE** que um anúncio do Mercado Livre vire candidato (`check source in ('ERP_IMPORT')` + FK obrigatória para `erp_import_rows`). Reconciliação independente: **7.361 itens já venderam** (prova de existência), 4.710 estão fora de `listings` e **3.679 não têm vínculo nenhum**. Não é história antiga: **21,8% dos itens vendidos nos últimos 30 dias saem com `sku_id` nulo** — 437 anúncios, R$ 699.733,15. Esse dinheiro entra no faturamento da conta e some de tudo que é por SKU: estoque não é baixado, cobertura não existe, ABC não vê.
- 🔴 **O estoque local é ficção.** Dos 828 SKUs com saldo positivo, **581 estão acima de 1.000 unidades** — 164 em exatamente 3.996, 9 em 39.996. ~~É **estoque sentinela do ERP**, espelhado com fidelidade pela reconciliação (`AJUSTE_RECONCILIACAO`: +5.206.669 unidades).~~ **ATRIBUIÇÃO CORRIGIDA EM D-131 (2026-08-28): esses números são a impressão digital de um BUG, não dado do fornecedor.** 3.996 = 4 × 999 e 39.996 = 4 × 9.999 — a reconciliação lia 1.000 de 6.744 linhas por causa do `max_rows` do PostgREST, tratava o ledger ausente como zero e reaplicava o snapshot inteiro todo dia. As +5.206.669 unidades são o defeito somado, não fidelidade ao UpSeller. O achado de que o saldo local não serve para decidir **continua válido**; a causa era outra. Somam-se **1.639 SKUs com saldo NEGATIVO**, mediana −2. Dos 1.140 SKUs que venderam em 30 dias e têm saldo, só **170 são plausíveis**.
- 🔴 **A Central de Notificações já é 59% ruído.** (**Causa identificada em D-131**: 69% desses eventos vêm de `verify-ledger-integrity`, cego pelo mesmo truncamento, e são **falsos positivos medidos** — a comparação real dá zero divergências em 2.524 linhas.) `stock.balance.diverged` gera ~2.040 eventos CRÍTICOS por dia, estáveis, e responde por **55,1%** de todas as notificações (8.121 de 14.740, para um único usuário). É a falha dos 5.243 alertas da V2 renascendo — e é consequência direta do achado anterior.
- 🔴 **Uma bomba-relógio em `/acoes`** e **dois furos de autorização** — corrigidos em D-117/D-118 antes de qualquer feature nova.
- **`order_items.sale_fee` existe, está 100% preenchido e nunca foi lido.** R$ 297.993,32 em 30 dias sobre R$ 3.057.736,33 (9,75%).

**Decisão 2 — "receita líquida" é um nome vetado.** A pesquisa oficial confirmou que dá para compor bruto − comissão − frete do vendedor − desconto do vendedor, mas que a composição de `sale_fee`, a taxa fixa por pedido, o parcelamento, os impostos retidos no MLB e os reembolsos posteriores **não são obteníveis**. O nome canônico é `margem_operacional_pedido`, com a lista do que não entra visível ao lado. A conciliação real só existe no ciclo mensal de faturamento, que o próprio Mercado Livre afirma não servir como fonte primária de gestão de vendas — logo, **duas visões declaradas, nunca uma**. Agravante: **não existe L0** (o bucket `raw-ml` foi provisionado e nunca recebeu um byte), então nada de financeiro é reconstruível retroativamente.

**Decisão 3 — a republicação é oficial, e quatro crenças correntes sobre ela são falsas.** `POST /items/{item_id}/relist` existe, está documentado e sem deprecação. Mas: a tag é `relist` (não `relisted`/`item_relisted`); o `variation_id` é **renovado**, não preservado — remapear SKU vira etapa obrigatória; os 60 dias são a janela para **herdar visitas**, não prazo para republicar; e é POST. O vácuo documental decide o desenho: **a doc não afirma NADA sobre reputação/experiência de compra**, é silenciosa sobre Full e catálogo, e **não documenta idempotência alguma** — a proteção contra criar dois anúncios é 100% nossa. Full e catálogo ficam bloqueados na primeira versão.

**Decisão 4 — subfases, sem renumerar nada.** `4B` (confiabilidade do catálogo e do estoque), `5C` (dashboards e filtros), `5D` (reposição e compra), `6B` (diagnóstico narrado e timeline) e `9` (escrita no ML). Mesmo precedente de D-071, que criou a 7B sem tocar em `docs/PROMPT_MASTER.md` §38. **A Fase 8 continua intercalável** — backup/restore verificado não conflita com nada disto e é o único risco que cresce a cada dia.

**Decisão 5 — o que NÃO virou requisito.** Três premissas trazidas pelo usuário não sobreviveram à medição e ficam registradas como tal, em vez de virarem código:

- "Navetec e Off Racer são importação" — `origin_code` fiscal diz que **82% dos Navetec e 91% dos Off Racer são NACIONAIS**.
- "Anúncios sem vínculo estão escondidos pela tela" — não estão escondidos: **a linha não existe**, porque o sync enumera vínculos, não o catálogo.
- "A Curva ABC pode ganhar filtro de conta" — pode, mas **só dentro do RPC**: filtrar em JavaScript produziria uma curva silenciosamente errada, e este repositório já teve exatamente esse bug de grão multi-conta.

### Duas questões ABERTAS que bloqueiam parte do roadmap

Nenhuma delas é decisão técnica, e **nenhuma foi respondida** — por isso ficam aqui em vez de virarem premissa inventada.

**Questão 1 — o estoque sentinela.** Os valores 3.996 e 39.996 são o estado real do UpSeller (e devemos tratar `LOCAL` como "não confiável" para valor e cobertura), ou são erro de exportação a corrigir na origem? **Bloqueia**: valor de estoque, cobertura confiável e a Fase 5D inteira.

**Questão 2 — o que "importado" significa na operação.** Rota de compra (fornecedor no exterior) ou origem fiscal do item? A resposta decide se a configuração de reposição pendura em fornecedor, em marca ou em SKU. **Bloqueia**: o modelo de configuração da Fase 5D.

**Impacto:** `docs/ROADMAP.md` (5 subfases novas, ordem de execução atualizada), `docs/PRODUCT_REQUIREMENTS.md` (consolidação dos 30 blocos), `docs/METRICS.md` (§5C, com o veto de nome e os bloqueios declarados), `docs/MERCADO_LIVRE.md` (§2.14 catálogo, §2.15 financeiro, §2.16 relist). **Somente documentação — nenhuma linha de código, nenhuma migration, nenhuma alteração de banco ou infraestrutura.**

## D-121 — A V3 passa a saber quais anúncios existem: enumeração pelo catálogo real

**Contexto:** primeiro item da Fase 4B. Até aqui `listings` era populada enumerando `sku_listing_links` — ou seja, **só anúncios que a planilha do UpSeller já tinha vinculado**. D-117 mediu a consequência: 7.361 itens já venderam, **3.679 sem vínculo nenhum**, e 21,8% dos itens vendidos em 30 dias saem com `sku_id` nulo (R$ 699.733,15). O endpoint `GET /users/{id}/items/search` estava registrado desde a Fase 0 e **nunca tinha sido chamado**.

**Decisão 1 — a pesquisa oficial veio antes do código, e mudou o desenho três vezes** (`docs/MERCADO_LIVRE.md` secao 2.14, leitura ao vivo):

- **`results` traz só IDs**, nunca objetos. Enumerar é obrigatoriamente **duas fases**: descobrir e depois hidratar via multiget de no máximo 20 ids, em envelope verbose com `code` por item.
- **O teto de 1.000 é real**, confirmado em três lugares da doc. A maior conta desta organização já teve **2.675 itens distintos observados** — `search_type=scan` **não é otimização, é obrigatório**.
- **Não existe filtro por data.** Sincronização incremental por este endpoint é impossível; ele é reconciliação/backfill, e o incremental continua sendo o webhook `items` — posicionamento que a própria doc afirma (*"não substitui o uso das notificações de itens"*).

**Decisão 2 — a varredura é drenada INTEIRA antes de qualquer escrita.** O `scroll_id` expira em 5 minutos e a FAQ oficial diz que deixá-lo aberto gera 429. Gravar em lote no meio do laço é o caminho para scroll expirado — então a fase 1 acumula os IDs em memória (alguns milhares de strings, custo irrelevante) e só depois a fase 2 escreve.

**Decisão 3 — `limit` só na primeira chamada, por contradição declarada.** Duas páginas oficiais discordam: a FAQ (05/05/2026) diz que `scroll_id` junto com `offset`/`limit` causa erro; a página de itens (07/04/2025) põe a nota do `limit` máximo dentro da seção do scan. A FAQ é mais recente. O recorte conservador está travado por teste e **marcado para medir**.

**Decisão 4 — nenhuma ordenação é enviada, com teste-guarda.** Aqui o parâmetro é **`orders`**; `sort` pertence a `/sites/{site}/search`. Confundir os dois é exatamente o erro que custou D-109, e a varredura completa não depende de ordem — então o caminho mais seguro é não mandar nenhuma.

**Decisão 5 — `sku_id` deixa de dirigir a enumeração e vira LOOKUP.** Um `Map` carregado de uma consulta só; anúncio sem vínculo entra em `listings` com `sku_id` nulo. A coluna sempre foi anulável e a interface de `/anuncios` já renderiza `"—"` — o que faltava era a linha existir. Também mudou para leitura em BLOCO o estado anterior usado pelo motor de diff (antes era uma consulta por item; com catálogo completo seriam milhares).

**Decisão 6 — as cinco perguntas que a doc não responde estão INSTRUMENTADAS.** O log `listings_catalog_probe` registra páginas de varredura, itens descobertos, itens sem vínculo, vínculos conhecidos e **a distribuição de status observada** — que é o que responde a pergunta mais importante ("a busca sem filtro devolve `closed`/`paused` ou só ativos?", cuja frase na doc pertence a OUTRO endpoint da mesma página). É a lição de D-109: a evidência existia e era descartada.

**Falha por item, nunca do lote:** `code != 200` no envelope verbose e payload fora do schema contam em `itemsFailed` e o lote segue. Falha do upsert conta como falha e **nunca** soma em `itemsProcessed` — sem isso, um lote perdido viraria "done, N processados", a mesma classe de mentira que D-067 auditou.

**Consequência operacional a observar no primeiro ciclo:** a carga cresce de propósito. Antes eram 3.168 itens enumerados por vínculo; agora é o catálogo inteiro (pelo que já observamos, no mínimo ~8.800 nas quatro contas), o que significa dezenas de páginas de varredura e algumas centenas de chamadas de multiget por ciclo de 6h. O backoff com jitter do cliente já existe; **o número real só a primeira execução dirá**, e é justamente o que a instrumentação vai medir.

**Impacto:** `packages/mercado-livre/src/items.ts` (novo — `scanSellerItems`, `getItemsBatch`, `chunkItemIds`, 14 testes), `apps/worker/src/handlers/ml-listings-fetch.ts` (reescrito, 12 testes), `sync-listings-snapshot.ts` (passa `seller_id`; conta CONNECTED sem ele é falha não-retryable, porque é incoerência de dado). **Sem migration** — `listings.sku_id` já era anulável e `sync_runs.resource` continua `listings`. `check` 29/29.

**DEPLOYADO E COMPROVADO em produção em 2026-08-28**, na ordem obrigatória worker→api: `worker-00041-x4q` e `api-00027-lsp` (tag `fa43fe5`, árvore limpa). Disparo manual de `v3-listings-snapshot`: a api enfileirou 4 jobs (0 deduplicados) e **as 4 contas terminaram `done`**, com 4.643 itens processados e zero falha.

**O efeito medido, que é o ponto inteiro da Fase 4B:**

| | antes | depois |
|---|---|---|
| Linhas em `listings` | 3.168 | **5.085** |
| Anúncios **sem vínculo** | 0 (impossível por construção) | **1.917 (37,7%)** |

Esses 1.917 anúncios existiam no Mercado Livre e **não existiam no nosso sistema**. Agora existem, com `sku_id` nulo, e `/anuncios` já sabe renderizá-los.

**As perguntas em aberto da §2.14, respondidas pela primeira execução real** — que é exatamente para isto que o `listings_catalog_probe` foi instrumentado:

1. **A busca SEM filtro de status NÃO devolve só ativos.** Medido por conta: `active` 787–859, `paused` 326–380, `under_review` 4–8, `closed` 1–4. Confirma a leitura de que a frase *"os resultados sempre serão de itens ativos"* pertence ao OUTRO endpoint da mesma página — presumir o contrário teria escondido ~30% do catálogo, que está pausado.
2. **`limit=100` na primeira chamada funciona e as páginas seguintes voltam ao padrão 50** (22–24 páginas para ~1.100–1.230 itens). O recorte conservador (limit só na primeira, nunca junto de `scroll_id`) atravessou o catálogo inteiro sem erro.
3. **O laço encerra corretamente** nas quatro contas, sem repetição e sem estouro do teto de segurança.

**Limitação DESCOBERTA na verificação, registrada em vez de escondida:** 442 linhas antigas **não foram revistas** pela varredura — todas `closed`/`inactive` e todas com SKU. São anúncios que a enumeração por vínculo trouxe um dia e que a busca de catálogo não devolve mais. Elas permanecem com o último estado conhecido, e **o upsert não colhe (reap) linha que sumiu do catálogo**. Consequência prática para quem lê a tabela: `synced_at` é o único jeito de saber se a linha foi vista na última varredura. Colher ou marcar essas linhas é fatia própria — apagar histórico de anúncio encerrado sem decidir antes seria pior que mantê-lo.

**Nota operacional:** as varreduras dispararam `slow_operation` (instrumentação própria do projeto, >1.500 ms), o que é esperado e não é falha — cada execução faz 22–24 páginas de busca mais ~60 chamadas de multiget. Zero `job_failed`, zero erro de rate limit na janela.

## D-122 — A fila de anúncios sem vínculo é DERIVADA, não materializada: `link_candidates` não recebe o Mercado Livre

**Contexto:** o item 2 da Fase 4B, escrito por mim em D-120, dizia *"abrir `link_candidates` para o Mercado Livre"* — o que exigiria migration (aceitar `source='ML_CATALOG'`, tornar `source_row_id` e `sku_key` anuláveis, criar índices únicos parciais) mais um gerador e uma política de obsolescência. Antes de escrever a migration, submeti as duas alternativas a um painel independente (duas defesas + um levantamento de fatos + um juiz, todos lendo o código real). **O painel derrubou o item que eu mesmo tinha escrito, e derrubou também um número que eu havia reportado.**

**Decisão 1 — a fila é derivada de `listings`, não materializada.** `link_candidates` existe para referências **sem casa**: a planilha cita um anúncio que talvez nem esteja sincronizado. Desde D-121 os anúncios do Mercado Livre TÊM casa (`listings` tem o catálogo inteiro). Materializar candidatos duplicaria estado, criaria obsolescência (candidato aberto quando o vínculo nasce por outro caminho) e exigiria um segundo reconciliador — porque o `reconcileLinkCandidates` existente indexa por `source_row_id` e relê `erp_import_rows`, sendo **por construção incapaz** de resolver um candidato de ML.

**Decisão 2 — a correção que muda tudo: `listings.sku_id IS NULL` NÃO é "anúncio sem vínculo".** O lookup que preenche a coluna usa `ref_kind='ITEM'` e `variation_id IS NULL`, de propósito, porque a pergunta do sync é *"que SKU atribuo a ESTE item?"*. Um anúncio corretamente vinculado nas suas VARIAÇÕES chega com `sku_id` nulo.

Medido: dos **1.917** com `sku_id` nulo, **1.013 (52,8%) já têm vínculo de variação**. Sem vínculo nenhum são **904** — 658 ativos. **Isto corrige o número que D-121 reportou**: "1.917 anúncios sem vínculo" estava errado; 1.917 é "sem vínculo de item inteiro".

A consequência de não corrigir seria grave, não cosmética: metade da fila seria trabalho falso, e a ação natural do operador — vincular o anúncio inteiro — é exatamente o estado misto que D-119 recusa, porque não resolve venda nenhuma **e leva o estoque Full para o SKU errado**.

**Decisão 3 — o anti-join vai para SQL, contrariando o painel, por regra do projeto.** O juiz propôs fazer o anti-join em JavaScript no Server Component, sem migration. Recusei: isso exigiria trafegar ~13 mil vínculos de variação por render e viola `docs/ARCHITECTURE.md` secao 15/21 (*"Zero agregação em JavaScript"*, com o motivo medido na V2: 119 ms contra 1.343 ms). `get_unlinked_listings` (`security invoker`, migration `20260828183728`) faz anti-join, junção de receita e ordenação onde essas coisas pertencem. É **uma função nomeada que `drop function` desfaz** — não é estado novo.

**Decisão 4 — ordenar por DINHEIRO, não por data.** A fila tem centenas de linhas; `created_at` ascendente (o padrão da tela de candidatos) põe o mais velho na frente. Medido no primeiro uso: o topo é um baú Navetec com **R$ 42.517,70 em 30 dias e 139 unidades vendidas — sem vínculo nenhum**. Padrão da tela é **só ativos**; pausado é fila legítima e fica atrás de um link.

**Decisão 5 — a ação reusa o caminho de escrita existente.** Cada linha leva a `/vinculacoes?conta=…&item=…`, que pré-preenche o formulário de D-119 pela URL — mesmo padrão de filtro na URL do resto do app, **sem estado novo, sem RPC de escrita nova, sem policy nova**. As cinco recusas que D-119 construiu (mesma forma, mistura de formas, mesmo SKU, corrida 23505, sessão expirada) continuam sendo a única porta.

**O que fica de fora, conscientemente:** DISMISS persistente ("este eu decidi nunca vincular") — `dismiss_link_candidate` existe desde 21/08 e **nunca rodou sobre dado real** (a tabela tem zero linhas). Construir o segundo caminho de descarte para um botão que nunca foi apertado violaria o critério do projeto. Gatilho declarado para reabrir: se depois de duas semanas de uso o resíduo de anúncios ativos, frescos e recusados pelo operador passar de ~50 linhas, nasce `listing_link_exclusions` — e ainda assim **não** `link_candidates`. Também fica fora o auto-match por `seller_custom_field`: o campo nem é pedido hoje, e se a medição confirmar disponibilidade ele escreve direto em `sku_listing_links` com `source='RULE'`, valor que o CHECK já aceita — ou seja, o maior prêmio prometido pela alternativa é alcançável sem ela.

**Dois textos que ficaram falsos no deploy de ontem foram corrigidos no mesmo commit:** `/anuncios` afirmava *"Anúncio ainda sem vínculo não aparece aqui"* (falso desde D-121 — a página lista as 5.085 linhas, 1.917 com "—" no SKU) e a abertura de `/vinculacoes` dizia que a lista *"não conhece anúncios que só existem no Mercado Livre"*.

**Impacto:** migration `20260828183728` (uma função, sem tabela/coluna/índice), `apps/web/app/vinculacoes/{page,manual-link-form}.tsx`, `apps/web/app/anuncios/page.tsx` (texto), `packages/db/src/types.ts` (tipo inserido cirurgicamente). `check` 29/29. **O bloco de guarda de candidato OPEN em `actions.ts` NÃO foi tocado** — é código morto hoje (zero candidatos) e continua morto, mas removê-lo seria mudança sem necessidade medida e quebraria a compatibilidade se a fonte ERP voltar a produzir candidatos.

## D-123 — Venda de anúncio COM variação volta a contar: R$ 469.593,20 que a tela escondia

**Contexto:** terceiro item da Fase 4B. `get_listing_sales` e `get_listing_traffic` filtravam `m.variation_id is null`, e o comentário da própria função dizia o motivo: *"mesma restrição de escopo: só itens sem variação, igual sync.listings.snapshot"*.

**Decisão — o filtro era o espelho de um limite que deixou de existir, e virou mentira.** Enquanto `listings` só continha itens sem variação (enumeração por `sku_listing_links`), somar variações traria linhas sem par na tela. **D-121 acabou com essa restrição** — `listings` é o catálogo real e itens com variação estão lá. O filtro parou de proteger e passou a **esconder receita**.

Medido em 2026-08-28, últimos 30 dias: **R$ 469.593,20 (15,4% da receita) em 460 anúncios** ficavam invisíveis em `/anuncios`. Um dashboard que erra 15% para menos não é conservador — é errado.

**Por que não há dupla contagem, medido e não presumido.** `daily_listing_metrics` tem grão `(ml_account_id, mlb_id, variation_id, metric_date)` e cada item de pedido contribui para exatamente UMA linha; verifiquei que **zero** itens têm os dois grãos no mesmo dia. As duas funções **já agrupavam por `(conta, mlb_id)`** — a pergunta certa para uma tela cujo grão é o ANÚNCIO. A prova final é aritmética: depois da mudança, a soma do RPC bate com `daily_account_metrics` com diferença de **exatamente R$ 0,00**; antes faltavam R$ 469.593,20.

**O que NÃO foi corrigido, e por quê.** Itens com variação passam a ter PEDIDOS mas continuam sem VISITAS — a varredura de visitas ainda enumera `sku_listing_links` com `variation_id is null`. Para eles `conversion_rate` continua `null`, nunca zero: sem denominador, a resposta honesta é "não sei", não "0%". Medido: **1.060 anúncios vendem sem visita registrada** e 3.382 dos 5.085 do catálogo não têm visita nenhuma.

Trocar a enumeração de visitas (e de Full) para `listings` é **fatia própria** porque muda a carga na API do Mercado Livre: a API de visitas aceita **1 item por chamada** (`docs/MERCADO_LIVRE.md` secao 2.15), então sair de ~3.168 para ~5.085 itens é ~1.900 chamadas/dia a mais. Isso merece sua própria verificação de rate limit, não um apêndice.

**Impacto:** migration `20260828185020` (duas funções substituídas, sem tabela/coluna/índice). Nenhuma mudança de código de aplicação — as telas já consomem as duas funções. `check` 29/29.

## D-124 — Visitas passam a enumerar o catálogo ativo: mais cobertura com MENOS chamadas

**Contexto:** fatia que D-123 separou de propósito, com a justificativa de que mudaria a carga na API. **A medição inverteu a minha própria estimativa** — e é por isso que separar valeu.

Eu havia escrito em D-123 que enumerar por `listings` custaria *"~1.900 chamadas/dia a mais"*. Isso assumia varrer o catálogo inteiro (5.085). Filtrando por **status ativo**, a conta é outra:

| | hoje (por vínculo) | agora (catálogo ativo) |
|---|---|---|
| Itens enumerados | 3.579 | **3.252** |
| Ativos cobertos | ~1.713 | **3.252** |

**Menos 327 chamadas/dia e mais 1.539 anúncios ativos cobertos.** A enumeração por vínculo tinha duas falhas ao mesmo tempo: deixava de fora anúncio com variação e anúncio sem vínculo (1.539 ativos, medido), e gastava chamada em item que nem está ativo (1.866, medido).

**Decisão 1 — enumerar `listings` com `status = 'active'`.** `daily_listing_visits` **não exige SKU** (grão é `(ml_account_id, item_id, metric_date)`), então anúncio sem vínculo é perfeitamente sincronizável. É exatamente o que separa este caso do Full — ver decisão 3.

**Decisão 2 — só ATIVOS, de propósito.** A API de visitas aceita **1 item por chamada** (`docs/MERCADO_LIVRE.md` secao 2.15), então cada item custa uma requisição por dia. Anúncio pausado ou encerrado não recebe tráfego relevante, e as linhas históricas dele continuam onde estão. Incluir os 1.833 não-ativos seria +56% de carga por dado quase sempre zero.

**Decisão 3 — Full NÃO muda nesta fatia, por restrição de schema.** `fulfillment_stock_snapshots.sku_id` é **NOT NULL** (congelado na captura, mesmo raciocínio de `order_items.sku_id`/D-020). Enumerar anúncios sem vínculo para Full falharia na inserção. Trocar exigiria tornar a coluna anulável — uma decisão sobre o significado do snapshot, não um ajuste de enumeração. Fica registrado, não feito.

**Consequência para a conversão:** os itens com variação agora ganham **visitas**, e D-123 já lhes deu **pedidos** — então `conversion_rate` deixa de ser `null` para eles a partir da próxima varredura. Antes de D-123+D-124, esses 460 anúncios (15,4% da receita) não tinham nem numerador nem denominador.

**Comentário falso corrigido junto:** a tabela declarava *"mesmo escopo de listings/Full: só itens sem variação"* — falso a partir desta mudança (migration `20260828192215`, só `comment on`).

**Impacto:** `apps/worker/src/handlers/ml-listing-visits-fetch.ts` (enumeração), testes dos dois níveis adaptados, migration só de comentário. `check` 29/29. **Não deployado** — pela regra de D-109, só verificado quando uma execução for lida.

## D-125 — Desfazer vínculo + histórico auditável, e um furo de escrita que estava aberto desde a Fase 2

**Contexto:** a lacuna que D-119 declarou e D-122 repetiu — *"não existe tabela append-only de eventos de vínculo"*, e um vínculo manual errado só se corrigia por SQL. O roadmap exigia as duas juntas: sem histórico, remover é destruir.

**Decisão 1 — remoção FÍSICA, não `removed_at`.** Um painel de desenho testou as duas e o soft delete quebra em três lugares, todos verificados no código:

1. **`resolveSku` pararia de persistir pedidos.** Ele filtra pela chave natural e termina em `.maybeSingle()`. Remover e revincular o mesmo anúncio criaria DUAS linhas com essa chave (o índice único só cobriria as vivas) → PGRST116 → o `throw` da guarda anti-overselling dispara sobre um estado LEGAL. A guarda existe para impedir venda sem baixa de estoque; ela passaria a impedir a própria feature.
2. **`get_unlinked_listings` (D-122) é anti-join físico**: a lápide continua satisfazendo o `exists`, e o anúncio não voltaria para a fila.
3. **`createManualLink` leria a lápide como "já vinculado"** e recusaria o revínculo.

Somado a isso, exigiria o primeiro `drop index` em 68 migrations, sobre um dos "três constraints que sustentam o sistema". Com remoção física, **seis leitores continuam corretos sem uma linha alterada** — a tabela volta a significar o que todos já assumem: uma linha, um vínculo vigente.

**Decisão 2 — 🔴 fechar a escrita direta, que estava aberta desde a Fase 2.** Medido hoje: `authenticated` tinha **DELETE, INSERT, UPDATE e TRUNCATE** em `sku_listing_links`, com policy `for all`. Qualquer ADMIN/GESTOR/OPERADOR com acesso à conta **já apagava ou reescrevia `sku_id` pelo PostgREST** — sem interface, sem auditoria, sem rastro. Não era hipótese: era o estado corrente, e a auditoria de GRANTs de D-066/D-098 excluiu esta tabela de propósito, por ela ter policy de escrita "legítima".

Sem fechar isso, a garantia "toda mudança deixa evento" seria vazia. Revogado no mesmo commit; a escrita passa a ser **só** pelas três RPCs.

**Decisão 3 — RETARGET é a operação primária, REMOVE é a rara.** Trocar o SKU preserva o `id` — logo preserva **todos os ponteiros já gravados em `order_items`** —, satisfaz os três índices trivialmente e grava `source='MANUAL'`, que `PROTECTED_SOURCES` blinda da planilha para sempre. Remover é para quando a intenção real é "este anúncio não deve ter vínculo nenhum", e exige motivo.

**Decisão 4 — a FK de `order_items` sai, para PRESERVAR a procedência.** `order_items.sku_listing_link_id` era `on delete set null`: a primeira remoção zeraria o ponteiro de **255.815 linhas (76,7%)** de forma irreversível. Sem a FK, o id resolve no snapshot **imutável** do evento — melhor que apontar para uma linha mutável que o importador reescreve sem rastro. Mesma forma de `domain_events.entity_id`.

**Decisão 5 — o importador em massa NÃO emite `CREATED`.** Seriam 20.650 eventos na primeira rodada para descrever uma decisão de máquina cuja procedência já vive em `erp_import_rows`/`erp_import_batches`. **Sem backfill dos vínculos existentes**: evento sintetico datado seria dado inventado e faria a linha do tempo mentir. A fronteira está escrita no `comment on table`.

**Verificado contra o banco real**, sob RLS como o usuário de produção, em transação revertida: `delete` direto recusado; ciclo `CREATED → RETARGETED (com previous_sku_id e motivo) → REMOVED (com motivo)` gravado corretamente.

**Consequência imediata assumida:** a revogação **quebrou** o `createManualLink` de D-119 (escrita direta), então ele foi religado à RPC no mesmo commit — e ganhou de brinde o que faltava: as três pré-checagens (mesma forma, mistura de formas, candidato aberto) eram **TOCTOU** fora da transação e agora rodam dentro dela. D-119 fica emendada, não contradita: o próprio critério dela ("RPC quando escreve duas tabelas na mesma transação") passou a se aplicar.

**FICA ABERTO, e é requisito da próxima fatia:** a **supressão no importador**. Um vínculo `IMPORT_UPSELLER` removido à mão volta na próxima importação e desfaz a decisão humana em silêncio — `erp-import-apply` precisa consultar os `REMOVED` humanos (o índice parcial dedicado já existe) e tratar a chave como `UNRESOLVED` em vez de recriar. Também aberto: emitir `RETARGETED` quando o importador reescreve `sku_id` in-place, que é a mutação mais frequente desta tabela e hoje não deixa rastro nenhum.

**Impacto:** migration `20260828191841` (tabela nova + trigger + RLS, revogações, drop da FK, helper de autorização, 3 RPCs, `resolve_link_candidate` emendada), `apps/web/app/vinculacoes/actions.ts` (RPC + `retargetLink`/`removeLink` + tradução de erro), `apps/web/lib/manual-link.ts` (as duas funções de mensagem de conflito foram REMOVIDAS — a RPC as absorveu, e duplicá-las seria manter duas verdades), 6 testes de RLS reescritos. `check` 29/29. **Sem UI de remover/trocar ainda** — as ações existem, o botão é a fatia seguinte.

## D-126 — A supressão que faltava: decisão humana não é desfeita pela planilha

**Contexto:** D-125 entregou remover/trocar vínculo com histórico, e declarou como requisito da fatia seguinte exatamente isto — sem supressão, um vínculo `IMPORT_UPSELLER` removido à mão **volta na próxima importação** e desfaz a decisão humana em silêncio. Uma feature de "desfazer" que se desfaz sozinha não é uma feature.

**Decisão 1 — a supressão é por CHAVE NATURAL, lida em lote.** `applyLinks` passa a montar um `Set` das chaves com `REMOVED` **humano** (`actor_source='HUMAN'`), no mesmo `chunk(accountIds)` que já existia, sobre o índice parcial dedicado que D-125 criou. Chave suprimida não gera INSERT.

**Decisão 2 — suprimido vira `UNRESOLVED` e NÃO abre candidato.** Vínculo removido por gente é **questão fechada, não fila**: abrir um `link_candidate` recolocaria na Central de Vinculações exatamente o que alguém tirou de lá. A linha da planilha fica `UNRESOLVED` com o motivo visível em `/importacoes`, que é onde o operador descobre por que aquela linha não aplicou.

**Decisão 3 — falha ao ler a supressão PROPAGA.** Tratar erro de leitura como "nada suprimido" recriaria exatamente os vínculos que alguém removeu de propósito — a mesma classe de mentira que D-067 auditou, e aqui com consequência de dado.

**Decisão 4 — a reescrita in-place do importador passa a deixar rastro.** `RETARGETED` com `actor_source='IMPORT'` e `previous_sku_id`. Isto fecha o buraco que a defesa do painel de D-125 apontou como o mais grave: **a mutação MAIS FREQUENTE desta tabela não é DELETE, é o UPDATE do importador** — e ele reescrevia `sku_id` sem deixar rastro nenhum. Foi por causa dele que D-020 precisou congelar `order_items.sku_id` em vez de confiar no join.

**Armadilha achada ao implementar, que teria virado erro em produção:** `toUpdate` também dispara quando **só o `channel_sku`** muda, e nesse caso `sku_id` continua igual — o que viola `sku_listing_link_events_target_coherent`, que exige `previous_sku_id <> sku_id` num RETARGETED. O evento só é emitido quando o SKU realmente mudou.

**Falha ao gravar o evento derruba o lote, de propósito.** O UPDATE é idempotente (mesmos valores na retentativa), então perder a auditoria é pior que repetir o trabalho — e é coerente com os outros `throw` da mesma função.

**Impacto:** `apps/worker/src/handlers/erp-import-apply.ts` (supressão + evento), 2 testes novos, tipo da tabela `sku_listing_link_events` inserido em `types.ts` (D-125 tinha inserido só as RPCs). **Sem migration** — o índice parcial e a tabela já vieram de D-125. `check` 29/29.

**Segue aberto:** o botão de remover/trocar na interface. As Server Actions (`retargetLink`/`removeLink`) existem desde D-125; falta a UI.

## D-127 — Estoque virtual é deliberado: a Fase 5D destrava, mas com outro desenho

**Contexto:** a questão aberta 1 de D-120, que travava a Fase 5D inteira. O usuário respondeu em 2026-08-28: **é o estado real do UpSeller, é estoque virtual** — número alto para o anúncio não pausar, não erro de exportação.

**A resposta muda a natureza do problema.** Não é dado sujo a limpar: é uma **classe de SKU cujo saldo não responde "quanto eu tenho"**. Cobertura, sugestão de compra e valor de estoque precisam saber a diferença — e um SKU virtual com "2.000 dias de cobertura" não é um número conservador, é um número errado com cara de preciso.

**Decisão 1 — a marcação é CONFIGURAÇÃO, porque procurei um sinal e não existe.** Três tentativas, todas medidas:

- **Armazém**: `erp_stock_snapshots.warehouse` tem **um valor só** (`ESTOQUE LOJA`). O virtual não mora num armazém separado.
- **Coluna no export**: não existe marcação nenhuma.
- **Regra derivada das vendas**: a assinatura é visível no histograma — **615 SKUs em exatamente 999, 254 em 998, 148 em 997, 106 em 996...** e, na outra base, **62 em 9.999, 34 em 9.998, 19 em 9.990**. São bases de **1.000 e 10.000 corroídas por venda**, e nenhuma distribuição natural faz isso. Mas testei a hipótese "base menos vendas acumuladas" contra as vendas reais e **ela NÃO se sustenta**: correlação **0,291** e só **165 de 2.172** SKUs batendo exato. O vendedor reajusta o sentinela por fora.

Um limiar (">1.000 é virtual") classificaria errado nos dois sentidos: o SKU virtual já bastante consumido (999 → 640) e o SKU real de giro alto. Então `skus.stock_is_virtual` nasce `false` para todos e **a migration não semeia nenhuma linha** — marcar é ato humano. É a regra transversal que o próprio usuário pediu no bloco 26: configuração em vez de hardcode.

**Decisão 2 — a cobertura RECUSA número para SKU virtual, em vez de escondê-lo.** `get_stock_coverage` devolve `days_of_coverage` nulo e `is_ruptura` falso para eles, mais a marca `stock_is_virtual`. A tela mostra "estoque virtual" na coluna de cobertura e ordena esses SKUs **no fim** — não é urgência, é ausência de resposta. Sumir com eles seria pior: o operador precisa saber que existem e que estão sem resposta.

**Nota sobre `is_ruptura`**: sem saldo físico confiável não dá para afirmar ruptura. Um SKU virtual com saldo alto nunca cairia em ruptura de qualquer forma, mas a regra fica explícita para quando o sentinela for consumido até zero.

**O que isto NÃO resolve, e é a próxima fatia:** marcar 2.306 SKUs um a um não é realista. Falta a **ferramenta de marcação em lote**, com a assinatura medida servindo de *sugestão* que o operador confirma — nunca aplicada sozinha. Enquanto ela não existir, a coluna está lá e ninguém está marcado, então o comportamento é idêntico ao de antes: nada quebrou, nada foi presumido.

**Consequência para a Fase 5D:** ela deixa de estar bloqueada por decisão de negócio e passa a ter uma **pré-condição técnica nomeada** — a marcação. Sugestão de compra sobre SKU não marcado continua sendo ficção, e agora o sistema sabe dizer isso.

**Impacto:** migration `20260828193425` (coluna + `get_stock_coverage` recriada com a marca), `apps/web/app/cobertura/page.tsx`, `packages/db/src/types.ts`. `check` 29/29. **Zero linha marcada** — comportamento inalterado até alguém marcar.

## D-128 — Integridade de vinculações: a fila não pode ser acreditada por si mesma

**Contexto:** blocos 16 e 17 do usuário. A desconfiança original — *"duvido que todos os anúncios estejam corretamente vinculados"* — estava certa, e D-117 mostrou que a fila era estruturalmente incapaz de saber. Faltava a tela que mede isso continuamente.

**Decisão — a coluna que importa não vem deste pipeline.** `get_link_integrity` devolve, por conta, o que se espera (anúncios, vinculados, sem vínculo, % e candidatos abertos) e mais uma coluna que é o ponto inteiro: **`vendidos_sem_vinculo`, derivada das VENDAS**. Um item que gerou pedido existe, independentemente do que a nossa varredura conheça. É a única fonte desta tela que não depende do pipeline auditado — auditar a fila com a própria fila não audita nada.

**A divergência que a tela mostra hoje**, medida em 2026-08-28 (90 dias):

| Conta | % vinculado | Candidatos abertos | Venderam sem vínculo | Receita |
|---|---|---|---|---|
| GMR | 79,1% | **0** | 142 | R$ 307.153,58 |
| SbMotos | 84,8% | **0** | 132 | R$ 267.013,04 |
| Speedbikers (loja 1) | 83,0% | **0** | 193 | R$ 449.611,23 |
| Speedbikers (loja 2) | 81,8% | **0** | 239 | R$ 528.039,29 |

**650 anúncios venderam sem vínculo, R$ 1.551.817,14 — com a fila de candidatos zerada nas quatro contas.** É exatamente o formato de divergência que o requisito pedia para detectar, e a tela agora a nomeia em vermelho em vez de deixá-la implícita.

**Nota sobre o denominador:** `% vinculado` é sobre o catálogo que a varredura conhece (`listings`), que desde D-121 é o catálogo real do vendedor. Antes de D-121 esse percentual teria sido 100% por construção — e falso.

**Impacto:** migration `20260828193942` (uma função), `apps/web/app/vinculacoes/page.tsx` (seção nova), `packages/db/src/types.ts`. `check` 29/29.

---

## Achado que CONTRADIZ a premissa da marcação por fornecedor (D-127)

O usuário respondeu que o estoque virtual é por fornecedor, citando Navetec e Off Racer. **A medição não sustenta essa associação**, e registrar isso agora evita construir a ferramenta de marcação sobre a chave errada.

Distribuição da assinatura sentinela (base 1.000/10.000) por marca:

| Marca | SKUs | Com assinatura | % |
|---|---|---|---|
| **MANETE** | 2.241 | **1.928** | **86,0%** |
| (sem marca) | 440 | 216 | 49,1% |
| **NAVETEC** | 228 | **1** | **0,4%** |
| **OFFRACER** | 65 | **17** | 26,2% |
| PLASMOTO | 134 | 0 | 0,0% |

O estoque virtual está concentrado em **MANETE**, não em Navetec. Duas leituras possíveis, e não dá para escolher entre elas sem o usuário:

1. **`brand` não é fornecedor.** O campo vem da coluna `Categorias` do UpSeller (D-039), e "MANETE" com 66% do catálogo parece **categoria de produto**, não marca nem fornecedor. Nesse caso a chave de marcação não existe no schema — é o item "Vínculo fornecedor → SKU", ainda aberto.
2. **A associação é real mas por outro fornecedor** — o que fornece os itens "MANETE" é que sempre tem, e Navetec/Off Racer são importados **sem** serem virtuais.

A afirmação "Navetec e Off Racer são sempre importados" segue **válida e útil** — ela responde a questão aberta 2 de D-120 (o que "importado" significa: **rota de compra**, não `origin_code` fiscal, que classifica 82% dos Navetec como nacionais). Ela só não é a chave do estoque virtual.

**Consequência:** a ferramenta de marcação em lote NÃO deve ser construída por marca antes de esclarecer isto. Fica aguardando.

> **RESOLVIDO em D-129 (2026-08-28), e a leitura 1 estava certa.** `brand` é a **categoria** do UpSeller. Com a marca real separada numa coluna própria, a distribuição fica sem ambiguidade: **Off Racer 82,4%** de assinatura sentinela contra **Navetec 0,4%**. Ou seja, a associação com fornecedor é **real** — só que é Off Racer, e **não** Navetec. "Importado" e "estoque virtual" são dois eixos independentes: Navetec é importado e tem contagem física de verdade. A ferramenta de marcação em lote está destravada, com a chave certa.

---

## D-129 — `brand` não é marca, é categoria: a marca real do fornecedor ganha coluna própria

**Contexto:** a Fase 5D e a ferramenta de marcação em lote de D-127 dependiam de um eixo "fornecedor" que o schema não tinha. O achado anterior (logo acima) media que o estoque sentinela estava em `brand = 'MANETE'` e não em Navetec, e deixava duas leituras em aberto. O usuário então instruiu: *"Manetes grande parte são OFF Racer, apenas alguns que são RT, TMAC ou até Aolixim; os que não têm categorizado a marca, pode deduzir os que tiverem algo que lembre ser Off Racer ou RT, e os que não têm pode deixar vazio para eu colocar manualmente mesmo."*

**Decisão 1 — a leitura 1 estava certa, e a medição agora prova.** `skus.brand` guarda a coluna `Categorias` do UpSeller: **2.255 de 3.554 SKUs (66%) em 'MANETE'**, que é um tipo de peça. NAVETEC, PLASMOTO, TMAC e AOLIXIM convivem no mesmo campo — o export mistura os dois conceitos numa coluna só. Nenhuma regra escrita contra `brand` pode ser confiável enquanto isso for verdade.

**Decisão 2 — coluna nova, e não conserto de `brand`, por um motivo mecânico.** O importador **sobrescreve** `brand` a cada planilha (`packages/domain/src/upseller/apply.ts:90`). Qualquer atribuição feita à mão morreria no próximo import, em silêncio. `supplier_brand` mora fora do alcance do importador. `supplier_brand_source` (`DERIVED` | `MANUAL`) separa o que a máquina deduziu do que a pessoa decidiu, para que um reprocessamento futuro possa reescrever `DERIVED` **sem nunca pisar** em `MANUAL`.

**Decisão 3 — deduzir só onde há evidência, e deixar o resto vazio de propósito.** Dentro de 'MANETE', a dedução usa título **e** código do SKU (o prefixo `off`/`kitoff` carrega sinal que o título não carrega). Fora de 'MANETE', `brand` já é a marca e é copiada. Resultado: **1.280 de 3.554 com marca (36%)**, **2.274 em branco (64%)** — exatamente o que o usuário pediu, e não um palpite disfarçado de dado. `supplier_brand_source = 'MANUAL'` está hoje em **zero linhas**.

**Decisão 4 — normalizar as duas grafias, em migration separada.** `OFF RACER` (567 deduzidos) e `OFFRACER` (65 copiados literalmente do ERP) são o mesmo fornecedor. Não é cosmética: a regra de origem que o usuário deu é **por fornecedor**, e com duas grafias qualquer regra escrita contra uma delas classificaria 65 SKUs errado. Colapsadas em `OFF RACER` — 632.

**O achado que fecha a contradição.** Com a marca real separada, a distribuição da assinatura sentinela deixa de ser ambígua:

| Marca real | SKUs | Com assinatura | % |
|---|---|---|---|
| **OFF RACER** | 631 | **520** | **82,4%** |
| (a preencher à mão) | 2.095 | 1.639 | 78,2% |
| **NAVETEC** | 228 | **1** | **0,4%** |
| PLASMOTO | 134 | 0 | 0,0% |
| RT | 73 | 2 | 2,7% |
| TMAC / AOLIXIM / PANDÃO / SAKAMAX / ATEC / SPORTIVE | 10–41 cada | 0 | 0,0% |

A associação com fornecedor é **real** — só que é **Off Racer, não Navetec**. E o resíduo "a preencher à mão" com 78,2% é coerente com o que o usuário disse: são as manetes ainda não atribuídas, em grande parte Off Racer. **A ferramenta de marcação em lote está destravada, agora com a chave certa.**

**Segundo achado, que veta uma fonte de dado inteira.** `skus.origin_code` (CST de origem da NF-e) **contradiz a regra do usuário em 707 SKUs**: Off Racer e Navetec são declarados sempre importados, mas 707 deles chegam como `origin_code = 0` (nacional); só 267 SKUs no catálogo inteiro têm `1` e 29 têm `2`. O campo é preenchido por quem emite a nota, não por quem compra. **Confirma D-120 questão 2 com número**: "importado" é rota de compra e o eixo é `supplier_brand` — `origin_code` **não serve** como fonte de Nacional/Importado, e a Fase 5C não deve usá-lo para isso.

**O que fica de fora, conscientemente: `skus.supplier_id`.** O item "Vínculo fornecedor → SKU" pede FK para `suppliers`, que existe desde a Fase de compras e tem **uma linha só** — PLASMOTO, criada porque um pedido de compra real precisou dela. Criar 19 fornecedores para acomodar 19 marcas seria inventar entidades com CNPJ, prazo e condição de pagamento em branco, só para satisfazer um modelo. `supplier_brand` é **atributo de catálogo** (a marca estampada na peça); `suppliers` é **entidade de compra** (a empresa para quem se emite o pedido). Coincidem neste negócio, mas não são a mesma coisa, e a segunda deve nascer quando uma compra real exigir — como PLASMOTO nasceu. O item do roadmap segue aberto, porém reduzido: o eixo de nomeação já existe e serve de semente.

**Impacto:** migrations `20260828195154` (duas colunas, dois CHECKs, um índice parcial, três `update` de semeadura) e `20260828195524` (normalização), `packages/db/src/types.ts` (Row/Insert/Update de `skus`, inserção cirúrgica). **Nenhuma tela mudou** — a coluna ainda não é lida por ninguém; ela destrava a marcação em lote e o filtro por marca da 5C. `check` **29/29**.

---

## D-130 — O teste-guarda de GRANTs nunca passou, e a razão é de catálogo: `TRUNCATE` não tem RLS por trás

**Contexto:** ao medir os privilégios de `skus` para desenhar a marcação em lote, apareceu `TRUNCATE` para `authenticated`. Puxando o fio, o achado é maior do que a tabela: **o teste-guarda que D-098 escreveu para apanhar exatamente esta classe de defeito nunca passou**, e por isso não apanhou nada.

**Achado 1 — a CI está vermelha desde 2026-08-27 (commit `52f60d7`), e ninguém viu.** O guarda `"nenhuma tabela de public da escrita a authenticated sem policy correspondente"` nasceu junto com D-098. Rodando a consulta dele contra o banco real, ela devolve **5 linhas** desde o primeiro dia:

| Tabela | Comandos órfãos | Desde |
|---|---|---|
| `profiles` | INSERT, DELETE | 2026-08-20 (criação) |
| `sku_listing_link_events` | INSERT, UPDATE, DELETE | 2026-08-28 (**D-125, meu**) |

`profiles` foi **excluída de propósito** da rodada 1 (D-066) sob a justificativa de "ter policy de escrita legítima". A justificativa vale para UPDATE — e só para ele: as linhas nascem de um **trigger sobre `auth.users`**, que roda como dono da função, nunca como `authenticated`. `sku_listing_link_events` é defeito meu de véspera: a migration de D-125 revoga de `anon` e esquece `authenticated`, que é **literalmente o erro descrito no comentário de D-098** ("um `grant select` explícito NÃO desfaz isso — GRANTs são aditivos").

Isso explica por que `check` 29/29 nunca foi garantia: `packages/db/package.json` exclui `*.integration.test.ts` do `test`, e a suíte só roda na CI, contra `supabase start`. **Seis commits (D-125…D-129) foram entregues lendo "29/29" como se fosse verde.**

**Achado 2 — a causa raiz, agora provada no catálogo e não por indução.** As rodadas anteriores discutiam se "tabela nova no Supabase nasce exposta" (D-062/D-066 mediram que sim; o comentário de `20260825170000` afirmava que não). `pg_default_acl` encerra a questão:

```
schema public, objeto 'r' (tabela), criador postgres
  -> authenticated=arwdDxtm/postgres
```

`a`=INSERT, `w`=UPDATE, `d`=DELETE, `D`=TRUNCATE. **Toda tabela criada por migration nasce com escrita total para `authenticated`**, e só um `revoke` explícito tira.

**Achado 3 — `TRUNCATE` derruba o argumento com que as duas rodadas anteriores se tranquilizaram.** D-066 e D-098 aceitaram o grant excessivo escrevendo "é aperto de superfície, não correção de vazamento — a RLS nega de qualquer jeito". **Para TRUNCATE isso é falso.** TRUNCATE não consulta policy, não respeita `using`, e **os triggers append-only de `domain_events` e `stock_movements` também não disparam nele**. É o único privilégio de escrita do projeto **sem nenhum backstop**.

Medido: **33 das 54 tabelas de `public`** ainda davam TRUNCATE a `authenticated` — entre elas `orders`, `order_items`, `skus`, `listings`, `stock_movements` e `domain_events`. As outras 21 nasceram depois da convenção de D-062 e já estavam limpas.

**Não há caminho conhecido de exploração hoje** — o PostgREST não expõe TRUNCATE. O motivo de remover assim mesmo: aqui "ninguém alcança" seria a **única** coisa entre o dado e o apagamento total. Revogado nas 33.

**Achado 4 — o guarda podia MORRER em vez de falhar.** A consulta original monta o nome com `format('public.%I', t.tablename)`. A ordem de avaliação de quals no Postgres **não é garantida**, então o predicado pode rodar antes do filtro `schemaname='public'` e chamar `has_table_privilege('authenticated','public.pg_statistic',…)` — erro `42P01`, que foi exatamente o que aconteceu ao rodar esta consulta durante esta decisão. Um guarda que estoura por acidente de plano não é guarda. Corrigido para passar o **OID**, que não depende de resolução por nome.

**Decisão — o invariante de TRUNCATE é absoluto, não condicionado a policy.** O segundo teste do bloco não pergunta "tem policy correspondente?", porque **não existe policy de TRUNCATE**. Ele afirma: `authenticated` não tem TRUNCATE em tabela nenhuma de `public`. Qualquer tabela futura que esquecer o revoke cai aqui.

**Limitação honesta desta entrega:** Docker não sobe nesta máquina, então **não rodei a suíte de integração localmente**. A verificação é indireta mas direta o bastante: as duas consultas dos testes foram executadas **contra o banco real**, e ambas devolvem **zero linhas** depois da migration (antes: 5 e 33). O veredito final continua sendo a CI.

**Impacto:** migration `20260828200541` (dois `revoke` de escrita, um `revoke truncate` em 33 tabelas), `packages/db/src/rls.integration.test.ts` (guarda corrigido para OID + teste novo de TRUNCATE). Nenhuma tela, nenhuma RPC, nenhum dado alterado. `check` 29/29.

---

## D-131 — O PostgREST corta em 1.000 linhas sem avisar, e isso corrompeu o saldo de estoque de produção

**Contexto:** eu ia construir a ferramenta de marcação em lote (fatia registrada no HANDOFF). Ao medir os privilégios de `skus` para desenhá-la, tropecei em `inventory_balances`: mínimo **−4.620**, máximo **43.964**, contra um snapshot do ERP da ordem de 10.000. Puxando o fio, o defeito é de classe e o estrago é grande.

**O mecanismo, e ele é o pior formato possível de defeito: não quebra, mente.** `supabase/config.toml:46` fixa `max_rows = 1000`. Uma consulta que devolveria mais que isso volta cortada com `error` **nulo** — o código segue achando que tem o conjunto inteiro. Nenhum lugar do repo altera esse teto, e `admin-client.ts` não manda header que o contorne.

**A cadeia, em `maintenance.reconcile-balances`:**

1. `compute_erp_snapshot_balances` devolve **6.744 linhas** (3.372 LOCAL + 3.372 RESERVADO). O handler recebia 1.000.
2. `loadLedgerBalances` lia `inventory_balances` (2.524 linhas) sem `.range()`. Recebia 1.000.
3. `computeReconciliationAdjustments` faz `ledgerByKey.get(chave) ?? 0`. SKU ausente **por truncamento** é lido como saldo zero.
4. Logo `delta = snapshot − 0 = snapshot`: o valor inteiro virava ajuste.
5. A chave de idempotência inclui a data (decisão consciente de D-029, não descuido), então não colide entre dias.
6. `inventory_balances` é projeção escrita por trigger que **soma** o delta. Os ajustes acumularam.

**A impressão digital, medida em produção:** SKU `1779-3717`, snapshot 9.999, saldo **39.996 — exatamente 4×**, com um ajuste de +9.999 por dia nos dias 25, 26, 27 e 28/08. SKU `1909-3911`: 10.991 → 43.964, também 4×. **637 SKUs receberam os quatro ajustes.** E os ajustes por dia nunca passaram de 1.000: 896, 674, 674, 657.

**Um painel adversarial de quatro lentes matou as duas explicações alternativas** e mediu o que eu não tinha medido:

- *"A trigger duplica"* — **morta**. `inventory_balances` == `sum(stock_movements.qty_delta)` em **2.524 de 2.524 linhas**. A projeção reproduz o ledger com exatidão; ela aplicou fielmente movimentos corrompidos.
- *"Retry do job reinsere"* — **morta**. 2.901 movimentos para 2.901 chaves distintas, com **máximo de 1 ajuste por SKU por dia**. A idempotência protegeu exatamente do que foi desenhada para proteger.
- **A prova que fecha o caso**: a recorrência do ajuste correlaciona com a **posição física da linha**. Todos os 259 SKUs que pararam de ser ajustados estão nas 1.000 primeiras linhas físicas de `inventory_balances`; 607 dos 637 com 4× estão além da posição 1.000. Posição no heap não significa nada para trigger nem para retry — só para um `LIMIT` sem `ORDER BY`.

**Três coisas que o meu diagnóstico inicial errou, e que o painel corrigiu:**

🔴 **1. O dano dominante é o OPOSTO do que eu descrevi.** Eu contei a história da inflação. Medido: **1.628 SKUs nunca receberam ajuste nenhum, e 1.627 deles estão NEGATIVOS** (mínimo −4.620). A reconciliação *era* o mecanismo de saldo de abertura — não existe `ENTRADA_NFE` no ledger, só `VENDA_ML` (216.388 movimentos, −222.145 unidades desde 2025-10-23). Truncada, ela semeou ~900 de 3.372 SKUs; o resto só recebeu dedução de venda e afundou. **65% da base está errada para baixo por falta de semeadura; 35% para cima por excesso.** Mesma causa, danos de sinal oposto.

🔴 **2. `RESERVADO` nunca foi reconciliado. Nem uma vez.** `compute_erp_snapshot_balances` é um `union all` que emite os 3.372 LOCAL **antes** do primeiro RESERVADO, sem `order by` — o corte em 1.000 decapitava a metade RESERVADO **sempre**. Medido: **zero** linhas RESERVADO em `inventory_balances`, **zero** ajustes RESERVADO em quatro dias, contra **300 linhas de snapshot com reservado ≠ 0 (686 unidades)**. Como `reconciliation.ts` declara este job a **única** fonte de movimento RESERVADO da V3, o item **"Reservado e em trânsito" da Fase 4 está marcado como concluído no ROADMAP e nunca funcionou um único dia em produção.**

🔴 **3. O vigia estava cego pelo mesmo defeito, e 69% do alarme era falso.** Dos 9.225 `stock.balance.diverged`, apenas 2.901 vêm da reconciliação — **6.324 vêm de `verify-ledger-integrity`**, o job de D-056 que existe para detectar corrupção de saldo. Ele lê `compute_inventory_balances_from_ledger` e `inventory_balances`, **as duas sem `.range()`**, e trata chave ausente de um lado como zero. Como a comparação real dá **zero divergências em 2.524 linhas**, esses 6.324 críticos são **100% falsos** — 1.100 a 1.370 por dia desde 24/08. O único alarme que existia para pegar este bug passou cinco dias gritando sobre um defeito impossível enquanto a corrupção de verdade acontecia ao lado.

**Mais duas ocorrências da mesma classe, medidas:**

- **`ml-fulfillment-fetch`**: lia `sku_listing_links` por conta sem paginar. O comentário no arquivo dizia *"as quatro contas reais têm hoje bem menos que 1.000 — ver se vira problema real antes de adicionar `.range()`"*. Medido em 28/08: **2.012, 1.915, 1.784 e 1.640**. **As quatro passaram**, e de 18% a 50% dos vínculos de cada conta nunca eram consultados — snapshot do Full pela metade, em silêncio. A lição registrada é sobre o formato da nota: *"hoje cabe, revisar depois"* não tem quem revise.
- **`/cobertura` e `/estoque`**: `get_stock_coverage` devolve 2.602 linhas e a página pedia sem `.range()`, depois contava ruptura e estoque virtual **em JavaScript sobre a fatia** — o cabeçalho anunciava contagem de amostra arbitrária, sendo a ruptura real **924**. `/estoque` era pior: ordenava por `quantity desc` **só** para decidir quais 1.000 das 2.524 linhas sobreviviam (a tela reordenava por SKU em JS logo depois), o que mostrava justamente os saldos inflados e **escondia ~1.524 dos 1.645 negativos**.

**Decisão 1 — um helper, não N correções pontuais.** `apps/worker/src/read-all-pages.ts` (`readAllPages`) faz o laço de `.range()`, com três coisas que não são detalhe: rebaixa `pageSize` ao teto do servidor (pedir 5.000 devolveria 1.000 e o laço concluiria "acabou"); **exige ordenação estável** do chamador, senão a mesma linha volta em duas páginas e no pior caso o laço não termina; e aceita `label` para o erro não perder o contexto que o `try/catch` manual tinha.

**Decisão 2 — os fakes de teste passam a fatiar de verdade.** Um fake que aceita `.range()` e devolve a lista inteira em toda janela faz teste passar sobre código que não pagina — e podia entrar em laço infinito. Os fakes tocados agora simulam `max_rows` com `pageCap`, e cada handler ganhou um teste que **falha contra a versão anterior**: 1.500 linhas iguais dos dois lados devem produzir **zero** ajustes.

**Decisão 3 — instrumentação, porque o defeito era invisível.** `balances_reconciled` passa a logar `snapshot_rows` e `ledger_rows`. Sem esses dois números não havia como perceber que o job lia 1.000 de 6.744.

**O que NÃO faço aqui, e por quê.** Não escrevo script de reparo: `stock_movements` é append-only e o handler corrigido **repara sozinho** (com D-132, `delta = alvo − saldo_inflado`, negativo). Mas com uma ressalva que o painel achou e que teria me feito reportar sucesso falso: `recordStockMovements` usa `ignoreDuplicates: true`, e as **657 chaves `reconciliacao:2026-08-28:*` já existem**. Rodar hoje pularia esses SKUs **em silêncio** e o job reportaria `processed` alto mesmo assim. **O reparo entra na rodada de 2026-08-29**, com chave nova — e pela regra de D-109 só estará verificado quando a execução for lida.

**Correção a D-120, que leu o sintoma deste bug como dado legítimo.** D-120 registrou: *"164 em exatamente 3.996, 9 em 39.996. É estoque sentinela do ERP, espelhado com fidelidade pela reconciliação (+5.206.669 unidades)"*. **3.996 = 4 × 999 e 39.996 = 4 × 9.999**: é a assinatura 4× deste defeito, não fidelidade ao fornecedor. A mesma auditoria também classificou `stock.balance.diverged` como "59% de ruído da Central de Notificações" — o ruído era este bug, e 69% dele vinha do vigia cego. **D-127 não é afetada**: ela mediu a assinatura sentinela em `erp_stock_snapshots`, que nunca esteve corrompido.

**Uma afirmação minha que era falsa:** eu disse "74 SKUs acima de 10.000, e o teto do ERP é 10.000". Não existe esse teto — `docs/UPSELLER.md` secao 6 documenta retrovisores com ~10.993 unidades como estoque artificial do próprio ERP, e D-038 decidiu tratá-los como reais.

**Impacto:** `apps/worker/src/read-all-pages.{ts,test.ts}` (novo, 7 testes), `reconcile-balances.{ts,test.ts}`, `ml-fulfillment-fetch.{ts,test.ts}`, `verify-ledger-integrity.{ts,test.ts}`, `sync-fulfillment-snapshot.test.ts`, `apps/web/app/{cobertura,estoque}/page.tsx`, migrations `20260828203950` (`get_stock_coverage_summary`) e `20260828204103` (`get_stock_balances`), `packages/db/src/{types.ts,rls.integration.test.ts}`. `check` **29/29**. **A suíte de integração não rodou aqui** (Docker não sobe nesta máquina) — as consultas foram verificadas contra o banco real.

---

## D-132 — O alvo da reconciliação é o snapshot ROLADO PARA A FRENTE, não o retrato congelado

**Contexto:** ao corrigir o truncamento de D-131, uma lente do painel refutou não o mecanismo, mas a **conclusão**: paginar sozinho não conserta o saldo. Existe um segundo defeito, independente, e paginar sem tratá-lo **pioraria** — passaria a aplicá-lo aos 3.372 SKUs em vez de ~900.

**O defeito:** `compute_erp_snapshot_balances` devolvia o retrato cru, e o handler forçava `saldo := snapshot`. Existe **um único** snapshot no banco (2026-08-21 15:42) e **não existe job de import do ERP** — `infra/cloud-scheduler.sh` tem 13 jobs `v3-*` e nenhum deles importa a planilha. Com o job rodando todo dia contra um retrato parado, **ele desfaz a venda de cada dia**.

**Medido, e em SKUs NÃO afetados pelo truncamento** (o ajuste é +1, +2, +3 — não o snapshot inteiro), o que isola o mecanismo:

| SKU | Snapshot | Vendeu após a captura | Alvo correto | Saldo hoje |
|---|---|---|---|---|
| `EB0001` | 13.163 | −251 | **12.912** | **13.143** |
| `SV73` | 2.025 | −134 | **1.891** | **2.016** |
| `TM874.TM0451` | 608 | −146 | **462** | 115 |

Há SKUs em que o ajuste do dia N é **exatamente o oposto da venda do dia N−1**: 31 casos em 26/08, 26 em 27/08, 15 em 28/08.

**E a defesa óbvia não se sustenta** — *"o problema é o import do ERP não rodar"*. O próprio código a derruba: `apps/api/src/balance-reconcile-schedule.ts` escolheu cadência **diária** justamente porque *"o snapshot só muda quando alguém reimporta a planilha do UpSeller manualmente (esporádico)"*. O desenho reconhece o snapshot esporádico e mesmo assim o reaplica todo dia.

**Decisão — "o UpSeller vence" (D-029) continua valendo, com a precisão que faltava: ele vence NO INSTANTE DA CAPTURA.** O que aconteceu depois — venda, cancelamento, devolução — é verdade nossa, com fonte própria, e não pode ser apagado por um retrato mais velho:

```
alvo = snapshot + movimentos com occurred_at > captured_at
```

`compute_erp_target_balances` substitui a função antiga, que foi **removida** (manter as duas convidaria a chamar a errada, e o nome `snapshot_balances` descreve exatamente a semântica recusada).

**`AJUSTE_RECONCILIACAO` fica de fora da soma, e é isso que torna a função correta em vez de circular:** ajuste não é evento de estoque, é correção em direção ao alvo. Somando-o, o alvo perseguiria o próprio rastro.

**A álgebra fecha nas três situações** (L = saldo atual, S = snapshot, M = movimentos reais após a captura):

| Situação | Saldo atual | Delta | Efeito |
|---|---|---|---|
| Saudável | `L = S + M` | **0** | nada a fazer |
| Inflado 4× (D-131) | `L = 4S + M` | **−3S** | volta ao certo |
| Nunca semeado | `L = M` | **S** | o saldo nasce |

**Ganho que não era o objetivo e vale registrar: o job vira idempotente entre dias.** A repetição diária de D-029 passa a produzir **zero** quando não há divergência real, em vez de um ajuste novo a cada rodada. A data na chave de idempotência deixa de ser amplificador de defeito e volta a ser o que D-029 queria: rastro de uma divergência que persiste.

**O que a primeira rodada corrigida vai fazer, medido antes de rodar:** 3.229 dos 3.372 SKUs precisam de ajuste LOCAL (delta líquido **+881.843** unidades — a soma de tirar dos inflados e semear os 1.628 zerados) e **3.372 precisam de ajuste RESERVADO, que nasce pela primeira vez (686 unidades)**.

**Resíduo declarado, que este desenho NÃO resolve:** 27 SKUs têm linha LOCAL no ledger e **não têm** contrapartida no snapshot (de −87 a −1 unidades). `computeReconciliationAdjustments` só itera sobre `snapshotBalances` — por construção, esses 27 nunca são visitados e continuam negativos. Não é descuido: são SKUs sobre os quais o ERP não tem opinião, e inventar uma seria pior. Gatilho para reabrir: se depois de uma reimportação fresca da planilha eles continuarem fora, é sinal de SKU morto no ERP e vivo na V3 — problema de catálogo, não de estoque.

**Impacto:** migration `20260828203624` (uma função criada, uma removida), `apps/worker/src/handlers/reconcile-balances.{ts,test.ts}`, `packages/db/src/{types.ts,rls.integration.test.ts}` (teste novo provando que movimento posterior à captura entra no alvo e que `AJUSTE_RECONCILIACAO` não entra). `check` **29/29**.

---

## D-133 — Curadoria do catálogo: `false` deixa de significar duas coisas ao mesmo tempo

**Contexto:** a fatia pendente desde D-127 era a "ferramenta de marcação em lote" — marcar ~2.300 SKUs um a um não é realista. D-129 corrigiu a chave (a assinatura sentinela é **Off Racer 82,4% contra Navetec 0,4%**, não `brand='MANETE'`), e D-131/D-132 tornaram o saldo por baixo dela confiável. Antes de escrever código, submeti o desenho a um painel: cinco leitores mapearam o terreno, três desenhos independentes por lentes diferentes (menor superfície / a pessoa que vai usar / ciclo de vida do dado) e um juiz.

**O juiz escolheu a lente do DADO, e o argumento decisivo foi um que nenhum dos outros dois viu.** `applyProducts` não só atualiza SKU: ele **INSERE** SKU novo. Todo SKU que a próxima planilha criar nasce com `stock_is_virtual = false` por default — e, sem uma marca de decisão, ele fica **indistinguível** de um que alguém já examinou e aprovou como estoque físico. Some da fila de trabalho para sempre, mesmo chegando com saldo 999.

**Decisão 1 — a DATA da decisão, separada do VALOR.** `stock_is_virtual_set_at` e `supplier_brand_set_at` (mais os atores). `set_at is null` passa a significar **nunca classificado**; `false` deixa de ser resposta e volta a ser ausência de resposta. `updated_at` não serviria: a trigger é bumpada pelo importador a cada planilha, então mede "quando o ERP falou deste SKU", nunca "quando uma pessoa decidiu".

**Decisão 2 — CHECK de IMPLICAÇÃO, não bicondicional, e o painel corrigiu dois dos três desenhos aqui.** Dois deles escreveram `by is null = at is null` e justificaram `on delete restrict` afirmando que essa é "a convenção unânime do projeto para coluna de ator". **É falso no código**: coluna de ator em linha MUTÁVEL é `on delete set null` em pelo menos oito lugares (`sku_listing_links.confirmed_by`, `link_candidates.resolved_by`, `erp_import_batches.uploaded_by/applied_by`, os quatro de `purchase_orders`). Com bicondicional, apagar um usuário estouraria a constraint numa operação que não tem nada de errado — a mesma classe de erro enganoso que D-099 e D-113 tiveram de consertar depois. Com implicação (`set_by is null or set_at is not null`), o ator some e a **data fica**: continua sabendo que a decisão existe, só não quem tomou. E passa nas 1.280 linhas `DERIVED` existentes sem backfill nenhum.

**Decisão 3 — três estados de decisão, não dois.** `VIRTUAL`, `FISICO` e **`INDEFINIDO`** (enxerto do desenho perdedor). Sem o terceiro, uma marcação errada só poderia ser *invertida*, nunca *desfeita*, e o SKU nunca voltaria à fila. É o que faz o botão **Desfazer** existir de verdade.

**Decisão 4 — retorno POR LINHA, primeira vez no repositório.** `APLICADO | JA_DECIDIDO | NAO_ENCONTRADO`. Não é enfeite: com o filtro de no-op, "412 marcados" pode significar 8, e sem o retorno por linha essa diferença é invisível. Duas consequências desenhadas em cima disso: a faixa de resultado diz *"412 aplicados · 85 já estavam assim · 3 sumiram da lista — recarregue"*, e o **Desfazer manda de volta APENAS os `APLICADO`** — mandar os enviados reverteria decisão que já era de outra pessoa.

**Decisão 5 — id de outra organização vira `NAO_ENCONTRADO` em vez de abortar o lote.** Desvio declarado dos precedentes de linha única (`create_sku_listing_link` levanta exceção). O motivo: abortar faria o operador perder as outras 499 decisões por causa de uma linha que ele nem sabia que estava ali. A tela é **obrigada** a exibir a contagem — silenciar seria pior que abortar.

**Decisão 6 — o no-op tem duas sutilezas que parecem detalhe e não são.** Reafirmar `FISICO` sobre um SKU cujo `stock_is_virtual` já é `false` **NÃO é no-op** quando `set_at is null`: é o clique que tira o SKU da fila. E confirmar à mão uma marca `DERIVED` idêntica também não é: promove a linha a `MANUAL` e a **blinda** contra re-derivação futura. Os dois casos estão nos testes.

**Decisão 7 — `MANUAL` é literal no corpo da função, nunca parâmetro do cliente.** A CHECK de coerência só proíbe um-nulo-outro-preenchido; gravar `'DERIVED'` passaria em tudo e seria apagado em silêncio pela primeira re-derivação — exatamente o modo de falha para o qual D-129 criou a coluna. E limpar a marca zera as **quatro** colunas no mesmo statement: anular só o texto estouraria `skus_supplier_brand_source_coherent` (23514) e derrubaria o lote inteiro.

**Decisão 8 — ADMIN/GESTOR, e a LEITURA também é `security definer`.** A tela projeta `erp_stock_snapshots`, cuja policy exige ADMIN/GESTOR, e uma RPC `security definer` não pode conceder mais acesso do que a leitura direta concedia. O corolário é o que importa: com `security invoker`, um OPERADOR veria a tela **VAZIA** em vez de receber "sem permissão" — e tela vazia mente.

**Medições feitas antes de escrever, não depois:**

- **Pré-merge de normalização**: a maior marca existente tem **12 caracteres**, **zero** fora de caixa alta, **zero** com espaço nas bordas — logo o `upper(btrim(...))` da RPC não cria marca gêmea. (D-129 já tinha precisado de uma migration só para colapsar `OFFRACER`/`OFF RACER`; era essa a armadilha.)
- **`EXPLAIN (ANALYZE, BUFFERS)`** da fila, primeira página de 100: **116 ms**, todos os buffers em `shared hit`, vendas de 90 dias por `daily_sku_metrics_account_date_idx`. **Nenhum índice novo** — o plano não pediu, e `docs/DATABASE.md` secao 6 exige EXPLAIN antes de criar índice. Um dos desenhos propunha um índice parcial; foi recusado por isso.
- **182 SKUs não têm retrato do ERP.** Por isso `has_sentinel_signature` é **NULL** para eles, e não `false`: "sem opinião do ERP" é um terceiro estado, e a tela diz "Sem retrato do ERP" em vez de "Não parece sentinela".

**Uma correção do painel ao desenho vencedor, aceita:** ele filtrava o universo por `is_active`. Nenhum outro consumidor de `skus` filtra (`get_stock_coverage`, `get_sku_abc_curve`, nenhuma tela), e filtrar faria as contagens da tela discordarem dos 3.554 SKUs medidos, além de esconder SKU descontinuado que ainda carrega saldo. Removido.

**O teste de maior valor da fatia não é de RLS nem de tela.** A imunidade das quatro colunas curadas ao importador é **incidental**: vem de `applyProducts` fazer um UPDATE parcial com as chaves que `readSkuUpsert` devolve. Basta alguém acrescentar um campo a `SkuUpsert` para a curadoria começar a ser apagada a cada planilha, **em silêncio** — o import fica verde e a decisão humana some. Por isso o teste congela `Object.keys(readSkuUpsert(...))` na lista exata de 20 chaves e afirma que nenhuma das sete colunas curadas está lá.

**Sobre `packages/db/src/types.ts`:** `docs/API.md` secao 7 exige tipos **gerados**, e desta vez foi possível — o gerador do MCP produziu o arquivo inteiro, o que de quebra corrigiu uma defasagem que a manutenção manual tinha deixado passar (`order_items_sku_listing_link_id_fkey` ainda estava lá, e D-125 removeu essa FK). Duas correções manuais foram **reaplicadas sobre o gerado, com o motivo escrito no próprio arquivo**: o gerador nunca marca argumento de RPC como nulo, e `create_sku_listing_link.p_variation_id` e `set_skus_supplier_brand.p_supplier_brand` aceitam `null` de verdade — no segundo caso, `null` é justamente o valor que LIMPA a marca.

**Escopo recusado, com gatilho declarado:**

- **"Selecionar todos os N do filtro"** e seleção atravessando páginas. É onde o desenho encostaria em "aplicar às cegas": o operador confirmaria uma *contagem*, não as linhas, e D-127 escreve que a sugestão é confirmada por gente, nunca aplicada sozinha. Gatilho para reabrir: medição de que as rodadas de 100 doem de verdade — e a primeira resposta seria aumentar `PAGE_SIZE`, nunca trocar ids por filtro na escrita (viraria TOCTOU).
- **Evento append-only por SKU, tabela de lote, `domain_events`.** Motivo medido, não preferência: `apps/web/app/skus/[skuId]/actions.ts` lê `domain_events` por `entity_type='sku'` e entrega ao diagnóstico como **causas candidatas** — 500 eventos de configuração virariam 500 causas falsas. A data da decisão na própria linha já responde "quando" e "quem".
- **Índice novo, `skus.supplier_id`, Filtros Salvos em `/produtos`** (custa três linhas e funciona porque o filtro está na URL; entra quando o operador salvar a mesma combinação duas vezes), **edição de qualquer outro campo do SKU** (as outras 20 colunas morrem no próximo import), **job de re-derivação de `supplier_brand`**.
- **Semear, backfillar ou aplicar a sugestão sozinha**: recusado por decisão já registrada (D-127, D-129). Só o usuário reabre.

**Duas perguntas que o painel deixou para o usuário, e o que fiz com elas:**

1. *Quem faz a curadoria — só ADMIN/GESTOR, ou também OPERADOR?* Fiquei em **ADMIN/GESTOR**, herdando a policy de `erp_stock_snapshots`, porque é o que a fonte já exigia e ampliar seria conceder acesso novo sem pedido. Abrir para OPERADOR é uma linha na guarda, se for o caso.
2. *A marcação vai reduzir os `stock.balance.diverged` diários?* **Não, e a pergunta ficou obsoleta durante esta mesma sessão**: nenhum job lê `stock_is_virtual`, então marcar não silencia nada — mas **D-132 já resolveu o ruído por outro caminho**, tornando a reconciliação idempotente entre dias. Sem divergência real, nenhum evento é emitido.

**Impacto:** migrations `20260828210048` (quatro colunas, três CHECKs, comentários) e `20260828215404` (um helper `private` + quatro RPCs, sem tabela nova, sem índice, **sem semear uma linha**), `apps/web/app/produtos/{page,curation-table,actions}.tsx`, `apps/web/lib/sku-curation.{ts,test.ts}` (16 testes), `apps/web/components/shell.tsx` (nav + o JSDoc que declarava "Produtos" ausente de propósito, atualizado na mesma edição), `apps/web/app/cobertura/page.tsx` (link de ida), `packages/domain/src/upseller/apply.test.ts` (a trava), `packages/db/src/rls.integration.test.ts` (13 testes novos), `packages/db/src/types.ts` (gerado), `docs/METRICS.md`. `check` **29/29** e `next build` limpo. **A suíte de integração não rodou aqui** (Docker não sobe nesta máquina) e **a tela não foi vista no navegador** (sem `.env.local` o dev server não alcança o Supabase) — o ensaio operacional que o painel exige (marcar 5 SKUs, conferir em `/cobertura`, só então o lote grande) continua pendente, e o caminho `stock_is_virtual = true` de `get_stock_coverage` **nunca rodou com dado real**.

## D-134 — O banco andou e o código ficou: o descompasso que quebrou a reconciliação, e o reparo que ele acidentalmente preservou

**Contexto:** sessão de 2026-08-29 aberta pelo protocolo de início. A tarefa registrada era o reparo do saldo de estoque que D-131/D-132 deixaram agendado para a rodada de hoje. A primeira verificação — qual código está no ar — encontrou um incidente que ninguém tinha visto.

**O achado: o banco estava 10 commits à frente do código.** Cloud Run servia `fa43fe5` (D-121, publicado em 28/08 18:12Z) enquanto o Supabase já tinha as 79 migrations, incluindo as de D-133. A migration `20260828203624` (D-132) faz `drop function public.compute_erp_snapshot_balances(uuid)` e cria `compute_erp_target_balances(uuid)`; o worker no ar ainda chamava o nome antigo. Resultado, medido no Cloud Logging:

```
09:00:02Z  job_type=maintenance.reconcile-balances  message=job_failed
reason=Could not find the function public.compute_erp_snapshot_balances(p_organization_id)
```

Três tentativas (09:00:02, 09:01:02, 09:03:03) — a fila `maintenance` tem `maxAttempts: 3`. A task esgotou e saiu. **A reconciliação não rodou em 2026-08-29 pela manhã.**

🟢 **E a falha SALVOU o reparo, por acidente.** D-131 registrou que uma rodada em 28/08 seria inútil porque as chaves `reconciliacao:2026-08-28:*` já tinham sido consumidas e `recordStockMovements` usa `ignoreDuplicates: true` — pularia os SKUs em silêncio *reportando sucesso*. Como o job de hoje morreu **antes de escrever**, as chaves `reconciliacao:2026-08-29:*` continuaram livres. O descompasso que quebrou o job é o mesmo que preservou a janela.

**Decisão 1 — deploy antes de qualquer disparo, e a ordem não é negociável.** Disparar o job sem publicar o worker novo produziria a quarta falha idêntica. Publicados `worker-00042-tlc` e `api-00028-d4x`, ambos na imagem `6982c33` (sem sufixo `-dirty`), ordem worker→api imposta pelo próprio script. `apps/api` **não tinha nenhuma mudança direta** desde `fa43fe5` — foi publicada mesmo assim porque depende de `@sb/domain`/`@sb/db`, que mudaram, e porque uma tag única por serviço é o que torna "qual código está no ar" respondível sem adivinhação.

**Decisão 2 — o disparo manual foi autorizado explicitamente pelo usuário**, seguindo o precedente de D-065/D-081: a convenção durável de 2026-08-27 cobre *deploy*, não escrita em massa de dado. O usuário pediu o disparo de hoje aceitando de antemão o risco de dedupe. **A ressalva não se materializou**: `balance_reconcile_schedule_triggered` com `enqueued: 1, deduplicated: 0` — a task falha das 09:03 estava a ~11h, fora da janela de dedupe.

**A execução, lida e não presumida** (`balances_reconciled`, 20:51:01Z). Os quatro números que provam a correção de paginação de D-131:

| Campo | Antes (D-131) | Nesta execução |
|---|---|---|
| `snapshot_rows` | 1.000 de 6.744 | **6.744** |
| `ledger_rows` | 1.000 de 2.524 | **2.529** |
| `skus_compared` | 1.000 | **3.372** |
| `adjustments` | — | **3.300** |

**O efeito no dado:**

- **LOCAL**: 3.172 linhas, **191 negativas** contra as **1.627** que D-131 mediu; mínimo subiu de **−4.632 para −160**. É a correção do dano dominante que D-131 identificou (65% errado para baixo, por falta de semeadura).
- **RESERVADO**: de **zero linhas** — nunca reconciliado uma única vez na história do projeto, porque o `union all` truncava antes da primeira linha — para **exatamente 300**, o número de linhas com `reservado ≠ 0` que D-131 previu. Fecha o item da Fase 4 que estava `[~]`.
- **Integridade**: projeção contra soma do ledger dá **zero divergências em 3.472 chaves**, sem órfãos nos dois sentidos.

🔴 **Consequência que precisa ficar registrada: o reparo gerou uma avalanche de notificações.** A reconciliação emite um `stock.balance.diverged` por ajuste, então 3.300 ajustes viraram **3.300 eventos e 3.308 notificações não lidas numa única hora**. O total não lido subiu para **6.410**. Não é defeito novo — é o item "Ruído antes da inteligência" da Fase 6B (`stock.balance.diverged` já era 55,1% de todas as notificações) encontrando um reparo em massa. **Mas ele deixou de ser teórico**: a Central de Notificações está inutilizável até que a agregação da 6B seja feita, e isso passa a ser pré-requisito prático, não backlog.

**Expectativa declarada, a conferir amanhã e não afirmada aqui:** como D-132 tornou o job idempotente entre dias, a rodada de 2026-08-30 às 09:00Z deveria produzir ~0 ajustes e ~0 eventos. Se produzir milhares de novo, a idempotência de D-132 não está funcionando como projetado — e este parágrafo é o critério.

**Achado colateral, sobre a própria esteira:** `pnpm run check` falhou na primeira rodada com **130 erros em `@sb/api#lint`** (`no-unsafe-member-access` em `request.tool`, "type cannot be resolved"), e passou 29/29 na segunda. `pnpm run lint` isolado em `apps/api` passa com exit 0. É corrida de cache frio do Turborepo: o lint tipado lê os `.d.ts` das dependências enquanto ainda estão sendo gerados. **Não é defeito de código, é uma fonte de CI falsamente vermelha** — mesma classe de armadilha que D-130 documentou ao provar que "check 29/29" não era prova de nada. Quem vir `@sb/api#lint` vermelho deve rodar de novo antes de investigar.

**Observação não diagnosticada, deixada aberta de propósito:** 16 ocorrências de `sync.webhook.received` com `resposta fora do contrato esperado: Invalid input: expected array, received null` no path `["orders"]`, todas na revisão `worker-00041-x4q` numa janela de 6 minutos em 28/08 (provavelmente retries da mesma notificação). Mesma classe de D-101/D-103. Não foi investigada nesta sessão e não reapareceu na revisão nova no intervalo observado.

**Impacto:** nenhuma migration, nenhuma linha de código de produto. Revisões `worker-00042-tlc`/`api-00028-d4x` (tag `6982c33`); 3.300 movimentos de ajuste e 300 linhas RESERVADO criados no Supabase Dev; `docs/HANDOFF.md` atualizado, inclusive a seção "Próxima etapa registrada", que estava congelada na Fase 7B enquanto a 7B já tinha sido fechada por D-116.

## D-135 — `stock.balance.diverged` significava duas coisas opostas, e a severidade mentia para uma delas

**Contexto:** a tarefa registrada era "agregar ou silenciar `stock.balance.diverged`" (Fase 6B), escrita em 2026-08-28 sobre uma dor medida de ~2.040 eventos críticos/dia e 55,1% de todas as notificações. **A medição feita antes de construir mostrou que o item descrevia um problema que tinha acabado de deixar de existir.**

**O que a medição achou.** Os 13.891 eventos de 7 dias vinham de duas origens distinguíveis pelo prefixo do `dedup_key`:

| Origem | Volume/dia | O que era |
|---|---|---|
| `integridade-ledger` | ~1.366 | **100% falsos** — o próprio vigia truncava em 1.000 linhas e "achava" divergência onde não havia (D-131) |
| `reconciliacao` | ~657 | alvo congelado desfazia a venda de cada dia (D-132) |

As duas causas-raiz já estavam corrigidas no repositório e entraram em produção com o deploy de D-134. **Prova direta, medida em 2026-08-29 disparando o vigia com o worker novo:** `rows_compared: 3472, divergences: 0`, contra `rows_compared: 1683, divergences: 1366` na última rodada da versão truncada, no mesmo dia. **Zero eventos gravados.**

**Decisão 1 — NÃO construir a camada de agregação.** Ela resolveria uma dor que a fonte já tinha eliminado, reprovando no teste 1 do `docs/ARCHITECTURE.md` §1 ("só entra infraestrutura que resolve um problema medido, não um problema imaginado"). O item da Fase 6B dizia "agregar **ou silenciar**"; silenciar aconteceu, de graça, ao consertar o bug.

**Decisão 2 — separar o que sobrou, porque o defeito real era de SIGNIFICADO, não de volume.** O mesmo `event_type` carregava dois fatos opostos, e o próprio código do domínio já admitia isso em comentário: na reconciliação contra o UpSeller *"a divergência é ESPERADA (o ERP externo diverge por processo humano)"*; no vigia *"as duas fontes são internas e não deveriam DIVERGIR NUNCA, por construção. Uma divergência aqui é bug"*. **As duas eram `critico`.** É o padrão de D-133 outra vez: um valor significando duas coisas ao mesmo tempo.

- `stock.balance.adjusted` (**informativo**) — reconciliação contra o UpSeller. **O nome descreve o que aconteceu**: o ajuste sai na MESMA estrutura de retorno que o evento, então quando ele existe o saldo **já foi corrigido**. Alarmar sobre um problema que a própria linha resolveu é o oposto de informar.
- `stock.balance.diverged` (**critico**) — vigia de integridade, e só ele. Aqui o job **só detecta, nunca corrige**, e o nível volta a significar alguma coisa: hoje este caminho emite zero.

**Decisão 3 — `dedup_key` inalterado e ZERO backfill.** As 6.201 linhas históricas de reconciliação continuam com o nome antigo. `domain_events` é append-only (L2, `docs/ARCHITECTURE.md` §9); reescrever história para uniformizar nomenclatura seria pior que conviver com dois nomes, e o prefixo do `dedup_key` já separa as origens em qualquer consulta. O catálogo em `docs/API.md` diz isso explicitamente para quem for ler dado antigo.

**Decisão 4 — nenhuma migration.** Medido antes de assumir: `domain_events_event_type_check` é só `char_length` entre 1 e 100, não um enum. O catálogo é imposto em `@sb/domain/events`, como `docs/API.md` §4 já declarava ("a severidade final é calculada por regra versionada, não fixada na interface"). Tipo novo é mudança de código, não de schema.

**A trava, e ela foi verificada FALHANDO.** Os dois caminhos nasceram com o mesmo tipo e a mesma severidade; reunificá-los por descuido — um `EVENT_SEVERITY` copiado, um find-and-replace — devolveria o problema **em silêncio**, porque nada quebra: o evento continua gravando. O teste novo afirma que a reconciliação nunca emite `diverged` e nunca sobe de `informativo`. Revertendo `reconciliation.ts` à mão, **2 testes falham**; restaurado, 10/10. Um teste que não sabe falhar não vale nada — foi exatamente o achado de D-118.

**Limpeza do backlog, e por que ela NÃO foi "marcar todas como lidas".** Havia 6.851 não lidas. A composição desmentia a premissa:

- **4.666 eram ruído provado** e foram marcadas como lidas: 1.366 de `integridade-ledger` (falsos, provados duas vezes) e 3.300 de `reconciliacao` (o próprio reparo de D-134);
- **2.185 ficaram de propósito**, entre elas 34 `stock.depleted` críticos, 109 cancelamentos, 77 devoluções e 28 mediações — **sinal operacional real dos últimos dois dias**. "Marcar todas como lidas", que é o que a interface oferece (D-074), teria enterrado isso junto.

Operação direta em `notification_recipients.read_at` via `service_role`, não migration: é dado, não estrutura (mesmo precedente do reparo direto de 9 linhas em D-097).

🔴 **O que a limpeza revelou, e vira a próxima pergunta:** com `stock.balance.diverged` fora, **`listing.available_quantity.changed` passa a ser a maior fonte de entulho da Central — 1.790 não lidas, 6.540 eventos em 7 dias (27,9% de todos)**. Ele é `informativo`, mas **o fan-out é incondicional** e a preferência do usuário não o filtra (D-076 deixou a preferência só no toast, de propósito). Nada de D-134/D-135 tocou nisso. **É aqui que a agregação da Fase 6B cabe de verdade, se couber** — e o alvo mudou de lugar em relação ao que o roadmap descrevia. Não decidido nesta sessão: é sinal legítimo, não falso, e silenciá-lo é escolha de produto do usuário.

**Impacto:** sem migration. `packages/domain/src/events/catalog.ts`, `packages/domain/src/inventory/reconciliation.ts`, `packages/domain/src/diagnostics/sales-anomaly.ts`, `packages/domain/src/inventory/reconciliation.test.ts` (+1 trava), `apps/worker/src/handlers/reconcile-balances.test.ts`, `apps/web/lib/labels.ts`, `docs/API.md` (catálogo de eventos e a linha do job — que ainda citava `compute_erp_snapshot_balances`, nome morto desde D-132 e causa da falha de D-134). `check` **29/29**. **Deployado e verificado**: `worker-00043-bkp` (imagem `06d7489`), boot com `worker_started` e zero ERROR — a rodada de 2026-08-30 às 09:00Z já emite `stock.balance.adjusted`.

## D-136 — Métrica trocável no gráfico de vendas: a Fase 5C começa pelo dado que já viajava e era descartado

**Contexto:** primeira fatia da Fase 5C, escolhida por ser a que o ROADMAP marcava como mais barata — *"a RPC já devolve as quatro e a tela plota uma: é interface, não banco"*. **Premissa conferida antes de escrever, não assumida**: `get_sales_daily_series` (`20260821210000`) devolve `units_sold`, `gross_revenue`, `orders_count` e `purchases_count` desde 2026-08-21, e `page.tsx` não restringe colunas. As quatro cruzavam a rede todo dia e três eram jogadas fora no cliente.

**Decisão 1 — a métrica mora na URL, e a tela continua Server Component.** `?metric=`, resolvido no servidor, sem `use client`, sem estado. Segue o que a tela já fazia com `days`/`from`/`to`/`account` e o que D-133 fez em `/produtos`. Ganha o que URL dá de graça: link compartilhável, voltar do navegador, e compatibilidade com os Filtros Salvos, que o `docs/PRODUCT_REQUIREMENTS.md` pede e cujo mecanismo é agnóstico de tela.

**Decisão 2 — o default fica FORA da URL.** `/vendas` limpo continua idêntico ao de ontem. Uma URL sem `?metric=` tem de mostrar exatamente o gráfico que mostrava antes desta fatia: mudar isso quebraria links salvos e a memória de quem abre a tela todo dia. Há teste para essa invariante especificamente.

**Decisão 3 — `DEFAULT_SALES_METRIC` aponta para uma constante NOMEADA, não para `SALES_METRICS[0]`.** O lint pediu `!` no lugar do `as`; a resposta certa não era nenhum dos dois. Indexar a posição 0 significa que reordenar o array — coisa que alguém fará um dia só para mudar a ordem dos botões — trocaria em silêncio qual gráfico a tela abre por padrão. Com a constante, a ordem visual e o default ficam independentes.

**Decisão 4 — cada métrica carrega o ID da definição canônica.** `receita_bruta`, `unidades_vendidas`, `pedidos`, `pedidos_por_pack`, todos de `docs/METRICS.md` 5.2, aprovados em 2026-08-21. **Nenhuma métrica nova foi inventada** — a coluna da RPC é a implementação da definição que já existia. Um teste falha se alguém acrescentar uma quinta entrada com ID fora do catálogo, que é como `docs/ARCHITECTURE.md` §15 ("todo número na tela carrega o ID da sua definição") deixa de ser boa intenção.

**Dois defeitos encontrados ao implementar, ambos do tipo que não quebra nada:**

- **O `<form method="get">` do período personalizado teria descartado a métrica.** Um GET nativo envia só os campos do formulário, e o `account` já tinha `input hidden` por exatamente esse motivo. Sem o hidden da métrica, escolher um intervalo de datas devolveria o gráfico a faturamento sozinho — o mesmo defeito que o comentário de `buildHref` já descrevia ("trocar de conta não pode resetar o período"), na terceira dimensão.
- **Rótulo fracionário em eixo de contagem.** As linhas de grade são `chartMax × 0,5`; com faturamento isso é natural, com unidades produz "27,5 unidades". Arredondado **só o rótulo** — a posição `y` continua no valor exato, senão a linha sairia do lugar.

**Cuidado explícito com formatação:** contagem nunca passa por `formatCurrency`. "R$ 12" numa série de unidades vendidas seria um número errado com aparência de certo — a classe de defeito que D-131 perseguiu.

⚠️ **Limitação honesta de verificação:** `check` **29/29** (6 testes novos) e `next build` compila `/vendas`. **A tela NÃO foi vista renderizada** — o dev server sobe e alcança o Supabase (verificado nesta sessão, o bloqueio de D-133 acabou), mas `/vendas` exige sessão e não há credencial de usuário nesta sessão; entrar credencial é ação vedada ao agente. Mesma limitação registrada em D-074/D-075. O que ficou provado sem sessão: o middleware preserva a query no `next=` (`/login?next=%2Fvendas%3Fmetric%3Dunidades%26days%3D30`), então o link sobrevive ao login.

**Escopo recusado:** comparação com período anterior NO GRÁFICO (o `docs/PRODUCT_REQUIREMENTS.md` pede, e ela já existe nos cards) — é a fatia seguinte e tem decisão própria de desenho, porque duas séries no mesmo SVG exigem escala, legenda e cor, e nenhuma delas está resolvida hoje.

**Impacto:** sem migration, sem RPC nova, sem consulta nova. `apps/web/lib/sales-metric.{ts,test.ts}` (novo, 6 testes), `apps/web/app/vendas/sales-chart.tsx`, `apps/web/app/vendas/page.tsx`, `docs/ROADMAP.md`. Deploy automático pela Vercel — não exige Cloud Run.

## D-137 — Comparação de período no gráfico, e o alinhamento por índice que estava certo por sorte

**Contexto:** fatia declarada como "seguinte" em D-136 e adiada de propósito, porque duas séries no mesmo SVG exigem três decisões que não estavam tomadas — escala, alinhamento e cor/legenda. Requisito de `docs/PRODUCT_REQUIREMENTS.md`: *"a comparação com período anterior existe nos cards e deve alcançar o gráfico"*.

**Decisão 1 — escala COMPARTILHADA, um eixo Y só.** As duas séries são a mesma métrica na mesma unidade; dois eixos seriam mentira visual. `chartMax` passa a considerar as duas: usar só o máximo do período atual faria a linha anterior sair do quadro exatamente quando o período passado tivesse vendido mais — o caso que a comparação existe para mostrar.

🔴 **Decisão 2 — o eixo X deixa de ser índice do array e passa a ser OFFSET DE DIA. É o achado da fatia.**

A primeira versão espaçava por índice, com um argumento que era bom para uma série só: dias sem linha em `daily_account_metrics` ficam AUSENTES (a RPC não fabrica zero), e espaçar por calendário exageraria a lacuna.

**Com duas séries esse desenho passa a mentir.** Índice não significa a mesma coisa nas duas janelas: se a atual tem 28 dias com métrica e a anterior tem 30, o índice 5 de uma é um dia relativo DIFERENTE do índice 5 da outra — e o gráfico afirmaria "este dia contra o mesmo dia do período anterior" sobre dois dias que não se correspondem.

**Medido antes de decidir:** hoje as duas janelas estão completas (**30/30 dias cada, zero ausentes**), então o alinhamento por índice funcionaria — **por sorte**. É a classe de defeito que este projeto persegue desde D-131: correto agora, silenciosamente errado no primeiro dia em que uma janela tiver lacuna e a outra não. E não é hipótese remota: a própria tela já exibe *"Só N dias têm métrica calculada"* quando a série vem incompleta, ou seja, o estado é previsto e tratado em outro lugar do mesmo arquivo.

O offset é bem definido porque `previousBusinessDateRange` devolve janela do MESMO comprimento por construção — `0..length-1` mapeia 1:1.

**Decisão 3 — cor, ordem de pintura e legenda condicional.** Período anterior em `--sb-muted`, tracejado, mais fino, e **desenhado ANTES no DOM**: em SVG a ordem é a ordem de pintura, então desenhar depois colocaria a referência por cima da linha que interessa. A legenda só é renderizada quando existe série anterior — anunciar uma linha tracejada que não foi desenhada faria a tela descrever algo que não está lá.

**Decisão 4 — a dica de cada ponto carrega os dois valores**, e "sem dado" quando o dia não existe do outro lado. `undefined`, nunca 0: "sem dado" e "vendeu zero" são afirmações diferentes sobre o negócio, e a RPC não fabrica zero.

**Dois defeitos meus, achados e corrigidos durante a implementação:**

- **A quarta consulta ficou de fora da agregação de erro, e esse era o pior lugar possível.** O bloco tem comentário explícito de D-067 ("falha em QUALQUER uma das três: mostrar erro, nunca 'sem dado'"). Sem a quarta ali, falhar a consulta da série anterior produziria um gráfico **sem a linha de comparação** — visualmente idêntico a "o período anterior não teve venda", que é uma afirmação sobre o negócio, não sobre a rede. Exatamente a classe que D-067 existe para impedir.
- **A legenda rotulava o fim da janela anterior com a data do ÚLTIMO PONTO COM DADO.** Se o último dia não tiver métrica, a legenda encolheria a janela e o usuário compararia 30 dias contra o que a tela chamaria de 28. Passou a usar a janela real.

**A trava foi verificada FALHANDO.** `offsetInPeriod`/`indexByOffset` foram extraídos para `apps/web/lib/series-alignment.ts` — em `lib/` e não dentro do componente para serem testáveis sem React, mesma razão de `sales-metric.ts` (D-136) e `sku-curation.ts` (D-133). O teste central monta o cenário assimétrico (janela atual com um dia ausente no meio, anterior completa) e prova que o dia 4 encontra o dia 4, não "o quarto item da lista". Trocando `indexByOffset` para indexar por posição de array, **ele falha**; restaurado, 5/5. Sem isso o teste seria decorativo: o defeito que ele impede é **invisível na tela** — as duas linhas continuariam bonitas.

**Nenhuma consulta nova de banco.** A quarta chamada reusa `get_sales_daily_series` com a outra janela, em PARALELO (`docs/ARCHITECTURE.md` §21: "consultas independentes em paralelo, nunca em cascata"). Sem migration, sem RPC nova.

⚠️ **Mesma limitação de verificação de D-136:** `check` **29/29** (107 testes em `@sb/web`, +5) e `next build` compila `/vendas`. **A tela não foi vista renderizada** — exige sessão e entrar credencial é ação vedada ao agente.

**Impacto:** `apps/web/lib/series-alignment.{ts,test.ts}` (novo), `apps/web/app/vendas/sales-chart.tsx` (reescrito), `apps/web/app/vendas/page.tsx`, `docs/ROADMAP.md`. Deploy automático pela Vercel.

## D-138 - Dashboard de Anuncios, e a SEXTA ocorrencia do truncamento de 1.000 linhas

**Contexto:** item da Fase 5C (*"Anuncios como dashboard: colunas e filtros completos, incluindo anuncio SEM vinculo e filtro por conta"*). A primeira leitura do codigo encontrou outra coisa antes.

- **A tela mostrava 1.000 de 5.085 anuncios, em silencio.** `page.tsx` lia `from("listings").select(...).order("title")` **sem `.range()`**, contra o teto `max_rows = 1000` de `supabase/config.toml`. O PostgREST corta a resposta e devolve `error` NULO. Como ordenava por titulo, o que sobrevivia era "os 1.000 primeiros no alfabeto" - criterio de nada.

**E a SEXTA ocorrencia da classe de D-131, e a primeira encontrada depois dela.** O defeito nasceu com D-121: enquanto `listings` era enumerada por `sku_listing_links` a tabela cabia no teto; ao passar a conter o catalogo REAL do vendedor ela cresceu para 5.085 e a leitura sem paginacao virou truncamento. D-131 corrigiu cinco pontos no mesmo dia e nao alcancou este - a busca de entao mirou o worker e as duas telas de estoque.

**Decisao 1 - o precedente seguido e o de `/estoque` (D-131), NAO o `readAllPages` do worker.** Numa tela, trazer 5.085 linhas para o navegador a fim de mostrar 50 e desperdicio. O pivo, os filtros, a ordenacao e a **contagem** passam para o Postgres (`get_listings_dashboard`), e a pagina le uma janela declarada.

**Decisao 2 - `total_count` e o ponto inteiro da funcao.** Sem ele a tela nao tem como distinguir "estes sao todos os anuncios" de "estes sao os primeiros N" - exatamente a ambiguidade que deixou o truncamento invisivel. A tela agora diz sempre *"Mostrando 1 a 50 de 5.085"*, e um teste fixa essa frase.

**Decisao 3 - `p_link_state` nao e `sku_id is null`.** D-122 mediu que 1.013 dos 1.917 anuncios com `sku_id` nulo tem vinculo POR VARIACAO; sem vinculo nenhum sao 904. A tela antiga mostrava "-" nos dois casos, **dobrando o tamanho aparente da fila de trabalho**. Agora "por variacao" (apagado, nao e pendencia) e "sem vinculo" (alerta) sao rotulos distintos, com teste afirmando que diferem.

**Decisao 4 - ordenacao deterministica e COMPLETA** (`gross_revenue desc, title asc, item_id asc`). Sem o terceiro criterio, duas paginas consecutivas poderiam repetir ou pular linhas - o modo mais silencioso de uma tabela paginada mentir.

**O `EXPLAIN` REPROVOU a minha primeira versao, e e o melhor argumento a favor da regra do §21:**

- duas varreduras de `daily_listing_metrics` (venda e pedidos) com o mesmo `group by` e a mesma janela - unificadas numa CTE;
- e o defeito caro: `exists (select 1 from sku_listing_links ...)` **correlacionado**. Fora da funcao ele engana, porque so roda para as linhas que sobrevivem ao `limit`; dentro, o filtro `p_link_state` obriga a avalia-lo para **todas as 5.085 linhas**, cada uma varrendo as 20.650 de `sku_listing_links`. Trocado por `left join` contra um conjunto `distinct`: **1.123 ms -> 137 ms**, medido no filtro mais pesado.

Tambem errei o metodo de medicao no caminho: o primeiro `EXPLAIN` inline deu 29 ms, mas eu tinha selecionado so `id` e o Postgres **eliminou os joins e o `exists`** que eu queria medir. Numero de outra consulta. Refeito com todas as colunas.

**Nenhum indice novo** - o plano usa `daily_listing_metrics_account_date_idx` e resolve o resto em hash join sobre tabelas pequenas. `docs/DATABASE.md` §6 exige EXPLAIN antes de criar indice; ele nao pediu nenhum.

**Contagens conferidas contra D-122**, que e quem estabeleceu a semantica: 5.085 no total, 4.181 vinculados (3.168 diretos + 1.013 por variacao), **904 sem vinculo**, 654 destes ativos. Os mesmos numeros.

**Achado de processo, e ele quase quebrou a CI:** o `apply_migration` do MCP gera o PROPRIO timestamp de versao (`20260829220548`), diferente do nome que eu tinha dado ao arquivo (`20260829215000`). A CI veria o arquivo como nao aplicado, tentaria roda-lo e falharia com *"function already exists"*. Arquivo renomeado para a versao real. **Quem aplicar migration por MCP precisa conferir `supabase_migrations.schema_migrations` depois** - o nome do arquivo nao e a fonte da verdade nesse caminho.

- **Divida declarada: `packages/db/src/types.ts` foi editado A MAO.** `docs/API.md` §7 exige tipos gerados, e nesta sessao nao havia `SUPABASE_ACCESS_TOKEN` nem Docker - nem o gerador do CLI (`--project-id`, caminho de D-073) nem o local rodaram. O bloco foi escrito a partir da assinatura real da migration, com o motivo no proprio arquivo, e **deve ser substituido pelo gerado na proxima sessao com token**.

- **A tela nao foi vista renderizada** - exige sessao, e entrar credencial e acao vedada ao agente. `check` **29/29** (118 testes em `@sb/web`, +11), `next build` compila `/anuncios`, e as quatro combinacoes de filtro foram conferidas contra o banco real.

**Escopo recusado, com gatilho:** filtros de Full, com/sem estoque e com/sem venda (o PRD os pede) - Full depende de `fulfillment_stock_snapshots.sku_id` ser NOT NULL, que D-123 ja registrou como decisao pendente sobre o significado do snapshot; os outros dois entram quando alguem pedir, e custam uma clausula cada.

**Impacto:** migration `20260829220548`, `apps/web/app/anuncios/page.tsx` (reescrita), `apps/web/lib/listings-dashboard.{ts,test.ts}` (novo, 11 testes), `packages/db/src/types.ts`, `docs/ROADMAP.md`. Deploy automatico pela Vercel.

## D-139 - Estoque enriquecido, e a segunda coluna fiscal que mente sobre a rota de compra

**Contexto:** item da Fase 5C. `/estoque` mostrava quatro colunas (SKU, Local, Reservado, Transito) enquanto marca, categoria, custo, Full e datas ja existiam no banco e nenhuma tela as lia - era literalmente o que o `docs/PRODUCT_REQUIREMENTS.md` apontava.

**Decisao 1 - as colunas foram escolhidas POR PREENCHIMENTO MEDIDO**, porque coluna quase vazia e ruido: `category_raw` 95,7%, `purchase_cost` 94,9%, `brand` 82,9% (entra como CATEGORIA, nunca como marca - D-129), `supplier_brand` 36,0% (entra: e a marca REAL, e o vazio e deliberado, esperando preenchimento humano em `/produtos`).

**Decisao 2 - NAO existe coluna Origem, e este e o achado da fatia.** `is_imported` diz que **187 dos 228 SKUs NAVETEC sao nacionais**, contra a regra de negocio que o usuario estabeleceu. E a SEGUNDA coluna fiscal a contradizer a rota de compra: D-129 ja tinha vetado `origin_code` por 707 SKUs, e a causa e a mesma - as duas carregam a origem preenchida por quem EMITE a nota, nao por quem COMPRA. O `docs/PRODUCT_REQUIREMENTS.md` ja avisava ("nem confianca cega em `is_imported`"); agora esta medido. Mostrar "Nacional" para Navetec seria a tela afirmando com confianca algo falso.

**Decisao 3 - Valor de estoque continua FORA, e a razao mudou de lugar.** `docs/METRICS.md` 5C.4 o bloqueava "ate a questao do estoque sentinela ser resolvida". A questao FOI resolvida (D-127) e a ferramenta existe (D-133), mas medido hoje: **1.089 SKUs carregam a assinatura sentinela e ZERO estao classificados**. O bloqueio saiu de "pergunta aberta" e virou "classificacao nao feita" - quem destrava e o ensaio de `/produtos`, que segue pendente.

**O EXPLAIN reprovou DUAS versoes, e a segunda reprovacao nao era da consulta:**

- **1a: 1.646 ms, 132.368 buffers.** `distinct on` sobre `fulfillment_stock_snapshots` varria as 60.086 linhas historicas. Medido que `captured_at` e carimbo POR RODADA do job (130 carimbos, ~462 linhas cada), nao por item - entao basta juntar com o `max(captured_at)` de cada conta e ler ~1.848 linhas. Resultado: 1.024 ms, 79.436 buffers.
- **2a: o custo restante era `max(occurred_at)` sobre `stock_movements`** - 70.732 buffers, 224 mil linhas varridas, `Heap Fetches: 69872` num index-only scan. **A causa nao era a consulta: era o reparo em massa de D-134**, que inseriu 6.672 movimentos e deixou o mapa de visibilidade defasado. `vacuum (analyze)` levou a **11.052 buffers, 132 ms quente**.

**LICAO OPERACIONAL, e ela vale alem desta tela:** reparo em massa no ledger deve ser seguido de `VACUUM ANALYZE`. Sem isso, toda consulta que agrega `stock_movements` paga ~6x em buffers, silenciosamente, e o custo aparece como "a tela esta lenta" em vez de "o mapa de visibilidade esta velho".

**Decisao 4 - "ultimo movimento" usa `occurred_at`, nao `updated_at` da projecao.** Testei a substituicao barata (custo zero, ja estava no join): 3.148 dos 3.174 SKUs concordam no dia, **mas o desvio maximo e de 278 dias** - movimento retroativo (backfill de pedido antigo) tem `occurred_at` velho e `updated_at` recente. Numa tela de estoque o operador quer a data do FATO.

**Substitui a assinatura de D-131 em vez de criar funcao nova:** `/estoque` era o unico chamador, e deixar a antiga viva seria codigo morto.

**Conferido contra o banco real:** 3.174 SKUs no total, **191 negativos** (exatamente o que D-134 deixou), 212 Navetec, 539 com Full na ultima captura.

- **Divida declarada, a mesma de D-138:** `packages/db/src/types.ts` editado a mao, sem `SUPABASE_ACCESS_TOKEN` nem Docker nesta sessao. Substituir pelo gerado na proxima sessao com token.
- **Tela nao vista renderizada** - exige sessao, e entrar credencial e acao vedada ao agente. `check` **29/29** (+13 testes), `next build` compila `/estoque`.

**Impacto:** migration `20260829230010`, `apps/web/app/estoque/page.tsx` (reescrita), `apps/web/lib/stock-filters.{ts,test.ts}` (novo, 13 testes), `packages/db/src/types.ts`, `docs/ROADMAP.md`.

## D-140 - Curva ABC com escopo e criterio, e a SETIMA ocorrencia do truncamento (a primeira que corrompe uma estatistica)

**Contexto:** ultimo item grande da Fase 5C. A curva era global, por faturamento, com janela fixa de 90 dias e nenhum parametro.

**Decisao 1 - o escopo de conta RECALCULA a curva, nao a filtra.** `p_ml_account_id` entra nas DUAS pontas do RPC: no conjunto (quais SKUs) e no denominador (`total`). Filtrar so o conjunto manteria o denominador global e produziria percentuais que nao somam 100 dentro do escopo.

**Verifiquei a medicao que justifica a fatia antes de escrever**, em vez de confiar no numero registrado: o `docs/PRODUCT_REQUIREMENTS.md` media 726 SKUs multi-conta e 450 (62%) mudando de classe em 28/08. Hoje: **743 e 476 (64,1%)**. O fenomeno e estavel e a fatia se justifica.

**Prova de que recalcula em vez de filtrar:** curva global = 1.492 SKUs, 270 na classe A; escopada numa conta = 541 SKUs, 126 na classe A, e **189 deles MUDAM de classe**. Se fosse filtro, a classe seria identica. Trocar o criterio de faturamento para unidades muda outros **312**.

**Decisao 2 - criterio trocavel** entre faturamento, unidades e pedidos, cada um carregando o ID da definicao canonica (`receita_bruta`, `unidades_vendidas`, `pedidos`), como exige `docs/ARCHITECTURE.md` secao 15. Periodos de 30/60/90, com 90 continuando o default -- classificacao ABC precisa de sinal estavel.

**A SETIMA ocorrencia da classe de D-131, e a pior ate agora em natureza:**

A tela chamava a RPC **sem `.range()`** contra o teto `max_rows = 1000`, e a curva devolve **1.492 linhas**. Ate aqui e o padrao ja conhecido. O que muda e o que a tela fazia com o array truncado: **somava as classes A/B/C em JavaScript** e **aplicava o filtro "sem Full" em JavaScript**. Medido:

| | Real | O que a tela exibia |
|---|---|---|
| Classe C | **790** | **298** (62% invisiveis) |
| "Sem Full" | **1.180** | **699** (41% invisiveis) |

Nas seis ocorrencias anteriores o estrago era uma LISTA incompleta. Aqui era uma **estatistica de resumo errada** -- um numero que o operador le como fato consolidado, nao como "os primeiros N". E o filtro "sem Full", cujo proposito inteiro e achar SKUs que dependem so de estoque local, escondia 481 deles.

**Correcao:** filtro e paginacao no Postgres, e as contagens de classe viraram janela sobre o conjunto filtrado INTEIRO (`count(*) filter (...) over ()`), nunca sobre a pagina. Conferido contra medicao direta: 1.492 / A=270 / B=432 / C=790 sem filtro; 1.180 / A=99 / B=317 / C=764 com "sem Full". **Os 99 de classe A sem Full nenhum sao exatamente o que aquele filtro existe para revelar** -- e estavam parcialmente truncados.

**Achado menor, mesma familia:** a URL antiga ligava o filtro pela mera PRESENCA de `semFull`, entao `?semFull=0` LIGAVA o filtro. Agora so `=1` liga, com teste.

**`EXPLAIN (ANALYZE, BUFFERS)`:** 102 ms e 7.871 buffers na curva global inteira. Nenhum indice novo -- o plano nao pediu.

- **Divida declarada, terceira consecutiva (D-138, D-139):** `packages/db/src/types.ts` editado a mao, sem `SUPABASE_ACCESS_TOKEN` nem Docker nesta sessao.
- **Tela nao vista renderizada** -- exige sessao, e entrar credencial e acao vedada ao agente. `check` **29/29** (+13 testes), `next build` compila `/curva-abc`.

**Impacto:** migration `20260829233213`, `apps/web/app/curva-abc/page.tsx` (reescrita), `apps/web/lib/abc-filters.{ts,test.ts}` (novo, 13 testes), `packages/db/src/types.ts`, `docs/ROADMAP.md`.

## D-141 - Filtros padronizados, e a medicao de exposicao do repositorio publico

Duas coisas nesta entrada, porque aconteceram juntas.

### 1. O repositorio virou publico, e a exposicao foi MEDIDA em vez de temida

O usuario tornou o repositorio publico para recuperar os minutos de GitHub Actions (a CI estava parada desde 28/08 por falha de faturamento -- os jobs nem comecavam, mensagem "The job was not started because recent account payments have failed"). Eu tinha levantado risco: `infra/lib.sh` versiona a chave publicavel do Supabase e o ref do projeto.

**Medido depois da decisao, e o resultado desarma o alerta:**

- **nenhuma** tabela de `public` concede SELECT ou INSERT a `anon`;
- **todas** tem RLS habilitada;
- das funcoes executaveis por `anon`, so `get_unlinked_listings` nao era trigger -- e ela e `security invoker`, entao roda com os privilegios (inexistentes) do chamador.

**Abrir o repositorio nao expos dado.** A chave publicavel nao abre nada porque `anon` nao tem privilegio nenhum. Ficou so a inconsistencia: a migration de D-122 esqueceu o `revoke all ... from public, anon` que todas as outras fazem. Fechado -- agora **nenhuma** RPC de negocio e executavel por `anon`. Nao era vulnerabilidade, era superficie desnecessaria, mesmo argumento de D-066.

**Correcao de premissa registrada:** commitar e dar push NUNCA estiveram bloqueados. O faturamento de Actions nao afeta Git. Cinco commits subiram normalmente durante a interrupcao.

### 2. Filtros padronizados (o item da Fase 5C)

**Extraido com dor MEDIDA, nao por antecipacao** (`docs/ARCHITECTURE.md` secao 1):

| Peca | Antes | Depois |
|---|---|---|
| `pillStyle` | 5 copias | 0 |
| `buildHref` com reset de pagina | 3 copias | 0 |
| Calculo de janela paginada | 3 copias | 1 |

A regra de contencao do projeto diz que algo vira peca compartilhada quando aparece o SEGUNDO consumidor; aqui ja eram cinco. Antes desta sessao havia uma copia so -- por isso o item estava parado, e por isso ele so ficou maduro agora.

**Decisao 1 - compartilha-se a MECANICA, nunca o vocabulario.** `lib/filters.ts` tem `resolvePageParam`, `buildFilterHref` e `summarizePagedWindow`. O que NAO entrou: a resolucao dos filtros de cada tela. `marca` so existe em `/estoque`, `criterio` so em `/curva-abc`, `vinculo` so em `/anuncios`. Generalizar isso produziria um resolvedor que aceita qualquer coisa e nao valida nada -- o oposto do que cada `resolve*` faz, que e recusar valor fora da lista fechada.

**Decisao 2 - `tone` no `FilterPill` existe por um caso real.** Das dezoito pilulas, uma divergia: "⏱ Prazo em risco" em `/atendimento` fica VERMELHA quando ativa, porque ali "ligado" significa risco, nao selecao. Apagar essa diferenca na extracao teria trocado um alerta por um filtro comum.

**Decisao 3 - as tres libs delegam mas mantem a API publica**, entao nenhuma tela precisou mudar por causa disso. Os 36 testes existentes de `stock-filters`, `abc-filters` e `listings-dashboard` **passaram sem uma linha alterada** -- e como eles fixam as strings de rotulo, isso e a prova de que o comportamento nao mudou.

**O que a extracao revelou de codigo morto:** `PILL_BASE` orfao em duas telas e `import Link` sem uso em outras duas. Removidos.

`check` **29/29**, 154 testes em `@sb/web` (+11 do nucleo novo), `next build` limpo.

- **Divida declarada, quarta consecutiva** (D-138, D-139, D-140): `packages/db/src/types.ts` segue editado a mao, sem `SUPABASE_ACCESS_TOKEN` nesta sessao.
- **Telas nao vistas renderizadas.** Este e um refactor de aparencia em CINCO telas sem verificacao visual -- o risco mais alto da sessao nesse quesito. O que sustenta: os 36 testes de comportamento intactos, o build, e o fato de o `FilterPill` reproduzir exatamente o mesmo objeto de estilo que estava nas cinco copias.

**Impacto:** `apps/web/lib/filters.{ts,test.ts}` (novo, 11 testes), `apps/web/components/filter-pill.tsx` (novo), `apps/web/lib/{stock-filters,abc-filters,listings-dashboard}.ts`, as cinco telas, migration `20260830002606`.

## D-142 - A CI voltou e cobrou a conta dos 17 commits: quatro defeitos, um deles quebrando /produtos

**Contexto:** o usuario reativou os minutos de Actions tornando o repositorio publico. A primeira execucao completa (CI #256) passou em typecheck/build, e2e e infraestrutura -- e falhou no job de integracao com **8 erros**. Cada um foi triado contra o banco real antes de qualquer correcao. Quatro causas distintas:

**1. `/produtos` ESTAVA QUEBRADA -- `pg_catalog.current_date` nao e SQL valido.** `current_date` e palavra reservada, nao funcao: qualifica-la vira `tabela.coluna` e estoura *"missing FROM-clause entry for table pg_catalog"*. A qualificacao veio de aplicar mecanicamente a regra do `search_path = ''` (que vale para funcoes) a uma palavra reservada, em `get_sku_curation` (D-133). **Nunca falhou antes porque o erro so dispara DEPOIS do guarda de permissao, e a tela nunca foi aberta como ADMIN** -- exatamente a verificacao que D-133 declarou pendente. O ensaio dos 5 SKUs teria morrido no primeiro clique. Corrigido reescrevendo a definicao REAL lida do catalogo (so o trecho trocado), com bloco idempotente na migration para o rebuild da CI. Ocorrencia unica no repositorio, verificada por grep.

**2. `profiles` PERDEU O UPDATE em D-130, e a policy ficou morta.** O comentario da propria migration concluia: *"verdade para UPDATE, e so para ele"* -- e a linha seguinte revogou os tres (`revoke insert, update, delete`). A analise estava certa; o comando nao seguiu a analise. Como o GRANT e avaliado ANTES da RLS, `profiles_update_self` ficou inalcancavel: **"usuario atualiza o proprio perfil" esteve quebrado em producao de 28/08 ate hoje.** Dois dos oito erros eram isto.

**3. `compute_erp_target_balances` concedida a `authenticated` contra o proprio teste de D-132.** O teste da MESMA decisao afirma *"authenticated nao executa -- so service_role, mesmo sendo ADMIN"*; a migration concedeu. O unico chamador e o worker, via service_role. Revogado. Migration e teste da mesma decisao discordavam, e ninguem viu porque a CI estava vermelha desde D-130 por outro motivo.

**4. Dois testes errados, nao dois defeitos de produto:**
- O teste de `get_listing_sales` afirmava 5/500 *"ignorando a linha com variacao"* -- o comportamento que **D-123 removeu de proposito** (R$ 469.593,20 escondidos). Atualizado para 14/1400, com o motivo no comentario.
- O teste do evento CREATED de `create_sku_listing_link` **nasceu falhando e nunca rodou numa CI verde**: chamava a RPC num CTE e lia os eventos NA MESMA instrucao -- o snapshot do SELECT externo nao enxerga linhas inseridas por funcao volatil durante a execucao. Devolvia `[]` com a RPC funcionando (verificado: a definicao insere o evento). O padrao correto ja existia no proprio arquivo (`asUserPersist` + leitura separada). Mesma classe do achado de D-118: teste que nao sabe falhar... ou que nao sabe passar.

**O padrao que une os quatro:** nenhum aparecia no `check` local, porque `packages/db` exclui `*.integration.test.ts` do script `test` POR CONSTRUCAO. "check 29/29" e uma afirmacao sobre tipos, lint e testes de unidade -- nunca sobre RLS, GRANTs ou o guarda. D-130 ja tinha dito isso; D-142 e a segunda demonstracao, com a esteira parada por FATURAMENTO em vez de por defeito.

**Correcao de premissa que ficou desta conversa:** commitar e dar push nunca estiveram bloqueados pelo faturamento -- Actions nao afeta Git.

**O teardown da suite tambem estava quebrado, em TRES camadas -- e cada uma tinha dono e data:**

| Camada | Bloqueio | Quebrada desde |
|---|---|---|
| 1 | `sku_listing_link_events` -> `ml_accounts` (RESTRICT) | D-125, 28/08 |
| 2 | `stock_movements` -> `skus` (RESTRICT) | fluxos de compra/ajuste persistidos |
| 3 | atores dos ledgers -> `profiles` -> `auth.users` | **D-099, 27/08** -- a troca SET NULL -> RESTRICT quebrou a limpeza no MESMO dia em que o guarda de GRANTs deixou a CI vermelha; uma falha escondeu a outra |

A camada 3 foi encontrada pelo CATALOGO (enumerando as FKs RESTRICT reais), nao pagando mais uma rodada de CI. E houve uma correcao de diagnostico no caminho: atribui o erro da camada 1 ao meu proprio teste corrigido com `asUserPersist`; a rodada seguinte devolveu o mesmo erro com o teste ja em rollback -- a fonte era `resolve_link_candidate`, que persiste eventos de proposito desde D-125.

**Decisao de teardown, e ela e assimetrica de proposito:** na camada 1 o trigger append-only foi desligado-e-religado pelo dono da tabela (eventos de teste sao expurgaveis); nas camadas 2 e 3 NAO -- `stock_movements` e o artefato mais protegido do projeto, e teardown de teste nao e lugar para normalizar excecao. Vale o precedente que o proprio arquivo documenta para `organizations`: historico legitimo bloqueia exclusao, apaga-se so o que nada referencia (`not exists` sobre as FKs enumeradas do catalogo), e o residuo local e aceito ate o proximo `supabase db reset`.

**VEREDITO -- CI #260 (`702cad5`), 2026-08-30: os CINCO jobs verdes**, incluindo "aplicar migrations no Supabase Dev". E a primeira esteira completamente verde desde 27/08 -- e a primeira vez NA HISTORIA em que o teste-guarda de GRANTs de D-098 passou na CI (D-130 provou que ele nunca tinha passado desde que nasceu).

**Impacto:** migrations `20260830002606` e `20260830004256`, correcao do ARQUIVO de `20260828215404` (para o rebuild do zero na CI; o Dev remoto e corrigido pelo bloco idempotente), tres correcoes no teardown e dois testes de `packages/db/src/rls.integration.test.ts`. Commits `0d0c96d`, `75e9a88`, `d2bd58f`, `702cad5`.

## D-143 - Saude da sincronizacao por recurso, e os dois problemas de producao que a tela antiga escondia

**Contexto:** ultimo item da Fase 5C. A tela `/sincronizacao` media o frescor de UM recurso (orders, canal de reconciliacao) e contava erros de 24h. O PRD (2026-08-28) pede por conta E por recurso, separando backfill de sincronizacao continua e dado puxado de dado processado. O ROADMAP apontava o ganho barato: `sync_runs.items_processed` e `ml_accounts.backfill_covered_until` "sao gravados e nunca lidos".

**A medicao previa ja pagou a fatia -- dois problemas de producao INVISIVEIS na tela antiga:**

- **`visits`: 123 falhas em 145 execucoes (85%)**, todas 429 do Mercado Livre -- o rate limit conhecido de D-070, agravado pela cobertura maior de D-124 (a varredura e por item, 1 chamada cada). Ha UM sucesso diario, entao o frescor fica "ok" enquanto a cobertura degrada por baixo.
- **`fulfillment`: ZERO `done` em 130 execucoes** -- 111 `partial` (404 de itens mortos derrubam itens individuais) e 19 falhas. Nunca completou uma rodada limpa.

**Corrigir o rate limit e fatia de worker, nao desta tela** -- o que esta fatia entrega e a VISIBILIDADE que faltava para alguem decidir prioriza-la.

**Decisao 1 - o veredito de frescor e CONTRA A CADENCIA de cada job, nao um limiar unico.** `classifySyncFreshness` (`@sb/domain`) tem limiares calibrados para pedidos (horario). Aplica-los a `visits` (diario) carimbaria "atrasada" uma sincronizacao funcionando exatamente como projetada. `classifyResourceFreshness` (novo, `apps/web/lib/sync-health.ts`) compara a idade do ultimo SUCESSO com a cadencia real do job: ate 2 ciclos perdidos = ok, ate 4 = atencao, acima = critico. As cadencias vem de `infra/cloud-scheduler.sh` (fonte apontada no comentario); se um cron mudar la, o pior caso e veredito conservador -- nunca dado inventado. Recurso sem cadencia mapeada NAO ganha veredito ("datas cruas valem mais que selo chutado").

**Decisao 2 - backfill NUNCA ganha selo de frescor.** E processo finito: "nao rodou nas ultimas 24h" e o estado NORMAL de um backfill concluido. A tabela dele mostra o cursor real (`backfill_covered_until`, lido pela primeira vez) e a ultima execucao -- sem porcentagem, porque nao existe denominador confiavel para "quanto falta" (regra do PRD: nunca inventar porcentagem).

**Decisao 3 - falha alta com sucesso recente e ESTADO PROPRIO, nao media.** `failureRateLabel` alerta "17 de 20 execucoes falharam (85%)" mesmo com o veredito "Em dia" -- e exatamente o estado real de `visits`, e uma media dos dois esconderia o problema.

**Decisao 4 - o lado PROCESSADO tem tabela propria** (`get_processing_health`): ate que dia as metricas diarias foram calculadas e quando foi o ultimo recalculo, por conta. O ML pode estar em dia e o recalculo parado -- e onde os gargalos aparecem (PRD).

**RPCs:** `get_sync_health` (por conta x recurso x canal: ultima execucao com status e motivo, ultimo sucesso, ultimo dado, execucoes/falhas/itens de 24h) e `get_processing_health`. `EXPLAIN`: 37 ms, 1.196 buffers, 32 linhas. Nenhum indice novo.

- **Divida declarada, quinta ocorrencia**: `types.ts` a mao (sem token de gerador na sessao).
- **Tela nao vista renderizada** (exige sessao). `check` **29/29** (+10 testes), `next build` compila `/sincronizacao`. As RPCs foram conferidas contra o banco real, incluindo a distincao backfill/reconciliacao com dado de producao.

**FASE 5C COMPLETA** com esta fatia: metrica trocavel (D-136), comparacao no grafico (D-137), anuncios (D-138), estoque (D-139), Curva ABC (D-140), filtros padronizados (D-141) e saude da sincronizacao (D-143). O item de Vendas (taxas ML/margem/cancelamentos) do PRD segue aberto como evolucao -- depende de definicoes de METRICS.md 5C ainda nao implementadas em RPC.

**Impacto:** migration `20260830011456`, `apps/web/app/sincronizacao/page.tsx` (reescrita), `apps/web/lib/sync-health.{ts,test.ts}` (novo, 10 testes), `packages/db/src/types.ts`, `docs/ROADMAP.md`.

## D-144 - Configuracao de reposicao: a fundacao da 5D, e a recusa como contrato

**Contexto:** primeira fatia da Fase 5D. Todos os outros itens da fase (tendencia, sugestao auditavel, estados operacionais, priorizacao) LEEM a configuracao de reposicao -- lead time, cobertura alvo, estoque de seguranca. A nota do proprio ROADMAP orientou o corte: "sugestao de compra sobre SKU nao marcado continua sendo ficcao; a diferenca e que agora o sistema sabe dizer isso" -- o ensaio de `/produtos` pendente nao bloqueia construir a fundacao, bloqueia inventar numero.

**Decisao 1 - tres escopos exclusivos, o mais especifico vence: SKU > marca > padrao da organizacao.** O eixo de marca e `supplier_brand` (D-129: `skus.supplier_id` nao existe de proposito -- `suppliers` tem uma linha, e marca de catalogo nao e entidade de compra). Unicidade por indice parcial em cada escopo (um padrao por org, uma regra por marca, uma por SKU) e CHECK proibindo marca e SKU na mesma linha. Medido antes: 18 marcas, 3.554 SKUs.

**Decisao 2 - ZERO linhas semeadas, e a recusa e o contrato.** Precedente D-127/D-133: configurar e ato humano. O resolvedor (`resolveReplenishmentPolicy`, `@sb/domain/purchasing`) devolve `null` sem configuracao aplicavel, e quem chama RECUSA a sugestao em vez de assumir default. As referencias do PRD (~90 dias de cobertura para importacao, ~15 de lead nacional) aparecem na tela COMO TEXTO -- referencia e o que o ADMIN digita, nunca o que o codigo assume.

**Decisao 3 - SKU sem marca nao casa com configuracao de marca nenhuma.** 64% dos SKUs ainda nao tem `supplier_brand` (vazio de proposito, D-129); deixa-los cair numa marca qualquer aplicaria a politica errada em silencio. Sem marca, so o padrao da organizacao alcanca o SKU. Testado.

**Decisao 4 - a armadilha do PRD virou funcao nomeada.** "Comprar 15 dias de estoque com 15 dias de prazo zera antes da entrega": `demandWindowDays = lead + cobertura + seguranca` -- lead time SOMA, nunca substitui. E a formula que a sugestao de compra vai consumir; pela regra da formula unica, quando ela precisar existir em SQL, a versao SQL sera derivada com teste de equivalencia.

**Decisao 5 - escopo e IDENTIDADE, nao campo editavel.** Editar uma regra muda os tres numeros; mudar a MARCA de uma regra re-atribuiria silenciosamente a politica de outro conjunto de SKUs (mesma regra de identidade fixa de D-076). Apagar e recriar e o caminho para trocar escopo.

**Decisao 6 - `sku_id` e `on delete cascade`, diferente dos ledgers.** Configuracao nao e historia: a regra de um SKU morre com ele. E foi deliberado tambem pelo aprendizado de D-142 -- FK restrict em tabela de teste persistente bloquearia o teardown da suite.

**Decisao 7 - Server Actions com retorno void e erro pela URL** (`?erro=`): `<form action>` de Server Component exige void, e o redirect de sucesso da POST-redirect-GET de graca. Escrita direta sob RLS, sem RPC -- policies espelham `reply_templates` (D-111): leitura para membros, escrita ADMIN/GESTOR.

**Verificacao:** `check` 29/29 (+8 testes de dominio), `next build` compila `/reposicao/configuracoes`, 8 testes de RLS novos na suite de integracao (incluindo o indice parcial do padrao unico e o CHECK de caixa alta). 86 migrations locais == 86 remotas. Tela nao vista renderizada (exige sessao); `types.ts` a mao (6a ocorrencia da divida).

**Escopo recusado, com gatilho:** configuracao por SKU na TELA (a tabela e o resolvedor ja suportam; a UI entra quando o primeiro caso real aparecer -- criar dropdown de 3.554 SKUs antes disso e peso sem uso); "buffer maximo" como campo proprio (o PRD cita, mas sem consumidor definido ainda -- entra com a sugestao de compra se a formula pedir); politica nacional/importado como flag (o eixo E a marca, D-129).

**Impacto:** migration `20260830015215`, `packages/domain/src/purchasing/replenishment-policy.{ts,test.ts}` (novo), `apps/web/app/reposicao/configuracoes/{page,actions}.tsx`, `apps/web/components/shell.tsx` (nav ESTOQUE), `packages/db/src/rls.integration.test.ts` (+8), `packages/db/src/types.ts`, `docs/ROADMAP.md`.

## D-145 - Tendencia deterministica -- e o buraco de recalculo que fazia junho mentir em TODAS as telas

**Contexto:** segunda fatia da Fase 5D ("tendencia por janelas 90/60/30/15, classificando crescendo/estavel/caindo, com formula deterministica e documentada").

**O achado veio ANTES da formula, e era maior que a fatia.** A primeira medicao de limiares deu **86% dos SKUs "crescendo"** -- distribuicao impossivel. Causa: **junho tinha 13 de 30 dias com metrica recomputada** (1.903 unidades) com os PEDIDOS COMPLETOS em `orders` (23.025 pedidos, 30/30 dias). Buraco de RECALCULO, nao de dados -- a janela "anterior" subcontava e tudo parecia crescimento.

**Reparo antes da feature** (Regra de Progressao): `rebuild_daily_sales_metrics` -- idempotente, L3 e 100% recomputavel por desenho -- para as 4 contas, 2026-06-01..2026-08-29, ~1,4s por conta. Resultado medido:

| Mes | Antes | Depois |
|---|---|---|
| junho | 1.903 unidades (13 dias) | **21.224 (30/30)** -- 11x subcontado |
| julho | 16.723 | **25.581** -- tambem furado |
| agosto | 28.522 | 28.897 |

**TODA tela de 90 dias lia junho/julho errados ate 2026-08-30** -- `/vendas`, Curva ABC, baselines de diagnostico. O reparo os corrige de uma vez. E abre uma pendencia: NADA vigia buraco de recalculo (o `history_days_90` desta fatia e a primeira guarda, mas so na tendencia).

**A formula, fixada DEPOIS da medicao no dado consertado:**

- `taxa_recente = u30/30` vs `taxa_anterior = (u90-u30)/60` -- **janelas nao sobrepostas** (sobreposicao contaria as vendas recentes dos dois lados; ha teste fixando a razao exata para a versao sobreposta nao voltar em silencio);
- limiares **+-25%**: no dado real dao 239 crescendo / 174 caindo / 152 estavel -- corte com significado, nao degenerado;
- **duas recusas como parte do desenho**: AMOSTRA_INSUFICIENTE (< 12 unidades/90d -- razao sobre meia duzia de vendas e ruido; 1.144 SKUs caem aqui e e a resposta certa) e HISTORICO_INCOMPLETO (< 84/90 dias com metrica -- a guarda que nasceu do artefato de junho);
- SKU que COMECOU a vender (anterior zero) e CRESCENDO por definicao (6 casos reais).

**Formula unica:** canonica em `@sb/domain/purchasing` (`classifySalesTrend`, 9 testes); a RPC so agrega as janelas (`units_15d/30d/60d/90d` + `history_days_90` em `get_stock_coverage`) e a classificacao NUNCA e feita em SQL. Definicao normativa registrada em `docs/METRICS.md` secao 5D.

**Consumidor imediato:** coluna Tendencia em `/cobertura`, com as quatro janelas e a razao no tooltip (decomposicao visivel). As janelas de 15/60 sao contexto exposto; a classificacao documentada usa 30x(30,90].

**Verificacao:** `check` 29/29 (+9 testes), `EXPLAIN` 94 ms na organizacao inteira, `next build` compila. Tela nao vista renderizada; `types.ts` a mao (7a ocorrencia -- e desta vez corrigiu de carona a nulidade de `days_of_coverage`/`title` que o bloco antigo afirmava erradas).

**Impacto:** migration `20260830021209`, reparo de dado via `rebuild_daily_sales_metrics` (sem migration -- e execucao, nao schema), `packages/domain/src/purchasing/sales-trend.{ts,test.ts}`, `apps/web/app/cobertura/page.tsx`, `packages/db/src/types.ts`, `docs/METRICS.md` secao 5D, `docs/ROADMAP.md`.

## D-146 - Estoque real aproveitavel: a definicao que faltava, e as duas honestidades dela

**Contexto:** terceira fatia da Fase 5D e ultima pre-condicao da sugestao de compra. O PRD exige definicao explicita do que entra de Local, Full, Reservado e Transito, "sem contar duas vezes nem ignorar". Definicao normativa em `docs/METRICS.md` 5D.2.

**A conta: `aproveitavel = LOCAL + FULL + TRANSITO`, com RESERVADO fora.**

**A pergunta da dupla contagem foi respondida por MEDICAO do modelo, nao por suposicao:** o "Disponivel" do UpSeller ja exclui o "Ocupado" -- as duas colunas do export viram `location_kind` DISJUNTOS (LOCAL/RESERVADO) desde a importacao, somando independentes. Logo somar LOCAL sem RESERVADO nao subtrai nada em dobro, e somar os dois e que contaria unidades comprometidas como disponiveis. FULL e outro armazem fisico (disjunto por lugar); TRANSITO baixa e LOCAL sobe na MESMA transacao do recebimento (D-055).

**As duas honestidades, e elas sao o desenho:**

1. **SKU virtual nao tem total.** `stock_is_virtual` diz que o LOCAL e sentinela; sentinela + Full real = lixo com aparencia de precisao. `computeUsableStock` devolve `null` com motivo -- mesma recusa de D-127 na cobertura e de D-144 na politica. Full e transito continuam expostos nos componentes: sao reais.
2. **LOCAL negativo entra NEGATIVO.** -5 sao unidades vendidas alem do que o ledger conhece -- DEVIDAS. Truncar em zero esconderia a divida e a sugestao de compra deixaria de cobri-la. 191 SKUs estao negativos pos-D-134; o numero e real e aparece na conta.

**Formula unica:** `computeUsableStock` em `@sb/domain/purchasing` (5 testes), com a decomposicao no retorno -- e o "por que aproveitavel = 48?" que a sugestao de compra vai exibir.

**Consumidor imediato, sem migration nem RPC nova:** coluna "Aproveitavel" em `/estoque` -- a RPC de D-139 ja devolvia as quatro parcelas e a tela as mostrava separadas sem nunca responder o total. O tooltip carrega a decomposicao ("local X + full Y + transito Z, reservado W fica fora"), honrando o `ARCHITECTURE.md` secao 14: nunca somar num "estoque total" sem dizer o que ele contem.

**Verificacao:** `check` 29/29 (+5 testes), `next build` compila. Tela nao vista renderizada (a ressalva de sempre).

**Com esta fatia, as TRES pre-condicoes da sugestao de compra estao prontas:** politica (D-144) + tendencia (D-145) + aproveitavel (D-146), sobre saldo reparado (D-134) e historico recomputado (D-145). O que continua pendente e HUMANO: o ensaio de /produtos (SKUs sentinela sem classificar => a sugestao recusara para eles) e o preenchimento de /reposicao/configuracoes.

**Impacto:** `packages/domain/src/purchasing/usable-stock.{ts,test.ts}` (novo), `apps/web/app/estoque/page.tsx`, `docs/METRICS.md` 5D.2, `docs/ROADMAP.md`. Sem migration.

## D-147 - Sugestao de compra auditavel: a composicao das tres pecas, e a divida do gerador quitada

**Contexto:** o coracao da Fase 5D, com as tres pre-condicoes prontas (D-144/145/146). O PRD exige: quantidade por calculo auditavel (nunca IA), decomposicao visivel ("por que comprar 48?"), e as referencias por politica -- nao por palpite.

**A conta e uma COMPOSICAO, nao uma formula nova:** `computePurchaseSuggestion` em `@sb/domain/purchasing` consome exatamente o que as tres fatias produziram -- a politica resolvida (D-144) da a janela (`prazo + cobertura + seguranca`), a tendencia (D-145) da a taxa dos ultimos 30 dias, o aproveitavel (D-146) da o que ja existe -- e projeta com `simulateRequiredQuantity` (D-080), como o ROADMAP previa. `sugestao = max(0, ceil(taxa x janela - aproveitavel))`. Normativa em `docs/METRICS.md` 5D.3.

**Decisoes de desenho:**

1. **Taxa = 30d/30, e a tendencia NAO modula o numero.** E a mesma janela "recente" da classificacao; modular por CRESCENDO/CAINDO seria um segundo botao escondido. A tendencia aparece ao lado, como contexto.
2. **As recusas se propagam e TODAS aparecem** (lista, nao primeira): sem configuracao, estoque virtual, historico incompleto, amostra insuficiente. Quem configurar a marca de um SKU virtual precisa saber que ainda falta o ensaio -- descobrir recusa por recusa esconderia o caminho. A decomposicao parcial fica exposta (taxa sempre; projecao se ha config; aproveitavel se nao e virtual).
3. **Zero e resposta** ("nao compre"), nunca recusa. **LOCAL negativo AUMENTA a sugestao** -- a divida entra na compra (24001/PLASMOTO, real: 497 un/30d com LOCAL -168 e Full 113 -> aproveitavel -55).
4. **Custo estimado = custo CADASTRADO x sugestao**, rotulado como tal no tooltip; custo de simulacao separado segue item aberto.

**A RPC entrega INGREDIENTES, nunca a formula** (`get_purchase_suggestions`): reusa os blocos medidos de D-139 (pivot + Full da ultima captura) e D-145 (janelas + `history_days_90`), full outer join saldo x venda de 90d, filtros/ordenacao/contagem no Postgres (D-131). Ordena por `units_30d desc` -- ordenar PELA sugestao exigiria a formula em SQL com teste de equivalencia, e priorizacao e item proprio da fase. `EXPLAIN`: 90 ms quente, 5.445 buffers, 3.276 linhas. Nenhum indice novo.

**Tela `/reposicao`** com a conta inteira por linha (tooltip: `taxa/dia x janela = projetado - aproveitavel = comprar N`), janela com escopo da politica, marca/busca/paginacao (padrao D-141), aviso quando `replenishment_settings` esta vazia, e o retarget do nav que D-144 previa (configuracao virou subpagina). `TrendBadge` extraido para `components/` quando `/reposicao` virou o segundo consumidor -- a regra de contencao de D-141.

**A divida do gerador foi QUITADA no caminho:** `generate_typescript_types` do MCP funcionou nesta sessao -- `types.ts` voltou a ser o arquivo GERADO (docs/API.md secao 7), enterrando os 7 blocos manuais de D-138..D-146. Sobrevive UMA classe de correcao manual, reaplicada e marcada no arquivo: o gerador nunca marca argumento de RPC como anulavel, e ha argumentos onde `null` carrega significado (D-133) -- `p_variation_id`, `p_supplier_brand` de `set_skus_supplier_brand`, os filtros de dashboard/estoque/curva-abc e os da RPC nova. O check inteiro passou com o arquivo regenerado -- prova de que os 7 blocos manuais estavam fieis ao schema.

**Verificacao:** `check` 29/29 (+9 dominio, +9 filtros, +4 integracao RLS/ingredientes), `next build` compila, RPC conferida contra o banco real (total 3.276, lideres de venda no topo). Tela nao vista renderizada (a ressalva de sempre). Com a configuracao vazia, TODAS as linhas recusam "sem configuracao" -- e o contrato: a tela nasce recusando e passa a responder no instante em que o ADMIN preencher `/reposicao/configuracoes`.

**Impacto:** `packages/domain/src/purchasing/purchase-suggestion.{ts,test.ts}` (novo), `apps/web/app/reposicao/page.tsx` (novo), `apps/web/lib/replenishment-filters.{ts,test.ts}` (novo), `apps/web/components/trend-badge.tsx` (novo, extraido de `/cobertura`), `apps/web/components/shell.tsx` (retarget), `packages/db/src/types.ts` (REGENERADO), `packages/db/src/rls.integration.test.ts` (+4), migration `20260830145612`, `docs/METRICS.md` 5D.3.

## D-148 - Estados operacionais calculados: todos os limiares vem da politica, nenhuma constante inventada

**Contexto:** segundo item da reta final da 5D. O ROADMAP pede cinco estados (ruptura, compra urgente, comprar em breve, cobertura baixa/adequada, excesso); o PRD exige que excesso seja "estado proprio, calculado, nao opiniao da IA".

**A regua e a cobertura em dias** (`aproveitavel / taxa_30d`, a MESMA formula de D-080 via `simulateCoverageDays` -- formula unica), **e todos os limiares vem da configuracao de D-144**: cobertura <= prazo -> COMPRA_URGENTE (mesmo comprando agora, esgota antes de chegar); <= prazo + seguranca (ponto de pedido) -> COMPRAR_EM_BREVE; abaixo da janela -> COBERTURA_BAIXA (onde a sugestao de D-147 ja da numero); na janela ate o teto -> ADEQUADA; acima do teto -> EXCESSO. `aproveitavel <= 0` com demanda -> RUPTURA. Normativa em `docs/METRICS.md` 5D.4.

**O achado da fatia: o "buffer maximo" que o PRD nomeia na secao de configuracao e que D-144 nao implementou e exatamente o teto do EXCESSO.** A coluna `max_coverage_days` nasce ANULAVEL e nenhuma linha e preenchida: sem teto, EXCESSO nunca e afirmado -- quanto e "demais" e decisao do ADMIN, nao constante do codigo (mesmo desenho da recusa de D-144). A coerencia e contrato do banco: CHECK `max_covers_window` recusa teto < prazo + cobertura + seguranca, porque abaixo da janela o estado ADEQUADA seria impossivel.

**Uma recusa nova, propria dos estados: SEM_DEMANDA_RECENTE.** Taxa zero nos ultimos 30 dias torna a cobertura INDEFINIDA (contrato de D-080 -- nunca "infinita" fingida), e sem regua nenhum selo e defensavel. O caso passa pela porta da amostra (units30=0 com units90>=12) e e real. As quatro recusas de D-147 tambem se propagam. A cobertura em si e exposta sempre que computavel -- ela nao depende da politica.

**Consumidores:** coluna Estado em `/reposicao` (tons por severidade, D-007; tooltip com cobertura + os quatro limiares) e campo "Teto (dias)" em `/reposicao/configuracoes` (criar, editar e LIMPAR -- voltar a nulo e edicao legitima). Erro do CHECK traduzido na action.

**Processo que ficou de D-147 e virou passo padrao: o ensaio revertido.** A CI cobrou duas vezes fixtures que violavam CHECKs que eu nao tinha enumerado (proveniencia da marca de D-133; formato de item_id). Na segunda, a fixture INTEIRA foi validada contra o Dev numa transacao com rollback (DO block com raise por assercao) -- CI #268 verde na primeira tentativa depois disso. Nesta fatia o ensaio rodou ANTES do primeiro push.

**Verificacao:** `check` 29/29 (+11 dominio, +2 integracao), build compila, constraints ensaiadas contra o Dev em transacao revertida. Tela nao vista renderizada (a ressalva de sempre). CI #268 (`a6e07c6`) validou D-147 completa, incluindo os 4 testes de integracao da RPC.

**Impacto:** `packages/domain/src/purchasing/stock-state.{ts,test.ts}` (novo), `replenishment-policy.ts` (+`maxCoverageDays`), `apps/web/app/reposicao/page.tsx` (coluna Estado), `apps/web/app/reposicao/configuracoes/{page,actions}.tsx` (campo teto), `packages/db/src/types.ts` (REGENERADO -- script `regen_types` reutilizavel), `rls.integration.test.ts` (+2), migration `20260830152556`, `docs/METRICS.md` 5D.4.

## D-149 - Custo de simulacao separado do cadastrado, e o custo passa a ter historia

**Contexto:** terceiro item da reta final da 5D. O ROADMAP nomeia a dor: `skus.purchase_cost` e sobrescrito a cada importacao (o UPDATE do erp-import-apply grava o registro INTEIRO) e o valor anterior morre sem rastro. O PRD exige: "simular um pedido nao pode destruir o custo historico do SKU".

**A separacao ja era estrutural -- esta fatia a torna VISIVEL e TRAVADA:**

1. **`sku_cost_history` (nova, L2 append-only), alimentada por TRIGGER na propria `skus`**: nenhum caminho de escrita (import, reparo direto, RPC futura) muda o custo sem historiar. `previous_cost` nulo = SKU nasceu com custo; `new_cost` nulo = custo apagado (o apagamento tambem e historia). `changed_by_role` e a proveniencia real disponivel (service_role = import, postgres = direto) -- NAO ha coluna de ator humano porque nao existe caminho humano de escrita; coluna sempre nula seria auditoria de mentira.
2. **SEM backfill, de proposito**: linha "baseline" afirmaria um instante de vigencia que ninguem mediu, e seriam ~3.4k escritas em massa sem necessidade (precedente D-065/D-081). O registro comeca em 2026-08-30 e a tela declara isso.
3. **FK do SKU em RESTRICT -- corrigida pela CI #270, e a correcao e o registro honesto**: a primeira versao usou CASCADE (racionalizando "custo de quem nunca operou nao e historia perdida"), e cascade + gatilho append-only e CONTRADICAO: o cascade dispara exatamente o DELETE que o gatilho rejeita -- o SKU ficava indeletavel do jeito mais tortuoso, e o teardown da suite caiu com TODOS os 404 testes verdes (a classe de D-099: uma falha derrubando o lote). O padrao correto ja existia na casa: auditoria prende por RESTRICT (sku_listing_link_events, D-125) e o teardown ganha a 8a guarda NOT EXISTS. Licao de processo: o ensaio revertido validou as 5 mecanicas do gatilho mas NAO exercitou a delecao do SKU -- o ensaio precisa incluir o caminho do teardown. De passagem: `purchase_order_items.sku_id` e SET NULL (por isso os testes de compras usavam `skuId: null`).
4. **O invariante do PRD virou teste**: criar pedido com `unit_cost` proprio nao toca `skus.purchase_cost` NEM gera linha de historia -- o custo de pedido vive em `purchase_order_items.unit_cost` e nunca escreve de volta.
5. **O custo cadastrado vira SUGESTAO no pedido** (`/compras/novo`): selecionar um SKU preenche o custo unitario com o cadastrado, rotulado ("edite a vontade; o pedido nao altera o cadastro"), e so quando o campo esta vazio ou ainda carrega sugestao anterior -- nunca por cima do que o usuario digitou. Antes o campo nascia vazio e era digitado de cabeca.

**Consumidores**: secao "Custo cadastrado" no Dashboard de SKU (custo atual + historico com proveniencia + estado vazio honesto sobre o inicio do rastreio); tooltip do custo estimado em `/reposicao` atualizado (o "item aberto" fechou).

**Ensaio revertido ANTES do push** (processo de D-148): as cinco mecanicas do gatilho (nascimento, mudanca, update sem custo, apagamento, append-only) validadas contra o Dev em transacao com rollback.

**Verificacao:** `check` 29/29 (+7 integracao), build compila. Tela nao vista renderizada (a ressalva de sempre).

**Impacto:** migration `20260830154350` (tabela + 2 triggers de captura + append-only fisico + RLS), `apps/web/app/skus/[skuId]/page.tsx` (secao de custo), `apps/web/app/compras/novo/item-row.tsx` (sugestao de custo), `apps/web/app/reposicao/page.tsx` (tooltip), `packages/db/src/types.ts` (regenerado), `rls.integration.test.ts` (+7).

## D-150 - Priorizacao de compras: a primeira derivacao SQL da formula canonica, com teste de equivalencia

**Contexto:** penultimo item da 5D. O PRD e explicito: priorizacao e camada de ORDENACAO, nunca compra automatica. Ordenar o conjunto inteiro (3.276 SKUs) pela prioridade exige o calculo no Postgres (D-131: paginacao e ordenacao em SQL) -- e o momento que D-144/D-147 declararam para a primeira versao SQL derivada de `@sb/domain` com teste de equivalencia.

**A ordem e lexicografica por categorias, sem score e sem peso inventado:** estado operacional (ruptura > urgente > em breve > baixa > RECUSAS > adequada > excesso), classe ABC (faturamento/90d, pela PROPRIA `get_sku_abc_curve` via join -- a curva e canonica em SQL, nunca reimplementada), cobertura crescente, venda 30d decrescente, SKU. **Recusa no meio de proposito**: pendencia humana acima do que nao precisa de acao, abaixo do que precisa de compra. Crescimento e valor sao COLUNAS para o julgamento, nao chaves -- chave explicavel vale mais que score opaco. Normativa em `docs/METRICS.md` 5D.5.

**O teste de equivalencia e a licenca da derivacao:** `packages/db` ganhou `@sb/domain` como devDependency (sem ciclo) e a suite compara, PARA CADA LINHA que a RPC devolve, sugestao/estado/cobertura do SQL contra o dominio alimentado com os mesmos ingredientes -- mais quatro SKUs plantados que forcam os ramos (urgente, ruptura, excesso, virtual) e um teste de posicoes da ordenacao. O `test:integration` builda `@sb/domain` antes (o job de CI chama o script direto, sem turbo).

**Detalhes que a derivacao exigiu:**

1. **Resolucao de politica em SQL por precedencia de LINHA INTEIRA** (SKU > marca > padrao), nunca coalesce por campo -- coalesce misturaria escopos quando o `max_coverage_days` do escopo vencedor e nulo.
2. **Bug real de float achado pela equivalencia, corrigido na RAIZ (D-080):** `Math.ceil(janela x taxa)` cru transforma artefato binario em unidade INTEIRA -- `90 x (3/30) = 9.0000000000000005` mandava comprar 10 quando a conta exata da 9. `simulateRequiredQuantity` agora sanea o produto na 9a casa antes do ceil; vale tambem para o Simulador de decisao, que carregava o mesmo defeito.
3. **A tela continua renderizando pelo dominio** (formula unica: o canonico e o TS); as colunas derivadas existem para ordenar e para a equivalencia. So `abc_class` e exibida do SQL -- a curva e canonica la.

**Medicao:** 196 ms quente, 15.047 buffers, temp ~4MB -- acima da familia de 90-137 ms, e o custo extra e o preco DECLARADO de reusar a `get_sku_abc_curve` canonica (que refaz o proprio join de Full) em vez de duplicar a formula. Nenhum indice novo.

**Verificado no dado real antes de qualquer config:** com a configuracao vazia, a ordem ja conta a verdade -- classe A com cobertura 0,0 no topo (24001/PLASMOTO de novo: 497 un/30d com aproveitavel -55). Ensaio revertido no Dev com os quatro ramos e as posicoes ANTES do push.

**Verificacao:** `check` 29/29 (+1 dominio, +3 integracao), build compila. Tela nao vista renderizada (a ressalva de sempre).

**Impacto:** migration `20260830163841` (RPC reescrita com derivacao e ordenacao), `packages/domain/src/inventory/coverage-simulation.{ts,test.ts}` (saneamento de float), `packages/db/package.json` (+@sb/domain dev, test:integration builda antes), `rls.integration.test.ts` (+3, incluindo a equivalencia linha a linha), `apps/web/app/reposicao/page.tsx` (coluna Classe, texto da ordem), `apps/web/lib/replenishment-filters.ts` (rotulo), `types.ts` (regenerado), `docs/METRICS.md` 5D.5.

## D-151 - Da cobertura para o pedido: a ponte que encurta o caminho, nunca a decisao -- FASE 5D COMPLETA

**Contexto:** a ultima fatia da 5D. O PRD pede: selecionar, revisar quantidade e custo, criar pedido -- com aprovacao humana, respeitando a regra de nao misturar nacional e importado.

**A ponte tem as duas pontas prontas ha muito, e a fatia e deliberadamente pequena:** `/reposicao` ja prioriza e sugere (D-147/D-150); `/compras/novo` ja aceita `initial` (o editar de rascunho usa) e o ciclo DRAFT -> aprovar -> enviar -> receber de D-055 E a aprovacao humana. O que faltava era o fio:

1. **Selecao em `/reposicao`**: checkbox POR LINHA COM SUGESTAO defensavel e positiva (linha recusada ou coberta nao tem o que pedir; item avulso entra a mao no proprio pedido). GET nativo para `/compras/novo` com pares `sku=<uuid>:<qtd sugerida>`.
2. **Pre-carga no pedido** (`parseReplenishmentPrefill`, pura e testada): par malformado e DESCARTADO em silencio (URL e editavel; um caractere errado nao derruba os demais), duplicata fica com a primeira, teto de 100. O `.in()` roda sob RLS: id alheio simplesmente nao volta. Quantidade sugerida + custo CADASTRADO como sugestao editavel (D-149) -- e o aviso na tela: nasce como RASCUNHO, so vira compra com a aprovacao do ciclo de Compras.
3. **"Nao misturar nacional e importado" como AVISO, nunca bloqueio** (`detectOriginMix`, pura e testada): `is_imported` e origem FISCAL e D-129/D-139 MEDIRAM que ela contradiz a rota de compra (187 dos 228 NAVETEC constam "nacionais") -- bloquear em cima de dado sabidamente errado impediria pedidos legitimos. O aviso conta importados/nacionais/desconhecidos, cita a ressalva de D-129 e deixa a decisao com o humano; origem desconhecida NAO dispara a mistura (ausencia de resposta nao e resposta). O proprio PRD ja avisava: "nem hardcode por marca, nem confianca cega em is_imported".

**Verificacao:** `check` 29/29 (+7 testes de web), build compila. Sem migration, sem RPC nova, sem types. Tela nao vista renderizada (a ressalva de sempre).

**FASE 5D COMPLETA**: D-144 (configuracao) -> D-145 (tendencia) -> D-146 (aproveitavel) -> D-147 (sugestao) -> D-148 (estados) -> D-149 (custo com historia) -> D-150 (priorizacao com equivalencia SQL) -> D-151 (cobertura->pedido). Toda a matematica e deterministica, toda recusa tem motivo, e os DOIS interruptores da fase continuam humanos: preencher `/reposicao/configuracoes` e o ensaio de `/produtos`. A proxima fase da fila declarada e a **6B (diagnostico narrado, timeline e acoes acionaveis)** -- cujo primeiro item ja esta medido: `stock.balance.diverged` foi eliminado na origem por D-134/D-135, restando verificar o que sobrou de ruido antes de qualquer sinal novo.

**Impacto:** `apps/web/app/compras/novo/prefill.{ts,test.ts}` (novo), `apps/web/app/compras/novo/page.tsx` (pre-carga), `apps/web/app/compras/novo/purchase-order-form.tsx` (aviso de mistura), `apps/web/app/reposicao/page.tsx` (selecao + submit).

## D-152 - Fase 6B comeca: o ruido medido como resolvido, e a correlacao alcanca anuncio e pedido

**Contexto:** primeira fatia da 6B. O checklist tem uma pre-condicao nomeada -- "ruido antes da inteligencia" -- e um item de correlacao que o proprio ROADMAP descreve: o filtro `entity_type='sku'` exclui todo `listing.*` e `order.*` do diagnostico.

**1. O ruido foi MEDIDO como resolvido (2026-08-30):** `stock.balance.diverged` -- que era ~2.040 criticos/dia e 55,1% de todas as notificacoes -- esta em **ZERO nas ultimas 24h** (os 13.891 da janela de 7d sao residuo anterior a D-134/D-135, que o eliminaram na ORIGEM). O item fecha com numeros, nao com otimismo. O topo do ruido agora e `listing.available_quantity.changed`: 1.267 notificacoes/24h, **91% do total** -- severidade informativa, e segue sendo a DECISAO DE PRODUTO ja sinalizada ao usuario (silenciar, agregar ou manter).

**2. A correlacao alcancou anuncio e pedido** (`get_sku_correlated_events`, RPC unica para os TRES consumidores -- `/diagnostico`, painel do SKU e detector do worker, que carregavam o mesmo filtro copiado):

- `entity_type='sku'`: o que ja chegava (todos os stock.*);
- `entity_type='listing'`: entity_id e o item_id do ML -- mapeia ao SKU por `listings(ml_account_id, item_id) -> sku_id`. **Vocabulario FECHADO** (preco/titulo/pausa/reativacao/Full) e a exclusao e o ponto: `available_quantity.changed` e consequencia de venda, nao causa -- inclui-lo inundaria todo diagnostico com o proprio ruido que a fase manda conter;
- `entity_type='order'`: entity_id e o id ML do pedido (orders.id bigint) -- mapeia pelos itens CONGELADOS (`order_items.sku_id`, D-020); pedido com dois SKUs candidatos correlaciona com os dois; entity_id nao numerico e descartado por guarda de regex em vez de derrubar a consulta.

**As causas classicas ganharam leitura propria** em `describeCandidateCause` (preco mudou, anuncio PAUSADO, reativado, titulo, entrada no Full) -- a funcao ja sabia descrever `order.cancelled`/`order.returned` que nunca chegavam; agora chegam.

**Medicao:** 34 ms quente, 10.534 buffers (50 SKUs candidatos, janela de 10 dias). Nenhum indice novo. Ensaio revertido no Dev com os tres caminhos + exclusao + guarda ANTES do push.

**Verificacao:** `check` 29/29 (+1 dominio, +4 integracao), build compila. Tela nao vista renderizada (a ressalva de sempre).

**Impacto:** migration `20260830211033` (RPC), `packages/domain/src/diagnostics/sales-anomaly.{ts,test.ts}` (vocabulario), `apps/web/app/diagnostico/page.tsx`, `apps/web/app/skus/[skuId]/actions.ts`, `apps/worker/src/handlers/detect-sales-anomaly-actions.{ts,test.ts}`, `types.ts` (regenerado), `rls.integration.test.ts` (+4).

## D-153 - Timeline de evidencias: historia nao edita o passado

**Contexto:** segundo item de tela da 6B. "domain_events ja e a linha do tempo; falta a tela" (ROADMAP) -- a ordem dos acontecimentos de um SKU, para o Diagnostico e o "O que aconteceu?".

**A RPC (`get_sku_timeline`) junta os MESMOS tres caminhos de D-152** (evento do proprio SKU; de anuncio via `listings(conta, item_id)`; de pedido via `order_items` congelados) -- **mas com o contrato OPOSTO no vocabulario, e a diferenca e o desenho**: a correlacao FECHA a lista porque causa candidata inventada e ruido vestido de causa (e exclui `available_quantity.changed`); a timeline e HISTORIA, nao causa -- todo evento mapeavel entra, inclusive as mudancas de quantidade, porque elas SAO a historia do estoque daquele SKU e escolher o que entra na historia seria editar o passado. O teste de integracao fixa o contraste sobre as MESMAS fixtures: correlacao devolve 3, timeline devolve 4.

**A tela** e uma secao "Linha do tempo" no Dashboard de SKU: quando (fuso fixo), evento (rotulos de `eventTypeLabel`, severidade por tom), mudanca (via `formatEventDiff`, que so interpreta formatos DOCUMENTADOS -- o resto aparece sem diff, nunca com leitura inventada) e onde (entidade + conta). Ultimos 50, com o corte declarado quando age. Zero pecas novas de leitura: `eventTypeLabel`/`severityLabel`/`formatEventDiff`/`entityLabel` ja existiam compartilhados entre Central de Notificacoes e toasts (D-074/D-075).

**Medicao:** 70 ms quente, 36.286 buffers no SKU MAIS MOVIMENTADO da organizacao (pior caso), limit 50. Nenhum indice novo. Ensaio revertido no Dev (4 eventos, ordem decrescente, corte do limit, label da conta) ANTES do push.

**Verificacao:** `check` 29/29 (+2 integracao), build compila. Tela nao vista renderizada (a ressalva de sempre). Licao pequena de tipos: o gerador nao marca `account_label` de LEFT JOIN como anulavel -- interface local de nulidade real, o padrao das demais telas.

**Impacto:** migration `20260831095401` (RPC), `apps/web/app/skus/[skuId]/page.tsx` (secao), `types.ts` (regenerado), `rls.integration.test.ts` (+2 sobre as fixtures de D-152).

## D-154 - Atalhos operacionais na Central de Acoes: so se aponta para tela que existe

**Contexto:** item da 6B com a dor nomeada pelo ROADMAP: "hoje nao existe um unico link, e a recomendacao gerada manda abrir telas que a interface nao oferece". Fatia deliberadamente ANTES da "IA explicando a acao" -- o mesmo principio de "ruido antes da inteligencia": a camada deterministica primeiro, para a narracao da fatia seguinte apontar para chao real.

**A regra do modulo e a inversa da dor** (`actionShortcuts`, puro e testado): so se aponta para tela que EXISTE, com o filtro que ela realmente tem. Venda anomala com SKU ganha tres atalhos -- Dashboard do SKU (o hub: diagnostico, simulador, custo e a linha do tempo de D-153), `/anuncios?busca=` (D-138) e `/reposicao?busca=` (D-147). Reclamacoes recorrentes ganha a Caixa de Entrada INTEIRA, **sem fingir um filtro por SKU que `/atendimento` nao oferece**. `kind` desconhecido degrada para os atalhos genericos do SKU; acao sem SKU nao ganha link morto. Calculo no servidor; a linha so renderiza.

**O achado da fatia estava no DOMINIO**: o proximo passo do diagnostico prometia "Abrir a Caixa de Entrada FILTRADA POR ESTE SKU" -- exatamente o filtro que nao existe, a queixa literal do item encarnada numa string de D-116. Corrigido para prometer o que existe.

**Verificacao:** `check` 29/29 (+5 testes de web), build compila. Sem migration, sem RPC, sem types. Tela nao vista renderizada (a ressalva de sempre).

**Impacto:** `apps/web/lib/action-shortcuts.{ts,test.ts}` (novo), `apps/web/app/acoes/{page,action-row}.tsx` (sku_id no select; atalhos sob a recomendacao), `packages/domain/src/diagnostics/sales-anomaly.ts` (texto honesto).

## D-155 - IA explicando a ACAO: o vocabulario obrigatorio vira instrucao, e a leitura da evidencia vira uma so -- FASE 6B COMPLETA

**Contexto:** ultimo item da 6B ("IA explicando a ACAO, nao so o diagnostico do SKU"). O motor ja existia (D-082: Haiku 4.5, `ai_runs` com custo real, orcamento D-100); D-154 acabara de dar chao determinismo a linha da Central. O PRD fixa o vocabulario obrigatorio: causa mais provavel, fatores contribuintes, hipoteses, evidencias contrarias e o que nao conseguimos verificar -- nunca "causa verdadeira".

**Decisao 1 -- o input e so `{ actionId }`, e isso elimina a superficie de contrato forjado.** `narrate_sku_diagnosis` (D-082) recebe o contrato inteiro do chamador porque o diagnostico e calculado na hora pelo `web` e nao existe no banco. A ACAO e o oposto: ja vive em `actions` (D-064/D-116). A `api` le a linha sob a RLS do PROPRIO usuario (`UserClient`) -- autorizacao e dado no mesmo ato, acao de outra organizacao simplesmente nao e encontrada. Nada a revalidar, nada a forjar.

**Decisao 2 -- `describeActionEvidence` subiu para `@sb/domain/diagnostics`.** A `api` precisava ler o MESMO `evidence` jsonb que a tela: a `api` virou o segundo consumidor, e a regra de contencao (`ARCHITECTURE.md` secao 7) manda subir exatamente nesse momento. `git mv` preservando historia, teste junto, zero linha alterada na logica. A alternativa -- um segundo leitor na `api` -- divergiria na primeira forma nova de `kind`, e a narracao citaria evidencia que a tela nao mostra (a classe de defeito que D-117 achou na leitura dupla da Central).

**Decisao 3 -- o vocabulario obrigatorio e INSTRUCAO DE SISTEMA, nao esperanca.** `ACTION_EXPLANATION_SYSTEM_PROMPT` exige as cinco secoes rotuladas, manda secao sem dado declarar a ausencia ("nenhuma registrada pelo sistema") e proibe a expressao "causa verdadeira" e certeza acima da confianca informada. Para `reclamacoes_recorrentes` -- sem direcao, sem causas candidatas -- e o caminho da ausencia que roda sempre: o teste fixa que o prompt declara "nenhuma causa candidata encontrada" em vez de omitir. `maxTokens: 768` (cinco secoes nao cabem com folga nos 512 padrao; truncar a ultima secao e falha certa).

**UI:** botao "Explicar com IA" na linha de `/acoes` (client fetch direto a `api`, padrao D-082 -- a chave da Anthropic nunca chega a Vercel), narrativa em linha propria sob a acao com `pre-line`. Nunca dispara no carregamento (`COPILOT.md` secao 9).

**De passagem:** dois paragrafos de `docs/API.md` congelados desde D-114/D-082 ("planner ainda nao existe"; "llm_used sempre false") corrigidos com a marca da correcao.

**Verificacao:** `check` 29/29 (+3 testes de api; testes de `action-evidence` movidos sem alteracao), build 8/8. Sem migration, sem RPC, sem types. Tela nao vista renderizada (a ressalva de sempre); o caminho LLM real (chave da Anthropic) so existe no deploy.

**Impacto:** `packages/domain/src/diagnostics/action-evidence.{ts,test.ts}` (movidos de `apps/web/lib`), `packages/domain/src/diagnostics/index.ts`, `packages/contracts/src/{copilot-tools,index}.ts` (`narrate_action`), `apps/api/src/copilot.{ts,test.ts}`, `apps/web/app/acoes/{page,action-row}.tsx`, `docs/{COPILOT,API,ROADMAP,HANDOFF}.md`.

## D-156 - Rate limit de visits: cada tentativa passa a somar progresso, e a rajada ganha espacamento

**Contexto:** D-143 mediu e entregou a visibilidade: `visits` falhava 123 de 145 execucoes (85%) por 429, e "corrigir o rate limit e fatia de worker". Remedido em 2026-08-31 antes de escrever: a cobertura diaria ACONTECE (4 `done`/dia, ~240s, ~815-895 itens), mas ao custo de ~22 execucoes falhas/dia — cada uma queimando dezenas de segundos de chamadas full-speed antes de morrer no 429 esgotado e RECOMECAR DO ZERO na tentativa seguinte do Cloud Tasks. A fila `ml-sync-<conta>` tem teto de 8 tentativas, e os dias medidos chegam a ~7,5 por conta: um dia pior que a media esgota as tentativas e perde a cauda EM SILENCIO. De quebra: a maior conta tem 857 ativos e a enumeracao lia `listings` sem `.range()` — a 8a ocorrencia latente da classe D-131, a 143 itens do penhasco.

**Decisao 1 — checkpoint pela PROPRIA tabela, nao por infraestrutura nova.** Item com linha em `daily_listing_visits` com `synced_at` nas ultimas 12h e pulado. Cada tentativa do Cloud Tasks passa a CONTINUAR de onde a anterior morreu — o retry nativo da fila vira o mecanismo de retomada, sem coluna de cursor, sem job novo, sem IAM novo (o worker nao pode enfileirar em `ml-sync-<conta>`, secao 11 da arquitetura — auto-encadeamento estava bloqueado por construcao). Janela de 12h: menor que a cadencia diaria, maior que a cauda de retries (~2h), livre de fuso. Item com escrita parcial pode ser pulado ate a janela expirar — o `last=3` da rodada seguinte recobre, que e a folga para a qual ele existe.

**Decisao 2 — espacamento de 150 ms entre chamadas (~6-7/s).** A execucao que completa faz ~280 ms/item; as que morrem, full speed — a rajada e o gatilho. Sem numero oficial de rate limit (D-042), o valor e conservador e AJUSTAVEL POR MEDICAO, declarado no codigo e em `MERCADO_LIVRE.md` secao 2.11. Custo: +~2 min na varredura completa (~370s totais, contra timeout de 900s). Item pulado pelo checkpoint nao paga espera (testado).

**Decisao 3 — enumeracao e checkpoint por `readAllPages`.** Fecha a 8a ocorrencia da classe D-131 ANTES de virar corte silencioso; a leitura do checkpoint ja nasce paginada (ate 3 linhas por item na janela). O teste de paginacao fatia por `range` de verdade — 1.002 ativos atravessam em duas paginas.

**O que NAO mudou:** 429 esgotado continua derrubando a execucao (falha retryable, `sync_runs` failed) — so que agora o progresso persiste e a tentativa seguinte nao o repete. 404/403 por item continuam `itemsFailed` sem derrubar. O resultado ganhou `itemsSkipped`, logado pelo orquestrador.

**Verificacao:** `check` 29/29 (20 testes no par de arquivos, +4 novos), build 8/8. Sem migration. ⚠️ **Aguarda deploy do worker e a LEITURA da rodada seguinte** (regra de D-109): a confirmacao e a queda das ~22 execucoes falhas/dia na tela de Saude da Sincronizacao (D-143), que ja mede exatamente isso.

**Impacto:** `apps/worker/src/handlers/ml-listing-visits-fetch.{ts,test.ts}`, `apps/worker/src/handlers/sync-listing-visits-snapshot.{ts,test.ts}` (log + fake), `docs/{MERCADO_LIVRE,ROADMAP,HANDOFF}.md`.

## D-157 - Metricas 5C de vendas: cancelamento sai do L1 de proposito, e a ressalva vira parte do card

**Contexto:** o item de Vendas era o unico da 5C ainda aberto. Das sete metricas de 5C.2, cinco tem fonte confirmada E persistida (`sale_fee` 100% preenchido, medido em D-120); margem operacional espera frete/desconto que nao existem no banco, e a visao "hoje" tem decisao propria (5C.4). Entregar as cinco e recusar as duas com motivo nomeado e exatamente o desenho da secao.

**Decisao 1 — cancelamento vem de `orders` direto (L1), nao do rollup L3.** Nao e desvio da arquitetura, e o unico caminho: o recalculo filtra `paid`/`partially_refunded` POR CONSTRUCAO, entao cancelamento nao existe em `daily_*_metrics`. E a **taxa de cancelamento calcula os dois lados da MESMA leitura**: misturar cancelados de L1 com o `pedidos` de L3 embutiria o atraso do recalculo na razao — medido no dia da entrega: 28.584 validos em L1 contra 28.556 em L3 na mesma janela (0,1%). A secao da tela declara a fonte e avisa que pode divergir minimamente dos cards L3 acima.

**Decisao 2 — a ressalva obrigatoria e PARTE DO CARD, nao tooltip.** 5C manda a ressalva "visivel ao lado do numero"; cada um dos cinco cards carrega a sua em texto corrido (comissao nao inclui frete/taxa fixa/parcelamento/impostos; pending_cancel conta como cancelado; valor PEDIDO, nao estornado; bucket sem vinculo excluido — 21,8% dos itens). A secao inteira abre com o aviso de 5C.1: **nao e receita liquida**.

**Decisao 3 — `taxa_cancelamento` NULL quando nao ha pedido elegivel**, nunca 0% fingido (nullif no denominador; nulidade REAL por interface local sobre o tipo gerado, padrao D-153). `formatPercent` novo em `lib/format`.

**Mecanica:** RPC `get_sales_expanded_summary` (security invoker — RLS de orders/order_items/daily_sku_metrics filtra antes da soma; anon revogado), mesma expressao de dia civil SP do recalculo canonico, janela sargavel em `orders_date_created_idx`. **EXPLAIN: 168 ms / 174k buffers, sem indice novo.** Catalogo `metric_definitions` ganhou as cinco definicoes. Duas consultas novas em `/vendas`, no MESMO paralelo e na MESMA agregacao de erro de D-067 (falhar so a expandida viraria "nao houve cancelamento"). Migration aplicada pelo MCP e arquivo renomeado para o timestamp registrado (`20260831114736`, licao de D-138); `types.ts` com o bloco novo no formato exato do gerador (unica migration desde a regeneracao de D-153).

**Ensaio revertido no Dev ANTES do push** (licao de D-148): fixture equivalente ao do teste de integracao inserida em 2020-01-01 (data sem dado real), RPC devolvendo as STRINGS EXATAS que o teste espera ("23.00", 2, "0.3333", "1059.00") — inclusive a prova do fuso (pedido de 01:30 UTC do dia 2 contado no dia civil 1 de SP). Zero residuo conferido.

**Verificacao:** `check` 29/29, build 8/8. +5 testes de integracao (RLS por organizacao, filtro por conta, pending_cancel, bucket nulo, taxa NULL, anon recusado) sobre o fixture existente de metricas — que ganhou `sale_fee` e um pedido `pending_cancel`. ⚠️ Tela nao vista renderizada (a ressalva de sempre); RLS dos testes novos confirmada pela CI, nao localmente.

**Impacto:** migration `20260831114736`, `packages/db/src/{types.ts,rls.integration.test.ts}`, `apps/web/app/vendas/page.tsx`, `apps/web/lib/format.ts`, `docs/{METRICS,ROADMAP,HANDOFF}.md`.

**Correcao pos-CI (2026-08-31):** a CI deste commit FALHOU num teste que a fatia nao tinha tocado — "membro autenticado le as seis definicoes canonicas" fixava a CONTAGEM do catalogo, e as cinco definicoes novas levaram de 6 a 11. O ensaio no Dev nao pegou porque valida a RPC, nao a suite alheia; a licao e a mesma classe de D-142 ("29/29 local nunca foi afirmacao sobre a suite de integracao"). Corrigido trocando contagem por CONJUNTO EXATO de ids (lista diz O QUE mudou, contagem so diz QUE mudou) e validado com a suite INTEIRA rodando local pela primeira vez desde D-142: Docker configurado pelo usuario, `supabase start` aplicou as 92 migrations do zero e **422/422 testes de integracao passaram** — incluindo os de D-157/D-158.

## D-158 - Visao "hoje": le orders ao vivo E sinaliza -- as duas metades da alternativa de 5C.4

**Contexto:** o sub-item "visao hoje" era o penultimo do item de Vendas, deixado por 5C.4 com decisao de desenho propria: "ou le orders direto (fora do padrao L3) ou sinaliza a incompletude; nunca finge que o dia fechou". D-157 tinha acabado de estabelecer o precedente que faltava — leitura L1 com a fonte DECLARADA na tela.

**Decisao — as duas metades, nao uma:** `get_sales_today_summary` le `orders`/`order_items` ao vivo para um unico dia civil SP, E a secao "Hoje — dia em andamento" sinaliza tres vezes: no titulo, no aviso ("numeros parciais por construcao; nao comparavel com periodos encerrados") e no **`last_order_at`** — "ultima venda registrada as HH:MM", que diz ate onde o dia foi observado (o webhook traz pedidos em segundos desde D-101). Dia sem venda mostra "nenhuma venda registrada ate agora" com zeros REAIS — diferente do "nunca calculado" do L3, porque orders e vivo.

**Nenhuma metrica nova nasceu.** Sao as quatro formulas canonicas de 5.2 (receita_bruta, unidades_vendidas, pedidos, pedidos_por_pack) avaliadas ao vivo sobre a fonte que o proprio catalogo cita — os cards usam os IDs existentes, e a incompletude, que e UMA verdade sobre as quatro, vive no cabecalho da secao, nao repetida em cada card. Receita/pedidos/compras contados nas ORDERS (nao no join com itens — imune a pedido multi-item duplicar total_amount); unidades no join.

**O teste de integracao e uma mini-prova de equivalencia L1×L3:** sobre o MESMO fixture, `get_sales_today_summary('2026-08-20')` tem de devolver exatamente o que o teste de `get_sales_summary` le do rollup (5 / 220.00 / 4 / 3) — e prova de quebra o fuso (pedido de 01:30 UTC do dia 21 contado no dia civil 20 de SP) e a exclusao de cancelado/pending_cancel do `last_order_at`.

**Mecanica:** security invoker (RLS filtra antes da soma; anon revogado), mesma expressao de dia civil do recalculo, **EXPLAIN 19 ms / 2.9k buffers** (dia com 136 pedidos), setima consulta de `/vendas` no MESMO paralelo e agregacao de erro. Migration `20260831115917` aplicada pelo MCP com arquivo casando o timestamp (licao D-138). Ensaio revertido no Dev confirmou as strings exatas do teste, zero residuo.

**Verificacao:** `check` 29/29, build 8/8, +4 testes de integracao. ⚠️ Tela nao vista renderizada (a ressalva de sempre).

**Impacto:** migration `20260831115917`, `packages/db/src/{types.ts,rls.integration.test.ts}`, `apps/web/app/vendas/page.tsx`, `docs/{METRICS,ROADMAP,HANDOFF}.md`. **Do item de Vendas resta so a margem operacional** (frete/desconto nao persistidos — fatia de worker candidata declarada).

## D-159 - Fase 9 abre pelo MODELO: idempotencia vira constraint, e o estado que exige gente tem nome

**Contexto:** a fila declarada de D-120 chegou a ultima fase (9 — republicacao oficial, a primeira escrita destrutiva no ML). A pesquisa de 2.16 fixa o que decide o desenho: o fluxo real FECHA O PAI (irreversivel) antes do POST /relist, **a API nao oferece idempotencia nenhuma** (busca literal: zero ocorrencias), o `variation_id` do filho e RENOVADO, e Full/catalogo sao vacuo documental. Abrir a fase pelo modelo — sem chamada ao ML, sem UI — e a ordem que nao alarga a pilha nao-deployada.

**Decisao 1 — a maquina de estados e do dominio, e nomeia a janela perigosa.** `@sb/domain/listings` (subdominio novo): 9 estados, com tres familias — reabriveis (`PREFLIGHT_FAILED`/`CLOSE_FAILED`: nada destrutivo aconteceu), vivos, e **`RELIST_FAILED` = pai fechado SEM filho confirmado**, o unico `relistStateRequiresHuman`: nao e terminal (o retry humano volta a RELISTING depois de reconferir o remoto — um filho pode ter nascido sem a resposta chegar) e nunca reabre como operacao nova. O teste fixa que RELISTING so nasce de CLOSED ou desse retry — nao existe caminho que emita o POST sem o pai confirmado fechado.

**Decisao 2 — idempotencia como CONSTRAINT, nunca boa vontade de handler.** `listing_relists_one_live_per_parent` (indice unico parcial: uma operacao viva/concluida por pai; o predicado espelha `RELIST_REOPENABLE_STATES` e o teste de integracao fixa a equivalencia dos dois lados), `listing_relists_child_unique` (um filho nunca pertence a duas operacoes) e o CHECK `child_requires_state` (filho so existe a partir de RELISTED — preenchido quando CONFIRMADO no remoto, nunca pelo que o POST "deveria" ter criado). A validacao de TRANSICAO fica so no dominio (duplica-la em trigger exigiria equivalencia sem ganho; quem escreve e worker/RPC futura, sempre pela maquina).

**Decisao 3 — as licoes viram FK:** ator RESTRICT (D-099), historico RESTRICT (D-149 — cascade + append-only quebra teardown), snapshot `parent_snapshot` capturado na criacao (base do preflight, do remapeamento e do antes/depois do PRD). Historico `listing_relist_events` append-only com trigger, sem grant de update/delete nem para service_role.

**Achado de suite no caminho:** a conta do fixture usou slug `rlstest-*` e a limpeza global quebrou na 2a rodada local (RESTRICT novo) — corrigida para slug permanente (`relist-conta`, precedente `syncobs-conta`). E ficou documentado o que a rodada dupla ensinou: **a suite de integracao pressupoe banco recriado por rodada** (fixtures referenciadas por append-only ficam por desenho); local, `supabase db reset` antes de repetir.

**Fase 8, medicao parcial de passagem:** a metade do SCHEMA do "backup e restore verificados" ja e provada diariamente (CI + local recriam as 93 migrations do zero); a metade do DADO depende do plano do projeto Supabase, que nem MCP nem API expoem — registrado no ROADMAP como ato do usuario (Dashboard → Database → Backups).

**Verificacao:** migration `20260831123707` aplicada no Dev (MCP, arquivo casando o timestamp) e no local; **427/427 testes de integracao em banco recriado do zero** (+5 de relist: RLS/anon, escrita direta negada, indice parcial com reabertura, coerencia+unicidade do filho, append-only ate para superusuario); `check` 29/29 (+7 testes de dominio), build 8/8.

**Impacto:** `packages/domain/src/listings/{relist.ts,relist.test.ts,index.ts}` (subdominio novo), `packages/domain/src/index.ts`, migration `20260831123707`, `packages/db/src/{types.ts,rls.integration.test.ts}`, `docs/{ROADMAP,HANDOFF}.md`.

## D-160 - Preflight do relist: fail-safe por desenho -- snapshot ilegivel reprova, nunca presume

**Contexto:** segunda fatia da Fase 9. O ROADMAP pede "preflight que nunca fecha o anuncio quando pre-condicao critica falha" — fechar e IRREVERSIVEL (secao 2.16). A fatia entrega o AVALIADOR deterministico; o fio (executor que o consulta antes de fechar) nasce junto do fluxo web→api→worker, na fatia seguinte.

**Decisao 1 — cada bloqueio nasce de um fato da pesquisa, nunca de suposicao (REGRA ABSOLUTA):** `JA_REPUBLICADO` pela tag oficial `relist` (uma republicacao por pai e regra do proprio ML); `FULL_BLOQUEADO` por `inventory_id` na raiz OU em variacao (secao 2.7, exemplo oficial) — a doc de relist e silenciosa sobre o CD e o risco e prender estoque fisico; `CATALOGO_BLOQUEADO` por `catalog_listing` (silencio documental identico); `ENCADEAMENTO_NAO_DOCUMENTADO` quando o pai ja e FILHO (`parent_item_id` presente) — o caso "incerto" que a propria pesquisa registrou.

**Decisao 2 — FAIL-SAFE como contrato:** o snapshot e jsonb sem contrato de banco. Forma que nao e um item ⇒ `SNAPSHOT_ILEGIVEL`; `tags`/`catalog_listing` ilegiveis ⇒ `SNAPSHOT_INCOMPLETO` — reprovar o que nao da para VERIFICAR, nunca presumir aprovacao. A excecao e deliberada e testada: ausencia so passa onde ausencia e o caso NORMAL (`inventory_id` ausente = fora do Full; `parent_item_id` ausente = nao e filho). Mesmo espirito da recusa como contrato de D-144/D-147.

**Decisao 3 — bloqueios saem JUNTOS, aviso nunca bloqueia:** o operador ve a lista inteira de uma vez (corrigir um por vez seria a dor de CI em conta-gotas, em versao de produto). `HERANCA_NAO_OCORRE_EM_FREE` e aviso: republicar anuncio gratuito e permitido, so nao herda visitas/vendas — quem decide sabendo e o humano (PRD: nao prometer recuperacao de exposicao).

**Verificacao:** `check` 29/29 (+9 testes de dominio, incluindo o fail-safe sobre lixo e a prova do contraste ausencia-normal x ausencia-lacuna), build 8/8. Sem migration, sem rede, sem UI. 🟢 CI de D-159 (`787e885`) verde.

**Impacto:** `packages/domain/src/listings/{relist-preflight.ts,relist-preflight.test.ts,index.ts}`, `docs/{ROADMAP,HANDOFF}.md`.

## D-161 - O fio do relist comeca pela CRIACAO: a api autoriza e enfileira, o worker captura e avalia, nada destrutivo acontece

**Contexto:** terceira fatia da Fase 9. Modelo (D-159) e avaliador (D-160) prontos; o fio web→api→worker precisava nascer — e o corte deliberado e parar ANTES de qualquer escrita no Mercado Livre: esta fatia entrega o pedido humano ate o veredito do preflight, e o executor (fechar → POST → confirmar → remapear) fica para a proxima, atras de confirmacao propria.

**Decisao 1 — o desenho de D-096, reusado inteiro:** `POST /v1/listings/relist` valida (papel ADMIN/GESTOR na rota; fronteira de organizacao em codigo porque o AdminClient bypassa RLS; escopo por CONTA para nao-ADMIN — a licao de D-117; anuncio conhecido em `listings` para falhar cedo) e ENFILEIRA `relist.prepare` na fila da conta (a captura fala com o ML e disputa o rate limit daquela conta, D-036). "Nao encontrado" nunca vira "sem permissao" — a segunda resposta revelaria que a conta/anuncio existe.

**Decisao 2 — sem OPERADOR, e o porque registrado:** republicar comeca fechando um anuncio (irreversivel). E decisao de gestao, nao de atendimento — a "permissao especifica" do PRD e este par papel+conta imposto no servidor. Um flag proprio de permissao seria entidade inventada antes do primeiro caso real.

**Decisao 3 — o worker e o unico que toca o remoto, e so LE:** `relist.prepare` busca o item pelo multiget ja existente (1 id), guarda o corpo CRU como `parent_snapshot` (D-159: capturado na criacao) e roda `evaluateRelistPreflight`. Aprovado ⇒ fica REQUESTED com o evento de criacao carregando o ATOR humano; reprovado ⇒ PREFLIGHT_FAILED com `failure_reason` (descricoes) e evento SEM ator (transicao do sistema, reason = codigos). Corpo de OUTRO item falha sem retry (snapshot do anuncio errado e defeito, nao condicao transitoria). 23505 no insert = o indice parcial de D-159 fazendo o trabalho: retry do Cloud Tasks ou segundo pedido terminam em paz, sem segunda operacao.

**Decisao 4 — janela de minuto no nome da task (classe D-051):** o Cloud Tasks retem nomes por 24h; sem a janela, um pedido legitimo horas depois de uma operacao reaberta seria descartado em silencio. Dois cliques no mesmo minuto colapsam; a garantia duravel e a constraint, nao o nome.

**Falha que NAO e engolida:** se o update para PREFLIGHT_FAILED falhar, o job FALHA com retry — deixar a operacao REQUESTED aprovavel seria o oposto do veredito. Ja o evento de auditoria que falha e logado sem derrubar o job (falhar depois do insert repetiria tudo e cairia no 23505 SEM o evento — pior).

**Verificacao:** `check` 29/29 (+7 testes de worker, +4 de api), build 8/8. Sem migration, sem UI (o botao nasce com o executor — hoje o caminho e chamavel por API, como o primeiro envio de resposta foi). ⚠️ Fluxo nunca exercitado contra o ML real — e nao deve ser antes do deploy e de um ensaio deliberado.

**Impacto:** `apps/api/src/{relist.ts,relist.test.ts,app.ts,index.ts}`, `apps/worker/src/{handlers/relist-prepare.ts,handlers/relist-prepare.test.ts,index.ts}`, `docs/{API,ROADMAP,HANDOFF}.md`.

## D-162 - O executor do relist: re-entrante por ESTADO, e a janela sem idempotencia atravessada sem mentir

**Contexto:** a fatia destrutiva da Fase 9 — fechar o pai (irreversivel) e emitir o POST /relist numa API SEM idempotencia (secao 2.16). Todo o desenho existe para atravessar essa janela sem jamais mentir sobre onde parou.

**Decisao 1 — confirmacao humana em DOIS atos:** o pedido (D-161) e a execucao (`POST /v1/listings/relist/:id/execute`, D-162) sao comandos separados, ambos ADMIN/GESTOR + escopo por conta. So REQUESTED e executavel (409 fora disso); o worker re-roda o preflight NA HORA de qualquer forma — o estado do anuncio muda entre pedido e execucao (padrao D-096 de revalidar o remoto no momento do ato).

**Decisao 2 — re-entrante por estado, nunca por memoria:** cada retomada do Cloud Tasks decide pelo status persistido (maquina de D-159), e o estado e gravado ANTES do ato remoto que descreve — um crash deixa a operacao dizendo a verdade ("estava fechando", "estava republicando"), nunca um passo atras dela. Retomada em CLOSING reconfere o remoto (pai ja fechado nao repete o PUT); retomada em RELISTING vira RELIST_FAILED SEMPRE — entre persistir RELISTING e ler a resposta nao ha como saber se o filho nasceu, e repetir o POST poderia criar DOIS.

**Decisao 3 — POST falho NUNCA re-tenta** (mesma razao de D-096: um 5xx pode significar que o filho existe) e **filho so e confirmado por id DIFERENTE do pai** — o defeito registrado da propria doc (resposta com variacoes devolvendo o id do pai) nao e tratado como contrato; resposta ambigua e RELIST_FAILED, gente decide.

**Decisao 4 — transicao e CAS de verdade:** `update ... where id and status = from` com `select` conferindo QUE a linha mudou — zero linhas significa que o estado mudou sob os pes, e o job falha e rele em vez de gravar evento de transicao que nao aconteceu. Falha ao persistir STATUS falha o passo; falha so no EVENTO e logada sem derrubar (repetir o job para regravar auditoria repetiria atos remotos — o risco maior).

**Decisao 5 — o corpo do relist herda do pai AO VIVO** (price/available_quantity/listing_type_id do GET da execucao, nao do snapshot): e o contrato minimo confirmado; overrides humanos entram com a UI, com decisao propria. `PUT {status:closed}` que responde sem fechar vira CLOSE_FAILED — reabrivel, nada destrutivo aconteceu.

**Escopo declarado:** o executor PARA em RELISTED. O remapeamento (RELISTED→REMAPPED) e fatia propria: vinculo de ITEM e retargetavel; vinculo de VARIACAO nao tem mapeamento deterministico (ids renovados, sem tabela de/para na doc) e caira na fila de vinculacao existente.

**Verificacao:** `check` 29/29 (+9 testes do executor cobrindo caminho feliz, re-preflight na hora, retomadas, POST falho, resposta ambigua, CLOSE_FAILED, noop e CAS perdido; +3 do comando), build 8/8. Sem migration, sem UI. ⚠️ **NUNCA exercitado contra o ML real — a primeira execucao de verdade deve ser um ensaio humano deliberado, depois do deploy, com um anuncio sacrificavel.**

**Impacto:** `apps/worker/src/handlers/relist-execute.{ts,test.ts}` (novo), `apps/api/src/{relist.ts,relist.test.ts,app.ts}`, `apps/worker/src/index.ts`, `docs/{API,ROADMAP,HANDOFF}.md`.

## Como adicionar nova decisao

Registrar:

- ID;
- contexto;
- decisão;
- motivo;
- alternativas consideradas quando relevante;
- impacto;
- data/commit quando útil.

Não reverter decisão existente silenciosamente. Registrar nova decisão que substitui a anterior e explicar o motivo.
