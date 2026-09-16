-- D-351 -- dois vocabularios fechados ganham valores (dois tipos de movimento e uma fonte), e o fan-out de notificacao
-- aprende a ignorar a carga da historia.
--
-- 1. `stock_movements.movement_type` ganha `ESTORNO_PRE_CAPTURA` e `ESTORNO_REVERSAO_EXCEDENTE`.
--
--    O par de uma venda cuja "venda em" (`date_closed ?? date_created`) e anterior ou
--    igual ao corte do snapshot do UpSeller: a planilha ja descontou essa venda. O worker
--    grava a venda e o estorno juntos, com a MESMA `occurred_at` -- o par soma zero no
--    saldo e, do mesmo lado do corte, zero no alvo de `compute_erp_target_balances`.
--
--    Tipo proprio, e nao `AJUSTE_MANUAL`: ajuste manual exige `created_by` e `reason`
--    (`stock_movements_manual_has_creator`/`_has_reason`), e atribuir a linha de sistema
--    ao unico ADMIN seria autoria falsa. `created_by` fica nulo, como toda linha de
--    sistema (`20260821200000`). E nao `AJUSTE_RECONCILIACAO`: esse fica FORA do alvo, e
--    a venda ficaria dentro.
--
--    E `ESTORNO_REVERSAO_EXCEDENTE` (reverificacao de cc90baa, D-351 §12): a anulacao da
--    reversao a mais de uma venda estornada -- o legado de D-052/D-057 gravou cancelamento E
--    devolucao da mesma venda. Tipo proprio, e nao `ESTORNO_PRE_CAPTURA` negativo: quem le
--    `ESTORNO_PRE_CAPTURA` (o worker e a F3) o trata como "esta venda ja foi estornada", e a
--    anulacao nao e estorno de venda nenhuma. Chave neutra `estorno:<chave da reversao>`,
--    `occurred_at` espelhado da reversao, `created_by` nulo.
--
--    Nada mais le a lista: `get_stock_movements` e `get_stock_movements_summary` nao
--    validam o tipo (o resumo conta entrada e saida pelo sinal), e a web ganha o rotulo e o
--    filtro no mesmo commit.
alter table public.stock_movements drop constraint stock_movements_movement_type_check;

alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML', 'DEVOLUCAO_ML',
  'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
  'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO',
  'ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE'
));

-- 2. `domain_events.source` ganha `backfill`.
--
--    O evento sobre a HISTORIA que a carga inicial de pedidos traz. O primeiro backfill
--    de producao gerou 32.258 `order.cancelled` de pedidos de ate um ano antes, e cada
--    um virou notificacao `importante` para o unico ADMIN. O evento continua sendo
--    gravado -- `get_sku_correlated_events` e o diagnostico o leem --, so nao notifica.
--
--    ORDEM DE PUBLICACAO: esta migration ANTES do worker. O worker novo grava `backfill`;
--    contra o CHECK antigo, o flush da pagina aborta (`page-writes.ts`) e o job retenta.
alter table public.domain_events drop constraint domain_events_source_check;

alter table public.domain_events add constraint domain_events_source_check
  check (source in ('webhook', 'sync', 'user', 'system', 'backfill'));

-- 3. `private.fan_out_notification` pula `backfill`.
--
--    Corpo identico ao de `20260824210000_fix_notification_preferences_scope.sql` (a
--    definicao de producao), com o desvio no topo. Filtrar pela FONTE, e nao por
--    `occurred_at < ml_accounts.connected_at`: `connected_at` e reescrito a cada
--    reconexao (`apps/api/src/ml-accounts.ts`), e o filtro por data silenciaria eventos
--    reais da janela horaria logo depois de uma reconexao.
create or replace function private.fan_out_notification()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_notification_id uuid;
begin
  if new.source = 'backfill' then
    return new;
  end if;

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
  'AFTER INSERT em domain_events: cria notifications + notification_recipients pra todo membro elegível por permissão de conta. notification_preferences NAO filtra aqui desde 2026-08-24 (corrigido D-073 -> D-076) -- aplicada na entrega em tempo real (cliente), nunca na criação do registro durável. Evento com source = backfill (a carga da historia) nao vira notificacao (D-351). docs/NOTIFICATIONS.md secao 1/4/5.';

-- Funcao de gatilho: o Postgres nao confere EXECUTE ao disparar, so ao criar o gatilho.
-- O `revoke` tira o EXECUTE implicito de PUBLIC (o `proacl` de producao estava nulo),
-- no mesmo padrao de `private.support_case_links_validate_scope`.
revoke all on function private.fan_out_notification() from public, anon, authenticated;
