# NF-e / XML — Speed Bikers Gestão V3

> Dono documental de: layout oficial da Nota Fiscal Eletrônica, mapeamento de campos e regras de importação de documento fiscal.
> Status: **schema, parser e parse implementados em 2026-08-22, seguindo o layout oficial — decisão explícita do usuário de não esperar um XML real** ("não tenho o modelo real agora... segue"). Validação contra um XML real de fornecedor da Speed Bikers continua pendente; pode exigir ajuste quando aparecer (`docs/HANDOFF.md`).

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
- [ ] Validação contra XML real de fornecedor da Speed Bikers — **decisão do usuário: seguir sem esperar (2026-08-22)**. Parser implementado contra o layout oficial; risco assumido, não ignorado — ver secao 3
- [x] Como o código do produto do fornecedor (`det/prod/cProd`) deve mapear para `skus` — **resolvido**: vínculo humano por documento na tela de conferência (próxima etapa), sem cadastro fornecedor→SKU reutilizável ainda (limitação conhecida, secao 3)
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

## 2.2 Direção do movimento — `ide/tpNF`

Fonte: documentação de mercado convergente sobre rejeições 518/519 da SEFAZ (que validam a consistência entre `tpNF` e o CFOP do item), consulta em 2026-08-22.

- `tpNF = 0` → **Entrada** (compra, devolução recebida, ajuste de entrada) → `stock_movements.movement_type = 'ENTRADA_NFE'`
- `tpNF = 1` → **Saída** (venda direta fora do ML, devolução ao fornecedor, ajuste de saída) → `stock_movements.movement_type = 'SAIDA_NFE'`

O CFOP de cada item (`det/prod/CFOP`) é consistente com `tpNF` por regra da própria SEFAZ (CFOP iniciado em 1/2/3 = entrada, 5/6/7 = saída) — pode servir de conferência cruzada, mas `tpNF` é a fonte primária por ser um campo único no nível do documento, não por item.

## 2.3 Reforma tributária 2026 — IBS/CBS/IS

Fonte: [Documento XML NFe — reforma tributária](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/reforma-tributaria-do-consumo/20251114-documento-xml-nfe.txt/view) (Receita Federal, novembro/2025), consulta em 2026-08-22.

A partir de 2026, o bloco `imposto` de cada item pode conter um grupo novo `IBSCBS` (`CST`, `cClassTrib`, `gIBSCBS` com `vBC`/`gIBSUF`/`gIBSMun`/`vIBS`/`gCBS`), e `total` ganha `IBSCBSTot`, ao lado dos blocos tradicionais (`ICMS`, `IPI`, `PIS`, `COFINS`) que continuam existindo durante a transição. **Não afeta o parser do ledger de estoque** (secao 2 já registra que `imposto` é ignorado para `stock_movements`), mas importa para não estranhar a presença desses campos novos em XMLs emitidos a partir de 2026 — não é XML malformado, é o layout vigente.

---

## 3. Pendências que só um XML real resolve

**Decisão do usuário em 2026-08-22**: implementar o schema e o parser contra o layout oficial agora, sem esperar um arquivo real. Risco aceito conscientemente, não ignorado — os itens abaixo continuam pendentes e o parser (`packages/domain/src/nfe/parse.ts`) pode precisar de ajuste quando um XML real aparecer.

- **Matching de item para SKU — resolvido, não como automação**: `det/prod/cProd` é o código do produto **do fornecedor**, texto livre, sem padrão entre emissores — implementado como vínculo humano por documento na tela de conferência (próxima etapa), mesmo espírito de `sku_listing_links`/Central de Vinculações mas SEM cadastro fornecedor→SKU reutilizável entre notas futuras do mesmo fornecedor. `cEAN` (código de barras) seria candidato a match automático, mas **`skus` hoje não tem coluna de EAN/GTIN** (conferido em `docs/DATABASE.md`, 2026-08-22) — matching por `cEAN` exigiria migration própria adicionando essa coluna, decisão que não deve ser tomada só por conveniência do parser de NF-e sem necessidade de produto mais ampla.
- **Múltiplos fornecedores, formatos variados**: cada emissor gera o próprio XML por sistema próprio (SAP, Bling, Omie, etc.) — o layout oficial é o mesmo, mas preenchimento de campos opcionais varia. O parser trata `NCM`/`CFOP` como opcionais (`null` quando ausentes) por precaução, mas só um XML real de mais de um fornecedor mostra o que de fato varia.
- **Encoding**: o parser assume UTF-8 (`buffer.toString("utf-8")`, `apps/worker/src/nfe-xml-reader.ts`) — padrão oficial, mas não confirmado contra um arquivo real. Um fornecedor que exporte em ISO-8859-1 (Latin-1, comum em sistemas legados brasileiros) produziria caracteres acentuados corrompidos, não um erro explícito — risco silencioso a observar no primeiro arquivo real.
- **Volume esperado e cadência**: quantas NF-e por mês a Speed Bikers processa, se chegam por e-mail, por XML direto do fornecedor ou só por consulta em serviço como `meudanfe.com.br` (mencionado pelo usuário como fonte) — importa para decidir se o upload é sempre manual (um arquivo por vez) ou se compensa suporte a lote (múltiplos XML de uma vez, como o importador do UpSeller já faz com XLSX). Ainda não implementado: a rota de upload em si.

---

## Como adicionar novo campo confirmado

Mesmo processo de `docs/MERCADO_LIVRE.md`: citar a fonte oficial (URL) e a data da consulta, ou citar o XML real específico usado como fixture (sem publicar dado sensível do fornecedor/CNPJ real no repositório — anonimizar em teste).
