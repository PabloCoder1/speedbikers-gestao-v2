# Auditoria de Custo, Dimensionamento, IAM e Limpeza de Nuvem (`I06`, `S05`, `L04`)

- **Data da coleta (somente leitura no GCP `speedbikers-prod`):** 2026-11-25
- **Decisão associada:** `D-836`
- **Responsável:** Gemini Sentinel

---

## 1. Inventário real de recursos ativos e dimensionamento (`I06`)

| Recurso | Configuração verificada (`25/11/2026`) | Política de retenção / lifecycle | Avaliação de dimensionamento |
|---|---|---|---|
| **VM `sb-db`** (`southamerica-east1-b`) | `e2-standard-2` (2 vCPU, 8 GiB RAM), disco `50 GB` `pd-balanced`, `RUNNING`, SA `sb-db-vm@speedbikers-prod.iam.gserviceaccount.com` | Backup diário GCS com delete em 35 dias (`diario/`) + snapshot automático | Adequado ao workload validado em `P02` (72 consultas concorrentes < 8 s em 2 vCPU / 8 GiB) |
| **Cloud Run `api`** (`southamerica-east1`) | `1 vCPU / 512 MiB`, SA `v3-api-runtime@speedbikers-prod.iam.gserviceaccount.com`, revisão ativa `api-00044-zzf` (`c5882974`) | Escala a zero quando ocioso | Adequado; sem sinais de OOM |
| **Cloud Run `worker`** (`southamerica-east1`) | `1 vCPU / 512 MiB`, SA `v3-worker-runtime@speedbikers-prod.iam.gserviceaccount.com`, revisão ativa `worker-00065-ccn` (`c5882974`) | Escala a zero entre filas | Adequado; revisões tagged `worker-m05-*` candidatas à limpeza (`L04`) |
| **Artifact Registry `speedbikers-v3`** | Docker, `1.669,34 MB` acumulados | **`cleanupPolicies: null` (ausente)** | **Ação pronta (`infra/artifact-retention.sh`):** manter últimas 10 versões por imagem e remover > 30 dias |
| **Bucket `speedbikers-prod-db-backups`** | `SOUTHAMERICA-EAST1` | Delete em 35 dias (`diario/`) | Conforme (`I03`) |
| **Bucket `speedbikers-prod-raw-ml`** | `SOUTHAMERICA-EAST1` | Transição para `COLDLINE` em 90 dias | Conforme |
| **Buckets `speedbikers-prod-documents` e `erp-imports`** | `SOUTHAMERICA-EAST1` | Sem expiração (documentos fiscais e planilhas de auditoria) | Intencional (dados de negócio) |
| **Bucket `speedbikers-prod_cloudbuild`** | `US` | **Sem lifecycle** (acumula tarballs temporários de build) | **Ação pronta (`--cloudbuild-lifecycle`):** expirar em 30 dias |

### Estimativa de custo mensal de referência (`southamerica-east1`, preços públicos GCP)

- `sb-db` (`e2-standard-2` 24x7 + 50 GB `pd-balanced` + IP externo): maior parcela fixa do projeto (~US\$ 65–80/mês antes de CUD/créditos).
- Cloud Run (`api` + `worker`) + Cloud Tasks + Cloud Scheduler + Secret Manager: baixo volume sob demanda (~US\$ 3–10/mês).
- GCS + Artifact Registry: ~US\$ 1–3/mês (contido ao ativar `infra/artifact-retention.sh`).
- **Pendência final de `I06` (requer acesso de faturamento do dono no Cloud Billing):** conferir a fatura consolidada real do mês fechado no painel de Billing após a reativação de 24/11 e executar `./infra/artifact-retention.sh --project speedbikers-prod --cloudbuild-lifecycle`.

---

## 2. Revisão de IAM `roles/editor` (`S05`)

Consulta `gcloud projects get-iam-policy speedbikers-prod` em `25/11/2026`:

- `roles/owner`: `user:pablolima83352@gmail.com` (esperado).
- `roles/editor`: **apenas** `serviceAccount:246130997439-compute@developer.gserviceaccount.com` (default Compute Engine SA).

**Mapeamento de uso verificado:**
- VM `sb-db` → usa `sb-db-vm@...` (**não** usa default compute SA).
- Cloud Run `api` → usa `v3-api-runtime@...` (**não** usa default compute SA).
- Cloud Run `worker` → usa `v3-worker-runtime@...` (**não** usa default compute SA).
- **Único consumidor remanescente:** `gcloud builds submit` quando invocado sem `--service-account=projects/speedbikers-prod/serviceAccounts/v3-builder@speedbikers-prod.iam.gserviceaccount.com`.

**Procedimento seguro de fechamento de `S05` (com rollback em 1 comando):**
1. Padronizar builds passando `CLOUD_BUILD_SERVICE_ACCOUNT=projects/speedbikers-prod/serviceAccounts/v3-builder@speedbikers-prod.iam.gserviceaccount.com` e `CLOUD_BUILD_REGION=southamerica-east1` (já suportado no candidato `#364`).
2. Remover `roles/editor` da default compute SA:
   ```bash
   gcloud projects remove-iam-policy-binding speedbikers-prod \
     --member="serviceAccount:246130997439-compute@developer.gserviceaccount.com" \
     --role="roles/editor"
   ```
3. **Rollback imediato (se algum build legado falhar):**
   ```bash
   gcloud projects add-iam-policy-binding speedbikers-prod \
     --member="serviceAccount:246130997439-compute@developer.gserviceaccount.com" \
     --role="roles/editor"
   ```

---

## 3. Recursos de nuvem candidatos à limpeza com dependência e rollback (`L04`)

| Candidato | Evidência (`25/11/2026`) | Dependência ativa | Procedimento seguro | Rollback |
|---|---|---|---|---|
| Revisões tagged `worker-m05-cf6dae2d`, `worker-m05-d0c2790f`, `worker-m05-0f7a98de` | Substituídas por `worker-00065-ccn` (100% tráfego, `c5882974`) | Nenhuma (0% tráfego) | `gcloud run services update-traffic worker --clear-tags` e deletar revisões antigas após 7 dias | Re-apontar tráfego para `worker-00065-ccn` ou `worker-00061-gwr` (ou redeploy do SHA no Artifact Registry) |
| Imagens antigas em `speedbikers-v3` (`1.669,34 MB`) | Sem `cleanupPolicies` | Apenas imagens em uso pelas revisões ativas (cobertas por `keepCount: 10`) | `./infra/artifact-retention.sh --project speedbikers-prod --dry-run` seguido de execução sem `--dry-run` | Rebuild determinístico a partir do commit Git via `infra/cloudbuild.yaml` |
| Tarballs antigos em `gs://speedbikers-prod_cloudbuild` | Sem lifecycle | Nenhuma após conclusão do build | `./infra/artifact-retention.sh --project speedbikers-prod --cloudbuild-lifecycle` | `gcloud builds submit` gera novo tarball automaticamente |
| Projeto Supabase hosted legado `imvjfgnaprqsfjlnsyev` | `INACTIVE` desde o cutover para `sb-db` | Nenhuma (produção usa `34-39-221-164.sslip.io`) | Manter inativo até validação pós-01/12; excluir somente mediante decisão explícita do dono | Backup completo em `gs://speedbikers-prod-db-backups/diario/` (35 dias) |


---

## 4. Execução autorizada pelo dono e verificação pós-aplicação (`2026-11-25 13:23 UTC`)

1. **`I06` — Retenção de artefatos aplicada e verificada:**
   - `./infra/artifact-retention.sh --project speedbikers-prod --cloudbuild-lifecycle` executado com sucesso.
   - `speedbikers-v3`: `cleanupPolicies` ativo (`keep-minimum-versions` = `10` versões mais recentes + `delete-old-versions` > `2592000s`, `dry-run` desativado).
   - `gs://speedbikers-prod_cloudbuild`: `lifecycle_config` ativo (`Delete` após `30` dias).
2. **`S05` — Remoção de `roles/editor` aplicada e verificada:**
   - Removido `roles/editor` de `serviceAccount:246130997439-compute@developer.gserviceaccount.com`.
   - `gcloud projects get-iam-policy speedbikers-prod --filter="bindings.role:roles/editor"` retornou **0 bindings** (somente SAs de menor privilégio + `roles/owner` do dono).
3. **`L04` — Limpeza de tags obsoletas no Cloud Run aplicada e verificada:**
   - `gcloud run services update-traffic worker --clear-tags --to-latest` removeu as 3 tags `worker-m05-*` antigas.
   - Tráfego verificado: `100% LATEST (worker-00065-ccn)`. Saúde da API verificada: `GET /health` -> `{"status":"ok","service":"api","commit":"c5882974"}`.
