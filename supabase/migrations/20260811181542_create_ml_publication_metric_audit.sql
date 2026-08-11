create table public.ml_publication_metric_audits (
  account_code text not null,

  period_start date not null,

  period_end date not null,

  listing_id text not null,

  title text,

  sku_values text,

  variation_values text,

  report_rows integer not null
    default 1
    check (
      report_rows > 0
    ),

  official_sales integer not null
    default 0
    check (
      official_sales >= 0
    ),

  official_units integer not null
    default 0
    check (
      official_units >= 0
    ),

  official_gross_brl_rounded numeric(18, 2)
    not null
    default 0
    check (
      official_gross_brl_rounded >= 0
    ),

  source_filename text not null,

  imported_at timestamptz
    not null
    default now(),

  primary key (
    account_code,
    period_start,
    period_end,
    listing_id
  )
);


create index
ml_publication_metric_audits_period_idx

on public.ml_publication_metric_audits (
  account_code,
  period_start,
  period_end
);


alter table
public.ml_publication_metric_audits
enable row level security;


revoke all
on table
public.ml_publication_metric_audits
from anon;


revoke all
on table
public.ml_publication_metric_audits
from authenticated;