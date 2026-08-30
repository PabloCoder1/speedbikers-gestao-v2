-- Curadoria do catalogo: as duas colunas que so uma PESSOA pode preencher
-- (`stock_is_virtual`, D-127; `supplier_brand`, D-129) ganham um caminho de
-- escrita em lote (D-133).
--
-- `authenticated` tem apenas `grant select on public.skus` e a tabela NAO tem
-- policy de escrita. Isso e deliberado e continua: a escrita entra por RPC
-- `security definer` que refaz a autorizacao internamente, mesmo desenho de
-- D-125. Nenhuma policy de UPDATE em `skus` nasce aqui.
--
-- MEDICAO DE PLANO exigida antes do merge, contra o banco real (3.554 SKUs,
-- 3.372 retratos, 18.913 linhas de metrica em 90 dias):
--   get_sku_curation, primeira pagina de 100 -> Execution Time 116 ms,
--   todos os buffers em shared hit, vendas de 90 dias por
--   `daily_sku_metrics_account_date_idx`. O `distinct on` varre 3.372 linhas
--   e o `skus` 3.554 -- tabelas pequenas, seq scan e a escolha certa do
--   planner. NENHUM INDICE NOVO: o plano nao pediu, e `docs/DATABASE.md`
--   secao 6 exige EXPLAIN antes de criar indice.

-- ------------------------------------------------------------
-- 1. Guarda de autorizacao
--
-- ADMIN/GESTOR, herdado de `erp_stock_snapshots_select_admin`: a tela PROJETA
-- o retrato do ERP, e uma RPC `security definer` nao pode conceder mais
-- acesso do que a leitura direta concedia. Como corolario, as funcoes de
-- LEITURA tambem sao `security definer` com a mesma guarda -- `security
-- invoker` faria a tela aparecer VAZIA para um OPERADOR, em vez de NEGAR, e
-- tela vazia mente.
-- ------------------------------------------------------------

create or replace function private.check_sku_curation_writer(p_organization_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_member_of(p_organization_id) or not private.has_role(array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para curar o catalogo desta organizacao';
  end if;
end;
$$;

revoke all on function private.check_sku_curation_writer(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. get_sku_curation -- a fila de trabalho
-- ------------------------------------------------------------

create function public.get_sku_curation(
  p_organization_id uuid,
  p_brand text default null,
  p_missing_brand boolean default false,
  p_classified text default null,
  p_signal text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  brand text,
  supplier_brand text,
  supplier_brand_source text,
  supplier_brand_set_at timestamptz,
  stock_is_virtual boolean,
  stock_is_virtual_set_at timestamptz,
  snapshot_available numeric,
  snapshot_captured_at timestamptz,
  has_sentinel_signature boolean,
  units_sold_90d bigint,
  decision_diverges_from_signature boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_sku_curation_writer(p_organization_id);

  return query
  with retrato as (
    -- Mesma forma de compute_erp_target_balances: o retrato mais recente por
    -- (sku, armazem). `available` e o "Disponivel" do UpSeller, que e o que
    -- alimenta o LOCAL do ledger.
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  retrato_agg as (
    select r.sku_id, sum(r.available) as available, max(r.captured_at) as captured_at
    from retrato r
    group by r.sku_id
  ),
  vendas as (
    select m.sku_id, sum(m.units_sold)::bigint as units_sold_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date >= (current_date - 89)
    group by m.sku_id
  ),
  base as (
    -- Universo: TODAS as linhas de skus da organizacao. NAO filtra
    -- `is_active` -- nenhum outro consumidor de `skus` filtra
    -- (`get_stock_coverage`, `get_sku_abc_curve`, nenhuma tela), e filtrar
    -- faria as contagens desta tela discordarem do catalogo medido.
    select
      k.id as sku_id,
      k.sku,
      k.title,
      k.brand,
      k.supplier_brand,
      k.supplier_brand_source,
      k.supplier_brand_set_at,
      k.stock_is_virtual,
      k.stock_is_virtual_set_at,
      k.sku_key,
      ra.available as snapshot_available,
      ra.captured_at as snapshot_captured_at,
      -- NULL quando nao ha retrato: "sem opiniao do ERP" e um TERCEIRO
      -- estado, nunca "nao parece sentinela". Medido: 182 SKUs.
      case
        when ra.sku_id is null then null
        else (ra.available between 900 and 1000 or ra.available between 9900 and 10000)
      end as has_sentinel_signature,
      coalesce(v.units_sold_90d, 0)::bigint as units_sold_90d
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    left join vendas v on v.sku_id = k.id
    where k.organization_id = p_organization_id
  ),
  marcada as (
    select
      b.*,
      -- O ERP se mexeu debaixo de uma decisao ja tomada. E a leitura de volta
      -- que faz a ferramenta continuar util DEPOIS da primeira varredura.
      (b.stock_is_virtual_set_at is not null
        and b.has_sentinel_signature is not null
        and b.stock_is_virtual <> b.has_sentinel_signature) as decision_diverges_from_signature
    from base b
  ),
  filtrada as (
    select m.* from marcada m
    where (p_brand is null or m.supplier_brand = p_brand)
      and (not coalesce(p_missing_brand, false) or m.supplier_brand is null)
      and (
        p_classified is null
        or (p_classified = 'PENDENTE' and m.stock_is_virtual_set_at is null)
        or (p_classified = 'VIRTUAL' and m.stock_is_virtual_set_at is not null and m.stock_is_virtual)
        or (p_classified = 'FISICO' and m.stock_is_virtual_set_at is not null and not m.stock_is_virtual)
      )
      and (
        p_signal is null
        or (p_signal = 'SENTINELA' and m.has_sentinel_signature)
        or (p_signal = 'SEM_SINAL' and m.has_sentinel_signature is false)
        or (p_signal = 'SEM_RETRATO' and m.has_sentinel_signature is null)
        or (p_signal = 'DIVERGENTE' and m.decision_diverges_from_signature)
      )
      and (
        p_search is null
        or pg_catalog.btrim(p_search) = ''
        or m.sku_key like pg_catalog.upper(pg_catalog.btrim(p_search)) || '%'
        or m.title ilike '%' || pg_catalog.btrim(p_search) || '%'
      )
  )
  select
    f.sku_id, f.sku, f.title, f.brand,
    f.supplier_brand, f.supplier_brand_source, f.supplier_brand_set_at,
    f.stock_is_virtual, f.stock_is_virtual_set_at,
    f.snapshot_available, f.snapshot_captured_at,
    f.has_sentinel_signature, f.units_sold_90d, f.decision_diverges_from_signature,
    -- Janela ANTES do limit: e o total do filtro, nao o da pagina.
    (count(*) over ())::bigint as total_count
  from filtrada f
  order by
    f.decision_diverges_from_signature desc nulls last,
    f.has_sentinel_signature desc nulls last,
    f.sku
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_sku_curation is
  'Fila de curadoria do catalogo (D-133): SKU, marca real, retrato do ERP, assinatura sentinela, vendas de 90 dias e o estado da decisao humana. `security definer` porque projeta erp_stock_snapshots, cuja policy exige ADMIN/GESTOR -- e porque `security invoker` deixaria a tela VAZIA para OPERADOR em vez de negar. `has_sentinel_signature` NULL = sem retrato do ERP, terceiro estado.';

-- ------------------------------------------------------------
-- 3. get_sku_curation_summary -- os totais do cabecalho
-- ------------------------------------------------------------

create function public.get_sku_curation_summary(p_organization_id uuid)
returns table (
  is_total boolean,
  supplier_brand text,
  total bigint,
  unclassified bigint,
  virtual_marked bigint,
  with_signature bigint,
  diverging bigint,
  snapshot_captured_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_sku_curation_writer(p_organization_id);

  return query
  with retrato as (
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  retrato_agg as (
    select r.sku_id, sum(r.available) as available, max(r.captured_at) as captured_at
    from retrato r
    group by r.sku_id
  ),
  base as (
    select
      k.supplier_brand,
      k.stock_is_virtual,
      k.stock_is_virtual_set_at,
      ra.captured_at,
      case
        when ra.sku_id is null then null
        else (ra.available between 900 and 1000 or ra.available between 9900 and 10000)
      end as assinatura
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    where k.organization_id = p_organization_id
  )
  -- `grouping sets` distingue a linha TOTAL da linha "marca nula" (2.274
  -- SKUs). Sao coisas diferentes e um `union all` as confundiria.
  select
    (grouping(b.supplier_brand) = 1) as is_total,
    b.supplier_brand,
    count(*)::bigint as total,
    count(*) filter (where b.stock_is_virtual_set_at is null)::bigint as unclassified,
    count(*) filter (where b.stock_is_virtual)::bigint as virtual_marked,
    count(*) filter (where b.assinatura)::bigint as with_signature,
    count(*) filter (
      where b.stock_is_virtual_set_at is not null
        and b.assinatura is not null
        and b.stock_is_virtual <> b.assinatura
    )::bigint as diverging,
    max(b.captured_at) as snapshot_captured_at
  from base b
  group by grouping sets ((b.supplier_brand), ())
  order by (grouping(b.supplier_brand) = 1) desc, count(*) desc, b.supplier_brand;
end;
$$;

comment on function public.get_sku_curation_summary is
  'Totais da curadoria por marca real, mais a linha TOTAL (D-133). Usa grouping sets porque "todas as marcas" e "os SKUs sem marca" sao linhas diferentes e um union all as confundiria. `snapshot_captured_at` alimenta a tarja de contexto da tela: o retrato do ERP tem data e a tela precisa dize-la.';

-- ------------------------------------------------------------
-- 4. set_skus_stock_virtual -- a escrita em lote
--
-- PRIMEIRA RPC DE ESCRITA MULTI-LINHA concedida a `authenticated` neste
-- repositorio, e primeiro retorno POR LINHA de uma escrita (molde de leitura:
-- `erp_import_rows`). O retorno por linha nao e enfeite: sem ele o filtro de
-- no-op fica invisivel e "412 marcados" pode significar 8.
-- ------------------------------------------------------------

create function public.set_skus_stock_virtual(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_decision text
)
returns table (sku_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_virtual boolean;
begin
  if p_decision is null or p_decision not in ('VIRTUAL', 'FISICO', 'INDEFINIDO') then
    raise exception 'decisao invalida';
  end if;

  select array_agg(distinct t.x)
    into v_ids
    from unnest(coalesce(p_sku_ids, '{}'::uuid[])) as t(x)
   where t.x is not null;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'selecao vazia';
  end if;

  -- Teto de raio de explosao, nao de desempenho: com a selecao presa a uma
  -- pagina de 100, 500 ja e cinco paginas inteiras.
  if array_length(v_ids, 1) > 500 then
    raise exception 'selecao grande demais';
  end if;

  perform private.check_sku_curation_writer(p_organization_id);

  -- Trava consultiva + `order by id for update`. As duas juntas fecham a
  -- classe de deadlock entre dois lotes que se cruzam; remover qualquer uma
  -- PARECE inofensivo e nao e.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sku_curation:' || p_organization_id::text, 0)
  );

  v_virtual := (p_decision = 'VIRTUAL');

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
       set stock_is_virtual = case when p_decision = 'INDEFINIDO' then false else v_virtual end,
           stock_is_virtual_set_by = case when p_decision = 'INDEFINIDO' then null else (select auth.uid()) end,
           stock_is_virtual_set_at = case when p_decision = 'INDEFINIDO' then null else pg_catalog.now() end
      from alvo a
     where k.id = a.id
       and (
         -- Reafirmar `false` sobre um `false` NUNCA DECIDIDO e decisao nova,
         -- nao no-op: e o clique que tira o SKU da fila.
         (p_decision <> 'INDEFINIDO'
           and (k.stock_is_virtual is distinct from v_virtual or k.stock_is_virtual_set_at is null))
         or (p_decision = 'INDEFINIDO' and k.stock_is_virtual_set_at is not null)
       )
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

comment on function public.set_skus_stock_virtual is
  'Classifica SKUs como estoque VIRTUAL, FISICO ou INDEFINIDO em lote, ate 500 por chamada (D-133). Devolve o desfecho POR LINHA: APLICADO, JA_DECIDIDO (no-op) ou NAO_ENCONTRADO. Id de outra organizacao volta NAO_ENCONTRADO em vez de abortar o lote -- desvio declarado dos precedentes de linha unica, e a tela e obrigada a exibir a contagem. INDEFINIDO devolve a linha ao estado "ninguem olhou", sem o qual uma marcacao errada so poderia ser invertida, nunca desfeita.';

-- ------------------------------------------------------------
-- 5. set_skus_supplier_brand
-- ------------------------------------------------------------

create function public.set_skus_supplier_brand(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_supplier_brand text
)
returns table (sku_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_brand text;
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

  perform private.check_sku_curation_writer(p_organization_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sku_curation:' || p_organization_id::text, 0)
  );

  v_brand := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_supplier_brand, ''))), '');

  if v_brand is not null and pg_catalog.char_length(v_brand) > 60 then
    raise exception 'marca invalida';
  end if;

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
       -- LIMPAR zera as QUATRO colunas no MESMO statement: anular so o texto
       -- estouraria `skus_supplier_brand_source_coherent` (23514) e derrubaria
       -- o lote inteiro.
       set supplier_brand = v_brand,
           -- 'MANUAL' LITERAL, jamais parametro do cliente: gravar 'DERIVED'
           -- passaria em toda CHECK e seria apagado em silencio pela primeira
           -- re-derivacao -- o modo de falha para o qual D-129 criou a coluna.
           supplier_brand_source = case when v_brand is null then null else 'MANUAL' end,
           supplier_brand_set_by = case when v_brand is null then null else (select auth.uid()) end,
           supplier_brand_set_at = case when v_brand is null then null else pg_catalog.now() end
      from alvo a
     where k.id = a.id
       and (
         k.supplier_brand is distinct from v_brand
         -- Confirmar a mao uma DERIVED identica NAO e no-op: promove a linha a
         -- MANUAL e a blinda contra re-derivacao.
         or (v_brand is not null and k.supplier_brand_source is distinct from 'MANUAL')
       )
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

comment on function public.set_skus_supplier_brand is
  'Preenche ou limpa a marca real do fornecedor em lote, ate 500 por chamada (D-133). Normaliza para caixa alta sem espacos nas bordas (medido: nenhuma das 1.280 marcas existentes muda com isso). Marca vazia LIMPA e zera as quatro colunas juntas. Grava supplier_brand_source = MANUAL literal no corpo, nunca vindo do cliente. Devolve o desfecho por linha.';

-- ------------------------------------------------------------
-- 6. GRANTs -- `revoke ... from public` sozinho NAO basta neste projeto:
-- `alter default privileges` concede EXECUTE direto a anon e authenticated
-- em toda funcao nova de `public` (D-041, D-130).
-- ------------------------------------------------------------

revoke all on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer) to authenticated;

revoke all on function public.get_sku_curation_summary(uuid) from public, anon;
grant execute on function public.get_sku_curation_summary(uuid) to authenticated;

revoke all on function public.set_skus_stock_virtual(uuid, uuid[], text) from public, anon;
grant execute on function public.set_skus_stock_virtual(uuid, uuid[], text) to authenticated;

revoke all on function public.set_skus_supplier_brand(uuid, uuid[], text) from public, anon;
grant execute on function public.set_skus_supplier_brand(uuid, uuid[], text) to authenticated;
