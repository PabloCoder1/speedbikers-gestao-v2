-- ============================================================
-- Filtro de MARCA na Curva ABC (D-235) -- item P1 "filtros de Conta / Origem /
-- Marca nas telas em que fizerem sentido".
--
-- A tela ja tinha o filtro de CONTA; faltava o de marca, e com ele
-- `/curva-abc` passa a responder "quais SKUs sustentam o faturamento DESTA
-- marca" em vez de so "da operacao inteira".
--
-- ------------------------------------------------------------
-- 1. QUAL COLUNA E "MARCA", E POR QUE A OUTRA NAO SERVE
-- ------------------------------------------------------------
-- Existem duas, e elas DIVERGEM em 2.320 dos 3.554 SKUs. Medido no Dev:
--
--   skus.brand           83,0% preenchida, 19 valores -- e o topo e `MANETE`,
--                        que e TIPO DE PECA, em 2.225 SKUs cuja marca real e
--                        `OFF RACER`. D-129 ja tinha registrado: essa coluna
--                        guarda a CATEGORIA do UpSeller e o importador a
--                        sobrescreve a cada planilha.
--   skus.supplier_brand  99,9% preenchida, 19 valores, marcas de verdade
--                        (`OFF RACER`, `NAVETEC`, `PLASMOTO`, `RT`), com
--                        procedencia (`MANUAL`/`DERIVED`) e normalizacao
--                        (`OFFRACER` -> `OFF RACER`).
--
-- Filtrar por `brand` daria uma resposta plausivel e ERRADA -- exatamente o
-- motivo pelo qual o item deixou a "Origem" de fora (`is_imported` medido como
-- nao confiavel). `supplier_brand` e a mesma coluna que `replenishment_settings`
-- ja usa para escopo, entao a tela concorda com a reposicao.
--
-- ------------------------------------------------------------
-- 2. O FILTRO ENTRA NA `base`, E ISSO E A DECISAO INTEIRA
-- ------------------------------------------------------------
-- A funcao ja dizia, sobre a conta: *"Escopo na PONTA 1: quais SKUs entram na
-- curva"* e *"o denominador sai do MESMO conjunto escopado"*.
--
-- Havia duas semanticas possiveis para a marca, e a escolha muda o numero:
--
--   (a) na `base`      -> a CURVA ABC DENTRO DA MARCA. As participacoes somam
--                         100% da marca, e as classes A/B/C sao recalculadas
--                         ali dentro.
--   (b) na `classificada` -> onde os SKUs da marca CAEM na curva global. As
--                         classes vem do total da operacao e a marca so
--                         filtra a exibicao.
--
-- **(a)**, porque o filtro de CONTA ja escolheu (a) explicitamente. Se a marca
-- escolhesse (b), a MESMA tela significaria coisas diferentes conforme o filtro
-- usado -- e ninguem leria o rodape para descobrir qual.
--
-- ------------------------------------------------------------
-- 3. `exists` E NAO `join`, E O MOTIVO E MEDIDO
-- ------------------------------------------------------------
-- A forma da casa nas outras quatro RPCs e `(p_supplier_brand is null or
-- sk.supplier_brand = p_supplier_brand)` sobre um `skus sk` **ja juntado**.
-- Aqui a `base` NAO junta `skus` -- juntar so para filtrar mudaria o plano
-- tambem quando NAO ha filtro. Medido no Dev, quente nos tres:
--
--   hoje (sem o parametro)          18,4 ms   1.184 buffers
--   com o parametro, NULO           18,9 ms   1.184 buffers  <- identico
--   com o parametro, 'OFF RACER'    16,8 ms   1.371 buffers
--
-- Com nulo o `or` curto-circuita e o subplano **some do plano**: a tela sem
-- filtro nao paga nada pelo filtro novo. Com filtro fica ate mais rapido (menos
-- grupos para agregar), pagando 187 buffers do `skus_supplier_brand_idx`, que
-- ja existia.
--
-- ------------------------------------------------------------
-- 4. O QUE NAO MUDOU, DE PROPOSITO
-- ------------------------------------------------------------
-- `latest_full` continua sem o filtro de marca: ela entra por `left join` sobre
-- `ranked`, que ja esta escopado, entao filtrar la seria um segundo lugar para
-- manter em sincronia sem mudar resposta.
--
-- ------------------------------------------------------------
-- 5. POR QUE O PARAMETRO E O ULTIMO, CONTRA A CONVENCAO
-- ------------------------------------------------------------
-- A convencao da casa (D-226) e "filtros primeiro, paginacao por ultimo", e
-- foi o que eu fiz na primeira versao: `p_supplier_brand` entre
-- `p_only_without_full` e `p_limit`. **A suite reprovou, e o motivo nao estava
-- em TypeScript nenhum.**
--
-- `get_sku_abc_curve` tem DOIS chamadores dentro do proprio banco --
-- `get_purchase_suggestions` e `get_sku_curation` --, e os dois chamam
-- posicionalmente com 8 argumentos. Trocar a assinatura no meio quebrou os
-- dois de uma vez (6 testes vermelhos), e o Postgres reportou o erro citando
-- `get_sku_abc_curve` dentro de um teste que chamava `get_purchase_suggestions`
-- -- levou tempo ate a busca sair do `apps/web` e ir para o `pg_proc`.
--
-- Com o parametro no FIM, uma chamada de 8 argumentos continua casando com a
-- funcao de 9, porque o nono tem default. **Blast radius zero:** nenhuma das
-- duas funcoes precisou ser recriada dentro de uma fatia que e sobre filtro de
-- tela. Recriar duas funcoes grandes so para preservar a ordem dos argumentos
-- trocaria uma convencao de leitura por risco em codigo que esta fatia nao
-- testa.
--
-- Nao ha normalizacao de entrada (`upper(btrim(...))`): as outras quatro RPCs
-- comparam direto, e os valores chegam de `get_supplier_brands`, que devolve
-- exatamente o que esta gravado. Normalizar so aqui criaria a divergencia que
-- este arquivo inteiro existe para evitar.
-- ============================================================

drop function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer);

create function public.get_sku_abc_curve(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_criterion text default 'faturamento',
  p_only_without_full boolean default false,
  p_limit integer default 200,
  p_offset integer default 0,
  -- ULTIMO de proposito, contra a convencao da casa. Ver secao 5 do cabecalho.
  p_supplier_brand text default null
)
returns table (
  sku_id uuid, sku text, title text, metric_value numeric, metric_share numeric,
  cumulative_share numeric, abc_class text, full_quantity numeric,
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with base as (
    select m.sku_id,
      case p_criterion
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos'  then sum(m.orders_count)::numeric
        else sum(m.gross_revenue)
      end as metric_value
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
      -- Escopo na PONTA 1: quais SKUs entram na curva.
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      -- Marca no MESMO lugar da conta (ver secao 2 do cabecalho): a curva e
      -- recalculada DENTRO da marca, nao a fatia da marca na curva global.
      and (p_supplier_brand is null
           or exists (
                select 1 from public.skus sk
                where sk.id = m.sku_id and sk.supplier_brand = p_supplier_brand))
    group by m.sku_id
    having case p_criterion
             when 'unidades' then sum(m.units_sold)::numeric
             when 'pedidos'  then sum(m.orders_count)::numeric
             else sum(m.gross_revenue)
           end > 0
  ),
  -- Escopo na PONTA 2: o denominador sai do MESMO conjunto escopado.
  total as (select sum(metric_value) as total_value from base),
  ranked as (
    select b.sku_id, b.metric_value,
      round(b.metric_value / nullif(t.total_value,0) * 100, 2) as metric_share,
      round(sum(b.metric_value) over w / nullif(t.total_value,0) * 100, 2) as cumulative_share,
      round((sum(b.metric_value) over w - b.metric_value) / nullif(t.total_value,0) * 100, 2)
        as cumulative_share_before
    from base b cross join total t
    window w as (order by b.metric_value desc, b.sku_id)
  ),
  latest_full as (
    -- GRAO CORRIGIDO em D-173: um saldo por BUCKET (`inventory_id`), nao por
    -- (sku, conta). O colapso anterior descartava as variacoes: 12 SKUs
    -- apareciam como "sem Full" tendo Full, e o total ficava 15,6% menor.
    -- Janela de frescor igual a da Central Full: saldo nao recapturado ha 3
    -- dias nao e estoque atual.
    select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_by_sku as (select sku_id, sum(quantity) as full_quantity from latest_full group by sku_id),
  classificada as (
    select r.sku_id, sk.sku, sk.title, r.metric_value, r.metric_share, r.cumulative_share,
      case when r.cumulative_share_before < 80 then 'A'
           when r.cumulative_share_before < 95 then 'B'
           else 'C' end as abc_class,
      coalesce(fb.full_quantity, 0) as full_quantity
    from ranked r
    join public.skus sk on sk.id = r.sku_id
    left join full_by_sku fb on fb.sku_id = r.sku_id
  ),
  filtrada as (
    select * from classificada
    where not p_only_without_full or full_quantity = 0
  )
  select f.sku_id, f.sku, f.title, f.metric_value, f.metric_share, f.cumulative_share,
         f.abc_class, f.full_quantity,
         count(*) over ()                                as total_count,
         count(*) filter (where f.abc_class='A') over () as class_a_count,
         count(*) filter (where f.abc_class='B') over () as class_b_count,
         count(*) filter (where f.abc_class='C') over () as class_c_count
  from filtrada f
  order by f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text) is
  'Curva ABC de SKUs (D-166; p_supplier_brand desde D-235). O escopo entra na `base` -- conta E marca --, entao o denominador e as classes A/B/C sao recalculados DENTRO do recorte: filtrar por marca da a curva ABC daquela marca, nao a fatia dela na curva global. Marca e `skus.supplier_brand`, nunca `skus.brand`: esta guarda a CATEGORIA do UpSeller (D-129) e diverge da marca real em 2.320 dos 3.554 SKUs. O filtro entra por `exists` e nao por join novo: com o parametro nulo o plano fica identico ao de antes (1.184 buffers, medido). security invoker.';

revoke all on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text) from public, anon;
grant execute on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text) to authenticated, service_role;
