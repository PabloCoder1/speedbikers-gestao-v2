-- Configuracao de reposicao (D-144) -- a fundacao da Fase 5D, da qual todos
-- os outros itens leem (tendencia, sugestao, estados operacionais,
-- priorizacao).
--
-- TRES ESCOPOS EXCLUSIVOS, o mais especifico vence:
--   1. padrao da organizacao (supplier_brand e sku_id nulos, um por org);
--   2. por MARCA do fornecedor -- o eixo que D-129 estabeleceu
--      (`skus.supplier_id` nao existe DE PROPOSITO: `suppliers` tem uma
--      linha, e marca de catalogo nao e entidade de compra);
--   3. por SKU.
--
-- A resolucao (sku > marca > padrao > nada) e feita em
-- `@sb/domain/purchasing` -- regra da formula unica: quando a sugestao de
-- compra em SQL precisar dela, a versao SQL sera derivada com teste de
-- equivalencia.
--
-- ZERO LINHAS SEMEADAS (precedente D-127/D-133: configurar e ato humano).
-- A consequencia deliberada: sem configuracao aplicavel, a sugestao de
-- compra RECUSA numero em vez de inventar default -- mesmo desenho de
-- `stock_is_virtual` na cobertura. O PRD da referencias (~90 dias de
-- cobertura para importacao, ~15 de lead nacional), e referencias sao o que
-- o ADMIN digita na tela, nunca o que o codigo assume.
--
-- `sku_id` e `on delete cascade`: configuracao de um SKU morre com ele --
-- diferente dos ledgers (restrict), porque config nao e historia.
--
-- Politicas espelham reply_templates (D-111): leitura para membros, escrita
-- ADMIN/GESTOR, revoke-first.

create table public.replenishment_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_brand text
    check (supplier_brand is null
           or (char_length(supplier_brand) between 1 and 60
               and supplier_brand = upper(btrim(supplier_brand)))),
  sku_id uuid references public.skus(id) on delete cascade,
  lead_time_days integer not null check (lead_time_days between 1 and 365),
  target_coverage_days integer not null check (target_coverage_days between 1 and 365),
  safety_stock_days integer not null default 0 check (safety_stock_days between 0 and 365),
  policy_note text check (policy_note is null or char_length(policy_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint replenishment_settings_one_scope
    check (not (supplier_brand is not null and sku_id is not null))
);

create unique index replenishment_settings_org_default_key
  on public.replenishment_settings (organization_id)
  where supplier_brand is null and sku_id is null;

create unique index replenishment_settings_org_brand_key
  on public.replenishment_settings (organization_id, supplier_brand)
  where supplier_brand is not null;

create unique index replenishment_settings_org_sku_key
  on public.replenishment_settings (organization_id, sku_id)
  where sku_id is not null;

create trigger replenishment_settings_set_updated_at
  before update on public.replenishment_settings
  for each row execute function private.set_updated_at();

alter table public.replenishment_settings enable row level security;

create policy replenishment_settings_select_member
  on public.replenishment_settings for select to authenticated
  using (private.is_member_of(organization_id));

create policy replenishment_settings_insert_admin
  on public.replenishment_settings for insert to authenticated
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN','GESTOR']));

create policy replenishment_settings_update_admin
  on public.replenishment_settings for update to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN','GESTOR']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN','GESTOR']));

create policy replenishment_settings_delete_admin
  on public.replenishment_settings for delete to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN','GESTOR']));

revoke all on public.replenishment_settings from anon, authenticated;
grant select, insert, update, delete on public.replenishment_settings to authenticated;
grant all on public.replenishment_settings to service_role;

comment on table public.replenishment_settings is
  'Configuracao de reposicao (D-144, Fase 5D): lead time, cobertura alvo e estoque de seguranca, em tres escopos exclusivos -- padrao da organizacao (brand e sku nulos), por marca do fornecedor (o eixo de D-129; skus.supplier_id nao existe de proposito) ou por SKU. O mais especifico vence (resolvido em @sb/domain/purchasing). ZERO linhas semeadas: configurar e ato humano (precedente D-127/D-133), e sem configuracao a sugestao de compra RECUSA numero em vez de inventar default.';
comment on column public.replenishment_settings.lead_time_days is
  'Prazo de reposicao em dias. NAO e cobertura alvo: comprar 15 dias de estoque com 15 dias de prazo zera antes da entrega (PRD 2026-08-28).';
comment on column public.replenishment_settings.target_coverage_days is
  'Cobertura desejada em dias APOS o recebimento. A demanda a cobrir na sugestao e lead_time + cobertura + seguranca.';
