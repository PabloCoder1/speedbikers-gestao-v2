-- ============================================================
-- `get_stock_movements_summary` -- a faixa de KPIs de
-- `/estoque/movimentacoes` (D-252, fatia D17).
--
-- O frame `ProcessScreen type="movements"` desenha TRES cartoes:
-- "Movimentacoes no periodo", "Entradas" e "Saidas".
--
-- ------------------------------------------------------------
-- CONTA MOVIMENTACAO, NAO SOMA UNIDADE -- e a diferenca e medida
-- ------------------------------------------------------------
-- O frame mostra 1.248 / 842 / 391, e 842+391 fecha com 1.248: sao
-- **contagens de linha**, nao somas de quantidade. Seguir isso nao e copia --
-- e a unica forma honesta aqui, e o dado diz por que.
--
-- Medido no Dev, 30 dias, somando `qty_delta` por tipo:
--
--   VENDA_ML                28.830 linhas              -29.513 unidades
--   AJUSTE_RECONCILIACAO     6.202 linhas   +9.638.833 / -3.549.634
--   CANCELAMENTO_ML          1.043 linhas       +1.058
--   DEVOLUCAO_ML               285 linhas         +287
--
-- **Os ajustes de reconciliacao despejam milhoes de unidades** contra ~29,5
-- mil de venda real: e o saldo sentinela do ERP (D-127) entrando no ledger
-- como delta. Um cartao "Entradas: 9.638.833 unidades" seria a tela afirmando
-- movimento fisico que nao houve.
--
-- Contando LINHA, os tres cartoes fecham e dizem a verdade: 36.360 = 6.776
-- entradas + 29.584 saidas, zero neutras.
--
-- ------------------------------------------------------------
-- OS MESMOS FILTROS DA TABELA
-- ------------------------------------------------------------
-- Recebe todos os parametros de recorte de `get_stock_movements` -- periodo,
-- tipo, local, origem e busca. Faixa que ignora o filtro de baixo faz
-- cabecalho e corpo falarem de conjuntos diferentes na mesma tela: o defeito
-- que D-236 mediu em `/cobertura` e que D-249 e D-250 ja evitaram.
--
-- Conferencia de assinatura, nas duas metades (licao de D-237), antes de
-- escrever: esta funcao e NOVA, entao nao ha chamador a quebrar; e
-- `get_stock_movements`, que ela espelha, so e chamada por
-- `apps/web/app/estoque/movimentacoes/page.tsx` e pelos testes -- nenhum
-- chamador dentro do banco.
-- ============================================================

create function public.get_stock_movements_summary(
  p_organization_id uuid,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_movement_type text default null,
  p_location_kind text default null,
  p_source_type text default null,
  p_search text default null
)
returns table (
  movimentacoes bigint,
  entradas bigint,
  saidas bigint,
  skus_tocados bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint as movimentacoes,
    -- Entrada e saida pelo SINAL do delta, nao pelo tipo: `AJUSTE_RECONCILIACAO`
    -- produz os dois, e classificar por tipo poria 6.202 ajustes inteiros num
    -- lado so.
    count(*) filter (where m.qty_delta > 0)::bigint as entradas,
    count(*) filter (where m.qty_delta < 0)::bigint as saidas,
    count(distinct m.sku_id)::bigint as skus_tocados
  from public.stock_movements m
  join public.skus sk on sk.id = m.sku_id
  where m.organization_id = p_organization_id
    and (p_date_from is null or m.occurred_at >= p_date_from)
    and (p_date_to is null or m.occurred_at < p_date_to)
    and (p_movement_type is null or m.movement_type = p_movement_type)
    and (p_location_kind is null or m.location_kind = p_location_kind)
    and (p_source_type is null or m.source_type = p_source_type)
    and (p_search is null
         or sk.sku ilike '%' || p_search || '%'
         or sk.title ilike '%' || p_search || '%')
$$;

comment on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) is
  'Faixa de KPIs de /estoque/movimentacoes (D-252). CONTA movimentacoes, nunca soma unidades: AJUSTE_RECONCILIACAO despeja o saldo sentinela do ERP no ledger (+9,6 mi / -3,5 mi em 30 dias, medido) contra ~29,5 mil de venda real -- somar daria "entradas" que nao houve. Entrada e saida saem do SINAL do delta, nao do tipo, porque o ajuste produz os dois. Recebe os MESMOS filtros da tabela (licao de D-236). security invoker.';

revoke all on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) to authenticated, service_role;
