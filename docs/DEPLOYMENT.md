# Plataformas, ambientes e deploy

> Dono documental de: ambientes, provisionamento, secrets, CI/CD e rollout.
> Arquitetura geral em `docs/ARCHITECTURE.md`.
> Status: **estratégia aprovada.** Nada provisionado além do Supabase V3 Dev e da fundação do Google Cloud.

---

## 1. Plataformas

| Plataforma | Papel | Fora de escopo |
|---|---|---|
| **Vercel** | `apps/web`, região `gru1` | Nenhum worker, nenhum trabalho longo |
| **Supabase** | Postgres, Auth, RLS, Realtime, Storage | **Sem Edge Functions** |
| **Google Cloud** | Cloud Run (2 serviços), Cloud Tasks (4 filas), Cloud Scheduler, Secret Manager, Cloud Storage, Cloud Logging | Sem GKE, Compute Engine, Cloud SQL, Load Balancer, VPC customizada, Artifact Registry além da imagem |
| **GitHub** | Código, CI, memória versionada | — |

**Por que não Supabase Edge Functions:** processamento pesado já tem casa definida (D-003). Um terceiro lugar onde código roda, com um terceiro modelo de deploy, um terceiro lugar de log e Deno em vez de Node, reprova no teste do operador único.

*Nota medida na V2:* `gru1` e Supabase `sa-east-1` são ambos São Paulo, sem salto entre regiões. A auditoria descartou a hipótese de que a Vercel fosse o gargalo — os gargalos eram agregação em JavaScript, índice ausente e polling.

---

## 2. Ambientes

| Ambiente | Banco | Compute | Frontend |
|---|---|---|---|
| **local** | Supabase CLI em Docker | apps locais, Mercado Livre em fixture | `next dev` |
| **development** | Supabase V3 Dev (`sa-east-1`) | Cloud Run dev | Vercel Preview |
| **production** | Projeto novo, criado na Fase 8 | Cloud Run prod | Vercel Production |

**Três ambientes, não quatro.** Staging separado só se justifica quando houver produção com usuário real dependendo de estabilidade.

**Preview da Vercel aponta para o Supabase Dev.**

- *Vantagem:* zero infraestrutura de provisionamento por PR, dados realistas.
- *Desvantagem:* migration destrutiva num PR afeta quem estiver testando.
- *Mitigação:* migration destrutiva exige justificativa, impacto e plano de rollback (`docs/PROMPT_MASTER.md` §11).

---

## 3. Configuração dos serviços Cloud Run

| | `api` | `worker` |
|---|---|---|
| Rota pública | Webhook e OAuth callback | Nenhuma |
| `min-instances` | **1** | 0 |
| Timeout | Curto | Até 15 min |
| Concorrência | Alta | Baixa |
| Autenticação de entrada | JWT do usuário, OIDC interno, validação própria do webhook | OIDC apenas |

**`min-instances=1` na `api` não é otimização prematura:** é requisito do webhook. Cold start atrasa o ACK e provoca reentrega pelo Mercado Livre. Custo estimado na ordem de poucos dólares por mês.

---

## 4. Filas

| Fila | Papel | Configuração relevante |
|---|---|---|
| `ml-sync` | Sincronização | Limite de taxa e concorrência **por conta** |
| `analytics-recompute` | Recálculo de métricas | Dedupe forte por nome de task |
| `backfill` | História | Prioridade baixa, nunca disputa com o vivo |
| `maintenance` | Conferência, expurgo, medição | Baixa frequência |

Cloud Scheduler dispara apenas reconciliação e manutenção. **Nunca despacha fila** — foi o que dominou o banco da V2 com polling.

---

## 5. Secrets

| Segredo | Onde vive | Quem lê |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret Manager | `api`, `worker` |
| Credenciais de aplicação do Mercado Livre | Secret Manager | `api` |
| Chave de cifragem dos tokens ML | Secret Manager | `api` |
| Chave da API de IA | Secret Manager | `api` |
| `NEXT_PUBLIC_SUPABASE_URL` e chave publicável | Vercel env | `web` |

Regras:

- **`service_role` nunca na Vercel, nunca no bundle, nunca em log.**
- Token do Mercado Livre cifrado em repouso, nunca registrado em log nem parcialmente.
- Chamadas de Scheduler e Tasks autenticadas por **OIDC de service account**, sem segredo compartilhado (D-024).
- **`.env.example` completo e versionado.** *Motivo:* a V2 tinha `APP_ENCRYPTION_KEY` no ambiente local e ausente do exemplo — um ambiente novo subiria sem ela e só descobriria em runtime.
- **Validação de variáveis com Zod no boot dos três apps.** Falta variável, o processo morre no start.

---

## 6. Infraestrutura como código

**Scripts `gcloud` versionados em `infra/` agora; Terraform na Fase 8** (D-022).

```text
infra/
  setup-dev.sh              projeto, serviços habilitados, service accounts
  cloud-tasks-queues.sh     as 4 filas e suas configurações
  cloud-scheduler.sh        reconciliação e manutenção
  secrets.sh                criação dos segredos (valores nunca versionados)
  README.md                 ordem de execução e pré-requisitos
```

- *Motivo:* Terraform brilha com múltiplos ambientes e múltiplas pessoas. Com um ambiente e um operador, é uma linguagem a mais, um state a gerenciar e um modo novo de quebrar deploy — antes de existir uma linha de domínio.
- *Desvantagem assumida:* script não detecta drift. Alteração feita pelo console não gera aviso.
- *Porta de saída:* os recursos são poucos e conhecidos; migrar para Terraform na Fase 8 é trabalho de um dia.

---

## 7. CI/CD

**GitHub Actions**, obrigatório antes de entrar na `v3`:

```text
typecheck -> lint -> testes unitários -> testes de integração -> build
```

- Migrations aplicadas **por CI**, nunca à mão, nunca pelo dashboard.
- Deploy do `web` pela integração nativa da Vercel com a branch.
- Deploy de `api` e `worker` por workflow que constrói a imagem e publica no Cloud Run.
- Nenhum deploy sem CI verde.

---

## 8. Rollout da V3 (Fase 8)

1. Migrar `infra/` para Terraform.
2. Criar projeto Supabase de produção e serviços Cloud Run de produção.
3. Executar a carga inicial conforme D-027: backfill do Mercado Livre para pedidos e anúncios, ETL da V2 para vínculos, estoque, NF-e e compras.
4. Verificar backup e restore — restore testado, não apenas backup configurado.
5. Testes de carga e revisão de `pg_stat_statements`.
6. Revisão de segurança e de secrets.
7. Corte da operação.

---

## 9. Buckets e lifecycle

| Bucket | Conteúdo | Lifecycle |
|---|---|---|
| `raw-ml` | Payload bruto do Mercado Livre (L0) | **90 dias em classe quente, depois classe fria** (D-030) |
| `erp-imports` | Planilhas do UpSeller | Privado, retenção acompanha o batch |
| `documents` | XML e PDF de NF-e | Privado, retenção fiscal |

A retenção do L0 é **regra declarativa do bucket**, não rotina de expurgo em código.

---

## 10. Pendências

- Criação do projeto Vercel V3 conectado à branch `v3` (Fase 1).
- Provisionamento de Cloud Run, Cloud Tasks, Scheduler, Secret Manager e Storage (Fase 1).
