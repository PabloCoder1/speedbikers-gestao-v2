-- ============================================================
-- `get_purchase_orders_overview` — /compras numa leitura so (D-365).
--
-- A tela era uma fila de oito colunas sem nenhum numero de decisao: para saber
-- quanto dinheiro estava comprometido, quantos pedidos esperavam aprovacao ou
-- qual fornecedor estava atrasado, era preciso abrir pedido por pedido. Esta
-- funcao devolve, num `jsonb`, tudo o que a tela refeita pergunta:
--
--   total       quantos pedidos passam nos filtros (a janela, D-131)
--   contagens   por estado: pedidos, valor e pedidos com custo faltando
--   em_aberto   rascunho + aprovado + enviado: o dinheiro comprometido
--   atrasados   aprovado ou enviado com a previsao ja vencida
--   chegando    aprovado ou enviado com previsao nos proximos 7 dias
--   recebidos   recebidos nos ultimos 30 dias
--   linhas      a pagina, com itens, unidades, valor e dias ate a previsao
--
-- `get_purchase_orders` (D-255) continua existindo, sem mudanca: a web da
-- branch principal chega ao ar antes desta migration, e a tela cai nela
-- quando esta funcao ainda nao existe (PGRST202).
--
-- ------------------------------------------------------------
-- POR QUE NAO E PAGE-FIRST, ao contrario de D-255
-- ------------------------------------------------------------
-- D-196 manda calcular depois do `limit` o que nao filtra nem ordena. Aqui o
-- valor por pedido FILTRA os cartoes (a soma do valor em aberto precisa de
-- todos os pedidos abertos, nao dos 50 da pagina). Entao os itens sao lidos
-- uma vez, agrupados por pedido, para o conjunto da busca -- e a pagina sai
-- desse mesmo conjunto. Pedido de compra e tabela pequena (dezenas a poucas
-- centenas por organizacao), e a leitura usa `purchase_order_items_order_idx`.
--
-- Os cartoes seguem a regra de `/reposicao` (D-250/D-358): respeitam a BUSCA,
-- nao o estado nem o "so atrasados" -- clicar num cartao nao pode zerar os
-- outros.
--
-- ------------------------------------------------------------
-- VALOR: a mesma definicao de D-254, com as tres saidas
-- ------------------------------------------------------------
--   pedido SEM item             -> 0      (zero SABIDO)
--   itens, NENHUM com custo     -> NULL   (desconhecido)
--   itens, ALGUNS com custo     -> soma parcial + `sem_custo` > 0
--
-- Nos agregados, `sum()` ignora o NULL de um pedido sem custo e o conta em
-- `sem_custo`; um grupo em que NENHUM pedido tem valor conhecido devolve NULL,
-- nunca 0. Grupo vazio devolve 0: nenhum pedido e zero sabido.
--
-- ------------------------------------------------------------
-- A PREVISAO E UMA DATA, nao um instante
-- ------------------------------------------------------------
-- O formulario grava `expected_at` como `new Date('AAAA-MM-DD').toISOString()`
-- -- meia-noite UTC do dia escolhido -- e a edicao le de volta com
-- `slice(0, 10)`. A data de negocio, entao, e `expected_at` em UTC. A lista
-- mostrava `formatDateTime`, que converte para Sao Paulo: o dia 20 aparecia
-- como "19/09, 21:00". Aqui a data sai pronta (`previsao`), e o "hoje" que
-- decide o atraso e o de Sao Paulo, o dia de quem opera.
--
-- Atraso so vale para APROVADO e ENVIADO: rascunho ainda nao foi pedido, e
-- recebido/cancelado ja terminou.
-- ============================================================

create function public.get_purchase_orders_overview(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default null,
  p_search text default null,
  p_overdue boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
-- Filtros anulaveis (`p_status is null or ...`): o plano generico nao sabe
-- qual ramo vale, e D-358 mediu o custo disso. Plano por chamada.
set plan_cache_mode = force_custom_plan
as $$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as dia
  ),
  pedidos as (
    select po.id,
           po.order_number,
           po.status,
           po.supplier_id,
           s.name as supplier_name,
           po.destination_warehouse_name,
           po.created_at,
           po.created_by,
           po.approved_at,
           po.ordered_at,
           po.received_at,
           po.cancelled_at,
           (po.expected_at at time zone 'UTC')::date as previsao,
           (po.expected_at at time zone 'UTC')::date - h.dia as dias_para_previsao,
           coalesce(
             po.status in ('APPROVED', 'ORDERED') and (po.expected_at at time zone 'UTC')::date < h.dia,
             false
           ) as atrasado,
           coalesce(
             po.status in ('APPROVED', 'ORDERED')
               and (po.expected_at at time zone 'UTC')::date between h.dia and h.dia + 7,
             false
           ) as chegando
    from public.purchase_orders po
    cross join hoje h
    -- `left join`: fornecedor e anulavel por desenho (rascunho sem fornecedor).
    left join public.suppliers s on s.id = po.supplier_id
    where po.organization_id = p_organization_id
      and (p_search is null
           or po.order_number::text ilike '%' || p_search || '%'
           or s.name ilike '%' || p_search || '%')
  ),
  itens as (
    select i.purchase_order_id,
           count(*) as itens,
           sum(i.quantity_ordered) as unidades,
           count(*) filter (where i.unit_cost is null) as sem_custo,
           sum(i.quantity_ordered * i.unit_cost) as soma
    from public.purchase_order_items i
    join pedidos p on p.id = i.purchase_order_id
    group by i.purchase_order_id
  ),
  completos as (
    select p.*,
           coalesce(it.itens, 0) as itens,
           coalesce(it.unidades, 0) as unidades,
           coalesce(it.sem_custo, 0) as sem_custo,
           -- Sem linha em `itens` = pedido sem item = zero sabido. Com linha,
           -- `soma` e NULL quando nenhum item tem custo (D-254).
           case when it.purchase_order_id is null then 0 else it.soma end as valor
    from pedidos p
    left join itens it on it.purchase_order_id = p.id
  ),
  filtrados as (
    select *
    from completos c
    where (p_status is null or c.status = p_status)
      and (not coalesce(p_overdue, false) or c.atrasado)
  ),
  pagina as (
    select f.*
    from filtrados f
    order by f.created_at desc, f.order_number desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'contagens', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'status', e.status,
               'pedidos', e.pedidos,
               'valor', e.valor,
               'sem_custo', e.sem_custo
             ) order by e.status), '[]'::jsonb)
      from (
        select c.status,
               count(*) as pedidos,
               sum(c.valor) as valor,
               count(*) filter (where c.valor is null or c.sem_custo > 0) as sem_custo
        from completos c
        group by c.status
      ) e
    ),
    'em_aberto', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor is null or c.sem_custo > 0)
             )
      from completos c
      where c.status in ('DRAFT', 'APPROVED', 'ORDERED')
    ),
    'atrasados', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor is null or c.sem_custo > 0),
               'maior_atraso_dias', coalesce(max(-c.dias_para_previsao), 0)
             )
      from completos c
      where c.atrasado
    ),
    'chegando', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor is null or c.sem_custo > 0)
             )
      from completos c
      where c.chegando
    ),
    'recebidos', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor is null or c.sem_custo > 0)
             )
      from completos c
      where c.status = 'RECEIVED'
        and c.received_at >= now() - interval '30 days'
    ),
    'linhas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', pg.id,
               'order_number', pg.order_number,
               'status', pg.status,
               'supplier_id', pg.supplier_id,
               'supplier_name', pg.supplier_name,
               'destination_warehouse_name', pg.destination_warehouse_name,
               'created_at', pg.created_at,
               'created_by_name', pr.full_name,
               'approved_at', pg.approved_at,
               'ordered_at', pg.ordered_at,
               'received_at', pg.received_at,
               'cancelled_at', pg.cancelled_at,
               'previsao', pg.previsao,
               'dias_para_previsao', pg.dias_para_previsao,
               'atrasado', pg.atrasado,
               'itens', pg.itens,
               'unidades', pg.unidades,
               'sem_custo', pg.sem_custo,
               'valor', pg.valor
             ) order by pg.created_at desc, pg.order_number desc), '[]'::jsonb)
      from pagina pg
      -- `left join`: o perfil pode ter sido apagado e `full_name` e anulavel.
      left join public.profiles pr on pr.id = pg.created_by
    )
  )
$$;

comment on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) is
  '/compras numa leitura (D-365): total filtrado, contagens por estado, em aberto, atrasados, chegando em 7 dias, recebidos em 30 dias e a pagina. Os agregados respeitam a busca e ignoram estado e "so atrasados" (D-250). Valor segue D-254: 0 sem item, NULL sem nenhum custo, soma parcial com sem_custo > 0. previsao e a data de negocio (expected_at em UTC, como o formulario grava); atraso compara com o dia de Sao Paulo e so vale para APPROVED/ORDERED. security invoker.';

revoke all on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) from public, anon;
grant execute on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) to authenticated, service_role;
