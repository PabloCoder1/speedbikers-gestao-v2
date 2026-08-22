-- ============================================================
-- NF-e/XML: documento e itens (Fase 4, docs/ROADMAP.md; docs/NFE.md).
--
-- Mesmo fluxo do importador do UpSeller (docs/PROMPT_MASTER.md secao 13,
-- migration 20260820200000_create_erp_import.sql):
--
--   upload -> parse -> CONFERENCIA -> confirmacao humana -> aplicacao
--
-- Esta migration cobre so upload+parse (documents/document_items). A tela
-- de conferencia, o vinculo de item por SKU e a geracao de stock_movements
-- (so na confirmacao humana, nunca no parse) sao as proximas etapas, mesmo
-- padrao incremental ja usado no ledger e no Full.
-- ============================================================

-- ============================================================
-- 1. documents
--
-- Um documento por ARQUIVO XML. content_hash UNIQUE impede reaplicar o
-- mesmo arquivo -- mesma garantia que erp_import_batches ja tem.
-- ============================================================

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  status text not null default 'UPLOADED'
    check (status in ('UPLOADED', 'PARSING', 'PARSED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED')),

  -- Caminho no bucket privado. O arquivo NUNCA vira coluna do Postgres --
  -- mesma regra do payload bruto do Mercado Livre (D-015) e do UpSeller.
  storage_path text not null,
  file_name text,

  -- SHA-256 do conteudo -- a chave de idempotencia do fluxo inteiro.
  content_hash text not null check (char_length(content_hash) = 64),

  -- Campos extraidos no PARSE (docs/NFE.md secao 2). Nulos ate a etapa de
  -- parse rodar; NF-e/XML e o unico tipo de documento hoje, mas a coluna
  -- fica pronta para quando PDF/DANFE entrar como fallback (D-034,
  -- docs/PROMPT_MASTER.md secao 13 -- so depois do XML estar solido).
  document_type text not null default 'NFE' check (document_type in ('NFE')),

  -- 44 digitos, sem prefixo. UNIQUE por organizacao: a mesma nota fiscal
  -- (mesma chave) nao deveria ter dois documentos aplicados -- mas o
  -- content_hash ja e quem impede reenvio do MESMO ARQUIVO; esta constraint
  -- cobre o caso de dois arquivos DIFERENTES (ex.: reexportado) carregando
  -- a mesma nota.
  access_key text check (access_key is null or access_key ~ '^\d{44}$'),

  operation_type text check (operation_type is null or operation_type in ('ENTRADA', 'SAIDA')),
  document_number text,
  series text,
  issue_date timestamptz,
  issuer_cnpj text,
  issuer_name text,

  total_items integer check (total_items is null or total_items >= 0),
  resolved_items integer check (resolved_items is null or resolved_items >= 0),

  uploaded_by uuid references public.profiles(id) on delete set null,
  applied_by uuid references public.profiles(id) on delete set null,

  parsed_at timestamptz,
  applied_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint documents_hash_unique unique (organization_id, content_hash),

  constraint documents_access_key_unique unique (organization_id, access_key),

  -- Aplicado exige quem aplicou e quando -- mesma garantia de
  -- erp_import_batches, mesmo motivo (auditoria de quem alterou o ledger).
  constraint documents_applied_coherent check (
    (status = 'APPLIED' and applied_at is not null and applied_by is not null)
    or status <> 'APPLIED'
  )
);

comment on table public.documents is
  'Um documento (NF-e/XML) por arquivo. content_hash impede reaplicar o mesmo arquivo (docs/NFE.md).';

comment on column public.documents.access_key is
  'Chave de acesso da NF-e, 44 digitos, sem prefixo "NFe". Nula ate o parse rodar.';

create index documents_org_status_idx
  on public.documents (organization_id, status, created_at desc);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. document_items
--
-- Um item por linha <det> do XML. sku_id nulo ate o vinculo humano na tela
-- de conferencia -- mesmo padrao de erp_stock_snapshots.sku_id: um item
-- sem vinculo continua sendo informacao, nao deve ser descartado em
-- silencio.
--
-- Vinculo e por DOCUMENTO, nao um cadastro reutilizavel entre notas do
-- mesmo fornecedor (docs/NFE.md secao 3: "vinculo humano via tela de
-- conferencia e o caminho sem dependencia nova"). Repetir o vinculo em
-- notas futuras do mesmo fornecedor e uma limitacao conhecida, nao um
-- descuido -- registrar vinculo fornecedor->SKU reutilizavel fica para
-- quando o volume real mostrar que vale a pena.
-- ============================================================

create table public.document_items (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,

  position integer not null check (position >= 0),

  -- Codigo do produto NO FORNECEDOR -- texto livre, sem padrao entre
  -- emissores (docs/NFE.md secao 3). Nao e o mesmo conceito de channel_sku
  -- (Mercado Livre); guardado a parte por clareza de origem.
  supplier_code text not null,
  ean text,
  description text not null,
  ncm text,
  cfop text,
  unit text not null,

  quantity numeric(14, 3) not null check (quantity > 0),
  unit_value numeric(14, 4) not null check (unit_value >= 0),
  total_value numeric(14, 2) not null check (total_value >= 0),

  sku_id uuid references public.skus(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint document_items_unique_per_document unique (document_id, position)
);

comment on table public.document_items is
  'Item de um documento (linha <det> do XML da NF-e). sku_id nulo ate vinculo humano.';

comment on column public.document_items.sku_id is
  'Nulo ate a confirmacao humana na tela de conferencia -- item sem vinculo continua registrado.';

create index document_items_document_idx
  on public.document_items (document_id, position);

-- ============================================================
-- 3. RLS
--
-- Mesmo padrao de erp_import_batches/rows: importacao e ato administrativo,
-- ADMIN e GESTOR enxergam. Escrita nao passa pela Data API -- upload pela
-- api, parse pelo worker, aplicacao com service_role.
-- ============================================================

alter table public.documents enable row level security;
alter table public.document_items enable row level security;

create policy documents_select_admin
  on public.documents for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy document_items_select_admin
  on public.document_items for select to authenticated
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_items.document_id
        and private.is_member_of(d.organization_id)
        and private.has_role(array['ADMIN', 'GESTOR'])
    )
  );

-- ============================================================
-- 4. GRANTs
-- ============================================================

grant select on public.documents, public.document_items to authenticated;

grant select, insert, update, delete on public.documents, public.document_items to service_role;

revoke all on public.documents from anon;
revoke all on public.document_items from anon;
