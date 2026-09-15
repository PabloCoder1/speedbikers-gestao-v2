-- D-351 F3 -- compensacao dos VENDA_ML gravados ANTES da guarda, de vendas que a
-- planilha do UpSeller ja tinha descontado.
--
-- NAO E MIGRATION, de proposito. Precisa rodar DEPOIS do deploy do worker de D-351:
-- enquanto o worker antigo estiver no ar ele continua gravando VENDA_ML de pedido
-- antigo, e uma compensacao aplicada antes deixaria essas novas sem par. Como a
-- selecao e por regra, rodar de novo depois pega o que tiver sobrado (e idempotente).
-- Se virar migration, copie este corpo para um arquivo com instante valido.
--
-- PRE-REQUISITOS
--   1. migrations de D-351 aplicadas (o tipo ESTORNO_PRE_CAPTURA e o corte da exportacao
--      em `erp_stock_snapshots.captured_at`);
--   2. worker de D-351 servindo trafego;
--   3. `v3-reconcile-balances` AINDA pausado -- a organizacao com AJUSTE_RECONCILIACAO
--      nao e compensada (abaixo).
--
-- A REGRA (a mesma do worker, `@sb/domain/inventory`):
--   afetado = VENDA_ML de pedido cuja "venda em" (`date_closed ?? date_created`) e <= o
--             corte do SKU (o `max(captured_at)` do SKU; sem snapshot proprio, o da
--             organizacao) e que ainda nao tem `estorno-pre-captura:<chave>`.
--   EXCETO a venda cujo CANCELAMENTO_ML aconteceu ate o corte: a planilha ja tinha a
--             unidade de volta, e o par venda/cancelamento ja soma zero.
--   estorno  = ESTORNO_PRE_CAPTURA com quantidade oposta e `occurred_at` ESPELHADO do
--             VENDA_ML -- o par soma zero no saldo E no alvo de
--             `compute_erp_target_balances` (as duas linhas ficam do mesmo lado do corte).
--             `created_by` nulo: linha de sistema.
--   CANCELAMENTO_ML e DEVOLUCAO_ML nao sao compensados: aconteceram depois da planilha e
--             sao verdade nossa (resposta do dono: o UpSeller devolve a unidade sozinho).
--
-- QUAIS ORGANIZACOES. So a que "nasceu no import": tem snapshot, NENHUM
-- AJUSTE_RECONCILIACAO, e o primeiro movimento do ledger e posterior a (corte - 1 h).
-- Em producao (2026-09-14): primeiro VENDA_ML as 18:43:59, corte 18:42:00, zero ajustes.
-- No Dev (ledger de 08-21 com reconciliacoes) e na CI vazia: nao faz nada. Organizacao
-- com afetados que fica de fora sai em NOTICE -- nunca some em silencio. Se alguem
-- despausar a reconciliacao antes, a organizacao deixa de ser elegivel: rode a PROVA 1.
--
-- COMO RODAR (SQL Editor ou psql, como postgres). O bloco e atomico e termina com
-- asserções que abortam tudo se falharem. Para restringir a UMA organizacao (e o que o
-- teste de integracao faz):
--     begin;
--     set local sb.compensacao_organizacao = '<uuid>';
--     <este arquivo>
--     commit;
--
-- COMO FOI PROVADO: `packages/db/src/estoque-pre-captura.integration.test.ts`, bloco
-- "compensacao F3", contra Postgres real -- compensa so o que deve, espelha a data,
-- o alvo fecha em snapshot + legitimos, a segunda execucao grava 0, e a organizacao
-- reconciliada nao e tocada.

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
       g.elegivel
from public.stock_movements m
join d351_organizacoes g on g.organization_id = m.organization_id
left join (
  select s.organization_id, s.sku_id, max(s.captured_at) as captured_at
  from public.erp_stock_snapshots s
  where s.sku_id is not null
  group by s.organization_id, s.sku_id
) k on k.organization_id = m.organization_id and k.sku_id = m.sku_id
join public.orders o
  on o.organization_id = m.organization_id
 -- `source_id` e texto; o CASE impede o cast de uma origem que nao seja numero.
 and o.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
where m.movement_type = 'VENDA_ML'
  and m.source_type = 'ORDER'
  and coalesce(o.date_closed, o.date_created) <= coalesce(k.captured_at, g.corte_da_organizacao)
  and not exists (
    select 1 from public.stock_movements e
    where e.idempotency_key = 'estorno-pre-captura:' || m.idempotency_key
  )
  and not exists (
    select 1 from public.stock_movements c
    where c.idempotency_key = 'cancelamento:' || m.idempotency_key
      and c.occurred_at <= coalesce(k.captured_at, g.corte_da_organizacao)
  );

do $$
declare
  v_gravados integer;
  v_restantes integer;
  v_divergencias integer;
  r record;
begin
  for r in
    select a.organization_id, count(*) as afetados
    from d351_afetados a
    where not a.elegivel
    group by a.organization_id
  loop
    raise notice 'compensacao_d351: organizacao % fora do criterio (tem AJUSTE_RECONCILIACAO ou ledger anterior ao corte) com % VENDA_ML afetados -- NAO compensada',
      r.organization_id, r.afetados;
  end loop;

  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select a.organization_id,
         a.sku_id,
         a.location_kind,
         -a.qty_delta,
         'ESTORNO_PRE_CAPTURA',
         a.source_type,
         a.source_id,
         'estorno-pre-captura:' || a.idempotency_key,
         a.occurred_at
  from d351_afetados a
  where a.elegivel
  on conflict (idempotency_key) do nothing;

  get diagnostics v_gravados = row_count;

  raise notice 'compensacao_d351: % estornos gravados', v_gravados;

  -- PROVA 1, dentro do bloco: nenhuma venda afetada sem par nas organizacoes elegiveis.
  select count(*) into v_restantes from d351_afetados a where a.elegivel;

  if v_restantes > 0 then
    raise exception 'compensacao_d351: % VENDA_ML afetados continuam sem estorno', v_restantes;
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
-- 1. afetados sem par, TODAS as organizacoes (esperado 0 na de producao):
--      select organization_id, elegivel, count(*) from d351_afetados group by 1, 2;
--    (as views sao temporarias: rode este arquivo e a consulta na mesma sessao, ou recrie as
--    duas views antes.)
-- 2. reexecutar este arquivo: NOTICE "0 estornos gravados".
-- 3. repetir a prova 1 depois de 1 h e de 24 h.
