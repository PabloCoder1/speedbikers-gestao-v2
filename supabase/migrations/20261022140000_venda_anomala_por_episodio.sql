-- ============================================================
-- D-643 -- a venda anomala vira um episodio por SKU e canal.
--
-- Ate aqui o worker gravava uma acao por SKU por dia (`sales_anomaly:<sku>:<dia>`)
-- e nenhuma fechava sozinha: a D-263 viu 1.449 abertas no Dev, e em producao
-- elas acumulam desde setembro. A D-403 deu aos outros alertas da Central o
-- episodio por assunto; a venda anomala ficou de fora. Decisao do dono em
-- 22/10: episodio, e os acumulados encerrados (nada apagado).
--
-- `registrar_vendas_anomalas(organizacao, dia, detectadas)` faz o ciclo da
-- D-403 numa transacao, com o assunto `<canal>:<sku>` (`ML:` ou `SHOPEE:`,
-- o canal do C-83):
-- 1. o acumulado de antes (venda anomala aberta SEM assunto) e encerrado com o
--    motivo -- a cada rodada, para cobrir tambem o que o worker antigo gravar
--    entre a migration e o deploy;
-- 2. episodio aberto e detectado: a evidencia, a severidade e o impacto
--    passam a ser os de hoje;
-- 3. fechado por uma pessoa e ainda detectado (ate anteontem): nao reabre,
--    so anota a continuidade;
-- 4. detectado sem episodio aberto nem fechado em curso: episodio novo, com
--    `dedup_key` = venda_anomala:<assunto>:<dia em que nasceu>;
-- 5. tres dias sem deteccao (o worker rodou): o sistema encerra, e diz por
--    que.
-- Sem notificacao: a venda anomala nao notificava e continua nao notificando
-- (o D-411 e dos alertas da Central; aqui seriam centenas por dia).
-- `security invoker`, executavel so pelo `service_role`, como a da Central.
-- ============================================================

create function public.registrar_vendas_anomalas(
  p_organization_id uuid,
  p_hoje date,
  p_detectadas jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_legado integer := 0;
  v_atualizadas integer := 0;
  v_continuas integer := 0;
  v_criadas integer := 0;
  v_encerradas integer := 0;
begin
  if p_organization_id is null or p_hoje is null then
    raise exception 'registrar_vendas_anomalas exige a organizacao e o dia';
  end if;

  if jsonb_typeof(p_detectadas) is distinct from 'array' then
    raise exception 'p_detectadas deve ser uma lista (veio %)', jsonb_typeof(p_detectadas);
  end if;

  -- 1. O acumulado de antes do episodio: aberto e sem assunto.
  update public.actions a set
    status = 'resolvido',
    evidence = a.evidence || jsonb_build_object('encerramento', jsonb_build_object(
      'em', p_hoje,
      'por', 'sistema',
      'motivo', 'Substituída pelo episódio por SKU e canal (D-643): a venda anômala agora é um cartão só, atualizado enquanto a anomalia aparece e encerrado quando ela some.'))
  where a.organization_id = p_organization_id
    and a.kind = 'venda_anomala'
    and a.subject_key is null
    and a.status in ('novo', 'em_andamento');

  get diagnostics v_legado = row_count;

  -- 2. Episodio aberto e ainda detectado: a evidencia, a severidade e o
  -- impacto passam a ser os de hoje.
  with d as (
    select * from jsonb_to_recordset(p_detectadas) as x(
      subject_key text, severity text, confidence text, impacto numeric, sku_id uuid, evidence jsonb, recommendation text)
  )
  update public.actions a set
    severity = d.severity,
    confidence = d.confidence,
    estimated_impact_brl = d.impacto,
    sku_id = coalesce(d.sku_id, a.sku_id),
    evidence = d.evidence || jsonb_build_object(
      'primeira_deteccao', coalesce(a.evidence -> 'primeira_deteccao', to_jsonb(a.created_at::date)),
      'ultima_deteccao', p_hoje),
    recommendation = d.recommendation,
    last_detected_on = p_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = 'venda_anomala'
    and a.subject_key = d.subject_key
    and a.status in ('novo', 'em_andamento');

  get diagnostics v_atualizadas = row_count;

  -- 3. Fechado por uma pessoa e a anomalia continua (detectada ate
  -- anteontem): nao reabre -- quem resolveu ou descartou ja decidiu.
  with d as (
    select * from jsonb_to_recordset(p_detectadas) as x(subject_key text)
  )
  update public.actions a set last_detected_on = p_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = 'venda_anomala'
    and a.subject_key = d.subject_key
    and a.status in ('resolvido', 'descartado')
    and a.last_detected_on >= p_hoje - 2
    and a.last_detected_on < p_hoje
    and not exists (
      select 1 from public.actions o
      where o.organization_id = a.organization_id
        and o.kind = a.kind
        and o.subject_key = a.subject_key
        and o.status in ('novo', 'em_andamento')
    );

  get diagnostics v_continuas = row_count;

  -- 4. Episodio novo: detectado hoje, sem episodio aberto e sem um fechado que
  -- ainda esteja em curso. O indice parcial `actions_um_episodio_aberto`
  -- garante um so aberto por assunto.
  with d as (
    select * from jsonb_to_recordset(p_detectadas) as x(
      subject_key text, severity text, confidence text, impacto numeric, sku_id uuid, evidence jsonb, recommendation text)
  )
  insert into public.actions (
    organization_id, kind, severity, confidence, estimated_impact_brl, sku_id, evidence, recommendation,
    created_by, dedup_key, subject_key, last_detected_on)
  select
    p_organization_id, 'venda_anomala', d.severity, d.confidence, d.impacto, d.sku_id,
    d.evidence || jsonb_build_object('primeira_deteccao', p_hoje, 'ultima_deteccao', p_hoje),
    d.recommendation,
    'system', 'venda_anomala:' || d.subject_key || ':' || to_char(p_hoje, 'YYYY-MM-DD'), d.subject_key, p_hoje
  from d
  where not exists (
    select 1 from public.actions a
    where a.organization_id = p_organization_id
      and a.kind = 'venda_anomala'
      and a.subject_key = d.subject_key
      and (a.status in ('novo', 'em_andamento') or a.last_detected_on >= p_hoje - 2)
  )
  on conflict (organization_id, dedup_key) do nothing;

  get diagnostics v_criadas = row_count;

  -- 5. Tres dias sem deteccao: o sistema encerra, e diz por que. Tres, e nao
  -- um, porque a venda perto do limiar entra e sai da anomalia de um dia para
  -- o outro.
  update public.actions a set
    status = 'resolvido',
    evidence = a.evidence || jsonb_build_object('encerramento', jsonb_build_object(
      'em', p_hoje,
      'por', 'sistema',
      'motivo', 'A venda do SKU neste canal voltou ao normal (ou deixou de ter histórico suficiente para a comparação) há 3 dias.'))
  where a.organization_id = p_organization_id
    and a.kind = 'venda_anomala'
    and a.subject_key is not null
    and a.status in ('novo', 'em_andamento')
    and a.last_detected_on <= p_hoje - 3;

  get diagnostics v_encerradas = row_count;

  return jsonb_build_object(
    'hoje', p_hoje,
    'detectadas', jsonb_array_length(p_detectadas),
    'legado_encerradas', v_legado,
    'atualizadas', v_atualizadas,
    'continuas', v_continuas,
    'criadas', v_criadas,
    'encerradas', v_encerradas
  );
end;
$fn$;

comment on function public.registrar_vendas_anomalas(uuid, date, jsonb) is
  'D-643: o ciclo de episodio da venda anomala por SKU e canal (assunto <canal>:<sku>), o da D-403: atualiza o aberto, nao reabre o fechado por uma pessoa, cria o novo e encerra depois de 3 dias sem deteccao; encerra o acumulado sem assunto. Sem notificacao. So service_role.';

revoke all on function public.registrar_vendas_anomalas(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_vendas_anomalas(uuid, date, jsonb) to service_role;
