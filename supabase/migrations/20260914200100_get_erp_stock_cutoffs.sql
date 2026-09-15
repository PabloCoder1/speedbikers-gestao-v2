-- D-351 -- o corte do snapshot do ERP por SKU, para o worker decidir se uma venda ja
-- estava na planilha do UpSeller.
--
-- CONTRATO. Uma linha por id pedido (distinto, nao nulo), SEMPRE -- inclusive quando nao
-- ha corte, com `captured_at` nulo. O worker confere que cada id pedido voltou: linha
-- ausente e leitura incompleta e LANCA, nunca vira "sem corte" (que e exatamente a dupla
-- contagem de D-350 §5).
--
-- O CORTE DE UM SKU e o MESMO de `compute_erp_target_balances` (20260828203624): o
-- `captured_at` do snapshot mais recente por (sku, armazem), com o maximo entre
-- armazens -- que e o `max(captured_at)` do SKU. Os dois precisam concordar: o gate
-- estorna venda com "venda em" <= corte, e o alvo soma movimento com `occurred_at` >
-- corte. Se discordassem, a primeira reconciliacao desfaria a guarda.
--
-- SKU SEM SNAPSHOT PROPRIO usa o corte da organizacao (o snapshot mais recente dela). A
-- reconciliacao nunca visita esse SKU (nao ha alvo para ele), entao uma baixa anterior a
-- planilha o deixaria negativo para sempre. ORGANIZACAO SEM SNAPSHOT: nulo -- antes do
-- primeiro retrato nao ha o que estornar, e o comportamento e o de antes.
--
-- TETO DE 1.000 DO POSTGREST: a saida tem uma linha por id, e o worker manda lotes de no
-- maximo 500.

create function public.get_erp_stock_cutoffs(p_organization_id uuid, p_sku_ids uuid[])
returns table (sku_id uuid, captured_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with pedidos as (
    select distinct i.sku_id
    from unnest(p_sku_ids) as i(sku_id)
    where i.sku_id is not null
  ),
  organizacao as (
    select max(s.captured_at) as captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
  )
  select p.sku_id, coalesce(proprio.captured_at, o.captured_at) as captured_at
  from pedidos p
  cross join organizacao o
  left join lateral (
    select max(s.captured_at) as captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id = p.sku_id
  ) proprio on true
$$;

comment on function public.get_erp_stock_cutoffs(uuid, uuid[]) is
  'Corte do snapshot do UpSeller por SKU (instante da exportacao da planilha mais recente do SKU; sem snapshot proprio, o da organizacao; sem snapshot na organizacao, nulo). Uma linha por id pedido, sempre. O mesmo corte de compute_erp_target_balances (D-351).';

revoke all on function public.get_erp_stock_cutoffs(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_erp_stock_cutoffs(uuid, uuid[]) to service_role;

-- O indice que existia (`organization_id, sku_key, captured_at desc`) e por chave de
-- texto; o worker pergunta por `sku_id`. Os dois abaixo servem as duas metades da
-- consulta: o maximo por SKU e o maximo da organizacao, cada um por uma descida de
-- indice em vez de uma varredura dos snapshots da organizacao -- que crescem a cada
-- planilha importada (3.098 linhas por import em producao) e sao lidos a cada pagina
-- de pedidos. Medidos em D-351.
create index erp_stock_snapshots_sku_cutoff_idx
  on public.erp_stock_snapshots (organization_id, sku_id, captured_at desc)
  where sku_id is not null;

create index erp_stock_snapshots_org_cutoff_idx
  on public.erp_stock_snapshots (organization_id, captured_at desc);
