-- D-869: lançar custo no pedido de compra passa a ser idempotente.
--
-- `upsert_purchase_order_cost` com `p_id` nulo sempre inseria. Se a resposta
-- da Server Action se perdia depois de o banco gravar, repetir lançava o mesmo
-- custo duas vezes e inflava o custo de chegada e a margem (D-865 só avisava).
--
-- Agora a inclusão aceita `p_request_id`, gerado no navegador por intenção de
-- lançamento: a mesma requisição devolve o custo já gravado, sem linha nova e
-- sem evento novo. Reusar a requisição com outros dados é recusado, para a
-- repetição nunca esconder um valor diferente do que foi gravado.
--
-- Compatível com a tela anterior: o parâmetro é opcional, e a chamada sem ele
-- continua inserindo como antes. A função antiga (8 argumentos) sai, para o
-- PostgREST não ter duas assinaturas candidatas para a mesma chamada.

alter table public.purchase_order_costs
  add column request_id uuid,
  add constraint purchase_order_costs_request_unique unique (purchase_order_id, request_id);

comment on column public.purchase_order_costs.request_id is
  'Identificador da requisição de inclusão (D-869), gerado no navegador: repetir a mesma inclusão devolve o custo já lançado.';

drop function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text);

create function public.upsert_purchase_order_cost(
  p_purchase_order_id uuid,
  p_kind text,
  p_amount numeric,
  p_id uuid default null,
  p_description text default null,
  p_currency text default null,
  p_exchange_rate numeric default null,
  p_status text default null,
  p_request_id uuid default null
)
returns public.purchase_order_costs
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_order_costs;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_currency text := upper(coalesce(p_currency, 'BRL'));
  v_status text := coalesce(p_status, 'ESTIMADO');
begin
  select * into po from public.purchase_orders where id = p_purchase_order_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_purchase_order_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status = 'CANCELLED' then
    raise exception 'pedido % ja esta em estado terminal (status %)', po.id, po.status;
  end if;

  if p_id is not null and p_request_id is not null then
    raise exception 'p_request_id vale so para incluir custo, nao para editar';
  end if;

  if p_id is null then
    -- Idempotência (D-869): a mesma requisição devolve o custo já lançado.
    -- O `for update` do pedido acima serializa as chamadas do mesmo pedido.
    if p_request_id is not null then
      select * into result
      from public.purchase_order_costs
      where purchase_order_id = po.id and request_id = p_request_id;

      if result.id is not null then
        if result.kind is distinct from p_kind
          or result.amount is distinct from round(p_amount, 2)
          or result.description is distinct from v_description
          or result.currency is distinct from v_currency
          or result.exchange_rate is distinct from round(p_exchange_rate, 6)
          or result.status is distinct from v_status then
          raise exception 'requisicao % ja lancou um custo com outros dados', p_request_id;
        end if;

        return result;
      end if;
    end if;

    insert into public.purchase_order_costs (
      organization_id, purchase_order_id, kind, description, amount, currency, exchange_rate, status, created_by, request_id
    ) values (
      po.organization_id, po.id, p_kind, v_description, p_amount,
      v_currency, p_exchange_rate, v_status, (select auth.uid()), p_request_id
    )
    returning * into result;
  else
    update public.purchase_order_costs set
      kind = p_kind,
      description = v_description,
      amount = p_amount,
      currency = v_currency,
      exchange_rate = p_exchange_rate,
      status = coalesce(p_status, status)
    where id = p_id and purchase_order_id = po.id
    returning * into result;

    if result.id is null then
      raise exception 'custo % nao encontrado', p_id;
    end if;
  end if;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (po.organization_id, po.id, 'COSTS_UPDATED', (select auth.uid()),
          jsonb_build_object('costId', result.id, 'kind', result.kind, 'amount', result.amount,
                             'currency', result.currency, 'status', result.status));

  return result;
end;
$$;

comment on function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text, uuid) is
  'Inclui (p_id nulo) ou edita um custo adicional do pedido (D-725). Autorização (ADMIN/GESTOR) refeita internamente. A inclusão é idempotente por p_request_id (D-869): a mesma requisição devolve o custo já lançado; com outros dados, é recusada.';

revoke all on function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text, uuid) from public, anon;
grant execute on function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text, uuid) to authenticated;
