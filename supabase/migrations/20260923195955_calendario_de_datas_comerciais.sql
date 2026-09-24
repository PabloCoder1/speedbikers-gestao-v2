-- D-406 — Calendário de datas comerciais na meta do mês.
--
-- A projeção de D-395 pesava cada dia pelo dia da semana e declarava que não
-- considerava datas comerciais. Medido no Dev (pedidos de 21/08/2025 a
-- 14/09/2026), cada dia contra a média do mesmo dia da semana antes da data:
--
--   Black Friday 2025       sexta +42%, sábado +25%, quinta +16%, a segunda
--                           seguinte +18%; segunda e terça ANTES -7% e -10%
--   Natal e Ano Novo        22/12 -31%, 23/12 -45%, 24/12 -59%, 25/12 -65%,
--                           até 01/01 -63%; de 02 a 04/01 ainda -6% a -13%
--   Carnaval 2026           segunda -32%, terça -38%, sexta antes -16%
--   Dia das Mães 2026       a semana antes +6% a +40%
--   Dia dos Pais 2026       a semana antes +16% a +45%
--   Dia do Consumidor 2026  quase neutro (domingo +15%)
--
-- O efeito tem sinal e forma: um "+X% na semana" apagaria a sexta da Black
-- Friday e a véspera de Natal. A regra: o peso de cada dia passa a ser o do
-- dia da semana VEZES o efeito medido no mesmo dia relativo à data, na
-- ocorrência do ano anterior, contra a média do mesmo dia da semana nas 4
-- semanas antes dela. Entra no esperado até ontem, na projeção dos dias que
-- faltam e no ritmo recente (dias de data não inflam o nível); e o dia de data
-- sai do perfil da semana. Sem a ocorrência anterior dentro do histórico, a
-- data é dita (`medido: false`) e não pesa.
--
-- As datas são regras por ano (Carnaval pela Páscoa, segundo domingo de maio
-- e de agosto, sexta depois da quarta quinta de novembro), não uma tabela:
-- datas próprias da loja ficam para quando houver pedido.

-- Páscoa pelo algoritmo de Meeus/Jones/Butcher (calendário gregoriano).
create or replace function public.pascoa(p_ano integer)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  a integer := p_ano % 19;
  b integer := p_ano / 100;
  c integer := p_ano % 100;
  d integer := b / 4;
  e integer := b % 4;
  f integer := (b + 8) / 25;
  g integer := (b - f + 1) / 3;
  h integer := (19 * a + b - d - g + 15) % 30;
  i integer := c / 4;
  k integer := c % 4;
  l integer := (32 + 2 * e + 2 * i - h - k) % 7;
  m integer := (a + 11 * h + 22 * l) / 451;
begin
  return make_date(p_ano, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
end;
$$;

-- As datas comerciais de um ano: a âncora e a janela em dias relativos a ela
-- (`de` a `ate`), do alcance medido no Dev.
create or replace function public.datas_comerciais(p_ano integer)
returns table (nome text, ancora date, de integer, ate integer)
language sql
immutable
set search_path = ''
as $$
  select t.nome, t.ancora, t.de, t.ate
  from (values
    ('Carnaval', public.pascoa(p_ano) - 47, -4, 1),
    ('Dia do Consumidor', make_date(p_ano, 3, 15), -3, 1),
    ('Dia das Mães',
      make_date(p_ano, 5, 1) + ((7 - extract(isodow from make_date(p_ano, 5, 1))::integer) % 7) + 7, -6, 0),
    ('Dia dos Pais',
      make_date(p_ano, 8, 1) + ((7 - extract(isodow from make_date(p_ano, 8, 1))::integer) % 7) + 7, -6, 0),
    ('Black Friday',
      make_date(p_ano, 11, 1) + ((4 - extract(isodow from make_date(p_ano, 11, 1))::integer + 7) % 7) + 22, -4, 3),
    ('Natal e Ano Novo', make_date(p_ano, 12, 25), -3, 10)
  ) as t(nome, ancora, de, ate)
$$;

-- Em `public`, e não em `private`: `get_meta_do_mes` roda como quem chama
-- (`security invoker`), e `authenticated` não tem acesso ao schema `private`.
-- São só contas de calendário, sem dado nenhum.
revoke all on function public.pascoa(integer) from public, anon;
revoke all on function public.datas_comerciais(integer) from public, anon;
grant execute on function public.pascoa(integer) to authenticated, service_role;
grant execute on function public.datas_comerciais(integer) to authenticated, service_role;

create or replace function public.get_meta_do_mes(
  p_organization_id uuid,
  p_mes date default null,
  p_hoje date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini date;
  v_fim date;
  v_ontem date;
  v_historico date;
  v_ini_janela date;
  v_ano_ini date;
  v_ano_fim date;
  v_desde date;
begin
  v_ini := date_trunc('month', coalesce(p_mes, v_hoje)::timestamp)::date;
  v_fim := (v_ini + interval '1 month' - interval '1 day')::date;
  v_ontem := v_hoje - 1;
  v_ano_ini := (v_ini - interval '1 year')::date;
  v_ano_fim := (v_ano_ini + interval '1 month' - interval '1 day')::date;

  -- O primeiro dia com venda: antes dele "sem linha" nao e "vendeu zero".
  select min(d.metric_date) into v_historico
  from public.daily_account_metrics d
  where d.organization_id = p_organization_id;

  -- As 8 semanas completas ate ontem, cortadas no inicio do historico. Sem
  -- historico nenhum nao ha janela: `greatest` ignoraria o NULL e inventaria
  -- 56 dias de venda zero, e a projecao sairia R$ 0,00 em vez de NULL.
  v_ini_janela := case when v_historico is not null then greatest(v_ontem - 55, v_historico) end;

  -- D-406: o efeito de uma data comercial é medido na ocorrência do ano
  -- anterior, com a base das 4 semanas antes dela -- até ~1 ano e 2 meses
  -- antes do início da janela ou do mês.
  v_desde := least(coalesce(v_ini_janela, v_ini), v_ini) - 430;

  return (
    with
    receita_dia as materialized (
      select d.metric_date as dia, sum(d.gross_revenue) as receita
      from public.daily_account_metrics d
      where d.organization_id = p_organization_id
        and d.metric_date between v_desde and greatest(v_ontem, v_fim)
      group by d.metric_date
    ),
    -- D-406: as datas comerciais que tocam a janela do perfil ou o mês, cada
    -- uma com a ocorrência do ano anterior, onde o efeito é medido.
    ocorrencias as materialized (
      select e.nome, e.ancora, e.de, e.ate, p.ancora as ancora_ant
      from generate_series(
             extract(year from least(coalesce(v_ini_janela, v_ini), v_ini))::integer - 1,
             extract(year from greatest(v_ontem, v_fim))::integer) y(ano)
      cross join lateral public.datas_comerciais(y.ano) e
      join lateral public.datas_comerciais(y.ano - 1) p on p.nome = e.nome
      where e.ancora + e.ate >= least(coalesce(v_ini_janela, v_ini), v_ini)
        and e.ancora + e.de <= greatest(v_ontem, v_fim)
    ),
    dias_evento as materialized (
      select o.nome, o.ancora, o.ancora + k as dia, o.ancora_ant + k as dia_ant, k
      from ocorrencias o
      cross join generate_series(o.de, o.ate) k
    ),
    -- A base de cada ocorrência do ano anterior: a média por dia da semana das
    -- 4 semanas antes da janela dela, SÓ dentro do histórico (sem linha ali é
    -- venda zero, como na janela do perfil). Fora do histórico, nada é medido.
    base_evento as materialized (
      select o.nome, o.ancora, extract(isodow from g.d)::integer as dow, avg(coalesce(r.receita, 0)) as media
      from ocorrencias o
      cross join generate_series((o.ancora_ant + o.de - 28)::timestamp, (o.ancora_ant + o.de - 1)::timestamp, interval '1 day') g(d)
      left join receita_dia r on r.dia = g.d::date
      where v_historico is not null
        and o.ancora_ant + o.de - 28 >= v_historico
      group by o.nome, o.ancora, extract(isodow from g.d)
    ),
    -- O efeito do dia: a venda do mesmo dia da data no ano anterior contra a
    -- base do MESMO dia da semana. Vale dia a dia: a Black Friday sobe na
    -- sexta e a véspera de Natal desce, e um "+X% na semana" apagaria isso.
    fator_evento as materialized (
      select de.nome, de.ancora, de.dia, de.k,
             case when b.media > 0 then coalesce(r.receita, 0) / b.media end as fator
      from dias_evento de
      join base_evento b
        on b.nome = de.nome and b.ancora = de.ancora and b.dow = extract(isodow from de.dia_ant)::integer
      left join receita_dia r on r.dia = de.dia_ant
    ),
    efeito_dia as materialized (
      select fe.dia, avg(fe.fator) as e
      from fator_evento fe
      where fe.fator is not null
      group by fe.dia
    ),
    -- Dia sem linha DENTRO do historico e dia sem venda: o rollup so grava
    -- dia com venda (units_sold > 0).
    janela as materialized (
      select g.dia::date as dia, extract(isodow from g.dia)::int as dow, coalesce(r.receita, 0) as receita,
             coalesce(ef.e, 1) as e,
             exists (select 1 from dias_evento de where de.dia = g.dia::date) as em_evento
      from generate_series(v_ini_janela::timestamp, v_ontem::timestamp, interval '1 day') g(dia)
      left join receita_dia r on r.dia = g.dia::date
      left join efeito_dia ef on ef.dia = g.dia::date
    ),
    -- D-406: dia de data comercial não entra no perfil da semana -- a sexta da
    -- Black Friday não pode virar "a sexta normal".
    perfil as (
      select j.dow, avg(j.receita) as media, count(*) as n
      from janela j
      where not j.em_evento
      group by j.dow
    ),
    -- O perfil so vale com os sete dias da semana, cada um visto duas vezes
    -- ou mais; senao todo dia pesa 1 e a tela diz que o perfil e plano.
    perfil_ok as (
      select (count(*) = 7 and coalesce(min(p.n), 0) >= 2 and coalesce(avg(p.media), 0) > 0) as ok,
             avg(p.media) as media_geral
      from perfil p
    ),
    fatores as materialized (
      select g.dow, case when po.ok then p.media / po.media_geral else 1 end as fator
      from generate_series(1, 7) g(dow)
      cross join perfil_ok po
      left join perfil p on p.dow = g.dow
    ),
    -- Ritmo dessazonalizado dos ultimos N dias; so existe com os N dias
    -- inteiros dentro do historico.
    niveis as (
      select k.dias,
             case when count(j.dia) = k.dias and sum(f.fator * j.e) > 0 then sum(j.receita) / sum(f.fator * j.e) end as nivel
      from (values (7), (14), (28)) k(dias)
      left join janela j on j.dia > v_ontem - k.dias
      left join fatores f on f.dow = j.dow
      group by k.dias
    ),
    dias_mes as (
      select g.dia::date as dia, extract(isodow from g.dia)::int as dow
      from generate_series(v_ini::timestamp, v_fim::timestamp, interval '1 day') g(dia)
    ),
    mes as (
      select
        count(*) as dias_no_mes,
        count(*) filter (where dm.dia < v_hoje) as dias_completos,
        count(*) filter (where dm.dia >= v_hoje) as dias_restantes,
        coalesce(sum(r.receita) filter (where dm.dia < v_hoje), 0) as ate_ontem,
        coalesce(sum(r.receita) filter (where dm.dia = v_hoje), 0) as hoje,
        coalesce(sum(r.receita) filter (where dm.dia <= v_hoje), 0) as realizado,
        -- D-406: o peso do dia é o do dia da semana vezes o efeito da data.
        coalesce(sum(f.fator * coalesce(ef.e, 1)) filter (where dm.dia < v_hoje), 0) as f_passado,
        coalesce(sum(f.fator * coalesce(ef.e, 1)) filter (where dm.dia >= v_hoje), 0) as f_restante,
        sum(f.fator * coalesce(ef.e, 1)) as f_mes,
        sum(f.fator) as f_mes_sem_datas
      from dias_mes dm
      join fatores f on f.dow = dm.dow
      left join receita_dia r on r.dia = dm.dia
      left join efeito_dia ef on ef.dia = dm.dia
    ),
    ano as (
      select
        sum(r.receita) as total,
        coalesce(sum(r.receita) filter (where r.dia <= (v_ontem - interval '1 year')::date), 0) as ate_dia
      from receita_dia r
      where r.dia between v_ano_ini and v_ano_fim
    ),
    calc as (
      select
        m.*,
        (select g.revenue_goal from public.monthly_goals g
          where g.organization_id = p_organization_id and g.month = v_ini) as meta,
        (select n.nivel from niveis n where n.dias = 7) as n7,
        (select n.nivel from niveis n where n.dias = 14) as n14,
        (select n.nivel from niveis n where n.dias = 28) as n28,
        (select po.ok from perfil_ok po) as perfil_semanal,
        case when v_fim < v_hoje then 'encerrado' when v_ini > v_hoje then 'futuro' else 'em_curso' end as situacao
      from mes m
    ),
    final as (
      select
        c.*,
        coalesce(c.n28, c.n14, c.n7) as nivel,
        least(c.n7, c.n14, c.n28) as nivel_min,
        greatest(c.n7, c.n14, c.n28) as nivel_max,
        case when c.meta is not null and c.f_mes > 0 then c.meta * c.f_passado / c.f_mes end as esperado
      from calc c
    )
    select jsonb_build_object(
      'mes', v_ini,
      'fim', v_fim,
      'hoje', v_hoje,
      'situacao', x.situacao,
      'inicio_historico', v_historico,
      'meta', x.meta,
      'realizado', case when x.situacao <> 'futuro' then round(x.realizado, 2) end,
      'realizado_ate_ontem', case when x.situacao = 'em_curso' then round(x.ate_ontem, 2) end,
      'realizado_hoje', case when x.situacao = 'em_curso' then round(x.hoje, 2) end,
      'dias_no_mes', x.dias_no_mes,
      'dias_completos', case when x.situacao = 'em_curso' then x.dias_completos end,
      'dias_restantes', case when x.situacao = 'em_curso' then x.dias_restantes end,
      'atingimento', case when x.situacao <> 'futuro' and x.meta > 0 then round(x.realizado / x.meta, 4) end,
      'faltam', case when x.situacao <> 'futuro' and x.meta is not null then round(greatest(x.meta - x.realizado, 0), 2) end,
      'esperado_ate_ontem', case when x.situacao = 'em_curso' then round(x.esperado, 2) end,
      'diferenca_ritmo', case when x.situacao = 'em_curso' and x.esperado is not null then round(x.ate_ontem - x.esperado, 2) end,
      'media_diaria', case when x.situacao = 'em_curso' and x.dias_completos > 0 then round(x.ate_ontem / x.dias_completos, 2) end,
      'meta_diaria_necessaria', case when x.situacao = 'em_curso' and x.meta is not null
        then round(greatest(x.meta - x.ate_ontem, 0) / x.dias_restantes, 2) end,
      'aumento_necessario', case when x.situacao = 'em_curso' and x.meta is not null and x.dias_completos > 0 and x.ate_ontem > 0
        then round((greatest(x.meta - x.ate_ontem, 0) / x.dias_restantes) / (x.ate_ontem / x.dias_completos) - 1, 4) end,
      'perfil_semanal', coalesce(x.perfil_semanal, false),
      'fatores', (select jsonb_agg(jsonb_build_object('dia_semana', f.dow, 'fator', round(f.fator, 3)) order by f.dow) from fatores f),
      'ritmos', jsonb_build_object('sete', round(x.n7, 2), 'catorze', round(x.n14, 2), 'vinte_oito', round(x.n28, 2)),
      'projecao', case when x.situacao = 'em_curso' and x.nivel is not null then jsonb_build_object(
          'ritmo', round(x.ate_ontem + x.nivel * x.f_restante, 2),
          'conservador', round(x.ate_ontem + x.nivel_min * x.f_restante, 2),
          'otimista', round(x.ate_ontem + x.nivel_max * x.f_restante, 2)
        ) end,
      'ano_anterior', case when v_historico is not null and v_historico <= v_ano_ini then jsonb_build_object(
          'receita_mes', round(a.total, 2),
          'receita_ate_mesmo_dia', case when x.situacao = 'em_curso' then round(a.ate_dia, 2) end,
          'projecao_sazonal', case when x.situacao = 'em_curso' and x.dias_completos > 0 and a.ate_dia > 0 and a.total > 0
            then round(x.ate_ontem * a.total / a.ate_dia, 2) end,
          'crescimento', case
            when x.situacao = 'em_curso' and x.dias_completos > 0 and a.ate_dia > 0 then round(x.ate_ontem / a.ate_dia - 1, 4)
            when x.situacao = 'encerrado' and a.total > 0 then round(x.realizado / a.total - 1, 4) end
        ) end,
      'dias_sem_venda', (select count(*) from janela j where j.receita = 0),
      -- D-406: as datas comerciais que tocam o mês, com o efeito medido.
      'datas_comerciais', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'nome', o.nome,
            'data', o.ancora,
            'inicio', o.ancora + o.de,
            'fim', o.ancora + o.ate,
            'medida_em', o.ancora_ant,
            'medido', exists (
              select 1 from fator_evento fe
              where fe.nome = o.nome and fe.ancora = o.ancora and fe.fator is not null),
            -- A variação média dos dias da janela contra um dia normal.
            'efeito', (
              select round(avg(fe.fator) - 1, 4) from fator_evento fe
              where fe.nome = o.nome and fe.ancora = o.ancora and fe.fator is not null),
            -- Quanto a data muda o mês inteiro, pelo peso de cada dia.
            'efeito_no_mes', (
              select round(sum(f.fator * (fe.fator - 1)) / nullif(x.f_mes_sem_datas, 0), 4)
              from fator_evento fe
              join fatores f on f.dow = extract(isodow from fe.dia)::integer
              where fe.nome = o.nome and fe.ancora = o.ancora and fe.fator is not null
                and fe.dia between v_ini and v_fim),
            'dias', (
              select coalesce(jsonb_agg(jsonb_build_object('dia', fe.dia, 'fator', round(fe.fator, 3)) order by fe.dia), '[]'::jsonb)
              from fator_evento fe
              where fe.nome = o.nome and fe.ancora = o.ancora and fe.fator is not null
                and fe.dia between v_ini and v_fim)
          ) order by o.ancora), '[]'::jsonb)
        from ocorrencias o
        where o.ancora + o.ate >= v_ini
          and o.ancora + o.de <= v_fim
      )
    )
    from final x
    cross join ano a
  );
end;
$$;

comment on function public.get_meta_do_mes(uuid, date, date) is
  'Meta do mes e projecao de fechamento (D-395), da organizacao: realizado (receita bruta das vendas validas, daily_account_metrics), atingimento, ritmo contra a meta ponderado pelo perfil semanal, media diaria, meta diaria necessaria e a projecao em tres cenarios (ritmo de 28 dias; menor e maior ritmo entre 7, 14 e 28 dias), mais o mesmo mes do ano anterior quando o historico o cobre inteiro. Hoje entra na projecao pela media, nao pelo parcial. Eventos comerciais nao entram. security invoker: a RLS das contas decide a receita que a pessoa ve. D-406: o peso de cada dia inclui o efeito das datas comerciais (public.datas_comerciais), medido dia a dia na ocorrencia do ano anterior contra a media do mesmo dia da semana nas 4 semanas antes; dia de data sai do perfil semanal; datas_comerciais lista as do mes, com medido=false quando a ocorrencia anterior esta fora do historico.';

revoke all on function public.get_meta_do_mes(uuid, date, date) from public, anon;
grant execute on function public.get_meta_do_mes(uuid, date, date) to authenticated, service_role;
