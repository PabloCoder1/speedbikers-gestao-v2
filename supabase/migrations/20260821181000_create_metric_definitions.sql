-- ============================================================
-- metric_definitions — catálogo canônico de métricas (D-023/D-050).
--
-- Tabela de metadados global: não carrega organization_id porque a definição
-- de uma métrica é idêntica para todas as organizações. É o espelho
-- executável de docs/METRICS.md; alterações acontecem por migration, nunca
-- pela aplicação em runtime.
-- ============================================================

create table public.metric_definitions (
  id text primary key
    check (id ~ '^[a-z][a-z0-9_]*$'),
  name text not null
    check (btrim(name) <> ''),
  formula text not null
    check (btrim(formula) <> ''),
  source text not null
    check (btrim(source) <> ''),
  granularities text[] not null
    check (
      cardinality(granularities) > 0
      and granularities <@ array['listing', 'sku', 'account', 'organization']::text[]
    ),
  inclusions text not null
    check (btrim(inclusions) <> ''),
  exclusions text not null
    check (btrim(exclusions) <> ''),
  cancellation_treatment text not null
    check (cancellation_treatment in ('included', 'excluded', 'reversed')),
  timezone text not null
    check (timezone = 'America/Sao_Paulo'),
  definition_updated_on date not null
);

comment on table public.metric_definitions is
  'Espelho de docs/METRICS.md. Metadado global e alterável somente por migration.';

comment on column public.metric_definitions.granularities is
  'Grãos nos quais a métrica pode ser calculada diretamente; medidas distintas nunca são somadas de um grão inferior.';

insert into public.metric_definitions (
  id,
  name,
  formula,
  source,
  granularities,
  inclusions,
  exclusions,
  cancellation_treatment,
  timezone,
  definition_updated_on
)
values
  (
    'unidades_vendidas',
    'Unidades vendidas',
    'SUM(order_items.quantity)',
    'orders.status, orders.date_created, order_items.quantity e dimensões congeladas de order_items',
    array['listing', 'sku', 'account', 'organization'],
    'Pedidos com status paid ou partially_refunded; usa a data civil de orders.date_created.',
    'Todos os demais status e devoluções, cuja fonte ainda não está integrada.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  ),
  (
    'receita_bruta',
    'Receita bruta',
    'SUM(orders.total_amount)',
    'orders.status, orders.date_created e orders.total_amount; uma linha de item por pedido no contrato atual do Mercado Livre',
    array['listing', 'sku', 'account', 'organization'],
    'Pedidos com status paid ou partially_refunded; parcialmente reembolsados permanecem pelo total bruto.',
    'Todos os demais status; taxas, frete, custo, devoluções e estornos financeiros.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  ),
  (
    'pedidos',
    'Pedidos do Mercado Livre',
    'COUNT(DISTINCT orders.id)',
    'orders.id, orders.status e orders.date_created',
    array['listing', 'sku', 'account', 'organization'],
    'Pedidos com status paid ou partially_refunded; cada order_id conta uma vez.',
    'Todos os demais status e qualquer tentativa de tratar pack_id como pedido.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  ),
  (
    'pedidos_por_pack',
    'Compras por pack',
    'COUNT(DISTINCT CASE WHEN orders.pack_id IS NULL THEN ''order:'' || orders.id::text ELSE ''pack:'' || orders.pack_id::text END)',
    'orders.id, orders.pack_id, orders.status e orders.date_created',
    array['listing', 'sku', 'account', 'organization'],
    'Pedidos com status paid ou partially_refunded; pack_id identifica a compra e order_id é o fallback quando não há pack.',
    'Todos os demais status; a contagem distinta é calculada diretamente no grão solicitado e nunca somada de um rollup inferior.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  ),
  (
    'ticket_medio',
    'Ticket médio',
    'receita_bruta / NULLIF(pedidos_por_pack, 0)',
    'Componentes canônicos receita_bruta e pedidos_por_pack, derivados de orders',
    array['listing', 'sku', 'account', 'organization'],
    'Mesmos pedidos válidos de receita_bruta e pedidos_por_pack.',
    'Todos os demais status; média de médias de grãos inferiores.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  ),
  (
    'preco_medio_praticado',
    'Preço médio praticado',
    'receita_bruta / NULLIF(unidades_vendidas, 0)',
    'Componentes canônicos receita_bruta e unidades_vendidas, derivados de orders e order_items',
    array['listing', 'sku', 'account', 'organization'],
    'Mesmos pedidos válidos de receita_bruta e unidades_vendidas.',
    'Todos os demais status; média simples de preços e média de médias de grãos inferiores.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-21'
  );

-- Catálogo legível por qualquer usuário autenticado que pertença a uma
-- organização. Não há policy using(true), e usuário sem vínculo recebe zero
-- linhas. Escrita não é concedida nem à service_role: mudanças são migrations.
alter table public.metric_definitions enable row level security;

create policy metric_definitions_select_members
  on public.metric_definitions for select to authenticated
  using ((select private.current_org_id()) is not null);

revoke all on public.metric_definitions from anon, authenticated, service_role;
grant select on public.metric_definitions to authenticated, service_role;
