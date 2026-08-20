-- ============================================================
-- Importação do UpSeller: lote, linhas conferidas e snapshot de estoque.
--
-- Fluxo completo (escolhido em 2026-08-20):
--
--   upload -> parse -> CONFERENCIA -> confirmacao humana -> aplicacao
--
-- A conferencia existe pelo mesmo motivo que existe na NF-e
-- (`docs/PROMPT_MASTER.md` secao 13): um arquivo do ERP pode trazer linha que
-- nao casa com nada, e aplicar as cegas cria SKU fantasma ou vinculo errado
-- que ninguem descobre ate a venda sair errada.
-- ============================================================

-- ============================================================
-- 1. erp_import_batches
--
-- Um lote por ARQUIVO. O `content_hash` UNIQUE impede reaplicar o mesmo
-- arquivo — mesma garantia que `documents.content_hash` dara para a NF-e.
-- ============================================================

create table public.erp_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Qual dos quatro arquivos da exportacao.
  kind text not null check (kind in ('PRODUCTS', 'KITS', 'LINKS', 'STOCK')),

  status text not null default 'UPLOADED'
    check (status in ('UPLOADED', 'PARSING', 'PARSED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED')),

  -- Caminho no bucket `erp-imports`. O arquivo NUNCA vira coluna do Postgres —
  -- mesma regra do payload bruto do Mercado Livre (D-015).
  storage_path text not null,
  file_name text,

  -- SHA-256 do conteudo. E a chave de idempotencia do fluxo inteiro.
  content_hash text not null check (char_length(content_hash) = 64),

  total_rows integer check (total_rows is null or total_rows >= 0),
  ok_rows integer check (ok_rows is null or ok_rows >= 0),
  skipped_rows integer check (skipped_rows is null or skipped_rows >= 0),
  invalid_rows integer check (invalid_rows is null or invalid_rows >= 0),

  uploaded_by uuid references public.profiles(id) on delete set null,
  applied_by uuid references public.profiles(id) on delete set null,

  parsed_at timestamptz,
  applied_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- O MESMO arquivo nao entra duas vezes. Sem isto, reenviar a planilha
  -- duplicaria vinculo e sobrescreveria catalogo sem ninguem notar.
  constraint erp_import_batches_hash_unique unique (organization_id, content_hash),

  -- Aplicado exige quem aplicou e quando: aplicacao sem responsavel nao e
  -- auditavel, e esta e a etapa que altera o catalogo inteiro.
  constraint erp_import_batches_applied_coherent check (
    (status = 'APPLIED' and applied_at is not null and applied_by is not null)
    or status <> 'APPLIED'
  )
);

comment on table public.erp_import_batches is
  'Um lote por arquivo do UpSeller. content_hash impede reaplicar o mesmo arquivo.';

create index erp_import_batches_org_status_idx
  on public.erp_import_batches (organization_id, status, created_at desc);

create trigger erp_import_batches_set_updated_at
  before update on public.erp_import_batches
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. erp_import_rows
--
-- Uma linha por linha do arquivo, com o registro JA NORMALIZADO pelos parsers
-- de `@sb/domain`. E o que a tela de conferencia lê.
--
-- `SKIPPED` e `INVALID` sao coisas diferentes e a distincao importa na tela:
-- descartado por decisao (D-037, canal fora do Mercado Livre) e esperado e nao
-- pede acao; invalido precisa de atencao humana.
-- ============================================================

create table public.erp_import_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.erp_import_batches(id) on delete cascade,

  row_number integer not null check (row_number > 0),

  status text not null check (status in ('OK', 'SKIPPED', 'INVALID')),
  reason text,

  -- Chave natural do registro, extraida para permitir busca e conferencia sem
  -- abrir o jsonb.
  sku_key text,

  -- Registro normalizado. Formato depende de `kind` do lote.
  payload jsonb not null,

  created_at timestamptz not null default now(),

  constraint erp_import_rows_reason_matches_status check (
    (status = 'OK' and reason is null) or status <> 'OK'
  ),

  constraint erp_import_rows_unique_per_batch unique (batch_id, row_number)
);

comment on table public.erp_import_rows is
  'Linha normalizada do arquivo. SKIPPED e decisao (D-037); INVALID pede atencao.';

-- A tela de conferencia filtra por status dentro do lote — este e o padrao real
-- de consulta, e o unico indice que se justifica hoje.
create index erp_import_rows_batch_status_idx
  on public.erp_import_rows (batch_id, status);

create index erp_import_rows_sku_idx
  on public.erp_import_rows (batch_id, sku_key)
  where sku_key is not null;

-- ============================================================
-- 3. erp_stock_snapshots
--
-- Fonte de ALINHAMENTO da D-029, nunca escrita direta em inventory_balances.
--
-- O ledger da V3 e autossuficiente; o UpSeller entra por snapshot, e a
-- divergencia entre os dois gera `AJUSTE_RECONCILIACAO` auditavel. Isso e o
-- que preserva o caminho para a V3 assumir como ERP sem reescrita (D-028).
--
-- Append-only: cada importacao registra uma fotografia nova. Comparar
-- fotografias no tempo e o que mostra se a divergencia esta crescendo.
-- ============================================================

create table public.erp_stock_snapshots (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.erp_import_batches(id) on delete cascade,

  -- `sku_key` sempre presente; `sku_id` so quando o SKU ja existe na V3. Um
  -- saldo de SKU desconhecido continua sendo informacao — some-lo silenciosamente
  -- esconderia justamente o caso que a conferencia precisa mostrar.
  sku_key text not null,
  sku_id uuid references public.skus(id) on delete set null,

  warehouse text not null,

  on_hand numeric(14, 3) not null,
  available numeric(14, 3) not null,
  reserved numeric(14, 3) not null default 0,
  in_transit numeric(14, 3) not null default 0,
  average_cost numeric(12, 2),

  captured_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint erp_stock_snapshots_unique_per_batch unique (batch_id, sku_key, warehouse)
);

comment on table public.erp_stock_snapshots is
  'Fotografia do estoque no ERP. Fonte de alinhamento da D-029, nao de escrita.';

comment on column public.erp_stock_snapshots.sku_id is
  'Nulo quando o SKU ainda nao existe na V3 — o saldo continua registrado.';

-- "Qual o ultimo saldo deste SKU no ERP?" — a consulta da reconciliacao.
create index erp_stock_snapshots_latest_idx
  on public.erp_stock_snapshots (organization_id, sku_key, captured_at desc);

-- ============================================================
-- 4. RLS
--
-- Importacao e ato administrativo: quem enxerga sao ADMIN e GESTOR.
--
-- ESCRITA nao passa pela Data API. O upload cria o lote pela `api`, o parse e
-- do worker, e a aplicacao roda com service_role. A confirmacao humana e um
-- comando na `api`, nao um UPDATE direto do navegador — assim a transicao de
-- status fica num lugar so, com validacao.
-- ============================================================

alter table public.erp_import_batches enable row level security;
alter table public.erp_import_rows enable row level security;
alter table public.erp_stock_snapshots enable row level security;

create policy erp_import_batches_select_admin
  on public.erp_import_batches for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy erp_import_rows_select_admin
  on public.erp_import_rows for select to authenticated
  using (
    exists (
      select 1
      from public.erp_import_batches b
      where b.id = erp_import_rows.batch_id
        and private.is_member_of(b.organization_id)
        and private.has_role(array['ADMIN', 'GESTOR'])
    )
  );

create policy erp_stock_snapshots_select_admin
  on public.erp_stock_snapshots for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

-- ============================================================
-- 5. GRANTs
-- ============================================================

grant select on public.erp_import_batches, public.erp_import_rows,
                public.erp_stock_snapshots to authenticated;

grant select, insert, update, delete
  on public.erp_import_batches, public.erp_import_rows, public.erp_stock_snapshots
  to service_role;

revoke all on public.erp_import_batches from anon;
revoke all on public.erp_import_rows from anon;
revoke all on public.erp_stock_snapshots from anon;
