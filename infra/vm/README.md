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
- **Restore completo provado** em container descartável sem rede nem portas
  publicadas, com `pg_restore --no-owner --exit-on-error` encerrando em 0.
  A cópia voltou em `20261022170000`; os 17 SQLs posteriores foram ensaiados
  nela sem falha, e os 64 objetos do catálogo comparados com a VM coincidiram
  em definição. A RPC de reposição respondeu como `authenticated` em READ ONLY.
- Para reproduzir: usar `supabase_admin`, preparar os nomes de roles usados
  nos GRANTs (o dump de database não cria roles), pré-carregar
  `pg_stat_statements`, `pg_cron` e `pg_net` e definir `cron.database_name`
  para o database de ensaio. Desligar a execução dos jobs do cron e a rede.
  Não copiar senhas de roles nem restaurar sobre produção. O snapshot cobre
  a instância; o ensaio do dump usou owners locais com `--no-owner`.

## Dump diário verificado em 19/11

O objeto `diario/2026-11-19.dump`, geração `1795068954797517`, tem
183.547.863 bytes. O MD5 calculado em fluxo coincidiu com o Cloud
Storage. `pg_restore --list` leu 2.786 entradas em um container
isolado. O catálogo inclui as tabelas de migrations, importação e
`job_runs`.

A definição arquivada de `purchase_import_rows` antecede a migration
`20261119120000` da invoice. Para recuperar o schema atual a partir
desse dump, conferir o histórico restaurado e planejar a reaplicação
das migrations posteriores. O checksum e a leitura do catálogo
verificam a transferência e a estrutura. O restore integral também
passou em container descartável, sem rede, portas ou jobs ativos.
`pg_restore --no-owner --exit-on-error` terminou em 0.

A cópia tinha 322 migrations até `20261118211000`, zero índices
inválidos e nenhuma das cinco colunas da invoice. A reaplicação
transacional de `20261119120000` na cópia criou as cinco colunas.
O ensaio executou o SQL da migration sem gravar a entrada no histórico.
O container e seu volume anônimo foram removidos.

O cron e o Ops Agent estavam ativos na consulta de leitura. O arquivo
`/var/log/sb-backup.log` existe na VM e não está listado no arquivo
de configuração consultado do Ops Agent. Na consulta de 36 horas
para a instância, o Cloud Logging não retornou marcadores de sucesso
do dump diário. Coleta e alerta de falha seguem pendentes.

## Fluxo oficial pendente de reconciliação

O workflow versionado ainda usa o Supabase hosted, exige aplicação no Dev e
duas aprovações de `producao`. Ele não foi adaptado nem executado sobre a VM.
Antes de nova migration: identificar o destino real, comparar histórico e
objetos, produzir plano de diferenças e obter as aprovações do fluxo oficial.
Não usar `db push`, `--include-all` nem repair para repetir ou encobrir a
aplicação manual. Migração do workflow e mudanças na VM ficam em outra fatia.
