-- ============================================================
-- Hotfix — proteger leituras da carga de background
--
-- Parte C: dois bursts de até 20 jobs podiam rodar em paralelo
-- (maximum=2), até ~40 avaliações de produto concorrentes pressionando
-- o Postgres ao mesmo tempo que /produtos, /estoque e o dashboard.
-- Reduz para no máximo uma avaliação sequencial de alerts por vez.
-- O burst continua até 20 jobs por invocação — só a concorrência entre
-- invocações muda. dispatch_due_stock_workers não muda de assinatura
-- (usada por outras 4 tasks); só o argumento `maximum` no cron.
-- ============================================================

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname = 'operational-alert-workers-every-minute'
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end $$;

select cron.schedule(
  'operational-alert-workers-every-minute',
  '* * * * *',
  $$select private.dispatch_due_stock_workers('operational_alerts', 1);$$
);
