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

`variacao_percentual_periodo` · `comparacao_periodo_anterior` · `curva_abc` · `tendencia` · `vendas_perdidas_estimadas`

`vendas_perdidas_estimadas` é **estimativa com premissa explícita**, nunca apresentada como fato. A premissa aparece junto do número.

### 5.5 Dependentes de fonte ainda não confirmada

`investimento_ads` · `receita_ads` · `acos` · `margem_contribuicao`

**Escopo definido:** Ads entra depois; `margem_contribuicao` depende de custo cadastrado por SKU. Enquanto a fonte não existir, o diagnóstico **não distingue queda de tráfego de queda de conversão sem dizer que não distingue** — declara, em vez de inferir.

Nenhuma dessas será exibida enquanto a fonte não estiver confirmada e a definição preenchida. **Métrica sem fonte confirmada não vai para a tela.**

> **`visitas` e `taxa_conversao` saíram desta seção em 2026-08-31 (D-170).** O texto tinha envelhecido: a fonte foi confirmada em D-032, `daily_listing_visits` está em produção e a coleta foi corrigida em D-156 — mas as duas apareciam na tela **sem definição canônica**, exatamente o que a regra central proíbe. As definições estão em **5D**, abaixo.

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

A pesquisa oficial (`docs/MERCADO_LIVRE.md` secao 2.15) confirmou que dá para compor **bruto − comissão − frete do vendedor − desconto bancado pelo vendedor**, mas que ficam de fora, por lacuna da própria documentação: a composição de `sale_fee` (a doc nunca diz se a taxa fixa está dentro), a taxa fixa por pedido, a taxa de parcelamento, o custo de cobrança do Mercado Pago, os impostos retidos no MLB e os reembolsos posteriores.

Chamar isso de "receita líquida" afirmaria que o número fecha com o extrato — e ele não fecha. O nome canônico é **`margem_operacional_pedido`**, e a interface exibe a lista do que NÃO entra junto do valor.

A conciliação real só existe no ciclo mensal de `/billing/integration/...`, que o próprio Mercado Livre diz não servir como fonte primária de gestão de vendas. Portanto **duas visões distintas e declaradas**, nunca uma só.

### 5C.2 Definições

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `taxas_ml` | Taxas do Mercado Livre | `SUM(order_items.sale_fee)` sobre vendas válidas | `order_items.sale_fee` (100% preenchido, medido) | É a **comissão de venda**. Não inclui frete, taxa fixa, parcelamento nem impostos |
| `margem_operacional_pedido` | Margem operacional | `receita_bruta − taxas_ml − frete_vendedor − desconto_vendedor`, **sobre pedidos COBERTOS** | `orders` + `order_items.sale_fee` + `order_financials` (D-165) | **IMPLEMENTADA em D-166** (`get_sales_margin_summary` + seção em `/vendas`): computada SÓ sobre pedidos com frete E desconto observados, receita/taxas do MESMO subconjunto, cobertura declarada ao lado (cobertos ÷ válidos), zero cobertura = NULL. **Não é receita líquida** (5C.1) — a tela lista o que não entra. Componentes `frete_vendedor`/`desconto_vendedor` catalogados junto |
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

## 6. Como adicionar ou alterar uma métrica

1. Registrar ou alterar a definição **aqui primeiro**.
2. Atualizar `metric_definitions` na mesma migration da mudança de cálculo.
3. Se a fórmula existir em SQL e em `@sb/domain`, atualizar as duas e o teste de equivalência.
4. Se a alteração muda números históricos, registrar em `docs/DECISIONS.md` com impacto e data.

**Não alterar silenciosamente o significado de uma métrica existente.** Se o significado muda, o `id` muda.
