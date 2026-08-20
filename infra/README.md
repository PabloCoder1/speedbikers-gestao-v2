# Infraestrutura — Google Cloud

Scripts `gcloud` versionados. Terraform só na Fase 8, quando existir produção — ver **D-022** em `docs/DECISIONS.md`.

**Todos os scripts são idempotentes.** Podem ser rodados quantas vezes for necessário; o que já existe é pulado.

## Pré-requisitos

| Requisito | Como verificar |
|---|---|
| Google Cloud SDK instalado | `gcloud.cmd --version` |
| Autenticado | `gcloud.cmd auth login` |
| Credencial para código local | `gcloud.cmd auth application-default login` |
| Billing habilitado no projeto | verificado pelo `setup-dev.sh` |

**No Windows:** os scripts chamam o wrapper `gcloud.cmd`, não o `gcloud.ps1`. O `.ps1` esbarra na política de execução do PowerShell; o `.cmd` não. Se o SDK estiver em outro caminho, defina `GCLOUD_BIN`.

Rode pelo **Git Bash**, não pelo PowerShell.

## Ordem de execução

```bash
bash infra/setup-dev.sh
```

```bash
bash infra/cloud-tasks-queues.sh
```

```bash
bash infra/storage-buckets.sh
```

## O que cada um cria

| Script | Recursos | Custo parado |
|---|---|---|
| `setup-dev.sh` | Habilita APIs e garante as service accounts `v3-api-runtime`, `v3-worker-runtime`, `v3-tasks-invoker`, `v3-scheduler-invoker` | Zero |
| `cloud-tasks-queues.sh` | Filas `analytics-recompute`, `backfill`, `maintenance`, mais `ml-sync-<conta>` sob demanda | Zero |
| `storage-buckets.sh` | Buckets `raw-ml`, `erp-imports`, `documents`, ciclo de vida de 90 dias no primeiro, e IAM por bucket | Zero até haver objeto |

Nenhum deles cria serviço do Cloud Run. Deploy é assunto do workflow de CI — ver `docs/DEPLOYMENT.md`.

## Fila por conta do Mercado Livre

O limite de taxa do Cloud Tasks é **por fila**, não por conta. Para respeitar o rate limit do Mercado Livre por conta, cada conta tem a própria fila:

```bash
bash infra/cloud-tasks-queues.sh offracer
```

Uma fila compartilhada faria o backfill de uma conta consumir o orçamento de requisições das outras. Ver **D-036**.

## Valores provisórios

Os limites de taxa e concorrência das filas `ml-sync-*` são **provisórios**. A política de rate limit vigente do Mercado Livre ainda não foi confirmada na documentação oficial — ver a lista de verificação em `docs/MERCADO_LIVRE.md`. Ajustar depois de confirmar, nunca por estimativa.

## Ainda não existem

- `cloud-scheduler.sh` — entra na Fase 3, quando houver reconciliação a agendar.
- `secrets.sh` — entra na Fase 2, com o OAuth do Mercado Livre. Valores de segredo **nunca** são versionados.
