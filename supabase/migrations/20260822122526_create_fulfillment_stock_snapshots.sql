-- ============================================================
-- fulfillment_stock_snapshots — Full por conta, espelho do Mercado Livre
-- (Fase 4, docs/ROADMAP.md; D-018).
--
-- Full NAO e ledger nosso — e espelho de snapshot do Mercado Livre
-- (docs/ARCHITECTURE.md secao 12/14, docs/DATABASE.md secao "fulfillment_stock_snapshots").
-- A autoridade e o ML; a V3 nao observa os movimentos internos do CD do ML,
-- entao um ledger proprio para Full seria inventar precisao que a fonte nao
-- oferece. Eventos de Full (entrou, saiu, rompeu, repos) saem do DIFF entre
-- duas capturas consecutivas, nao de um movimento gravado no ato.
--
-- Esta migration e SOMENTE schema, mesmo padrao incremental ja usado em
-- sync_runs (Fase 2) e stock_movements (Fase 4, ledger): a busca na API do
-- Mercado Livre, o job de captura e o detector de diff sao a proxima etapa.
--
-- Fonte do inventory_id: GET /items/{item_id} (docs/MERCADO_LIVRE.md secao 2.7)
-- — cada variacao tem o proprio inventory_id. sku_listing_links (ref_kind='ITEM')
-- e quem enumera quais item_id/variation_id existem por conta; nao depende de
-- uma tabela `listings` ainda inexistente (essa continua fora do escopo da
-- Fase 4, ver docs/ROADMAP.md Fase 3).
-- ============================================================

create table public.fulfillment_stock_snapshots (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,

  -- `restrict`, nao `cascade`: mesmo motivo de domain_events/sync_runs —
  -- historico nao pode desaparecer atras de uma exclusao de conta.
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- Identificador nativo do Mercado Livre para o "bucket" de estoque Full de
  -- um item ou de uma variacao especifica (docs/MERCADO_LIVRE.md secao 2.7).
  inventory_id text not null check (char_length(inventory_id) between 1 and 60),

  item_id text not null check (item_id ~ '^MLB[0-9]+$'),
  variation_id text check (variation_id is null or variation_id ~ '^[0-9]+$'),

  -- Congelado na captura (mesmo raciocinio de order_items.sku_id, D-020): o
  -- vinculo pode mudar depois, e a captura historica deve continuar
  -- refletindo o que era verdade no momento em que foi tirada.
  sku_id uuid not null references public.skus(id) on delete restrict,

  quantity numeric(14, 3) not null,

  -- Quando o Mercado Livre reportou o saldo (resposta da API), nao quando o
  -- V3 processou o job — mesmo raciocinio de domain_events.occurred_at.
  captured_at timestamptz not null,

  created_at timestamptz not null default now(),

  -- Uma captura por inventory_id por instante — evita duplicar linha se o
  -- job de captura reprocessar (Cloud Tasks entrega ao menos uma vez).
  constraint fulfillment_stock_snapshots_unique unique (ml_account_id, inventory_id, captured_at)
);

comment on table public.fulfillment_stock_snapshots is
  'Espelho de snapshot do estoque Full por conta (D-018) — nao e ledger. Eventos saem do diff entre capturas consecutivas.';

comment on column public.fulfillment_stock_snapshots.sku_id is
  'Congelado na captura (D-020) — o vinculo pode ter mudado desde entao.';

comment on column public.fulfillment_stock_snapshots.captured_at is
  'Quando o Mercado Livre reportou o saldo, nao quando o V3 processou o job.';

-- "Qual a captura mais recente deste inventory_id?" e "quais as duas
-- ultimas, para diff?" — a consulta do detector de eventos. A UNIQUE acima
-- ja cobre esse prefixo de colunas.
create index fulfillment_stock_snapshots_timeline_idx
  on public.fulfillment_stock_snapshots (ml_account_id, inventory_id, captured_at desc);

-- "Historico deste SKU no Full, direto" — sem passar por inventory_id.
create index fulfillment_stock_snapshots_sku_idx
  on public.fulfillment_stock_snapshots (organization_id, sku_id, captured_at desc);

-- ============================================================
-- RLS — observabilidade PARA O USUARIO, mesmo padrao de domain_events/
-- sync_runs: quem alcanca a conta ve as capturas dela. Escrita continua so
-- por service_role: nenhum humano registra captura na mao.
-- ============================================================

alter table public.fulfillment_stock_snapshots enable row level security;

create policy fulfillment_stock_snapshots_select_permitted
  on public.fulfillment_stock_snapshots for select to authenticated
  using (private.has_account_access(ml_account_id));

grant select on public.fulfillment_stock_snapshots to authenticated;

grant select, insert on public.fulfillment_stock_snapshots to service_role;

revoke all on public.fulfillment_stock_snapshots from anon;
