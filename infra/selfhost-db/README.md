# Banco do Speed Bikers: Supabase próprio no Google Cloud

Pilha oficial do Supabase para auto-hospedagem (`docker compose`, commit fixado em
`startup.sh`) numa VM do projeto `speedbikers-prod`. Plano e decisão:
`docs/database-migration/MIGRATION_PLAN.md`, Parte 3. **Sem segredo neste diretório**: o
`.env` da pilha mora no Secret Manager (`selfhost-supabase-env`).

## O que existe

| Recurso | Nome | Observação |
|---|---|---|
| VM | `sb-db`, `southamerica-east1-b`, `e2-standard-2` (2 vCPU, 8 GB), Debian 12 | Proteção contra exclusão ligada. Sem IP público aberto: só SSH pelo IAP |
| Disco | `sb-db`, 50 GB `pd-balanced` | Snapshot diário às 07:00 UTC, 7 dias (`sb-db-diario`) |
| IP externo | `sb-db-ip` (reservado) | Para o DNS do domínio do banco. Sem regra de entrada 80/443 ainda |
| Sub-rede | `v3-db` (`10.20.1.0/24`) em `v3-vpc` | A mesma VPC da saída do Cloud Run |
| Firewall | `sb-db-allow-iap-ssh` (22 pelo IAP), `sb-db-allow-run-gateway` (8000 só de `10.20.0.0/24`) | Nada mais entra |
| Bucket | `gs://speedbikers-prod-db-backups` | `diario/` (35 dias, versionado, sem acesso público), `import/` (carga) |
| Conta de serviço | `sb-db-vm` | Lê o segredo, escreve no bucket, escreve logs e métricas. Nada além |
| Segredo | `selfhost-supabase-env` | O `.env` da pilha. Mudou o segredo: nova versão e rodar `startup.sh` de novo |

## Operar

SSH (sem porta aberta; o `--project` é obrigatório, o padrão do `gcloud` nesta máquina é outro):

```bash
gcloud compute ssh sb-db --project speedbikers-prod --zone southamerica-east1-b --tunnel-through-iap
```

Na VM: `sudo docker ps` (11 contêineres), `sudo tail /var/log/sb-startup.log`,
`sudo tail /var/log/sb-backup.log`, pilha em `/opt/supabase`.

- **`startup.sh`** roda a cada boot, é idempotente e reaplica o `.env` do segredo. Vem como
  metadado `startup-script`; o `backup.sh` vem como `backup-script`. Para mudar:
  `gcloud compute instances add-metadata sb-db --metadata-from-file startup-script=...`.
- **`backup.sh`**: `pg_dump -Fc` completo às 06:15 UTC (03:15 em Brasília) para `diario/AAAA-MM-DD.dump`,
  com conferência de tamanho e de conteúdo. Falha vira linha em `/var/log/sb-backup.log`.
  **Ainda não há alerta**: ver pendências.
- **`restore.sh`**: aplica as migrations da `main` (pacote `import/migrations.tgz`) e carrega os dados
  (`import/dados.sql.gz`). Os dois pacotes vêm do extrator que lê o backup do Supabase e leva só as
  colunas em comum com o destino.

## Restaurar um backup

Em banco descartável (o teste que prova que o backup serve): copiar o `.dump` para dentro do contêiner
e `pg_restore --no-owner --no-privileges -j 2 -d <banco>`. Os únicos erros esperados são os do `pg_cron`,
que só existe no banco `postgres`. Para recuperar a produção, restaurar numa pilha nova com a mesma
versão das imagens.

## Pendências (nada disto está no ar ainda)

1. **Domínio e HTTPS**: registro A para o IP reservado, regra de firewall 80/443, Caddy na frente
   (só `/rest`, `/auth`, `/realtime` e `/storage`; o Studio não sai) e `SUPABASE_PUBLIC_URL`,
   `API_EXTERNAL_URL`, `SITE_URL` no segredo.
2. **SMTP real** para convites e recuperação de senha, e os modelos de e-mail do painel hospedado.
3. **Paridade do Auth** com o painel hospedado (política de senha, validade do JWT, limites).
4. **Agendamentos**: `select private.agendar_vigia_da_sincronizacao();` só depois que o worker voltar a
   sincronizar (o vigia avisaria "conta parada" para todas as contas). Em produção havia um agendamento:
   `vigiar-sincronizacao`, a cada 30 minutos.
5. **Alertas** de CPU, disco e falha de backup, com um canal de notificação escolhido pelo dono.
6. **CI e migrations de produção**: o workflow `migrations-producao.yml` fala com o Supabase hospedado.
   Aqui o Postgres não tem porta pública, então ele precisa de outro caminho (túnel IAP ou execução na VM).
7. **Corte**: variáveis da Vercel e do Cloud Run, nesta ordem, com o worker parado (plano §3.4).
