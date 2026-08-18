-- ============================================================
-- Hotfix — proteger leituras da carga de background
--
-- Parte D: o fallback "refresh materialized view concurrently ->
-- exceção -> refresh materialized view normal (blocking)" tomava um
-- ACCESS EXCLUSIVE LOCK na matview quando o concurrent falhava,
-- bloqueando qualquer leitura de stock_sale_deductions — exatamente o
-- tipo de bloqueio que este hotfix existe para eliminar. Removido.
--
-- Serialização via pg_try_advisory_xact_lock (não bloqueante, escopo
-- de transação — libera sozinho ao fim da chamada): se outra chamada
-- já está fazendo o refresh, retorna imediatamente `already_running`
-- em vez de esperar ou empilhar refreshes concorrentes. Mesma função
-- para o burst do orders_v2 e para a reconciliação do orders_recent —
-- nenhuma lógica separada por caminho de chamada.
--
-- Preferência explícita do princípio: melhor stock_sale_deductions
-- ficar defasado por um ciclo do que bloquear /estoque ou /produtos.
-- ============================================================

create or replace function public.refresh_stock_sale_deductions()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  started_at timestamptz := clock_timestamp();
  lock_key bigint := hashtextextended('stock_sale_deductions_refresh', 0);
begin
  if not pg_try_advisory_xact_lock(lock_key) then
    return jsonb_build_object('refreshed', false, 'reason', 'already_running');
  end if;

  begin
    refresh materialized view concurrently public.stock_sale_deductions;
  exception when others then
    return jsonb_build_object(
      'refreshed', false,
      'reason', 'concurrent_refresh_failed',
      'error', sqlerrm
    );
  end;

  return jsonb_build_object(
    'refreshed', true,
    'mode', 'concurrent',
    'rows', (select count(*) from public.stock_sale_deductions),
    'elapsedMs', round(extract(milliseconds from clock_timestamp() - started_at))
  );
end;
$$;
