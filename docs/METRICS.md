# Catálogo de métricas — Speed Bikers Gestão V3

> Dono documental de: definição oficial de cada métrica.
> Este documento é **normativo**. Se um número na interface discorda daqui, o número está errado.
> Status: **regras canônicas e métricas de vendas aprovadas.** Métricas de estoque, tráfego e Ads permanecem para a Fase 5B.

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
| **Cancelamento e devolução** | Cada definição declara explicitamente se inclui, exclui ou estorna |
| **Escopo da IA** | Análise por IA respeita exatamente o filtro selecionado pelo usuário |

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

`visitas` · `taxa_conversao` · `investimento_ads` · `receita_ads` · `acos` · `margem_contribuicao`

**Escopo definido:** visitas, conversão e Ads entram na **Fase 5B** (D-032), depois do estoque. Até lá, o diagnóstico **não distingue queda de tráfego de queda de conversão** e deve declarar isso explicitamente, em vez de inferir. Margem depende de custo cadastrado por SKU.

Nenhuma dessas será exibida enquanto a fonte não estiver confirmada e a definição preenchida. **Métrica sem fonte confirmada não vai para a tela.**

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

## 5C. Métricas propostas para a evolução dos dashboards (D-120) — DEFINIDAS, NÃO IMPLEMENTADAS

> Registradas aqui ANTES de qualquer tela, como manda a regra central. Nenhuma
> vai para a interface enquanto a fonte não estiver confirmada e a ressalva
> não estiver visível ao lado do número.

### 5C.1 O veto: "receita líquida" não é um nome permitido

A pesquisa oficial (`docs/MERCADO_LIVRE.md` secao 2.15) confirmou que dá para compor **bruto − comissão − frete do vendedor − desconto bancado pelo vendedor**, mas que ficam de fora, por lacuna da própria documentação: a composição de `sale_fee` (a doc nunca diz se a taxa fixa está dentro), a taxa fixa por pedido, a taxa de parcelamento, o custo de cobrança do Mercado Pago, os impostos retidos no MLB e os reembolsos posteriores.

Chamar isso de "receita líquida" afirmaria que o número fecha com o extrato — e ele não fecha. O nome canônico é **`margem_operacional_pedido`**, e a interface exibe a lista do que NÃO entra junto do valor.

A conciliação real só existe no ciclo mensal de `/billing/integration/...`, que o próprio Mercado Livre diz não servir como fonte primária de gestão de vendas. Portanto **duas visões distintas e declaradas**, nunca uma só.

### 5C.2 Definições

| ID | Nome | Fórmula | Fonte | Ressalva obrigatória na tela |
|---|---|---|---|---|
| `taxas_ml` | Taxas do Mercado Livre | `SUM(order_items.sale_fee)` sobre vendas válidas | `order_items.sale_fee` (100% preenchido, medido) | É a **comissão de venda**. Não inclui frete, taxa fixa, parcelamento nem impostos |
| `margem_operacional_pedido` | Margem operacional | `receita_bruta − taxas_ml − frete_vendedor − desconto_vendedor` | idem + `/shipments/{id}/costs` + `/orders/{id}/discounts` | **Não é receita líquida.** Lista o que não entra. Bloqueada até frete e desconto serem persistidos |
| `pedidos_cancelados` | Pedidos cancelados | `COUNT(DISTINCT orders.id) where status in ('cancelled','pending_cancel')` | `orders.status` | `pending_cancel` conta como cancelado (mesma semântica de `order.cancelled`, `@sb/domain`) |
| `taxa_cancelamento` | Taxa de cancelamento | `pedidos_cancelados / NULLIF(pedidos_cancelados + pedidos, 0)` | idem | Denominador = **elegíveis** (válidos + cancelados), não só válidos. **Cancelamento ≠ devolução ≠ reembolso ≠ mediação** — ver 5C.3 |
| `valor_cancelado` | Valor cancelado | `SUM(orders.total_amount)` dos cancelados | `orders.total_amount` | Valor **pedido**, não valor estornado — a V3 não observa o estorno financeiro |
| `skus_distintos_vendidos` | SKUs distintos vendidos | `COUNT(DISTINCT sku_id)` calculado NO GRÃO PEDIDO | `daily_sku_metrics` | **Nunca somar de grão inferior** (D-017/D-050). Exclui o bucket `sku_id IS NULL` — e esse bucket é 21,8% dos itens em 30 dias |
| `valor_estoque` | Valor do estoque | `SUM(quantity × skus.purchase_cost)` | `inventory_balances` + `skus.purchase_cost` | 🔴 **BLOQUEADA** — ver 5C.4 |

### 5C.3 Cancelamento, devolução, reembolso e mediação são quatro coisas

Três mecanismos independentes, nenhum consolidado numa visão financeira:

- **Cancelado** — `orders.status in ('cancelled','pending_cancel')` + evento `order.cancelled`.
- **Reembolsado parcial** — `status = 'partially_refunded'`, que conta como **venda VÁLIDA** e entra na receita bruta pelo total. Reembolso TOTAL não tem status próprio.
- **Devolvido** — não está em `orders`: vem da API de Claims/Returns (`support_cases.has_return`) e reverte **só estoque**, nunca receita.
- **Mediação** — faceta do claim (`is_mediation`, `stage='dispute'`), sem efeito financeiro registrado.

**Não existe join entre `support_cases` e `orders`** — há `pack_id`, mas nenhuma FK. Ligar uma devolução ao pedido que ela estorna, em SQL, não é possível hoje.

### 5C.4 O que NÃO pode ir para a tela até a fonte melhorar

- **`valor_estoque`** — medido em 2026-08-28: dos 828 SKUs com saldo local positivo, **581 estão acima de 1.000 unidades**, com 164 em exatamente 3.996 e 9 em 39.996. É **estoque sentinela do ERP** (o truque de 4.000/40.000 para o anúncio não pausar), fielmente espelhado pela reconciliação (`AJUSTE_RECONCILIACAO` injetou +5.206.669 unidades). Há ainda **1.639 SKUs com saldo NEGATIVO**, mediana −2. Um valor de estoque sobre isso daria R$ 4,3 milhões num único SKU de retrovisor. **Decisão de negócio pendente** — ver `docs/DECISIONS.md` D-120, questão aberta 1.
- **Qualquer métrica derivada de cobertura, sugestão de compra ou priorização** — mesma base, mesmo bloqueio.
- **Visão "HOJE"** — mecanicamente trivial, mas `daily_*_metrics` do dia corrente está incompleto por construção, e o projeto evita lê-lo em todos os outros lugares. Ou lê `orders` direto (fora do padrão L3) ou sinaliza a incompletude; nunca finge que o dia fechou.

---

## 6. Como adicionar ou alterar uma métrica

1. Registrar ou alterar a definição **aqui primeiro**.
2. Atualizar `metric_definitions` na mesma migration da mudança de cálculo.
3. Se a fórmula existir em SQL e em `@sb/domain`, atualizar as duas e o teste de equivalência.
4. Se a alteração muda números históricos, registrar em `docs/DECISIONS.md` com impacto e data.

**Não alterar silenciosamente o significado de uma métrica existente.** Se o significado muda, o `id` muda.
