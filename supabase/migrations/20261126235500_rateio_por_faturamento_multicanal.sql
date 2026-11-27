-- Central de Inteligência Financeira: o rateio por faturamento passa a pesar a Shopee.
--
-- `get_faturamento_por_conta` (20261126234000) só lê `daily_account_metrics`, que
-- é do Mercado Livre. Na prévia do rateio de `/central/custos`, toda loja da
-- Shopee entrava com peso zero e recebia R$ 0,00 da despesa compartilhada,
-- mesmo vendendo. Só havia rateio por igual quando nenhuma conta do ML tinha
-- faturamento.
--
-- Esta função devolve o faturamento bruto das DUAS origens, por conta e por loja,
-- na régua da métrica aprovada `multicanal_receita_bruta` (METRICS §5):
--   * Mercado Livre: `receita_bruta` de `daily_account_metrics`, como em
--     `get_faturamento_por_conta`;
--   * Shopee: `shopee_receita_bruta` de receita conhecida, com o mesmo recorte do
--     bloco `vendas` de `get_shopee_faturamento_pedidos` (5U): pedido `VALIDA`,
--     criado no intervalo pelo dia de São Paulo, loja live já lida. O pedido de
--     receita desconhecida fica fora, porque não vira zero.
--
-- Lê `shopee_sales_orders` direto, e não pela função por pedido: o peso precisa
-- só da receita, e aquela função calcula o custo item a item.
--
-- `get_faturamento_por_conta` fica como está. A web lê esta função, e enquanto
-- ela não existe cai na antiga.
--
-- SECURITY INVOKER: valem a RLS de `daily_account_metrics` (por conta) e a de
-- `shopee_sales_orders`, então quem não é da organização lê vazio.

create or replace function public.get_faturamento_por_conta_multicanal(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns table (
  marketplace text,
  conta_id uuid,
  receita_bruta numeric
)
language sql
stable
set search_path to ''
as $function$
  select 'MERCADO_LIVRE'::text, m.ml_account_id, round(sum(m.gross_revenue), 2)
  from public.daily_account_metrics m
  where m.organization_id = p_organization_id
    and m.metric_date between p_from and p_to
    and m.gross_revenue is not null
  group by m.ml_account_id

  union all

  select 'SHOPEE'::text, v.shopee_shop_id, round(sum(v.receita_bruta), 2)
  from public.shopee_sales_orders v
  join public.shopee_shops s
    on s.id = v.shopee_shop_id
   and s.organization_id = p_organization_id
  where v.organization_id = p_organization_id
    and s.environment = 'live'
    and s.orders_last_success_at is not null
    and v.situacao = 'VALIDA'
    and v.receita_bruta is not null
    and v.shopee_created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
    and v.shopee_created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  group by v.shopee_shop_id;
$function$;

comment on function public.get_faturamento_por_conta_multicanal(uuid, date, date) is
  'Faturamento bruto por conta do Mercado Livre e por loja da Shopee no intervalo (multicanal_receita_bruta: receita_bruta do ML + shopee_receita_bruta de receita conhecida, pedido VALIDA, loja live lida), para o rateio ponderado das despesas compartilhadas em /central/custos. SECURITY INVOKER (RLS).';

revoke all on function public.get_faturamento_por_conta_multicanal(uuid, date, date) from public, anon;
grant execute on function public.get_faturamento_por_conta_multicanal(uuid, date, date) to authenticated, service_role;
