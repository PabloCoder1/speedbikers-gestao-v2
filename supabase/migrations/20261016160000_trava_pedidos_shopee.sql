-- ============================================================
-- D-481 -- uma leitura de pedidos por loja Shopee de cada vez
--
-- Na primeira leitura das lojas reais (16/10), o log mostrou janelas lidas
-- em dobro: enquanto a cadeia da loja andava de 15 em 15 dias, o aviso de
-- pedido (push, D-453) e o gatilho horario enfileiravam outra
-- `shopee.orders.sync`, que lia a MESMA janela ao mesmo tempo. A gravacao e
-- idempotente (D-432), entao os dados ficaram certos -- o custo era chamada
-- dobrada a Shopee e gravacao dobrada no banco, durante toda a leitura.
--
-- A trava e a do detalhe do catalogo (D-428, `shopee_items_hydrate_lock`):
-- quem pega le a janela; quem nao pega encerra sem erro, porque a leitura em
-- andamento ja cobre a loja. O worker solta gravando a coluna NULA antes de
-- enfileirar a janela seguinte. A validade cobre execucao que morra no meio:
-- vencida, o proximo gatilho pega.
-- ============================================================

alter table public.shopee_shops
  add column orders_sync_locked_until timestamptz;

comment on column public.shopee_shops.orders_sync_locked_until is
  'Trava da leitura de pedidos da loja (D-481): ate quando uma execucao de shopee.orders.sync a segura. NULO = livre. So o worker grava.';

create or replace function public.shopee_orders_sync_lock(p_shopee_shop_id uuid, p_ttl_seconds integer default 600)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with travada as (
    update public.shopee_shops
       set orders_sync_locked_until = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 60))
     where id = p_shopee_shop_id
       and (orders_sync_locked_until is null or orders_sync_locked_until < now())
    returning id
  )
  select exists (select 1 from travada);
$$;

comment on function public.shopee_orders_sync_lock(uuid, integer) is
  'Trava por loja da leitura de pedidos Shopee (D-481): true se pegou. O worker solta gravando orders_sync_locked_until NULO.';

revoke all on function public.shopee_orders_sync_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.shopee_orders_sync_lock(uuid, integer) to service_role;
