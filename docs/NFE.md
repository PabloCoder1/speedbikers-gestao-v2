# NF-e / XML — Speed Bikers Gestão V3

> Dono documental de: layout oficial da Nota Fiscal Eletrônica, mapeamento de campos e regras de importação de documento fiscal.
> Status: **fluxo completo (upload → parse → conferência → confirmação → aplicação) implementado em 2026-08-22; validado contra o PRIMEIRO XML real de fornecedor no mesmo dia** — achado um erro real (direção do movimento, D-053) e corrigido antes de existir qualquer código de aplicação (nenhum `stock_movements` errado chegou a ser gravado). Falta validar contra um segundo fornecedor para separar "layout oficial" de "peculiaridade deste emissor".

---

## REGRA ABSOLUTA

**Nunca inventar campo, estrutura ou comportamento do XML da NF-e** — mesmo princípio de `docs/MERCADO_LIVRE.md` §REGRA ABSOLUTA (`docs/PROMPT_MASTER.md` §9), aplicado aqui a um padrão do governo brasileiro em vez de uma API de terceiro.

Antes de implementar o parser:

1. consultar a documentação oficial vigente (Portal NF-e / Receita Federal) e, quando possível, validar contra um XML real fornecido pelo usuário;
2. registrar o campo e a fonte **neste arquivo**;
3. considerar reforma tributária (IBS/CBS/IS, em vigor desde 2026), duplicidade e idempotência;
4. escrever teste com fixture gravado a partir de um XML real, nunca sintético só da memória.

Este arquivo tem seções deliberadamente vazias quando o item ainda não foi confirmado contra um XML real. **Seção vazia é sinal de trabalho pendente, não de esquecimento.**

---

## 1. Lista de verificação

Confirmado por pesquisa em fontes oficiais (Portal da NF-e `nfe.fazenda.gov.br`, Receita Federal `gov.br/receitafederal`, consulta em 2026-08-22):

- [x] Estrutura geral do XML (envelope, `infNFe`, `ide`, `emit`, `dest`, `det`, `imposto`, `total`) — secao 2
- [x] Composição da chave de acesso (44 dígitos) — secao 2.1
- [x] Campo que determina entrada vs. saída (`ide/tpNF`) — secao 2.2
- [x] Impacto da reforma tributária 2026 (IBS/CBS/IS) na estrutura de impostos — secao 2.3
- [x] Validação contra XML real de fornecedor da Speed Bikers — **primeiro fornecedor confirmado em 2026-08-22** (Plasmoto, compra de 19 itens). Achou e corrigiu um erro real de direção do movimento (D-053). Falta um segundo fornecedor para separar layout oficial de peculiaridade de emissor — secao 3
- [x] Como o código do produto do fornecedor (`det/prod/cProd`) deve mapear para `skus` — **resolvido**: vínculo humano por documento na tela de conferência (`/notas-fiscais/:id`, `link_document_item`, implementado em 2026-08-22), sem cadastro fornecedor→SKU reutilizável ainda (limitação conhecida, secao 3)
- [ ] Encoding real dos arquivos (UTF-8 é o padrão oficial, mas fornecedores variam) — confirmar com arquivo real quando aparecer
- [ ] Layout de DANFE em PDF (fallback, só depois do XML estar sólido) — não pesquisado, não bloqueia o começo

---

## 2. Estrutura do XML (modelo 55, layout 4.00)

Fonte: [Manual de Orientação do Contribuinte](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE%3D) (Portal da NF-e) e [Documento XML NFe — reforma tributária](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/reforma-tributaria-do-consumo/20251114-documento-xml-nfe.txt/view) (Receita Federal, novembro/2025), consultados em 2026-08-22.

```text
<nfeProc>                              -- envelope opcional: NFe + protocolo de autorização
  <NFe>
    <infNFe Id="NFe{chave de 44 dígitos}" versao="4.00">
      <ide>       cUF, cNF, natOp, mod, serie, nNF, dhEmi, tpNF, tpAmb, ...
      <emit>      CNPJ, xNome, enderEmit, IE, CRT     -- fornecedor
      <dest>      CNPJ, xNome, enderDest, indIEDest   -- Speed Bikers
      <det nItem="N">
        <prod>    cProd, cEAN, xProd, NCM, CFOP, uCom, qCom, vUnCom, vProd
        <imposto> ICMS, IPI, PIS, COFINS, IBSCBS (novo, reforma 2026)
      <total>     ICMSTot, IBSCBSTot (novo)
      <transp> <cobr> <pag> <infAdic>   -- não relevantes para o ledger de estoque
  <protNFe>       -- protocolo de autorização da SEFAZ (presença confirma nota autorizada)
```

**Para o ledger de estoque só interessam `det/prod`** (código do produto, quantidade, valores) **e `ide/tpNF`** (direção). O bloco `imposto` não afeta `stock_movements` — é dado fiscal, não dado de estoque. Não há necessidade de parsear ICMS/IPI/PIS/COFINS/IBSCBS para este caso de uso; podem ficar como metadado bruto do documento (`raw jsonb`?, decisão pendente) se algum dia servirem a outra tela.

**Assinatura digital (`<Signature>`)**: presente no XML autorizado, mas **não será validada criptograficamente** por este importador — o passo de "conferência" humana (`docs/PROMPT_MASTER.md` §13, item 5-7) é quem garante que o documento é legítimo antes da confirmação, mesmo raciocínio já usado para o importador do UpSeller (planilha também não tem assinatura, e a confiança vem da revisão humana, não de criptografia).

## 2.1 Chave de acesso — 44 dígitos

Fonte: múltiplas referências de mercado convergentes (Portal da NF-e não publica um único documento didático para isso; a estrutura é derivada do Manual de Integração), consulta em 2026-08-22. **Tratar como dado estrutural confirmado, não como comportamento de API — é auditável no próprio XML (`Id` de `infNFe` e conteúdo de `ide`).**

```text
posição   tamanho   campo    significado
1-2       2         cUF      código IBGE da UF do emitente
3-6       4         AAMM     ano (2) + mês (2) de emissão
7-20      14        CNPJ     CNPJ do emitente
21-22     2         mod      modelo do documento (55 = NF-e)
23-25     3         serie    série do documento
26-34     9         nNF      número sequencial da NF-e
35        1         tpEmis   forma de emissão
36-43     8         cNF      código numérico aleatório
44        1         cDV      dígito verificador (módulo 11)
```

O atributo `Id` de `infNFe` é `"NFe" + chave de 44 dígitos` — mesma chave que aparece em `ide/cNF`+outros campos compostos. **Candidato natural a `content_hash`? Não** — `content_hash` deve continuar sendo hash SHA-256 do ARQUIVO (mesmo padrão de `erp_import_batches.content_hash`, já com o comentário "mesma garantia que documents.content_hash dara para a NF-e" na migration `20260820200000_create_erp_import.sql`), não a chave de acesso. A chave de acesso é **outro** dado a guardar (identifica a nota no SEFAZ; útil para busca/exibição), mas não substitui o hash de conteúdo — dois arquivos poderiam teoricamente ter a mesma chave e bytes diferentes (correção, reenvio), e o hash é sobre o que foi de fato enviado ao V3.

## 2.2 Direção do movimento — CORRIGIDO em 2026-08-22 contra XML real (D-053)

**`ide/tpNF` sozinho NÃO decide a direção do movimento no estoque da Speed Bikers.** `tpNF` reflete a operação do **emitente** do documento — `0` = entrada para o emitente, `1` = saída para o emitente. A implementação original deste parser usava `tpNF` direto (`tpNF === "0" ? "ENTRADA" : "SAIDA"`), o que está tecnicamente certo sobre o que `tpNF` significa, mas ERRADO sobre como aplicá-lo: uma compra de fornecedor chega com `tpNF=1` (é saída do lado de quem vendeu), o que inverteria a direção se usado direto.

**Confirmado pelo primeiro XML real de fornecedor recebido do usuário** (2026-08-22): `natOp="VENDA P/FORA DO ESTADO"` (nome da operação do ponto de vista de quem vende) + `tpNF=1` + `emit`=fornecedor + `dest`=Speed Bikers. Usar `tpNF` direto classificaria essa COMPRA como `SAIDA_NFE` — inverteria o sinal do movimento gerado no ledger.

**Regra correta**: comparar `emit/CNPJ` e `dest/CNPJ` contra o CNPJ da PRÓPRIA organização (`organizations.cnpj`):

- `dest/CNPJ` = CNPJ da organização → **Entrada** (a Speed Bikers está recebendo) → `stock_movements.movement_type = 'ENTRADA_NFE'`
- `emit/CNPJ` = CNPJ da organização → **Saída** (a Speed Bikers está emitindo) → `stock_movements.movement_type = 'SAIDA_NFE'`
- nenhum dos dois bate → erro, documento rejeitado (não adivinha)

`ide/tpNF` continua sendo lido e validado (precisa ser `'0'` ou `'1'`), mas não decide mais a direção — ver D-053 (`docs/DECISIONS.md`) para o raciocínio completo. O CFOP de cada item (`det/prod/CFOP`) é consistente com `tpNF` por regra da própria SEFAZ (CFOP iniciado em 1/2/3 = entrada, 5/6/7 = saída, do ponto de vista do emitente) — não usado como conferência cruzada por ora, decisão registrada em D-053.

## 2.3 Reforma tributária 2026 — IBS/CBS/IS

Fonte: [Documento XML NFe — reforma tributária](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/reforma-tributaria-do-consumo/20251114-documento-xml-nfe.txt/view) (Receita Federal, novembro/2025), consulta em 2026-08-22.

A partir de 2026, o bloco `imposto` de cada item pode conter um grupo novo `IBSCBS` (`CST`, `cClassTrib`, `gIBSCBS` com `vBC`/`gIBSUF`/`gIBSMun`/`vIBS`/`gCBS`), e `total` ganha `IBSCBSTot`, ao lado dos blocos tradicionais (`ICMS`, `IPI`, `PIS`, `COFINS`) que continuam existindo durante a transição. **Não afeta o parser do ledger de estoque** (secao 2 já registra que `imposto` é ignorado para `stock_movements`), mas importa para não estranhar a presença desses campos novos em XMLs emitidos a partir de 2026 — não é XML malformado, é o layout vigente.

---

## 3. Pendências que um XML real resolve

**Primeiro XML real recebido do usuário em 2026-08-22** (compra de fornecedor, dados anonimizados nos testes) — revelou um erro real na direção do movimento (D-053, secao 2.2 acima) e confirmou vários pontos abaixo. Segue pendente até um SEGUNDO fornecedor aparecer, para saber o que é layout oficial e o que é peculiaridade de um emissor só.

- **Matching de item para SKU — resolvido, não como automação**: `det/prod/cProd` é o código do produto **do fornecedor**, texto livre, sem padrão entre emissores — implementado como vínculo humano por documento na tela de conferência (`/notas-fiscais/:id`, implementado em 2026-08-22), mesmo espírito de `sku_listing_links`/Central de Vinculações mas SEM cadastro fornecedor→SKU reutilizável entre notas futuras do mesmo fornecedor. `cEAN` (código de barras) seria candidato a match automático, mas **`skus` hoje não tem coluna de EAN/GTIN** (conferido em `docs/DATABASE.md`, 2026-08-22) — matching por `cEAN` exigiria migration própria adicionando essa coluna, decisão que não deve ser tomada só por conveniência do parser de NF-e sem necessidade de produto mais ampla. O XML real confirmou `cEAN` preenchido em 100% dos 19 itens — bom sinal para um futuro matching automático assistido.
- **Ordem dos elementos no XML não é a do XSD oficial — confirmado, não afeta o parser**: o XML real trouxe `infAdic`/`infRespTec` ANTES de `ide`/`emit`/`det` (o XSD oficial exige a ordem inversa) e um elemento `<Id>` solto duplicando o atributo `Id` de `infNFe`. Provavelmente reformatado pelo serviço de consulta usado pelo usuário (`meudanfe.com.br`), não o XML original transmitido à SEFAZ. Sem efeito no parser: acesso é por nome de propriedade, nunca por posição.
- **Bloco `imposto` por item é real e grande** (ICMS, IPI, PIS, COFINS, IBSCBS da reforma tributária) — confirmado, integralmente ignorado pelo parser (não afeta `stock_movements`, só dado fiscal).
- **Múltiplos fornecedores, formatos variados**: só um fornecedor visto até agora (Plasmoto). O parser trata `NCM`/`CFOP` como opcionais (`null` quando ausentes) por precaução, mas só um SEGUNDO XML real de outro fornecedor mostra o que de fato varia entre sistemas emissores.
- **Encoding**: o XML real recebido é UTF-8 (`<?xml version="1.0" encoding="UTF-8"?>`), confirmado. Um fornecedor que exporte em ISO-8859-1 (Latin-1, comum em sistemas legados brasileiros) ainda seria um risco não testado.
- **Volume esperado e cadência**: quantas NF-e por mês a Speed Bikers processa, se chegam por e-mail, por XML direto do fornecedor ou só por consulta em serviço como `meudanfe.com.br` — importa para decidir se o upload é sempre manual (um arquivo por vez, como implementado: `POST /v1/nfe-imports`, `apps/api/src/nfe-import.ts`, tela `notas-fiscais/nova`) ou se compensa suporte a lote (múltiplos XML de uma vez, como o importador do UpSeller já faz com XLSX). A rota de upload de um arquivo existe desde 2026-08-22; o suporte a lote é que depende desta resposta.

---

## Como adicionar novo campo confirmado

Mesmo processo de `docs/MERCADO_LIVRE.md`: citar a fonte oficial (URL) e a data da consulta, ou citar o XML real específico usado como fixture (sem publicar dado sensível do fornecedor/CNPJ real no repositório — anonimizar em teste).
