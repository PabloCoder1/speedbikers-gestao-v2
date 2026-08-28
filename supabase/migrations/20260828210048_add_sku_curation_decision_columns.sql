-- A DECISAO humana sobre o SKU passa a ter data propria, separada do VALOR
-- (D-133).
--
-- O motivo nao e auditoria, e uma falha concreta de fila de trabalho. O
-- importador do UpSeller nao so atualiza: ele INSERE SKU novo
-- (`apps/worker/src/handlers/erp-import-apply.ts`, applyProducts). Todo SKU que
-- a proxima planilha criar nasce com `stock_is_virtual = false` por default --
-- e, sem uma marca de decisao, esse SKU novo fica INDISTINGUIVEL de um que
-- alguem ja examinou e classificou como estoque fisico. Ele some da fila de
-- curadoria para sempre, mesmo chegando com saldo 999.
--
-- `stock_is_virtual_set_at is null` passa a significar NUNCA CLASSIFICADO.
-- `false` deixa de ser resposta e volta a ser ausencia de resposta.
--
-- `updated_at` NAO serve para isso: a trigger `skus_set_updated_at` e bumpada
-- pelo importador a cada planilha, entao ela mede "quando o ERP falou deste
-- SKU", nunca "quando uma pessoa decidiu sobre ele".

alter table public.skus
  add column stock_is_virtual_set_by uuid references public.profiles(id) on delete set null,
  add column stock_is_virtual_set_at timestamptz,
  add column supplier_brand_set_by uuid references public.profiles(id) on delete set null,
  add column supplier_brand_set_at timestamptz;

-- CHECK de IMPLICACAO, e nao bicondicional (`by is null = at is null`).
--
-- A diferenca importa por causa do `on delete set null`: apagar o usuario
-- zeraria `set_by` e um bicondicional estouraria a constraint numa operacao
-- que nao tem nada de errado -- exatamente a classe de erro enganoso que
-- D-099 e D-113 tiveram de consertar depois. Com implicacao, o ator some e a
-- DATA fica: continua sabendo que alguem decidiu, so nao quem.
--
-- `set_at` e o marcador de decisao; `set_by` e cortesia.
--
-- Passa nas 1.280 linhas DERIVED existentes sem backfill nenhum: elas tem
-- `supplier_brand_source = 'DERIVED'` e as quatro colunas novas nulas.
alter table public.skus
  add constraint skus_stock_virtual_decision_dated
    check (stock_is_virtual_set_by is null or stock_is_virtual_set_at is not null),
  add constraint skus_supplier_brand_manual_dated
    check (supplier_brand_source is distinct from 'MANUAL' or supplier_brand_set_at is not null),
  -- Medido antes de escrever: a maior marca hoje tem 12 caracteres, nenhuma
  -- fora de caixa alta, nenhuma com espaco nas bordas.
  add constraint skus_supplier_brand_shape
    check (supplier_brand is null or char_length(btrim(supplier_brand)) between 1 and 60);

comment on column public.skus.stock_is_virtual_set_at is
  'Quando uma PESSOA classificou este SKU como virtual ou fisico. NULL = NUNCA CLASSIFICADO -- inclusive o SKU que o proximo import criar, que nasce stock_is_virtual=false por default (D-133). Sem esta coluna, false significa ao mesmo tempo "examinado e aprovado" e "ninguem olhou", e o SKU novo desaparece da fila. `updated_at` nao serve: o importador a bumpa a cada planilha.';

comment on column public.skus.stock_is_virtual_set_by is
  'Quem classificou. `on delete set null` com CHECK de IMPLICACAO: apagar o usuario zera o ator e PRESERVA a data, porque o que a fila precisa saber e que a decisao existe (D-133).';

comment on column public.skus.supplier_brand_set_at is
  'Quando uma PESSOA preencheu a marca do fornecedor. Obrigatoria quando supplier_brand_source = MANUAL (D-133).';

comment on column public.skus.supplier_brand_set_by is
  'Quem preencheu a marca. Mesmo desenho de stock_is_virtual_set_by (D-133).';
