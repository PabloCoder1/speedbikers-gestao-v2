-- D-404 — A sincronização dos alertas da central (D-403) por fonte.
--
-- Medido em produção em 24/09/2026, no primeiro disparo: a chamada com as três
-- fontes numa transação estourou o `statement_timeout` de 8 s da API do banco
-- com o banco frio (8.066 ms, "canceling statement due to statement timeout");
-- a nova tentativa da fila, 60 s depois e com cache, passou em 2.254 ms e
-- criou 32 alertas (9 de frete, 8 de Ads, 15 de produto). O detector de frete
-- sozinho faz 4,4 s frio em produção (D-399): as três juntas não cabem no teto
-- a frio, e às 8h o banco está frio.
--
-- A função ganha `p_fontes` (NULL = as três, como antes). O worker passa a
-- chamar uma fonte por vez: cada chamada é uma transação e um timeout próprios,
-- e a que falhar não derruba as outras. Fonte não pedida não roda -- e não
-- cria nem encerra nada, pelo mesmo caminho de "fonte sem dado" de D-403. O
-- corpo é o de D-403; só a escolha das fontes é nova.
--
-- O worker no ar chama sem `p_fontes` e continua funcionando entre esta
-- migration e o deploy dele.

drop function public.sincronizar_alertas_central(uuid, date);

create or replace function public.sincronizar_alertas_central(
  p_organization_id uuid,
  p_hoje date default null,
  p_fontes text[] default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_frete jsonb;
  v_ads jsonb;
  v_pagina jsonb;
  v_offset integer := 0;
  v_total integer;
  v_fontes text[] := '{}';
  v_detectado jsonb := '[]'::jsonb;
  v_atualizadas integer := 0;
  v_continuas integer := 0;
  v_criadas integer := 0;
  v_encerradas integer := 0;
begin
  if p_organization_id is null then
    raise exception 'organizacao obrigatoria' using errcode = '22023';
  end if;
  if p_fontes is not null and (
    cardinality(p_fontes) = 0
    or not p_fontes <@ array['frete_anomalo', 'ads_campanha', 'produto_prejuizo']
  ) then
    raise exception 'fonte desconhecida: %', p_fontes using errcode = '22023';
  end if;

  -- 4.1 Frete: provável problema e forte indício (D-397/D-399). A fonte só
  -- conta como "rodou" com anúncio analisado: sem frete observado, nada é
  -- encerrado por ausência.
  -- D-404: sem pedir a fonte, ela não roda -- e fonte que não rodou não
  -- cria nem encerra nada (o NULL cai no mesmo caminho de "sem dado").
  v_frete := case when p_fontes is null or 'frete_anomalo' = any(p_fontes)
    then public.get_detector_frete(p_organization_id, v_hoje) end;

  if coalesce((v_frete -> 'resumo' ->> 'analisados')::integer, 0) > 0 then
    v_fontes := array_append(v_fontes, 'frete_anomalo');
    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'frete_anomalo',
        'subject_key', (a ->> 'anuncio') || ':' || (a ->> 'faixa'),
        'severity', case a ->> 'nivel' when 'forte' then 'alta' else 'media' end,
        'confidence', case a ->> 'nivel' when 'forte' then 'alta' else 'media' end,
        'impacto', case when (a ->> 'excesso')::numeric > 0 then (a ->> 'excesso')::numeric end,
        'ml_account_id', (
          select l.ml_account_id
          from public.listings l
          where l.organization_id = p_organization_id
            and l.item_id = a ->> 'anuncio'
          limit 1
        ),
        'sku_id', a ->> 'sku_id',
        'mlb_id', a ->> 'anuncio',
        'evidence', jsonb_build_object(
          'nivel', a ->> 'nivel',
          'pontos', (a ->> 'pontos')::integer,
          'faixa', a ->> 'faixa',
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'frete_atual', 'descricao', format(
              'Frete médio de %s nos últimos 14 dias até %s (%s pedidos, preço %s).',
              private.formatar_brl((a ->> 'frete_atual')::numeric),
              to_char(v_hoje - 1, 'DD/MM/YYYY'),
              a ->> 'pedidos_atual',
              case a ->> 'faixa'
                when 'ate_40' then 'até R$ 40'
                when '40_79' then 'de R$ 40 a R$ 79'
                when '79_120' then 'de R$ 79 a R$ 120'
                when '120_200' then 'de R$ 120 a R$ 200'
                when '200_400' then 'de R$ 200 a R$ 400'
                else 'acima de R$ 400'
              end)),
            case when a ->> 'frete_esperado' is not null then jsonb_build_object('tipo', 'historico', 'descricao', format(
              'Pelo histórico do próprio anúncio, o esperado seria %s.', private.formatar_brl((a ->> 'frete_esperado')::numeric))) end,
            case when a ->> 'frete_irmaos' is not null then jsonb_build_object('tipo', 'mesmo_produto', 'descricao', format(
              'Outros anúncios do mesmo produto pagam %s.', private.formatar_brl((a ->> 'frete_irmaos')::numeric))) end,
            case when a ->> 'frete_pares' is not null then jsonb_build_object('tipo', 'pares', 'descricao', format(
              'Produtos da mesma categoria na faixa pagam %s (%s produtos).',
              private.formatar_brl((a ->> 'frete_pares')::numeric), a ->> 'pares')) end,
            jsonb_build_object('tipo', 'nivel', 'descricao', format(
              '%s (%s pontos no detector de frete).',
              case a ->> 'nivel' when 'forte' then 'Forte indício de frete errado' else 'Provável problema de frete' end,
              a ->> 'pontos'))
          ), '$[*] ? (@ != null)'),
          -- O retrato do detector no dia, para o histórico do episódio.
          'detector', a
        ),
        'recommendation', case a ->> 'nivel'
          when 'forte' then 'Vale conferir o peso e as medidas cadastrados no anúncio e a etiqueta dos últimos envios: o frete destoa em mais de uma comparação. O motivo completo está no detector de frete.'
          else 'Vale conferir o cadastro de peso e medidas do anúncio antes que o frete a mais se acumule. O motivo completo está no detector de frete.'
        end
      ))
      from jsonb_array_elements(v_frete -> 'alertas') a
      where a ->> 'nivel' in ('provavel', 'forte')
    ), '[]'::jsonb);
  end if;

  -- 4.2 Ads: crítico e ROAS abaixo da meta, na semana consolidada (D-398/
  -- D-401). Sem semana consolidada, a fonte não rodou.
  v_ads := case when p_fontes is null or 'ads_campanha' = any(p_fontes)
    then public.get_sinais_ads(p_organization_id, v_hoje) end;

  if v_ads -> 'janela' ->> 'fim' is not null then
    v_fontes := array_append(v_fontes, 'ads_campanha');
    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'ads_campanha',
        'subject_key', (c ->> 'ml_account_id') || ':' || (c ->> 'campaign_id'),
        'severity', case c ->> 'nivel' when 'critico' then 'alta' else 'media' end,
        'confidence', 'alta',
        -- Gasto além do que a meta da própria campanha pediria para a mesma
        -- venda; sem meta, o que não voltou em venda.
        'impacto', case
          when (c ->> 'roas_alvo')::numeric > 0
            then nullif(greatest(round((c ->> 'investimento')::numeric - (c ->> 'receita_ads')::numeric / (c ->> 'roas_alvo')::numeric, 2), 0), 0)
          else nullif(greatest((c ->> 'investimento')::numeric - (c ->> 'receita_ads')::numeric, 0), 0)
        end,
        'ml_account_id', c ->> 'ml_account_id',
        'sku_id', null,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'nivel', c ->> 'nivel',
          'campanha', c ->> 'nome',
          'campaign_id', (c ->> 'campaign_id')::bigint,
          'conta', c ->> 'conta',
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'semana', 'descricao', format(
              'Campanha "%s" (%s), semana de %s a %s: %s investidos e %s em vendas atribuídas (%s unidades).',
              c ->> 'nome', c ->> 'conta',
              to_char((v_ads -> 'janela' ->> 'inicio')::date, 'DD/MM/YYYY'),
              to_char((v_ads -> 'janela' ->> 'fim')::date, 'DD/MM/YYYY'),
              private.formatar_brl((c ->> 'investimento')::numeric),
              private.formatar_brl((c ->> 'receita_ads')::numeric),
              c ->> 'unidades')),
            case when c ->> 'roas' is not null then jsonb_build_object('tipo', 'roas', 'descricao', format(
              'ROAS %s%s.',
              replace(to_char((c ->> 'roas')::numeric, 'FM999990.00'), '.', ','),
              case when c ->> 'roas_alvo' is not null
                then ' contra a meta de ' || replace(to_char((c ->> 'roas_alvo')::numeric, 'FM999990.00'), '.', ',') || ' da campanha'
                else '' end)) end,
            case when c ->> 'roas_anterior' is not null then jsonb_build_object('tipo', 'anterior', 'descricao', format(
              'Na semana anterior: ROAS %s, com %s investidos.',
              replace(to_char((c ->> 'roas_anterior')::numeric, 'FM999990.00'), '.', ','),
              private.formatar_brl((c ->> 'investimento_anterior')::numeric))) end
          ), '$[*] ? (@ != null)'),
          'detector', c
        ),
        'recommendation', case
          when c ->> 'nivel' = 'critico' and (c ->> 'unidades')::integer = 0
            then 'Vale revisar a campanha: ela gastou sem vender na semana. Considere reduzir o orçamento e investigar segmentação e produtos; avaliar pausa caso o comportamento permaneça.'
          when c ->> 'nivel' = 'critico'
            then 'Vale revisar a campanha: o Ads custou mais do que vendeu na semana. Considere reduzir o orçamento enquanto investiga CPC, conversão e produtos.'
          else 'Vale revisar o que puxou o ROAS para baixo da meta — CPC, conversão ou produtos anunciados — antes de continuar investindo no mesmo ritmo.'
        end
      ))
      from jsonb_array_elements(v_ads -> 'campanhas') c
      where c ->> 'nivel' in ('critico', 'abaixo_meta')
    ), '[]'::jsonb);
  end if;

  -- 4.3 Produtos no prejuízo nos 30 dias completos até ontem (D-402), com 3
  -- pedidos cobertos ou mais: uma venda só no prejuízo é o ranking que mostra,
  -- não um alerta.
  loop
    exit when p_fontes is not null and not ('produto_prejuizo' = any(p_fontes));

    v_pagina := public.get_ranking_produtos(
      p_date_from => v_hoje - 30,
      p_date_to => v_hoje - 1,
      p_ordem => 'prejuizo',
      p_limite => 100,
      p_offset => v_offset,
      p_organization_id => p_organization_id
    );

    if v_offset = 0 then
      exit when coalesce((v_pagina -> 'resumo' ->> 'skus_cobertos')::integer, 0) = 0;
      v_fontes := array_append(v_fontes, 'produto_prejuizo');
    end if;

    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'produto_prejuizo',
        'subject_key', p ->> 'sku_id',
        'severity', case when (p ->> 'margem_venda')::numeric <= -0.10 then 'alta' else 'media' end,
        'confidence', case when (p ->> 'pedidos_cobertos')::integer >= 5 and not (p ->> 'custo_atual')::boolean then 'alta' else 'media' end,
        'impacto', -(p ->> 'resultado_venda')::numeric,
        'ml_account_id', null,
        'sku_id', p ->> 'sku_id',
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'periodo', jsonb_build_object('inicio', v_hoje - 30, 'fim', v_hoje - 1),
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'resultado', 'descricao', format(
              'De %s a %s: %s pedidos cobertos, %s de receita e resultado de %s (margem %s).',
              to_char(v_hoje - 30, 'DD/MM/YYYY'), to_char(v_hoje - 1, 'DD/MM/YYYY'),
              p ->> 'pedidos_cobertos',
              private.formatar_brl((p ->> 'receita_coberta')::numeric),
              private.formatar_brl((p ->> 'resultado_venda')::numeric),
              private.formatar_pct((p ->> 'margem_venda')::numeric))),
            jsonb_build_object('tipo', 'custos', 'descricao', format(
              'Comissão %s, frete %s e custo do produto %s nos mesmos pedidos.',
              private.formatar_brl((p ->> 'taxas_ml_cobertas')::numeric),
              private.formatar_brl((p ->> 'frete_vendedor')::numeric),
              private.formatar_brl((p ->> 'custo_produtos')::numeric))),
            case when (p ->> 'custo_atual')::boolean then jsonb_build_object('tipo', 'custo_atual', 'descricao',
              'Parte dos pedidos usou o custo atual, por não haver histórico de custo anterior à venda.') end
          ), '$[*] ? (@ != null)'),
          'detector', p
        ),
        'recommendation', 'Vale revisar preço, custo e frete do produto: ele fechou no prejuízo no período. O ranking de produtos mostra a conta completa.'
      ))
      from jsonb_array_elements(v_pagina -> 'itens') p
      where (p ->> 'pedidos_cobertos')::integer >= 3
    ), '[]'::jsonb);

    v_total := (v_pagina ->> 'total')::integer;
    v_offset := v_offset + 100;
    exit when v_offset >= v_total;
  end loop;

  -- 5. O ciclo de vida. Um assunto (anúncio × faixa, campanha, SKU) tem um
  -- episódio por vez: `dedup_key` = tipo:assunto:dia em que o episódio nasceu.

  -- 5.1 Episódio aberto e ainda detectado: a evidência, a severidade e o
  -- impacto passam a ser os de hoje.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  )
  update public.actions a set
    severity = d.severity,
    confidence = d.confidence,
    estimated_impact_brl = d.impacto,
    ml_account_id = coalesce(d.ml_account_id, a.ml_account_id),
    sku_id = coalesce(d.sku_id, a.sku_id),
    mlb_id = coalesce(d.mlb_id, a.mlb_id),
    evidence = d.evidence || jsonb_build_object(
      'primeira_deteccao', coalesce(a.evidence -> 'primeira_deteccao', to_jsonb(a.created_at::date)),
      'ultima_deteccao', v_hoje),
    recommendation = d.recommendation,
    last_detected_on = v_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = d.kind
    and a.subject_key = d.subject_key
    and a.status in ('novo', 'em_andamento');

  get diagnostics v_atualizadas = row_count;

  -- 5.2 Episódio fechado por uma pessoa, e a condição continua (detectada
  -- até anteontem): não reabre -- quem resolveu ou descartou já decidiu. Só a
  -- continuidade é anotada, para o episódio não recomeçar amanhã.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(kind text, subject_key text)
  )
  update public.actions a set last_detected_on = v_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = d.kind
    and a.subject_key = d.subject_key
    and a.status in ('resolvido', 'descartado')
    and a.last_detected_on >= v_hoje - 2
    and a.last_detected_on < v_hoje
    and not exists (
      select 1 from public.actions o
      where o.organization_id = a.organization_id
        and o.kind = a.kind
        and o.subject_key = a.subject_key
        and o.status in ('novo', 'em_andamento')
    );

  get diagnostics v_continuas = row_count;

  -- 5.3 Episódio novo: detectado hoje, sem episódio aberto e sem um fechado
  -- que ainda esteja em curso.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  )
  insert into public.actions (
    organization_id, kind, severity, confidence, estimated_impact_brl,
    ml_account_id, sku_id, mlb_id, evidence, recommendation,
    created_by, dedup_key, subject_key, last_detected_on)
  select
    p_organization_id, d.kind, d.severity, d.confidence, d.impacto,
    d.ml_account_id, d.sku_id, d.mlb_id,
    d.evidence || jsonb_build_object('primeira_deteccao', v_hoje, 'ultima_deteccao', v_hoje),
    d.recommendation,
    'system', d.kind || ':' || d.subject_key || ':' || to_char(v_hoje, 'YYYY-MM-DD'), d.subject_key, v_hoje
  from d
  where not exists (
    select 1 from public.actions a
    where a.organization_id = p_organization_id
      and a.kind = d.kind
      and a.subject_key = d.subject_key
      and (a.status in ('novo', 'em_andamento') or a.last_detected_on >= v_hoje - 2)
  )
  on conflict (organization_id, dedup_key) do nothing;

  get diagnostics v_criadas = row_count;

  -- 5.4 Episódio aberto que não aparece há 3 dias, numa fonte que rodou hoje:
  -- o sistema encerra, e diz por quê. Três dias, não um: um anúncio perto do
  -- limiar entra e sai do nível de um dia para o outro.
  update public.actions a set
    status = 'resolvido',
    evidence = a.evidence || jsonb_build_object('encerramento', jsonb_build_object(
      'em', v_hoje,
      'por', 'sistema',
      'motivo', case a.kind
        when 'frete_anomalo' then 'O detector de frete deixou de apontar o anúncio como provável problema há 3 dias: o frete voltou ao normal, o nível caiu ou faltam pedidos na janela de 14 dias.'
        when 'ads_campanha' then 'A campanha saiu do nível crítico e de ROAS abaixo da meta na semana consolidada há 3 dias, ou deixou de gastar.'
        else 'O produto não fecha mais no prejuízo nos 30 dias até ontem, ou deixou de ter 3 pedidos cobertos.'
      end))
  where a.organization_id = p_organization_id
    and a.kind = any(v_fontes)
    and a.subject_key is not null
    and a.status in ('novo', 'em_andamento')
    and a.last_detected_on <= v_hoje - 3;

  get diagnostics v_encerradas = row_count;

  return jsonb_build_object(
    'hoje', v_hoje,
    'fontes', to_jsonb(v_fontes),
    'detectados', (
      select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb)
      from (
        select x ->> 'kind' as kind, count(*) as n
        from jsonb_array_elements(v_detectado) x
        group by x ->> 'kind'
      ) k
    ),
    'atualizadas', v_atualizadas,
    'continuas', v_continuas,
    'criadas', v_criadas,
    'encerradas', v_encerradas
  );
end;
$$;

comment on function public.sincronizar_alertas_central(uuid, date, text[]) is
  'D-403: grava em actions os alertas da central -- frete provável/forte (get_detector_frete), campanha crítica/abaixo da meta (get_sinais_ads) e produto no prejuízo em 30 dias com 3 pedidos cobertos (get_ranking_produtos) -- um episódio por assunto: atualiza o aberto, respeita o fechado por uma pessoa enquanto a condição continua, abre um novo depois de 3 dias sem detecção, e encerra o aberto que sumiu há 3 dias numa fonte que rodou. D-404: p_fontes escolhe as fontes (NULL = as três); o worker chama uma por vez, cada chamada abaixo do statement_timeout de 8 s. Só o worker chama (service_role).';

revoke all on function public.sincronizar_alertas_central(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.sincronizar_alertas_central(uuid, date, text[]) to service_role;
