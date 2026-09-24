-- D-405 — As medidas do pacote de cada envio, da leitura que já acontece.
--
-- O detector de frete (D-397) aponta o anúncio cujo frete destoa, mas não diz
-- QUE medida está errada: peso e dimensões estão cadastrados em 22 de 973 SKUs
-- vendidos. O ROADMAP pedia as medidas declaradas no anúncio; a leitura real
-- mostrou uma fonte melhor, e de graça.
--
-- `GET /shipments/{id}` -- a mesma leitura de `logistic_type` (D-352), por
-- pedido que vai deduzir e na varredura de logística -- traz `shipping_items[]`
-- com `dimensions` ("4.0x19.0x26.0,710.0": três lados em cm e o peso em
-- gramas) e `dimensions_source.origin`. São as medidas que o Mercado Livre usou
-- NAQUELE envio, as que definem o frete cobrado. Medido em 4 envios reais de
-- 17/09/2026: "bmp" no que saiu da loja, "fd" nos três do Full; o
-- `dimensions` do topo do envio veio nulo nos quatro.
--
-- Uma tabela à parte, e não colunas em `orders`: a gravação do pedido é o
-- caminho crítico do estoque (R5, upsert com o valor resolvido), e esta medida
-- é um fato à parte, gravado por quem leu o envio, que nunca pode derrubar a
-- baixa. Sem chave estrangeira para `orders`: no caminho do pedido o envio é
-- lido ANTES de o pedido ser gravado. Pedido não é apagado (ledger).
--
-- Só envio de UM item tem as medidas do anúncio; com mais de um, o pacote é de
-- todos juntos, e só `items_in_shipment` é gravado.

create table public.shipment_packages (
  order_id bigint primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  shipping_id bigint not null,
  item_id text,
  items_in_shipment integer not null check (items_in_shipment > 0),
  -- O texto do Mercado Livre como veio, para auditoria; os números saem dele.
  dimensions_raw text,
  weight_g numeric check (weight_g > 0),
  volume_cm3 numeric check (volume_cm3 > 0),
  largest_side_cm numeric check (largest_side_cm > 0),
  -- `dimensions_source.origin` cru ("bmp", "fd"…): quem mediu.
  dimensions_origin text,
  captured_at timestamptz not null
);

comment on table public.shipment_packages is
  'D-405: as medidas do pacote de cada envio (shipping_items[].dimensions de GET /shipments/{id}), gravadas pelo worker na mesma leitura de logistic_type (D-352). Só envio de um item tem medidas; com mais, só a contagem. NULL = não medido, nunca 0.';

create index shipment_packages_org_item_idx on public.shipment_packages (organization_id, item_id);

alter table public.shipment_packages enable row level security;

-- A forma de CONJUNTO (D-181), a das tabelas novas: o alcance por conta de
-- `orders`, sem a chamada por linha.
create policy shipment_packages_select_permitted
  on public.shipment_packages for select to authenticated
  using (ml_account_id in (select private.accessible_accounts()));

revoke all on public.shipment_packages from anon, authenticated, service_role;
grant select on public.shipment_packages to authenticated;
grant select, insert, update on public.shipment_packages to service_role;
