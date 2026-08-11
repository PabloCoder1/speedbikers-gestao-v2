delete from public.ml_publication_metric_audits

where account_code = 'sb'

and period_start = date '2026-08-04'

and period_end = date '2026-08-10';