-- ============================================================
-- BAIXA DE VENDAS MATERIALIZADA
-- ============================================================
--
-- Aplicada em producao como 20260818132533.
--
-- Historico: tres tentativas de baratear current_ml_sale_deductions
-- chegaram a 3.492 ms (de 11.487 ms). Insuficiente para o caminho quente,
-- e o EXPLAIN mostrou por que nao da para melhorar reescrevendo: o
-- planner estima 98.635 linhas onde existem 1.113, porque nao sabe
-- estimar date_created > (subquery), e por isso varre order_items inteiro.
--
-- Desenho correto: pagar esse custo UMA VEZ no worker, em vez de a cada
-- carregamento de pagina.
--
-- O indice unico e requisito do REFRESH CONCURRENTLY, que atualiza sem
-- bloquear leitura - importante porque /estoque e /produtos leem isto.

create materialized view if not exists public.stock_sale_deductions as
select
  organization_id,
  sku_key,
  warehouse_key,
  quantity,
  last_sale_at,
  sale_lines
from public.current_ml_sale_deductions;

create unique index if not exists stock_sale_deductions_key_idx
  on public.stock_sale_deductions (organization_id, sku_key, warehouse_key);

-- Sem RLS em matview: o acesso direto fica fechado e a leitura acontece
-- somente dentro das funcoes security definer, que ja filtram por
-- organizacao.
revoke all on public.stock_sale_deductions from public, anon, authenticated;

comment on materialized view public.stock_sale_deductions is
  'Baixa de estoque por venda do Mercado Livre, materializada. Atualizada por public.refresh_stock_sale_deductions() ao fim de cada sync de pedidos. Ler daqui, nunca da view current_ml_sale_deductions, que custa ~3,5 s.';

-- CONCURRENTLY nao pode rodar dentro de bloco de transacao, e funcoes
-- plpgsql executam em transacao. O primeiro REFRESH apos a criacao
-- tambem nao pode ser CONCURRENTLY. Por isso a funcao tenta concurrent e
-- cai para o modo normal quando nao for possivel.
create or replace function public.refresh_stock_sale_deductions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  started_at timestamptz := clock_timestamp();
  mode text := 'concurrent';
begin
  begin
    refresh materialized view concurrently public.stock_sale_deductions;
  exception when others then
    refresh materialized view public.stock_sale_deductions;
    mode := 'blocking';
  end;

  return jsonb_build_object(
    'refreshed', true,
    'mode', mode,
    'rows', (select count(*) from public.stock_sale_deductions),
    'elapsedMs', round(extract(milliseconds from clock_timestamp() - started_at))
  );
end;
$$;

revoke all on function public.refresh_stock_sale_deductions() from public, anon, authenticated;
