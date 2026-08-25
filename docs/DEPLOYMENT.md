# Plataformas, ambientes e deploy

> Dono documental de: ambientes, provisionamento, secrets, CI/CD e rollout.
> Arquitetura geral em `docs/ARCHITECTURE.md`.
> Status: **estratégia aprovada e ambiente de desenvolvimento provisionado.** Produção permanece para a Fase 8.

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

### Ordem segura de deploy

Quando `api` e `worker` são publicados juntos, `infra/deploy-cloud-run.sh` implanta **primeiro o `worker` e depois a `api`**. O worker é consumidor dos tipos de job que a api produz; publicar o produtor primeiro abre uma janela em que a api nova pode enfileirar um tipo que o worker antigo ainda recusa.

Essa janela causou um incidente real em 2026-08-20: quatro tasks `erp.import.parse` chegaram à revisão antiga do worker, receberam `400 unknown_job_type` nas três tentativas e foram descartadas, deixando os batches em `UPLOADED`. Consumidor antes do produtor passa a ser regra de deploy, não convenção informal.

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

**Exceções registradas em 2026-08-21:** `v3-worker-runtime` recebe `roles/cloudtasks.enqueuer` somente em `backfill` (autoencadeia o próximo pedaço) e `analytics-recompute` (marca conta/dia sujos depois de persistir uma reconciliação). Todas as outras filas continuam produzidas só pela `api`; não existe concessão no projeto inteiro.

Como toda task usa `v3-tasks-invoker` no token OIDC, os dois produtores (`v3-api-runtime` e `v3-worker-runtime`) recebem `roles/iam.serviceAccountUser` **na própria service account invocadora**, nunca no projeto. O segundo vínculo é indispensável para o autoencadeamento do backfill.

---

## 5. Secrets

| Segredo | Onde vive | Quem lê |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret Manager | `api`, `worker` |
| `MERCADO_LIVRE_CLIENT_SECRET` | Secret Manager | `api` (troca o `code`), `worker` (renova por `refresh_token`) |
| `ML_TOKEN_ENCRYPTION_KEY` (AES-256, D-046) | Secret Manager | `api`, `worker` |
| `ANTHROPIC_API_KEY` (Claude Haiku 4.5, D-082) | Secret Manager | `api` (Copiloto — o `worker` nunca chama a Anthropic) |
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
  cloudbuild.yaml           receita do Cloud Build usada por deploy-cloud-run.sh
  deploy-cloud-run.sh       build + deploy de `api`/`worker` — MANUAL, ver secao 7
  cloud-scheduler.sh        cria/atualiza todos os jobs do Cloud Scheduler — idempotente, MANUAL
  README.md                 ordem de execução e pré-requisitos
  # pendente:
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

**GitHub Actions** (`.github/workflows/ci.yml`), obrigatório antes de entrar na `v3`:

```text
typecheck -> lint -> testes unitários -> testes de integração -> build -> aplicar migrations no Dev
```

- Migrations aplicadas **por CI** (`supabase db push`, job `migrations`), nunca à mão, nunca pelo dashboard — só em push na `v3`, depois de `check`/`scripts`/`integration` verdes.
- Deploy do `web` pela integração nativa da Vercel com a branch — esse sim é automático.
- **Deploy de `api` e `worker` é MANUAL** — `bash infra/deploy-cloud-run.sh` (worker primeiro, depois api — secao 3). Não existe workflow do GitHub Actions que publique no Cloud Run. Quem roda o deploy é responsável por conferir CI verde antes ("nenhum deploy sem CI verde" é regra de operador, não trava automática).

**Achado real em 2026-08-24, D-065:** o `worker`/`api` de produção ficaram 36 commits atrás do HEAD e 5 jobs do Cloud Scheduler documentados como "rodando" nunca tinham sido criados de fato — ninguém rodou `deploy-cloud-run.sh`/`cloud-scheduler.sh` depois de várias sessões de trabalho de features. Nasceu daí a regra abaixo, agora also em `docs/HANDOFF.md`.

### Documentação não comprova deploy

Antes de declarar qualquer mudança operacional como implantada, verificar contra a infraestrutura real, nunca contra o texto do HANDOFF/ROADMAP:

- `gcloud run services describe api/worker --format='value(status.latestReadyRevisionName)'` e comparar a tag da imagem (`git rev-parse --short HEAD` no momento do deploy) contra o commit atual;
- `gcloud scheduler jobs list --location southamerica-east1` contra os jobs esperados (`infra/cloud-scheduler.sh` é a lista canônica);
- `pnpm exec supabase migration list --linked` (local == remoto, sem drift);
- CI do commit exato verde (`gh run list`/`gh run view`), não presumido;
- logs de boot sem `ERROR` (`gcloud logging read ... severity>=ERROR`) depois de um deploy novo;
- para um job que nunca rodou de verdade em produção, disparar manualmente uma vez (`gcloud scheduler jobs run <nome>`) e conferir o log de conclusão antes de confiar na cadência automática.

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

## 10.1 Conectar uma conta Mercado Livre (manual, precisa do painel)

Antes do primeiro `POST /v1/ml-accounts/connect` em qualquer ambiente:

1. Criar os secrets no Secret Manager: `MERCADO_LIVRE_CLIENT_SECRET` (vem do painel de aplicações do Mercado Livre) e `ML_TOKEN_ENCRYPTION_KEY` — gerar com `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, nunca reaproveitar entre ambientes.
2. Cadastrar a aplicação no painel de aplicações do Mercado Livre (`developers.mercadolivre.com.br`) com o `redirect_uri` **exatamente** igual a `MERCADO_LIVRE_REDIRECT_URI` — Mercado Livre recusa o callback se não bater caractere a caractere.
3. PKCE pode permanecer habilitado no painel: a V3 usa sempre S256, guarda o verifier cifrado e o envia na troca do token (D-049). Desabilitá-lo para contornar erro de integração é proibido.
4. Definir `MERCADO_LIVRE_CLIENT_ID` e `MERCADO_LIVRE_REDIRECT_URI` no ambiente antes de rodar `infra/deploy-cloud-run.sh` (não são segredo, mas precisam existir — o script falha cedo, com causa explícita, se `MERCADO_LIVRE_CLIENT_ID` estiver vazio).

No ambiente atual, depois de criar a linha da conta no `web` e **antes** de conectá-la, o operador de infraestrutura ainda precisa provisionar a fila dedicada:

```bash
bash infra/cloud-tasks-queues.sh <slug-da-conta>
```

As quatro contas atuais já estão provisionadas. Automatizar essa criação exige uma identidade controlada com permissão de administrar filas e fica para o provisionamento da Fase 8; conceder `queueAdmin` ao runtime público da `api` violaria o menor privilégio. OAuth e backfill inicial usam a tela normalmente, mas a reconciliação/webhook da conta dependem da fila `ml-sync-<slug>` existir.

---

## 11. Pendências

- Criar e validar o ambiente de produção na Fase 8.
- Automatizar, na Fase 8, o provisionamento da fila `ml-sync-<slug>` para contas novas; até lá usar o script versionado.
- Migrar os scripts `gcloud` para Terraform na Fase 8.
