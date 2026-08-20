-- ============================================================
-- Catalogo: SKUs e composicao de kits.
--
-- Modelado sobre a exportacao REAL do UpSeller de 2026-08-20 (3.415 produtos,
-- 138 kits, 272 componentes). A analise que sustenta cada escolha esta em
-- `docs/UPSELLER.md`.
--
-- O SKU e a entidade central da V3 (D-004). Anuncio e canal, nao identidade.
-- ============================================================

-- ============================================================
-- 1. skus
--
-- Uma tabela para PRODUTO e KIT, distinguidos por `kind`.
--
-- Por que uma so: medido na exportacao, **nenhum dos 138 kits existe no
-- catalogo de produtos** — 0 de 138 — mas todos aparecem no mapeamento de
-- anuncios. Um kit e um SKU vendavel que nao e produto de armazem. Separar em
-- duas tabelas obrigaria toda consulta de venda, vinculo e anuncio a fazer
-- union das duas, para sempre.
-- ============================================================

create table public.skus (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `sku` preserva o texto original; `sku_key` e a identidade normalizada.
  -- Padrao herdado da V2, que estava correto.
  sku text not null check (char_length(btrim(sku)) between 1 and 120),
  sku_key text not null
    generated always as (upper(btrim(sku))) stored,

  kind text not null default 'PRODUTO' check (kind in ('PRODUTO', 'KIT')),

  title text,

  -- Identificadores do ERP. `erp_product_code` vem 100% preenchido; `erp_spu`,
  -- 77%. Guardados para reconciliar importacoes futuras sem depender do texto
  -- do SKU.
  erp_product_code text,
  erp_spu text,

  -- Marca vem da coluna `Categorias` do ERP, normalizada (D-039). A coluna
  -- `Marca` do proprio ERP esta 90% vazia e nao serve.
  brand text,
  category_raw text,

  -- `ESTOQUE INATIVO` no ERP: produto em encerramento, com estoque sendo
  -- zerado para deixar de ser trabalhado. Estado de negocio, nao lixo.
  is_discontinued boolean not null default false,

  is_active boolean not null default true,

  -- Codigo de origem da NF-e. NAO e tag livre: e a tabela fiscal padrao, que
  -- ja vem preenchida em 98% do catalogo. Atende ao requisito de
  -- "origem como dado estruturado" sem inventar classificacao propria.
  --   0 nacional · 1 estrangeira, importacao direta
  --   2 estrangeira, adquirida no mercado interno
  --   3,4,5 nacional com conteudo de importacao
  --   6,7 estrangeira sem similar nacional · 8 nacional, conteudo > 70%
  origin_code smallint check (origin_code between 0 and 8),

  -- Derivado, nao digitado: evita que "nacional" e "importado" divirjam do
  -- codigo fiscal por edicao manual.
  is_imported boolean generated always as (origin_code in (1, 2, 6, 7)) stored,

  -- Unidade normalizada na importacao: o ERP tem UN/UNID e PC/PECAS/PA
  -- significando a mesma coisa.
  unit text,

  barcode text,
  ncm text,
  cest text,

  retail_price numeric(12, 2) check (retail_price is null or retail_price >= 0),
  purchase_cost numeric(12, 2) check (purchase_cost is null or purchase_cost >= 0),

  weight_g integer check (weight_g is null or weight_g >= 0),
  length_cm numeric(8, 2) check (length_cm is null or length_cm >= 0),
  width_cm numeric(8, 2) check (width_cm is null or width_cm >= 0),
  height_cm numeric(8, 2) check (height_cm is null or height_cm >= 0),

  image_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint skus_org_key_unique unique (organization_id, sku_key)
);

comment on table public.skus is
  'SKU canonico. Entidade central da V3 (D-004). Cobre produto e kit.';

comment on column public.skus.kind is
  'PRODUTO tem saldo proprio; KIT nao tem, e decomposto em sku_components.';

comment on column public.skus.origin_code is
  'Codigo de origem da NF-e (tabela fiscal padrao), nao classificacao propria.';

comment on column public.skus.brand is
  'Derivada da coluna Categorias do UpSeller, normalizada. Ver D-039.';

-- Consulta quente: buscar SKU dentro da organizacao. `sku_key` ja tem indice
-- pelo UNIQUE; este cobre a listagem filtrada, que e o outro padrao real.
create index skus_org_active_idx
  on public.skus (organization_id, is_active, is_discontinued);

create index skus_org_brand_idx
  on public.skus (organization_id, brand)
  where brand is not null;

-- `erp_product_code` e a chave de reconciliacao com o ERP em importacoes
-- futuras. Unico por organizacao quando presente.
create unique index skus_org_erp_code_unique
  on public.skus (organization_id, erp_product_code)
  where erp_product_code is not null;

create trigger skus_set_updated_at
  before update on public.skus
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. sku_components
--
-- Composicao de kit. Medido: 138 kits, de 1 a 4 componentes, com quantidades
-- 1, 2, 3, 4 e 10.
--
-- `quantity` e numeric, nao integer: o ERP exporta 1.0, e nada garante que
-- todo componente futuro seja unidade inteira.
-- ============================================================

create table public.sku_components (
  kit_sku_id uuid not null references public.skus(id) on delete cascade,
  component_sku_id uuid not null references public.skus(id) on delete restrict,
  quantity numeric(12, 3) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (kit_sku_id, component_sku_id),

  -- Um kit nao pode conter a si mesmo. Nao impede ciclo indireto (A contem B,
  -- B contem A), mas o ERP nao produz aninhamento: todos os 272 componentes
  -- sao produtos de armazem, nunca outros kits.
  constraint sku_components_no_self check (kit_sku_id <> component_sku_id)
);

comment on table public.sku_components is
  'Composicao de kit. Venda de kit movimenta o estoque dos componentes.';

-- `on delete restrict` no componente e proposital: apagar um produto que
-- compoe kit deve falhar, nao silenciosamente esvaziar o kit.

create index sku_components_component_idx
  on public.sku_components (component_sku_id);

create trigger sku_components_set_updated_at
  before update on public.sku_components
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. Integridade de natureza
--
-- Garante no banco o que a exportacao mostrou ser verdade: so KIT tem
-- componente, e componente e sempre PRODUTO.
--
-- Sem isto, um erro de importacao criaria um "produto com componentes" que
-- nenhuma tela saberia interpretar.
-- ============================================================

create or replace function private.sku_components_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  kit_kind text;
  component_kind text;
begin
  select kind into kit_kind from public.skus where id = new.kit_sku_id;
  select kind into component_kind from public.skus where id = new.component_sku_id;

  if kit_kind is distinct from 'KIT' then
    raise exception 'sku_components: % nao e KIT', new.kit_sku_id;
  end if;

  if component_kind is distinct from 'PRODUTO' then
    raise exception 'sku_components: componente % precisa ser PRODUTO (kit aninhado nao suportado)',
      new.component_sku_id;
  end if;

  return new;
end;
$$;

create trigger sku_components_validate_kinds
  before insert or update on public.sku_components
  for each row execute function private.sku_components_validate();

-- ============================================================
-- 4. RLS
--
-- Catalogo e legivel por qualquer membro da organizacao: preco, custo e
-- estoque aparecem em praticamente toda tela.
--
-- Escrita nao passa pela Data API. O catalogo vem do UpSeller por importacao,
-- executada pelo worker com service_role (D-028). Sem policy de escrita, a
-- ausencia ja nega.
-- ============================================================

alter table public.skus enable row level security;
alter table public.sku_components enable row level security;

create policy skus_select_own_org
  on public.skus for select to authenticated
  using (private.is_member_of(organization_id));

create policy sku_components_select_own_org
  on public.sku_components for select to authenticated
  using (
    exists (
      select 1
      from public.skus k
      where k.id = sku_components.kit_sku_id
        and private.is_member_of(k.organization_id)
    )
  );

-- ============================================================
-- 5. GRANTs
--
-- Privilegio de tabela e avaliado ANTES da policy (docs/DATABASE.md secao 5).
-- `authenticated` recebe apenas SELECT: a escrita e do importador.
-- ============================================================

grant select on public.skus, public.sku_components to authenticated;

grant select, insert, update, delete
  on public.skus, public.sku_components
  to service_role;

revoke all on public.skus from anon;
revoke all on public.sku_components from anon;
