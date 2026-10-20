-- D-491: marcar em lote as notificações de UMA loja Shopee.
--
-- Desde a D-604 a `/notificacoes` recorta por loja Shopee
-- (`domain_events.shopee_shop_id`, D-438), mas `mark_notifications_read`
-- (D-393) só conhecia severidade, família e conta do ML. Com a loja no recorte,
-- "Marcar todas como lidas" marcaria além do que se vê (o defeito de D-183),
-- e a tela esconde o botão. Esta migration dá à função a loja, com o mesmo
-- significado dos outros recortes: nulo = sem recorte nesta dimensão.
--
-- **Drop + create, nunca um segundo `create`.** Acrescentar o parâmetro com
-- `create or replace` criaria uma SOBRECARGA ao lado da de três argumentos, e a
-- chamada com os três nomes de sempre ficaria ambígua no PostgREST (PGRST203).
-- Com uma função só, a chamada antiga continua igual: o quarto vale nulo.
--
-- **Conta e loja juntas não marcam nada.** O evento tem uma origem só
-- (`domain_events_uma_origem`): os recortes se somam, e nenhum evento é da
-- conta E da loja. A tela tira uma ao escolher a outra (D-604).
--
-- Continua `security invoker`: a RLS de `notification_recipients` e a de
-- `domain_events` (que alcança a loja por `accessible_shopee_shops`, D-433)
-- valem dentro da função.

drop function public.mark_notifications_read(text, text, uuid);

create function public.mark_notifications_read(
  p_severity text default null,
  p_event_type_prefix text default null,
  p_ml_account_id uuid default null,
  p_shopee_shop_id uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_marcadas integer;
begin
  with alvo as (
    select nr.notification_id
      from public.notification_recipients nr
      join public.notifications n on n.id = nr.notification_id
      join public.domain_events de on de.id = n.domain_event_id
     where nr.user_id = (select auth.uid())
       and nr.read_at is null
       and (p_severity is null or de.severity = p_severity)
       -- Prefixo de FAMÍLIA (`listing.`), não tipo cru: é o recorte que a tela
       -- oferece, e `like` com o prefixo fixo à esquerda usa índice quando há.
       and (p_event_type_prefix is null or de.event_type like p_event_type_prefix || '%')
       and (p_ml_account_id is null or de.ml_account_id = p_ml_account_id)
       and (p_shopee_shop_id is null or de.shopee_shop_id = p_shopee_shop_id)
  )
  update public.notification_recipients r
     set read_at = now()
    from alvo
   where r.notification_id = alvo.notification_id
     and r.user_id = (select auth.uid())
     and r.read_at is null;

  get diagnostics v_marcadas = row_count;

  return v_marcadas;
end;
$$;

comment on function public.mark_notifications_read(text, text, uuid, uuid) is
  'Marca como lidas as notificações NÃO LIDAS do usuário corrente dentro de um recorte (severidade, prefixo de família de evento, conta do ML, loja Shopee). Os quatro nulos = todas; conta e loja juntas não marcam nada (o evento tem uma origem só). security invoker: a RLS de notification_recipients e de domain_events continua valendo. Devolve quantas linhas escreveu. D-393, D-491, docs/NOTIFICATIONS.md §7.';

revoke all on function public.mark_notifications_read(text, text, uuid, uuid) from public, anon;
grant execute on function public.mark_notifications_read(text, text, uuid, uuid) to authenticated;
