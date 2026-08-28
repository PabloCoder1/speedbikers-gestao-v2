-- O ALVO da reconciliacao deixa de ser o retrato do ERP e passa a ser o
-- retrato ROLADO PARA A FRENTE pelos movimentos posteriores a ele (D-132).
--
-- O DEFEITO, medido em producao. `compute_erp_snapshot_balances` devolvia o
-- snapshot cru. O handler entao forcava `saldo := snapshot`. Com o snapshot
-- capturado em 2026-08-21 15:42 e o job rodando TODO DIA, isso desfaz a venda
-- de cada dia -- e nao e teoria:
--
--   SKU EB0001: snapshot 13.163, vendeu -251 depois da captura, alvo correto
--   12.912. Saldo hoje: 13.143. As vendas foram apagadas.
--   SKU SV73:   snapshot 2.025, vendeu -134, alvo 1.891. Saldo hoje: 2.016.
--
-- Em SKUs NAO afetados pelo truncamento de D-131 da para ver o mecanismo
-- limpo: o ajuste do dia N e exatamente o oposto da venda do dia N-1.
--
-- E NAO adianta dizer "o problema e o import do ERP nao rodar". O proprio
-- codigo do agendador (apps/api/src/balance-reconcile-schedule.ts) escolheu
-- cadencia diaria JUSTAMENTE porque "o snapshot so muda quando alguem
-- reimporta a planilha do UpSeller manualmente (esporadico)". O desenho
-- reconhece o snapshot esporadico e mesmo assim o reaplica todo dia.
--
-- A CORRECAO. "O UpSeller vence" (D-029) continua valendo, com a precisao que
-- faltava: ele vence NO INSTANTE DA CAPTURA. O que aconteceu depois -- venda,
-- cancelamento, devolucao -- e verdade nossa, com fonte propria, e nao pode
-- ser apagado por um retrato mais velho. Logo:
--
--     alvo = snapshot + movimentos com occurred_at > captured_at
--
-- `AJUSTE_RECONCILIACAO` fica DE FORA da soma, e essa exclusao e o que torna
-- a funcao correta em vez de circular: ajuste nao e evento de estoque, e
-- correcao em direcao ao alvo. Somando-o, o alvo perseguiria o proprio rastro.
--
-- Verificacao algebrica das tres situacoes (L = saldo atual, S = snapshot,
-- M = movimentos reais apos a captura):
--   SKU saudavel    L = S + M   -> delta = 0     (nada a fazer)
--   SKU inflado 4x  L = 4S + M  -> delta = -3S   (volta ao certo)
--   SKU nao semeado L = M       -> delta = S     (nasce o saldo)
-- Ou seja: alem de parar de apagar venda, a funcao torna o job IDEMPOTENTE
-- entre dias -- a repeticao diaria de D-029 passa a produzir zero quando nao
-- ha divergencia real, em vez de um ajuste novo a cada rodada.

create function public.compute_erp_target_balances(p_organization_id uuid)
returns table (
  sku_id uuid,
  location_kind text,
  quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    -- Snapshot mais recente por (sku_id, warehouse) -- um lote reimportado
    -- nao soma com o anterior, substitui. So SKUs ja resolvidos.
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.reserved, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  aggregated as (
    -- Soma entre armazens: o ledger da V3 nao distingue armazem do UpSeller.
    -- `captured_at` fica sendo o mais recente entre os armazens do SKU -- e o
    -- instante a partir do qual os nossos movimentos passam a valer.
    select
      l.sku_id,
      sum(l.available) as available,
      sum(l.reserved) as reserved,
      max(l.captured_at) as captured_at
    from latest l
    group by l.sku_id
  ),
  depois as (
    select
      a.sku_id,
      m.location_kind,
      sum(m.qty_delta) as delta
    from aggregated a
    join public.stock_movements m
      on m.sku_id = a.sku_id
     and m.organization_id = p_organization_id
     and m.occurred_at > a.captured_at
     and m.movement_type <> 'AJUSTE_RECONCILIACAO'
    group by a.sku_id, m.location_kind
  )
  select
    a.sku_id,
    'LOCAL'::text as location_kind,
    a.available + coalesce(d.delta, 0) as quantity
  from aggregated a
  left join depois d on d.sku_id = a.sku_id and d.location_kind = 'LOCAL'
  union all
  select
    a.sku_id,
    'RESERVADO'::text as location_kind,
    a.reserved + coalesce(d.delta, 0) as quantity
  from aggregated a
  left join depois d on d.sku_id = a.sku_id and d.location_kind = 'RESERVADO'
$$;

comment on function public.compute_erp_target_balances is
  'Saldo-ALVO por SKU: o snapshot do UpSeller rolado para a frente pelos movimentos posteriores a captura (D-132). Substitui compute_erp_snapshot_balances, que devolvia o retrato cru e fazia a reconciliacao APAGAR a venda de cada dia enquanto o snapshot nao fosse reimportado. AJUSTE_RECONCILIACAO e excluido da soma de proposito: ajuste nao e evento de estoque, e correcao em direcao ao alvo -- inclui-lo tornaria a funcao circular.';

revoke all on function public.compute_erp_target_balances(uuid) from public, anon;
grant execute on function public.compute_erp_target_balances(uuid) to authenticated, service_role;

-- A funcao antiga sai: manter as duas convidaria a chamar a errada, e o nome
-- `snapshot_balances` descreve exatamente a semantica que esta decisao recusa.
drop function public.compute_erp_snapshot_balances(uuid);
