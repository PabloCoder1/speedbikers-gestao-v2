-- ============================================================
-- Limpeza UNICA do entulho de webhook em `job_runs` (D-222).
--
-- NAO E POLITICA DE RETENCAO, e a distincao decidiu o desenho. D-221 mediu o
-- "88% sem trabalho" em tres janelas e mostrou que ele **ja existia com as 4
-- contas saudaveis**, antes do incidente de D-217: era o defeito que **D-179
-- matou na origem**. O ritmo caiu de 2.664 para ~93 linhas/h. O que sobrou na
-- tabela e MASSA de um defeito morto, nao fluxo corrente -- e massa se limpa
-- uma vez, nao com um mecanismo permanente de escrita destrutiva.
--
-- O RECORTE E DELIBERADAMENTE ESTREITO. So apaga linha que satisfaz as
-- QUATRO condicoes:
--
--   * `job_type = 'sync.webhook.received'` -- nenhum outro tipo e tocado;
--   * `status = 'done'` -- falha NUNCA sai, e falha e o que se investiga;
--   * `processed = 0` -- a linha registra "chegou notificacao e nao havia o
--     que fazer". Quem processou alguma coisa fica;
--   * `started_at` ESTRITAMENTE ANTES do deploy de 2026-09-02 20:53 UTC, o
--     instante em que D-179 entrou no ar. Nada produzido pelo sistema
--     corrigido e apagado.
--
-- Medido no Dev antes de escrever: **278.371 linhas (82,8% da tabela, ~106
-- MB)**. Sobrevivem 32.102 linhas de webhook, 2.249 delas pos-deploy -- a
-- Saude do Sistema continua com dado de sobra.
--
-- A DATA FIXA e proposital, e e o oposto da armadilha registrada no HANDOFF
-- ("fixture com data fixa apodrece"). Aquela regra vale para teste, que roda
-- de novo todo dia; esta migration roda UMA vez e esta ancorada num evento
-- real e datado. Uma janela relativa (`now() - interval`) e que estaria
-- errada aqui: apagaria coisa diferente conforme o dia em que rodasse.
--
-- POR QUE PRECISA DESLIGAR O TRIGGER: `job_runs` e append-only por
-- construcao desde `20260820130000` -- recusa DELETE ate para o dono. E a
-- garantia certa, e ela volta ligada no fim desta migration. **O risco real
-- aqui e esquecer de religar**, e desde D-221 existe teste de integracao
-- entrando pela porta do dono para provar que o trigger esta de pe.
--
-- NAO HA VACUUM FULL. Ele devolveria os 106 MB ao sistema de arquivos, mas
-- pede lock exclusivo na tabela. O espaco liberado fica reutilizavel pelo
-- proprio crescimento de `job_runs`, que insere ~4 mil linhas/dia -- a tabela
-- nao volta a crescer em disco tao cedo.
-- ============================================================

alter table public.job_runs disable trigger job_runs_no_delete;

delete from public.job_runs
where job_type = 'sync.webhook.received'
  and status = 'done'
  and coalesce(processed, 0) = 0
  and started_at < timestamptz '2026-09-02 20:53:00+00';

alter table public.job_runs enable trigger job_runs_no_delete;

-- ------------------------------------------------------------
-- As provas, dentro da propria migration (padrao de D-182 secao 6).
--
-- A primeira e a que importa: sair daqui com o trigger desligado seria trocar
-- 106 MB por uma garantia perdida, e em silencio.
-- ------------------------------------------------------------
do $prova$
declare
  ligado char;
  sobrou_com_trabalho bigint;
  sobrou_pos_deploy bigint;
begin
  select t.tgenabled into ligado
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relname = 'job_runs' and t.tgname = 'job_runs_no_delete';

  if ligado is distinct from 'O' then
    raise exception 'job_runs_no_delete NAO voltou a ficar ligado (tgenabled=%)', coalesce(ligado, '?');
  end if;

  -- As duas asserçoes de sobrevivente so fazem sentido onde havia dado. Num
  -- banco recriado do zero (`db reset`, CI) a tabela nasce VAZIA, e exigir
  -- sobrevivente ali derrubaria a migration por um motivo falso.
  --
  -- E o guarda NAO fica vazio com isso: se o recorte tivesse apagado webhook
  -- demais, os outros `job_type` continuariam na tabela, o `exists` abaixo
  -- seria verdadeiro e as duas checagens acusariam.
  if exists (select 1 from public.job_runs) then
    select count(*) into sobrou_com_trabalho
    from public.job_runs
    where job_type = 'sync.webhook.received' and coalesce(processed, 0) > 0;

    if sobrou_com_trabalho = 0 then
      raise exception 'nenhuma execucao de webhook COM trabalho sobreviveu -- o recorte pegou demais';
    end if;

    select count(*) into sobrou_pos_deploy
    from public.job_runs
    where job_type = 'sync.webhook.received'
      and started_at >= timestamptz '2026-09-02 20:53:00+00';

    if sobrou_pos_deploy = 0 then
      raise exception 'nenhuma execucao pos-deploy sobreviveu -- a data de corte esta errada';
    end if;
  end if;
end;
$prova$;
