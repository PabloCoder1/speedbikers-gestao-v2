-- Historico de custo cadastrado (D-149, Fase 5D): "hoje skus.purchase_cost e
-- sobrescrito a cada importacao" (ROADMAP) -- o UPDATE do erp-import-apply
-- grava o registro INTEIRO e o valor anterior morre sem rastro. A partir
-- desta migration, toda mudanca de custo deixa linha aqui, gravada por
-- TRIGGER na propria skus: nenhum caminho de escrita (import, reparo direto,
-- RPC futura) consegue mudar o custo sem historiar.
--
-- SEM BACKFILL, de proposito: nao existe historia anterior para semear --
-- uma linha "baseline" afirmaria um instante de vigencia que ninguem mediu,
-- e semear ~3.4k linhas seria escrita em massa sem necessidade (precedente
-- D-065/D-081). O registro comeca agora; a tela diz isso com todas as
-- letras.
--
-- FK do SKU em CASCADE, nao restrict: um SKU deletavel e um SKU que nunca
-- operou (qualquer movimento/venda ja o torna indeletavel pelas outras FKs
-- restrict) -- custo de quem nunca operou nao e historia perdida. Isso
-- tambem evita engrossar a cebola de teardown que D-142 documentou.
--
-- `changed_by_role` e a proveniencia disponivel HOJE: service_role =
-- importacao/worker, postgres = operacao direta. Nao ha coluna de ator
-- humano porque NAO EXISTE caminho humano de escrita de custo -- quando
-- existir (RPC propria), ela grava a autoria dela. Nada de coluna sempre
-- nula fingindo auditoria.
--
-- Append-only fisico (padrao job_runs/support_case_events): UPDATE e DELETE
-- rejeitados ate para o dono; service_role recebe so SELECT e INSERT.

create table public.sku_cost_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  sku_id uuid not null references public.skus(id) on delete cascade,
  previous_cost numeric,
  new_cost numeric,
  changed_by_role text not null,
  changed_at timestamptz not null default now(),
  -- Cinto sobre o suspensorio dos WHEN das triggers: linha sem mudanca real
  -- nao existe.
  constraint sku_cost_history_change_real check (previous_cost is distinct from new_cost)
);

create index sku_cost_history_sku_idx
  on public.sku_cost_history (sku_id, changed_at desc);

comment on table public.sku_cost_history is
  'Historico append-only do custo cadastrado (skus.purchase_cost), gravado por trigger a cada mudanca (D-149). previous_cost nulo = primeiro registro (SKU nasceu com custo); new_cost nulo = custo apagado. changed_by_role: service_role = importacao/worker, postgres = operacao direta. SEM backfill: o registro comeca em 2026-08-30 e a tela declara isso. Custo de SIMULACAO/pedido vive em purchase_order_items.unit_cost e NUNCA escreve de volta em skus.';

-- Trigger de captura -----------------------------------------------------

create function private.record_sku_cost_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.sku_cost_history
    (organization_id, sku_id, previous_cost, new_cost, changed_by_role)
  values
    (new.organization_id, new.id,
     case when tg_op = 'INSERT' then null else old.purchase_cost end,
     new.purchase_cost,
     current_user);

  return null;
end;
$$;

comment on function private.record_sku_cost_change is
  'Grava sku_cost_history a cada mudanca de skus.purchase_cost (D-149). SEM security definer, de proposito: current_user identifica quem escreveu (service_role = import, postgres = direto), e todos os escritores legitimos de skus ja alcancam a tabela de historico.';

create trigger skus_record_cost_on_insert
  after insert on public.skus
  for each row
  when (new.purchase_cost is not null)
  execute function private.record_sku_cost_change();

create trigger skus_record_cost_on_update
  after update on public.skus
  for each row
  when (old.purchase_cost is distinct from new.purchase_cost)
  execute function private.record_sku_cost_change();

-- Append-only fisico ------------------------------------------------------

create function private.sku_cost_history_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'sku_cost_history e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

create trigger sku_cost_history_no_update
  before update on public.sku_cost_history
  for each row execute function private.sku_cost_history_reject_mutation();

create trigger sku_cost_history_no_delete
  before delete on public.sku_cost_history
  for each row execute function private.sku_cost_history_reject_mutation();

-- RLS e GRANTs (revoke-first, padrao D-111) --------------------------------

alter table public.sku_cost_history enable row level security;

create policy sku_cost_history_select_member
  on public.sku_cost_history for select to authenticated
  using (private.is_member_of(organization_id));

revoke all on public.sku_cost_history from anon, authenticated;
grant select on public.sku_cost_history to authenticated;
grant select, insert on public.sku_cost_history to service_role;
