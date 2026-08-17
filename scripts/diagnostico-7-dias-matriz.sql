-- ============================================================
-- Matriz de reconciliação: descobre a fórmula EXATA do
-- "Vendas brutas / últimos 7 dias" do Mercado Livre.
--
-- Alvos (print da Central de Vendedores em 13/08/2026):
--   Vendas brutas:  R$ 263.566
--   Vendas:         2.583
--   Unidades:       2.643
--   Canceladas:     115
--
-- Rode cada bloco e me mande os resultados.
-- ============================================================

-- ------------------------------------------------------------
-- 1) MATRIZ 7 DIAS: 2 janelas x 3 regras de status.
--    A linha que bater com o alvo acima define a fórmula.
-- ------------------------------------------------------------
with base as (
  select
    o.id,
    o.status,
    o.pack_id,
    o.total_amount,
    (o.date_created at time zone 'America/Sao_Paulo')::date as dia
  from public.orders o
  join public.ml_accounts a on a.id = o.ml_account_id
  where a.code = 'speedbikers'
    and (o.date_created at time zone 'America/Sao_Paulo')::date >= date '2026-08-06'
),
items as (
  select
    oi.order_id,
    sum(oi.quantity)                                  as qty,
    sum(coalesce(oi.full_unit_price, 0) * oi.quantity) as rev_cheio
  from public.order_items oi
  where oi.is_current = true
  group by 1
)
select
  w.nome                                            as janela,
  r.nome                                            as regra,
  count(distinct b.id)                              as vendas,
  count(distinct coalesce(b.pack_id, b.id::text))   as vendas_agrupando_pack,
  sum(i.qty)                                        as unidades,
  round(sum(b.total_amount), 2)                     as receita_total_amount,
  round(sum(i.rev_cheio), 2)                        as receita_preco_cheio
from (values
  ('A: 06 a 12/08 (7 dias completos)', date '2026-08-06', date '2026-08-12'),
  ('B: 07 a 13/08 (inclui hoje)',      date '2026-08-07', date '2026-08-13')
) as w(nome, d1, d2)
cross join (values
  ('1: so paid'),
  ('2: todos os status'),
  ('3: paid + cancelled')
) as r(nome)
join base b
  on b.dia between w.d1 and w.d2
 and case r.nome
       when '1: so paid'          then b.status = 'paid'
       when '3: paid + cancelled' then b.status in ('paid', 'cancelled')
       else true
     end
left join items i on i.order_id = b.id
group by w.nome, r.nome
order by w.nome, r.nome;

-- ------------------------------------------------------------
-- 2) Quebra por status na janela 06-13/08
--    (compare "cancelled" com as 115 canceladas do print)
-- ------------------------------------------------------------
select
  o.status,
  count(*)                                          as pedidos,
  round(sum(o.total_amount), 2)                     as receita_total_amount
from public.orders o
join public.ml_accounts a on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-06' and '2026-08-13'
group by o.status
order by pedidos desc;

-- ------------------------------------------------------------
-- 3) MESES FECHADOS x regras de status.
--    Alvos oficiais (relatorio Evolucao do negocio):
--      Junho: 6.936 vendas / 7.051 un / R$ 742.090
--      Julho: 9.704 vendas / 9.952 un / R$ 1.015.474
--    Se "todos os status" bater, a semantica esta provada.
--    Se julho ficar abaixo em TODAS as regras, o backfill de
--    julho ainda esta incompleto (ver bloco 4).
-- ------------------------------------------------------------
with base as (
  select
    o.id,
    o.status,
    o.total_amount,
    date_trunc('month', o.date_created at time zone 'America/Sao_Paulo')::date as mes
  from public.orders o
  join public.ml_accounts a on a.id = o.ml_account_id
  where a.code = 'speedbikers'
    and (o.date_created at time zone 'America/Sao_Paulo')::date
        between '2026-06-01' and '2026-07-31'
),
items as (
  select
    oi.order_id,
    sum(oi.quantity)                              as qty
  from public.order_items oi
  where oi.is_current = true
  group by 1
)
select
  b.mes,
  r.nome                          as regra,
  count(distinct b.id)            as vendas,
  sum(i.qty)                      as unidades,
  round(sum(b.total_amount), 2)   as receita_total_amount
from base b
cross join (values
  ('1: so paid'),
  ('2: todos os status'),
  ('3: paid + cancelled')
) as r(nome)
left join items i on i.order_id = b.id
where case r.nome
        when '1: so paid'          then b.status = 'paid'
        when '3: paid + cancelled' then b.status in ('paid', 'cancelled')
        else true
      end
group by b.mes, r.nome
order by b.mes, r.nome;

-- ------------------------------------------------------------
-- 4) Ate onde o backfill ja chegou (se julho estiver
--    incompleto, aparece aqui)
-- ------------------------------------------------------------
select
  (min(o.date_created) at time zone 'America/Sao_Paulo')::date as pedido_mais_antigo,
  (max(o.date_created) at time zone 'America/Sao_Paulo')::date as pedido_mais_recente,
  count(*)                                                     as total_pedidos
from public.orders o
join public.ml_accounts a on a.id = o.ml_account_id
where a.code = 'speedbikers';

-- Pedidos por dia em julho (buracos no meio = backfill incompleto)
select
  (o.date_created at time zone 'America/Sao_Paulo')::date as dia,
  count(*) as pedidos
from public.orders o
join public.ml_accounts a on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-07-01' and '2026-07-31'
group by 1
order by 1;
