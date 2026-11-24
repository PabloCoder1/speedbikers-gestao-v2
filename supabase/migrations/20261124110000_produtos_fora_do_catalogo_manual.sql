-- D-860, segunda parte: o operador marca à mão o produto FORA DO CATÁLOGO.
--
-- A planilha só tira do catálogo o que sumiu da exportação do UpSeller. O
-- produto com que a loja não vai mais trabalhar, mas que o UpSeller ainda
-- lista, ficava ativo, na Reposição e nas sugestões de compra. Apagar continua
-- fora de questão (pedidos, ledger de estoque e vínculos referenciam o SKU com
-- `on delete restrict`); o caminho é a mesma marca, posta por gente.
--
-- A regra:
-- * a marca ganha ORIGEM (`erp_absent_source`): PLANILHA (a aplicação do lote)
--   ou MANUAL (a tela de Produtos);
-- * a marca MANUAL não sai com a planilha: o produto que continua vindo no
--   arquivo do UpSeller continua fora, e a aplicação, que regrava `is_active`
--   com o valor da planilha, tem o falso reafirmado no fim;
-- * marcar guarda o `is_active` de antes (`erp_absent_was_active`), e tirar a
--   marca à mão devolve esse valor, em vez de inventar "ativo";
-- * marcar à mão o que a planilha já marcou não muda nada (JA_DECIDIDO): a
--   origem continua sendo a planilha.

alter table public.skus
  add column erp_absent_source text,
  add column erp_absent_was_active boolean;

-- As marcas que já existem vieram todas da planilha (a única origem até aqui).
update public.skus
   set erp_absent_source = 'PLANILHA'
 where erp_absent_since is not null
   and erp_absent_source is null;

alter table public.skus
  add constraint skus_erp_absent_source_coherent
  check (
    (erp_absent_since is null) = (erp_absent_source is null)
    and (erp_absent_source is null or erp_absent_source in ('PLANILHA', 'MANUAL'))
    and (erp_absent_source is distinct from 'MANUAL' or erp_absent_batch_id is null)
    and (erp_absent_since is not null or erp_absent_was_active is null)
  );

comment on column public.skus.erp_absent_source is
  'D-860: quem pôs a marca de fora do catálogo. PLANILHA = a aplicação de um lote PRODUCTS (sai quando o SKU volta numa planilha); MANUAL = o operador na tela de Produtos (só sai à mão). Nulo junto com erp_absent_since.';
comment on column public.skus.erp_absent_was_active is
  'D-860: o is_active do SKU no momento da marca, para tirar a marca à mão devolver o valor de antes. Nulo = sem marca, ou marca anterior a esta coluna.';


-- ---------------------------------------------------------------------------
-- 1. A prévia da conferência: "voltam" é só a marca da planilha
-- ---------------------------------------------------------------------------
-- Republicação de 20261124100000 com um filtro a mais em `voltam`: a marca
-- MANUAL não volta com a planilha, então não pode ser anunciada como volta.

create or replace function public.get_products_batch_absences(p_batch_id uuid, p_sample integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with lote as (
    select b.id, b.organization_id
    from public.erp_import_batches b
    where b.id = p_batch_id
      and b.kind = 'PRODUCTS'
  ),
  conhecidos as (
    -- O denominador da tela: o catálogo que as planilhas de produtos já trouxeram.
    select sk.id
    from lote l
    join public.skus sk
      on sk.organization_id = l.organization_id
     and sk.kind = 'PRODUTO'
    where exists (
      select 1
      from public.erp_import_batches pb
      join public.erp_import_rows pr on pr.batch_id = pb.id
      where pb.organization_id = l.organization_id
        and pb.kind = 'PRODUCTS'
        and pb.status = 'APPLIED'
        and pb.id <> l.id
        and pr.sku_key = sk.sku_key
        and pr.apply_status = 'APPLIED'
    )
  ),
  ausentes as (
    select sk.id, sk.sku, sk.title, sk.erp_absent_since
    from public.products_batch_absent_sku_ids(p_batch_id) a(sku_id)
    join public.skus sk on sk.id = a.sku_id
  ),
  saldo as (
    select b.sku_id, sum(b.quantity) as quantidade
    from public.inventory_balances b
    join ausentes a on a.id = b.sku_id
    where b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  vinculo as (
    select distinct k.sku_id
    from public.sku_listing_links k
    join ausentes a on a.id = k.sku_id
  ),
  voltam as (
    select sk.id
    from lote l
    join public.skus sk
      on sk.organization_id = l.organization_id
     and sk.erp_absent_source = 'PLANILHA'
    where exists (
      select 1
      from public.erp_import_rows r
      where r.batch_id = l.id
        and r.status = 'OK'
        and r.sku_key = sk.sku_key
    )
  ),
  amostra as (
    select a.id, a.sku, a.title, a.erp_absent_since
    from ausentes a
    order by a.sku
    limit greatest(coalesce(p_sample, 50), 0)
  )
  select case
    when not exists (select 1 from lote) then null
    else jsonb_build_object(
      'conhecidos', (select count(*) from conhecidos),
      'ausentes', (select count(*) from ausentes),
      'jaMarcados', (select count(*) from ausentes where erp_absent_since is not null),
      'comSaldo', (select count(*) from saldo where quantidade > 0),
      'comVinculo', (select count(*) from vinculo),
      'voltam', (select count(*) from voltam),
      'amostra', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'skuId', m.id,
                 'sku', m.sku,
                 'title', m.title,
                 'saldo', s.quantidade,
                 'comVinculo', v.sku_id is not null,
                 'foraDesde', m.erp_absent_since)
               order by m.sku)
        from amostra m
        left join saldo s on s.sku_id = m.id
        left join vinculo v on v.sku_id = m.id
      ), '[]'::jsonb)
    )
  end;
$$;

comment on function public.get_products_batch_absences(uuid, integer) is
  'D-860: a prévia da conferência de um lote PRODUCTS: quantos SKUs conhecidos (já vieram numa planilha de produtos aplicada), quantos ficariam fora do catálogo, quantos destes já estavam marcados, têm saldo LOCAL positivo ou vínculo com anúncio, quantos marcados PELA PLANILHA voltam (a marca manual não volta), e uma amostra ordenada por SKU. Nulo para lote que não é PRODUCTS ou que a RLS esconde. security invoker.';


-- ---------------------------------------------------------------------------
-- 2. A marcação no fim da aplicação: respeita a marca manual
-- ---------------------------------------------------------------------------

create or replace function public.apply_products_batch_absences(p_batch_id uuid, p_mark boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_kind text;
  v_marked integer := 0;
  v_cleared integer := 0;
  v_kept integer := 0;
begin
  select b.organization_id, b.kind
    into v_org, v_kind
  from public.erp_import_batches b
  where b.id = p_batch_id;

  if v_org is null then
    raise exception 'lote % não existe', p_batch_id;
  end if;

  if v_kind <> 'PRODUCTS' then
    raise exception 'lote % não é de produtos (%)', p_batch_id, v_kind;
  end if;

  -- Quem voltou perde a marca DA PLANILHA. O is_active já foi gravado pela
  -- aplicação, com o valor que o UpSeller manda: aqui só sai o motivo.
  update public.skus sk
     set erp_absent_since = null,
         erp_absent_batch_id = null,
         erp_absent_source = null,
         erp_absent_was_active = null
   where sk.organization_id = v_org
     and sk.erp_absent_source = 'PLANILHA'
     and exists (
       select 1
       from public.erp_import_rows r
       where r.batch_id = p_batch_id
         and r.status = 'OK'
         and r.sku_key = sk.sku_key
     );

  get diagnostics v_cleared = row_count;

  -- A marca MANUAL fica. A aplicação acabou de regravar is_active com o valor
  -- da planilha; o falso volta aqui, e o valor da planilha vira o "de antes".
  update public.skus sk
     set erp_absent_was_active = sk.is_active,
         is_active = false
   where sk.organization_id = v_org
     and sk.erp_absent_source = 'MANUAL'
     and sk.is_active
     and exists (
       select 1
       from public.erp_import_rows r
       where r.batch_id = p_batch_id
         and r.status = 'OK'
         and r.sku_key = sk.sku_key
     );

  get diagnostics v_kept = row_count;

  if coalesce(p_mark, false) then
    update public.skus sk
       set erp_absent_since = now(),
           erp_absent_batch_id = p_batch_id,
           erp_absent_source = 'PLANILHA',
           erp_absent_was_active = sk.is_active,
           is_active = false
     where sk.id in (select a from public.products_batch_absent_sku_ids(p_batch_id) a)
       and sk.erp_absent_since is null;

    get diagnostics v_marked = row_count;
  end if;

  update public.erp_import_batches b
     set absent_marked = case
           when coalesce(p_mark, false) then coalesce(b.absent_marked, 0) + v_marked
           else b.absent_marked
         end,
         absent_cleared = coalesce(b.absent_cleared, 0) + v_cleared
   where b.id = p_batch_id;

  return jsonb_build_object('marked', v_marked, 'cleared', v_cleared, 'manualKept', v_kept);
end;
$$;

comment on function public.apply_products_batch_absences(uuid, boolean) is
  'D-860: no fim da aplicação de um lote PRODUCTS, tira a marca de fora do catálogo POSTA PELA PLANILHA de quem voltou, reafirma is_active falso de quem tem marca MANUAL e veio no arquivo e, com p_mark, marca (is_active falso + erp_absent_since, origem PLANILHA) os SKUs de products_batch_absent_sku_ids. Idempotente; acumula absent_marked/absent_cleared no lote. Só service_role.';

revoke all on function public.apply_products_batch_absences(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_products_batch_absences(uuid, boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 3. A marca à mão, em lote, na tela de Produtos
-- ---------------------------------------------------------------------------
-- Mesma forma de set_skus_supplier_brand (D-133): até 500 por chamada, quem
-- escreve é ADMIN ou GESTOR, trava por organização, desfecho por linha.
-- security definer porque `authenticated` só tem SELECT em skus: toda escrita
-- de curadoria passa por uma RPC que confere o papel antes.

create function public.set_skus_out_of_catalog(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_out boolean
)
returns table (sku_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(distinct t.x)
    into v_ids
    from unnest(coalesce(p_sku_ids, '{}'::uuid[])) as t(x)
   where t.x is not null;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'selecao vazia';
  end if;

  if array_length(v_ids, 1) > 500 then
    raise exception 'selecao grande demais';
  end if;

  if p_out is null then
    raise exception 'decisao invalida';
  end if;

  perform private.check_sku_curation_writer(p_organization_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sku_curation:' || p_organization_id::text, 0)
  );

  return query
  with alvo as materialized (
    select k.id
    from public.skus k
    where k.organization_id = p_organization_id
      and k.id = any(v_ids)
    order by k.id
    for update
  ),
  atualizado as (
    update public.skus k
       set erp_absent_since = case when p_out then pg_catalog.now() else null end,
           erp_absent_batch_id = null,
           -- 'MANUAL' LITERAL: a origem nunca vem do cliente (como em D-133).
           erp_absent_source = case when p_out then 'MANUAL' else null end,
           erp_absent_was_active = case when p_out then k.is_active else null end,
           -- Tirar a marca devolve o valor de antes; marca sem ele (anterior à
           -- coluna) volta a ativo, que é o que a planilha manda por padrão.
           is_active = case when p_out then false else coalesce(k.erp_absent_was_active, true) end
      from alvo a
     where k.id = a.id
       and (case when p_out then k.erp_absent_since is null else k.erp_absent_since is not null end)
     returning k.id
  )
  select
    t.x as sku_id,
    case
      when u.id is not null then 'APLICADO'
      when a2.id is not null then 'JA_DECIDIDO'
      else 'NAO_ENCONTRADO'
    end as status
  from unnest(v_ids) as t(x)
  left join atualizado u on u.id = t.x
  left join alvo a2 on a2.id = t.x;
end;
$$;

comment on function public.set_skus_out_of_catalog(uuid, uuid[], boolean) is
  'D-860: marca (p_out verdadeiro) ou tira (falso) a marca de fora do catálogo de até 500 SKUs, à mão. Marcar grava origem MANUAL, guarda o is_active de antes e o põe falso; tirar devolve o is_active guardado. O SKU já no estado pedido sai JA_DECIDIDO (marcar não troca a origem PLANILHA). Só ADMIN e GESTOR. Devolve o desfecho por linha.';

-- `alter default privileges` concede EXECUTE a anon e authenticated em toda
-- função nova de `public` (D-041, D-130): o revoke explícito é obrigatório.
revoke all on function public.set_skus_out_of_catalog(uuid, uuid[], boolean) from public, anon;
grant execute on function public.set_skus_out_of_catalog(uuid, uuid[], boolean) to authenticated;
