-- ============================================================
-- `get_job_failures`: a lista de execucoes que FALHARAM, agrupada por motivo.
--
-- D-273 recusou a tabela "Execucoes recentes" que o frame de `/sincronizacao`
-- desenha, com quatro medicoes -- e deixou UM item aberto por escrito: "uma
-- lista so de falhas seria util, e exige RPC nova com decisao propria (expor
-- log de execucao a web)". Esta e a RPC, e a decisao esta tomada abaixo.
--
-- ------------------------------------------------------------
-- 1. POR QUE AGRUPADA, E NAO UMA LISTA CRUA
--
-- A razao da recusa de D-273 era o firehose: `sync.webhook.received` e 65% das
-- execucoes, entao "as 25 mais recentes" seriam 25 webhooks. Medido agora, no
-- Dev, o firehose ATRAVESSA o recorte de falhas:
--
--     falhas em 7 dias ............................ 473 (de 51.896 execucoes)
--     delas, `sync.webhook.received` .............. 370 -> 78%
--     motivos DISTINTOS entre as 473 .............. 170
--
-- Uma lista crua de falhas seria a mesma tela inutil com outro filtro. O que
-- muda o resultado e a ASSINATURA do motivo: os textos carregam ids ("404 para
-- GET /post-purchase/v2/claims/5570387932/returns"), e sem eles as 473 falhas
-- viram poucas familias.
--
--     motivos crus ................................ 170
--     assinaturas (digitos viram #) ............... 15
--     assinaturas (SO corridas de 4+ digitos) ..... 16
--
-- **A regra escolhida e a de 4+ digitos**, e a diferenca entre 15 e 16 e o que
-- decide: normalizar TODO digito apaga o codigo HTTP -- 403, 404 e 500 do mesmo
-- endpoint viram uma linha so, e o codigo e justamente o diagnostico. Com 4+,
-- `404` sobrevive e o id de dez digitos vira `#`.
--
-- A normalizacao e DECLARADA na tela, nao escondida: a coluna se chama motivo
-- e o painel diz que numeros longos viraram `#`. Agrupar por regra dita e
-- diferente de inventar categoria (D-023).
--
-- ------------------------------------------------------------
-- 2. A DECISAO DE EXPOSICAO
--
-- `job_runs` tem RLS ligada e ZERO policies desde 20260820130000: ninguem le
-- pela Data API, nem `anon` nem `authenticated`. Isso NAO muda -- a tabela
-- continua fechada, e o teste que fixa isso (`job_runs permanece fechada`)
-- continua valendo.
--
-- O que abre e uma JANELA: esta funcao, `security definer`, com a autorizacao
-- REFEITA dentro (ADMIN), devolvendo agregado -- nunca a linha. Fora do
-- agregado ficam `dedupe_key` (19% carregam UUID solto, D-273), `job_id`,
-- `attempt` e `processed`: sao chaves internas do worker, e o que a tela
-- pergunta e "o que esta quebrado", nao "qual foi a execucao 4.312".
--
-- O escopo copia `get_system_health` (D-209): organizacoes onde o chamador e
-- ADMIN, MAIS os jobs de plataforma (organizacao que nao existe no catalogo),
-- que e o que impede o escopo de apagar o heartbeat.
--
-- ------------------------------------------------------------
-- 3. O INDICE, MEDIDO ANTES E DEPOIS (transacao revertida contra o Dev)
--
--     sem indice ..... 82,8 ms, 9.626 buffers, Seq Scan descartando 106.071
--     com o parcial ...  7,3 ms,   365 buffers, Bitmap Index Scan
--
-- 11x, e o indice custa quase nada: e PARCIAL sobre `status = 'failed'`, que
-- sao 2.967 das 106.543 linhas (2,8%).
-- ============================================================

create index if not exists job_runs_failures_idx
  on public.job_runs (finished_at desc)
  where status = 'failed';

comment on index public.job_runs_failures_idx is
  'Sustenta get_job_failures: parcial sobre status=failed (2.967 de 106.543 linhas no Dev). Sem ele a consulta faz Seq Scan e custa 82,8 ms; com ele, 7,3 ms.';

create or replace function public.get_job_failures(
  p_days integer default 7,
  p_limit integer default 50
)
returns table (
  job_type text,
  reason_signature text,
  failures bigint,
  distinct_reasons bigint,
  retryable_failures bigint,
  first_failed_at timestamptz,
  last_failed_at timestamptz,
  sample_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with guard as (
    -- A autorizacao e refeita aqui dentro, nunca herdada de quem chamou.
    select exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
    ) as ok
  ),
  orgs_administradas as (
    -- Papel e organizacao na MESMA linha (D-180).
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
  ),
  falhas as (
    select
      r.job_type,
      -- A assinatura: corridas de 4+ digitos viram `#`, entao o codigo HTTP
      -- (3 digitos) sobrevive e o id de dez nao. `reason` e NOT NULL quando
      -- `status = 'failed'`? Nao: o CHECK exige `retryable`, nao `reason` --
      -- por isso o coalesce, que nomeia a ausencia em vez de sumir com a linha.
      left(regexp_replace(coalesce(r.reason, '(sem motivo registrado)'), '[0-9]{4,}', '#', 'g'), 300)
        as assinatura,
      r.reason,
      r.retryable,
      r.finished_at
    from public.job_runs r
    where r.status = 'failed'
      -- Janela limitada no proprio SQL: `p_days` fora de 1..90 nao vira erro
      -- nem varredura da tabela inteira, vira o extremo mais proximo.
      and r.finished_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90))
      and (
        r.organization_id in (select organization_id from orgs_administradas)
        or not exists (
          select 1 from public.organizations o where o.id = r.organization_id
        )
      )
  )
  select
    f.job_type,
    f.assinatura,
    count(*)::bigint,
    count(distinct f.reason)::bigint,
    count(*) filter (where f.retryable)::bigint,
    min(f.finished_at),
    max(f.finished_at),
    -- Um exemplo CRU da familia, o mais recente: e ele que devolve o id que a
    -- assinatura apagou, e sem ele a linha nao daria para investigar.
    (array_agg(f.reason order by f.finished_at desc))[1]
  from guard g
  cross join falhas f
  where g.ok
  group by f.job_type, f.assinatura
  order by count(*) desc, max(f.finished_at) desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

comment on function public.get_job_failures(integer, integer) is
  'Execucoes que falharam, agrupadas por job_type + assinatura do motivo (corridas de 4+ digitos viram #, para o codigo HTTP sobreviver ao id). Janela em dias (1..90, padrao 7). Autorizacao ADMIN refeita dentro (security definer): job_runs continua com RLS e zero policies. Escopo: organizacoes administradas pelo chamador mais os jobs de plataforma (D-209). No Dev, 473 falhas em 7 dias com 170 motivos crus viram 16 linhas.';

-- ============================================================
-- ACL explicita (20260902194500): funcao nova em `public` nao nasce
-- executavel por ninguem, e `anon` nunca deve alcancar log de execucao.
-- ============================================================

revoke all on function public.get_job_failures(integer, integer) from public, anon;
grant execute on function public.get_job_failures(integer, integer) to authenticated, service_role;
