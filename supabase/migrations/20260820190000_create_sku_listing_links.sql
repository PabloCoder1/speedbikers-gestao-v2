-- ============================================================
-- Vinculo SKU <-> anuncio do Mercado Livre.
--
-- E a tabela que sustenta a D-004: o SKU e a identidade; o anuncio e canal.
-- Sem ela, venda no Mercado Livre nao vira venda de produto.
--
-- Modelada sobre os 20.650 vinculos reais de Mercado Livre exportados do
-- UpSeller em 2026-08-20, e sobre a hierarquia de identificadores confirmada
-- na documentacao oficial (ver docs/MERCADO_LIVRE.md).
-- ============================================================

-- ============================================================
-- 1. Por que ha DOIS tipos de referencia
--
-- A documentacao oficial define tres identificadores distintos:
--
--   item_id         (MLB...)   o anuncio no marketplace
--   variation_id    (numerico) a variacao dentro do anuncio
--   user_product_id (MLBU...)  produto do catalogo DO VENDEDOR, que pode
--                              estar associado a UM OU MAIS itens
--
-- A exportacao do UpSeller mistura `MLB` e `MLBU` na mesma coluna. Medido nos
-- 20.650 vinculos de Mercado Livre:
--
--   MLB  + variacao numerica real   13.299   anuncio com variacao
--   MLB  + variante = anuncio        3.579   anuncio SEM variacao
--   MLBU + variante = anuncio        3.772   nao e anuncio: e user product
--
-- Tratar os tres como a mesma coisa produziria vinculo errado em 36% das
-- linhas. Por isso `ref_kind` e explicito.
-- ============================================================

create table public.sku_listing_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,

  ref_kind text not null check (ref_kind in ('ITEM', 'USER_PRODUCT')),

  -- ITEM: preenchidos `item_id` e, quando houver variacao, `variation_id`.
  item_id text check (item_id is null or item_id ~ '^MLB[0-9]+$'),

  -- NULL quando o anuncio nao tem variacao. O UpSeller repete o id do anuncio
  -- nesses casos; a importacao normaliza para NULL, porque "anuncio inteiro" e
  -- semanticamente diferente de "variacao X".
  variation_id text check (variation_id is null or variation_id ~ '^[0-9]+$'),

  -- USER_PRODUCT: preenchido `user_product_id`.
  user_product_id text check (user_product_id is null or user_product_id ~ '^MLBU[0-9]+$'),

  sku_id uuid not null references public.skus(id) on delete restrict,

  -- SKU declarado no proprio anuncio. Medido: difere do SKU interno em 463 dos
  -- 20.650 vinculos. Guardado porque e a pista mais forte para sugerir vinculo
  -- automatico na Central de Vinculacoes.
  channel_sku text,

  -- Procedencia do vinculo. `IMPORT_UPSELLER` e o que entra na carga inicial;
  -- `MANUAL` e confirmacao humana; `RULE` e sugestao aceita por regra.
  source text not null default 'MANUAL'
    check (source in ('MANUAL', 'IMPORT_UPSELLER', 'IMPORT_V2', 'RULE')),

  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Coerencia entre o tipo e as colunas preenchidas. Sem isto, uma importacao
  -- torta criaria linha com os dois identificadores, ou com nenhum.
  constraint sku_listing_links_ref_shape check (
    (ref_kind = 'ITEM' and item_id is not null and user_product_id is null)
    or
    (ref_kind = 'USER_PRODUCT' and user_product_id is not null
       and item_id is null and variation_id is null)
  )
);

comment on table public.sku_listing_links is
  'Vinculo entre SKU canonico e anuncio/user product do Mercado Livre (D-004).';

comment on column public.sku_listing_links.variation_id is
  'NULL quando o anuncio nao tem variacao. Nunca repete o item_id.';

comment on column public.sku_listing_links.ref_kind is
  'ITEM = anuncio MLB. USER_PRODUCT = MLBU, produto do catalogo do vendedor.';

-- ============================================================
-- 2. Unicidade
--
-- ARMADILHA que estes tres indices resolvem: em Postgres, `NULL` nao colide
-- com `NULL` num UNIQUE. Uma constraint unica em
-- (conta, item, variacao) permitiria inserir o MESMO anuncio sem variacao
-- quantas vezes se quisesse — e essa e exatamente a forma de 3.579 dos
-- vinculos reais.
--
-- A solucao sao indices parciais: um para cada forma.
--
-- Verificado nos dados: 0 combinacoes ambiguas em 20.650 vinculos. A restricao
-- e compativel com a realidade, nao uma esperanca.
-- ============================================================

create unique index sku_listing_links_item_variation_unique
  on public.sku_listing_links (ml_account_id, item_id, variation_id)
  where ref_kind = 'ITEM' and variation_id is not null;

create unique index sku_listing_links_item_only_unique
  on public.sku_listing_links (ml_account_id, item_id)
  where ref_kind = 'ITEM' and variation_id is null;

create unique index sku_listing_links_user_product_unique
  on public.sku_listing_links (ml_account_id, user_product_id)
  where ref_kind = 'USER_PRODUCT';

-- Consulta quente na direcao oposta: "em quais anuncios este SKU esta?".
-- Medido: 3.328 dos 3.553 SKUs estao anunciados em mais de uma loja.
create index sku_listing_links_sku_idx
  on public.sku_listing_links (sku_id);

create index sku_listing_links_account_idx
  on public.sku_listing_links (ml_account_id);

-- Busca por SKU declarado no anuncio, usada para sugerir vinculo.
create index sku_listing_links_channel_sku_idx
  on public.sku_listing_links (organization_id, channel_sku)
  where channel_sku is not null;

create trigger sku_listing_links_set_updated_at
  before update on public.sku_listing_links
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. Coerencia de organizacao
--
-- `sku_id` e `ml_account_id` precisam pertencer a MESMA organizacao da linha.
-- Sem esta checagem, um vinculo poderia cruzar organizacoes e furar o
-- isolamento que a RLS constroi em todas as outras tabelas.
-- ============================================================

create or replace function private.sku_listing_links_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sku_org uuid;
  account_org uuid;
begin
  select organization_id into sku_org from public.skus where id = new.sku_id;
  select organization_id into account_org from public.ml_accounts where id = new.ml_account_id;

  if sku_org is distinct from new.organization_id then
    raise exception 'sku_listing_links: SKU pertence a outra organizacao';
  end if;

  if account_org is distinct from new.organization_id then
    raise exception 'sku_listing_links: conta pertence a outra organizacao';
  end if;

  return new;
end;
$$;

create trigger sku_listing_links_validate_org
  before insert or update on public.sku_listing_links
  for each row execute function private.sku_listing_links_validate();

-- ============================================================
-- 4. RLS
--
-- Leitura segue a permissao DA CONTA, nao apenas a organizacao: quem nao
-- alcanca a conta nao deve ver os anuncios dela.
--
-- Escrita e permitida a usuario autenticado porque a Central de Vinculacoes e
-- confirmacao humana — o operador vincula SKU a anuncio pela interface. A
-- importacao em massa continua sendo do worker.
-- ============================================================

alter table public.sku_listing_links enable row level security;

create policy sku_listing_links_select_permitted
  on public.sku_listing_links for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy sku_listing_links_write_permitted
  on public.sku_listing_links for all to authenticated
  using (
    private.has_account_access(ml_account_id)
    and private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR'])
  )
  with check (
    private.has_account_access(ml_account_id)
    and private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR'])
  );

-- ============================================================
-- 5. GRANTs
-- ============================================================

grant select, insert, update, delete on public.sku_listing_links to authenticated;

grant select, insert, update, delete on public.sku_listing_links to service_role;

revoke all on public.sku_listing_links from anon;
