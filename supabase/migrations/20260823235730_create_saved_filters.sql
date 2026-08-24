-- Filtros salvos (Fase 5B, docs/ROADMAP.md — metade separada de "Busca
-- Universal / Command Palette e Filtros salvos", D-060) — presets de filtro
-- por USUÁRIO e por TELA, guardando o estado do filtro como jsonb (o mesmo
-- formato dos query params já usados por /vendas, /curva-abc etc.). Sem
-- papel restrito (ADMIN/GESTOR) como pedidos de compra: é preferência
-- pessoal, qualquer membro da organização pode salvar a própria.

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  screen text not null check (char_length(screen) between 1 and 60),
  name text not null check (char_length(name) between 1 and 80),
  params jsonb not null,
  created_at timestamptz not null default now(),

  unique (created_by, screen, name)
);

comment on table public.saved_filters is
  'Presets de filtro salvos por usuário e por tela — params jsonb é o mesmo formato dos query params já usados pela tela (ex.: /vendas?days=30&account=slug vira {"days":"30","account":"slug"}). Sem papel restrito: preferência pessoal, qualquer membro pode salvar a própria. Escrita só via RPC (create_saved_filter/delete_saved_filter, security definer) — mesmo padrão de stock_movements/domain_events, authenticated não grava direto.';

create index saved_filters_screen_idx on public.saved_filters (created_by, screen);

alter table public.saved_filters enable row level security;

create policy saved_filters_select_own
  on public.saved_filters for select
  to authenticated
  using (created_by = (select auth.uid()));

-- `revoke all ... from anon` sozinho NÃO basta neste projeto Supabase:
-- privilégios padrão concedem INSERT/UPDATE/DELETE também a `authenticated`
-- em tabela nova, mesmo sem GRANT explícito nenhum — achado ao verificar com
-- `has_table_privilege` (o mesmo já era verdade, sem revogação explícita,
-- para `stock_movements` e outras tabelas só-leitura-para-authenticated
-- desta sessão; ali a RLS sem policy de escrita já bloqueava na prática, mas
-- o GRANT em si nunca tinha sido apertado). Revoga de `authenticated` também,
-- antes de conceder só o SELECT pretendido.
revoke all on public.saved_filters from anon, authenticated;
grant select on public.saved_filters to authenticated;
grant all on public.saved_filters to service_role;

create function public.create_saved_filter(
  p_organization_id uuid,
  p_screen text,
  p_name text,
  p_params jsonb
)
returns public.saved_filters
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.saved_filters;
begin
  if not private.is_member_of(p_organization_id) then
    raise exception 'sem permissao para salvar filtro nesta organizacao';
  end if;

  insert into public.saved_filters (organization_id, created_by, screen, name, params)
  values (p_organization_id, (select auth.uid()), p_screen, p_name, p_params)
  on conflict (created_by, screen, name) do update set params = excluded.params
  returning * into result;

  return result;
end;
$$;

comment on function public.create_saved_filter(uuid, text, text, jsonb) is
  'Cria (ou sobrescreve, se o nome ja existir para esta tela) um preset de filtro do usuario que chama. Autorizacao (membro da organizacao) refeita internamente.';

revoke all on function public.create_saved_filter(uuid, text, text, jsonb) from public, anon;
grant execute on function public.create_saved_filter(uuid, text, text, jsonb) to authenticated, service_role;

create function public.delete_saved_filter(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.saved_filters where id = p_id and created_by = (select auth.uid());
end;
$$;

comment on function public.delete_saved_filter(uuid) is
  'Apaga um preset de filtro — so o dono apaga (checagem interna, mesmo sem linha nenhuma a funcao nao erra, so nao afeta nada).';

revoke all on function public.delete_saved_filter(uuid) from public, anon;
grant execute on function public.delete_saved_filter(uuid) to authenticated, service_role;
