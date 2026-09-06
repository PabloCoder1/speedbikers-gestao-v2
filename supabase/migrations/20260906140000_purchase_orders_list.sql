-- ============================================================
-- `get_purchase_orders` — a lista de /compras pelo frame `ProcessScreen
-- type="purchases"` (D19, D-255).
--
-- POR QUE UMA RPC, e nao mais colunas no `select` do PostgREST. O frame pede
-- sete colunas, e duas delas nao sao colunas: **Itens** e **Valor Estimado**.
-- A segunda e `sum(quantidade x custo)` -- uma EXPRESSAO, nao um agregado de
-- coluna, e os agregados do PostgREST nao a expressam. Somar no navegador
-- exigiria ler os itens de TODOS os pedidos da pagina so para somar, que e
-- precisamente o que `AGENTS.md` proibe ("agregacao em SQL, nunca em
-- JavaScript").
--
-- ------------------------------------------------------------
-- PAGE-FIRST, pela licao de D-196
-- ------------------------------------------------------------
-- Contagem de itens e valor estimado **nao filtram e nao ordenam**: eles so
-- aparecem na saida. Logo nao ha razao para calcula-los antes do `limit`.
-- A CTE `base` recorta e pagina; as duas agregacoes saem por `lateral`
-- SOMENTE para os pedidos que a pagina devolve. Com 1 pedido no Dev isso nao
-- se mede, mas o desenho errado so aparece quando ja doi -- e D-196 ja pagou
-- essa conta em `get_stock_balances` (313.941 linhas lidas para enriquecer
-- 50).
--
-- `count(*) over ()` corre dentro de `base`, sobre o conjunto FILTRADO e
-- antes do recorte: `total_count` e o total da busca, nunca o da pagina. E a
-- classe de defeito que a tela tinha -- `.limit(100)` e um rodape dizendo
-- "N pedido(s)" com N = tamanho da pagina (D-131).
--
-- ------------------------------------------------------------
-- VALOR ESTIMADO: a definicao e a de D-254, e ela tem TRES saidas
-- ------------------------------------------------------------
-- `unit_cost` e anulavel por desenho (`unit_cost is null or unit_cost >= 0`):
-- custo nao preenchido e o estado normal de um rascunho. Entao:
--
--   pedido SEM item             -> 0      (zero SABIDO)
--   itens, NENHUM com custo     -> NULL   (desconhecido, a tela mostra "—")
--   itens, ALGUNS com custo     -> soma parcial + `items_missing_cost` > 0
--
-- `sum()` ignora NULL por si, entao a soma ja e "so o que tem custo"; o
-- `case` existe para separar o zero SABIDO (sem item) do zero FALSO (itens
-- sem custo), que e a distincao que D-254 corrigiu do lado do TypeScript.
--
-- **Ha duas implementacoes desta definicao, e isso e deliberado.** Esta, para
-- a LISTA (onde os itens nao sao lidos), e `apps/web/lib/purchase-order-cost.ts`,
-- para o DETALHE (onde ja foram lidos para a tabela, e uma segunda consulta
-- seria desperdicio). Nao e um segundo dono do numero no sentido de D-224: e
-- a MESMA regra, escrita duas vezes porque os dois contextos tem custos
-- diferentes. O contrato entre elas -- as tres saidas acima -- esta fixado em
-- teste dos dois lados; mudar uma sem a outra e o defeito a vigiar.
--
-- ------------------------------------------------------------
-- ASSINATURA: conferida nas duas metades, antes de escrever (licao de D-237)
-- ------------------------------------------------------------
--   catalogo   funcao NOVA -- nao ha chamador a quebrar
--   monorepo   nenhuma ocorrencia de `get_purchase_orders` em apps/ ou
--              packages/ antes desta fatia
--
-- Argumentos de filtro vem por ULTIMO na assinatura, pela convencao de
-- D-242/D-243: a suite de integracao chama funcoes por POSICAO, e um
-- argumento inserido no meio quebra chamadas que nao mudaram.
--
-- ESTADOS: cinco, nao sete. O brief secao 23 pede "Em transito" e "Recebido
-- parcialmente", e o frame desenha um badge "Recebimento Parcial" -- a
-- `check` constraint de `purchase_orders` aceita
-- DRAFT/APPROVED/ORDERED/RECEIVED/CANCELLED e nada mais. Recebimento parcial
-- exigiria quantidade RECEBIDA por item, que `purchase_order_items` nao tem.
-- Filtro de estado fora da lista nao vai ao banco: quem valida e o
-- TypeScript (`lib/purchase-order-filters.ts`), pelo mesmo motivo de D-242 --
-- zero linhas seria indistinguivel de filtro legitimo sem resultado.
-- ============================================================

create function public.get_purchase_orders(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default null,
  p_search text default null
)
returns table (
  id uuid,
  order_number bigint,
  status text,
  supplier_name text,
  destination_warehouse_name text,
  expected_at timestamptz,
  created_at timestamptz,
  created_by_name text,
  items_count bigint,
  items_missing_cost bigint,
  estimated_value numeric,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select po.id,
           po.order_number,
           po.status,
           s.name as supplier_name,
           po.destination_warehouse_name,
           po.expected_at,
           po.created_at,
           po.created_by,
           count(*) over () as total_count
    from public.purchase_orders po
    -- `left join`: fornecedor e anulavel por desenho ("um rascunho pode nascer
    -- antes do fornecedor estar decidido"). `inner` sumiria com os rascunhos,
    -- que sao exatamente os pedidos que a fila existe para mostrar.
    left join public.suppliers s on s.id = po.supplier_id
    where po.organization_id = p_organization_id
      and (p_status is null or po.status = p_status)
      -- Busca sobre o que o frame nomeia no campo ("Buscar PC, fornecedor..."):
      -- o numero do pedido e o nome do fornecedor.
      and (p_search is null
           or po.order_number::text ilike '%' || p_search || '%'
           or s.name ilike '%' || p_search || '%')
    order by po.created_at desc
    limit p_limit offset p_offset
  )
  select b.id,
         b.order_number,
         b.status,
         b.supplier_name,
         b.destination_warehouse_name,
         b.expected_at,
         b.created_at,
         p.full_name as created_by_name,
         coalesce(it.items_count, 0)::bigint as items_count,
         coalesce(it.items_missing_cost, 0)::bigint as items_missing_cost,
         it.estimated_value,
         b.total_count::bigint
  from base b
  -- `left join`: `created_by` e NOT NULL, mas o perfil pode ter sido apagado
  -- (`on delete restrict` protege o pedido, nao o nome), e `full_name` e
  -- anulavel. A tela mostra "—" nos dois casos.
  left join public.profiles p on p.id = b.created_by
  left join lateral (
    select count(*)::bigint as items_count,
           count(*) filter (where i.unit_cost is null)::bigint as items_missing_cost,
           case
             when count(*) = 0 then 0
             else sum(i.quantity_ordered * i.unit_cost)
           end as estimated_value
    from public.purchase_order_items i
    where i.purchase_order_id = b.id
  ) it on true
  order by b.created_at desc
$$;

comment on function public.get_purchase_orders(uuid, integer, integer, text, text) is
  'Lista de /compras pelo frame ProcessScreen type="purchases" (D-255). Sete colunas, duas delas agregadas: items_count e estimated_value saem por lateral DEPOIS do limit (page-first de D-196) porque nenhuma das duas filtra ou ordena. estimated_value segue a definicao de D-254 e tem TRES saidas: 0 para pedido sem item (zero sabido), NULL quando ha itens e nenhum tem custo (desconhecido, nunca R$ 0,00), e soma parcial com items_missing_cost > 0 quando alguns tem -- unit_cost e anulavel por desenho. total_count vem de count(*) over () dentro do recorte filtrado, antes da paginacao: e o total da busca, nao o da pagina (D-131). Cinco estados, nao os sete do brief: a check constraint de purchase_orders nao conhece "em transito" nem "recebido parcialmente". security invoker.';

-- DROP + CREATE nao se aplica (funcao nova), mas o `revoke` continua sendo
-- obrigatorio: o Postgres da EXECUTE a PUBLIC em TODA funcao nova, e o guarda
-- de D-182 ("nenhuma funcao de public alcancavel por anon") ficaria vermelho.
revoke all on function public.get_purchase_orders(uuid, integer, integer, text, text) from public, anon;
grant execute on function public.get_purchase_orders(uuid, integer, integer, text, text) to authenticated, service_role;
