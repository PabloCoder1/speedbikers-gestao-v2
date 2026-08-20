# UpSeller — o ERP de origem

> Dono documental de: estrutura das exportações do UpSeller, qualidade dos dados e regras de importação.
> Decisão que o define: **D-028** (o UpSeller permanece como ERP) e **D-029** (em divergência de estoque, o UpSeller vence).
> Status: **estrutura analisada sobre exportação real de 2026-08-20.** Importador ainda não construído.

Tudo neste documento veio da leitura dos quatro arquivos exportados, não de suposição.

---

## 1. Os quatro arquivos

| Arquivo | Linhas | O que é |
|---|---|---|
| `export_warehouse_products` | 3.415 | **Catálogo de produtos.** Uma linha por SKU, 37 colunas |
| `SKU_Map_Relationship` | 23.924 | **Vínculo canal ↔ SKU.** Uma linha por anúncio/variação |
| `export_kit` | 272 | **Kits.** Uma linha por *componente*, não por kit |
| `Lista_de_Estoque` | 3.372 | **Saldo por armazém.** Uma linha por SKU |

---

## 2. Achado que altera a arquitetura: não é só Mercado Livre

O `SKU_Map_Relationship` mapeia SKUs para **9 lojas em 5 marketplaces**:

| Marketplace | Lojas | Vínculos |
|---|---|---|
| **Mercado Livre** | Speedbikers (loja 1), Speedbikers (loja 2), SbMotos, GMR | 20.650 |
| **Shopee** | Speedbikers, Sbmotos | 3.011 |
| **Kwai** | SpeedBikers | 207 |
| **Temu** | Speed Bikers | 29 |
| **TikTok** | Speed Bikers | 1 |

Toda a documentação da V3 fala em "operação multi-conta do **Mercado Livre**". A realidade do ERP é **multi-marketplace**, e o Mercado Livre responde por 86% dos vínculos.

**Consequência de schema:** `sku_listing_links` foi desenhada como `(ml_account_id, mlb_id, variation_id)`. Se a V3 precisar enxergar os outros canais, a chave tem de ser genérica: `(channel, store, listing_id, variation_id)`.

O custo de nascer genérico é praticamente zero. O custo de migrar depois, com dados dentro, não é. **Decisão pendente — ver seção 7.**

### Identificadores de anúncio

Dois prefixos convivem na coluna `ID do Anúncio`:

- `MLB` — 16.878 vínculos
- `MLBU` — 3.772 vínculos

Em **8.565 de 23.898** linhas, `ID do Anúncio` é igual a `ID da Variante` — ou seja, anúncio sem variação real. Nas demais, diferem.

A coluna `Variante` existe mas vem preenchida com `-` em todas as linhas: **não carrega informação**.

**3.328 dos 3.553 SKUs mapeados estão anunciados em mais de uma loja.** Multi-canal é a regra, não a exceção — o que confirma o SKU como entidade central (D-004).

---

## 3. Achado que altera o modelo de catálogo: kit não é produto

- 138 kits distintos, com **1 a 4 componentes** cada.
- O `KIT SKU` é a concatenação dos componentes por ponto: `BAULATPTO.BAU98.SUP99`.
- Quantidades por componente: majoritariamente 1, mas há 2, 3, 4 e 10.

E o fato decisivo:

> **Nenhum dos 138 kits existe no catálogo de produtos.** Todos os 138 aparecem no mapeamento de anúncios, mas 0 de 138 têm linha em `export_warehouse_products`.

Ou seja, **um kit é um SKU vendável que não é um produto de armazém**. Ele existe para ser anunciado e é decomposto em componentes na hora da baixa de estoque.

**Consequência de schema:** `skus` precisa aceitar os dois tipos, distinguidos por uma coluna de natureza (produto ou kit). Um kit não tem saldo próprio; tem componentes que têm.

Todos os componentes de kit **existem** no catálogo — a integridade referencial fecha.

---

## 4. Qualidade dos dados, medida

### Confiável

| Campo | Preenchimento | Observação |
|---|---|---|
| `Código do Produto` | 100% | Código interno do ERP |
| `Custo de Compra` | 99% | Base de margem |
| `Preço de varejo` | 98% | |
| `NCM` | 84% | Fiscal |
| `Origem` | 98% | **É o nacional/importado que os requisitos pedem** |
| `Código de Barras` | 60% | EAN |

**`Origem` usa o código fiscal padrão**, não uma tag livre: `0` nacional (3.055), `1` estrangeira de importação direta (267), `2` estrangeira adquirida no mercado interno (29). Isso atende ao requisito de "origem como dado estruturado, não mera tag" sem inventar nada.

**Custo:** `Custo de Compra` (catálogo, 3.373 SKUs) e `Custo Médio` (estoque, 1.152 SKUs) **não divergem em nenhuma das 1.152 linhas que têm os dois**. São o mesmo número; o do estoque é apenas menos preenchido. Não há conflito de custo a resolver.

### Não confiável hoje

**`Marca` está vazia em 90%** (3.086 de 3.415) e os 23 valores existentes têm duplicata por caixa: `Plasmoto` e `PLASMOTO`, `Off Racer` e variantes. Marca não serve como filtro até ser normalizada e preenchida.

**`Categorias` tem 64 valores** com hierarquia embutida por seta — `MANETE→XRE/BROS/TORNADO`, `MANETE→FAZER 250` — misturada com valores que não são categoria: `999`, `ESTOQUE INATIVO`. Na prática funciona como linha de produto, e a parte antes da seta é a categoria real.

**`Unidade` tem 11 valores com duplicata semântica:** `UN` (2.492), `PAR` (441), `KIT` (275), `PC` (60), `UNID` (33), `PECAS` (16), `PA` (3). `UN`/`UNID` e `PC`/`PECAS`/`PA` são a mesma coisa escrita de formas diferentes. Precisa de normalização na importação.

---

## 5. Achado que afeta analytics: estoque com valor sentinela

O somatório de estoque dá **5.876.075 unidades** — número implausível para uma loja de peças de moto. A distribuição explica:

- mediana: **993**
- p90: **9.919**
- p99: **9.999**
- **404 linhas acima de 1.000 unidades concentram 68% do total**

Os maiores valores são redondos e repetidos:

```
LCH4              28.700   Lampada Comum H4
7773-111          19.981   Kit Manopla Jupiter TM2
AC1402Vermelha    15.920   Chave Honda
1909-3919         10.994   Retrovisor Esportivo TM2
1909-3913         10.994   Retrovisor Esportivo TM2   (mesmo valor)
1909-3915         10.992   Retrovisor Esportivo TM2
```

Quatro retrovisores com ~10.993 unidades cada não é estoque real. O padrão é típico de **estoque artificial para manter o anúncio ativo** — prática comum em marketplace para item sob encomenda ou de giro contínuo.

**Por que isso importa muito:** cobertura em dias, data estimada de ruptura e sugestão de compra são calculadas sobre o saldo. Num SKU com saldo sentinela, todas as três produzem número sem significado — e com aparência de certeza, que é pior que não ter número.

**Decisão pendente — ver seção 7.**

---

## 6. Integridade entre os arquivos

Verificada, não presumida:

| Verificação | Resultado |
|---|---|
| SKU do estoque existe no catálogo | ✅ 0 órfãos |
| Componente de kit existe no catálogo | ✅ 0 órfãos |
| SKU do catálogo sem linha de estoque | 43 (aceitável — produto sem saldo) |
| SKU do mapeamento ausente do catálogo | **138 — são exatamente os kits** |
| Estoque negativo | ✅ nenhum |

Um único armazém: `ESTOQUE LOJA`.

**`Em Trânsito (Compra)` e `Em Trânsito (Transferência)` estão zerados em todas as 3.372 linhas.** O recurso existe no ERP mas não é usado. O `em trânsito` da V3 virá dos pedidos de compra, não daqui.

**`Ocupado`** tem 686 unidades em 300 linhas — é o **reservado** da V3.

---

## 7. Decisões pendentes que esta análise levantou

### I — A V3 cobre os outros marketplaces?

14% dos vínculos são Shopee, Kwai, Temu e TikTok. Opções: modelar o vínculo genérico por canal desde já (custo quase zero agora); restringir ao Mercado Livre e ignorar o resto na importação; ou importar tudo mas só exibir Mercado Livre.

### II — Como tratar o estoque sentinela?

404 SKUs com saldo artificial. Opções: marcar SKU como "estoque não gerenciado" e suprimir cobertura/ruptura/compra nele; usar um limiar (por exemplo, acima de 1.000 unidades) como heurística; ou tratar tudo como real e aceitar métrica sem sentido nesses itens.

### III — Marca

90% vazia e com duplicata de caixa. Filtro por marca é requisito. Opções: derivar de `Categorias`, normalizar o que existe e conviver com lacuna, ou adiar o filtro até haver cadastro.

---

## 8. Mapeamento para o schema da V3

O que já está decidido pelos dados, independente das pendências acima:

| Arquivo do UpSeller | Destino na V3 |
|---|---|
| `export_warehouse_products` | `skus` (natureza `PRODUTO`) + atributos fiscais e dimensionais |
| `export_kit` | `skus` (natureza `KIT`) + `sku_components` |
| `SKU_Map_Relationship` | `sku_listing_links` |
| `Lista_de_Estoque` | `erp_stock_snapshots` — fonte de alinhamento da D-029, **nunca** escrita direta em `inventory_balances` |

O ledger da V3 continua sendo autossuficiente (D-028): o UpSeller entra por snapshot, e a divergência gera `AJUSTE_RECONCILIACAO` auditável.
