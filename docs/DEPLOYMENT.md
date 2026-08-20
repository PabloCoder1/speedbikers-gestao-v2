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
| `ml-sync-<conta>` | Sincronização | **Uma fila por conta** (D-036); limites provisórios até confirmar o rate limit oficial do ML |
| `analytics-recompute` | Recálculo de métricas | 10/s, 20 simultâneas, dedupe por nome de task |
| `backfill` | História | 1/s, 2 simultâneas — nunca disputa com o vivo |
| `maintenance` | Conferência, expurgo, medição | 1/s, 1 simultânea |

Permissão de enfileirar é concedida **por fila** à service account `v3-api-runtime`, nunca no projeto inteiro.

### Service accounts

Uma identidade por responsabilidade, seguindo a convenção já existente no projeto:

| Service account | Papel |
|---|---|
| `v3-api-runtime` | Runtime do `apps/api` no Cloud Run |
| `v3-worker-runtime` | Runtime do `apps/worker` no Cloud Run |
| `v3-tasks-invoker` | Identidade que o Cloud Tasks usa para invocar o worker via OIDC |
| `v3-scheduler-invoker` | Identidade que o Cloud Scheduler usa para invocar a api via OIDC |

Papéis são concedidos **no recurso** (fila, bucket, serviço), não no projeto.

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
  lib.sh                    variáveis, helpers e pré-condições comuns
  setup-dev.sh              APIs habilitadas e service accounts
  cloud-tasks-queues.sh     filas base e fila por conta do Mercado Livre
  storage-buckets.sh        buckets e ciclo de vida do payload bruto
  README.md                 ordem de execução e pré-requisitos
  # pendentes:
  # cloud-scheduler.sh      Fase 3, quando houver reconciliação a agendar
  # secrets.sh              Fase 2, com o OAuth do Mercado Livre
```

Projeto de desenvolvimento: **`speedbikers-gestao-v3`**, região `southamerica-east1`.

### Vercel: `ignoreCommand` fica no repositório, não no dashboard

`apps/web/vercel.json` define `"ignoreCommand": "exit 1"` — na Vercel a lógica é invertida: **saída 1 constrói, saída 0 pula**.

Está versionado de propósito. Um *Ignored Build Step* configurado só no dashboard é invisível para quem lê o repositório e **cancela deploys em silêncio** — foi exatamente o que aconteceu em 2026-08-20, quando o comando destinado ao projeto antigo da V2 foi colado no projeto da V3 e cancelou cinco deploys seguidos sem nenhum sinal no código.

O `vercel.json` sobrescreve a configuração do dashboard, então a regra passa a viver junto do código que ela afeta.

Os scripts chamam `gcloud.cmd` no Windows — o wrapper `.ps1` esbarra na política de execução do PowerShell. Rodar pelo Git Bash.

**Nenhum script define projeto padrão global no gcloud.** O projeto é sempre explícito, porque a mesma conta administra outros projetos e um padrão global erra silenciosamente.

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
3. Executar a carga inicial: backfill do Mercado Livre para pedidos e anúncios. ETL da V2 para vínculos/estoque/NF-e foi descartado por evidência medida (D-040); só resta, se ainda fizer sentido no momento, migrar o(s) pedido(s) de compra reais da V2.
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

## 10. Primeiro acesso (bootstrap)

Problema de ovo e galinha: só ADMIN pode conceder papel (policy `organization_members_admin_writes`), e num ambiente novo não existe ADMIN nenhum.

A organização Speed Bikers vem do migration `20260820210000_seed_organization.sql`, com **UUID fixo** (`00000000-0000-4000-8000-000000000001`). Fixo de propósito: o valor aparece em teste, em script de carga e em consulta manual, e sortear por ambiente transformaria cada um desses usos numa consulta prévia. Vai em migration e não em `supabase/seed.sql` porque `seed.sql` só roda no `db reset` local — a CI aplica o schema em Dev com `db push`, que o ignora.

O usuário é criado **no painel do Supabase** (Authentication → Users → Add user), onde a própria pessoa define a senha. Senha não passa por script, por arquivo nem por log. O trigger `on_auth_user_created` cria o perfil sozinho.

Falta só o vínculo com papel:

```bash
node packages/db/src/bin/grant-role.ts --email pessoa@exemplo.com --role ADMIN
```

O script usa `SUPABASE_URL` e `SUPABASE_SECRET_KEY` do ambiente e escreve com `service_role`, que ignora RLS — é o que quebra o ciclo. Depois do primeiro ADMIN, promoção sai pela interface e o script não é mais necessário.

Papéis aceitos: `ADMIN`, `GESTOR`, `ANALISTA`, `OPERADOR`, `VISUALIZADOR`. `--org` aceita outro slug; o padrão é `speed-bikers`.

Roda direto com `node`, sem passo de build: o Node 24 remove os tipos do `.ts` nativamente.

---

## 11. Pendências

- Criação do projeto Vercel V3 conectado à branch `v3` (Fase 1).
- Provisionamento de Cloud Run, Cloud Tasks, Scheduler, Secret Manager e Storage (Fase 1).
