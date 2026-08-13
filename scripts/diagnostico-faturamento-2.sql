-- ============================================================
-- Diagnóstico 2: por que "todos os status" deu R$253.239,50
-- (65% acima do benchmark oficial R$154.502,98 / 1.445 vendas)
-- ============================================================

-- A) Quebra por status — o mais importante agora.
--    Mostra quantos pedidos/unidades/receita cada status representa
--    na semana 04/08 a 10/08/2026, conta SpeedBikers.
select
  o.status,
  count(distinct o.id)                                     as pedidos,
  sum(oi.quantity)                                          as unidades,
  sum(coalesce(oi.unit_price, 0) * oi.quantity)              as receita_bruta
from public.orders o
join public.order_items oi
  on oi.order_id = o.id
 and oi.is_current = true
join public.ml_accounts a
  on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-04' and '2026-08-10'
group by o.status
order by receita_bruta desc;

-- B) Só "paid" — pra comparar direto com o benchmark
--    (ML: 1.445 vendas / 1.460 unidades / R$ 154.502,98)
select
  count(distinct o.id)                                     as pedidos_paid,
  sum(oi.quantity)                                          as unidades_paid,
  sum(coalesce(oi.unit_price, 0) * oi.quantity)              as receita_paid
from public.orders o
join public.order_items oi
  on oi.order_id = o.id
 and oi.is_current = true
join public.ml_accounts a
  on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and o.status = 'paid'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-04' and '2026-08-10';

-- C) Existem itens duplicados marcados como "is_current = true"
--    na mesma linha de pedido? (bug de sincronização que dobraria receita)
select
  order_id,
  line_key,
  count(*) as versoes_current
from public.order_items
where is_current = true
group by order_id, line_key
having count(*) > 1
limit 50;

-- D) Pedidos "pack" (mesma pack_id, múltiplos orders) dentro da semana —
--    ML pode contar isso como 1 "venda", nós como N pedidos.
select
  o.pack_id,
  count(distinct o.id) as pedidos_no_pack
from public.orders o
join public.ml_accounts a
  on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and o.pack_id is not null
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-04' and '2026-08-10'
group by o.pack_id
having count(distinct o.id) > 1
order by pedidos_no_pack desc
limit 20;
