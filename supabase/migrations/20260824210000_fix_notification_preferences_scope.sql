-- Corrige D-073 (achado ao construir a UI de preferências, Fase 7, item 6,
-- D-076): `notification_preferences` NÃO deve suprimir a criação da linha
-- em `notification_recipients`.
--
-- docs/NOTIFICATIONS.md secao 1 é explícito desde a Fase 0: "'nem toda
-- mudança precisa interromper alguém' acontece via `notification_preferences`
-- (por usuário), não por deixar de criar a notificação: o registro na
-- Central de Notificações continua existindo para consulta, só o alerta em
-- tempo real é que respeita a preferência de cada um." Reforçado pela
-- secao 9 (mesmo arquivo): "notificação é efêmera na atenção, permanente no
-- histórico."
--
-- A trigger original de D-073 (`private.fan_out_notification`) filtrava a
-- inserção de `notification_recipients` pela preferência — suprimia TANTO a
-- Central de Notificações quanto o alerta em tempo real pro usuário que
-- desativou aquele `event_type`, contradizendo o próprio doc que rege esta
-- regra. Até esta correção a tabela `notification_preferences` nascia
-- vazia (sem UI pra criar linha nenhuma), então o bug era inerte, sem
-- nenhuma consequência real — a primeira preferência real só passa a
-- existir com a UI que este item constrói, e é por isso que faz sentido
-- corrigir agora, antes de qualquer preferência real do usuário depender
-- do comportamento errado.
--
-- Correção: a inserção de `notification_recipients` volta a ser
-- incondicional pra todo membro elegível (mesma regra de permissão por
-- conta de sempre — `docs/NOTIFICATIONS.md` secao 5, D-054 — sem
-- alteração). `notification_preferences` passa a ser consultada só na
-- CAMADA DE ENTREGA EM TEMPO REAL (`apps/web/components/notification-toasts.tsx`,
-- via `apps/web/lib/notification-preferences.ts`) — o cliente decide ali se
-- mostra o toast, mas a linha em `notification_recipients` (e portanto a
-- visibilidade na Central) nunca deixa de existir.
create or replace function private.fan_out_notification()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_notification_id uuid;
begin
  insert into public.notifications (organization_id, domain_event_id)
  values (new.organization_id, new.id)
  returning id into v_notification_id;

  insert into public.notification_recipients (notification_id, user_id)
  select v_notification_id, m.user_id
  from public.organization_members m
  where m.organization_id = new.organization_id
    and (
      new.ml_account_id is null
      or m.role = 'ADMIN'
      or exists (
        select 1
        from public.user_account_permissions p
        where p.ml_account_id = new.ml_account_id
          and p.user_id = m.user_id
      )
    );

  return new;
end;
$$;

comment on function private.fan_out_notification is
  'AFTER INSERT em domain_events: cria notifications + notification_recipients pra todo membro elegível por permissão de conta. notification_preferences NAO filtra aqui desde 2026-08-24 (corrigido D-073 -> D-076) -- aplicada na entrega em tempo real (cliente), nunca na criação do registro durável. docs/NOTIFICATIONS.md secao 1/4/5.';
