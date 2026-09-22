-- Higiene da marca do fornecedor, antes de o importador passar a derivá-la (D-390).
--
-- O QUE ACONTECEU. A marcação em lote de `/produtos` foi usada em 14/09/2026
-- (3.143 SKUs em 32 minutos) e 18/09 (97 SKUs num minuto) para copiar a coluna
-- `Categorias` do UpSeller para a marca. Medido no export de 22/09: `Categorias`
-- só é marca em 1.037 das 3.074 linhas. Nas outras é tipo de peça mais modelo de
-- moto (`MANETE→CB 300R`, 2.037 linhas) ou status e ruído de cadastro (`999`,
-- `ESTOQUE INATIVO`, `OCUPADO`, 356 linhas).
--
-- O resultado em produção: 2.393 SKUs com `OFFRACER` — incluindo 20 que têm
-- `RT PARTS` escrito no próprio título — e 254 com um status no lugar da marca.
--
-- ESTA MIGRATION NÃO DEDUZ MARCA. Ela só tira do caminho o que não é marca e
-- devolve o campo ao importador. Quem deduz é `resolveSupplierBrand`
-- (`packages/domain/src/upseller/supplier-brand.ts`), na próxima planilha
-- importada — uma regra só, testada, em vez de uma cópia dela em SQL.

-- 1. Status e ruído de cadastro não são marca.
--
-- `ESTOQUE INATIVO` continua chegando como `is_discontinued` por
-- `parseCategory`; `OCUPADO` é rascunho. Os dois campos vão juntos por causa do
-- CHECK `skus_supplier_brand_source_coherent`.
update public.skus
   set supplier_brand = null,
       supplier_brand_source = null,
       supplier_brand_set_at = null,
       supplier_brand_set_by = null
 where supplier_brand is not null
   and (upper(btrim(supplier_brand)) in ('ESTOQUE INATIVO', 'OCUPADO')
        or btrim(supplier_brand) ~ '^[0-9]+$');

-- 2. Uma grafia por fornecedor.
--
-- D-129 já tinha colapsado `OFFRACER` em `OFF RACER` por um motivo que não é
-- cosmético: regra de compra escrita contra uma grafia classifica a outra
-- errado. A marcação em lote reintroduziu a grafia do ERP.
update public.skus set supplier_brand = 'OFF RACER' where supplier_brand in ('OFFRACER', 'OFF-RACER');
update public.skus set supplier_brand = 'AOLIXIM'   where supplier_brand = 'AOLIXIN';
update public.skus set supplier_brand = 'TMAC'      where supplier_brand = 'T-MAC';
update public.skus set supplier_brand = 'RT'        where supplier_brand in ('RT PARTS', 'RTPARTS');
update public.skus set supplier_brand = 'PANDÃO'    where supplier_brand = 'PANDAO';

-- 3. A marcação em lote deixa de bloquear o importador.
--
-- `MANUAL` existe para proteger decisão POR ITEM. O que está gravado não é
-- isso: são 32 minutos de lote, uma marca por vez, copiada da categoria. Marcar
-- como `DERIVED` devolve essas linhas ao importador, que na próxima planilha as
-- reescreve com evidência — inclusive os 20 `RT PARTS`.
--
-- A janela é fechada de propósito: só o que já estava marcado ANTES desta
-- decisão. Marca escolhida a partir de agora na tela `/produtos` nasce `MANUAL`
-- e o importador não a toca (`comMarcaDoFornecedor`, em `erp-import-apply.ts`).
update public.skus
   set supplier_brand_source = 'DERIVED',
       supplier_brand_set_at = null,
       supplier_brand_set_by = null
 where supplier_brand_source = 'MANUAL'
   and supplier_brand_set_at < timestamptz '2026-09-22 00:00:00-03';

comment on column public.skus.supplier_brand is
  'Marca REAL do fornecedor. `brand` NAO serve: guarda a categoria do UpSeller (66% dos SKUs em MANETE). Desde D-390 o importador a DERIVA da planilha por cascata de evidencia (coluna Marca, Categorias quando e marca, "Marca:" na descricao, titulo/codigo, linha de produto) e NULL segue significando "sem evidencia", nunca zero.';

comment on column public.skus.supplier_brand_source is
  'DERIVED = derivada da planilha pelo importador (D-390), reescrita a cada import. MANUAL = escolhida por gente na tela /produtos; o importador nunca pisa nela.';
