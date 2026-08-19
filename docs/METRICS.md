# Catálogo de métricas — Speed Bikers Gestão V3

> Dono documental de: definição oficial de cada métrica.
> Este documento é **normativo**. Se um número na interface discorda daqui, o número está errado.
> Status: **regras canônicas aprovadas; definições individuais a preencher na Fase 5.**

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
| **Rollups** | `daily_sku_metrics` e `daily_account_metrics`, gerados pelo **mesmo código**, com teste de equivalência na CI |
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
granularidade      anúncio | SKU | conta | organização
inclusoes          o que entra
exclusoes          o que não entra
cancelamentos      incluído | excluído | estornado
timezone           America/Sao_Paulo
atualizado_em      data da última revisão desta definição
```

---

## 5. Métricas previstas

Preenchimento completo na Fase 5, quando as fontes estiverem disponíveis e medidas.

### Vendas e receita — fonte disponível

`unidades_vendidas` · `receita_bruta` · `pedidos` · `pedidos_por_pack` · `ticket_medio` · `preco_medio_praticado`

`pedidos_por_pack` existe porque `pack_id` é a unidade de compra real do cliente — a V2 tinha o campo mas não a agregação.

### Estoque e cobertura — fonte disponível

`estoque_local` · `estoque_full_por_conta` · `reservado` · `em_transito` · `disponivel` · `cobertura_dias` · `data_estimada_ruptura` · `venda_media_diaria_30`

`disponivel` **nunca** é a soma cega dos quatro estados. Local, Full, reservado e em trânsito têm autoridades diferentes (ver `docs/DATABASE.md`), e a definição declara exatamente o que compõe cada um.

### Derivadas e comparativas — fonte disponível

`variacao_percentual_periodo` · `comparacao_periodo_anterior` · `curva_abc` · `tendencia` · `vendas_perdidas_estimadas`

`vendas_perdidas_estimadas` é **estimativa com premissa explícita**, nunca apresentada como fato. A premissa aparece junto do número.

### Dependentes de fonte ainda não confirmada

`visitas` · `taxa_conversao` · `investimento_ads` · `receita_ads` · `acos` · `margem_contribuicao`

**Escopo definido:** visitas, conversão e Ads entram na **Fase 5B** (D-032), depois do estoque. Até lá, o diagnóstico **não distingue queda de tráfego de queda de conversão** e deve declarar isso explicitamente, em vez de inferir. Margem depende de custo cadastrado por SKU.

Nenhuma dessas será exibida enquanto a fonte não estiver confirmada e a definição preenchida. **Métrica sem fonte confirmada não vai para a tela.**

---

## 6. Como adicionar ou alterar uma métrica

1. Registrar ou alterar a definição **aqui primeiro**.
2. Atualizar `metric_definitions` na mesma migration da mudança de cálculo.
3. Se a fórmula existir em SQL e em `@sb/domain`, atualizar as duas e o teste de equivalência.
4. Se a alteração muda números históricos, registrar em `docs/DECISIONS.md` com impacto e data.

**Não alterar silenciosamente o significado de uma métrica existente.** Se o significado muda, o `id` muda.
