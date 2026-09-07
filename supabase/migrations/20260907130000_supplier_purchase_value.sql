-- ============================================================
-- "Valor comprado" por fornecedor: a coluna que faltava na LISTA, e a
-- correcao do mesmo defeito no DETALHE (D-258).
--
-- Duas mudancas numa fatia so, e a juncao e o ponto:
--
--   1. `get_suppliers` (NOVA) -- a lista de /fornecedores ganha "ultimo
--      pedido" e "valor comprado", duas das nove colunas que o brief secao 24
--      pede e que D20 nao entregou por precisarem de agregacao;
--   2. `get_supplier_overview` (RECRIADA) -- o mesmo numero, no dashboard
--      individual, deixa de transformar custo DESCONHECIDO em R$ 0,00.
--
-- Separa-las abriria uma janela em que lista e detalhe respondem diferente
-- para a mesma pergunta -- exatamente o "segundo dono do numero" que D-224
-- nomeia. A licao de D-255 foi essa: as duas implementacoes de uma definicao
-- so valem se forem conferidas UMA CONTRA A OUTRA, caso a caso.
--
-- ------------------------------------------------------------
-- O DEFEITO CORRIGIDO, que e o de D-254 numa terceira tela
-- ------------------------------------------------------------
-- `get_supplier_overview` somava assim:
--
--     coalesce(round(sum(quantity_ordered * unit_cost), 2), 0)
--
-- `sum()` sobre itens todos sem custo e NULO, e o `coalesce` o convertia em
-- **R$ 0,00**. Um fornecedor cujos pedidos ainda nao tem custo negociado
-- aparecia com "Comprado: R$ 0,00", que se le como "comprou nada" em vez de
-- "nao sei quanto". `unit_cost` e anulavel POR DESENHO
-- (`unit_cost is null or unit_cost >= 0`): custo em aberto e o estado normal
-- de um rascunho, nao excecao.
--
-- **O `coalesce` nao estava todo errado, e e por isso que a correcao nao e
-- apaga-lo.** Para um fornecedor SEM item nenhum o zero e SABIDO, e continua
-- zero. So o caso "ha itens, nenhum com custo" e que precisa virar nulo. As
-- tres saidas sao as mesmas de D-254/D-255:
--
--   sem item                  -> 0     (zero sabido)
--   itens, nenhum com custo   -> NULL  (a tela mostra "—")
--   itens, alguns com custo   -> soma parcial + `itens_sem_custo` > 0
--
-- `itens_sem_custo` e novo nas duas funcoes: sem ele a soma parcial se passa
-- por total fechado, que e o defeito com outra roupa. A ressalva ao lado do
-- numero e exigencia de `docs/METRICS.md` 5C.2.
--
-- ------------------------------------------------------------
-- POR QUE DROP + CREATE, e o que isso obriga a repetir
-- ------------------------------------------------------------
-- `create or replace` NAO muda o tipo de retorno, e `itens_sem_custo` e
-- coluna nova em `returns table`. Entao a funcao cai e nasce de novo -- e com
-- ela caem os GRANTS. A licao de D-242: o Postgres da EXECUTE a PUBLIC em
-- toda funcao nova, e o `grant` recriado precisa incluir `service_role`, ou o
-- worker perde acesso em silencio. O guard de D-182 ("nenhuma funcao de
-- public alcancavel por anon") e quem pega isso se eu esquecer.
--
-- CANCELADO CONTINUA SEPARADO (D-174/D-157): `valor_pedido` exclui
-- `CANCELLED` e `valor_cancelado` so ele. A lista mostra o primeiro, que e o
-- que "valor comprado" quer dizer; somar os dois afirmaria compra que nao
-- houve, e o unico pedido real do Dev esta cancelado.
--
-- ASSINATURA conferida nas duas metades antes de escrever (licao de D-237):
--   catalogo   `get_supplier_overview` nao e chamada por nenhuma funcao SQL
--   monorepo   so `apps/web/app/fornecedores/[supplierId]/page.tsx` e os
--              testes de integracao; `get_suppliers` e nome NOVO, sem
--              chamador algum
-- ============================================================

-- ------------------------------------------------------------
-- 1. A lista de /fornecedores
-- ------------------------------------------------------------

create function public.get_suppliers(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  -- ULTIMO, pela convencao de D-242/D-243: a suite de integracao chama por
  -- POSICAO, e argumento novo no meio quebra chamada que nao mudou.
  p_only_active boolean default null
)
returns table (
  id uuid,
  name text,
  legal_name text,
  document text,
  contact_name text,
  phone text,
  is_active boolean,
  orders_total bigint,
  ultimo_pedido_em timestamptz,
  valor_pedido numeric,
  itens_sem_custo bigint,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select s.id, s.name, s.legal_name, s.document, s.contact_name, s.phone, s.is_active,
           count(*) over () as total_count
    from public.suppliers s
    where s.organization_id = p_organization_id
      and (p_only_active is null or s.is_active = p_only_active)
    order by s.name
    limit p_limit offset p_offset
  )
  select b.id, b.name, b.legal_name, b.document, b.contact_name, b.phone, b.is_active,
         p.orders_total,
         p.ultimo_pedido_em,
         /*
           SEM `coalesce` aqui, e a ausencia dele e o ponto da fatia.
           A primeira versao tinha `coalesce(p.valor_pedido, 0)`, posto para o
           caso "fornecedor sem pedido" -- e ele engolia o NULO LEGITIMO de
           "tem itens, nenhum com custo", reintroduzindo na LISTA exatamente o
           defeito que esta migration corrige no DETALHE. Pego rodando as duas
           funcoes lado a lado contra o banco local: a lista dizia 0 onde o
           detalhe dizia "—".
           E o `coalesce` nem era necessario: a lateral e agregada sem
           `group by`, entao devolve SEMPRE uma linha -- `p` nunca e nulo, e o
           caso "sem pedido" ja cai no `count(*) = 0` la dentro.
         */
         p.valor_pedido,
         p.itens_sem_custo,
         b.total_count::bigint
  from base b
  -- Page-first (D-196): os agregados nao filtram nem ordenam, entao saem por
  -- lateral DEPOIS do limit -- so para os fornecedores da pagina.
  left join lateral (
    select count(*)::bigint as orders_total,
           max(po.created_at) as ultimo_pedido_em,
           (select case
                     when count(*) = 0 then 0
                     -- `round(...,2)` como no detalhe: mesma definicao tem
                     -- de devolver a mesma ESCALA, ou os dois lados divergem
                     -- na aparencia sem divergir no valor.
                     else round(sum(i.quantity_ordered * i.unit_cost), 2)
                   end
              from public.purchase_order_items i
              join public.purchase_orders po2 on po2.id = i.purchase_order_id
             where po2.supplier_id = b.id
               and po2.organization_id = p_organization_id
               and po2.status <> 'CANCELLED') as valor_pedido,
           (select count(*) filter (where i.unit_cost is null)::bigint
              from public.purchase_order_items i
              join public.purchase_orders po2 on po2.id = i.purchase_order_id
             where po2.supplier_id = b.id
               and po2.organization_id = p_organization_id
               and po2.status <> 'CANCELLED') as itens_sem_custo
    from public.purchase_orders po
    where po.supplier_id = b.id
      and po.organization_id = p_organization_id
  ) p on true
  order by b.name
$$;

comment on function public.get_suppliers(uuid, integer, integer, boolean) is
  'Lista de /fornecedores (D-258). Cadastro + "ultimo pedido" e "valor comprado", duas das nove colunas do brief secao 24 -- as outras cinco (origem, marcas, lead time, cobertura, politica) NAO sao fato de fornecedor neste modelo: skus.supplier_id nao existe de proposito e replenishment_settings e escopada por organizacao, marca ou SKU (D-174/D-256). valor_pedido EXCLUI cancelados (D-174) e tem tres saidas: 0 para fornecedor sem pedido ou sem item (zero sabido), NULL quando ha itens e nenhum tem custo (desconhecido, nunca R$ 0,00), soma parcial com itens_sem_custo > 0 quando alguns tem. Agregados por lateral DEPOIS do limit (page-first, D-196). total_count e o total filtrado, nao o da pagina (D-131). security invoker.';

revoke all on function public.get_suppliers(uuid, integer, integer, boolean) from public, anon;
grant execute on function public.get_suppliers(uuid, integer, integer, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. O dashboard individual, com a MESMA definicao
-- ------------------------------------------------------------

drop function public.get_supplier_overview(uuid, uuid);

create function public.get_supplier_overview(
  p_organization_id uuid,
  p_supplier_id uuid
)
returns table (
  supplier_id uuid,
  name text,
  legal_name text,
  document text,
  contact_name text,
  email text,
  phone text,
  whatsapp text,
  website text,
  notes text,
  is_active boolean,
  orders_total bigint,
  orders_draft bigint,
  orders_approved bigint,
  orders_ordered bigint,
  orders_received bigint,
  orders_cancelled bigint,
  skus_distintos bigint,
  unidades_pedidas numeric,
  valor_pedido numeric,
  unidades_canceladas numeric,
  valor_cancelado numeric,
  itens_sem_custo bigint,
  itens_cancelados_sem_custo bigint,
  primeiro_pedido_em timestamptz,
  ultimo_pedido_em timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pedidos as (
    select po.id, po.status, po.created_at
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and po.supplier_id = p_supplier_id
  ),
  itens as (
    select i.sku_id, i.sku_snapshot, i.quantity_ordered, i.unit_cost, p.status
    from public.purchase_order_items i
    join pedidos p on p.id = i.purchase_order_id
  )
  select
    s.id, s.name, s.legal_name, s.document,
    s.contact_name, s.email, s.phone, s.whatsapp, s.website,
    s.notes, s.is_active,
    (select count(*) from pedidos)::bigint,
    (select count(*) from pedidos where status = 'DRAFT')::bigint,
    (select count(*) from pedidos where status = 'APPROVED')::bigint,
    (select count(*) from pedidos where status = 'ORDERED')::bigint,
    (select count(*) from pedidos where status = 'RECEIVED')::bigint,
    (select count(*) from pedidos where status = 'CANCELLED')::bigint,
    -- `sku_snapshot` cobre o item em texto livre, que o formulario aceita de
    -- proposito (vinculo pendente e informacao, nao bloqueio).
    (select count(distinct coalesce(sku_id::text, sku_snapshot)) from itens)::bigint,
    -- Unidade sempre e conhecida (`quantity_ordered` e NOT NULL): o zero aqui
    -- e sempre sabido, e o `coalesce` continua certo. E so o VALOR que muda.
    (select coalesce(sum(quantity_ordered), 0) from itens where status <> 'CANCELLED'),
    -- Tres saidas (D-254): 0 sem item, NULO com itens e nenhum custo, soma
    -- parcial quando alguns tem. `sum()` ja ignora nulo; o `case` existe para
    -- separar o zero SABIDO do zero FALSO.
    (select case
              when count(*) = 0 then 0
              else round(sum(quantity_ordered * unit_cost), 2)
            end
       from itens where status <> 'CANCELLED'),
    (select coalesce(sum(quantity_ordered), 0) from itens where status = 'CANCELLED'),
    (select case
              when count(*) = 0 then 0
              else round(sum(quantity_ordered * unit_cost), 2)
            end
       from itens where status = 'CANCELLED'),
    -- A ressalva: sem ela a soma parcial se passa por total fechado.
    (select count(*) filter (where unit_cost is null)::bigint
       from itens where status <> 'CANCELLED'),
    (select count(*) filter (where unit_cost is null)::bigint
       from itens where status = 'CANCELLED'),
    (select min(created_at) from pedidos),
    (select max(created_at) from pedidos)
  from public.suppliers s
  where s.organization_id = p_organization_id and s.id = p_supplier_id
$$;

comment on function public.get_supplier_overview(uuid, uuid) is
  'Resumo de UM fornecedor (D-174, corrigido em D-258): cadastro + agregados dos pedidos, com cancelado SEPARADO (nunca somado ao resto, nunca escondido). valor_pedido e valor_cancelado deixaram de usar coalesce(sum,0): custo AUSENTE nao e zero (D-254). Tres saidas -- 0 sem item (zero sabido), NULL com itens e nenhum custo, soma parcial com itens_sem_custo > 0. As unidades continuam com coalesce porque quantity_ordered e NOT NULL: ali o zero e sempre sabido. Nao existe catalogo fornecedor->SKU; o unico relacionamento com produto e o que foi comprado. Mesma definicao de valor que get_suppliers, conferida caso a caso. security invoker.';

revoke all on function public.get_supplier_overview(uuid, uuid) from public, anon;
grant execute on function public.get_supplier_overview(uuid, uuid) to authenticated, service_role;
