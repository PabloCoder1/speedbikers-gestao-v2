-- ============================================================
-- D-370 -- a logo do fornecedor.
--
-- O pedido do dono: "coloque opcao de colocar a logo no fornecedor". O desenho
-- e o da foto de perfil (D-354, 20260915160000), com a pasta sendo a
-- ORGANIZACAO e nao a pessoa:
--
--   1. `suppliers.logo_path` -- o CAMINHO no bucket, nunca a URL: a URL
--      depende do projeto (Dev x producao) e envelheceria num restore;
--   2. o bucket `supplier-logos`, PUBLICO: a logo aparece na lista, no painel
--      e na escolha do fornecedor do pedido, e URL assinada seria uma ida a
--      mais por render (D-195). Logo de fornecedor nao e dado sensivel, e o
--      caminho leva um uuid aleatorio por envio;
--   3. escrita no bucket so para ADMIN/GESTOR DA organizacao dona da pasta
--      (`private.has_org_role`, a juncao de D-180);
--   4. `set_supplier_logo` -- `suppliers` so muda por RPC. `update_supplier`
--      nao conhece a coluna e nao a apaga: ela so muda aqui;
--   5. `get_suppliers_overview` devolve `logo_path` em cada linha (mesma
--      assinatura, `create or replace`). O leitor da web trata o campo como
--      OPCIONAL, para a lista nao quebrar onde a migration ainda nao chegou.
--
-- O timestamp e posterior ao de 20260917150000 (a ultima da v3 quando esta
-- fatia foi escrita), para o `db push` nao recusar por ordem.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A coluna, com a forma travada
-- ------------------------------------------------------------
-- `<organization_id>/<uuid>.<ext>`: a pasta e a organizacao, e e ela que as
-- policies do bucket conferem. Caminho fora da forma nao entra no cadastro.
alter table public.suppliers
  add column logo_path text
    constraint suppliers_logo_path_shape check (
      logo_path is null
      or logo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg|jpeg)$'
    );

comment on column public.suppliers.logo_path is
  'Caminho da logo no bucket supplier-logos (<organization_id>/<uuid>.<ext>), nunca a URL (D-370). NULL = sem logo, e a tela desenha as iniciais.';

-- ------------------------------------------------------------
-- 2 e 3. Quem escreve no bucket, e o bucket
-- ------------------------------------------------------------
-- Texto e nao uuid: a policy passa o nome da pasta, que vem do cliente. Pasta
-- que nao e uuid vira "nao pode", nunca erro de conversao (mesma razao de
-- `private.can_edit_profile`).
create function private.can_manage_supplier_logo(target_org text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_org ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.has_org_role(target_org::uuid, array['ADMIN', 'GESTOR'])
    else false
  end;
$$;

comment on function private.can_manage_supplier_logo(text) is
  'ADMIN ou GESTOR da organizacao dona da pasta pode enviar, trocar e apagar logos de fornecedor (D-370). Texto: a pasta vem do cliente, e uuid invalido vira recusa, nao erro.';

revoke all on function private.can_manage_supplier_logo(text) from public, anon;
grant execute on function private.can_manage_supplier_logo(text) to authenticated, service_role;

-- 1 MiB e folga: a tela ajusta a logo num quadrado de 512 px antes de enviar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-logos', 'supplier-logos', true, 1048576, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Leitura por `authenticated` so para o Storage conferir a linha ao trocar ou
-- apagar. A imagem em si e publica.
create policy supplier_logos_select
  on storage.objects for select to authenticated
  using (bucket_id = 'supplier-logos');

create policy supplier_logos_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-logos' and private.can_manage_supplier_logo((storage.foldername(name))[1]));

create policy supplier_logos_update
  on storage.objects for update to authenticated
  using (bucket_id = 'supplier-logos' and private.can_manage_supplier_logo((storage.foldername(name))[1]))
  with check (bucket_id = 'supplier-logos' and private.can_manage_supplier_logo((storage.foldername(name))[1]));

create policy supplier_logos_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-logos' and private.can_manage_supplier_logo((storage.foldername(name))[1]));

-- ------------------------------------------------------------
-- 4. set_supplier_logo
-- ------------------------------------------------------------
-- Devolve o caminho ANTERIOR, para a tela apagar o arquivo velho so depois de
-- o cadastro apontar para o novo (a ordem de `salvarFoto`, D-354).
create function public.set_supplier_logo(p_id uuid, p_logo_path text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_anterior text;
begin
  select s.organization_id, s.logo_path
    into v_org, v_anterior
  from public.suppliers s
  where s.id = p_id
  for update;

  if v_org is null then
    raise exception 'fornecedor % nao encontrado', p_id;
  end if;

  -- Papel NA organizacao do fornecedor (D-180), e nao o par
  -- is_member_of + has_role.
  if not private.has_org_role(v_org, array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para alterar o fornecedor';
  end if;

  -- A pasta tem de ser a organizacao do fornecedor: um caminho de outra
  -- organizacao apontaria para uma imagem que esta nao controla.
  if p_logo_path is not null and split_part(p_logo_path, '/', 1) <> v_org::text then
    raise exception 'logo fora da pasta da organizacao';
  end if;

  update public.suppliers
     set logo_path = p_logo_path
   where id = p_id;

  return v_anterior;
end;
$$;

comment on function public.set_supplier_logo(uuid, text) is
  'Troca (ou tira, com NULL) a logo do fornecedor e devolve o caminho anterior (D-370). ADMIN/GESTOR da organizacao do fornecedor; o caminho precisa estar na pasta dela. A forma do caminho e travada pela check de suppliers.logo_path.';

revoke all on function public.set_supplier_logo(uuid, text) from public, anon;
grant execute on function public.set_supplier_logo(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. get_suppliers_overview devolve logo_path
-- ------------------------------------------------------------
-- Corpo identico ao de 20260917150000, com UMA coluna a mais em `base`, que
-- sai em cada linha por `to_jsonb(p)`.
create or replace function public.get_suppliers_overview(
  p_organization_id uuid,
  p_search text default null,
  p_state text default null,
  p_order text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  termo text := nullif(btrim(coalesce(p_search, '')), '');
  -- CNPJ se digita com e sem pontuacao; o cadastro tambem guarda dos dois
  -- jeitos. So compara digitos quando o termo TEM digitos suficientes, senao
  -- "a" casaria com todo documento.
  digitos text := nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '');
  resultado jsonb;
begin
  with pedidos as (
    select po.supplier_id,
           count(*)::bigint as orders_total,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED'))::bigint as orders_em_aberto,
           max(po.created_at) as ultimo_pedido_em
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and po.supplier_id is not null
    group by po.supplier_id
  ),
  itens as (
    select po.supplier_id,
           count(*) filter (where po.status <> 'CANCELLED') as itens_validos,
           round(sum(i.quantity_ordered * i.unit_cost) filter (where po.status <> 'CANCELLED'), 2) as soma_valida,
           count(*) filter (where po.status <> 'CANCELLED' and i.unit_cost is null)::bigint as itens_sem_custo,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')) as itens_abertos,
           round(sum(i.quantity_ordered * i.unit_cost)
             filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')), 2) as soma_aberta,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')
                              and i.unit_cost is null)::bigint as itens_em_aberto_sem_custo,
           -- Com os cancelados, como `get_supplier_overview`: o mesmo nome
           -- tem de contar a mesma coisa na lista e no dashboard.
           count(distinct coalesce(i.sku_id::text, i.sku_snapshot))::bigint as skus_distintos
    from public.purchase_order_items i
    join public.purchase_orders po on po.id = i.purchase_order_id
    where po.organization_id = p_organization_id
      and po.supplier_id is not null
    group by po.supplier_id
  ),
  base as (
    select s.id, s.name, s.legal_name, s.document, s.contact_name, s.email,
           s.phone, s.whatsapp, s.website, s.is_active, s.created_at,
           -- D-370: o caminho da logo; a tela monta a URL publica.
           s.logo_path,
           coalesce(p.orders_total, 0) as orders_total,
           coalesce(p.orders_em_aberto, 0) as orders_em_aberto,
           p.ultimo_pedido_em,
           -- As tres saidas de D-258: sem item -> 0; itens sem custo -> NULL.
           case when coalesce(it.itens_validos, 0) = 0 then 0 else it.soma_valida end as valor_pedido,
           coalesce(it.itens_sem_custo, 0) as itens_sem_custo,
           case when coalesce(it.itens_abertos, 0) = 0 then 0 else it.soma_aberta end as valor_em_aberto,
           coalesce(it.itens_em_aberto_sem_custo, 0) as itens_em_aberto_sem_custo,
           coalesce(it.skus_distintos, 0) as skus_distintos
    from public.suppliers s
    left join pedidos p on p.supplier_id = s.id
    left join itens it on it.supplier_id = s.id
    where s.organization_id = p_organization_id
      and (termo is null
           or s.name ilike '%' || termo || '%'
           or s.legal_name ilike '%' || termo || '%'
           or s.contact_name ilike '%' || termo || '%'
           or s.email ilike '%' || termo || '%'
           or (length(digitos) >= 3
               and regexp_replace(coalesce(s.document, ''), '\D', '', 'g') like '%' || digitos || '%'))
  ),
  filtrada as (
    select b.*
    from base b
    where p_state is null
       or (p_state = 'ativos' and b.is_active)
       or (p_state = 'inativos' and not b.is_active)
       or (p_state = 'em_aberto' and b.orders_em_aberto > 0)
       or (p_state = 'sem_pedido' and b.orders_total = 0)
  ),
  pagina as (
    select f.*
    from filtrada f
    order by
      case when p_order = 'valor' then f.valor_pedido end desc nulls last,
      case when p_order = 'recente' then f.ultimo_pedido_em end desc nulls last,
      case when p_order = 'em_aberto' then f.orders_em_aberto end desc,
      lower(f.name), f.id
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'contagens', (
      select jsonb_build_object(
        'todos', count(*),
        'ativos', count(*) filter (where b.is_active),
        'inativos', count(*) filter (where not b.is_active),
        'em_aberto', count(*) filter (where b.orders_em_aberto > 0),
        'sem_pedido', count(*) filter (where b.orders_total = 0))
      from base b),
    'totais', (
      select jsonb_build_object(
        'pedidos_em_aberto', coalesce(sum(b.orders_em_aberto), 0),
        -- A soma das somas repete as tres saidas: se ha item em aberto e
        -- NENHUM tem custo, o total e desconhecido, nao R$ 0,00.
        'valor_em_aberto', case
          when coalesce(sum(it.itens_abertos), 0) = 0 then 0
          else round(sum(it.soma_aberta), 2) end,
        'itens_em_aberto_sem_custo', coalesce(sum(b.itens_em_aberto_sem_custo), 0),
        'valor_comprado', case
          when coalesce(sum(it.itens_validos), 0) = 0 then 0
          else round(sum(it.soma_valida), 2) end,
        'itens_sem_custo', coalesce(sum(b.itens_sem_custo), 0),
        'ultimo_pedido_em', max(b.ultimo_pedido_em),
        'ultimo_pedido_fornecedor', (
          select b2.name from base b2
          where b2.ultimo_pedido_em is not null
          order by b2.ultimo_pedido_em desc, b2.name
          limit 1))
      from base b
      left join itens it on it.supplier_id = b.id),
    'linhas', coalesce((
      select jsonb_agg(to_jsonb(p) order by
        case when p_order = 'valor' then p.valor_pedido end desc nulls last,
        case when p_order = 'recente' then p.ultimo_pedido_em end desc nulls last,
        case when p_order = 'em_aberto' then p.orders_em_aberto end desc,
        lower(p.name), p.id)
      from pagina p), '[]'::jsonb)
  )
  into resultado;

  return resultado;
end
$fn$;

revoke all on function public.get_suppliers_overview(uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_suppliers_overview(uuid, text, text, text, integer, integer) to authenticated, service_role;
