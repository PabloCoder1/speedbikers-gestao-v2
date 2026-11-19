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

## Verificação do backup diário

O cron da VM começa às 06:15 UTC. A sondagem de leitura consulta os
metadados de `diario/AAAA-MM-DD.dump` no Cloud Storage. Antes de 07:15 UTC
(04:15 em Brasília), exige a cópia de ontem. A partir desse horário, exige a
de hoje. Essa janela deixa uma hora para gerar, conferir e enviar o dump.

```sh
node infra/vm/check-daily-backup.mjs
node --test infra/vm/check-daily-backup.test.mjs
```

A sondagem requer Node 24, Google Cloud CLI autenticado e permissão
`storage.objects.get` no objeto. Saída em JSON com código 0 para objeto
válido, 1 para nome, tamanho ou data inválidos, 2 quando a consulta falha
(inclusive objeto ausente) ou não retorna JSON legível. A CLI consulta
metadados; o ensaio de restore é a prova separada de legibilidade do dump.

Em 19/11, o objeto diário de 183.547.863 bytes (geração
`1795068954797517`) passou na sondagem. Um restore completo dessa geração
em contêiner descartável isolado confirmou 322 migrations até
`20261118211000` e zero índices inválidos. O SQL de invoice foi ensaiado
em seguida e as cinco colunas apareceram no catálogo.

Para ativar o alerta, executar a sondagem fora da VM do banco, com uma
identidade de leitura, depois da janela diária e encaminhar falhas ao
canal aprovado. Uma execução saudável e uma falha controlada devem confirmar
a entrega antes de fechar o item de monitoramento.

## Fluxo oficial pendente de reconciliação

O workflow versionado ainda usa o Supabase hosted, exige aplicação no Dev e
duas aprovações de `producao`. Ele não foi adaptado nem executado sobre a VM.
Antes de nova migration: identificar o destino real, comparar histórico e
objetos, produzir plano de diferenças e obter as aprovações do fluxo oficial.
Não usar `db push`, `--include-all` nem repair para repetir ou encobrir a
aplicação manual. Migração do workflow e mudanças na VM ficam em outra fatia.
