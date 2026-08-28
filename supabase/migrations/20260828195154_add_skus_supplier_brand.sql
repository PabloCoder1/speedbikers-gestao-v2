-- Marca REAL do fornecedor: `skus.brand` nao e marca, e CATEGORIA do UpSeller.
--
-- Medido em 28/08/2026: 2.255 de 3.399 SKUs (66%) tem brand = 'MANETE', que e
-- um tipo de peca. NAVETEC, PLASMOTO, TMAC, AOLIXIM aparecem no mesmo campo --
-- o export mistura os dois conceitos numa coluna so. Isso bloqueia duas coisas
-- que o usuario pediu: a origem Nacional/Importado (que e POR FORNECEDOR --
-- "Navetec e Off Racer sao sempre importados") e a marcacao em lote de
-- `stock_is_virtual` (D-127), porque 86% do estoque sentinela esta debaixo de
-- 'MANETE'.
--
-- POR QUE UMA COLUNA NOVA E NAO CORRIGIR `brand`. O importador SOBRESCREVE
-- `brand` a cada planilha (`packages/domain/src/upseller/apply.ts:90`). Toda
-- atribuicao feita a mao morreria no proximo import. A atribuicao precisa
-- morar numa coluna que o importador nao toca.
--
-- `supplier_brand_source` separa o que a maquina deduziu do que a pessoa
-- decidiu: um reprocessamento futuro pode reescrever DERIVED sem nunca pisar
-- em MANUAL.

alter table public.skus
  add column supplier_brand text,
  add column supplier_brand_source text
    check (supplier_brand_source is null or supplier_brand_source in ('DERIVED', 'MANUAL'));

alter table public.skus
  add constraint skus_supplier_brand_source_coherent check (
    (supplier_brand is null and supplier_brand_source is null)
    or (supplier_brand is not null and supplier_brand_source is not null));

comment on column public.skus.supplier_brand is
  'Marca REAL do fornecedor. `brand` NAO serve: guarda a categoria do UpSeller (66% dos SKUs em MANETE) e e sobrescrita a cada import. NULL = ainda nao atribuida, por decisao (D-129): so semeamos onde havia evidencia no titulo ou no codigo.';

comment on column public.skus.supplier_brand_source is
  'DERIVED = deduzida por regra em D-129. MANUAL = preenchida por gente. Existe para que um reprocessamento futuro reescreva DERIVED sem pisar em MANUAL.';

-- Deducao dentro de 'MANETE', na ordem que o usuario descreveu: "grande parte
-- sao OFF Racer, apenas alguns que sao RT, TMAC ou Aolixim". O codigo do SKU
-- carrega sinal que o titulo nao carrega (prefixo `off`/`kitoff`), por isso as
-- duas fontes. O que nao tem evidencia fica NULL de proposito -- o usuario
-- pediu explicitamente para deixar vazio e preencher a mao.
update public.skus
   set supplier_brand = 'OFF RACER', supplier_brand_source = 'DERIVED'
 where brand = 'MANETE'
   and (title ~* '(off ?racer)' or sku ~* '^off|kitoff');

update public.skus
   set supplier_brand = 'RT', supplier_brand_source = 'DERIVED'
 where brand = 'MANETE'
   and supplier_brand is null
   and (title ~* '\yrt\y' or sku ~* '^rt[-0-9]');

-- Fora de 'MANETE', `brand` JA e a marca do fornecedor -- copia direta.
update public.skus
   set supplier_brand = brand, supplier_brand_source = 'DERIVED'
 where supplier_brand is null
   and brand is not null
   and brand <> 'MANETE';

create index skus_supplier_brand_idx on public.skus (organization_id, supplier_brand)
  where supplier_brand is not null;
