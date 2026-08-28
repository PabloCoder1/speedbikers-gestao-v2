-- Métricas de SAC (Fase 7B, D-115) — a RPC que espelha as definições
-- canônicas de docs/METRICS.md secao 5B (o documento é a fonte; isto é o
-- espelho executável).
--
-- security invoker + soma em SQL (docs/ARCHITECTURE.md secao 21, "zero
-- agregação em JavaScript"): a RLS de support_cases/support_case_deadlines/
-- support_messages decide o escopo por chamador — usuário sem acesso a uma
-- conta não conta os atendimentos dela.
--
-- "Prazos vencidos" é computado NA LEITURA (due_at < now() sobre linhas
-- ACTIVE): o job que marcaria BREACHED continua não existindo (D-107), e
-- ler não muda estado. "Tempo de resolução" fica FORA de propósito —
-- created_at é relógio de ingestão e resolved_at mistura relógios (triagem
-- = now(), auto-resolve D-102 = relógio do ML): um claim backfilled daria
-- duração NEGATIVA. Ver METRICS.md para as ressalvas completas.
--
-- Primeira resposta: só QUESTION/POST_SALE_MESSAGE (o transcript de CLAIM é
-- um piso, D-106), os dois lados no relógio do Mercado Livre (occurred_at).
-- O caso raro "loja falou antes do cliente" fica fora (fout > fin exige a
-- resposta DEPOIS da pergunta).

create function public.get_support_metrics(p_days integer default 7)
returns table (
  abertos_total bigint,
  abertos_question bigint,
  abertos_message bigint,
  abertos_claim bigint,
  aguardando_loja bigint,
  mediacoes_abertas bigint,
  prazos_proximas_24h bigint,
  prazos_vencidos bigint,
  novos_question bigint,
  novos_message bigint,
  novos_claim bigint,
  resolvidos_periodo bigint,
  mediana_primeira_resposta_horas numeric
)
language sql
security invoker
set search_path = ''
as $$
  with abertos as (
    select channel, is_mediation,
           (channel = 'QUESTION'
            or last_inbound_at > coalesce(last_outbound_at, '-infinity'::timestamptz)) as aguardando
    from public.support_cases
    where internal_status <> 'RESOLVIDO'
  ),
  prazos as (
    select count(*) filter (where due_at >= now() and due_at < now() + interval '24 hours') as proximas,
           count(*) filter (where due_at < now()) as vencidos
    from public.support_case_deadlines
    where status = 'ACTIVE' and due_at is not null
  ),
  fluxo as (
    select count(*) filter (where channel = 'QUESTION' and created_at >= now() - make_interval(days => p_days)) as novos_q,
           count(*) filter (where channel = 'POST_SALE_MESSAGE' and created_at >= now() - make_interval(days => p_days)) as novos_m,
           count(*) filter (where channel = 'CLAIM' and created_at >= now() - make_interval(days => p_days)) as novos_c,
           count(*) filter (where resolved_at >= now() - make_interval(days => p_days)) as resolvidos
    from public.support_cases
  ),
  resposta as (
    select percentile_cont(0.5) within group (
             order by extract(epoch from (fout - fin)) / 3600.0
           ) as mediana_horas
    from (
      select min(m.occurred_at) filter (where m.direction = 'INBOUND') as fin,
             min(m.occurred_at) filter (where m.direction = 'OUTBOUND') as fout
      from public.support_messages m
      join public.support_cases c on c.id = m.support_case_id
      where c.channel in ('QUESTION', 'POST_SALE_MESSAGE')
      group by m.support_case_id
    ) pares
    where fin is not null and fout is not null and fout > fin
      and fin >= now() - make_interval(days => p_days)
  )
  select
    (select count(*) from abertos),
    (select count(*) from abertos where channel = 'QUESTION'),
    (select count(*) from abertos where channel = 'POST_SALE_MESSAGE'),
    (select count(*) from abertos where channel = 'CLAIM'),
    (select count(*) from abertos where aguardando),
    (select count(*) from abertos where is_mediation),
    prazos.proximas,
    prazos.vencidos,
    fluxo.novos_q,
    fluxo.novos_m,
    fluxo.novos_c,
    fluxo.resolvidos,
    round(resposta.mediana_horas::numeric, 1)
  from prazos, fluxo, resposta;
$$;

revoke execute on function public.get_support_metrics(integer) from public, anon;
grant execute on function public.get_support_metrics(integer) to authenticated, service_role;
