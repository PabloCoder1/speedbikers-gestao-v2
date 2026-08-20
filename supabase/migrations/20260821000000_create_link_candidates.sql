-- ============================================================
-- Central de Vinculacoes: candidatos sem vinculo, com resolucao
-- por match exato ou confirmacao humana.
--
-- Fonte de candidatos hoje: linhas LINKS da importacao do UpSeller cujo SKU
-- ainda nao existe no catalogo (`erp_import_rows.apply_status = 'UNRESOLVED'`).
-- Outras fontes (NF-e, codigo de fornecedor) entram quando existirem
-- (`docs/PROMPT_MASTER.md` secao 15) — nao adivinhar formato agora.
--
-- As colunas de referencia (ref_kind/item_id/variation_id/user_product_id/
-- channel_sku) duplicam o que ja esta no jsonb de `erp_import_rows.payload`,
-- de proposito: e a mesma razao de `erp_import_rows.sku_key` existir —
-- permitir a confirmacao sem reabrir o jsonb dentro de uma funcao SQL.
-- ============================================================

create table public.link_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,

  source text not null default 'ERP_IMPORT' check (source in ('ERP_IMPORT')),
  source_row_id bigint not null references public.erp_import_rows(id) on delete cascade,

  sku_key text not null,

  -- Mesma forma e mesmo check de sku_listing_links.ref_shape — o candidato
  -- vira uma linha daquela tabela quando resolvido.
  ref_kind text not null check (ref_kind in ('ITEM', 'USER_PRODUCT')),
  item_id text check (item_id is null or item_id ~ '^MLB[0-9]+$'),
  variation_id text check (variation_id is null or variation_id ~ '^[0-9]+$'),
  user_product_id text check (user_product_id is null or user_product_id ~ '^MLBU[0-9]+$'),
  channel_sku text,

  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolved_sku_id uuid references public.skus(id) on delete set null,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  resolution_method text check (resolution_method in ('EXACT_MATCH', 'MANUAL')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Uma linha de origem gera no maximo um candidato. Reprocessar o mesmo lote
  -- (idempotencia do worker) atualiza o candidato existente, nunca duplica.
  constraint link_candidates_source_row_unique unique (source, source_row_id),

  constraint link_candidates_ref_shape check (
    (ref_kind = 'ITEM' and item_id is not null and user_product_id is null)
    or
    (ref_kind = 'USER_PRODUCT' and user_product_id is not null
       and item_id is null and variation_id is null)
  ),

  constraint link_candidates_resolved_coherent check (
    (status = 'RESOLVED' and resolved_sku_id is not null and resolved_at is not null
       and resolution_method is not null)
    or status <> 'RESOLVED'
  )
);

comment on table public.link_candidates is
  'Referencia sem vinculo pendente de resolucao (match exato ou confirmacao humana). docs/PROMPT_MASTER.md secao 15.';

comment on column public.link_candidates.resolution_method is
  'EXACT_MATCH: o worker resolveu sozinho quando o SKU passou a existir. MANUAL: confirmado por um humano na tela.';

-- Consulta quente das duas pontas: a tela lista OPEN por organizacao, e a
-- reconciliacao do worker varre OPEN por organizacao inteira apos cada apply.
create index link_candidates_org_status_idx
  on public.link_candidates (organization_id, status);

create trigger link_candidates_set_updated_at
  before update on public.link_candidates
  for each row execute function private.set_updated_at();

-- ============================================================
-- RPCs de resolucao.
--
-- `security definer` de proposito: a confirmacao e uma escrita atomica em
-- DUAS tabelas (cria o vinculo, fecha o candidato). Duas chamadas REST
-- separadas do navegador arriscariam ficar pela metade se a segunda falhasse.
-- Por isso a autorizacao e refeita AQUI DENTRO, nos mesmos termos da policy
-- de escrita de sku_listing_links — a funcao nao pode conceder mais acesso
-- do que a escrita direta ja concederia.
-- ============================================================

create or replace function public.resolve_link_candidate(p_candidate_id uuid, p_sku_id uuid)
returns public.sku_listing_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.link_candidates;
  target_org uuid;
  result public.sku_listing_links;
begin
  select * into c from public.link_candidates where id = p_candidate_id for update;

  if c.id is null then
    raise exception 'candidato % nao encontrado', p_candidate_id;
  end if;

  if c.status <> 'OPEN' then
    raise exception 'candidato % nao esta aberto', p_candidate_id;
  end if;

  if not private.is_member_of(c.organization_id)
     or not private.has_account_access(c.ml_account_id)
     or not private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para vincular este candidato';
  end if;

  select organization_id into target_org from public.skus where id = p_sku_id;

  if target_org is distinct from c.organization_id then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  insert into public.sku_listing_links (
    organization_id, ml_account_id, ref_kind, item_id, variation_id, user_product_id,
    sku_id, channel_sku, source, confirmed_by, confirmed_at
  ) values (
    c.organization_id, c.ml_account_id, c.ref_kind, c.item_id, c.variation_id, c.user_product_id,
    p_sku_id, c.channel_sku, 'MANUAL', (select auth.uid()), now()
  )
  returning * into result;

  update public.link_candidates
    set status = 'RESOLVED',
        resolved_sku_id = p_sku_id,
        resolved_by = (select auth.uid()),
        resolved_at = now(),
        resolution_method = 'MANUAL'
    where id = p_candidate_id;

  return result;
end;
$$;

comment on function public.resolve_link_candidate is
  'Confirmacao humana: cria o vinculo em sku_listing_links e fecha o candidato, na mesma transacao.';

create or replace function public.dismiss_link_candidate(p_candidate_id uuid)
returns public.link_candidates
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.link_candidates;
begin
  select * into c from public.link_candidates where id = p_candidate_id for update;

  if c.id is null then
    raise exception 'candidato % nao encontrado', p_candidate_id;
  end if;

  if c.status <> 'OPEN' then
    raise exception 'candidato % nao esta aberto', p_candidate_id;
  end if;

  if not private.is_member_of(c.organization_id)
     or not private.has_account_access(c.ml_account_id)
     or not private.has_role(array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para descartar este candidato';
  end if;

  update public.link_candidates
    set status = 'DISMISSED',
        resolved_by = (select auth.uid()),
        resolved_at = now()
    where id = p_candidate_id
    returning * into c;

  return c;
end;
$$;

comment on function public.dismiss_link_candidate is
  'Descarte humano: este candidato nao deve virar vinculo (ex.: produto fora de linha).';

-- ============================================================
-- RLS e GRANTs
--
-- Leitura para quem alcanca a conta, mesmos papeis que escrevem
-- sku_listing_links diretamente. Escrita NUNCA pela Data API — só pelas duas
-- funcoes acima (usuario) ou por service_role (worker criando candidatos).
-- ============================================================

alter table public.link_candidates enable row level security;

create policy link_candidates_select_permitted
  on public.link_candidates for select to authenticated
  using (private.has_account_access(ml_account_id));

grant select on public.link_candidates to authenticated;

grant select, insert, update, delete on public.link_candidates to service_role;

revoke all on public.link_candidates from anon;

revoke all on function public.resolve_link_candidate(uuid, uuid) from public;
revoke all on function public.dismiss_link_candidate(uuid) from public;

grant execute on function public.resolve_link_candidate(uuid, uuid) to authenticated;
grant execute on function public.dismiss_link_candidate(uuid) to authenticated;
