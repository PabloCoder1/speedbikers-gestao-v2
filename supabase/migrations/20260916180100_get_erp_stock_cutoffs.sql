-- D-351 -- o corte do snapshot do ERP por SKU, para o worker decidir se uma venda ja
-- estava na planilha do UpSeller.
--
-- CONTRATO. Uma linha por id pedido (distinto, nao nulo), SEMPRE -- inclusive quando nao
-- ha corte, com `captured_at`, `imported_at` e `exported_at` nulos. O worker confere que cada
-- id pedido voltou e que cada instante e legivel: linha ausente, coluna ausente ou data
-- invalida LANCA, nunca vira "sem corte" (que e exatamente a dupla contagem de D-350 §5).
--
-- O CORTE DE UM SKU (`captured_at`) e o MESMO de `compute_erp_target_balances`: o
-- `captured_at` do snapshot mais recente por (sku, armazem), com o maximo entre armazens --
-- que e o `max(captured_at)` do SKU. Os dois precisam concordar: o alvo soma movimento com
-- `occurred_at` > corte, e o worker usa o corte para saber de que lado do alvo esta uma
-- linha ja gravada. Se discordassem, a primeira reconciliacao desfaria a guarda.
--
-- O QUE A PLANILHA RETRATA (`exported_at`, reverificacao de c48fb70, MEDIA-1). O saldo da
-- planilha e o Disponivel no instante da EXPORTACAO. Em quase todo snapshot isso e o proprio
-- `captured_at`: o worker grava a exportacao desde D-351, e a migration 20260916180000
-- corrigiu os antigos. A excecao e o snapshot que AINDA carrega o parse de uma planilha com o
-- nome carimbado (`captured_at = parsed_at`, e o nome aponta outro instante): a organizacao
-- reconciliada, que aquela migration deixa no parse de proposito (o Dev: exportado em 08-20
-- 16:09:23, corte em 08-21 15:42:02.459), ou uma planilha importada pelo worker antigo entre a
-- migration e o deploy. Ali o corte do alvo e o parse, mas a venda entre a exportacao e o
-- parse NAO esta na planilha. Com so `captured_at`, o worker a estornava: no Dev, 708 VENDA_ML
-- do worker antigo dessa janela, com `occurred_at` depois do corte e que o alvo ja conta
-- certo, ganhariam um +1 que sobe alvo e saldo juntos, sem ajuste que o denuncie. Por isso a
-- RPC devolve os dois: `exported_at` diz o que a planilha TEM (o gate da venda e os instantes
-- do cancelamento, no worker), `captured_at` diz de que lado do alvo uma linha esta.
-- `exported_at` <= `captured_at` sempre: a exportacao lida do nome fica em
-- [parse - 24 h, parse]. `private.erp_stock_export_instant` ganha EXECUTE para
-- `service_role`, que chama esta funcao `security invoker`.
--
-- QUANDO O CORTE CHEGOU (`imported_at`). O snapshot VENCEDOR do corte e o primeiro por
-- `captured_at desc, created_at desc, id desc` -- o mesmo desempate que
-- `compute_erp_target_balances` passa a usar em 20260916180400 --, e `imported_at` e o maior
-- entre o `applied_at` do lote dele e o `created_at` dele. O `created_at` e o `now()` do
-- INICIO da transacao do lote; `applied_at` e gravado pelo worker DEPOIS de todos os upserts
-- e da marcacao das linhas. Com o MENOR `created_at`, como era, uma venda decidida com o
-- corte ANTIGO (lido antes do commit) e gravada numa transacao iniciada depois do primeiro
-- lote parecia ter entrado no saldo depois de o corte chegar, e seria estornada na
-- atualizacao seguinte do pedido (verificacao de e6fda07, BAIXA-1). Em producao: primeiro
-- lote 18:44:18.714, ultimo 18:44:19.198, applied_at 18:44:19.581 -- 867 ms que deixam de
-- ser janela. Lote que ainda nao fechou (applied_at nulo) fica com o `created_at`.
--
-- A ULTIMA RECONCILIACAO (`reconciled_at`, da organizacao): o maior entre o `finished_at`
-- do ultimo `maintenance.reconcile-balances` concluido (`job_runs`) e o `created_at` do
-- ultimo AJUSTE_RECONCILIACAO; nulo se nunca houve. Quem absorve a venda gravada e o
-- ALINHAMENTO do saldo ao alvo, nao o import (verificacao de e6fda07, MEDIA-1): a venda com
-- `occurred_at` ate o corte, gravada depois do import e antes de uma reconciliacao, ja foi
-- posta de lado por ela, e estorna-la depois deixa o saldo 1 acima do real ate a rodada
-- seguinte gravar -1 com notificacao. As duas fontes, e nao uma:
--   - `job_runs`, porque a rodada que nao grava ajuste nenhum TAMBEM alinhou o saldo -- todo
--     SKU comparado ficou igual ao alvo. So com o ajuste, uma organizacao com nove dias de
--     rodadas sem ajuste (o Dev, de 09-06 a 09-14) ficaria ancorada no ultimo ajuste;
--   - o ajuste, porque uma rodada que gravou ajustes e falhou antes de registrar o
--     `job_runs` (a gravacao de job_runs e do roteador, depois do handler) alinhou os SKUs
--     que ajustou.
-- `finished_at`, e nao `started_at`: o alvo e lido DENTRO da rodada, e o fim e o unico
-- instante em que se sabe que ela ja leu. A venda gravada no meio da rodada fica tratada
-- como absorvida; no caso raro em que nao foi, a rodada seguinte a absorve com um ajuste.
--
-- SKU SEM SNAPSHOT PROPRIO usa o corte da organizacao (o snapshot vencedor dela). A
-- reconciliacao nunca visita esse SKU (nao ha alvo para ele), entao uma baixa anterior a
-- planilha o deixaria negativo para sempre. ORGANIZACAO SEM SNAPSHOT: corte, imported_at e
-- exported_at nulos -- antes do primeiro retrato nao ha o que estornar, e o comportamento e
-- o de antes.
--
-- TETO DE 1.000 DO POSTGREST: a saida tem uma linha por id, e o worker manda lotes de no
-- maximo 500.

create function public.get_erp_stock_cutoffs(p_organization_id uuid, p_sku_ids uuid[])
returns table (sku_id uuid, captured_at timestamptz, imported_at timestamptz, reconciled_at timestamptz, exported_at timestamptz)
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
    select w.captured_at,
           greatest(b.applied_at, w.created_at) as imported_at,
           -- O snapshot que ainda carrega o parse retrata a exportacao do nome do arquivo.
           case when w.captured_at = b.parsed_at
                then private.erp_stock_export_instant(b.file_name, b.parsed_at)
                else w.captured_at
           end as exported_at
    from (
      select s.captured_at, s.created_at, s.batch_id
      from public.erp_stock_snapshots s
      where s.organization_id = p_organization_id
      order by s.captured_at desc, s.created_at desc, s.id desc
      limit 1
    ) w
    left join public.erp_import_batches b on b.id = w.batch_id
  ),
  reconciliacao as (
    select greatest(
      (select j.finished_at
         from public.job_runs j
        where j.organization_id = p_organization_id
          and j.job_type = 'maintenance.reconcile-balances'
          and j.status = 'done'
        order by j.finished_at desc
        limit 1),
      (select m.created_at
         from public.stock_movements m
        where m.organization_id = p_organization_id
          and m.movement_type = 'AJUSTE_RECONCILIACAO'
        order by m.created_at desc
        limit 1)
    ) as reconciled_at
  )
  select p.sku_id,
         coalesce(proprio.captured_at, o.captured_at) as captured_at,
         case when proprio.captured_at is not null then proprio.imported_at else o.imported_at end as imported_at,
         -- So o SKU com snapshot PROPRIO tem alvo, e so ele e visitado pela reconciliacao:
         -- para o que usa o corte da organizacao, nenhuma rodada alinha o saldo, e a venda
         -- gravada depois do import continua precisando do estorno.
         case when proprio.captured_at is not null then r.reconciled_at end as reconciled_at,
         case when proprio.captured_at is not null then proprio.exported_at else o.exported_at end as exported_at
  from pedidos p
  -- `left join ... on true`: a organizacao sem snapshot nao tem linha vencedora, e o
  -- contrato continua sendo uma linha por id.
  left join organizacao o on true
  cross join reconciliacao r
  left join lateral (
    select w.captured_at,
           greatest(b.applied_at, w.created_at) as imported_at,
           case when w.captured_at = b.parsed_at
                then private.erp_stock_export_instant(b.file_name, b.parsed_at)
                else w.captured_at
           end as exported_at
    from (
      select s.captured_at, s.created_at, s.batch_id
      from public.erp_stock_snapshots s
      where s.organization_id = p_organization_id
        and s.sku_id = p.sku_id
      order by s.captured_at desc, s.created_at desc, s.id desc
      limit 1
    ) w
    left join public.erp_import_batches b on b.id = w.batch_id
  ) proprio on true
$$;

comment on function public.get_erp_stock_cutoffs(uuid, uuid[]) is
  'Corte do snapshot do UpSeller por SKU: captured_at (o corte do alvo: o captured_at da planilha mais recente do SKU; sem snapshot proprio, o da organizacao; sem snapshot na organizacao, nulo), imported_at (o maior entre applied_at do lote e created_at do snapshot vencedor do corte: venda gravada ate ali ja estava no saldo), reconciled_at (a ultima reconciliacao da organizacao, por job_runs concluido ou AJUSTE_RECONCILIACAO) e exported_at (o instante que a planilha retrata: a exportacao do nome do arquivo quando o snapshot vencedor ainda carrega o parse, senao o proprio captured_at). Uma linha por id pedido, sempre. O mesmo corte e o mesmo desempate de compute_erp_target_balances (D-351).';

revoke all on function public.get_erp_stock_cutoffs(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_erp_stock_cutoffs(uuid, uuid[]) to service_role;

-- A funcao acima e `security invoker` e le a exportacao do nome do arquivo: quem a chama
-- (`service_role`) precisa de EXECUTE na funcao privada, que 20260916180000 revogou de
-- public, anon e authenticated. `usage` no schema `private` o `service_role` ja tem
-- (20260820150000).
grant execute on function private.erp_stock_export_instant(text, timestamptz) to service_role;

-- O indice que existia (`organization_id, sku_key, captured_at desc`) e por chave de
-- texto; o worker pergunta por `sku_id`. Os dois abaixo servem as duas metades da
-- consulta: o snapshot vencedor por SKU e o da organizacao, cada um por UMA descida de
-- indice na ordem do desempate, em vez de uma varredura dos snapshots da organizacao --
-- que crescem a cada planilha importada (3.098 linhas por import em producao) e sao lidos
-- a cada pagina de pedidos. O `include (batch_id)` leva ao lote sem ler a linha.
create index erp_stock_snapshots_sku_cutoff_idx
  on public.erp_stock_snapshots (organization_id, sku_id, captured_at desc, created_at desc, id desc)
  include (batch_id)
  where sku_id is not null;

create index erp_stock_snapshots_org_cutoff_idx
  on public.erp_stock_snapshots (organization_id, captured_at desc, created_at desc, id desc)
  include (batch_id);

-- A ultima reconciliacao, por uma descida de indice. `job_runs` tem 143 mil linhas no Dev
-- (os jobs de atendimento rodam de 10 em 10 minutos, 6.869 em producao no primeiro dia):
-- sem o indice parcial, a organizacao que nunca reconciliou -- producao hoje -- percorreria
-- o historico inteiro de jobs a cada pagina de pedidos.
create index job_runs_reconcile_balances_done_idx
  on public.job_runs (organization_id, finished_at desc)
  where job_type = 'maintenance.reconcile-balances' and status = 'done';

create index stock_movements_ajuste_reconciliacao_idx
  on public.stock_movements (organization_id, created_at desc)
  where movement_type = 'AJUSTE_RECONCILIACAO';
