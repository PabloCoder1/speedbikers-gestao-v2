-- ============================================================
-- `get_actions_queue` — a fila de /acoes pelo frame `IntelligenceScreen
-- type="actions"` (D23, D-263).
--
-- ------------------------------------------------------------
-- ISTO CONSERTA UM DEFEITO VIVO, e a fatia de design so o encontrou
-- ------------------------------------------------------------
-- A tela le `actions` direto pelo PostgREST **sem `limit` e sem paginacao**,
-- e imprime "N aberto(s)" com N = `rows.length`. O `max_rows` do PostgREST
-- neste projeto e **1000** (`supabase/config.toml`). Medido no Dev em
-- 2026-09-08: **1.449 abertas**.
--
-- Entao a tela hoje devolve 1.000 linhas, esconde 449 sem dizer nada, e
-- imprime "1.000 aberto(s)" -- um numero que nao e o total nem o da pagina,
-- e sim o TETO do servidor. E exatamente D-131 ("nunca uma lista
-- silenciosamente truncada"), e nao aparecia porque ninguem tinha somado
-- 1.449 > 1.000. A fila cresce sozinha: o job de deteccao criou ~140 acoes
-- entre 2026-09-07 e 2026-09-08.
--
-- ------------------------------------------------------------
-- POR QUE UMA RPC, e nao `range()` + `count: 'exact'` no PostgREST
-- ------------------------------------------------------------
-- O `range()` resolveria a janela e o total, mas nao as CONTAGENS do painel
-- de filtros -- que sao a metade esquerda do frame ("Todas as Acoes 14",
-- "Alta Prioridade 6"). Cada contagem dessas e um `select` proprio: quatro
-- filtros sao quatro idas ao banco, e D-185 mede custo por IDA, nao por
-- linha. Uma funcao devolve pagina, total e facetas numa viagem.
--
-- ------------------------------------------------------------
-- AS FACETAS NAO SEGUEM O FILTRO ATIVO, e isso e deliberado
-- ------------------------------------------------------------
-- `escopo` e o inbox inteiro (abertas da organizacao) e as facetas saem dele.
-- Se elas respeitassem `p_severity`, escolher "Alta" zeraria a contagem de
-- "Media" -- e o painel deixaria de dizer quanto trabalho existe fora do
-- recorte, que e a unica coisa que ele tem para dizer. O total da BUSCA
-- (`total_count`) segue o filtro; as facetas, nao.
--
-- ------------------------------------------------------------
-- `facet_kind` e jsonb porque `kind` NAO tem check constraint
-- ------------------------------------------------------------
-- `severity` e fechado em ('baixa','media','alta') e poderia virar tres
-- colunas. `kind` e texto livre: hoje ha dois valores no Dev
-- (`venda_anomala` 1.402, `reclamacoes_recorrentes` 47), e o detector pode
-- passar a gravar um terceiro sem tocar no banco. Colunas fixas obrigariam
-- uma migration para cada tipo novo -- e, pior, um tipo desconhecido sumiria
-- do painel sem aviso. Os dois vao como mapa, pela mesma regra, e o
-- TypeScript trata chave ausente como zero.
--
-- **Chave ausente NAO e zero mentiroso aqui:** `severity = 'baixa'` tem zero
-- linhas no Dev hoje, e o painel mostrando "Baixa 0" e verdade medida, nao
-- ausencia disfarcada (D-067). O que seria mentira e omitir a linha.
--
-- ------------------------------------------------------------
-- O CRITERIO DE DESEMPATE E OBRIGATORIO, nao cosmetico
-- ------------------------------------------------------------
-- A ordenacao canonica e `estimated_impact_brl desc` (ARCHITECTURE secao 16 --
-- nunca por contagem, nunca por data). Mas **63 das 1.449 abertas tem
-- `estimated_impact_brl` NULL** e empatam entre si, e outras empatam em
-- valor. Ordenacao nao-deterministica com `offset` faz o Postgres devolver a
-- MESMA linha em duas paginas e nenhuma linha para outra -- perda silenciosa,
-- sem erro. `created_at desc, id` fecha o desempate e torna a paginacao
-- reproduzivel.
--
-- ------------------------------------------------------------
-- PAGE-FIRST, pela licao de D-196
-- ------------------------------------------------------------
-- SKU e conta nao filtram e nao ordenam: so aparecem na saida. `base` recorta
-- e pagina; os dois saem por `left join` SOMENTE para as linhas da pagina.
--
-- ------------------------------------------------------------
-- STATUS FICA FORA DOS ARGUMENTOS, de proposito
-- ------------------------------------------------------------
-- O painel do frame se chama "Filtros (Inbox)": inbox e o que esta aberto. A
-- tela ja filtrava `novo`/`em_andamento` e isso nao deve regredir -- "cinco
-- mil alertas nao sao cinco mil problemas" (ARCHITECTURE secao 16). Uma acao
-- some da fila por ter sido resolvida, nao por o registro ter sumido.
--
-- ------------------------------------------------------------
-- ASSINATURA: conferida nas duas metades, antes de escrever (licao de D-237)
-- ------------------------------------------------------------
--   catalogo   funcao NOVA -- nao ha chamador a quebrar
--   monorepo   nenhuma ocorrencia de `get_actions_queue` em apps/ ou
--              packages/ antes desta fatia
--
-- Argumentos de filtro por ULTIMO (D-242/D-243): a suite de integracao chama
-- por POSICAO, e argumento inserido no meio quebra chamada que nao mudou.
-- ============================================================

create function public.get_actions_queue(
  p_organization_id uuid,
  p_limit integer default 25,
  p_offset integer default 0,
  p_severity text default null,
  p_kind text default null
)
returns table (
  id uuid,
  kind text,
  severity text,
  confidence text,
  estimated_impact_brl numeric,
  sku_id uuid,
  sku text,
  sku_title text,
  mlb_id text,
  account_label text,
  evidence jsonb,
  recommendation text,
  status text,
  assignee_id uuid,
  created_at timestamptz,
  total_count bigint,
  open_total bigint,
  facet_severity jsonb,
  facet_kind jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    select a.severity, a.kind
    from public.actions a
    where a.organization_id = p_organization_id
      and a.status in ('novo', 'em_andamento')
  ),
  facetas as (
    select
      (select count(*) from escopo)::bigint as open_total,
      coalesce(
        (select jsonb_object_agg(g.severity, g.n)
         from (select e.severity, count(*)::bigint as n from escopo e group by e.severity) g),
        '{}'::jsonb
      ) as facet_severity,
      coalesce(
        (select jsonb_object_agg(g.kind, g.n)
         from (select e.kind, count(*)::bigint as n from escopo e group by e.kind) g),
        '{}'::jsonb
      ) as facet_kind
  ),
  base as (
    select a.id,
           a.kind,
           a.severity,
           a.confidence,
           a.estimated_impact_brl,
           a.sku_id,
           a.mlb_id,
           a.ml_account_id,
           a.evidence,
           a.recommendation,
           a.status,
           a.assignee_id,
           a.created_at,
           count(*) over () as total_count
    from public.actions a
    where a.organization_id = p_organization_id
      and a.status in ('novo', 'em_andamento')
      and (p_severity is null or a.severity = p_severity)
      and (p_kind is null or a.kind = p_kind)
    -- Impacto primeiro (ARCHITECTURE secao 16); o resto so desempata.
    order by a.estimated_impact_brl desc nulls last, a.created_at desc, a.id
    limit p_limit offset p_offset
  )
  select b.id,
         b.kind,
         b.severity,
         b.confidence,
         b.estimated_impact_brl,
         b.sku_id,
         s.sku,
         s.title as sku_title,
         b.mlb_id,
         -- `ml_account_id` e anulavel e, no Dev, e NULL em 100% das abertas:
         -- o detector de venda anomala trabalha por SKU, que atravessa contas.
         -- O chip de conta do frame so nasce quando a acao REALMENTE tem uma.
         m.label as account_label,
         b.evidence,
         b.recommendation,
         b.status,
         b.assignee_id,
         b.created_at,
         coalesce(b.total_count, 0)::bigint,
         f.open_total,
         f.facet_severity,
         f.facet_kind
  -- `facetas` ANTES de `base`, com `left join`, e nao `base cross join
  -- facetas`. A diferenca aparece so no caso vazio, e e a diferenca entre a
  -- tela funcionar e nao funcionar: com `cross join`, um filtro que nao casa
  -- nada devolve ZERO linhas, e entao `open_total` e as facetas vem junto com
  -- elas -- o painel de filtros fica em branco exatamente quando o operador
  -- precisa dele para voltar a "Todas". Medido: `p_kind = 'nao_existe'`
  -- devolvia 0 linhas e nenhuma contagem.
  --
  -- `facetas` tem sempre EXATAMENTE uma linha (agregados sem `from`), entao o
  -- `left join` garante uma linha-sentinela com as colunas da acao em NULL
  -- quando a pagina esta vazia. Quem chama descarta linha com `id is null` --
  -- regra fixada em teste dos dois lados, em `lib/action-filters.ts`.
  from facetas f
  left join base b on true
  left join public.skus s on s.id = b.sku_id
  left join public.ml_accounts m on m.id = b.ml_account_id
  order by b.estimated_impact_brl desc nulls last, b.created_at desc, b.id
$$;

comment on function public.get_actions_queue(uuid, integer, integer, text, text) is
  'Fila de /acoes pelo frame IntelligenceScreen type="actions" (D-263). Devolve pagina + total da busca + facetas numa viagem so: as contagens do painel de filtros seriam uma ida ao banco cada (D-185). CONSERTA D-131 vivo -- a tela lia sem limit contra max_rows=1000 do PostgREST e imprimia "1.000 aberto(s)" com 1.449 abertas no Dev, escondendo 449 sem aviso. As facetas correm sobre o inbox INTEIRO e nao seguem p_severity/p_kind: se seguissem, escolher "Alta" zeraria a contagem de "Media" e o painel deixaria de dizer o que existe fora do recorte; total_count, esse sim, segue o filtro. facet_kind e jsonb porque kind nao tem check constraint (dois valores hoje, e um tipo novo nao pode sumir do painel sem aviso). Desempate por created_at/id e obrigatorio: 63 abertas tem impacto NULL e empatam, e ordenacao nao-deterministica com offset repete linha numa pagina e perde outra em silencio. Status fica fora dos argumentos: inbox e o que esta aberto (ARCHITECTURE secao 16). security invoker.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova, e o guarda de D-182
-- ("nenhuma funcao de public alcancavel por anon") ficaria vermelho.
revoke all on function public.get_actions_queue(uuid, integer, integer, text, text) from public, anon;
grant execute on function public.get_actions_queue(uuid, integer, integer, text, text) to authenticated, service_role;
