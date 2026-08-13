-- ============================================================
-- Diagnóstico 3: comparação mês a mês com o relatório oficial
-- "Evolução do negócio" (SpeedBikers, 13/05/2026 a 13/08/2026)
--
-- Referência oficial (ML):
--   Maio:   8.724 vendas / 8.923 unidades  / R$  978.001,00
--   Junho:  6.936 vendas / 7.051 unidades  / R$  742.090,00
--   Julho:  9.704 vendas / 9.952 unidades  / R$ 1.015.474,00
--   Agosto: 170 vendas   / 177 unidades    / R$   17.753,40  (só até dia 13)
-- ============================================================

select
  date_trunc('month', o.date_created at time zone 'America/Sao_Paulo')::date as mes,
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
      between '2026-05-13' and '2026-08-13'
group by 1, 2
order by 1, receita_bruta desc;

-- Totais por mês, todos os status juntos (pra ver o tamanho total antes de filtrar)
select
  date_trunc('month', o.date_created at time zone 'America/Sao_Paulo')::date as mes,
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
      between '2026-05-13' and '2026-08-13'
group by 1
order by 1;

-- Confirma a identidade da conta 'speedbikers' no banco agora
-- (seller_id deve ser 118570204 / nickname SPEEDBIKERSLOJA)
select code, oauth_app_code, seller_id, expected_seller_id, nickname, connection_status, is_active
from public.ml_accounts
where code = 'speedbikers';
