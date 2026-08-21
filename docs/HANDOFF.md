# Handoff V3

> Última atualização: 2026-08-21 — **Dashboard Geral de vendas (primeira fatia da última etapa da Fase 5A) concluído e verificado rodando.** Janela fixa de 30 dias, grão organização, via a nova `get_sales_summary` (soma `daily_account_metrics` em SQL). **Próxima etapa de desenvolvimento: filtro de período + comparação de períodos, depois o Dashboard por Conta. O rebuild histórico no Dev continua proibido até os quatro backfills terminarem.**

## Estado atual

- Branch: `v3`
- Referência V2: commit `8573d971a5cd427702575b52ed249c53588ec5ca` da `main`
- V3 reconstruída como monorepo com `web`, `api`, `worker`, packages compartilhados e migrations versionadas.
- Supabase V3 Dev (`nmgccyqquwxecqffsidr`, `sa-east-1`): migrations aplicadas até `20260821190000_create_sales_summary_rpc`, `supabase migration list` confere local = remoto sem drift.
- Google Cloud V3 (`speedbikers-gestao-v3`, `southamerica-east1`): Cloud Run, sete filas Cloud Tasks (três base + quatro por conta), Scheduler, Secret Manager e Storage provisionados em Dev.
- Vercel V3: **criado e no ar**, branch `v3`.
- Monorepo e CI: criados e operacionais. Falta o ambiente de produção (Fase 8).

## Última etapa concluída

**Dashboard Geral de vendas — primeira fatia da quarta etapa da Fase 5A.**

- Escopo deliberadamente pequeno, decidido com o usuário antes de codificar: janela fixa dos últimos 30 dias, grão organização, sem seletor de período nem comparação — ambos ficam para a próxima etapa, junto do Dashboard por Conta.
- **`public.get_sales_summary(date_from, date_to, ml_account_id?)`** (migration `20260821190000_create_sales_summary_rpc.sql`): soma `daily_account_metrics` no grão organização. `docs/METRICS.md` já listava "organização" como granularidade válida de toda métrica de venda, mas as tabelas materializadas em `20260821182620` param no grão conta — esta função fecha o grão que faltava **sem duplicar cálculo**, só somando o rollup de conta que já está correto.
- **Por que somar é seguro aqui e não repete o erro que D-017 evita** (nunca somar contagem distinta de grão inferior): um `pack_id`/`order_id` pertence a exatamente uma conta do Mercado Livre — packs atravessam anúncios/SKUs dentro da mesma conta, nunca duas contas diferentes. Os conjuntos de `purchase_key` por conta são disjuntos por construção, então `SUM(purchases_count)` entre contas equivale ao `COUNT(DISTINCT)` direto no grão organização. A mesma soma entre ANÚNCIOS seria inválida (é exatamente o que o teste de equivalência da etapa anterior prova: 3 anúncios podem somar 3 enquanto o grão da conta correto dá 2, porque um pack pode ligar dois anúncios).
- `security invoker`, sem repetir `has_account_access` na função: a RLS de `daily_account_metrics` já filtra as linhas antes da soma — ADMIN vê todas as contas da organização, um papel com permissão restrita veria só o que tem acesso, automaticamente.
- **`shiftBusinessDate`** (`packages/domain/src/metrics/business-date.ts`), pura: desloca uma data de negócio (`YYYY-MM-DD`) em N dias corridos, aritmética de calendário via UTC-meia-noite (não converte fuso — deslocar dia civil independe de fuso quando o fuso não muda no meio do cálculo). 6 testes novos, incluindo virada de mês/ano e ano bissexto.
- **`apps/web/app/vendas/page.tsx`**: Server Component, Modelo A (D-012), lê `get_sales_summary` direto sob RLS. Os seis cartões batem exatamente com as seis métricas canônicas de `docs/METRICS.md` (receita bruta, unidades vendidas, pedidos, compras por pack, ticket médio, preço médio praticado). D-023 (todo número carrega o ID da sua definição): cada cartão mostra o `id` da métrica e o `title` (tooltip nativo) com a fórmula.
- **Estado "nunca calculado" distinto de "calculado e zero"**: a tela só mostra os cartões quando `get_sales_summary` devolve `last_computed_at` não nulo. Como os quatro backfills ainda não terminaram e o backfill deliberadamente não suja dia para recálculo (D-051), a janela de 30 dias hoje devolve `last_computed_at IS NULL` — a tela mostra essa explicação em vez de fingir R$ 0,00 real. Verificado rodando localmente contra o Supabase Dev real: mensagem correta, sem erro no servidor.
- **Estado "stale"**: reaproveita `classifySyncFreshness` (mesma função da Tela de Saúde da Sincronização, mesmos limiares 3h/12h) sobre `last_computed_at` em vez de duplicar uma segunda noção de frescor — o recálculo de métricas nasce do mesmo gatilho horário da reconciliação.
- **`apps/web/app/vendas/loading.tsx`**: primeiro `loading.tsx` do `web` — fallback de Suspense do App Router, cobrindo o estado "loading" do checklist junto com este.
- **`packages/db/src/types.ts` regenerado pela ferramenta oficial, não editado à mão** — pendência registrada repetidamente nas etapas anteriores desta sessão. `supabase gen types typescript --linked` funcionou (a máquina não tem Docker local confortável para `--local`, mas o CLI já estava autenticado e o projeto Dev já estava `linked`). Note: a saída da ferramenta não marca `average_ticket`/`average_selling_price`/`last_computed_at` de `get_sales_summary` como nulável mesmo podendo ser `NULL` em tempo de execução (limitação conhecida do gerador para `RETURNS TABLE` com agregação) — o código da página trata isso defensivamente mesmo sem o tipo forçar.
- **Verificado rodando**, não só em teste: login real (`pablolima83352@gmail.com`), `/vendas` carregada localmente contra o Supabase Dev real, nenhum erro no servidor, mensagem de estado vazio correta, nav com o novo link "Vendas" como primeiro item (tela âncora, D-033).
- `pnpm run check` verde nas 29 tasks; `pnpm --filter @sb/web run build` verde com `/vendas` como nova rota dinâmica.
- **Não verificado com dado real populado** (cartões com número real): os quatro backfills ainda não cobriram um dia sequer de reconciliação completa dentro da janela de 30 dias. Verificação do layout populado fica pendente até existir dado real — decisão deliberada de não inserir linha de teste em `daily_account_metrics` no Dev só para validar layout, para não arriscar interferir com o backfill/recálculo real em andamento.
- **Deliberadamente não feito**: seletor de período, comparação com período anterior, Dashboard por Conta. Ficam para a próxima etapa.

**Etapa anterior: recálculo incremental e rebuild completo — terceira etapa da Fase 5A (D-017/D-051).**

- A chave fixa diária antes documentada (`recompute:{conta}:{sku}:{data}`) era incorreta para Cloud Tasks: depois de executado ou excluído, um ID pode permanecer indisponível por até 24 horas e faria uma atualização posterior do mesmo dia desaparecer. D-051 substitui a chave por `recompute:{account-uuid}:{data-negocio}:{YYYY-MM-DDTHH:mmZ}`: o UUID evita colisão entre organizações com o mesmo slug, o burst do mesmo minuto converge, o seguinte sempre ganha ID novo e há atraso de 60 segundos.
- A unidade de invalidação é `(conta, dia de negócio em America/Sao_Paulo)`, não SKU. `private.compute_daily_sales_metrics` já produz os três grãos juntos; recalcular uma vez por conta/dia evita repetir a leitura inteira de pedidos para cada SKU alterado.
- Migration `20260821184047_create_sales_metrics_recompute.sql`: `private.refresh_daily_sales_metrics` substitui os três fatos no intervalo com um único `computed AS MATERIALIZED`; `recompute_daily_sales_metrics` expõe um dia e `rebuild_daily_sales_metrics` um intervalo. As RPCs são exclusivas de `service_role` e uma advisory lock por conta serializa incrementais concorrentes e rebuilds.
- `analytics.recompute` foi registrado no worker com payload discriminado incremental/rebuild. `sync.orders.window` só publica as datas realmente persistidas depois de concluir a janela; falha ao publicar é retryable. O backfill **não** marca dias sujos para não materializar história parcial enquanto seus quatro checkpoints ainda avançam.
- O dia de negócio foi centralizado em `toSalesMetricDate`, com testes nos limites UTC e no horário de verão histórico de São Paulo. O enqueuer do worker ganhou permissão somente na fila `analytics-recompute`; falta aplicar esse IAM e publicar o worker após a CI deste commit.
- Verificação local: reset completo aplicou as 20 migrations; 102/102 testes de integração passaram, incluindo idempotência, remoção de fatos obsoletos, concorrência real em duas conexões e bloqueio das RPCs para usuário autenticado. `pnpm run check` passou nas 29/29 tasks (130 testes de domínio, 110 do worker), o diff de schema ficou vazio e os advisors não apontaram achado novo. `EXPLAIN (ANALYZE, BUFFERS)` na fixture local ficou em aproximadamente 1,4 ms com cache aquecido para o rebuild testado.
- **Deliberadamente não feito:** nenhum rebuild histórico foi executado no Dev. O comando existe e está testado, mas continua bloqueado até as quatro contas cobrirem os 12 meses.

**Etapa anterior: fato diário de vendas e dois rollups — segunda etapa da Fase 5A (D-017/D-050).**

- Migration `20260821182620_create_daily_sales_metrics.sql`: cria `daily_listing_metrics` no grão aprovado `(conta, MLB, variação, dia)`, `daily_sku_metrics` em `(conta, SKU, dia)` e `daily_account_metrics` em `(conta, dia)`.
- `private.compute_daily_sales_metrics` é o único cálculo das três projeções: usa `GROUPING SETS`, filtra `paid`/`partially_refunded`, converte `date_created` para `America/Sao_Paulo`, ancora receita em `total_amount` e refaz `COUNT(DISTINCT order/pack)` diretamente em cada grão.
- `sku_id IS NULL` permanece como bucket de SKU; `UNIQUE NULLS NOT DISTINCT` impede bucket duplicado e faz o mesmo para anúncio sem variação. O rollup de SKU mantém `ml_account_id`, portanto ANALISTA não ganha visibilidade sobre contas sem permissão.
- As razões são colunas geradas em `numeric`, arredondadas para duas casas. `authenticated` só lê sob `has_account_access`; `service_role` é o único escritor. O cálculo privado é `security invoker`, tem `search_path` vazio e não é executável por `anon`/`authenticated`.
- Verificação local: reset completo aplicou as 19 migrations; 98/98 testes de integração passaram. A fixture crítica prova que dois anúncios somam 3 ocorrências de compra, mas o grão direto da conta retorna 2 packs — o rollup não mascara a não aditividade. Advisors não apontaram achado novo; permanecem apenas avisos preexistentes.
- **Deliberadamente não feito:** nenhum dado histórico foi materializado no Dev. O backfill de 12 meses continua sendo pré-condição para executar o rebuild, embora o mecanismo de recálculo possa ser construído e testado agora.

**Etapa anterior: catálogo canônico das métricas de venda — primeira etapa da Fase 5A (D-023/D-050).**

- `docs/METRICS.md` agora define, sem lacunas, `unidades_vendidas`, `receita_bruta`, `pedidos`, `pedidos_por_pack`, `ticket_medio` e `preco_medio_praticado`.
- Semântica aprovada: `paid` + `partially_refunded`; bruto ancorado em `orders.total_amount`; compra por `pack_id` com fallback tipado para `order_id`; dia civil de `date_created` em `America/Sao_Paulo`; `sku_id IS NULL` permanece nos totais.
- Migration `20260821181121_create_metric_definitions.sql` aplicada no Dev: seis definições globais, RLS de leitura somente para membro autenticado, `anon` sem GRANT e nenhum papel da aplicação com escrita. O gerador remoto confirmou que `packages/db/src/types.ts` coincide com o schema.
- Verificação: `pnpm run check` verde (29/29 tasks), migration aplicada localmente sem reset, 87/87 testes de integração RLS, seis definições conferidas no Dev e advisors sem achado novo causado pela tabela.

**Validação operacional das quatro contas e correção de infraestrutura pós-OAuth.**

- As quatro contas estão `CONNECTED`, com `seller_id` distintos, credenciais cifradas e `last_error IS NULL`. Não reaproveitaram state antigo: os novos states continham verifier PKCE e foram consumidos corretamente.
- Não aparecer novamente o botão azul de consentimento é compatível com autorização já concedida à aplicação; a prova real é a troca de token e o uso subsequente, ambos confirmados.
- Primeiro problema pós-conexão encontrado nos logs: `v3-worker-runtime` tinha `cloudtasks.enqueuer` na fila `backfill`, mas não podia agir como `v3-tasks-invoker`; o lote inicial persistia dados e falhava ao criar o próximo. `infra/setup-dev.sh` agora concede `roles/iam.serviceAccountUser` ao worker na service account invocadora, além da API.
- Segundo problema: as quatro filas `ml-sync-<slug>` ainda não existiam. Foram criadas por `infra/cloud-tasks-queues.sh`, com `v3-api-runtime` como enqueuer por fila. O Scheduler foi disparado de novo e as quatro execuções `sync.orders.window` terminaram `done` (518 pedidos processados no primeiro ciclo), zero falhas após o reparo.
- O backfill retomou e segue encadeando em baixa prioridade; as quatro contas já têm pedidos reais. Falhas IAM históricas continuam em `job_runs` por ser L2 append-only e não devem ser apagadas.
- D-048 foi confirmado empiricamente: `date_last_updated` difere de `last_updated` na maioria dos pedidos reais; manter o primeiro como checkpoint está correto.

**Etapa anterior: reparo do OAuth Mercado Livre — PKCE S256 (D-049).**

- Sintoma real: as 13 tentativas distribuídas pelas quatro contas chegaram ao callback público, mas todas terminaram em `400 rejected`; `ml_credentials` permaneceu vazia.
- Causa confirmada por Cloud Logging + estado do banco + documentação oficial: o endpoint de token recusava a troca com `invalid_request` porque a V3 não enviava `code_challenge` nem `code_verifier`, embora PKCE estivesse habilitado. Redirect URI, client ID e referências dos secrets no Cloud Run estavam corretos.
- `packages/mercado-livre/src/oauth.ts`: `createPkcePair()` gera verifier base64url novo por autorização e challenge SHA-256; o token endpoint já suportava `code_verifier` e agora recebe o valor em todo connect.
- `apps/api/src/ml-accounts.ts`: o início grava o verifier cifrado com AES-256-GCM em `ml_oauth_states` e envia somente o challenge S256; o callback consome o state atomicamente, decifra o verifier e o usa na troca. State legado sem verifier falha fechado e pede para reiniciar a conexão.
- Migration aditiva `20260821180000_add_ml_oauth_pkce_verifier.sql` aplicada no Supabase Dev. Os 13 states legados foram preservados; `anon` e `authenticated` continuam sem qualquer GRANT na tabela. Os tipos locais foram comparados com os tipos gerados do schema remoto e coincidem.
- Código versionado no commit `cf2b25e` e publicado no Cloud Run como revisão `api-00010-hvz`, pronta e com 100% do tráfego. `GET /health` respondeu `200`; nenhum log `ERROR` surgiu na revisão após o deploy.
- Verificação local: `pnpm run check` verde nas 29 tasks; 119 testes na API e 53 no pacote Mercado Livre. Testes novos provam a relação verifier/challenge, a cifra em repouso, o envio do verifier correto e a recusa de state legado sem chamar o token endpoint.
- **Validação concluída:** as quatro autorizações novas terminaram e as quatro contas executaram reconciliação real com sucesso.

**Etapa anterior: aplicação completa dos quatro imports reais do UpSeller e reparação das contas ML no Dev.**

- Causa confirmada no Cloud Logging: em 2026-08-20, a revisão `worker-00002-p4k` respondeu `400 unknown_job_type` para `erp.import.parse`; as três tentativas de cada Cloud Task se esgotaram antes de o worker com o handler ser publicado.
- Os quatro objetos continuavam íntegros no bucket `speedbikers-gestao-v3-erp-imports`; nenhum reupload foi necessário.
- Os parses foram reenfileirados para o worker atual e terminaram em `PARSED`: `PRODUCTS` 3.415/3.415 OK; `KITS` 272/272 OK; `LINKS` 20.650 OK + 3.274 `SKIPPED` por D-037; `STOCK` 3.372/3.372 OK; **zero `INVALID`**.
- Nota de observabilidade da recuperação manual: as quatro tasks usaram IDs aleatórios distintos, mas o PowerShell interpolou o `dedupe_key` do envelope como `erp-parse:-20260821` nas quatro linhas de `job_runs`. Os `job_id`, payloads e batches permaneceram distintos e corretos; não houve impacto no parse. O histórico L2 não foi reescrito para maquiar a operação.
- Aplicados pela tela `/importacoes`, nesta ordem, com validação no banco após cada lote:
  - `PRODUCTS`: `APPLIED`, 3.415/3.415 aplicadas, zero não resolvidas; `skus = 3.416` (3.415 do arquivo + o SKU de teste já existente).
  - `KITS`: `APPLIED`, 272/272 aplicadas, zero não resolvidas; `sku_components = 272`.
  - `LINKS`: `APPLIED`, 20.650/20.650 aplicadas, zero não resolvidas; 3.274 `SKIPPED` por D-037; `sku_listing_links = 20.650` e `link_candidates = 0`.
  - `STOCK`: `APPLIED`, 3.372/3.372 aplicadas, zero não resolvidas; `erp_stock_snapshots = 3.372`, todos com `sku_id` resolvido.
- **Defeito encontrado e corrigido na aplicação de `LINKS`:** `storeLabel()` prometia remover o prefixo completo `mercado-ML-`, mas removia apenas o trecho até o primeiro hífen (`mercado-`). O parser e os testes agora removem o prefixo completo, produzindo os slugs `speedbikers-loja-1`, `speedbikers-loja-2`, `sbmotos` e `gmr`; os demais marketplaces mantêm a remoção simples do próprio prefixo.
- Consequência original no Dev: o import havia criado quatro placeholders `PENDING` (`ml-speedbikers-loja-1`, `ml-speedbikers-loja-2`, `ml-sbmotos`, `ml-gmr`) e os 20.650 vínculos apontavam para eles, em vez das quatro contas manuais já usadas nas tentativas OAuth.
- **Reparação versionada:** migration `20260821171728_repair_imported_ml_account_slugs.sql`, transacional e com asserções fail-closed. Moveu 6.160 + 5.020 + 4.742 + 4.728 vínculos para as contas manuais correspondentes e removeu somente os quatro placeholders vazios. Antes de aplicar, a migration foi executada inteira sob `BEGIN`/`ROLLBACK` contra o estado real; depois foi publicada por `supabase db push` e validada novamente.
- Estado final conferido no banco: `skus = 3.554` (3.415 produtos + 138 kits + 1 SKU de teste), `sku_components = 272`, `sku_listing_links = 20.650`, `link_candidates = 0`, `erp_stock_snapshots = 3.372` e zero snapshots sem `sku_id`. Restam exatamente quatro `ml_accounts`, todas as manuais; os 13 estados OAuth existentes foram preservados, `ml_credentials` continua vazia e nenhuma conta está `CONNECTED`.
- Verificação: `pnpm run check` verde nas 29 tasks; `@sb/domain` com 123 testes; `supabase db push --linked --dry-run` confirma o banco remoto atualizado. Os advisors foram relidos e não apontam achado causado por esta migration de dados; os avisos preexistentes seguem fora do escopo desta reparação.
- Prevenção no repositório: `infra/deploy-cloud-run.sh` agora publica o consumidor (`worker`) antes do produtor (`api`) quando os dois são implantados juntos. Assim uma API nova não emite tipo de job para um worker antigo.

**Próximo passo de desenvolvimento:** Dashboard Geral concluído (janela fixa de 30 dias, sem filtro). Falta: seletor de período + comparação com período anterior na mesma tela, depois o Dashboard por Conta (mesmo `get_sales_summary`, passando `p_ml_account_id`). Os quatro checkpoints de backfill seguem incompletos — não executar rebuild histórico até terminarem.

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

## Pendência técnica externa — resolvida em 2026-08-21

~~Antes de congelar o capítulo de sincronização é preciso confirmar a documentação oficial atual do Mercado Livre: tópicos de webhook disponíveis, mecanismo oficial de recuperação de notificação perdida, política de rate limit vigente e modelo de autorização multi-conta.~~

Confirmado. `docs/MERCADO_LIVRE.md` secoes 2.1 a 2.9 registram cada item com fonte e data de consulta. Três decisões novas fecham as consequências arquiteturais: **D-041** (autorização multi-conta é OAuth padrão repetido por conta, feito pelo ADMIN — não existe fluxo "autoriza todas de uma vez"), **D-042** (rate limit não tem número oficial publicado — filas mantêm valor conservador, ajustado por `429` observado) e **D-043** (validação de origem do webhook por allowlist de IP, sem HMAC). Único item da lista de verificação ainda aberto é visitas/Ads, necessário só na Fase 5B (D-032) e que não bloqueia a Fase 3.

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

## Fase 2 — concluída

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
- **O Supabase concede `EXECUTE` a `anon` e `authenticated` por padrão em toda função nova do schema `public`** — via default privileges do projeto, não via o pseudo-papel `PUBLIC`. `revoke ... from public` na migration original de `resolve_link_candidate`/`dismiss_link_candidate` não bastou: o linter de segurança (`get_advisors`) achou `anon` com `EXECUTE` nas duas, já em Dev, logo depois do deploy. Não era explorável — as duas reautenticam por dentro e `auth.uid()` é nulo para `anon` — mas GRANT é a primeira barreira, não a segunda (`docs/DATABASE.md` secao 5). Corrigido por migration nova: `revoke execute ... from anon, authenticated` explícito, seguido do `grant` só para `authenticated`. **Toda função nova em `public` precisa desse revoke explícito desde a primeira migration**; funções em `private` não têm esse risco porque o PostgREST não expõe esse schema.
- **`ON DELETE CASCADE` numa tabela append-only é uma contradição que só aparece na hora de apagar.** `sync_runs`/`sync_errors` tinham `ml_account_id ... on delete cascade`; como a trigger append-only recusa TODO `DELETE` — inclusive o disparado por cascata de FK —, apagar a conta (ou a organização, em cascata mais acima) passou a falhar sempre que existisse pelo menos uma linha de histórico. Trocado para `on delete restrict`, que torna o bloqueio explícito em vez de a cascata quebrar no meio com um erro sem relação aparente com a causa. Pego pelos próprios testes de integração, não em produção.

## Próximo passo

**Fase 2 — Core de dados: CONCLUÍDA.** Identidade, contas, catálogo, importador do UpSeller (upload → aplicação), Central de Vinculações e o schema de observabilidade de sincronização — todos os itens do checklist em `docs/ROADMAP.md` estão marcados.

**Concluído nesta sessão:** o comando de aplicação; o ETL da V2 (D-027), encerrado por evidência medida (D-040); a Central de Vinculações, verificada num navegador real; e o schema de `sync_runs`/`sync_errors` — a última pendência real da fase.

**Schema de observabilidade de sincronização (`sync_runs`/`sync_errors`) — concluído nesta sessão:**

- Migrations `20260821010000_create_sync_observability.sql` e `20260821020000_lock_down_link_candidate_rpcs.sql` (a segunda corrige um achado de segurança da Central de Vinculações — ver a armadilha registrada acima).
- Mesmo padrão L2 append-only de `job_runs`, mas já com policy de leitura por `has_account_access`: é observabilidade **para o usuário** (`docs/ARCHITECTURE.md` secao 10), não só depuração interna.
- `resource` (`orders`/`listings`/`fulfillment`) e `channel` (`webhook`/`reconciliation`/`backfill`) nomeiam só o que já está aprovado em `docs/ARCHITECTURE.md`/`docs/MERCADO_LIVRE.md` — nenhum campo de payload do Mercado Livre antecipado.
- **Puramente schema**: nenhum código escreve nessas tabelas ainda. O sync do Mercado Livre é Fase 3.
- **10 testes novos de integração de RLS** (83 no total, de 73): constraints (`finished_after_started`, `reason_matches_status`), o trigger append-only recusando `UPDATE` e `DELETE` mesmo do dono, RLS positiva/negativa nas duas tabelas, e os dois negativos novos de `anon` sem `EXECUTE` nas RPCs da Central de Vinculações.

**Fase 3 está em andamento** — a documentação oficial do Mercado Livre foi confirmada (D-041 a D-043), o cliente `@sb/mercado-livre` e o webhook (D-044, D-045) já estão prontos. Ver as seções "Documentação do Mercado Livre confirmada" e "Fase 3 em andamento" abaixo. Próximo item do checklist: reconciliação por janela via Cloud Scheduler.

**Central de Vinculações — concluída e verificada nesta sessão:**

- Migration `20260821000000_create_link_candidates.sql`: tabela `link_candidates` (uma referência sem vínculo por linha de origem, `unique(source, source_row_id)`) e duas RPCs `security definer` — `resolve_link_candidate` (confirmação humana: cria `sku_listing_links` e fecha o candidato na mesma transação) e `dismiss_link_candidate`. As duas refazem a autorização internamente (`is_member_of` + `has_account_access` + `has_role(['ADMIN','GESTOR','OPERADOR'])`) porque `security definer` ignora GRANT e RLS — a função não pode conceder mais acesso do que a escrita direta já concederia.
- `apps/worker/src/handlers/erp-import-apply.ts`: `applyLinks` registra um candidato sempre que uma linha fica `UNRESOLVED` por falta de SKU. Nova função `reconcileLinkCandidates`, chamada ao fim de **toda** aplicação (não só LINKS): relê os candidatos `OPEN` da organização sobre as mesmas linhas de origem — se um PRODUCTS/KITS recém-aplicado criou o SKU que faltava, o vínculo nasce sozinho, `resolution_method = 'EXACT_MATCH'`, sem tela nem humano. Best-effort: falhar a reconciliação não derruba o resultado do lote que já foi aplicado.
- `apps/web/app/vinculacoes/`: tela lista candidatos `OPEN`; busca de SKU direto do navegador sob RLS; confirmar/descartar são **Server Actions** (`docs/ARCHITECTURE.md` secao 4 já previa "confirmar vínculo" como exemplo) chamando as RPCs — nunca escrita direta na tabela.
- **2 testes novos no worker** (fake, cobrindo o registro do candidato e a resolução automática por match exato) e **13 na integração de RLS contra Postgres real** (73 no total, de 60) — incluindo os negativos obrigatórios (sem acesso à conta, sem o papel certo, escrita direta recusada) e a prova de que a confirmação é atômica.
- **Verificado num navegador real**, não só em teste: usuário de teste criado via Admin API, login real, busca de SKU, clique em "Vincular" → `sku_listing_links` criado com `source = MANUAL`, candidato fechado com `resolved_by` do usuário logado; "Descartar" também verificado. Consultado direto no Postgres local depois, não só na tela.

**Tudo commitado e em `origin/v3`:** as duas migrations de observabilidade de sincronização e os testes de integração associados foram commitados junto com a atualização deste documento (commit `bce81b3`). A Central de Vinculações, o comando de aplicação, o fix de infra do `worker` e a correção D-040 de sessões anteriores também já estavam em `origin/v3`.

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
5. **Importador do UpSeller** e **ETL de carga inicial da V2** (D-027) — **concluído**.
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
   - ✅ **ETL de carga inicial da V2 (D-027) — encerrado por evidência medida, não por código.** Inspecionado o banco real da V2 (`speedbikers-gestao-v2`, ref `eeramcpouarfwagxigtz`): `product_inventory_links` (vínculos, 3.158 linhas) é 100% `source = 'upseller'`/`confidence = 'exact'` — sem curadoria humana distinta do que o importador da V3 já reproduz, e com **menos** cobertura (3.158 aplicados na V2 contra 20.650 vínculos brutos de ML no export atual). `stock_movements`, `product_inventory_balances` e `stock_receipts` (NF-e): **0 linhas** — funcionalidade que existia no schema da V2 e nunca foi usada. Único dado real: **1 pedido de compra**, 5 itens, 8 eventos — adiado para a Fase 4, quando `purchase_orders` existir na V3. Registrado como **D-040**, com a tabela completa em `docs/DECISIONS.md`.
6. **Central de Vinculações** — **concluído**. Tabela `link_candidates` + RPCs `resolve_link_candidate`/`dismiss_link_candidate` (`security definer`, autorização refeita internamente). O worker registra um candidato sempre que um vínculo fica pendente por falta de SKU, e reconcilia todos os candidatos abertos da organização ao fim de **toda** aplicação — match exato sem tela. Tela em `/vinculacoes` com busca de SKU sob RLS e confirmação/descarte por Server Action. Verificado num navegador real, login incluído, com o resultado conferido direto no Postgres.
7. **Observabilidade de sincronização** (`sync_runs`/`sync_errors`) — **concluído**. Schema L2 append-only com policy de leitura por conta, pronto para a Fase 3 escrever. Nenhum código escreve ainda — é a última peça de schema da Fase 2, e fecha o checklist inteiro.

**Fase 2 encerrada.** Ver `docs/ROADMAP.md` para o checklist completo. `docs/MERCADO_LIVRE.md` secao 1 — o que faltava confirmar antes da Fase 3 — foi resolvida na sequência desta mesma sessão, ver seção abaixo.

**Leitor de planilha escolhido:** `read-excel-file` (2,5 MB) em vez de `exceljs` (21,8 MB), porque o worker só lê. Medido nos arquivos reais: 23.925 linhas em 647 ms com 176 MB de RSS, folgado nos 512 MB do container. Usar `readSheet`, não o export padrão — na v9 o padrão devolve o array de planilhas.

**Números conferidos na validação ponta a ponta:** 20.650 vínculos de ML (13.299 com variação, 3.579 sem, 3.772 user products) e 3.274 descartados por decisão (D-037); 4 contas derivadas — `speedbikers-loja-1`, `speedbikers-loja-2`, `sbmotos`, `gmr`; 138 kits; 184 produtos descontinuados; 296 importados; 64 categorias reduzidas a **19 marcas**.

**Regra desta fase:** toda tabela nasce com RLS habilitada, GRANT mínimo explícito e **teste negativo** provando que quem não tem permissão não lê. Ver `docs/DATABASE.md` secao 5 e `docs/TESTING.md`.

## Documentação do Mercado Livre confirmada (2026-08-21)

Pesquisa feita diretamente em `developers.mercadolivre.com.br` (PT-BR), com URL e data citadas para cada afirmação — nenhum comportamento foi presumido. Fechou 11 dos 12 itens da lista de verificação de `docs/MERCADO_LIVRE.md` secao 1; só visitas/Ads ficou de fora, porque só é necessário na Fase 5B (D-032).

**Achado mais importante — autorização multi-conta (secao 2.2, D-041):** confirmado que não existe um fluxo OAuth diferente para múltiplas contas. É o Authorization Code Grant padrão, repetido **uma vez por loja**, e quem faz esse login precisa ser **administrador daquela conta ML específica** (colaborador recebe `invalid_operator_user_id`). Depois de autorizada uma vez, a conta nunca mais pede reautenticação — a aplicação guarda `access_token`/`refresh_token` no servidor e renova sozinha. Isso confirma que o schema de `ml_accounts`/`ml_credentials`/`ml_oauth_states` da Fase 2 já está certo, sem precisar de ajuste.

**Segundo achado — rate limit sem número oficial (secao 2.3, D-042):** a documentação não publica RPM nem cabeçalhos `X-RateLimit-*`/`Retry-After` — só confirma controle por `client_id`+endpoint e recomendação de backoff com jitter. D-036 ficou "aguardando confirmação de um número" que **não existe**; os valores das filas `ml-sync-<conta>` continuam conservadores, ajustados por `429` observado em `sync_errors`.

**Terceiro achado — validação de origem do webhook (secao 2.6, D-043):** só existe allowlist de 8 IPs publicados, nenhuma assinatura HMAC (essa existe só para Mercado Pago, produto diferente — risco real de confundir os dois, encontrado durante a própria pesquisa).

Também confirmados com detalhe de endpoint, paginação e payload: tópicos de webhook e formato de notificação (secao 2.4), recuperação de notificação perdida via `missed_feeds` — retenção de só 2 dias (secao 2.5), endpoints/paginação de pedidos e itens (secao 2), estoque Full (secao 2.7), promoções e catálogo (secao 2.8), e escopos/permissões funcionais de OAuth (secao 2.9).

**Avisos operacionais não bloqueantes, mas a não esquecer ao implementar:** a partir de 30/08/2026 o Mercado Livre exige aplicações separadas entre Mercado Livre e Mercado Pago; `GET /orders/{id}/shipments` muda de formato (vista única → sempre array) no fim de setembro/2026 — o parser do worker deve nascer já no formato novo.

## Fase 3 em andamento

**Concluído nesta sessão: `packages/mercado-livre` (`@sb/mercado-livre`).** Primeiro item do checklist da Fase 3 (`docs/ROADMAP.md`).

- `src/oauth.ts` — `buildAuthorizationUrl` (domínio `.com.br`, fixo — a Speed Bikers só opera contas MLB), `exchangeCodeForToken` e `refreshAccessToken`. Corpo `application/x-www-form-urlencoded` (não JSON) e schema de resposta/erro confirmados por leitura direta da página oficial (`docs/MERCADO_LIVRE.md` secao 2.2), não só pela pesquisa inicial — o Content-Type exato não estava na primeira pesquisa e valia a pena verificar antes de codificar, dado que é o mecanismo do qual a Fase 3 inteira depende.
- `src/http-client.ts` — `createMercadoLivreClient`: **um cliente, N contas** — o `access_token` é passado por chamada (`request({ accessToken, ... })`), nunca preso na instância, porque o worker itera várias contas com o mesmo cliente.
- `src/retry.ts` / `src/errors.ts` — backoff exponencial com "full jitter", honra `Retry-After` quando presente (a documentação não garante que ele exista — ver D-042), e classificação de erro em `retryable`/`retryable_eventual`/`not_retryable`, os mesmos três valores que `sync_errors.error_class` aceita no banco.
- `src/pagination.ts` — `paginateOffset`, genérico para `/orders/search` e `/users/{id}/items/search`. Comentário explícito no código: isto é o mecanismo de UMA chamada, não a estratégia de checkpoint entre execuções — o checkpoint real do motor de sync (ainda não construído) deve ser por data/`date_last_updated`, nunca por offset persistido (é exatamente o bug que a V2 teve).
- **Testes**: 43, incluindo — para OAuth e para o cliente HTTP — um teste dedicado provando que `access_token`, `refresh_token` e `client_secret` nunca aparecem na mensagem nem no corpo de um erro lançado (mesmo padrão de `packages/db/src/admin-client.test.ts`).
- Package segue exatamente a convenção dos demais (`package.json`/`tsconfig.json`/`tsconfig.build.json`/`eslint.config.js` idênticos em forma a `packages/observability`); nenhuma mudança em `turbo.json` ou `pnpm-workspace.yaml` foi necessária.

**Achado à parte, fora do escopo desta etapa:** a task `lint` do `turbo.json` não declara `dependsOn: ["^build"]` (diferente de `typecheck`/`test`, que declaram). Rodar `pnpm run check` do zero, antes de qualquer build local, falhou com uma avalanche de erros `@typescript-eslint/no-unsafe-*` no `apps/worker` — não por bug real, mas porque `@sb/domain` ainda não tinha `dist/` nesta máquina e o lint com checagem de tipo não esperou o build. `pnpm run build` seguido de `pnpm run check` confirma que está tudo verde (28 tasks). Registrado como sugestão separada, não corrigido aqui para não misturar com o commit do cliente ML.

**Concluído em seguida, nesta sessão: `POST /webhooks/mercado-livre`.** Segundo item do checklist da Fase 3.

- `apps/api/src/ip-allowlist.ts` — allowlist dos 8 IPs do Mercado Livre (D-043). `extractClientIp` pega o **penúltimo** elemento de `X-Forwarded-For`, não o primeiro: confirmado na documentação oficial do Google Cloud HTTPS Load Balancing que o load balancer acrescenta `<client-ip>,<load-balancer-ip>` no fim da lista e não verifica nada antes disso — o primeiro IP é exatamente o que o próprio cliente forjaria. Nenhuma página do Cloud Run confirma isso especificamente; marcado como **D-045** com um comentário "PENDENTE" no código pedindo verificação contra o log real do Cloud Run em Dev antes de confiar nisso em produção.
- `apps/api/src/webhook.ts` — `mercadoLivreNotificationSchema` (Zod, aceita `_id` ou `id` conforme o tópico), `receiveWebhook`: resolve a conta por `seller_id = notification.user_id` (busca indexada, não é a "chamada de rede" que a regra proíbe — essa é sobre não chamar o Mercado Livre, não sobre nunca tocar o próprio Postgres) e enfileira `sync.webhook.received` na fila `ml-sync-<conta>` (D-036), com `dedupeKey = ml-webhook:{resource}` — notificações repetidas do mesmo recurso colapsam numa só, **independente do tópico**, exatamente como `docs/ARCHITECTURE.md` secao 10 descreve.
- **Sem tabela de landing para a notificação crua** — decisão nova, **D-044**: o corpo da própria Cloud Task é o registro durável, mesmo padrão de `erp.import.parse`/`erp.import.apply`. O handler que vai processar `sync.webhook.received` (decidir por `topic` o que buscar no Mercado Livre) é trabalho futuro — depende do "Motor de diff e domain_events", mais adiante no checklist da Fase 3.
- `apps/api/src/app.ts`: `/webhooks/mercado-livre` **não passa** pelo middleware de OIDC (`/internal/*`) nem pelo de JWT (implícito em `/v1/*`) — só pela allowlist de IP, registrada como seu próprio `app.use("/webhooks/*", ...)`. Contrato de resposta completo em `docs/API.md` secao 2.
- **25 testes novos** (9 em `ip-allowlist.test.ts`, 8 em `webhook.test.ts`, 8 adicionados a `app.test.ts` — 78 no total da `api`, de 53), incluindo o teste que evita repetir o bug da V2: prova que a allowlist de IP do webhook **não vaza** para `/internal` (Cloud Tasks continua exigindo OIDC) nem para `/v1` (upload continua exigindo JWT) mesmo com a allowlist configurada, e que `/webhooks/outra-coisa` (vizinha dentro do próprio namespace) continua 404.
- `pnpm run check` verde nas 28 tasks do monorepo depois da mudança.

**Concluído em seguida, nesta sessão: conexão OAuth de conta (`POST /v1/ml-accounts/connect` + `GET /oauth/mercado-livre/callback`).** Não era item nomeado explicitamente no checklist da Fase 3 — descoberto como lacuna real ao começar a reconciliação por janela: sem uma conta `CONNECTED` de verdade, não existe token para chamar o Mercado Livre, e nenhum código anterior escrevia em `ml_credentials`. Discutido com o usuário antes de expandir o escopo; ver a resposta em `docs/DECISIONS.md` D-046.

- **D-046 — cifra dos tokens**: AES-256-GCM (`node:crypto`), formato `base64(iv || authTag || ciphertext)`. Chave de `ML_TOKEN_ENCRYPTION_KEY` (32 bytes base64), validada no boot da `api` — chave com tamanho errado derruba o processo no start, não na primeira conexão real. `packages/mercado-livre/src/token-cipher.ts` (`encryptToken`/`decryptToken`/`loadEncryptionKey`), 8 testes incluindo detecção de adulteração pelo `authTag` do GCM e prova de que o ciphertext nunca contém o texto claro.
- `apps/api/src/ml-accounts.ts`: `startConnect` grava um `state` de CSRF em `ml_oauth_states` (expira em 15 min) e devolve a `authorizationUrl`; `completeConnect` **consome o `state` atomicamente** — um único `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()`, não `SELECT` seguido de `UPDATE`, para que duas chamadas concorrentes com o mesmo `state` (aba duplicada, retry do navegador) só deixem uma passar. Troca o `code`, cifra os tokens, grava `ml_credentials` (`upsert` por `ml_account_id` — PK não parcial, seguro diferente da armadilha de `sku_listing_links`) e marca a conta `CONNECTED`. Qualquer falha depois da troca de código marca a conta `ERROR` com `last_error` preenchido, em vez de deixá-la presa em `PENDING` sem explicação.
- A conta em si (`ml_accounts`) continua sendo criada pelo `web` direto sob RLS (só ADMIN escreve) — a `api` só entra quando o segredo entra: `client_secret` do Mercado Livre e a chave de cifra nunca podem chegar ao navegador.
- **13 testes novos em `ml-accounts.test.ts`** (estado inválido/expirado/consumido, negação de consentimento, falha de troca de token, cifra nunca vazando texto claro em log) e **mais testes em `app.test.ts`** cobrindo os dois papéis de rota: `/v1/ml-accounts/connect` exige ADMIN e é coberto por CORS/JWT como o resto de `/v1/*`; `/oauth/mercado-livre/callback` é pública de propósito (nem JWT nem allowlist de IP — é o navegador do ADMIN, não o Mercado Livre chamando servidor a servidor) e prova explicitamente que não herda a allowlist do webhook nem o JWT de `/v1`. 107 testes na `api` no total (de 78).
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança.
- **Ainda não construído**: a tela do `web` para criar `ml_accounts` e disparar o connect (o botão "Conectar"). A rota existe e está testada; falta só a UI — pequeno, não bloqueia a reconciliação por janela, que só precisa que a conta exista e esteja `CONNECTED`, o que hoje só é alcançável via chamada direta à `api` (curl/Postman) até a tela nascer.

**Concluído em seguida, nesta sessão: reconciliação por janela (`POST /internal/schedule/reconcile` + `sync.orders.window`).** Quarto item do checklist da Fase 3 — a "rede de segurança do que o webhook perdeu" (`docs/MERCADO_LIVRE.md` secao 3).

- **Filtro de data confirmado por leitura direta da documentação oficial antes de codificar** (`developers.mercadolivre.com.br`, "Gerencie vendas → Orders", 2026-08-21): `order.date_last_updated.from`/`.to`, e o texto cita literalmente "usa até a hora e descarta a informação dos minutos, segundos e milissegundos". Consequência no desenho: `from` arredonda para baixo até a hora cheia, `to` para cima — nunca minutos não-zero saem daqui, e a sobreposição resultante é aceita de propósito (processamento idempotente) em vez de arriscar perder um registro por causa de um arredondamento não documentado do próprio Mercado Livre.
- `apps/api/src/reconcile.ts`: lista contas `CONNECTED` (todas as organizações) e enfileira `sync.orders.window` por conta, dedupe por `sync-orders:{slug}:{hora-cheia}`. Rodar o Scheduler mais de uma vez por hora não gera chamada extra ao Mercado Livre — o Cloud Tasks recusa o nome repetido.
- `apps/worker/src/handlers/sync-orders-window.ts` — o handler em si:
  - **Checkpoint por `sync_runs.latest_record_at`** da última execução bem-sucedida (`resource='orders'`, `channel='reconciliation'`), nunca offset persistido. Se a última execução não trouxe nada novo (`latest_record_at` nulo), usa `started_at` dela como piso — perder zero é seguro, ficar preso reprocessando o mesmo intervalo para sempre não seria.
  - **Renovação de token com trava atômica**: um único `UPDATE ml_credentials ... WHERE refresh_locked_until IS NULL OR refresh_locked_until < now()`, mesmo padrão do consumo de `state` em `ml-accounts.ts` — necessário porque o `refresh_token` é de uso único (`docs/MERCADO_LIVRE.md` secao 6) e um refresh concorrente sem trava invalidaria o token que a outra execução ainda ia usar.
  - Falha classificada (`retryable`/`retryable_eventual`/`not_retryable`, `docs/API.md` secao 6) e gravada em `sync_runs`(`status='failed'`)/`sync_errors` — **primeiro código a escrever de verdade nessas tabelas**, que nasceram só-schema na Fase 2.
  - **Não persiste pedidos ainda** — só busca, conta e observa. A tabela estruturada (`orders`/`order_items`, `pack_id`) é o próximo item do checklist, de propósito separado (mesmo padrão incremental "schema primeiro, escrita depois" já usado aqui).
- `infra/cloud-scheduler.sh`: novo job `v3-reconcile-orders`, `0 * * * *` — uma vez por hora é suficiente porque o próprio filtro do Mercado Livre só tem granularidade de hora cheia.
- **Achado replicado do incidente do `ERP_IMPORTS_BUCKET`** (ver a armadilha registrada nesta sessão, acima): `infra/deploy-cloud-run.sh` original só passava `MERCADO_LIVRE_CLIENT_ID`/`MERCADO_LIVRE_REDIRECT_URI` no ramo da `api`. Como o `worker` agora também chama o Mercado Livre (renovação de token), a checagem `[ -n "${MERCADO_LIVRE_CLIENT_ID}" ] || fail ...` foi movida para ANTES do `if [ "${app}" = "api" ]`, cobrindo os dois ramos — corrigido antes do primeiro deploy real, não depois de um incidente.
- **34 testes novos** (16 em `sync-orders-window.test.ts`, 5 em `reconcile.test.ts`, 3 em `app.test.ts`) — cobrindo checkpoint com/sem execução anterior, renovação de token bem-sucedida/travada/falha, paginação somando `items_processed`, classificação de erro do Mercado Livre, e prova de que token/segredo nunca aparecem em log. 115 testes na `api` (de 107), 64 no `worker` (de 48).
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança.

**Concluído em seguida, nesta sessão: backfill retomável (`backfill.orders`).** Quinto item do checklist da Fase 3 — a história que a reconciliação por janela não cobre (ela só avança para frente do checkpoint).

- **Decisão de arquitetura, confirmada com o usuário antes de construir**: quem dispara o PRÓXIMO pedaço é o próprio `worker`, se reenfileirando (fila `backfill`), e não o Cloud Scheduler batendo de hora em hora. Motivo: um pedaço por hora prenderia 12 meses de história (≈52 pedaços de 7 dias) a até 52 horas; auto-encadeamento respeita só o throughput real da fila (1/s, 2 simultâneas) e termina em minutos. Custo aceito: o `worker` ganhou uma capacidade nova — enfileirar no Cloud Tasks — que só existia na `api` até agora. Registrado em `docs/ARCHITECTURE.md` secao 11 e `docs/DEPLOYMENT.md` secao 4 como exceção explícita, não regra geral.
- **Refatorado antes de estender**: a lógica de renovar token (`ensureAccessToken`) e de buscar uma janela de pedidos (paginação + `latest_record_at`) saiu de `sync-orders-window.ts` para `apps/worker/src/handlers/ml-token.ts` e `ml-orders-fetch.ts` — o backfill precisa exatamente da mesma coisa, só com `from`/`to` calculados diferente. As 16 tests de `sync-orders-window.test.ts` continuaram passando sem alteração depois do refactor, confirmando que o comportamento não mudou.
- **Migration `20260821030000_add_ml_accounts_backfill_checkpoint.sql`**: `ml_accounts.backfill_covered_until` — checkpoint L1 (estado atual, mutável), deliberadamente separado de `sync_runs` (L2, histórico de cada execução). `NULL` = nunca começou; `>= connected_at` = terminou. **Tipos de `packages/db/src/types.ts` editados à mão** — Supabase CLI/Docker não estava disponível nesta sessão para `pnpm run gen:types`; conferir contra o schema real assim que possível.
- `apps/worker/src/handlers/backfill-orders.ts`: pedaços de 7 dias, começando em `now - 12 meses` (retenção do Mercado Livre, `docs/MERCADO_LIVRE.md` secao 2.5) quando `backfill_covered_until` é nulo. Cada pedaço bem-sucedido avança o checkpoint e, se ainda houver história antes de `connected_at`, enfileira o próximo com dedupe `backfill-orders:{slug}:{checkpoint-ISO}` — mesmo padrão de nome-de-task-como-checkpoint já documentado em `docs/API.md`. Falha não avança o checkpoint nem reenfileira; o Cloud Tasks repete o MESMO pedaço via seu próprio retry, nada é pulado.
- `apps/worker/src/enqueue.ts` (novo): mesma forma de `apps/api/src/enqueue.ts`, duplicado de propósito em vez de extraído para pacote comum — os dois apps ficam livres para divergir em formato de deploy sem se acoplarem, e o arquivo é pequeno o bastante para a duplicação não doer.
- `apps/api/src/ml-accounts.ts`: `completeConnect` agora dispara o primeiro pedaço do backfill (dedupe `backfill-orders:{slug}:start`) logo depois de marcar a conta `CONNECTED` — best-effort, uma falha ao enfileirar não desfaz a conexão já gravada (fica só um log `backfill_not_triggered` para acompanhar manualmente).
- `infra/cloud-tasks-queues.sh`: `v3-worker-runtime` ganha `roles/cloudtasks.enqueuer`, só na fila `backfill`. `infra/deploy-cloud-run.sh`: o `worker` passou a aprender a própria URL (mesma dança de duas fases que a `api` já fazia para conhecer a URL uma da outra) e recebeu `GCP_PROJECT_ID`/`GCP_REGION`/`WORKER_URL`/`TASKS_INVOKER_SERVICE_ACCOUNT`.
- **34 testes novos** (12 em `backfill-orders.test.ts`, mais os ajustes em `ml-accounts.test.ts`/`app.test.ts` para a nova dependência `enqueuer`). 117 testes na `api` (de 115), 78 no `worker` (de 64).
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança.

**Concluído em seguida, nesta sessão: persistência estruturada de pedidos (`orders`/`order_items`).** Sexto item do checklist da Fase 3 — a entidade de análise que `pack_id`, `sku_id` e o dashboard de vendas (Fase 5A) vão precisar.

- **Achado antes de codificar, corrigindo código já em produção nesta mesma sessão (D-048)**: o exemplo oficial de `/orders/search` (mesma página confirmada para a reconciliação) mostrou os campos `date_last_updated` e `last_updated` na MESMA order com valores DIFERENTES (2020 vs. 2019), sem nenhuma prosa explicando a diferença. `sync-orders-window.ts`/`backfill-orders.ts` já estavam em produção usando `last_updated` para o checkpoint. Corrigido para `date_last_updated` (bate o nome com o filtro `order.date_last_updated.from/to`) **antes de qualquer deploy real ter rodado com o campo errado** — achado durante o desenvolvimento, não em produção. Pendente de verificação empírica em Dev, mesma disciplina de D-045.
- **Vocabulário de `status` confirmado na documentação oficial**, não inventado: os 9 valores (`confirmed`, `payment_required`, `payment_in_process`, `partially_paid`, `paid`, `partially_refunded`, `pending_cancel`, `cancelled`, `invalid`) viraram a constraint `orders.status` — a mesma página que documenta o filtro documenta o vocabulário completo do campo.
- **Confirmado antes de desenhar o schema**: `/orders/search` devolve o objeto COMPLETO por resultado (igual a `GET /orders/{id}`, incluindo `order_items`) — sem isso, o desenho assumiria uma chamada extra por pedido que não existe.
- Migration `20260821040000_create_orders.sql`: `orders` (PK = id nativo do Mercado Livre, sem uuid surrogate — é um identificador externo já estável) e `order_items` (uuid, sem id próprio do Mercado Livre por linha — reprocessar um pedido faz `delete` + `insert` de todas as linhas, mesmo padrão de `erp_import_rows`). `order_items.ml_account_id` denormalizado de `orders` de propósito, mesmo padrão de `sync_errors` — RLS direta sem join.
- **D-020 aplicado**: `apps/worker/src/handlers/persist-order.ts` resolve `sku_id` por `sku_listing_links` (mesma forma de índice parcial já usada na Central de Vinculações: `.is("variation_id", null)` quando o item não tem variação) e grava `sku_id`/`sku_listing_link_id` congelados na linha — nunca recalculado por join na leitura.
- **Resiliência por linha, não por lote**: `client.request()` valida a resposta inteira de uma vez, então uma order com formato inesperado no meio de uma página de 50 não pode derrubar a página inteira. `ml-orders-fetch.ts` valida `results` frouxo na chamada HTTP e faz o parse estrito (`orderSchema.safeParse`) item a item — order inválida vira `itemsSkipped`, loga `order_parse_failed` e a execução termina com `sync_runs.status = 'partial'` (a constraint já esperava esse valor desde a Fase 2, nunca usado até agora).
- **Estado atual, registrado honestamente em `docs/DATABASE.md`**: `orders` já muda de status (`UPDATE` em lugar) mas ainda não emite evento — isso é o motor de diff/`domain_events`, o PRÓXIMO item do checklist, de propósito separado. Persistência da estrutura veio primeiro, mesmo padrão incremental já usado em `sync_runs`/reconciliação/backfill nesta mesma sessão.
- Não atômico entre `orders` e `order_items` (três chamadas de rede separadas) — aceito pelo mesmo motivo de sempre: o pedido é reprocessado a cada janela, uma falha no meio se autocorrige sozinha.
- **`packages/db/src/types.ts` editado à mão de novo** — mesma pendência já registrada para `backfill_covered_until`.
- **Refatorado**: `ml-orders-fetch.ts` ganhou `db`/`organizationId`/`mlAccountId`/`logger` nos parâmetros — `fetchOrdersWindow` agora persiste cada order conforme a página chega, além de contar. `sync-runs.ts`: `recordSyncRunSuccess` ganhou `status`/`reason` opcionais para suportar `partial`.
- **31 testes novos** (9 em `persist-order.test.ts`, mais os ajustes de fixture em `sync-orders-window.test.ts`/`backfill-orders.test.ts` para o novo formato de order e os dois novos testes de persistência/`partial` em cada um). 89 testes no `worker` (de 78).
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança.

**Concluído em seguida, nesta sessão: motor de diff e `domain_events` com `dedup_key`.** Sétimo item do checklist da Fase 3 — falta só a Tela de Saúde da Sincronização.

- **`domain_events`** (migration `20260821050000_create_domain_events.sql`): L2 append-only, `before`/`after` jsonb, `dedup_key` UNIQUE (D-016). Mesmo mecanismo de `job_runs`/`sync_runs` — trigger recusa `UPDATE`/`DELETE` mesmo para `service_role`. RLS de leitura por `has_account_access`, escrita só `service_role`.
- **Catálogo de eventos espelhado em código**: `packages/domain/src/events/catalog.ts` transcreve a tabela de `docs/API.md` secao 4 — `listing.price.changed` fica de fora de propósito (severidade condicional à magnitude da mudança, regra ainda não definida; não adivinhar).
- **Primeiro detector: `order.cancelled`** (`packages/domain/src/events/order-events.ts`, PURO — sem banco, sem rede, testável com objetos simples). Compara o `status` gravado antes do upsert contra o novo; emite só na transição PARA `cancelled`/`pending_cancel`, nunca reemite se já estava cancelado (idempotente por natureza, antes até do `UNIQUE` do banco fazer a mesma coisa na camada de baixo). `pending_cancel -> cancelled` não gera um SEGUNDO evento — mesma notícia, já contada.
- **`order.returned` fica de fora, registrado explicitamente**: devolução no Mercado Livre é modelada via `order_request.return`/API de Reclamações e Devoluções, que `orders` ainda não persiste. Implementar exigiria essa API — fora do escopo desta etapa, não esquecido.
- **`occurred_at` usa `orders.date_last_updated`**, não `now()` — quando a mudança aconteceu de verdade, relevante principalmente no backfill (pode estar processando um cancelamento de meses atrás).
- `apps/worker/src/handlers/persist-order.ts`: lê o `status` existente ANTES do upsert (é o "before" do diff), chama `detectOrderStatusEvents` depois de upsertar, grava os rascunhos via `recordDomainEvents` (novo `apps/worker/src/handlers/domain-events.ts`) — best-effort DE PROPÓSITO, mesmo padrão de `job_runs`: falha ao gravar evento não derruba uma persistência de pedido que já deu certo. Conflito de `dedup_key` (Postgres `23505`) nem é logado como erro — é a deduplicação funcionando.
- **Decisão de escopo, não uma nova decisão formal**: o diff roda INLINE dentro de `sync.orders.window`/`backfill.orders`, não como job `events.detect` separado (esse tipo de job, já documentado em `docs/API.md`, existiria para o caminho do webhook — decidir por `topic` o que buscar e enfileirar `events.detect` por entidade — trabalho futuro, que também depende de uma busca de pedido único (`GET /orders/{id}`) ainda não construída).
- **`packages/db/src/types.ts` editado à mão pela terceira vez** — mesma pendência de `gen:types`.
- **20 testes novos** (7 em `order-events.test.ts`, puro, em `packages/domain`; 6 a mais em `persist-order.test.ts` cobrindo emissão/não-emissão/idempotência/conflito; 4 em `domain-events.test.ts`). 99 testes no `worker` (de 89).
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança.

**Concluído em seguida, nesta sessão: Tela de Saúde da Sincronização (`/sincronizacao`).** Oitavo e último item do checklist da Fase 3 — **a fase inteira está concluída**.

- `apps/web/app/sincronizacao/page.tsx`: Server Component só-leitura, direto no Supabase sob RLS (Modelo A, D-012) — nenhuma rota nova na `api`. Por conta: rótulo, status de conexão (`PENDING`/`CONNECTED`/`REVOKED`/`ERROR`) e, quando `CONNECTED`, o frescor de pedidos e a contagem de `sync_errors` nas últimas 24h. Seção "Eventos recentes" lista os `domain_events` mais novos de todas as contas — **primeiro consumidor real** de toda a observabilidade construída ao longo desta sessão (`sync_runs`, `sync_errors`, `domain_events` já existiam; nada lia).
- **`classifySyncFreshness`** (`packages/domain/src/events/freshness.ts`, puro, testado): classifica a idade de `sync_runs.latest_record_at` em `ok` (≤3h) / `atencao` (≤12h) / `critico` (>12h) / `nunca_sincronizado`. Limiares dão folga à cadência real da reconciliação (no máximo uma vez por hora) antes de soar alarme — não é métrica do catálogo oficial (`sync.delayed`/`sync.failed` de `docs/API.md` continuam não implementados como eventos), é a mesma noção calculada direto de `sync_runs`.
- Consultas em paralelo por conta (`Promise.all`), cada uma um `order by finished_at desc limit 1` — exatamente o padrão que o índice `sync_runs_freshness_idx` (Fase 2) já foi desenhado para sustentar, confirmado pelo próprio comentário da migration na época.
- **`apps/web` ganhou `@sb/domain` como dependência** — antes só `@sb/db`; é a primeira vez que o `web` consome lógica pura do domínio diretamente (a Central de Vinculações não precisou).
- **Verificada num navegador real** (login ADMIN de verdade, `pablolima83352@...`, papel confirmado na tela): a rota carrega, autentica e renderiza os DOIS estados vazios corretamente (nenhuma conta ML, nenhum evento) — o banco Dev não tem nenhuma conta Mercado Livre conectada ainda. Os cards com dado (frescor calculado, linha de evento) **não foram vistos com dado real** — verificados por build + typecheck + lint + revisão de código, seguindo o mesmo padrão de tokens (`--sb-*`) e estrutura já testado visualmente em `/vinculacoes` e na Home.
- **Achado incidental, fora do escopo desta tarefa, registrado para investigar depois**: a tela `/importacoes` mostra os 4 lotes reais do UpSeller (produtos, kits, vínculos, estoque) com estado **"Enviado"**, não "Aplicado" — sugerindo que a aplicação desses lotes (que criaria as `ml_accounts`/`sku_listing_links` mencionadas em sessões anteriores) nunca rodou de fato neste banco Dev específico, só foi validada localmente/contra fixture. Não investigado nem corrigido agora — spawned como tarefa separada (ver chip).
- `.claude/launch.json` criado (config do `web-dev`, porta 3000) e `apps/web/.env.local` criado localmente (não versionado) com `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` fornecidas pelo usuário — chave publicável, não sensível, mas o arquivo continua fora do git (`.env.*` no `.gitignore`).
- **5 testes novos** em `packages/domain` (`freshness.test.ts`, puro). 122 testes no `domain` (de 117); nenhuma mudança em `api`/`worker`.
- `pnpm run check` verde nas 29 tasks do monorepo depois da mudança; `pnpm --filter @sb/web run build` verde com a rota `/sincronizacao` gerada.

## Bloqueios atuais

- **Dashboard Geral concluído** (`/vendas`, janela fixa de 30 dias). Nenhum bloqueio para o próximo incremento (filtro de período, comparação, Dashboard por Conta). A visualização com dado histórico real depende do término dos quatro backfills e do rebuild explícito posterior.
- `domain_events` já é lido pela tela `/sincronizacao`, mas ainda não alimenta notificações (`docs/NOTIFICATIONS.md`) nem a Central de Ações. Esses consumos são Fase 6/7.
- **As quatro contas Mercado Livre estão `CONNECTED` e reconciliaram pedidos reais.** O backfill de 12 meses segue em andamento na fila de baixa prioridade; não iniciar o rebuild histórico das métricas até os quatro checkpoints terminarem.
- **Imports do UpSeller em 2026-08-21:** `PRODUCTS`, `KITS`, `LINKS` e `STOCK` estão `APPLIED`, todos com zero linhas não resolvidas. Os 20.650 vínculos apontam para as quatro contas manuais corretas; não há placeholders `ml-*` nem candidatos pendentes.
- **D-048 validada empiricamente em Dev:** os dois timestamps divergem na maioria dos pedidos reais e as quatro reconciliações terminaram usando `date_last_updated` como checkpoint.
- **Tipos do banco regenerados em 2026-08-21:** `packages/db/src/types.ts` foi gerado novamente após as duas migrations de fatos e recálculo; reset completo e diff local sem alterações confirmam a cadeia versionada.
- **Provisionamento de conta nova ainda tem um passo de infraestrutura:** criar `ml-sync-<slug>` com `bash infra/cloud-tasks-queues.sh <slug>` antes do OAuth. As quatro filas atuais já existem. Automatização fica para a identidade de provisionamento da Fase 8; a API pública não recebe `queueAdmin`.
- O Scheduler `v3-reconcile-orders` está `ENABLED`, dispara de hora em hora e já concluiu uma reconciliação real nas quatro contas.
- **D-045 precisa de verificação empírica em Dev** (inspecionar o `X-Forwarded-For` real recebido pelo Cloud Run) antes de considerar a allowlist de IP confiável em produção — não bloqueia a Fase 5A, mas bloqueia declarar o webhook pronto para tráfego real do Mercado Livre.
- Modelos de exportação do pedido de compra (Excel e PDF) precisam ser solicitados antes da Fase 4.
