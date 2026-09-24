# Catálogo de métricas — Speed Bikers Gestão V3

> Dono documental de: definição oficial de cada métrica.
> Este documento é **normativo**. Se um número na interface discorda daqui, o número está errado.
> Status: **regras canônicas, métricas de vendas e de tráfego aprovadas.** Métricas de estoque e Ads permanecem para a Fase 5B.

---

## 1. Regra central

**Todo número exibido na interface carrega o ID da sua definição** (D-023). O tooltip mostra fórmula, fonte, granularidade, timezone e tratamento de cancelamento.

A tabela `metric_definitions` espelha este documento no banco para alimentar a interface. **Este arquivo é a fonte; a tabela é o espelho.** Divergência entre os dois é bug.

Uma métrica significa a mesma coisa nas quatro telas (Geral, Conta, SKU, Anúncio) por construção, não por disciplina.

---

## 2. Regras canônicas

Valem para todas as métricas, sem exceção.

| Regra | Definição |
|---|---|
| **Timezone** | Dia civil em `America/Sao_Paulo`, com helper canônico único e testado |
| **Grão base** | `daily_listing_metrics` — `(ml_account_id, mlb_id, variation_id, metric_date)` |
| **Rollups** | `daily_sku_metrics` — `(ml_account_id, sku_id, metric_date)`, incluindo o bucket `sku_id IS NULL` — e `daily_account_metrics` — `(ml_account_id, metric_date)` — gerados pelo **mesmo código**, com teste de equivalência na CI |
| **Aritmética** | `numeric` no Postgres, com arredondamento explícito antes de cruzar para o JavaScript |
| **Agregação** | Sempre em SQL. **Zero agregação em JavaScript** |
| **Recomputabilidade** | Toda métrica é reconstruível de L1+L2. L3 nunca é fonte única |
| **Materialização** | A L3 **converge**, não é reescrita (D-199): `insert ... on conflict do update ... where a linha DIFERE`, mais um `delete` por anti-join do que deixou de existir. Linha igual não vira `UPDATE`, não gera WAL e não deixa tupla morta |
| **Cancelamento e devolução** | Cada definição declara explicitamente se inclui, exclui ou estorna |
| **Escopo da IA** | Análise por IA respeita exatamente o filtro selecionado pelo usuário |

*Motivo da materialização convergente (D-199):* a forma anterior apagava o
intervalo inteiro da conta e reinseria tudo. Medido no Dev, isso custava
**485 mil escritas por dia** entre `daily_listing_metrics` e
`daily_sku_metrics` — onze vezes a rotatividade de `job_runs` — porque um dia
com 355 linhas era reescrito inteiro toda vez, disparado por **0 a 4 pedidos**
que tinham mudado naquela hora. O resultado era correto; o custo é que não
era. **O retorno das RPCs mudou de contrato junto:** era "linhas inseridas"
(sempre o dia inteiro) e passou a ser "linhas efetivamente escritas"
(inseridas + atualizadas + removidas). Um recompute que não muda nada agora
reporta `0` — e isso é a verdade, não uma falha.

*Motivo do timezone canônico:* a V2 teve bug de limite de dia por fazer operações UTC em pontos que representavam datas de negócio, e chegou a manter cinco cópias do mesmo helper de data.

*Motivo da aritmética:* na V2, `numeric` do Postgres virando `double` do JavaScript e passando por `ceil` produziu 25 divergências em 76 linhas na sugestão de compra. Ambas as correções foram de representação numérica, não de fórmula.

---

## 3. Fato importante sobre receita

A auditoria da V2 mediu, contra produção, que `sum(total_amount)` e `sum(unit_price * quantity)` divergem em **exatamente zero** — R$ 5,8 milhões em 52.594 pedidos, sem um único pedido divergente.

A razão é estrutural: o Mercado Livre **não entrega pedido multi-linha**. Uma compra de vários itens vira vários pedidos ligados por `pack_id`. Com uma linha por pedido, o rateio é matematicamente um no-op.

**Consequência para a V3:** ancorar receita em `total_amount` e **não construir lógica de rateio**. Se o formato do Mercado Livre mudar, a âncora já está no campo certo.

---

## 4. Modelo de definição

Toda métrica é registrada com estes campos:

```text
id                 identificador estável, usado pela interface
nome               rótulo exibido
formula            expressão inequívoca
fonte              tabelas e colunas de origem
granularidades     um ou mais de: anúncio | SKU | conta | organização
inclusoes          o que entra
exclusoes          o que não entra
cancelamentos      incluído | excluído | estornado
timezone           America/Sao_Paulo
atualizado_em      data da última revisão desta definição
```

---

## 5. Métricas

### 5.1 Semântica comum das métricas de venda

- **Venda válida:** `orders.status IN ('paid', 'partially_refunded')`.
- **Data de negócio:** dia civil de `orders.date_created` em `America/Sao_Paulo`.
- **Receita bruta:** `orders.total_amount`; reembolso parcial não reduz o bruto. Receita líquida/estornada só entra quando a fonte de devoluções e reembolsos estiver integrada.
- **Compra real:** `pack_id` quando existe; caso contrário, `order_id`. A chave tipada (`pack:<id>` ou `order:<id>`) evita colisão numérica.
- **Grãos:** toda métrica é calculada diretamente no grão solicitado. Contagens distintas e razões nunca são obtidas somando ou fazendo média de um grão inferior.
- **SKU não vinculado:** permanece nos totais de conta/organização e forma um bucket `sku_id IS NULL`; não desaparece do faturamento.

### 5.2 Vendas e receita — definições aprovadas em 2026-08-21

| ID | Nome | Fórmula | Fonte | Granularidades | Inclusões | Exclusões | Cancelamentos |
|---|---|---|---|---|---|---|---|
| `unidades_vendidas` | Unidades vendidas | `SUM(order_items.quantity)` | `orders.status`, `orders.date_created`, `order_items.quantity` e dimensões congeladas de `order_items` | anúncio, SKU, conta, organização | Vendas válidas | Demais status e devoluções sem fonte integrada | excluído |
| `receita_bruta` | Receita bruta | `SUM(orders.total_amount)` | `orders.status`, `orders.date_created`, `orders.total_amount` | anúncio, SKU, conta, organização | Vendas válidas; `partially_refunded` pelo bruto | Taxas, frete, custo, devoluções e estornos | excluído |
| `pedidos` | Pedidos do Mercado Livre | `COUNT(DISTINCT orders.id)` | `orders.id`, `status`, `date_created` | anúncio, SKU, conta, organização | Cada `order_id` válido uma vez | Demais status; não agrupa packs | excluído |
| `pedidos_por_pack` | Compras por pack | `COUNT(DISTINCT CASE WHEN pack_id IS NULL THEN 'order:' || id ELSE 'pack:' || pack_id END)` | `orders.id`, `pack_id`, `status`, `date_created` | anúncio, SKU, conta, organização | `pack_id` como compra; `order_id` como fallback | Demais status; soma de contagens de grão inferior | excluído |
| `ticket_medio` | Ticket médio | `receita_bruta / NULLIF(pedidos_por_pack, 0)` | Componentes canônicos acima | anúncio, SKU, conta, organização | Mesmas vendas válidas | Média de médias | excluído |
| `preco_medio_praticado` | Preço médio praticado | `receita_bruta / NULLIF(unidades_vendidas, 0)` | Componentes canônicos acima | anúncio, SKU, conta, organização | Mesmas vendas válidas | Média simples de preços e média de médias | excluído |

`pedidos_por_pack` existe porque `pack_id` é a unidade de compra real do cliente — a V2 tinha o campo mas não a agregação.

### 5.3 Estoque e cobertura — fonte disponível, definição pendente da Fase 5B

`estoque_local` · `estoque_full_por_conta` · `reservado` · `em_transito` · `disponivel` · `cobertura_dias` · `data_estimada_ruptura` · `venda_media_diaria_30`

`disponivel` **nunca** é a soma cega dos quatro estados. Local, Full, reservado e em trânsito têm autoridades diferentes (ver `docs/DATABASE.md`), e a definição declara exatamente o que compõe cada um.

### 5.4 Derivadas e comparativas — definição pendente da Fase 5B

`curva_abc` · `tendencia` · `vendas_perdidas_estimadas`

> **`variacao_percentual_periodo` e `comparacao_periodo_anterior` saíram desta seção em 2026-09-23 (D-394)**, com `variacao_pontos_percentuais`: as definições, as janelas e o tom estão em **5I**.

`vendas_perdidas_estimadas` é **estimativa com premissa explícita**, nunca apresentada como fato. A premissa aparece junto do número.

### 5.5 Dependentes de fonte ainda não confirmada

> **`margem_contribuicao` saiu desta seção em 2026-09-23 (D-395)**: imposto (alíquota com vigência) e Ads têm fonte, e a definição está em **5K**.

> **`investimento_ads`, `receita_ads` e `acos` saíram desta seção em 2026-09-16 (D-363)**, com `roas` e `tacos`: a fonte (API oficial de Product Ads) foi confirmada e as definições estão em **5G**.

**Escopo definido:** Ads entra depois; `margem_contribuicao` depende de custo cadastrado por SKU. A margem **sobre custo** entrou em D-356 como `margem_venda` (5F) — antes de impostos e de Ads; `margem_contribuicao` continua aqui até impostos e Ads terem fonte. Enquanto a fonte não existir, o diagnóstico **não distingue queda de tráfego de queda de conversão sem dizer que não distingue** — declara, em vez de inferir.

Nenhuma dessas será exibida enquanto a fonte não estiver confirmada e a definição preenchida. **Métrica sem fonte confirmada não vai para a tela.**

> **`visitas` e `taxa_conversao` saíram desta seção em 2026-08-31 (D-170).** O texto tinha envelhecido: a fonte foi confirmada em D-032, `daily_listing_visits` está em produção e a coleta foi corrigida em D-156 — mas as duas apareciam na tela **sem definição canônica**, exatamente o que a regra central proíbe. As definições estão em **5D**, abaixo.

### 5G. Mercado Ads — Product Ads (D-363)

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `investimento_ads` | Investimento em Ads | `SUM(daily_ads_campaign_metrics.cost)` | API de Product Ads, detalhe da campanha com `aggregation_type=DAILY`, gravado por `sync.ads.campaigns` | Só Product Ads (sem Brand/Display). Dia sem linha é **métrica não lida**, não investimento zero. A API só guarda 90 dias |
| `receita_ads` | Vendas com Ads | `SUM(daily_ads_campaign_metrics.total_amount)` (diretas + indiretas) | idem | É a **atribuição do Mercado Livre** aos cliques; a doc não diz se venda cancelada sai depois |
| `acos` | ACOS | `investimento_ads / NULLIF(receita_ads, 0)` | componentes acima | Fração; sobre as somas, nunca média de campanhas. NULL sem venda |
| `roas` | ROAS | `receita_ads / NULLIF(investimento_ads, 0)` | componentes acima | **Venda sobre investimento, não lucro** — a tela diz isso ao lado. NULL sem investimento |
| `tacos` | TACoS | `investimento_ads / NULLIF(receita_bruta, 0)` | `investimento_ads` + `receita_bruta` (5.2) das mesmas contas e dias | Todo o investimento contra toda a receita das vendas válidas |

Granularidades: `account` e `organization`. O grão gravado é (conta, campanha, dia), mas `campaign` não está entre as granularidades do catálogo — a lista por campanha da tela usa as mesmas fórmulas por campanha.

### 5D. Métricas de tráfego (D-032 na fonte, catalogadas em D-170)

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `visitas` | Visitas do anúncio | `SUM(daily_listing_visits.visits)` | `GET /visits/items` do Mercado Livre, por dia, gravado por `sync.listing-visits.snapshot` (D-032; coleta corrigida em D-156) | Grão de **anúncio**, nunca de SKU. Dia sem coleta é **ausência de observação**, não zero visita — a tela mostra em quantos dias houve coleta |
| `taxa_conversao` | Taxa de conversão do anúncio | `SUM(pedidos nos dias com visita observada) / NULLIF(SUM(visitas), 0)` | `daily_listing_metrics.orders_count` (nosso ledger) sobre `daily_listing_visits.visits` (Mercado Livre) | **Fração**, como `taxa_cancelamento` — a tela formata em percentual. Sem visita observada a taxa é **NULL**, nunca 0%. Não é conversão de sessão nem funil do ML |

**Por que o numerador é restrito aos dias observados.** As duas pontas da razão vêm de fontes diferentes, com coberturas diferentes: os pedidos existem todo dia, as visitas só nos dias em que o job rodou. Medido no Dev em 2026-08-31, sobre agosto: **11 dias de coleta contra 31 de pedidos**, e a fórmula antiga (janela inteira ÷ visitas parciais) produzia **93 anúncios com conversão acima de 100%, o maior com 2.900%**. Restringir o numerador ao mesmo recorte do denominador zera os 93 e faz o máximo cair para exatamente 1,0000. É o princípio do subconjunto coberto de D-166 aplicado a tráfego: **numerador e denominador do mesmo recorte, e a cobertura declarada ao lado do número**.

**Grão de SKU não existe de propósito.** A fonte é por MLB. Somar visitas de anúncios distintos para um SKU exigiria vínculo completo — e vínculo incompleto viraria denominador incompleto, que é o defeito que esta definição acabou de corrigir.

---

## 5B. Métricas de SAC (Fase 7B, D-115)

> Definições canônicas ANTES de exibir, como manda a regra central. Todas
> agregadas em SQL (`get_support_metrics`, `security invoker` — a RLS de
> `support_cases` decide o escopo por chamador), snapshot ou janela de N
> dias. Fonte: `support_cases` · `support_messages` · `support_case_deadlines`.

| id | nome | fórmula | ressalvas |
|---|---|---|---|
| `sac_abertos` | Atendimentos abertos | `count(support_cases) where internal_status <> 'RESOLVIDO'` — snapshot, também por canal | — |
| `sac_aguardando_loja` | Aguardando a loja | abertos onde a bola está conosco: `QUESTION` aberta sempre conta; conversa/claim conta quando `last_inbound_at > coalesce(last_outbound_at, -infinity)` | — |
| `sac_mediacoes_abertas` | Em mediação | abertos com `is_mediation` | mediação = `stage='dispute'` (D-104) |
| `sac_prazos_24h` | Prazos nas próximas 24h | `support_case_deadlines` `ACTIVE` com `due_at` entre agora e +24h | prazo remoto real (D-107); computado NA LEITURA — o job de `BREACHED` continua não existindo, e ler não muda estado |
| `sac_prazos_vencidos` | Prazos vencidos | `ACTIVE` com `due_at < now()` | idem; "vencido" aqui é leitura, a linha continua `ACTIVE` |
| `sac_novos_periodo` | Novos no período | `created_at >= now() - N dias`, por canal | ⚠️ `created_at` é o relógio da INGESTÃO, não do nascimento remoto. Para CLAIM, a série só é confiável a partir de **2026-08-28** (D-109 completou a ingestão; o primeiro dia contém o backfill de ~244) |
| `sac_resolvidos_periodo` | Resolvidos no período | `resolved_at >= now() - N dias` | `resolved_at` mistura relógios por desenho (triagem humana = `now()`; auto-resolve D-102 = relógio do ML) — serve para contagem, não para duração |
| `sac_mediana_primeira_resposta_horas` | Primeira resposta (mediana) | mediana de `primeiro OUTBOUND − primeiro INBOUND` por case, `QUESTION`/`POST_SALE_MESSAGE`, primeiro INBOUND dentro do período | os dois lados usam `occurred_at` (relógio do ML) — consistente. **CLAIM fica fora**: o transcript é um piso (D-106) e mensagem de mediador é `SYSTEM`. Caso raro excluído: loja falou ANTES do cliente (o primeiro OUTBOUND precede o INBOUND) |

**Deliberadamente NÃO definidas nesta fatia:**

- **Tempo médio de resolução** — exigiria `nascimento remoto − resolução`, e hoje `created_at` é ingestão local enquanto `resolved_at` mistura relógios: para um claim backfilled o resultado seria **negativo**. Entra quando houver um `opened_at` remoto persistido por case.
- **Reincidência, produtividade por responsável, atendimentos por SKU** — sem definição inequívoca ainda; ver requisito ("quando matematicamente correto" / "quando fizer sentido operacionalmente").

## 5C. Métricas propostas para a evolução dos dashboards (D-120) — CINCO IMPLEMENTADAS EM D-157

> Registradas aqui ANTES de qualquer tela, como manda a regra central. Nenhuma
> vai para a interface enquanto a fonte não estiver confirmada e a ressalva
> não estiver visível ao lado do número.
>
> **D-157 (2026-08-31)**: `taxas_ml`, `pedidos_cancelados`, `taxa_cancelamento`,
> `valor_cancelado` e `skus_distintos_vendidos` implementadas — RPC
> `get_sales_expanded_summary` (security invoker), seção "Cancelamentos e
> taxas" em `/vendas` com a ressalva de cada uma VISÍVEL no card, definições
> espelhadas em `metric_definitions`. **Refinamento registrado**: a taxa de
> cancelamento calcula os DOIS lados (cancelados e válidos) da mesma leitura
> de `orders` (L1) — misturar cancelados de L1 com o `pedidos` de L3
> embutiria o atraso do recálculo na razão (0,1% medido no dia da entrega).
> Segue bloqueada com o motivo nomeado: `valor_estoque` (5C.4 — espera o
> ensaio de `/produtos`). Todas as demais métricas de 5C.2 estão
> implementadas (D-157/D-158/D-165/D-166) — **o item de Vendas do PRD está
> COMPLETO**.

### 5C.1 O veto: "receita líquida" não é um nome permitido

A pesquisa oficial (`docs/MERCADO_LIVRE.md` secao 2.15) confirmou que dá para compor **bruto − comissão − frete do vendedor** (até D-356 a composição também subtraía o **desconto bancado pelo vendedor** — medido: ele já está dentro de `unit_price`, e subtraí-lo contava duas vezes), mas que ficam de fora, por lacuna da própria documentação: a composição de `sale_fee` (a doc nunca diz se a taxa fixa está dentro), a taxa fixa por pedido, a taxa de parcelamento, o custo de cobrança do Mercado Pago, os impostos retidos no MLB e os reembolsos posteriores.

Chamar isso de "receita líquida" afirmaria que o número fecha com o extrato — e ele não fecha. O nome canônico é **`margem_operacional_pedido`**, e a interface exibe a lista do que NÃO entra junto do valor.

A conciliação real só existe no ciclo mensal de `/billing/integration/...`, que o próprio Mercado Livre diz não servir como fonte primária de gestão de vendas. Portanto **duas visões distintas e declaradas**, nunca uma só.

### 5C.2 Definições

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `taxas_ml` | Taxas do Mercado Livre | `SUM(order_items.sale_fee × quantity)` sobre vendas válidas | `order_items.sale_fee`, a tarifa de **uma unidade** (100% preenchido, medido; por unidade desde D-356 — antes a soma ignorava a quantidade) | É a **comissão de venda**. Não inclui frete, taxa fixa, parcelamento nem impostos |
| `margem_operacional_pedido` | Margem operacional | `receita_bruta − taxas_ml − frete_vendedor − desconto_vendedor`, **sobre pedidos COBERTOS** | `orders` + `order_items.sale_fee` + `order_financials` (D-165) | **IMPLEMENTADA em D-166** (`get_sales_margin_summary` + seção em `/vendas`): computada SÓ sobre pedidos com frete observado (D-356: o desconto do vendedor já está no preço e deixou de ser subtraído), receita/taxas do MESMO subconjunto, cobertura declarada ao lado (cobertos ÷ válidos), zero cobertura = NULL. **Não é receita líquida** (5C.1) — a tela lista o que não entra. Componentes `frete_vendedor`/`desconto_vendedor` catalogados junto |
| `pedidos_cancelados` | Pedidos cancelados | `COUNT(DISTINCT orders.id) where status in ('cancelled','pending_cancel')` | `orders.status` | `pending_cancel` conta como cancelado (mesma semântica de `order.cancelled`, `@sb/domain`) |
| `taxa_cancelamento` | Taxa de cancelamento | `pedidos_cancelados / NULLIF(pedidos_cancelados + pedidos, 0)` | idem | Denominador = **elegíveis** (válidos + cancelados), não só válidos. **Cancelamento ≠ devolução ≠ reembolso ≠ mediação** — ver 5C.3 |
| `valor_cancelado` | Valor cancelado | `SUM(orders.total_amount)` dos cancelados | `orders.total_amount` | Valor **pedido**, não valor estornado — a V3 não observa o estorno financeiro |
| `skus_distintos_vendidos` | SKUs distintos vendidos | `COUNT(DISTINCT sku_id)` calculado NO GRÃO PEDIDO | `daily_sku_metrics` | **Nunca somar de grão inferior** (D-017/D-050). Exclui o bucket `sku_id IS NULL` — e esse bucket é 21,8% dos itens em 30 dias |
| `valor_estoque` | Valor do estoque | `SUM(quantity × skus.purchase_cost)` | `inventory_balances` + `skus.purchase_cost` | 🔴 **BLOQUEADA** — ver 5C.4 |
| `catalogo_nao_classificado` | SKUs nunca classificados | `COUNT(*) WHERE stock_is_virtual_set_at IS NULL` | `skus` | ✅ D-133 — visível em `/produtos` |
| `catalogo_estoque_virtual` | SKUs com saldo sentinela | `COUNT(*) WHERE stock_is_virtual` | `skus` | ✅ D-133 — visível em `/produtos` e `/cobertura` |

**Sobre `catalogo_nao_classificado` (D-133):** o id aparece ao lado do número na tela, e a definição depende de uma distinção que a coluna sozinha não faz. `stock_is_virtual = false` significa **duas** coisas antes de D-133: "examinado e aprovado como físico" e "ninguém olhou". Quem conta o segundo caso é `stock_is_virtual_set_at IS NULL` — inclusive para o SKU que o próximo import criar, que nasce `false` por default. Contar pelo valor em vez de pela data daria "catálogo 100% classificado" no dia seguinte a uma planilha nova.

### 5C.3 Cancelamento, devolução, reembolso e mediação são quatro coisas

Três mecanismos independentes, nenhum consolidado numa visão financeira:

- **Cancelado** — `orders.status in ('cancelled','pending_cancel')` + evento `order.cancelled`.
- **Reembolsado parcial** — `status = 'partially_refunded'`, que conta como **venda VÁLIDA** e entra na receita bruta pelo total. Reembolso TOTAL não tem status próprio.
- **Devolvido** — não está em `orders`: vem da API de Claims/Returns (`support_cases.has_return`) e reverte **só estoque**, nunca receita.
- **Mediação** — faceta do claim (`is_mediation`, `stage='dispute'`), sem efeito financeiro registrado.

**Não existe join entre `support_cases` e `orders`** — há `pack_id`, mas nenhuma FK. Ligar uma devolução ao pedido que ela estorna, em SQL, não é possível hoje.

### 5C.4 O que NÃO pode ir para a tela até a fonte melhorar

- **`valor_estoque`** — **decisão de negócio RESPONDIDA em 2026-08-28 (D-127): é estoque virtual deliberado**, não erro. **A FERRAMENTA de marcação existe desde D-133** (`/produtos`), mas a métrica **segue bloqueada** por dois motivos que a ferramenta não resolve sozinha: (1) enquanto houver SKU **não classificado**, somar quantidade × custo contaria sentinela como patrimônio — o denominador certo é `catalogo_nao_classificado = 0`, não "alguém começou a marcar"; e (2) o saldo em si só passou a ser confiável com D-131/D-132, e a primeira reconciliação corrigida ainda precisa ser lida. Quando destravar, a definição nasce com **exclusão explícita dos virtuais**, nunca somando tudo.
- **Qualquer métrica derivada de cobertura, sugestão de compra ou priorização** — mesma base, mesmo bloqueio.
- ~~**Visão "HOJE"**~~ — **RESOLVIDA em D-158 (2026-08-31)**, com as duas metades da alternativa que esta seção previa: lê `orders` direto (RPC `get_sales_today_summary`, precedente de fonte L1 declarada estabelecido por D-157) E sinaliza a incompletude ("dia em andamento", "última venda registrada às HH:MM" via `last_order_at`). **Nenhuma métrica nova nasceu**: são as quatro fórmulas canônicas de 5.2 avaliadas ao vivo sobre a fonte que o catálogo já cita — por isso os cards usam os IDs existentes, e a incompletude (uma verdade sobre as quatro) vive no cabeçalho da seção.

---

## 5D. Tendencia de venda (D-145) -- DEFINIDA E IMPLEMENTADA

| Campo | Definicao |
|---|---|
| ID | `tendencia_venda` |
| Nome | Tendencia de venda |
| Formula | `taxa_recente = unidades(ultimos 30d)/30`; `taxa_anterior = unidades((30,90] dias atras)/60`; `razao = taxa_recente/taxa_anterior`. CRESCENDO se razao >= 1,25; CAINDO se <= 0,75; ESTAVEL entre elas. Janelas NAO sobrepostas de proposito: comparar "ultimos 15" com "ultimos 90" contaria as vendas recentes dos dois lados e diluiria o sinal |
| Recusas | AMOSTRA_INSUFICIENTE quando unidades(90d) < 12 (~1/semana: razao sobre meia duzia de vendas e ruido); HISTORICO_INCOMPLETO quando a organizacao tem < 84 dos 90 dias com metrica recomputada -- a guarda nasceu de caso real (2026-08-30: junho com 13/30 dias fazia 86% dos SKUs parecerem "crescendo") |
| Fonte | `daily_sku_metrics.units_sold`, janelas trailing encerradas em `p_date_to` (`get_stock_coverage`) |
| Granularidade | SKU, organizacao (soma todas as contas -- estoque local e compartilhado) |
| Implementacao canonica | `classifySalesTrend` em `@sb/domain/purchasing` (formula unica; versao SQL futura exigira teste de equivalencia) |
| Limiares | +-25%, fixados APOS medicao no dado real pos-reparo: 239 crescendo / 174 caindo / 152 estavel em 565 classificaveis |
| Timezone | dia civil `America/Sao_Paulo`, herdado de `daily_sku_metrics` |

### 5D.2 Estoque real aproveitavel (D-146)

| Campo | Definicao |
|---|---|
| ID | `estoque_aproveitavel` |
| Nome | Estoque real aproveitavel |
| Formula | `LOCAL + FULL + TRANSITO`. **RESERVADO fica FORA** |
| Por que nao ha dupla contagem | O "Disponivel" do UpSeller JA EXCLUI o "Ocupado": no modelo da V3 os dois viram `location_kind` disjuntos (LOCAL/RESERVADO) desde a importacao. FULL e outro armazem fisico (CD do ML), disjunto por lugar. TRANSITO baixa e LOCAL sobe na MESMA transacao no recebimento (D-055) -- em nenhum instante a mesma unidade esta em duas parcelas |
| Por que RESERVADO fica fora | Comprometido com pedidos existentes; conta-lo faria a sugestao deixar de repor unidades que ja tem dono |
| Recusa | SKU com `stock_is_virtual` nao tem total (o LOCAL e sentinela, e sentinela + Full real = lixo com aparencia de precisao). `null` com motivo, componentes expostos -- mesmo desenho da cobertura (D-127) |
| LOCAL negativo | Entra NEGATIVO: -5 sao unidades vendidas alem do que o ledger conhece, devidas. Truncar em zero esconderia a divida da sugestao de compra |
| Fonte | `inventory_balances` (LOCAL/RESERVADO/TRANSITO) + ultimo snapshot de `fulfillment_stock_snapshots` por conta, somado (FULL) |
| Implementacao canonica | `computeUsableStock` em `@sb/domain/purchasing` (formula unica) |

### 5D.3 Sugestao de compra auditavel (D-147)

| Campo | Definicao |
|---|---|
| ID | `sugestao_compra` |
| Nome | Sugestao de compra auditavel |
| Formula | `max(0, ceil(demanda_projetada - estoque_aproveitavel))`, com `demanda_projetada = ceil(taxa_30d x janela_demanda)` e `janela_demanda = prazo + cobertura + seguranca` (a soma de D-144: prazo SOMA, nunca substitui) |
| Taxa de demanda | Unidades dos ultimos 30 dias / 30 -- a MESMA janela "recente" da tendencia (5D). 90d diluiria o regime antigo que a tendencia pode ja ter declarado morto; 15d amplificaria ruido. A tendencia aparece AO LADO como contexto e NUNCA altera o numero |
| Recusas | TODAS as aplicaveis, em lista: `SEM_CONFIGURACAO` (D-144), `ESTOQUE_VIRTUAL` (5D.2), `HISTORICO_INCOMPLETO` e `AMOSTRA_INSUFICIENTE` (5D). Numero so quando defensavel |
| Zero | E resposta ("nao compre"), nunca recusa. Excesso como estado proprio e item aberto da fase |
| LOCAL negativo | AUMENTA a sugestao: unidades devidas tambem precisam ser compradas (5D.2) |
| Custo estimado | custo CADASTRADO x sugestao, rotulado como tal -- custo de simulacao separado e item aberto da fase |
| Implementacao canonica | `computePurchaseSuggestion` em `@sb/domain/purchasing`, reusando `simulateRequiredQuantity` (D-080) e `demandWindowDays` (D-144) |
| Fonte | RPC `get_purchase_suggestions` entrega INGREDIENTES (saldo pivotado, Full da ultima captura, janelas, `history_days_90`, marca, custo); `replenishment_settings` resolve a politica. A formula NUNCA roda em SQL enquanto a ordenacao nao precisar dela |

### 5D.4 Estados operacionais de estoque (D-148)

| Campo | Definicao |
|---|---|
| ID | `estado_operacional` |
| Nome | Estado operacional de estoque |
| Regua | Cobertura em dias = `aproveitavel / taxa_30d` (mesma formula de D-080, `simulateCoverageDays` -- arredondada a 1 casa) |
| RUPTURA | `aproveitavel <= 0` com demanda recente -- nada para vender |
| COMPRA_URGENTE | cobertura <= prazo: mesmo comprando AGORA, esgota antes de chegar |
| COMPRAR_EM_BREVE | cobertura <= prazo + seguranca (o ponto de pedido) |
| COBERTURA_BAIXA | cobertura abaixo da janela de demanda -- o territorio em que a sugestao (5D.3) ja da numero > 0 |
| ADEQUADA | cobertura na janela, ate o teto (quando houver) -- limites inclusivos |
| EXCESSO | cobertura acima do TETO configurado (`max_coverage_days`, o "buffer maximo" do PRD). **Sem teto, EXCESSO nunca e afirmado** -- quanto e "demais" e decisao do ADMIN, nao constante do codigo |
| Coerencia do teto | CHECK no banco: teto >= prazo + cobertura + seguranca (abaixo da janela, ADEQUADA seria impossivel) |
| Recusas | As quatro de 5D.3 (config/virtual/historico/amostra) MAIS `SEM_DEMANDA_RECENTE` (taxa zero nos 30d torna a cobertura INDEFINIDA -- contrato de D-080, nunca "infinita" fingida). A cobertura em si e exposta sempre que computavel: ela nao depende da politica |
| Implementacao canonica | `classifyStockState` em `@sb/domain/purchasing`; nenhuma constante inventada -- todos os limiares vem da politica (D-144) |

### 5D.5 Prioridade de compra (D-150)

| Campo | Definicao |
|---|---|
| ID | `prioridade_compra` |
| Nome | Prioridade de compra |
| Natureza | ORDENACAO, nunca compra automatica (PRD). Chaves lexicograficas EXPLICAVEIS, sem score e sem peso inventado |
| Chave 1 | Estado operacional (5D.4): RUPTURA > COMPRA_URGENTE > COMPRAR_EM_BREVE > COBERTURA_BAIXA > **recusas** > ADEQUADA > EXCESSO. Recusa no MEIO de proposito: e pendencia humana (config/ensaio) -- acima do que nao precisa de acao, abaixo do que precisa de compra |
| Chave 2 | Classe ABC (5C/D-140), criterio faturamento, 90 dias TRAILING (a mesma janela do `units_90d`) -- pela PROPRIA `get_sku_abc_curve` via join, nunca reimplementada |
| Chave 3 | Cobertura em dias, crescente (menos dias primeiro); indefinidas por ultimo |
| Chave 4 | Venda 30d decrescente; SKU como desempate final |
| Crescimento e valor | COLUNAS para o julgamento humano, nao chaves -- chave explicavel vale mais que score opaco |
| Onde roda | Em SQL (`get_purchase_suggestions`), DERIVADA das formulas canonicas de `@sb/domain` com TESTE DE EQUIVALENCIA na CI: para cada linha, sugestao/estado/cobertura do SQL == dominio sobre os mesmos ingredientes. A tela continua renderizando pelo dominio |

## 5E. O que NÃO tem versão por marca (D-237)

O filtro de marca de `/vendas` obrigou a responder, métrica por métrica, se ela
**decompõe** por marca. A resposta não é a mesma para todas, e o critério é um
só: **a marca vive no ITEM; se a métrica é contada no PEDIDO, não há cota de
marca para atribuir.**

| Métrica | Decompõe? | Por quê |
|---|---|---|
| `receita_bruta` | **sim** | `sum(order_items.quantity * unit_price)` = `sum(orders.total_amount)` — medido, R$ 3.073.580,78 dos dois lados |
| `unidades_vendidas` | **sim** | `order_items.quantity` é do item |
| `pedidos` | **sim** (hoje) | medido: **zero pedidos com mais de um SKU** em 340.024. É verdade do dado, não garantia estrutural — se um pedido passar a ter duas marcas, ele conta nas duas |
| `preco_medio_praticado` | **sim** | razão de dois aditivos |
| `taxas_ml` | **sim** | `order_items.sale_fee` é por item |
| `skus_distintos_vendidos` | **sim** | contagem distinta NO grão SKU |
| **`pedidos_por_pack`** | **NÃO** | contagem DISTINTA de pack, e um pack atravessa SKUs de marcas diferentes. Medido: somando o grão fino, **48 de 124 pares (conta, dia) divergem em agosto/2026**, sempre para mais |
| **`ticket_medio`** | **NÃO** | denominador é `pedidos_por_pack` |
| **`pedidos_cancelados`, `taxa_cancelamento`, `valor_cancelado`** | **NÃO** | contagem de pedido e `orders.total_amount`, do pedido inteiro |
| **`margem_operacional_pedido`, `frete_vendedor`, `desconto_vendedor`** | **NÃO** | um pedido tem **um** frete, não um frete por item |

**A regra que fica:** sob recorte de marca, o que não decompõe volta **NULL** —
nunca um número plausível. Mostrar receita da marca menos custo da operação
inteira seria número errado com cara de preciso, que é o que D-127 recusa fazer
com cobertura. A tela imprime `—` e, no gráfico, **recusa a série** com o
motivo, em vez de plotar zero.

**"Sem marca" é um valor do filtro**, não ausência dele: **23,2% da receita**
está em itens sem `sku_id`. Sem esse estado, somar as 19 marcas não chega ao
total e um quarto do faturamento some sem explicação.

---

## 5F. Faturamento e margem sobre custo (D-356) — DEFINIDAS E IMPLEMENTADAS

> A tela `/faturamento` (D-356) responde "quanto sobra de cada venda". A conta é a do pedido do usuário: **recebido = preço − comissão − frete do vendedor**; **resultado = recebido − custo**; **margem = resultado ÷ preço**. O "recebido" é a `margem_operacional_pedido` de 5C.2 — o nome "receita líquida" continua vetado (5C.1). Tudo sai de `get_faturamento`, numa passada.

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `custo_produtos_vendidos` | Custo dos produtos vendidos | `SUM(quantity × custo unitário na data do pedido)`; KIT = Σ componentes × quantidade | `sku_cost_history` (último `new_cost` até `orders.date_created`), senão `skus.purchase_cost` atual; `sku_components` | Custo nulo ou 0 é **desconhecido**, nunca zero (D-249). Quando não há histórico anterior à venda o custo é o **atual** — a tela conta esses pedidos à parte |
| `resultado_venda` | Resultado da venda | `margem_operacional_pedido − custo_produtos_vendidos`, sobre pedidos **cobertos** | `orders` + `order_items` + `order_financials` + custo | **Não é lucro líquido**: impostos, taxa fixa, parcelamento, custo do Mercado Pago, reembolsos e Ads ficam fora |
| `margem_venda` | Margem sobre a venda | `resultado_venda / receita_bruta` do **mesmo** subconjunto coberto | componentes acima | Fração, formatada em %. Cobertura ao lado; zero cobertura = NULL, nunca 0% |
| `frete_medio_pedido` | Frete médio por pedido | `frete_vendedor / pedidos com frete observado` | `order_financials` (D-165) | Pedido sem observação sai do numerador **e** do denominador. A captura só existe para pedidos a partir de 14/09/2026 em produção |
| `comissao_percentual` | Comissão sobre a receita | `taxas_ml / receita_bruta` | `order_items.sale_fee × quantity` e `orders.total_amount` | Não contém taxa fixa, parcelamento nem impostos (5C.2) |

**Pedido coberto** tem três coisas: frete observado, custo conhecido e **uma** linha de item. O **desconto do vendedor não entra na conta**: é contra o preço de tabela e já está dentro do preço vendido — medido em D-356, a comissão é cobrada sobre `unit_price` (10,63%, contra 8,16% sobre preço + desconto), e há desconto maior que o próprio preço. A tela o mostra como informação. A última é a regra de 5E — um pedido tem um frete, e só dá para atribuí-lo ao produto quando o pedido tem um produto. Medido: zero pedidos com mais de uma linha em 340 mil; os que aparecerem saem da margem e são contados.

**Grão de SKU existe** para as cinco, pela mesma razão: com uma linha por pedido, frete, desconto e custo do pedido são os do produto. **Não há recorte de marca** na tela de faturamento: a marca é do item, e o frete não decompõe (5E).

---

## 5I. Comparação entre períodos e tom da variação (D-394) — DEFINIDAS E IMPLEMENTADAS

> A Central do negócio (`/central`) mostra cada indicador contra o período anterior. Os números são os de 5.2, 5F e 5G, lidos das mesmas RPCs de `/faturamento` (`get_faturamento` e `get_ads_overview`, sem detalhe) para os dois períodos. Esta seção define só a comparação.

| ID | Nome | Fórmula | Ressalva obrigatória na tela |
|---|---|---|---|
| `variacao_percentual_periodo` | Variação percentual | `(atual − anterior) ÷ anterior` | NULL com anterior ≤ 0 ou ausente — a tela mostra só a seta e a diferença, nunca "+∞" nem 0% |
| `variacao_pontos_percentuais` | Variação em pontos percentuais | `fração_atual − fração_anterior` | Para métricas que já são fração: margem, participações, ACOS, TACoS. "−2,1 p.p.", nunca "−10%" sobre uma porcentagem |

Granularidades: `account` e `organization`.

**`comparacao_periodo_anterior` — a janela anterior** (sai de 5.4):

| Período atual | Janela anterior |
|---|---|
| Hoje (em andamento) | Ontem inteiro |
| Ontem | Anteontem |
| Últimos 7, 15 e 30 dias — **até ontem** | Os N dias imediatamente anteriores |
| Mês atual — dia 1 até **ontem** | Os mesmos dias do mês anterior, limitados ao fim dele |
| Mês anterior | O mês antes dele, inteiro |
| Personalizado | A janela imediatamente anterior, do mesmo tamanho |

As janelas móveis da Central terminam **ontem**: comparar um dia em andamento com um dia inteiro poria ~1/N do volume a menos no período atual sem que nada tivesse piorado. As telas antigas (`/vendas`, `/faturamento`) continuam com "últimos N dias até hoje".

**O que se compara.** Comissão e custo sobem junto com a receita, então são comparados pela **participação**: `comissao_percentual` (5F) e `custo_produtos_vendidos ÷ receita coberta`, em pontos percentuais. O valor em reais continua à vista.

**Quando a comparação vale** — fora destes casos a tela escreve o motivo no lugar da variação:

- **Somas de pedidos cobertos** (`resultado_venda` em reais): só com coberturas (`receita coberta ÷ receita bruta`) a até **5 p.p.** uma da outra. Comparar 31% com 95% mede a captura do frete, não o negócio.
- **Razões de pedidos cobertos** (`margem_venda`, participação do custo, `frete_medio_pedido`): **20 pedidos** no mínimo em cada período.
- **Ads**: o diário (`get_ads_overview.diario`) precisa ter linha no primeiro e no último dia dos dois períodos. O Mercado Livre fecha o dia às 10h do dia seguinte, então "Hoje" nunca compara Ads.

**O tom da variação.** Cada indicador tem **polaridade**: maior é melhor (receita, pedidos, ticket, unidades, resultado, margem, vendas com Ads, ROAS), menor é melhor (frete médio, participação da comissão e do custo, ACOS, TACoS) ou **neutra** (investimento em Ads, que não é bom nem ruim por si — quem julga é ROAS e TACoS).

| Movimento | Valor (relativo) | Fração (p.p.) | Tom |
|---|---|---|---|
| Zona neutra | abaixo de 2% | abaixo de 0,5 p.p. | neutro (⚪) |
| A favor da polaridade | 2% ou mais | 0,5 p.p. ou mais | ok (🟢) |
| Contra, moderado | 2% a 10% | 0,5 a 2 p.p. | atenção (🟡) |
| Contra, forte | 10% ou mais | 2 p.p. ou mais | perigo (🔴) |

Os limites são **provisórios** (D-148: limiar é decisão do dono) e vão para a tela de configurações numa fatia seguinte. Com o dia em andamento, os indicadores de **volume** (faturamento, pedidos, unidades, resultado) mostram a variação sem tom; as razões continuam julgadas.

**O resumo em texto** é montado desses mesmos números, sem modelo de linguagem, e só afirma o que eles sustentam. A queda ou alta da margem é repartida entre comissão, frete e custo **exatamente**: nos pedidos cobertos, `margem = 1 − (comissão + frete + custo) ÷ receita coberta`, e a tela confere essa identidade (tolerância de 0,1 p.p.) nos dois períodos antes de atribuir qualquer ponto — se não fechar, não atribui.

## 5J. Meta do mês e projeção de fechamento (D-395) — DEFINIDAS E IMPLEMENTADAS

> A Central do negócio mostra a meta do mês corrente, da empresa inteira, contra o realizado, e projeta o fechamento. Tudo sai de `get_meta_do_mes(organização, mês, hoje)`, sobre `daily_account_metrics` (receita bruta das vendas válidas, 5.2) e `monthly_goals`. A meta é da organização: não muda com a conta nem com o período escolhidos na central, e a tela diz isso.

**O perfil semanal.** Cada dia da semana tem um fator: a média daquele dia nas 8 semanas completas até ontem, dividida pela média dos sete. Dia sem linha dentro do histórico é dia sem venda (o rollup só grava dia com venda); antes do primeiro dia com venda não há dia nenhum. Com menos de duas observações de cada dia da semana, todo fator vale 1 e a tela diz que o perfil é plano.

| ID | Nome | Fórmula | Ressalva obrigatória na tela |
|---|---|---|---|
| `atingimento_meta` | Atingimento da meta | `realizado ÷ meta`; faltam = `max(meta − realizado, 0)` | Realizado inclui hoje até a última atualização do resumo diário (a cada hora). Sem meta: NULL |
| `esperado_meta` | Esperado até ontem | `meta × Σ fator dos dias completos ÷ Σ fator do mês`; ritmo = `realizado até ontem − esperado` | O domingo fraco não conta como atraso. Abaixo do esperado até 5% é atenção; mais que isso, perigo |
| `receita_media_diaria` | Média diária do mês | `realizado até ontem ÷ dias completos` | Hoje fica fora (em andamento) |
| `meta_diaria_necessaria` | Meta diária necessária | `max(meta − realizado até ontem, 0) ÷ dias restantes (hoje incluído)`; aumento = `meta diária ÷ média diária − 1` | Média simples, como o dono pediu; a projeção é que pondera o dia da semana |
| `projecao_fechamento_mes` | Projeção de fechamento | `realizado até ontem + ritmo × Σ fator dos dias restantes`; ritmo = `receita ÷ Σ fator` dos últimos 28 dias completos. Conservador e otimista: o menor e o maior ritmo entre 7, 14 e 28 dias | **Eventos comerciais não entram** (não há calendário). Hoje entra pela média do dia da semana, não pelo parcial. Sem 7 dias completos de histórico: NULL |
| `projecao_sazonal_mes` | Pelo mesmo mês do ano anterior | `realizado até ontem × receita do mês inteiro no ano anterior ÷ receita do mesmo mês até o mesmo dia` | Só quando o histórico cobre o mês inteiro do ano anterior. Conferência sazonal, não motor |

**O veredito do mês** (`lib/central-meta.ts`): no caminho quando o ritmo atual fecha acima da meta; em risco quando só o otimista fecha; improvável quando nem o otimista fecha; sem projeção (histórico curto), pelo ritmo contra o esperado. Mês encerrado: atingida ou não pelo realizado.

Granularidade: `organization`. `security invoker`: quem não vê uma conta não vê a receita dela, e o realizado contra a meta da empresa fica menor — o caso é de um usuário com permissão parcial, não do ADMIN.

## 5K. Imposto e margem de contribuição (D-395) — DEFINIDAS E IMPLEMENTADAS

> O dono escolheu **uma alíquota efetiva sobre o faturamento, com vigência** (`tax_rates`). `get_faturamento` aplica, pedido a pedido, a alíquota vigente no dia de negócio da venda. Sai de 5.5 a `margem_contribuicao`, que esperava imposto e Ads.

| ID | Nome | Fórmula | Ressalva obrigatória na tela |
|---|---|---|---|
| `imposto_estimado` | Imposto estimado | `SUM(receita do pedido × alíquota vigente no dia)`, todas as vendas válidas | Algum pedido do período sem alíquota torna o total **NULL**, nunca parcial. Estimativa pela alíquota efetiva, não a apuração da guia |
| `resultado_apos_imposto` | Resultado após imposto | `resultado_venda − imposto dos mesmos pedidos cobertos` | Mesmo subconjunto coberto de 5F |
| `margem_apos_imposto` | Margem após imposto | `resultado_apos_imposto ÷ receita coberta` | idem |
| `resultado_contribuicao` | Lucro após imposto e Ads | `resultado_apos_imposto − investimento_ads × (receita coberta ÷ receita bruta)` | **O Ads entra rateado pela participação da receita coberta** (premissa declarada; some com cobertura de 100%). Custos fixos ficam fora. Sem o Ads do período inteiro no diário: NULL — exceto quando nenhuma conta tem Product Ads habilitado, e aí o zero é fato |
| `margem_contribuicao` | Margem de contribuição | `resultado_contribuicao ÷ receita coberta` = `margem_apos_imposto − TACoS` | É contribuição, não lucro líquido: aluguel, folha e embalagem não estão no sistema |

Comparação entre períodos (5I): o imposto é de polaridade **neutra** (acompanha a receita pela alíquota); o lucro segue a regra do resultado em reais (coberturas a até 5 p.p.); a margem de contribuição, a amostra mínima de 20 pedidos cobertos, e os dois exigem o Ads comparável.

## 5L. Detector de frete (D-397) — DEFINIDAS E IMPLEMENTADAS

> A tela `/central/frete` (e o painel "Frete" da central) aponta os anúncios cujo frete destoa do próprio histórico, dos outros anúncios do mesmo produto, dos pares da categoria ou do preço, e escreve o motivo com os números de cada comparação. Tudo sai de `get_detector_frete(organização, hoje)`; o texto é montado em `apps/web/lib/detector-frete.ts` a partir dos números da RPC, sem modelo de linguagem.

**Grão:** anúncio × faixa de preço **do pedido** (até R$ 40, 40–79, 79–120, 120–200, 200–400, acima de 400). O frete muda de patamar com o preço — medido em produção em 23/09: mediana de R$ 7,15 abaixo de R$ 40, R$ 8,45 de R$ 40 a 79, R$ 14,45 de R$ 79 a 120 —, então um anúncio que vende dos dois lados de uma faixa é comparado em cada uma separadamente. O SKU da linha é o mais frequente nos pedidos do anúncio.

**Janelas:** "atual" são os 14 dias até ontem; "antes", os 76 dias anteriores (90 no total, o que D-396 recuperou). Hoje fica de fora — o frete do dia ainda não foi capturado.

**Entra:** pedido válido (5.2) com frete observado (D-165), uma linha e **uma unidade**, fora do Flex (`self_service`, frete ~zero). Linha com 3 pedidos ou mais na janela atual. **Não entra:** pedido sem frete observado (não vira zero), duas unidades ou mais (o frete é do pacote), Flex.

| ID | Nome | Fórmula | Ressalva obrigatória na tela |
|---|---|---|---|
| `nivel_anomalia_frete` | Nível de anomalia de frete | soma dos pontos dos cinco sinais abaixo; 0 normal, 1–2 atenção, 3–4 provável problema, 5+ forte indício | O nível é indício, não diagnóstico: a tela escreve o motivo de cada ponto e sugere o que conferir ("vale conferir", nunca uma ordem) |
| `frete_excedente_estimado` | Frete a mais (14 dias) | `Σ frete da janela atual − referência × pedidos`; referência = frete de antes do anúncio, dos outros anúncios do mesmo SKU ou dos pares, a primeira que pontuou; o total soma os alertas provável e forte | Alerta só por proporção ou margem não tem referência: sem excedente (NULL, nunca 0) |

**Os cinco sinais** (medianas dos 14 dias contra a referência):

| Sinal | Compara com | 1 ponto | 2 pontos | 3 pontos | Mínimo |
|---|---|---|---|---|---|
| Histórico | o **frete esperado**: o do próprio anúncio na janela de antes, mesma faixa, × a mudança geral da faixa (D-399) | +15% ou 3× o desvio absoluto mediano do anúncio, o que for maior | +40% | +80% | 5 pedidos antes; +R$ 1 sobre o esperado |
| Mesmo produto | outros anúncios do mesmo SKU na mesma faixa (mediana) | +15% | +40% | +80% | 3 pedidos em cada; +R$ 1 |
| Pares | produtos da mesma categoria do Mercado Livre e faixa (um valor por produto) | +50% e z robusto ≥ 3 | +100% e z ≥ 4 | +200% e z ≥ 6 | 6 produtos; +R$ 2 |
| Proporção | frete ÷ preço contra o p95 da faixa | acima do p95 e ≥ 25% | ≥ 1,5× o p95 e ≥ 30% | ≥ 2× o p95 e ≥ 40% | — |
| Margem | margem dos pedidos cobertos (custo de `get_faturamento`, D-356) | vende no prejuízo com frete ≥ 10% do preço; ou o frete subiu ≥ 5 p.p. do preço e a margem caiu junto (quando conhecida) | deixou de dar resultado (margem > 0 antes, ≤ 0 agora) com o frete explicando ao menos metade da queda | — | 5 cobertos antes, 3 agora |

**Mudança geral da faixa (D-399):** a mediana, entre os anúncios da faixa com 5 pedidos antes e 3 agora, de frete de agora ÷ frete de antes — com 10 anúncios no mínimo, senão 1. É a tabela do Mercado Livre (medido: +4,6% a +5,2% nas faixas até R$ 120 a partir da semana de 24/08/2026, nas quatro contas), e o histórico não a atribui ao anúncio. Não é a mediana de todos os pedidos, que muda com a composição (deu +24% na faixa de R$ 200 a 400 porque passou a vender mais baú, contra +3,1% pelos anúncios). O "frete a mais" de um alerta de histórico também é contra o esperado.

z robusto = (frete − mediana) ÷ (1,4826 × desvio absoluto mediano); com desvio zero, qualquer valor acima da mediana conta como fora da dispersão. Os limiares dos pares são mais altos que os do mesmo produto porque a categoria mistura tamanhos — faróis contra lanternas.

**Por que estas referências e não outras** (medido em produção, 30 dias até 23/09): o frete de um anúncio é quase fixo (coeficiente de variação mediano de 1% a 3%), então 15% já é fora do normal; 225 SKUs vendem por mais de um anúncio e em 31 o frete difere mais de 15% entre eles — mesmo produto, frete diferente, o indício mais direto de medida cadastrada errada; a categoria do ERP (`skus.category_raw`) não é categoria de produto (mistura fornecedor e situação), e a do Mercado Livre (`listings.category_id`) cobre 1.864 de 1.865 anúncios vendidos; **peso e dimensões** estão cadastrados em 22 de 973 SKUs vendidos — a comparação por peso não existe, e a tela diz quantos têm.

**A margem é a de `get_faturamento`.** As CTEs de custo foram copiadas sem mudança (histórico com vigência, kits pelos componentes); o teste de integração confere a igualdade nos mesmos pedidos.

## 5M. Sinais de Ads por campanha (D-398) — DEFINIDAS E IMPLEMENTADAS

> A tela `/central/ads` (e o painel "Ads" da central) aponta as campanhas do Mercado Ads que pedem análise ou têm espaço para crescer, e mostra a tabela de todas as campanhas da semana. Tudo sai de `get_sinais_ads(organização, hoje)`; o texto (o que aconteceu, a possível interpretação, o que vale revisar) é montado em `apps/web/lib/sinais-ads.ts` só com os números da RPC.

**O dia consolidado.** O Mercado Livre publica o gasto e os cliques do dia antes da venda atribuída (medido em 23/09: 21/09 e 22/09 chegaram com gasto em todas as campanhas e venda zero; 22/09 também com impressão zero; nenhum dia mais antigo tem o padrão). **Dia pendente** = dia antes de hoje, com gasto, depois do último dia com venda atribuída **e** impressão, somando as contas do recorte. `get_ads_overview` devolve `dias_pendentes`; com algum no período, a central não compara vendas com Ads, ROAS nem ACOS (5I) — o investimento, o TACoS e o lucro após Ads seguem, porque o gasto desses dias é conhecido — e o `/faturamento` avisa.

**A semana:** os 7 dias até o último dia consolidado, contra os 7 anteriores. Hoje nunca entra.

| ID | Nome | Fórmula | Ressalva obrigatória na tela |
|---|---|---|---|
| `ctr_ads` | CTR do Ads | cliques ÷ impressões | Sem impressão: NULL |
| `cpc_ads` | CPC do Ads | investimento ÷ cliques | Sem clique: NULL |
| `conversao_ads` | Conversão do Ads | unidades atribuídas ÷ cliques | É unidade por clique, não conversão de pedido |
| `cpa_ads` | Custo por venda do Ads | investimento ÷ unidades atribuídas | Sem unidade: NULL |
| `uso_orcamento_ads` | Uso do orçamento | investimento da semana ÷ 7 ÷ orçamento diário; dias no teto = dias com gasto ≥ 90% do orçamento | O orçamento é o da última leitura da campanha (`budget` é diário: o gasto do dia bate nele) |
| `nivel_sinal_ads` | Sinal da campanha | tabela abaixo, na ordem | Sinal para análise, não decisão: a tela nunca diz "pause" |
| `lucro_estimado_apos_ads` | Lucro estimado após Ads | vendas com Ads × margem média da empresa na semana − investimento; margem após Ads = margem − ACOS; ROAS de equilíbrio = 1 ÷ margem | **Premissa declarada**: a API não diz que produtos cada campanha vendeu (D-363); a margem é a após imposto quando há alíquota, senão a da venda (5F/5K). Sem margem conhecida: NULL |

| Nível | Regra (semana atual; "antes" = a anterior) |
|---|---|
| Pausada | campanha que não está ativa — quem pausou já agiu; fica fora dos alertas e na tabela |
| Crítico | gasto ≥ max(R$ 50, orçamento diário) sem nenhuma unidade vendida; ou ROAS < 1 com R$ 50 ou mais |
| ROAS abaixo da meta | ROAS < 80% do `roas_target` da própria campanha, R$ 50 ou mais. Abaixo por pouco é a oscilação de uma estratégia que mira o alvo (medido: 25 de 51 campanhas abaixo por qualquer margem numa semana boa) |
| Atenção | CPC +20% com conversão −15% (100 cliques nas duas semanas); ou gasto +20% com ROAS −15% (R$ 100 antes) |
| Oportunidade de escala | ativa, ROAS ≥ meta, uso ≥ 90% ou 4 de 7 dias no teto, 5 unidades ou mais |
| Normal | o resto |

**Interpretação** (só em crítico e abaixo da meta): CTR < 70% da mediana das campanhas da empresa na semana (com 1.000 impressões) → criativo ou oferta; conversão < 60% da mediana (com 100 cliques) → página ou produto. Medianas das próprias campanhas, não número fixo. Em escala, margem após Ads < 10% troca "avaliar aumento gradual" por "não aumentar antes de revisar custos".

## 5H. Indicadores operacionais de sincronização

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `cobertura_historico_pedidos` | Cobertura do histórico de pedidos | `clamp((backfill_covered_until − (agora − 365 dias)) / (connected_at − (agora − 365 dias)), 0%, 99%)`; vira **100% somente** quando `backfill_covered_until >= connected_at` | `ml_accounts.backfill_covered_until`, `ml_accounts.connected_at`; retenção de 365 dias do handler `backfill.orders` | Estimativa da janela histórica de **pedidos** recuperável no Mercado Livre. Não mede anúncios, visitas, Full, Ads nem a saúde atual dos jobs; esses sinais aparecem separados. Sem `connected_at`, o valor é NULL, nunca 0% |

Granularidade: conta Mercado Livre. O cálculo usa os dois cursores escalares da
conta; não agrega linhas de negócio no JavaScript. O valor é inteiro de
propósito: o cursor é exato, mas a borda da retenção anda com o tempo, então
casas decimais dariam precisão falsa.

---

## 6. Como adicionar ou alterar uma métrica

1. Registrar ou alterar a definição **aqui primeiro**.
2. Atualizar `metric_definitions` na mesma migration da mudança de cálculo.
3. Se a fórmula existir em SQL e em `@sb/domain`, atualizar as duas e o teste de equivalência.
4. Se a alteração muda números históricos, registrar em `docs/DECISIONS.md` com impacto e data.

**Não alterar silenciosamente o significado de uma métrica existente.** Se o significado muda, o `id` muda.
