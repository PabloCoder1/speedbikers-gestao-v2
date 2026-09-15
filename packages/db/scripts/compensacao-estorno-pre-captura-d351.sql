-- D-351 F3 -- compensacao do que o worker antigo gravou (ou deixou de gravar) para vendas
-- que a planilha do UpSeller ja tinha descontado.
--
-- NAO E MIGRATION, de proposito. Precisa rodar DEPOIS do deploy do worker de D-351:
-- enquanto o worker antigo estiver no ar ele continua gravando VENDA_ML de pedido
-- antigo, e uma compensacao aplicada antes deixaria essas novas sem par. Como a
-- selecao e por regra, rodar de novo depois pega o que tiver sobrado (e idempotente).
-- Se virar migration, copie este corpo para um arquivo com instante valido.
--
-- PRE-REQUISITOS
--   1. migrations de D-351 aplicadas (o tipo ESTORNO_PRE_CAPTURA, o corte da exportacao
--      em `erp_stock_snapshots.captured_at` e a RPC das devolucoes). CONFERIDO no bloco,
--      nas organizacoes elegiveis: snapshot de planilha com o nome carimbado que ainda
--      carrega o PARSE como corte aborta tudo -- com o corte do parse (18:44:13 em
--      producao) a F3 estornaria venda legitima da janela entre exportacao e parse
--      (2000018457209778, fechada as 18:43:57). Isso tambem pega uma planilha importada
--      pelo worker ANTIGO entre a migration e o deploy, e por isso a conferencia vem ANTES
--      do deploy (DEPLOYMENT.md 8.2, passo 10): o worker NOVO le o mesmo corte, e com o do
--      parse grava VENDA_ML + ESTORNO_PRE_CAPTURA para venda da janela entre exportacao e
--      parse que a planilha nao tem. Refazer o UPDATE depois nao desfaz esses pares: com
--      occurred_at depois do corte corrigido, eles somam zero no alvo, que fica 1 acima por
--      unidade, ate a planilha seguinte -- a menos que o dono aceite, cada par precisa de
--      contrapartida manual. Nao importe planilha entre a migration e o deploy;
--   2. worker de D-351 servindo trafego;
--   3. `v3-reconcile-balances` AINDA pausado -- a organizacao com AJUSTE_RECONCILIACAO
--      nao e compensada (abaixo).
--
-- A CHAVE e NEUTRA: `estorno:<chave do movimento estornado>`, a mesma do worker
-- (`estornoKeyOf` em `@sb/domain`). O tipo diz a causa, a chave diz o movimento: um
-- segundo estorno do mesmo movimento, de qualquer produtor, cai no UNIQUE.
--
-- PARTE 1 -- VENDA_ML gravado sem par (a regra do worker, `@sb/domain/inventory`):
--   afetado = VENDA_ML de pedido cuja "venda em" (`date_closed ?? date_created`) e <= o
--             corte do SKU (o `max(captured_at)` do SKU; sem snapshot proprio, o da
--             organizacao) e que ainda nao tem `estorno:<chave>`.
--   EXCETO a venda cujo CANCELAMENTO_ML aconteceu ate o corte: a planilha ja tinha a
--             unidade de volta, e o par venda/cancelamento ja soma zero.
--   estorno  = ESTORNO_PRE_CAPTURA com quantidade oposta e `occurred_at` ESPELHADO do
--             VENDA_ML -- o par soma zero no saldo E no alvo de
--             `compute_erp_target_balances` (as duas linhas ficam do mesmo lado do corte).
--             `created_by` nulo: linha de sistema.
--   CANCELAMENTO_ML e DEVOLUCAO_ML nao sao compensados: aconteceram depois da planilha e
--             sao verdade nossa (resposta do dono: o UpSeller devolve a unidade sozinho).
--   LIMITADO pelo excesso do legado (verificacao de e6fda07, ALTA-1): uma unidade vendida
--             volta ao estoque no maximo uma vez, mas antes do limite das reversoes o worker
--             gravava cancelamento E devolucao da mesma venda. O que passou da quantidade
--             vendida ja anulou a venda, e o estorno e a venda menos esse excesso -- zero, e
--             nenhuma linha, nos 2 pedidos de producao com VENDA + DEVOLUCAO + CANCELAMENTO
--             (2000018212899604 e 2000018206306064), que ficam em +1 no saldo e no alvo.
--   Aqui NAO entra o "gravada antes de o corte chegar" do worker: so a organizacao que
--   nunca reconciliou e elegivel, e nela o saldo ainda nao foi alinhado a planilha nenhuma.
--
-- PARTE 2 -- a venda que o worker antigo NUNCA gravou (revisao de D-351, ALTA-2):
--   pedido hoje cancelado, com item vinculado (`order_items.sku_id`), `date_closed` <= o
--   corte, sem NENHUM VENDA_ML do pedido (por origem, nao pela chave de hoje: verificacao
--   de e6fda07, MEDIA-1), e com um `order.cancelled` de `before.status` venda valida
--   (`paid`/`partially_refunded`) cujo `occurred_at` e POSTERIOR ao corte. A planilha tem
--   a venda descontada e o UpSeller devolveu a unidade depois dela: o real e snapshot +1.
--   Grava o trio que o worker novo grava (`computeCancellationMovements`): VENDA_ML e
--   ESTORNO_PRE_CAPTURA com `occurred_at` = `date_closed`, e CANCELAMENTO_ML com
--   `occurred_at` = o do evento. KIT decompoe pelos componentes de hoje, como o worker.
--   Sem a transicao observada (`before.status` nulo: o backfill trouxe ja cancelado) nao
--   mexe -- esse cancelamento pode ser anterior a planilha. Medido em producao em
--   2026-09-15 (so SELECT, esta selecao com o corte 18:42:00): 20 pedidos, 20 movimentos
--   (um deles componente de KIT), 21 unidades, eventos de 09-14 18:47:13 a 09-15 05:46:27.
--
-- QUAIS ORGANIZACOES. So a que "nasceu no import": tem snapshot, NENHUM
-- AJUSTE_RECONCILIACAO, e o primeiro movimento do ledger e posterior a (corte - 1 h).
-- Em producao (2026-09-14): primeiro VENDA_ML as 18:43:59, corte 18:42:00, zero ajustes.
-- No Dev (ledger de 08-21 com reconciliacoes) e na CI vazia: nao faz nada. Organizacao
-- com afetados que fica de fora sai em NOTICE -- nunca some em silencio. Se alguem
-- despausar a reconciliacao antes, a organizacao deixa de ser elegivel: rode a PROVA 1.
--
-- COMO RODAR: por psql, como postgres -- o SQL Editor do Supabase nao mostra os NOTICE, e
-- sao eles que dizem quantos estornos e reposicoes entraram e que organizacao ficou de fora
-- (`psql "$URL" -v ON_ERROR_STOP=1 -f compensacao-estorno-pre-captura-d351.sql`). O bloco e
-- atomico e termina com asserções que abortam tudo se falharem. Para restringir a UMA
-- organizacao (e o que o teste de integracao faz):
--     begin;
--     set local sb.compensacao_organizacao = '<uuid>';
--     <este arquivo>
--     commit;
--
-- COMO FOI PROVADO: `packages/db/src/estoque-pre-captura.integration.test.ts`, bloco
-- "compensacao F3", contra Postgres real -- compensa so o que deve, espelha a data, repoe
-- a venda nunca gravada (PRODUTO e KIT) so com a transicao observada depois do corte, o
-- alvo fecha em snapshot + legitimos + reposicoes, a segunda execucao grava 0, a
-- organizacao reconciliada nao e tocada, e o corte do parse aborta.

create or replace temp view d351_organizacoes as
select g.organization_id,
       g.captured_at as corte_da_organizacao,
       not exists (
         select 1
         from public.stock_movements a
         where a.organization_id = g.organization_id
           and a.movement_type = 'AJUSTE_RECONCILIACAO'
       )
       and coalesce(
         (select min(m.created_at) from public.stock_movements m where m.organization_id = g.organization_id),
         'infinity'::timestamptz
       ) > g.captured_at - interval '1 hour' as elegivel
from (
  select s.organization_id, max(s.captured_at) as captured_at
  from public.erp_stock_snapshots s
  group by s.organization_id
) g
where nullif(current_setting('sb.compensacao_organizacao', true), '') is null
   or g.organization_id::text = current_setting('sb.compensacao_organizacao', true);

-- O corte proprio de cada SKU: o `max(captured_at)`, como `get_erp_stock_cutoffs`.
create or replace temp view d351_cortes as
select s.organization_id, s.sku_id, max(s.captured_at) as captured_at
from public.erp_stock_snapshots s
where s.sku_id is not null
group by s.organization_id, s.sku_id;

create or replace temp view d351_afetados as
select m.organization_id,
       m.sku_id,
       m.location_kind,
       m.qty_delta,
       m.source_type,
       m.source_id,
       m.idempotency_key,
       m.occurred_at,
       coalesce(k.captured_at, g.corte_da_organizacao) as corte,
       coalesce(o.date_closed, o.date_created) as venda_em,
       g.elegivel,
       -- A quantidade do estorno: a venda menos o que o legado reverteu ALEM dela
       -- (`excessReversed` em `@sb/domain`, verificacao de e6fda07, ALTA-1).
       abs(m.qty_delta) - greatest(0, rv.revertido - abs(m.qty_delta)) as quantidade
from public.stock_movements m
join d351_organizacoes g on g.organization_id = m.organization_id
left join d351_cortes k on k.organization_id = m.organization_id and k.sku_id = m.sku_id
join public.orders o
  on o.organization_id = m.organization_id
 -- `source_id` e texto; o CASE impede o cast de uma origem que nao seja numero.
 and o.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
-- O que ja foi revertido desta venda, pelas duas causas: o cancelamento (origem do pedido,
-- chave `cancelamento:<venda>`) e as devolucoes (origem do claim, pedido DENTRO da chave
-- `devolucao:<claim>:<venda>` -- o indice de `20260914200400` atende o `split_part`).
cross join lateral (
  select coalesce((select sum(c.qty_delta)
                     from public.stock_movements c
                    where c.idempotency_key = 'cancelamento:' || m.idempotency_key
                      and c.movement_type = 'CANCELAMENTO_ML'), 0)
       + coalesce((select sum(d.qty_delta)
                     from public.stock_movements d
                    where d.organization_id = m.organization_id
                      and d.movement_type = 'DEVOLUCAO_ML'
                      and split_part(d.idempotency_key, ':', 4) = m.source_id
                      and regexp_replace(d.idempotency_key, '^devolucao:[^:]+:', '') = m.idempotency_key), 0)
         as revertido
) rv
where m.movement_type = 'VENDA_ML'
  and m.source_type = 'ORDER'
  and coalesce(o.date_closed, o.date_created) <= coalesce(k.captured_at, g.corte_da_organizacao)
  -- Cancelamento E devolucao da mesma venda (o legado de D-052/D-057): o excesso ja anulou a
  -- venda, e o estorno inteiro levaria o pedido a +2 (2000018212899604 e 2000018206306064).
  and abs(m.qty_delta) - greatest(0, rv.revertido - abs(m.qty_delta)) > 0
  and not exists (
    select 1 from public.stock_movements e
    where e.idempotency_key = 'estorno:' || m.idempotency_key
  )
  and not exists (
    select 1 from public.stock_movements c
    where c.idempotency_key = 'cancelamento:' || m.idempotency_key
      and c.occurred_at <= coalesce(k.captured_at, g.corte_da_organizacao)
  );

create or replace temp view d351_reposicoes as
select r.*
from (
  select o.organization_id,
         coalesce(c.component_sku_id, i.sku_id) as sku_id,
         -(i.quantity * coalesce(c.quantity, 1)) as qty_delta,
         o.id::text as source_id,
         -- A MESMA chave do worker (`computeSaleDeductions`): KIT leva o componente.
         case when k.kind = 'KIT'
              then 'venda:' || o.id::text || ':' || i.position::text || ':' || c.component_sku_id::text
              else 'venda:' || o.id::text || ':' || i.position::text
         end as chave_venda,
         o.date_closed as venda_em,
         t.occurred_at as cancelado_em,
         coalesce(kc.captured_at, g.corte_da_organizacao) as corte,
         g.elegivel
  from public.orders o
  join d351_organizacoes g on g.organization_id = o.organization_id
  join lateral (
    select e.occurred_at
    from public.domain_events e
    where e.organization_id = o.organization_id
      and e.entity_type = 'order'
      and e.entity_id = o.id::text
      and e.event_type = 'order.cancelled'
      and e.before ->> 'status' in ('paid', 'partially_refunded')
    order by e.occurred_at desc
    limit 1
  ) t on true
  join public.order_items i on i.order_id = o.id and i.sku_id is not null
  join public.skus k on k.id = i.sku_id
  left join public.sku_components c on k.kind = 'KIT' and c.kit_sku_id = k.id
  left join d351_cortes kc
    on kc.organization_id = o.organization_id
   and kc.sku_id = coalesce(c.component_sku_id, i.sku_id)
  where o.status in ('cancelled', 'pending_cancel')
    and o.date_closed is not null
    -- KIT sem componente cadastrado nao deduz nada no worker; aqui tambem nao.
    and (k.kind <> 'KIT' or c.component_sku_id is not null)
) r
where r.venda_em <= r.corte
  and r.cancelado_em > r.corte
  -- NENHUM VENDA_ML do pedido, e nao "a chave de hoje nao foi gravada" (verificacao de
  -- e6fda07, MEDIA-1): a chave vem dos vinculos de HOJE, e com a composicao do KIT alterada,
  -- ou o PRODUTO virado KIT, a reposicao devolveria um SKU que nunca foi baixado.
  and not exists (
    select 1
    from public.stock_movements v
    where v.organization_id = r.organization_id
      and v.movement_type = 'VENDA_ML'
      and v.source_type = 'ORDER'
      and v.source_id = r.source_id
  );

do $$
declare
  v_corte_do_parse integer;
  v_gravados integer;
  v_vendas integer;
  v_estornos integer;
  v_cancelamentos integer;
  v_restantes integer;
  v_divergencias integer;
  r record;
begin
  -- PRE-REQUISITO 1, conferido: o corte ja e a exportacao nas organizacoes elegiveis. So
  -- nelas: a organizacao reconciliada fica com o corte do parse DE PROPOSITO (o UPDATE de
  -- 20260914200000 nao a toca, verificacao de e6fda07) e nao e compensada aqui.
  select count(*) into v_corte_do_parse
  from public.erp_stock_snapshots s
  join public.erp_import_batches b on b.id = s.batch_id
  join d351_organizacoes g on g.organization_id = s.organization_id and g.elegivel
  where b.kind = 'STOCK'
    and b.parsed_at is not null
    and s.captured_at = b.parsed_at
    and private.erp_stock_export_instant(b.file_name, b.parsed_at) <> b.parsed_at;

  if v_corte_do_parse > 0 then
    raise exception 'compensacao_d351: % snapshots ainda com o corte do PARSE, e nao o da exportacao -- rode de novo o UPDATE de 20260914200000_erp_corte_da_exportacao antes da F3. Se o worker novo ja rodou com esse corte, os ESTORNO_PRE_CAPTURA com occurred_at entre a exportacao e o parse ficam sem contrapartida (cabecalho, PRE-REQUISITO 1)',
      v_corte_do_parse;
  end if;

  for r in
    select x.organization_id, sum(x.afetados) as afetados, sum(x.reposicoes) as reposicoes
    from (
      select a.organization_id, count(*) as afetados, 0 as reposicoes from d351_afetados a where not a.elegivel group by 1
      union all
      select p.organization_id, 0, count(*) from d351_reposicoes p where not p.elegivel group by 1
    ) x
    group by x.organization_id
  loop
    raise notice 'compensacao_d351: organizacao % fora do criterio (tem AJUSTE_RECONCILIACAO ou ledger anterior ao corte) com % VENDA_ML afetados e % vendas a repor -- NAO compensada',
      r.organization_id, r.afetados, r.reposicoes;
  end loop;

  -- PARTE 1.
  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select a.organization_id,
         a.sku_id,
         a.location_kind,
         -a.qty_delta,
         'ESTORNO_PRE_CAPTURA',
         a.source_type,
         a.source_id,
         'estorno:' || a.idempotency_key,
         a.occurred_at
  from d351_afetados a
  where a.elegivel
  on conflict (idempotency_key) do nothing;

  get diagnostics v_gravados = row_count;

  raise notice 'compensacao_d351: % estornos gravados', v_gravados;

  -- PARTE 2: o trio num comando so -- as tres insercoes leem a MESMA selecao.
  with a_repor as (
    select * from d351_reposicoes where elegivel
  ),
  vendas as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', p.qty_delta, 'VENDA_ML', 'ORDER', p.source_id, p.chave_venda, p.venda_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  ),
  estornos as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', -p.qty_delta, 'ESTORNO_PRE_CAPTURA', 'ORDER', p.source_id,
           'estorno:' || p.chave_venda, p.venda_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  ),
  cancelamentos as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', -p.qty_delta, 'CANCELAMENTO_ML', 'ORDER', p.source_id,
           'cancelamento:' || p.chave_venda, p.cancelado_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select (select count(*) from vendas), (select count(*) from estornos), (select count(*) from cancelamentos)
    into v_vendas, v_estornos, v_cancelamentos;

  -- Um trio pela metade seria +1 ou -1 no saldo: um estorno ou cancelamento ja existente
  -- sem a venda e estado que nenhum produtor gera, e aborta em vez de seguir.
  if v_estornos <> v_vendas or v_cancelamentos <> v_vendas then
    raise exception 'compensacao_d351: reposicao incompleta -- % vendas, % estornos, % cancelamentos',
      v_vendas, v_estornos, v_cancelamentos;
  end if;

  raise notice 'compensacao_d351: % vendas repostas (venda + estorno + cancelamento)', v_vendas;

  -- PROVA 1, dentro do bloco: nada afetado sem par e nada a repor nas organizacoes elegiveis.
  select (select count(*) from d351_afetados a where a.elegivel)
       + (select count(*) from d351_reposicoes p where p.elegivel)
    into v_restantes;

  if v_restantes > 0 then
    raise exception 'compensacao_d351: % VENDA_ML afetados ou vendas a repor continuam pendentes', v_restantes;
  end if;

  -- PROVA 2: o ledger bate com a projecao, por SKU e local, nas organizacoes elegiveis.
  select count(*) into v_divergencias
  from (
    select l.quantidade, b.quantity
    from (
      select m.organization_id, m.sku_id, m.location_kind, sum(m.qty_delta) as quantidade
      from public.stock_movements m
      join d351_organizacoes g on g.organization_id = m.organization_id and g.elegivel
      group by m.organization_id, m.sku_id, m.location_kind
    ) l
    full join (
      select b.organization_id, b.sku_id, b.location_kind, b.quantity
      from public.inventory_balances b
      join d351_organizacoes g on g.organization_id = b.organization_id and g.elegivel
    ) b using (organization_id, sku_id, location_kind)
    where coalesce(l.quantidade, 0) <> coalesce(b.quantity, 0)
  ) d;

  if v_divergencias > 0 then
    raise exception 'compensacao_d351: % divergencias entre ledger e inventory_balances', v_divergencias;
  end if;
end;
$$;

-- PROVAS DEPOIS DE APLICAR (separadas; rodar e ler):
--
-- 1. pendentes, TODAS as organizacoes (esperado 0 na de producao):
--      select organization_id, elegivel, count(*) from d351_afetados group by 1, 2;
--      select organization_id, elegivel, count(*) from d351_reposicoes group by 1, 2;
--    (as views sao temporarias: rode este arquivo e as consultas na mesma sessao, ou recrie
--    as views antes.)
-- 2. reexecutar este arquivo: NOTICE "0 estornos gravados" e "0 vendas repostas".
-- 3. repetir a prova 1 depois de 1 h e de 24 h.
