# Custo, dimensionamento e retenção na nuvem (I06)

Levantamento do Claude Sentinel em 25/11/2026, só com leituras no projeto `speedbikers-prod`:
- API REST do Google Cloud;
- Cloud Monitoring;
- catálogo de preços;
- SSH na `sb-db`.

Nada foi alterado nesta leitura.

Este documento complementa o #408 do Gemini (D-836), que registra o que foi aplicado em 25/11 por volta de 13:23 UTC:
- a política do Artifact Registry, que mantém as 10 versões mais recentes por pacote e apaga as anteriores com mais de 30 dias;
- a expiração de 30 dias no bucket do Cloud Build;
- a remoção do `roles/editor` da conta padrão do Compute;
- a limpeza das tags `worker-m05-*`.

Confirmei a política e a regra do bucket direto nos recursos. Abaixo fica só o que o #408 não cobre ou estima de outro jeito.

## Dimensionamento

| Recurso | Configuração | Uso medido | Leitura |
|---|---|---|---|
| VM `sb-db` | e2-standard-2: 2 vCPU, 8 GB | CPU nos últimos 7 dias: média horária com p50 de 21 % e p95 de 23 %. Pico horário com p95 de 70 % e máximo de 96 % | Adequada. O pico vem das rotinas em lote, não de uso contínuo |
| Memória da VM | 7,9 GB, sem swap | 2,7 GB usados e 5,2 GB disponíveis, sem nenhum caso de falta de memória em 7 dias | Folga para subir o cache do Postgres (abaixo) |
| Disco `sb-db` | pd-balanced 50 GB | 15 GB usados (32 %). Banco com 1,6 GB e imagens Docker com 9,5 GB | Folga para meses |
| Cloud Run `api` | 1 vCPU, 512 MiB, **mínimo 1** | Uma instância ligada o tempo todo (média de 1,00 em 7 dias). Não escala a zero | O mínimo 1 evita partida a frio no painel |
| Cloud Run `worker` | 1 vCPU, 512 MiB, mínimo 0, máximo 5 | Média de 0,13 instância em 7 dias | Adequado |

### Postgres com parâmetros de fábrica

| Parâmetro | Atual | Referência para 8 GB e SSD |
|---|---|---|
| `shared_buffers` | 128 MB | ~2 GB (25 % da RAM). Exige reiniciar o Postgres |
| `effective_cache_size` | 128 MB | ~5 GB. O planejador hoje supõe que quase nada está em cache |
| `random_page_cost` | 4 | ~1,1 em SSD |
| `work_mem` | 4 MB | Avaliar 16 MB com as 100 conexões máximas |

- **Taxa de acerto do cache:** 99,7 % desde 18/11, mas só porque o sistema operacional guarda ~2 GB de páginas.
- **Tabelas mais lidas do disco:** `orders` (88 % de acerto), `job_runs` (41 %), `order_items` (89 %) e `notification_recipients` (85 %).
- **Risco de mudar:** a troca muda planos de consulta. Por isso precisa de ensaio das RPCs principais antes e depois (P02).
- **Quem decide:** é mudança de configuração de produção. Fica com o dono, com janela para reiniciar.

## Custo estimado

Preço de tabela do catálogo do Google em reais, para 730 horas por mês. **É estimativa, não fatura.** Não há exportação de faturamento para o BigQuery, então o custo efetivo só aparece no console (Faturamento → Relatórios).

| Item | Estimativa por mês |
|---|---|
| VM e2-standard-2 (2 × R$ 0,211/h + 8 GB × R$ 0,0283/h) | ~R$ 474 |
| Disco pd-balanced 50 GB (R$ 0,915/GB) | ~R$ 46 |
| IPs externos da VM e do NAT (R$ 0,0305/h cada) | ~R$ 45 |
| `api` com uma instância mínima ociosa | ~R$ 83, mais o tempo ativo, que a métrica não separa |
| `worker` (0,13 instância média) | ~R$ 74 |
| Cloud Scheduler (20 jobs, 3 gratuitos) | ~R$ 10 |
| Snapshots (12,2 GB), backups no Storage (~3 GB) e imagens (1,7 GB) | ~R$ 8 |
| **Parte fixa estimada** | **~R$ 740**, mais o tempo ativo da `api`, o NAT e a saída de rede |

**Diferença em relação ao #408:** ele estima o Cloud Run em US$ 3 a 10 por mês, partindo de "escala a zero". Com o mínimo de 1 na `api` e a média medida no `worker`, só os dois serviços ficam perto de R$ 160 por mês.

**Custo efetivo (25/11):** o dono conferiu no console o custo dos últimos 30 dias, e ele ficou bem abaixo da estimativa.
- A janela inclui só ~7 dias da VM, que roda desde 18/11.
- A estimativa mensal só fica validada no primeiro mês cheio com a VM (dezembro).
- O valor exato fica fora do repositório.

**Orçamentos da conta de faturamento:**
- **Produção:** um orçamento restrito ao projeto, com alertas de 25 % a 100 %. A estimativa fica perto do limite dele.
- **"Speed Bikers V3 Dev Budget":** não tem filtro de projeto, então cobre a conta inteira, com um valor bem abaixo da estimativa. Os alertas dele devem disparar todo mês e perdem o sentido. **Ação do dono:** restringir esse orçamento ao projeto Dev.

## Retenção

| Recurso | Regra atual | Achado | Recomendação |
|---|---|---|---|
| Snapshots automáticos do disco | Diário às 07:00 UTC, guardados por 7 dias | 7 automáticos, como previsto | Manter |
| Snapshots manuais | Sem expiração | `sb-db-antes-migrations-nov-20261118` (6,7 GB) e `sb-db-antes-d858-20261123` (0,4 GB) | Decidir depois do "check final" de 01/12 (L04) |
| Bucket `speedbikers-prod-db-backups` | Apaga `diario/` aos 35 dias. **Versionamento ligado.** Exclusão reversível por 7 dias | Com versionamento e sem regra para versões antigas, cada backup que a regra apagar vira versão guardada para sempre. Nenhum backup chegou a 35 dias ainda; o primeiro é de 18/11 | **Aplicada em 25/11 às 18:02 UTC, com autorização do dono:** as versões antigas de `diario/` são apagadas 30 dias depois de deixarem de ser a atual. A regra de 35 dias continua. `manual/` e `import/` ficam de fora, para decisão própria |
| `manual/` e `import/` no mesmo bucket | Sem regra | 7 objetos atuais (1,1 GB) e 3 versões antigas (0,4 GB) | Decidir com o dono o que é cópia histórica |
| Artifact Registry `speedbikers-v3` | Política do #408, ativa desde 25/11 14:31 UTC | 1,67 GB. Hoje são 10 imagens de `api` e 10 de `worker` | Manter |
| Bucket do Cloud Build | Apaga aos 30 dias (aplicado em 25/11) | 0,24 GB | Manter |
| `raw-ml` | Muda para Coldline aos 90 dias | — | Manter |
| Logs | `_Default` por 30 dias, `_Required` por 400 dias | Padrão do Google | Manter |

## IAM da conta de build depois da remoção do `editor` (S05)

**Quem roda com quê:**

| Consumidor | Conta | Afetado? |
|---|---|---|
| Cloud Run `api` | `v3-api-runtime` | Não |
| Cloud Run `worker` | `v3-worker-runtime` | Não |
| VM `sb-db` | `sb-db-vm`, com escrita de logs e métricas | Não |
| Job `sb-backup-check` | `sb-backup-probe` | Não |
| Cloud Scheduler (19 de 20 jobs com OIDC) | `v3-scheduler-invoker` | Não |
| **Builds do deploy** | conta padrão do Compute, em todos os builds normais até 25/11 12:03 UTC | **Sim** |

**Risco:** o #408 recomenda adotar o `v3-builder` nos builds (passo 1) antes de remover o `editor` (passo 2). Só o passo 2 está em produção.
- A conta padrão ficou sem nenhum papel no projeto, e o repositório `speedbikers-v3` não tem IAM próprio.
- O `v3-builder` também não tem papel no projeto nem no repositório: os vínculos do ensaio de 24/11 foram removidos.
- O `infra/deploy-cloud-run.sh` da `main` não escolhe a conta do build. Só a versão do candidato #378 aceita `CLOUD_BUILD_SERVICE_ACCOUNT`.
- Pela leitura das políticas, o próximo `gcloud builds submit` deve falhar sem escrita no repositório de imagens, leitura do bucket de origem e escrita de logs.
- Isso não foi testado: testar exigiria um build em produção.

**Ação do dono, antes do próximo deploy de `api` ou `worker`:** conceder ao `v3-builder` os papéis do runbook do candidato e fazer o deploy com `--service-account`. Ou, se o deploy for urgente, aplicar o rollback de um comando do #408.

São os três vínculos que o ensaio de 24/11 usou e removeu:
1. escrita no repositório de imagens;
2. leitura do bucket de origem;
3. escrita de logs.

O `infra/cloudbuild.yaml` já usa `CLOUD_LOGGING_ONLY`, que o Cloud Build exige quando a conta é escolhida.

```bash
SA=serviceAccount:v3-builder@speedbikers-prod.iam.gserviceaccount.com
gcloud artifacts repositories add-iam-policy-binding speedbikers-v3 --project=speedbikers-prod --location=southamerica-east1 --member="$SA" --role=roles/artifactregistry.writer
gcloud storage buckets add-iam-policy-binding gs://speedbikers-prod_cloudbuild --member="$SA" --role=roles/storage.objectViewer
gcloud projects add-iam-policy-binding speedbikers-prod --member="$SA" --role=roles/logging.logWriter --condition=None
```

O build passa a levar `--service-account=projects/speedbikers-prod/serviceAccounts/v3-builder@speedbikers-prod.iam.gserviceaccount.com --region=southamerica-east1`. A conta de quem opera precisa de `actAs` no `v3-builder`, que o papel `owner` já inclui.

Espere cerca de 2 minutos antes do primeiro build: o ensaio regional de 24/11 só gravou log 139 s depois da concessão.

**Fechado em 25/11:**
- O dono concedeu os três papéis.
- Conferi os vínculos no repositório, no bucket e no projeto.
- Um build de teste como `v3-builder` (`cdb5c897`) terminou em SUCCESS às 18:05 UTC, com a imagem `worker-sentinel-iam:*`. Ela não está em uso e entra na lista do L04.
- O próximo deploy de `api` ou `worker` usa o `--service-account` acima.

## O que fecha o I06

- **Custo efetivo:** lido pelo dono em 25/11 (últimos 30 dias). Falta comparar o primeiro mês cheio com a VM, em dezembro.
- **Orçamento "Dev":** ainda cobre a conta inteira. O dono restringe ao projeto Dev.
- **Dimensionamento:** validado nesta leitura. A mudança dos parâmetros do Postgres é opcional e depende de ensaio.
- **Retenção:** a regra de versões antigas de `diario/` foi aplicada em 25/11.
