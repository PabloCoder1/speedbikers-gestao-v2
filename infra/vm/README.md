# Banco de produção na VM

Estado verificado em 18/11/2026, por leitura via IAP/SSH: projeto
`speedbikers-prod`, VM `sb-db`, zona `southamerica-east1-b`, instalação em
`/opt/supabase`, container `supabase-db`, database `postgres` (PostgreSQL 17).
O README upstream na VM descreve o Compose; este arquivo registra o estado
específico do projeto sem copiar configurações ou credenciais.

## Migrations de novembro

O executor anterior relatou aplicação extraordinária por SSH em 18/11, após
ensaio com cópia do banco. A conferência independente encontrou as **17**
versões posteriores a `20261022170000` até `20261118211000` no histórico.
Os objetos de compras/importação conferem com as migrations versionadas.
Detalhes e limites da validação:
[handoff de integração](../../docs/archive/handoffs/2026-11-18_integracao-compras-importacao.md).

Não reaplicar essa faixa. O catálogo não informa o canal da aplicação; ela
não deve ser atribuída ao workflow `migrations-producao.yml`.

## Backups anteriores à aplicação

- Snapshot `sb-db-antes-migrations-nov-20261118`, estado `READY`.
- Bucket `speedbikers-prod-db-backups`, objeto
  `manual/antes-migrations-nov-20261118.dump`, 181.558.306 bytes. Archive CUSTOM
  do PostgreSQL 17.6, 2.596 entradas legíveis por `pg_restore --list`.
- Restore completo ainda deve ser provado em instância descartável com a
  configuração de `pg_cron` da VM; o ensaio em database secundária local
  encontrou a restrição de `cron.database_name`. Nunca restaurar sobre produção.

## Fluxo oficial pendente de reconciliação

O workflow versionado ainda usa o Supabase hosted, exige aplicação no Dev e
duas aprovações de `producao`. Ele não foi adaptado nem executado sobre a VM.
Antes de nova migration: identificar o destino real, comparar histórico e
objetos, produzir plano de diferenças e obter as aprovações do fluxo oficial.
Não usar `db push`, `--include-all` nem repair para repetir ou encobrir a
aplicação manual. Migração do workflow e mudanças na VM ficam em outra fatia.
