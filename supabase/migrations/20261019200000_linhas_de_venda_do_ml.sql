-- D-499 — As linhas de venda do Mercado Livre numa tabela estreita, mantida
-- por gatilhos, para o faturamento somar sem buscar pedido e item um a um.
--
-- Medido em produção em 19/10/2026 (`docs/PERFORMANCE.md`): o
-- `get_faturamento` de 90 dias com detalhe toca ~390 mil páginas -- cada
-- pedido numa página de `orders` e cada item mais quatro em `order_items` --
-- e leva ~1,9 s com cache quente e 7,4 s frio, perto do `statement_timeout`
-- de 8 s numa instância de ~1 GB de RAM. Às 14:20 UTC de 19/10 a `/central`
-- teve chamadas canceladas por isso.
--
-- É o mesmo problema que a D-409 resolveu para o detector de frete
-- (`shipping_sales`), com a mesma forma: UMA linha por item de pedido pago ou
-- parcialmente reembolsado, com o que o faturamento lê do pedido, do item e
-- do frete. ~150 bytes por linha: os 90 dias cabem em poucos milhares de
-- páginas lidas em sequência.
--
-- GATILHOS, NÃO ROTINA. Cada mudança que muda o que o faturamento soma (o
-- status, a data, o pacote, o SKU vinculado, a quantidade, o preço, a
-- comissão, o frete rateado, o desconto) recalcula as linhas daquele pedido
-- pela regra das CTEs `pedidos` e `linhas` do `get_faturamento`. A soma vê o
-- mesmo que veria lendo as três tabelas, no mesmo instante.
--
-- O custo do produto continua calculado na leitura (D-356): o custo atual
-- pode mudar, e congelá-lo aqui faria o faturamento divergir do cadastro.
--
-- ESTA MIGRATION SÓ CRIA E PREENCHE. O `get_faturamento` passa a ler a
-- tabela na migration seguinte, depois de a equivalência ser conferida em
-- produção (a tabela contra as três de origem e a saída nova contra a de
-- hoje). Nenhum contrato muda aqui.
--
-- A JANELA DE ESPERA DO WORKER. `create trigger` trava `orders`,
-- `order_items` e `order_financials` contra gravação (SHARE ROW EXCLUSIVE)
-- até o fim da migration; as leituras -- as telas -- continuam. Por isso a
-- ordem: a tabela, as funções e a RLS antes, sem travar nada; uma leitura de
-- aquecimento das três tabelas, também antes; e só então os gatilhos, a
-- carga, a chave, os índices e a FK, que juntos são a janela. A chave e os
-- índices construídos depois da carga, e a FK validada numa passada, custam
-- metade da carga numa tabela já indexada (medido no banco local). Gravação
-- do worker que esperar mais que o `lock_timeout` de 8 s falha e o Cloud
-- Tasks repete.

create table public.ml_sales_lines (
  line_id uuid not null,
  order_id bigint not null,
  organization_id uuid not null,
  ml_account_id uuid not null,
  date_created timestamptz not null,
  pack_id bigint,
  sku_id uuid,
  quantity integer not null,
  unit_price numeric not null,
  sale_fee numeric,
  shipping_share numeric,
  seller_discount numeric
);

alter table public.ml_sales_lines enable row level security;

-- O mesmo alcance de `orders`: quem alcança a CONTA lê (forma de conjunto,
-- D-181). Ninguém grava direto: só os gatilhos abaixo.
create policy ml_sales_lines_select_permitted
  on public.ml_sales_lines for select to authenticated
  using (ml_account_id in (select private.accessible_accounts()));

revoke all on public.ml_sales_lines from anon, authenticated, service_role;
grant select on public.ml_sales_lines to authenticated;
grant select on public.ml_sales_lines to service_role;

comment on table public.ml_sales_lines is
  'Linhas de venda do Mercado Livre que o faturamento soma (D-499): uma por item de pedido pago ou parcialmente reembolsado, com a data, a conta e o pacote do pedido, o SKU, a quantidade, o preco e a comissao do item, e o frete rateado (seller_shipping_share) e o desconto do vendedor do pedido. Mantida por gatilhos em orders, order_items e order_financials; so leitura para todos. O custo do produto nao fica aqui: e calculado na leitura.';
comment on column public.ml_sales_lines.line_id is 'order_items.id.';
comment on column public.ml_sales_lines.shipping_share is
  'order_financials.seller_shipping_share do pedido, repetido em cada linha dele. NULL sem frete capturado.';
comment on column public.ml_sales_lines.seller_discount is
  'order_financials.seller_discount do pedido, repetido em cada linha dele.';

-- As linhas de UM pedido, pela regra das CTEs `pedidos` e `linhas` do
-- `get_faturamento` (20260925160000): o pedido pago ou parcialmente
-- reembolsado, os itens da mesma organização e da mesma conta. Apaga e
-- regrava: pedido fora da regra fica sem linha.
create or replace function private.sync_ml_sales_lines(p_order_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ml_sales_lines where order_id = p_order_id;

  insert into public.ml_sales_lines
    (line_id, order_id, organization_id, ml_account_id, date_created, pack_id, sku_id,
     quantity, unit_price, sale_fee, shipping_share, seller_discount)
  select i.id, o.id, o.organization_id, o.ml_account_id, o.date_created, o.pack_id, i.sku_id,
         i.quantity, i.unit_price, i.sale_fee, f.seller_shipping_share, f.seller_discount
  from public.orders o
  join public.order_items i
    on i.order_id = o.id
   and i.organization_id = o.organization_id
   and i.ml_account_id = o.ml_account_id
  left join public.order_financials f on f.order_id = o.id
  where o.id = p_order_id
    and o.status in ('paid', 'partially_refunded');
end;
$$;

create or replace function private.ml_sales_lines_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'orders' then
    perform private.sync_ml_sales_lines(new.id);
  else
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.sync_ml_sales_lines(old.order_id);
    end if;

    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.order_id is distinct from old.order_id) then
      perform private.sync_ml_sales_lines(new.order_id);
    end if;
  end if;

  return null;
end;
$$;

-- Nada disto é chamável de fora: só os gatilhos.
revoke all on function private.sync_ml_sales_lines(bigint) from public, anon, authenticated, service_role;
revoke all on function private.ml_sales_lines_trigger() from public, anon, authenticated, service_role;

-- Aquece o cache com a leitura da carga, ainda sem travar nada: em produção
-- (19/10) essa leitura levou 4,1 s, quase toda do disco. A carga, já com as
-- gravações travadas, lê de novo -- da memória. O `work_mem` maior evita que
-- a junção por hash transborde para o disco (o padrão é 3,5 MB).
set local work_mem = '64MB';

select count(*), sum(f.seller_shipping_share), sum(i.unit_price)
from public.orders o
join public.order_items i
  on i.order_id = o.id
 and i.organization_id = o.organization_id
 and i.ml_account_id = o.ml_account_id
left join public.order_financials f on f.order_id = o.id
where o.status in ('paid', 'partially_refunded');

-- A PARTIR DAQUI, AS GRAVAÇÕES DO WORKER NAS TRÊS TABELAS ESPERAM.

-- O pedido: só quando muda o que a regra lê. O webhook regrava `orders` o
-- tempo todo com os mesmos valores, e isso não pode custar nada. Pedido novo
-- não tem item ainda: as linhas nascem com o item.
create trigger ml_sales_lines_from_orders
  after update on public.orders
  for each row
  when (
    old.status is distinct from new.status
    or old.date_created is distinct from new.date_created
    or old.organization_id is distinct from new.organization_id
    or old.ml_account_id is distinct from new.ml_account_id
    or old.pack_id is distinct from new.pack_id
  )
  execute function private.ml_sales_lines_trigger();

-- Os itens: linha nova ou apagada; na atualização, só o que a soma lê. O
-- worker regrava os itens por `upsert` em (order_id, position) com os mesmos
-- valores a cada webhook (D-189): sem mudança, nada dispara.
create trigger ml_sales_lines_from_items_insert_delete
  after insert or delete on public.order_items
  for each row execute function private.ml_sales_lines_trigger();

create trigger ml_sales_lines_from_items_update
  after update on public.order_items
  for each row
  when (
    old.order_id is distinct from new.order_id
    or old.organization_id is distinct from new.organization_id
    or old.ml_account_id is distinct from new.ml_account_id
    or old.sku_id is distinct from new.sku_id
    or old.quantity is distinct from new.quantity
    or old.unit_price is distinct from new.unit_price
    or old.sale_fee is distinct from new.sale_fee
  )
  execute function private.ml_sales_lines_trigger();

-- O frete e o desconto do pedido. O rateio do envio compartilhado (D-413)
-- regrava `seller_shipping_share` por UPDATE, e esse UPDATE também dispara:
-- a última passada vê a parte final. Pelo valor, não pela lista de colunas:
-- o `upsert` do worker cita todas a cada leitura do financeiro.
create trigger ml_sales_lines_from_financials_insert_delete
  after insert or delete on public.order_financials
  for each row execute function private.ml_sales_lines_trigger();

create trigger ml_sales_lines_from_financials_update
  after update on public.order_financials
  for each row
  when (
    old.order_id is distinct from new.order_id
    or old.seller_shipping_share is distinct from new.seller_shipping_share
    or old.seller_discount is distinct from new.seller_discount
  )
  execute function private.ml_sales_lines_trigger();

-- O histórico que já existe, pela mesma regra, numa passada só.
insert into public.ml_sales_lines
  (line_id, order_id, organization_id, ml_account_id, date_created, pack_id, sku_id,
   quantity, unit_price, sale_fee, shipping_share, seller_discount)
select i.id, o.id, o.organization_id, o.ml_account_id, o.date_created, o.pack_id, i.sku_id,
       i.quantity, i.unit_price, i.sale_fee, f.seller_shipping_share, f.seller_discount
from public.orders o
join public.order_items i
  on i.order_id = o.id
 and i.organization_id = o.organization_id
 and i.ml_account_id = o.ml_account_id
left join public.order_financials f on f.order_id = o.id
where o.status in ('paid', 'partially_refunded');

alter table public.ml_sales_lines add primary key (line_id);

-- A janela do faturamento é pela data. A conta não entra no índice: a RLS
-- filtra a conta por um subplano em hash (`in (select ...)`, D-181), que não
-- vira condição de índice -- com a conta na frente, o plano varria a tabela
-- inteira mesmo para 7 dias (medido no banco local).
create index ml_sales_lines_date_idx on public.ml_sales_lines (date_created);
-- Recalcular um pedido.
create index ml_sales_lines_order_idx on public.ml_sales_lines (order_id);

alter table public.ml_sales_lines
  add constraint ml_sales_lines_order_id_fkey
  foreign key (order_id) references public.orders(id) on delete cascade;

-- Estatísticas antes da primeira leitura (o ensaio da D-409 passou de 3,5
-- minutos sem elas).
analyze public.ml_sales_lines;
