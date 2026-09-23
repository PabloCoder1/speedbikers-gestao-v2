-- ============================================================
-- D-393 — triagem da Central de Notificações.
--
-- Duas coisas, e cada uma tem um número medido no Dev
-- (`nmgccyqquwxecqffsidr`, 2026-09-23, contra o usuário com a caixa cheia:
-- 54.306 notificações, 13.398 não lidas, 544 páginas de 100).
--
--   1. o índice que a ORDEM da tela pede;
--   2. a leitura em lote que respeita o RECORTE.
--
-- Sem alteração destrutiva: um índice novo e uma função nova. Nenhuma coluna,
-- policy ou trigger muda.
-- ============================================================

-- ============================================================
-- 1. O índice — a primeira página custava 556 ms e passa a custar 63 ms
-- ============================================================
--
-- A tela lê "as N mais recentes DESTE usuário". Até aqui a consulta tinha
-- `notifications` como raiz e ordenava por `notifications.created_at`, e o
-- planejador não tinha como andar pela ordem: ele materializava **as 54.306
-- linhas do usuário**, juntava com `domain_events` por hash e só então tirava
-- as 100 do topo com um `top-N heapsort`. Medido como `authenticated`, com a
-- RLS valendo: **556 ms** para a primeira página.
--
-- `notification_recipients` já tem um índice `(user_id, created_at desc)` —
-- mas PARCIAL, `where read_at is null` (D-073). Ele serve ao recorte de não
-- lidas e não serve a "todas", que é o padrão da tela.
--
-- Com o índice COMPLETO a consulta passa a ter a lista de destinatários como
-- raiz, anda por ele na ordem já ordenada e para na centésima linha:
-- **63 ms**, com 100 sondagens em vez de 54.306 (medido em transação, com
-- `rollback`, antes de escrever esta migration).
--
-- **Ordenar pelo `created_at` do DESTINATÁRIO é a mesma ordem, e não por
-- coincidência:** `private.fan_out_notification` insere a notificação e os
-- destinatários na MESMA transação, e `now()` é o instante da transação, não
-- da linha. Conferido nas 66.932 linhas da base: zero diferença, delta máximo
-- 0,000000 s.
create index notification_recipients_user_created_idx
  on public.notification_recipients (user_id, created_at desc);

comment on index public.notification_recipients_user_created_idx is
  'Ordem da Central de Notificações: as N mais recentes do usuário, com ou sem recorte de lidas. O índice parcial vizinho (user_id, created_at) where read_at is null continua servindo o recorte de não lidas, que é menor. D-393.';

-- ============================================================
-- 2. `mark_notifications_read` — marcar em lote SEM sair do recorte
-- ============================================================
--
-- **O problema é de produto, e tem número.** `listing.available_quantity.changed`
-- sozinho é **32.783 das 54.306** notificações desta base (60,4%): três em
-- cada cinco linhas da Central são o mesmo aviso de rotina. Quem tria quer
-- limpar exatamente essa família e **deixar as críticas por ler** — e até aqui
-- a única escrita em lote era "marcar TODAS", que apaga a distinção junto com
-- o ruído.
--
-- Esta função existe porque o recorte mora num JOIN. A tela escreve direto em
-- `notification_recipients` sob RLS desde D-074 (`docs/ARCHITECTURE.md` §4
-- cita este caso nominalmente), e um `update` do PostgREST não junta tabela:
-- o filtro por severidade/tipo/conta vive em `domain_events`. A alternativa
-- sem função seria ler as ids de mil em mil (o teto do PostgREST) e mandar
-- 14 updates — catorze idas e um teto para estourar em silêncio, que é a
-- classe de defeito de D-183.
--
-- **`security invoker`, não `definer`.** A RLS de `notification_recipients`
-- (`notification_recipients_update_own`) e a de `domain_events`
-- (`domain_events_select_permitted`) continuam valendo dentro da função — ela
-- não ganha poder nenhum, só junta o que o PostgREST não junta. O
-- `user_id = auth.uid()` explícito é defesa em profundidade, o mesmo par de
-- cintos de `actions.ts`.
--
-- `p_*` nulo quer dizer "sem recorte nesta dimensão", e os três nulos juntos
-- são "marcar todas" — o comportamento que a tela já tinha, agora com o
-- número do que foi escrito de volta.
create function public.mark_notifications_read(
  p_severity text default null,
  p_event_type_prefix text default null,
  p_ml_account_id uuid default null
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

comment on function public.mark_notifications_read(text, text, uuid) is
  'Marca como lidas as notificações NÃO LIDAS do usuário corrente dentro de um recorte (severidade, prefixo de família de evento, conta). Os três nulos = todas. security invoker: a RLS de notification_recipients e de domain_events continua valendo. Devolve quantas linhas escreveu. D-393, docs/NOTIFICATIONS.md §7.';

revoke all on function public.mark_notifications_read(text, text, uuid) from public, anon;
grant execute on function public.mark_notifications_read(text, text, uuid) to authenticated;
