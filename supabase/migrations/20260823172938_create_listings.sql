-- ============================================================
-- Sincronização de listings/anúncios (Fase 5B, docs/ROADMAP.md) —
-- pré-requisito não nomeado explicitamente até 2026-08-22, achado em
-- revisão: "Dashboards de SKU e de Anúncio" depende disso existir primeiro.
--
-- Escopo DELIBERADAMENTE menor que o desenho conceitual original
-- (`listings`/`listing_variations`/`listing_price_states`, três tabelas) —
-- achado ao inspecionar o banco real da V2 antes de desenhar (mesmo
-- princípio de evidência medida de D-037/D-039/D-040/D-048/D-053):
-- `ml_listings`/`ml_listing_variations` (o espelho completo — título,
-- categoria, health, permalink, thumbnail, raw_payload) EXISTIAM na V2 mas
-- tinham ZERO linhas — nunca chegaram a ser usadas de verdade. A tabela
-- mais estreita e focada em preço (`ml_offer_price_states`, 40+ colunas de
-- mecânica de promoção) teve uso real (5.143 linhas, "price divergence
-- diagnostics"), mas seu escopo (promoções, winning offer) é mais Fase 6/7
-- (diagnóstico) que Fase 5B (dashboards).
--
-- UMA tabela só, grão (ml_account_id, item_id) — mesma granularidade já
-- usada por `sku_listing_links`/`fulfillment_stock_snapshots` para o mesmo
-- conceito (item + variação opcional), evitando o split em duas tabelas que
-- a V2 tinha e nunca populou. Projeção MUTÁVEL (upsert), não ledger — não
-- há evidência ainda de que histórico de mudança de listing seja
-- necessário (isso é diagnóstico, Fase 6, quando `domain_events` datados
-- fizer sentido para isso).
--
-- Escopo desta etapa, mesmo raciocínio já usado em `ml-fulfillment-fetch.ts`
-- (Full por conta): só itens SEM variação (`sku_listing_links.variation_id
-- IS NULL`) — a doc oficial não mostra o formato exato de variação dentro
-- da resposta de `/items` para o campo a campo ser confiável sem adivinhar.
-- ============================================================

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,

  item_id text not null check (item_id ~ '^MLB[0-9]+$'),

  -- Resolvido no momento do sync (mesmo padrão de D-020) — reflete o
  -- vínculo vigente na ÚLTIMA sincronização, não um histórico; um vínculo
  -- trocado depois só aparece na próxima rodada. `set null`, não
  -- `restrict`: esta linha é projeção mutável, não ledger — perder o
  -- vínculo não apaga história nenhuma, só zera até o próximo sync.
  sku_id uuid references public.skus(id) on delete set null,

  title text not null,
  status text not null,
  price numeric(14, 2) not null check (price >= 0),
  currency_id text not null,
  available_quantity integer not null check (available_quantity >= 0),
  category_id text,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint listings_account_item_unique unique (ml_account_id, item_id)
);

comment on table public.listings is
  'Estado atual do anúncio no Mercado Livre — projeção mutável (upsert por sync), não ledger. Escopo: itens sem variação (D-058).';

create index listings_org_idx on public.listings (organization_id);
create index listings_sku_idx on public.listings (sku_id) where sku_id is not null;

create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function private.set_updated_at();

-- ============================================================
-- RLS — por CONTA (has_account_access), mesmo padrão de
-- fulfillment_stock_snapshots/domain_events: listing pertence a uma conta
-- Mercado Livre específica, diferente de stock_movements (organizacional).
-- ============================================================

alter table public.listings enable row level security;

create policy listings_select_own_account
  on public.listings for select to authenticated
  using (private.has_account_access(ml_account_id));

grant select on public.listings to authenticated;
grant select, insert, update on public.listings to service_role;
revoke all on public.listings from anon;
