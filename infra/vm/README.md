# Banco de produção na VM

Estado verificado em 18/11/2026, por leitura via IAP/SSH: projeto
`speedbikers-prod`, VM `sb-db`, zona `southamerica-east1-b`, instalação em
`/opt/supabase`, container `supabase-db`, database `postgres` (PostgreSQL 17).
O README upstream na VM descreve o Compose; este arquivo registra o estado
específico do projeto sem copiar configurações ou credenciais.

## Alerta de disco

O Ops Agent da `sb-db` publicou séries de utilização para `/dev/sda1` e
`/dev/sda15` na consulta de 20/11/2026. Confirme qual dispositivo contém
`/opt/supabase` e o diretório de dados do Docker na VM (por exemplo, com
`findmnt --target` para cada caminho). Use o dispositivo como aparece na
métrica do Cloud Monitoring e o ID numérico da instância.

```sh
node infra/vm/disk-alert-policy.mjs --project "$PROJECT_ID" \
  --instance-id "$INSTANCE_ID" --device "$DEVICE" --channel-id "$CHANNEL_ID" \
  > disk-alert-policy.json
```

O comando só gera JSON para revisão. A proposta dispara acima de 85% de
uso por 10 minutos. O canal precisa estar confirmado no projeto e a
política deve ser criada e testada com aprovação. A condição mede ocupação;
a perda da telemetria depende de monitoramento separado.

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
O MD5 calculado em fluxo coincidiu com o Cloud Storage, e
`pg_restore --list` leu 2.786 entradas. O restore integral terminou com
código 0 usando `--no-owner --exit-on-error`; as cinco colunas estavam
ausentes antes do SQL `20261119120000`. Esse SQL foi executado em uma
transação na cópia, sem registrar sua versão no histórico. O contêiner
isolado e o volume descartável foram removidos após o ensaio.

A listagem de 20/11 encontrou três dumps diários, de 18 a 20/11,
totalizando 540.814.378 bytes. O bucket tem versionamento e soft delete
de sete dias. A configuração consultada tem zero regras de lifecycle.

Para ativar o alerta, executar a sondagem fora da VM do banco, com uma
identidade de leitura, depois da janela diária e encaminhar falhas ao
canal aprovado. Uma execução saudável e uma falha controlada devem confirmar
a entrega antes de fechar o item de monitoramento.

Para uma sondagem executada como Cloud Run Job, gere a política para revisão:

```sh
node infra/vm/backup-alert-policy.mjs --project "$PROJECT_ID" --region "$REGION" \
  --job "$JOB_NAME" --channel-id "$CHANNEL_ID" > backup-alert-policy.json
```

A política cobre os três estados de erro emitidos em JSON na saída de erro
do job indicado. Uma execução que nunca iniciou ou morreu antes de emitir
JSON exige monitoramento do agendamento e das execuções. São pré-requisitos
para ativação o job externo, o agendamento e um canal confirmado.

O contêiner da sondagem usa a identidade do Cloud Run para solicitar
somente os campos de metadados do objeto diário. Construa a imagem com
`docker build -f infra/vm/Dockerfile.backup-probe infra/vm`. Restrinja o
acesso da identidade ao prefixo `diario/` do bucket de backups.
Execute a verificação normal antes de testar o alerta. Para o ensaio de
entrega, passe `--test-failure` somente como argumento de uma execução
manual do job. O log indica `simulated: true` e a execução encerra com 2.

Em 20/11/2026 (horário de Brasília), o job `sb-backup-check` foi
ativado em `speedbikers-prod`, região `southamerica-east1`, com a imagem
do commit `6def173a` e identidade `sb-backup-probe`. O Cloud Scheduler
`sb-backup-check-diario` chama a API do Cloud Run com a identidade
`sb-backup-scheduler` todos os dias às 07:25 UTC (04:25 em Brasília).
A execução acionada pelo Scheduler `sb-backup-check-v8vjq` terminou
com sucesso. A repetição da falha sintética (`sb-backup-check-x66xz`)
abriu o incidente `0.of9jh2tr03e9` às 22:41 BRT. O e-mail do Google Cloud
Alerting chegou ao canal autorizado. Evidências no
[checkpoint Sentinel](https://github.com/PabloCoder1/speedbikers-gestao-v2/issues/351).

## Fluxo oficial pendente de reconciliação

O workflow versionado ainda usa o Supabase hosted, exige aplicação no Dev e
duas aprovações de `producao`. Ele não foi adaptado nem executado sobre a VM.
Antes de nova migration: identificar o destino real, comparar histórico e
objetos, produzir plano de diferenças e obter as aprovações do fluxo oficial.
Não usar `db push`, `--include-all` nem repair para repetir ou encobrir a
aplicação manual. Migração do workflow e mudanças na VM ficam em outra fatia.

### Comparar o histórico com o candidato

Em uma sessão já autorizada na VM, extraia só as versões aplicadas:

```sh
sudo docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' supabase-db \
  psql -XAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'select version from supabase_migrations.schema_migrations order by version' \
  > catalogo-migrations.txt
```

Transfira o arquivo de versões ao checkout do commit candidato e execute:

```sh
node infra/vm/check-migration-catalog.mjs < catalogo-migrations.txt
```

A saída JSON mostra as pendências posteriores à última versão aplicada. O
código de saída é 0 para `match` ou `pending`, 1 para `blocked` e 2 para entrada
inválida. `blocked` indica lacuna anterior à última versão ou versão do
catálogo ausente no Git. A comparação cobre os identificadores das migrations.
A conferência dos objetos e o teste de upgrade completam a validação antes da
aplicação.

Para registrar o plano revisado, gere o JSON com os hashes SHA-256 do catálogo
e de cada migration pendente. Na segunda aprovação, extraia o catálogo
novamente e verifique o mesmo plano no checkout do commit aprovado:

```sh
node infra/vm/check-migration-catalog.mjs --plan < catalogo-migrations.txt
node infra/vm/check-migration-catalog.mjs --expect-plan "$PLAN_ID" < catalogo-atual.txt
```

`PLAN_ID` é o `plan.id` do JSON da primeira etapa. Uma mudança nas versões
aplicadas ou no conteúdo ou nome de um SQL pendente reprova a verificação.
O ID cobre o catálogo e os SQLs pendentes. Registre também o SHA do commit e
o ambiente de origem do catálogo na revisão.

### Recuperar após falha durante a aplicação

Os quatro SQLs atualmente em revisão incluem seus próprios `BEGIN` e
`COMMIT`. O rollback da transação de um arquivo protege esse arquivo.
Os commits anteriores permanecem aplicados. Em uma falha, interrompa a
sequência, confira o catálogo e os objetos criados, e registre o último
commit confirmado antes de decidir entre retomada e recuperação isolada.
O pg_dump imediatamente anterior e seu catálogo compõem a base de
recuperação. Valide a restauração fora da VM antes de qualquer troca.

Em 21/11, o ensaio em PG17 sem rede partiu do schema e das 324 versões do
dump de 20/11, geração `1795155357048726`. Foram aplicados três arquivos
com versões temporárias. A falha injetada antes do `COMMIT` do quarto
arquivo deixou iguais a impressão digital do schema e o histórico de
327 versões. Em outro contêiner, o mesmo artefato recuperou os 324
identificadores exatos e a constraint e o índice originais do Full.
O ensaio cobre schema e histórico. A recuperação dos dados e a troca
de serviço ainda exigem ensaio próprio para o rollout.
