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
