-- ============================================================
-- D-627 -- a divergencia de estoque entre a Shopee e o V3 vira acao na
-- Central (contrato C-78; o 4o e ultimo dos detectores da Shopee que o dono
-- escolheu em 20/10).
--
-- `sincronizar_alertas_central` ganha a fonte `shopee_divergencia` (secao
-- 4.7): o corpo e o de 20261021120000 (D-619). A regra saiu da medida de
-- 21/10 com o estoque fresco da D-619: ~94% das unidades batem; a Shopee
-- acima do V3 e o caso que pode vender sem produto.
-- O worker passa a pedir a fonte nova DEPOIS desta migration em producao.
-- ============================================================

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
-- Auditoria de 28/09: o work_mem que a 20260928160000 pos com alter
-- function; o create or replace o apagaria se nao viesse aqui.
set work_mem = '16MB'
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
  v_notificadas integer := 0;
  v_encerradas integer := 0;
begin
  if p_organization_id is null then
    raise exception 'organizacao obrigatoria' using errcode = '22023';
  end if;
  if p_fontes is not null and (
    cardinality(p_fontes) = 0
    or not p_fontes <@ array['frete_anomalo', 'ads_campanha', 'produto_prejuizo', 'shopee_sem_vinculo', 'shopee_ruptura', 'shopee_prejuizo', 'shopee_divergencia']
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

    -- D-471: o alerta so usa os 30 dias; o periodo anterior vai de UM dia
    -- (o ultimo antes da janela). Sem isso, o ranking lia 60 dias de pedidos
    -- e itens para preencher colunas de comparacao que o alerta nao usa -- e
    -- estourava os 8 s em producao todo dia (09 a 15/10).
    v_pagina := public.get_ranking_produtos(
      p_date_from => v_hoje - 30,
      p_date_to => v_hoje - 1,
      p_ordem => 'prejuizo',
      p_limite => 100,
      p_offset => v_offset,
      p_anterior_from => v_hoje - 31,
      p_anterior_to => v_hoje - 31,
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
          -- D-471: sem as colunas do periodo anterior, que agora seriam de um dia.
          'detector', p - array['pedidos_anterior', 'pedidos_cobertos_anterior', 'receita_anterior', 'unidades_anterior',
                                'resultado_anterior', 'margem_anterior', 'variacao_receita', 'variacao_margem']
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

  -- 4.4 D-609: o anuncio da Shopee vendendo sem vinculo. A unidade de anuncio
  -- (item ou variacao, `shopee_listing_units`) de loja LIVE cujo estado e
  -- SEM_SKU_NO_ANUNCIO ou SKU_FORA_DO_CATALOGO e que vendeu (pedido VALIDA)
  -- nos 30 dias completos ate ontem. Sem o vinculo, a venda nao baixa o
  -- estoque (D-495 b). O fato e certo (confianca alta); a severidade e media,
  -- sem notificacao: e cadastro a fazer, nao incendio. O impacto e a receita
  -- conhecida do anuncio na janela. A fonte so "rodou" com loja live de
  -- catalogo lido: sem catalogo, nada e criado nem encerrado por ausencia.
  loop
    exit when p_fontes is not null and not ('shopee_sem_vinculo' = any(p_fontes));
    exit when not exists (
      select 1 from public.shopee_shops s
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.items_synced_until is not null
    );

    v_fontes := array_append(v_fontes, 'shopee_sem_vinculo');

    v_detectado := v_detectado || coalesce((
      with vendas as (
        select
          it.shopee_shop_id,
          it.item_id,
          it.model_id,
          sum(it.quantity)::bigint as unidades,
          count(distinct it.order_sn)::bigint as pedidos,
          sum(it.receita_item) as receita,
          count(*) filter (where it.receita_item is null)::bigint as sem_receita
        from public.shopee_sales_items it
        where it.organization_id = p_organization_id
          and it.environment = 'live'
          and it.situacao = 'VALIDA'
          and it.shopee_created_at >= ((v_hoje - 30)::timestamp at time zone 'America/Sao_Paulo')
          and it.shopee_created_at < (v_hoje::timestamp at time zone 'America/Sao_Paulo')
        group by it.shopee_shop_id, it.item_id, it.model_id
      )
      select jsonb_agg(jsonb_build_object(
        'kind', 'shopee_sem_vinculo',
        'subject_key', u.shopee_shop_id::text || ':' || u.item_id::text || ':' || coalesce(u.model_id::text, '-'),
        'severity', 'media',
        'confidence', 'alta',
        'impacto', round(v.receita, 2),
        'ml_account_id', null,
        'shopee_shop_id', u.shopee_shop_id,
        'sku_id', null,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'periodo', jsonb_build_object('inicio', v_hoje - 30, 'fim', v_hoje - 1),
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'venda', 'descricao', format(
              'De %s a %s: %s unidades em %s pedidos, %s de receita, na loja %s, sem SKU vinculado.',
              to_char(v_hoje - 30, 'DD/MM/YYYY'), to_char(v_hoje - 1, 'DD/MM/YYYY'),
              v.unidades, v.pedidos,
              coalesce(private.formatar_brl(v.receita), 'receita desconhecida'),
              coalesce(s.shop_name, 'Shopee'))),
            jsonb_build_object('tipo', 'vinculo', 'descricao', case u.estado
              when 'SKU_FORA_DO_CATALOGO' then format('O anúncio traz o SKU "%s", que não existe no catálogo.', u.sku_anuncio)
              else 'O anúncio não traz SKU e não tem vínculo manual.' end),
            case when v.sem_receita > 0 then jsonb_build_object('tipo', 'sem_receita', 'descricao', format(
              '%s item(ns) de preço 0 ficaram fora da receita.', v.sem_receita)) end
          ), '$[*] ? (@ != null)'),
          'detector', jsonb_build_object(
            'shopee_shop_id', u.shopee_shop_id,
            'loja', s.shop_name,
            'item_id', u.item_id,
            'model_id', u.model_id,
            'anuncio', u.item_name,
            'variacao', u.model_name,
            'sku_anuncio', u.sku_anuncio,
            'estado', u.estado,
            'unidades', v.unidades,
            'pedidos', v.pedidos,
            'receita', round(v.receita, 2),
            'itens_sem_receita', v.sem_receita
          )
        ),
        'recommendation', case u.estado
          when 'SKU_FORA_DO_CATALOGO' then 'Cadastre o SKU do anúncio ou vincule o anúncio a um SKU existente em Anúncios da Shopee: sem o vínculo, a venda não baixa o estoque.'
          else 'Vincule o anúncio a um SKU em Anúncios da Shopee: sem o vínculo, a venda não baixa o estoque.'
        end
      ) order by v.receita desc nulls last, u.item_id, u.model_id)
      from public.shopee_listing_units u
      join public.shopee_shops s on s.id = u.shopee_shop_id and s.environment = 'live'
      join vendas v
        on v.shopee_shop_id = u.shopee_shop_id
       and v.item_id = u.item_id
       and v.model_id is not distinct from u.model_id
      where u.organization_id = p_organization_id
        and u.estado in ('SEM_SKU_NO_ANUNCIO', 'SKU_FORA_DO_CATALOGO')
    ), '[]'::jsonb);

    exit;
  end loop;

  -- 4.5 D-611: a ruptura no anuncio da Shopee. A unidade de anuncio ATIVA
  -- (`item_status` NORMAL e, na variacao, `model_status` MODEL_NORMAL) de loja
  -- LIVE com o estoque da Shopee ZERO -- conhecido; NULO e "nao sei" e fica de
  -- fora -- e que vendeu (VALIDA) nos 30 dias completos ate ontem: a venda
  -- para enquanto o estoque nao volta. O impacto e a receita conhecida dos 30
  -- dias, o que o anuncio fazia com estoque. Vinculado, leva o SKU e o saldo
  -- local do V3, que diz se falta produto ou so falta atualizar a Shopee.
  loop
    exit when p_fontes is not null and not ('shopee_ruptura' = any(p_fontes));
    exit when not exists (
      select 1 from public.shopee_shops s
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.items_synced_until is not null
    );
    -- D-619: o estoque so vale lido ha pouco. A venda baixa o estoque na
    -- Shopee sem mudar o update_time do item, e a fila rele o item ativo a
    -- cada 6 horas. Com o catalogo de uma loja live atrasado -- um item ativo
    -- cuja ultima leitura boa passa de 30 horas --, a fonte nao roda: nada
    -- nasce de estoque velho, e nada se encerra como se o estoque tivesse
    -- voltado.
    exit when exists (
      select 1
      from public.shopee_items i
      join public.shopee_shops s on s.id = i.shopee_shop_id
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.items_synced_until is not null
        and i.item_status = 'NORMAL'
        and i.details_error is null
        and i.details_synced_at < now() - interval '30 hours'
    );

    v_fontes := array_append(v_fontes, 'shopee_ruptura');

    v_detectado := v_detectado || coalesce((
      with vendas as (
        select
          it.shopee_shop_id,
          it.item_id,
          it.model_id,
          sum(it.quantity)::bigint as unidades,
          count(distinct it.order_sn)::bigint as pedidos,
          sum(it.receita_item) as receita,
          count(*) filter (where it.receita_item is null)::bigint as sem_receita,
          max(it.dia) as ultima_venda
        from public.shopee_sales_items it
        where it.organization_id = p_organization_id
          and it.environment = 'live'
          and it.situacao = 'VALIDA'
          and it.shopee_created_at >= ((v_hoje - 30)::timestamp at time zone 'America/Sao_Paulo')
          and it.shopee_created_at < (v_hoje::timestamp at time zone 'America/Sao_Paulo')
        group by it.shopee_shop_id, it.item_id, it.model_id
      )
      select jsonb_agg(jsonb_build_object(
        'kind', 'shopee_ruptura',
        'subject_key', u.shopee_shop_id::text || ':' || u.item_id::text || ':' || coalesce(u.model_id::text, '-'),
        'severity', 'media',
        'confidence', 'alta',
        'impacto', round(v.receita, 2),
        'ml_account_id', null,
        'shopee_shop_id', u.shopee_shop_id,
        'sku_id', u.sku_id,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'periodo', jsonb_build_object('inicio', v_hoje - 30, 'fim', v_hoje - 1),
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'venda', 'descricao', format(
              'De %s a %s: %s unidades em %s pedidos, %s de receita, na loja %s; a última venda foi em %s.',
              to_char(v_hoje - 30, 'DD/MM/YYYY'), to_char(v_hoje - 1, 'DD/MM/YYYY'),
              v.unidades, v.pedidos,
              coalesce(private.formatar_brl(v.receita), 'receita desconhecida'),
              coalesce(s.shop_name, 'Shopee'),
              to_char(v.ultima_venda, 'DD/MM/YYYY'))),
            jsonb_build_object('tipo', 'estoque', 'descricao', format(
              'O estoque do anúncio na Shopee estava zerado na leitura de %s, e o anúncio segue ativo.',
              to_char(u.details_synced_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'))),
            case when u.sku_id is not null then jsonb_build_object('tipo', 'saldo_v3', 'descricao', format(
              'O SKU %s tem %s em estoque local no V3.', u.sku, coalesce(b.quantity, 0)::text)) end
          ), '$[*] ? (@ != null)'),
          'detector', jsonb_build_object(
            'shopee_shop_id', u.shopee_shop_id,
            'loja', s.shop_name,
            'item_id', u.item_id,
            'model_id', u.model_id,
            'anuncio', u.item_name,
            'variacao', u.model_name,
            'sku_anuncio', u.sku_anuncio,
            'sku', u.sku,
            'estado', u.estado,
            'estoque_shopee', u.available_stock,
            'estoque_lido_em', u.details_synced_at,
            'saldo_v3', case when u.sku_id is not null then coalesce(b.quantity, 0) end,
            'unidades', v.unidades,
            'pedidos', v.pedidos,
            'receita', round(v.receita, 2),
            'itens_sem_receita', v.sem_receita,
            'ultima_venda', v.ultima_venda
          )
        ),
        'recommendation', case
          when u.sku_id is not null and coalesce(b.quantity, 0) > 0 then 'O V3 tem o SKU em estoque: atualize a quantidade do anúncio na Shopee, que está zerada.'
          else 'Reponha o estoque do anúncio na Shopee: ele vendia e está zerado.'
        end
      ) order by v.receita desc nulls last, u.item_id, u.model_id)
      from public.shopee_listing_units u
      join public.shopee_shops s on s.id = u.shopee_shop_id and s.environment = 'live'
      join vendas v
        on v.shopee_shop_id = u.shopee_shop_id
       and v.item_id = u.item_id
       and v.model_id is not distinct from u.model_id
      left join public.inventory_balances b
        on b.organization_id = p_organization_id
       and b.sku_id = u.sku_id
       and b.location_kind = 'LOCAL'
      where u.organization_id = p_organization_id
        and u.item_status = 'NORMAL'
        and (u.model_id is null or u.model_status = 'MODEL_NORMAL')
        and u.available_stock = 0
        -- D-619: a ultima leitura do item serviu (a que falhou deixa o
        -- estoque de antes, e estoque desconhecido nunca vira zero).
        and u.details_error is null
    ), '[]'::jsonb);

    exit;
  end loop;

  -- 4.6 D-617: o produto no prejuizo na Shopee, a regra do alerta do ML (4.3,
  -- D-402/D-471) na Shopee. O pedido coberto (o do faturamento, C-58:
  -- receita conhecida, financeiro lido, nenhum item sem SKU, custo de todos)
  -- de UM SKU so (`sku_unico`, ~99,6% dos pedidos validos em 20/10) leva o
  -- resultado inteiro a esse SKU: recebido + ajustes - custo. O pedido de
  -- varios SKUs fica de fora -- sem rateio, a conta e exata -- e e contado na
  -- evidencia. Por loja e SKU (o preco e as taxas sao da loja), nos 30 dias
  -- completos ate ontem, com 3 pedidos cobertos ou mais; a severidade e a
  -- confianca seguem a regra do ML.
  loop
    exit when p_fontes is not null and not ('shopee_prejuizo' = any(p_fontes));
    exit when not exists (
      select 1 from public.shopee_shops s
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.orders_last_success_at is not null
    );

    v_fontes := array_append(v_fontes, 'shopee_prejuizo');

    v_detectado := v_detectado || coalesce((
      with pedidos as (
        select k.*
        from public.get_shopee_faturamento_pedidos(p_organization_id, v_hoje - 30, v_hoje - 1) k
        where k.environment = 'live'
      ),
      por_sku as (
        select
          p.shopee_shop_id,
          p.sku_unico as sku_id,
          count(*)::bigint as pedidos_cobertos,
          sum(p.receita) as receita,
          sum(p.recebido) as recebido,
          sum(coalesce(p.ajustes, 0)) as ajustes,
          sum(p.custo) as custo,
          sum(p.recebido + coalesce(p.ajustes, 0) - p.custo) as resultado,
          sum(coalesce(p.comissao, 0) + coalesce(p.taxa_servico, 0) + coalesce(p.taxa_transacao, 0)) as taxas,
          sum(coalesce(p.frete_loja, 0)) as frete_loja,
          bool_or(p.custo_atual) as custo_atual
        from pedidos p
        where p.coberto and p.sku_unico is not null
        group by p.shopee_shop_id, p.sku_unico
      ),
      de_varios as (
        select p.shopee_shop_id, count(*)::bigint as pedidos
        from pedidos p
        where p.coberto and p.sku_unico is null
        group by p.shopee_shop_id
      )
      select jsonb_agg(jsonb_build_object(
        'kind', 'shopee_prejuizo',
        'subject_key', x.shopee_shop_id::text || ':' || x.sku_id::text,
        'severity', case when x.resultado / nullif(x.receita, 0) <= -0.10 then 'alta' else 'media' end,
        'confidence', case when x.pedidos_cobertos >= 5 and not x.custo_atual then 'alta' else 'media' end,
        'impacto', round(-x.resultado, 2),
        'ml_account_id', null,
        'shopee_shop_id', x.shopee_shop_id,
        'sku_id', x.sku_id,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'periodo', jsonb_build_object('inicio', v_hoje - 30, 'fim', v_hoje - 1),
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'resultado', 'descricao', format(
              'De %s a %s, na loja %s: %s pedidos cobertos, %s de receita e resultado de %s (margem %s).',
              to_char(v_hoje - 30, 'DD/MM/YYYY'), to_char(v_hoje - 1, 'DD/MM/YYYY'),
              coalesce(s.shop_name, 'Shopee'),
              x.pedidos_cobertos,
              private.formatar_brl(x.receita),
              private.formatar_brl(x.resultado),
              private.formatar_pct(x.resultado / nullif(x.receita, 0)))),
            jsonb_build_object('tipo', 'custos', 'descricao', format(
              'A Shopee repassou %s (comissão e taxas %s, frete da loja %s), ajustes depois do repasse %s, e o custo do produto foi %s.',
              private.formatar_brl(x.recebido),
              private.formatar_brl(x.taxas),
              private.formatar_brl(x.frete_loja),
              private.formatar_brl(x.ajustes),
              private.formatar_brl(x.custo))),
            case when x.custo_atual then jsonb_build_object('tipo', 'custo_atual', 'descricao',
              'Parte dos pedidos usou o custo atual, por não haver histórico de custo anterior à venda.') end,
            case when coalesce(dv.pedidos, 0) > 0 then jsonb_build_object('tipo', 'fora', 'descricao', format(
              '%s pedido(s) coberto(s) da loja com mais de um SKU ficaram fora da conta por SKU.', dv.pedidos)) end
          ), '$[*] ? (@ != null)'),
          'detector', jsonb_build_object(
            'shopee_shop_id', x.shopee_shop_id,
            'loja', s.shop_name,
            'sku_id', x.sku_id,
            'sku', sk.sku,
            'pedidos_cobertos', x.pedidos_cobertos,
            'receita', round(x.receita, 2),
            'recebido', round(x.recebido, 2),
            'ajustes', round(x.ajustes, 2),
            'custo', round(x.custo, 2),
            'resultado', round(x.resultado, 2),
            'margem', round(x.resultado / nullif(x.receita, 0), 4),
            'custo_atual', x.custo_atual,
            'pedidos_de_varios_skus', coalesce(dv.pedidos, 0)
          )
        ),
        'recommendation', 'Vale revisar o preço, o custo e o frete do produto na Shopee: ele fechou no prejuízo no período. O faturamento da Shopee mostra a conta por loja.'
      ) order by x.resultado, x.shopee_shop_id, x.sku_id)
      from por_sku x
      join public.shopee_shops s on s.id = x.shopee_shop_id
      left join public.skus sk on sk.id = x.sku_id
      left join de_varios dv on dv.shopee_shop_id = x.shopee_shop_id
      where x.pedidos_cobertos >= 3
        and x.resultado < 0
    ), '[]'::jsonb);

    exit;
  end loop;

  -- 4.7 D-627: a divergencia de estoque entre a Shopee e o V3, o 4o dos
  -- detectores da Shopee. A unidade de anuncio ATIVA, de loja LIVE, vinculada
  -- a um PRODUTO (o kit nao tem saldo proprio), fora do armazem da Shopee (o
  -- item `is_fulfillment_by_shopee` soma o estoque de la: a leitura de 21/10
  -- achou o hibrido) e com a ultima leitura boa, cujo estoque na Shopee passa
  -- do saldo LOCAL que o V3 tinha NO INSTANTE DA LEITURA -- o saldo de agora
  -- menos os movimentos LOCAL depois dela, pelo ledger. Comparar com o saldo
  -- de agora misturaria as vendas do intervalo. A Shopee anuncia mais do que
  -- havia e pode vender sem produto; sem saldo nenhum, a severidade e alta.
  -- A Shopee abaixo do V3 nao e alerta aqui: o zero ja e a ruptura (4.5).
  loop
    exit when p_fontes is not null and not ('shopee_divergencia' = any(p_fontes));
    exit when not exists (
      select 1 from public.shopee_shops s
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.items_synced_until is not null
    );
    -- O mesmo cuidado da ruptura (D-619): com o catalogo de uma loja live
    -- atrasado, a fonte nao roda, e nada se encerra por estoque velho.
    exit when exists (
      select 1
      from public.shopee_items i
      join public.shopee_shops s on s.id = i.shopee_shop_id
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.items_synced_until is not null
        and i.item_status = 'NORMAL'
        and i.details_error is null
        and i.details_synced_at < now() - interval '30 hours'
    );

    v_fontes := array_append(v_fontes, 'shopee_divergencia');

    v_detectado := v_detectado || coalesce((
      with unidades as (
        select u.shopee_shop_id, u.item_id, u.model_id, u.item_name, u.model_name, u.sku_anuncio,
               u.sku_id, u.sku, u.available_stock, u.details_synced_at,
               coalesce(b.quantity, 0) as saldo_agora
        from public.shopee_listing_units u
        join public.shopee_shops s on s.id = u.shopee_shop_id and s.environment = 'live'
        join public.shopee_items i on i.shopee_shop_id = u.shopee_shop_id and i.item_id = u.item_id
        join public.skus k on k.id = u.sku_id and k.kind = 'PRODUTO'
        left join public.inventory_balances b
          on b.organization_id = p_organization_id
         and b.sku_id = u.sku_id
         and b.location_kind = 'LOCAL'
        where u.organization_id = p_organization_id
          and u.item_status = 'NORMAL'
          and (u.model_id is null or u.model_status = 'MODEL_NORMAL')
          and u.available_stock is not null
          and u.details_error is null
          and i.is_fulfillment_by_shopee is false
      ),
      com_saldo as (
        select x.*,
               x.saldo_agora - coalesce((
                 select sum(m.qty_delta)
                 from public.stock_movements m
                 where m.organization_id = p_organization_id
                   and m.sku_id = x.sku_id
                   and m.location_kind = 'LOCAL'
                   and m.occurred_at > x.details_synced_at
               ), 0) as saldo_na_leitura
        from unidades x
      )
      select jsonb_agg(jsonb_build_object(
        'kind', 'shopee_divergencia',
        'subject_key', c.shopee_shop_id::text || ':' || c.item_id::text || ':' || coalesce(c.model_id::text, '-'),
        'severity', case when c.saldo_na_leitura <= 0 then 'alta' else 'media' end,
        'confidence', 'media',
        -- Sem valor em R$: a diferenca e de unidades, e o prejuizo depende de
        -- vender o que nao ha. Ausencia nao vira zero.
        'impacto', null,
        'ml_account_id', null,
        'shopee_shop_id', c.shopee_shop_id,
        'sku_id', c.sku_id,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'evidencias', jsonb_build_array(
            jsonb_build_object('tipo', 'estoque', 'descricao', format(
              'Na leitura de %s, a Shopee mostrava %s unidade(s) no anúncio da loja %s, e o V3 tinha %s do SKU %s em estoque local.',
              to_char(c.details_synced_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
              c.available_stock, coalesce(s.shop_name, 'Shopee'), trim_scale(c.saldo_na_leitura)::text, c.sku)),
            jsonb_build_object('tipo', 'saldo_agora', 'descricao', format(
              'Agora o V3 tem %s em estoque local.', trim_scale(c.saldo_agora)::text))
          ),
          'detector', jsonb_build_object(
            'shopee_shop_id', c.shopee_shop_id,
            'loja', s.shop_name,
            'item_id', c.item_id,
            'model_id', c.model_id,
            'anuncio', c.item_name,
            'variacao', c.model_name,
            'sku_anuncio', c.sku_anuncio,
            'sku', c.sku,
            'estoque_shopee', c.available_stock,
            'estoque_lido_em', c.details_synced_at,
            'saldo_v3_na_leitura', trim_scale(c.saldo_na_leitura),
            'saldo_v3_agora', trim_scale(c.saldo_agora),
            'diferenca', trim_scale(c.available_stock - c.saldo_na_leitura)
          )
        ),
        'recommendation', case
          when c.saldo_na_leitura <= 0 then 'A Shopee anuncia estoque que o V3 não tinha: o anúncio pode vender sem produto. Confira o estoque do SKU e a sincronização do UpSeller, ou zere a quantidade do anúncio na Shopee.'
          else 'A Shopee anuncia mais do que o V3 tinha: confira o estoque do SKU e a sincronização do UpSeller, ou ajuste a quantidade do anúncio na Shopee.'
        end
      ) order by c.available_stock - c.saldo_na_leitura desc, c.shopee_shop_id, c.item_id, c.model_id nulls first)
      from com_saldo c
      join public.shopee_shops s on s.id = c.shopee_shop_id
      where c.available_stock > c.saldo_na_leitura
    ), '[]'::jsonb);

    exit;
  end loop;

  -- 5. O ciclo de vida. Um assunto (anúncio × faixa, campanha, SKU) tem um
  -- episódio por vez: `dedup_key` = tipo:assunto:dia em que o episódio nasceu.

  -- 5.1 Episódio aberto e ainda detectado: a evidência, a severidade e o
  -- impacto passam a ser os de hoje.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, shopee_shop_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  )
  update public.actions a set
    severity = d.severity,
    confidence = d.confidence,
    estimated_impact_brl = d.impacto,
    ml_account_id = coalesce(d.ml_account_id, a.ml_account_id),
    shopee_shop_id = coalesce(d.shopee_shop_id, a.shopee_shop_id),
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
  -- D-411: o episódio novo de severidade ALTA vira um `domain_event`
  -- `central.alert.opened` na mesma transação -- e o fan-out de D-073 o
  -- transforma em notificação para quem alcança a conta (sem conta, a
  -- organização inteira), com toast e triagem na Central de Notificações.
  -- Um evento por episódio (`dedup_key` pelo id da ação): o que continua
  -- aberto não notifica de novo; o que volta depois de fechado é outro
  -- episódio, e notifica.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, shopee_shop_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  ),
  novos as (
    insert into public.actions (
      organization_id, kind, severity, confidence, estimated_impact_brl,
      ml_account_id, shopee_shop_id, sku_id, mlb_id, evidence, recommendation,
      created_by, dedup_key, subject_key, last_detected_on)
    select
      p_organization_id, d.kind, d.severity, d.confidence, d.impacto,
      d.ml_account_id, d.shopee_shop_id, d.sku_id, d.mlb_id,
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
    on conflict (organization_id, dedup_key) do nothing
    returning id, kind, severity, ml_account_id, shopee_shop_id, sku_id, mlb_id, subject_key, estimated_impact_brl, recommendation
  ),
  eventos as (
    insert into public.domain_events (
      organization_id, ml_account_id, shopee_shop_id, occurred_at, event_type, entity_type, entity_id,
      before, after, severity, source, dedup_key)
    select
      p_organization_id, n.ml_account_id, n.shopee_shop_id, now(), 'central.alert.opened', 'action', n.id::text,
      null,
      jsonb_build_object(
        'kind', n.kind,
        'subject_key', n.subject_key,
        'sku_id', n.sku_id,
        'mlb_id', n.mlb_id,
        'impacto', n.estimated_impact_brl,
        'recomendacao', n.recommendation,
        'detectado_em', v_hoje),
      'importante', 'system', 'central.alert.opened:' || n.id::text
    from novos n
    where n.severity = 'alta'
    on conflict (dedup_key) do nothing
    returning id
  )
  select (select count(*) from novos), (select count(*) from eventos)
  into v_criadas, v_notificadas;

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
        when 'shopee_sem_vinculo' then 'O anúncio da Shopee foi vinculado a um SKU, ou deixou de vender nos 30 dias até ontem, há 3 dias.'
        when 'shopee_ruptura' then 'O estoque do anúncio da Shopee voltou, o anúncio saiu do ar, ou ele deixou de ter venda nos 30 dias até ontem, há 3 dias.'
        when 'shopee_prejuizo' then 'O produto não fecha mais no prejuízo na Shopee nos 30 dias até ontem, ou deixou de ter 3 pedidos cobertos, há 3 dias.'
        when 'shopee_divergencia' then 'O estoque do anúncio da Shopee voltou a não passar do saldo do V3, ou o anúncio saiu do ar ou do vínculo, há 3 dias.'
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
    'notificadas', v_notificadas,
    'encerradas', v_encerradas
  );
end;
$$;


comment on function public.sincronizar_alertas_central(uuid, date, text[]) is
  'D-403: grava em actions os alertas da central -- frete provável/forte (get_detector_frete), campanha crítica/abaixo da meta (get_sinais_ads) e produto no prejuízo em 30 dias com 3 pedidos cobertos (get_ranking_produtos) -- um episódio por assunto: atualiza o aberto, respeita o fechado por uma pessoa enquanto a condição continua, abre um novo depois de 3 dias sem detecção, e encerra o aberto que sumiu há 3 dias numa fonte que rodou. D-404: p_fontes escolhe as fontes (NULL = as três). D-411: o episódio novo de severidade alta grava um domain_event central.alert.opened (importante), que o fan-out transforma em notificação. D-471: o produto no prejuízo pede ao ranking só os 30 dias (período anterior de um dia) e guarda a evidência sem as colunas de comparação. D-609: a fonte shopee_sem_vinculo, o anuncio Shopee de loja live que vendeu nos 30 dias ate ontem sem SKU vinculado (shopee_listing_units SEM_SKU_NO_ANUNCIO / SKU_FORA_DO_CATALOGO), com a loja em actions.shopee_shop_id. D-611: a fonte shopee_ruptura, o anuncio Shopee ativo de loja live com estoque zero que vendeu nos 30 dias ate ontem. D-617: a fonte shopee_prejuizo, o SKU de loja live no prejuizo em 30 dias com 3 pedidos cobertos de um SKU so (get_shopee_faturamento_pedidos, sku_unico). D-619: a shopee_ruptura so com o estoque da ultima leitura boa, e nao roda com um item ativo de loja live sem leitura boa ha 30 horas. D-627: a fonte shopee_divergencia, a unidade ativa vinculada a um produto, de loja live e fora do armazem da Shopee, cujo estoque na Shopee passa do saldo local do V3 no instante da leitura (pelo ledger). Só o worker chama (service_role).';
