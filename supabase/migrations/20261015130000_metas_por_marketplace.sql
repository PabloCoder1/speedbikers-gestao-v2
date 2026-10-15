-- ============================================================
-- D-473 — C-66: a meta do mês por marketplace e a geral (T8 da central)
--
-- Decisão do dono (15/10, pelo A2): uma meta POR MARKETPLACE e uma GERAL;
-- construir já, com a Shopee de fora até haver loja real.
--
-- 1. `monthly_goals` NÃO muda e continua sendo a meta GERAL (as linhas de hoje
--    viram a geral). Trocar a sua única para (organização, mês, escopo)
--    quebraria o `upsert ... onConflict: organization_id,month` da tela de
--    hoje assim que a migration rodasse -- a mesma classe de risco do
--    `p_order_sn` (D-476). As metas de ML e Shopee vão numa tabela nova,
--    `monthly_goals_marketplace`, no mesmo molde (RLS, escrita ADMIN/GESTOR).
-- 2. `get_meta_do_mes` roda o cálculo de sempre (perfil semanal, datas
--    comerciais, ritmos, projeção, ano anterior) uma vez por escopo, cada um
--    sobre a sua série diária:
--      GERAL  = receita bruta do ML + a da Shopee;
--      ML     = a de hoje (`daily_account_metrics`);
--      SHOPEE = vendas válidas das lojas live (a do consolidado, C-53), NULO
--               inteiro sem loja live com pedidos lidos (a regra do C-65).
--    As chaves de sempre são as do GERAL -- sem loja live lida, GERAL = ML
--    em número (pedido de loja live ainda não lida não entra em nenhum
--    escopo), e a tela de hoje não muda --, e os três vêm em `escopos`.
--    Vale sempre GERAL = ML + SHOPEE.
--    `escopos.GERAL` e `escopos.ML` vêm sempre (meta nula quando não
--    cadastrada); `escopos.SHOPEE` vem nulo sem loja live lida.
-- 3. Sem parâmetro novo: a tela de antes e a de depois funcionam nos dois
--    bancos; a nova só mostra os escopos quando a resposta traz `escopos`.
-- 4. A meta geral de um mês que atravessa o Go Live muda de base no meio: a
--    partir do primeiro pedido live lido, o realizado do GERAL soma a Shopee.
--    É a decisão do dono ("uma geral"); a tela avisa na nota da meta.
-- 5. Imposto e alíquota (D-395) seguem da empresa, sem escopo.
-- ============================================================

create table public.monthly_goals_marketplace (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  marketplace text not null check (marketplace in ('ML', 'SHOPEE')),
  revenue_goal numeric(14,2) not null check (revenue_goal > 0),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_goals_marketplace_org_month_mk_key unique (organization_id, month, marketplace)
);

create trigger monthly_goals_marketplace_set_updated_at
  before update on public.monthly_goals_marketplace
  for each row execute function private.set_updated_at();

alter table public.monthly_goals_marketplace enable row level security;

create policy monthly_goals_marketplace_select_member
  on public.monthly_goals_marketplace for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy monthly_goals_marketplace_insert_admin
  on public.monthly_goals_marketplace for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy monthly_goals_marketplace_update_admin
  on public.monthly_goals_marketplace for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy monthly_goals_marketplace_delete_admin
  on public.monthly_goals_marketplace for delete to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.monthly_goals_marketplace from anon, authenticated;
grant select, insert, update, delete on public.monthly_goals_marketplace to authenticated;
grant all on public.monthly_goals_marketplace to service_role;

comment on table public.monthly_goals_marketplace is
  'Meta de faturamento do mes POR MARKETPLACE (D-473, C-66): uma linha por organizacao, mes (dia 1) e marketplace (ML ou SHOPEE). A meta GERAL continua em monthly_goals. Comparada em get_meta_do_mes (escopos.ML e escopos.SHOPEE) com a receita bruta do marketplace. Escrita ADMIN/GESTOR.';


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
  -- D-473 (C-66): o calculo de sempre roda uma vez por escopo.
  v_escopo text;
  v_res jsonb;
  v_saida jsonb := '{}'::jsonb;
  v_shopee_lida boolean;
begin
  v_ini := date_trunc('month', coalesce(p_mes, v_hoje)::timestamp)::date;
  v_fim := (v_ini + interval '1 month' - interval '1 day')::date;
  v_ontem := v_hoje - 1;
  v_ano_ini := (v_ini - interval '1 year')::date;
  v_ano_fim := (v_ano_ini + interval '1 month' - interval '1 day')::date;

  -- D-473 (C-66): a Shopee so entra com loja live de pedidos ja lidos (a
  -- regra do C-65); sem ela, o escopo SHOPEE vem NULO e o GERAL e o ML --
  -- tambem em numero: pedido de loja live ainda nao lida nao entra no GERAL,
  -- para valer sempre GERAL = ML + SHOPEE.
  select exists (
    select 1 from public.shopee_shops s
    where s.organization_id = p_organization_id
      and s.environment = 'live'
      and s.orders_synced_until is not null
  ) into v_shopee_lida;

  foreach v_escopo in array array['GERAL', 'ML', 'SHOPEE'] loop
  if v_escopo = 'SHOPEE' and not v_shopee_lida then
    v_saida := v_saida || jsonb_build_object('SHOPEE', null);
    continue;
  end if;

  -- O primeiro dia com venda DO ESCOPO: antes dele "sem linha" nao e
  -- "vendeu zero". O GERAL comeca no primeiro dos dois.
  select min(x.dia) into v_historico
  from (
    select d.metric_date as dia
    from public.daily_account_metrics d
    where v_escopo in ('GERAL', 'ML')
      and d.organization_id = p_organization_id
    union all
    select v.dia
    from public.shopee_sales_orders v
    join public.shopee_shops s on s.id = v.shopee_shop_id
    where v_escopo in ('GERAL', 'SHOPEE')
      and v_shopee_lida
      and v.organization_id = p_organization_id
      and s.environment = 'live'
      and v.situacao = 'VALIDA'
  ) x;

  -- As 8 semanas completas ate ontem, cortadas no inicio do historico. Sem
  -- historico nenhum nao ha janela: `greatest` ignoraria o NULL e inventaria
  -- 56 dias de venda zero, e a projecao sairia R$ 0,00 em vez de NULL.
  v_ini_janela := case when v_historico is not null then greatest(v_ontem - 55, v_historico) end;

  -- D-406: o efeito de uma data comercial é medido na ocorrência do ano
  -- anterior, com a base das 4 semanas antes dela -- até ~1 ano e 2 meses
  -- antes do início da janela ou do mês.
  v_desde := least(coalesce(v_ini_janela, v_ini), v_ini) - 430;

  v_res := (
    with
    receita_dia as materialized (
      -- D-473: ML, Shopee ou a soma dos dois, conforme o escopo. A Shopee e a
      -- do consolidado (C-53): vendas validas das lojas live, pelo dia de Sao
      -- Paulo; pedido de receita desconhecida fica fora da soma.
      select x.dia, sum(x.receita) as receita
      from (
        select d.metric_date as dia, d.gross_revenue as receita
        from public.daily_account_metrics d
        where v_escopo in ('GERAL', 'ML')
          and d.organization_id = p_organization_id
          and d.metric_date between v_desde and greatest(v_ontem, v_fim)
        union all
        select v.dia, v.receita_bruta
        from public.shopee_sales_orders v
        join public.shopee_shops s on s.id = v.shopee_shop_id
        where v_escopo in ('GERAL', 'SHOPEE')
          and v_shopee_lida
          and v.organization_id = p_organization_id
          and s.environment = 'live'
          and v.situacao = 'VALIDA'
          and v.shopee_created_at >= (v_desde::timestamp at time zone 'America/Sao_Paulo')
          and v.shopee_created_at < ((greatest(v_ontem, v_fim) + 1)::timestamp at time zone 'America/Sao_Paulo')
      ) x
      group by x.dia
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
        case when v_escopo = 'GERAL'
          then (select g.revenue_goal from public.monthly_goals g
                where g.organization_id = p_organization_id and g.month = v_ini)
          else (select g.revenue_goal from public.monthly_goals_marketplace g
                where g.organization_id = p_organization_id and g.month = v_ini and g.marketplace = v_escopo)
        end as meta,
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
  v_saida := v_saida || jsonb_build_object(v_escopo, v_res);
  end loop;

  -- As chaves de sempre sao as do GERAL (a tela de antes continua igual); os
  -- tres escopos vem em `escopos`.
  return (v_saida -> 'GERAL') || jsonb_build_object('escopos', v_saida);
end;
$$;

comment on function public.get_meta_do_mes(uuid, date, date) is
  'Meta do mes e projecao de fechamento (D-395), da organizacao: realizado (receita bruta das vendas validas), atingimento, ritmo contra a meta ponderado pelo perfil semanal, media diaria, meta diaria necessaria e a projecao em tres cenarios (ritmo de 28 dias; menor e maior ritmo entre 7, 14 e 28 dias), mais o mesmo mes do ano anterior quando o historico o cobre inteiro. Hoje entra na projecao pela media, nao pelo parcial. security invoker: a RLS das contas e das lojas decide a receita que a pessoa ve. D-406: o peso de cada dia inclui o efeito das datas comerciais (public.datas_comerciais), medido dia a dia na ocorrencia do ano anterior contra a media do mesmo dia da semana nas 4 semanas antes; dia de data sai do perfil semanal; datas_comerciais lista as do mes, com medido=false quando a ocorrencia anterior esta fora do historico. D-473 (C-66): o calculo roda por escopo -- GERAL (ML + Shopee, meta de monthly_goals), ML (daily_account_metrics, meta de monthly_goals_marketplace) e SHOPEE (vendas validas das lojas live, meta de monthly_goals_marketplace; NULO sem loja live com pedidos lidos) --; as chaves de sempre sao as do GERAL e os tres vem em escopos.';
