-- ============================================================
-- Ledger de estoque local — primeiro item do checklist da Fase 4
-- (docs/ROADMAP.md, D-006, D-019).
--
-- `stock_movements` e o UNICO escritor da verdade do estoque LOCAL
-- (docs/ARCHITECTURE.md secao 14). Full (D-018), reservado e em transito sao
-- tres dos quatro estados descritos no PROMPT_MASTER; Full fica de fora desta
-- tabela de proposito — e espelho de snapshot do Mercado Livre
-- (fulfillment_stock_snapshots, item posterior do checklist), nunca ledger,
-- porque a V3 nao observa todos os movimentos internos do CD do ML.
--
-- Esta migration e SOMENTE schema + a projecao mantida por trigger. Nenhum
-- codigo de aplicacao escreve stock_movements ainda — dedução por venda,
-- reversao por cancelamento/devolucao e NF-e sao os proximos itens do
-- checklist, cada um sua propria etapa. Mesmo padrao incremental ja usado em
-- sync_runs (Fase 2, so-schema) e depois orders/domain_events (Fase 3).
-- ============================================================

-- ============================================================
-- 1. stock_movements — L2, append-only
-- ============================================================

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),

  -- `restrict`, nao `cascade`: tabela append-only. Um `cascade` disparado
  -- pela exclusao da organizacao bateria na mesma trigger que bloqueia
  -- DELETE direto e falharia no meio — a armadilha ja documentada para
  -- sync_runs/sync_errors (docs/HANDOFF.md). Organizacao nao e apagada na
  -- pratica; e a mesma garantia que sync_runs/orders ja adotam.
  organization_id uuid not null references public.organizations(id) on delete restrict,

  -- Idem: um SKU com historico de movimento nao pode desaparecer em
  -- silencio. `sku_components` ja usa `restrict` no componente pelo mesmo
  -- motivo (docs/DATABASE.md secao 4).
  sku_id uuid not null references public.skus(id) on delete restrict,

  -- Full (D-018) fica FORA desta lista de proposito — e snapshot, nao
  -- ledger. Os tres estados aqui sao os que a V3 observa integralmente.
  location_kind text not null check (location_kind in ('LOCAL', 'RESERVADO', 'TRANSITO')),

  -- Positivo = entrada, negativo = saida. Zero nao e um movimento — seria
  -- um evento sem efeito, sinal de bug na chamada, nunca uma linha legitima.
  qty_delta numeric(14, 3) not null check (qty_delta <> 0),

  -- Vocabulario fechado e ja aprovado (docs/ARCHITECTURE.md secao 12,
  -- docs/DATABASE.md secao 4) — diferente de `domain_events.event_type`,
  -- que evolui em packages/domain: aqui a lista e estavel, entao o CHECK
  -- e quem a protege, mesmo padrao de `orders.status`.
  movement_type text not null check (movement_type in (
    'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML', 'DEVOLUCAO_ML',
    'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
    'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO'
  )),

  -- Referencia polimorfica ao registro que originou o movimento (pedido,
  -- documento fiscal, etc.) — texto, nao FK, mesmo padrao de
  -- `domain_events.entity_type`/`entity_id`: a origem muda de tabela
  -- conforme o tipo, e uma FK unica nao serviria a nenhuma delas direito.
  -- Nulo para AJUSTE_MANUAL, que nao tem outro registro por tras.
  source_type text check (source_type is null or char_length(source_type) between 1 and 40),
  source_id text check (source_id is null or char_length(source_id) between 1 and 100),

  -- A garantia inteira do ledger (docs/DATABASE.md secao 3): a mesma venda,
  -- webhook ou NF-e nao conseguem movimentar estoque duas vezes, por mais
  -- que a fila reentregue o job. Formato e responsabilidade de quem grava
  -- (ex.: `venda:{order_id}:{sku_id}`), definido na etapa que escrever cada
  -- tipo de movimento.
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),

  -- Quando o movimento aconteceu de verdade (ex.: data do pedido), nao
  -- quando foi gravado — mesmo raciocinio de `domain_events.occurred_at`.
  occurred_at timestamptz not null,

  -- Nulo quando a origem e sistema (venda, reconciliacao); preenchido para
  -- AJUSTE_MANUAL. `restrict`, nao `set null`: a mesma armadilha do
  -- `cascade` em tabela append-only (docs/HANDOFF.md) se repete aqui — um
  -- `ON DELETE SET NULL` tambem e um UPDATE disparado pela FK, e a trigger
  -- de baixo bloqueia UPDATE em stock_movements de qualquer origem,
  -- inclusive de uma acao em cascata. Apagar um perfil com ajuste manual no
  -- historico falha explicitamente, em vez de a cascata quebrar no meio.
  created_by uuid references public.profiles(id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint stock_movements_manual_has_creator check (
    movement_type <> 'AJUSTE_MANUAL' or created_by is not null
  )
);

comment on table public.stock_movements is
  'Ledger L2 append-only do estoque LOCAL (D-006/D-019). Full/reservado/transito: ver location_kind. Full fica fora — e snapshot (D-018).';

comment on column public.stock_movements.qty_delta is
  'Positivo = entrada, negativo = saida. Nunca zero — constraint recusa movimento sem efeito.';

comment on column public.stock_movements.idempotency_key is
  'UNIQUE fisico: a mesma venda/webhook/NF-e nao pode movimentar estoque duas vezes (docs/DATABASE.md secao 3).';

-- Consulta quente: extrato de um SKU, mais recente primeiro.
create index stock_movements_sku_timeline_idx
  on public.stock_movements (organization_id, sku_id, occurred_at desc);

-- "O que aconteceu com ESTE pedido/documento" — mesma forma do indice de
-- entidade de domain_events.
create index stock_movements_source_idx
  on public.stock_movements (organization_id, source_type, source_id)
  where source_type is not null;

-- ============================================================
-- Append-only imposto pelo banco — mesmo mecanismo de domain_events/
-- sync_runs/job_runs.
-- ============================================================

create or replace function public.stock_movements_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'stock_movements e append-only: % nao e permitido. Corrija inserindo uma nova linha (ex.: AJUSTE_MANUAL).',
    tg_op;
end;
$$;

create trigger stock_movements_no_update
  before update on public.stock_movements
  for each row execute function public.stock_movements_reject_mutation();

create trigger stock_movements_no_delete
  before delete on public.stock_movements
  for each row execute function public.stock_movements_reject_mutation();

-- ============================================================
-- 2. inventory_balances — projecao L3, recomputavel por completo
--
-- Mantida por trigger a cada INSERT em stock_movements: correta por
-- construcao, na MESMA transacao do movimento — nunca ha janela em que o
-- ledger tem uma linha e a projecao ainda nao reflete. `compute_..._from_ledger`
-- abaixo e a mesma soma partindo do zero, usada pelo "job de conferencia"
-- (docs/ROADMAP.md) para provar que a projecao nao divergiu.
-- ============================================================

create table public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sku_id uuid not null references public.skus(id) on delete restrict,
  location_kind text not null check (location_kind in ('LOCAL', 'RESERVADO', 'TRANSITO')),

  quantity numeric(14, 3) not null default 0,

  updated_at timestamptz not null default now(),

  constraint inventory_balances_grain_unique unique (sku_id, location_kind)
);

comment on table public.inventory_balances is
  'Projecao L3 recomputavel do ledger (stock_movements). Nunca e fonte unica — ver private.compute_inventory_balances_from_ledger.';

create index inventory_balances_org_idx
  on public.inventory_balances (organization_id);

create or replace function private.apply_stock_movement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.inventory_balances (organization_id, sku_id, location_kind, quantity, updated_at)
  values (new.organization_id, new.sku_id, new.location_kind, new.qty_delta, now())
  on conflict (sku_id, location_kind)
  do update set
    quantity = public.inventory_balances.quantity + excluded.quantity,
    updated_at = now();

  return new;
end;
$$;

comment on function private.apply_stock_movement is
  'Mantem inventory_balances na mesma transacao de cada stock_movements. Correcao por construcao, nao por job assincrono.';

create trigger stock_movements_apply_to_balance
  after insert on public.stock_movements
  for each row execute function private.apply_stock_movement();

-- ============================================================
-- 3. Recomputo do zero — a base do job de conferencia
--
-- Soma stock_movements diretamente, sem depender da projecao. Compara-la
-- contra inventory_balances e o "job de conferencia" que
-- docs/ROADMAP.md pede; construido aqui como consulta, sem ainda existir job
-- agendado — nao ha nada real para conferir enquanto nenhum codigo grava
-- stock_movements. Fica pronta para a proxima etapa a usar.
-- ============================================================

create function private.compute_inventory_balances_from_ledger(
  p_organization_id uuid,
  p_sku_id uuid default null
)
returns table (
  sku_id uuid,
  location_kind text,
  quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.sku_id,
    m.location_kind,
    sum(m.qty_delta) as quantity
  from public.stock_movements m
  where m.organization_id = p_organization_id
    and (p_sku_id is null or m.sku_id = p_sku_id)
  group by m.sku_id, m.location_kind;
$$;

comment on function private.compute_inventory_balances_from_ledger is
  'Soma stock_movements do zero — o mesmo numero que inventory_balances deveria ter. Divergencia entre os dois e bug, nunca esperado.';

revoke all on function private.compute_inventory_balances_from_ledger(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.compute_inventory_balances_from_ledger(uuid, uuid)
  to service_role;

-- ============================================================
-- 4. RLS
--
-- Estoque local nao e por conta do Mercado Livre — e por organizacao, como
-- o catalogo (`skus`). `is_member_of`, nao `has_account_access`.
-- ============================================================

alter table public.stock_movements enable row level security;
alter table public.inventory_balances enable row level security;

create policy stock_movements_select_own_org
  on public.stock_movements for select to authenticated
  using (private.is_member_of(organization_id));

create policy inventory_balances_select_own_org
  on public.inventory_balances for select to authenticated
  using (private.is_member_of(organization_id));

-- ============================================================
-- 5. GRANTs
--
-- `stock_movements` e append-only: privilegio acompanha o contrato, sem
-- update/delete nem para service_role (docs/DATABASE.md secao 5) — a
-- trigger ja recusaria, mas o GRANT e a primeira barreira, nao a segunda.
-- `inventory_balances` e projecao mutavel, escrita so pela trigger (que
-- roda como quem inseriu em stock_movements, ou seja, service_role).
-- ============================================================

grant select on public.stock_movements, public.inventory_balances to authenticated;

grant select, insert on public.stock_movements to service_role;
grant select, insert, update on public.inventory_balances to service_role;

revoke all on public.stock_movements from anon;
revoke all on public.inventory_balances from anon;
