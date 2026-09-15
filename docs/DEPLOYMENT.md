# Plataformas, ambientes e deploy

> Dono documental de: ambientes, provisionamento, secrets, CI/CD e rollout.
> Arquitetura geral em `docs/ARCHITECTURE.md`.
> Status: **Dev e produção provisionados** — produção criada em 2026-09-14 (D-348, D-349, D-350); o corte da operação está pendente.

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
| **development** | Supabase `speedbikers-gestao-v3-dev` (`nmgccyqquwxecqffsidr`, `sa-east-1`) | Cloud Run em `speedbikers-gestao-v3` | Vercel `speedbikers-gestao-v2-m71j` |
| **production** | Supabase `speedbikers-prod` (`imvjfgnaprqsfjlnsyev`, `sa-east-1`), criado em 2026-09-14 | Cloud Run em `speedbikers-prod` | Vercel `speedbikers-prod` |

**Três ambientes, não quatro.** Staging separado só se justifica quando houver produção com usuário real dependendo de estabilidade.

**Preview da Vercel aponta para o Supabase Dev** — no projeto do Dev (`speedbikers-gestao-v2-m71j`). Nas prévias de `speedbikers-prod`, o escopo das `NEXT_PUBLIC_*` não foi verificado (D-350): se estiverem em *All Environments*, toda prévia de branch fala com o banco de produção.

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
  # secrets.sh nunca foi criado, por escolha — os segredos são criados
  # manualmente no Secret Manager (secao 5); só as concessões de IAM são
  # scriptadas (setup-dev.sh). Ver infra/README.md.
```

Projeto de desenvolvimento: **`speedbikers-gestao-v3`**, região `southamerica-east1`.

Projeto de produção: **`speedbikers-prod`**, mesma região (D-350). ⚠️ O projeto **padrão do `gcloud`** na máquina do dono passou a ser `speedbikers-prod`: todo comando manual leva `--project`. Os scripts de `infra/` já o passam, pela função `gc` de `lib.sh`.

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

## 6.1 Configuração externa obrigatória — painel do Mercado Livre

> Acrescentado em 2026-08-25 (D-091), depois de descobrir que o webhook nunca
> tinha sido chamado em 30 dias. **Este passo não é automatizável**: não existe
> API pública para configurá-lo, e nenhum script de `infra/` pode fazê-lo.
> Enquanto ele não for executado, o webhook simplesmente não recebe tráfego —
> e o sistema não tem como perceber sozinho, porque "nenhuma notificação" é
> indistinguível de "nenhum evento aconteceu".

Em `developers.mercadolivre.com.br` → **Suas integrações** → aplicação da V3:

| O quê | Valor | Por quê |
|---|---|---|
| URL de callback de notificações | **produção:** `https://api-p6gzq3hzca-rj.a.run.app/webhooks/mercado-livre` (desde 2026-09-14 17:30 UTC). Antes, a do Dev: `https://api-rrquw5upla-rj.a.run.app/webhooks/mercado-livre` | É o endpoint que a `api` expõe (`docs/API.md` secao 2). ⚠️ **O app é um só para Dev e produção** (`client_id` 3270890376967436), e a URL de notificação é uma só: apontá-la para produção deixou o Dev sem webhooks (D-350) |
| Tópicos assinados | `orders_v2`, `questions`, `post_purchase` | Os três com consumidor pronto hoje. `messages` entra quando a ingestão existir |
| Permissões funcionais | incluir **Comunicação pré e pós-venda** | Requisito de `questions`/`messages`/`claims` (D-083). Contas autorizadas ANTES dessa permissão existir precisam ser **reautorizadas** — o token não ganha permissão nova sozinho |

**Como verificar que funcionou** (não presumir):

```
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="api"
  AND httpRequest.requestUrl:"/webhooks/"' --freshness=1h
```

Requisição com status `200` = notificação aceita. Status `403` = a allowlist de
IP recusou a origem — ver o risco registrado em D-091/D-045 sobre a extração do
IP a partir de `X-Forwarded-For`, que nunca foi validada contra uma chamada
real do Mercado Livre. Nenhuma requisição = o painel ainda não está enviando.

---

## 7. CI/CD

**GitHub Actions** (`.github/workflows/ci.yml`), obrigatório antes de entrar na `v3`:

```text
typecheck -> lint -> testes unitários -> testes de integração -> build -> aplicar migrations no Dev
```

- Migrations aplicadas **por CI** (`supabase db push`, job `migrations`), nunca à mão, nunca pelo dashboard — só em push na `v3`, depois de `check`/`scripts`/`integration` verdes. **Em produção**, só por `.github/workflows/migrations-producao.yml`, disparado à mão na `v3`, com duas aprovações no ambiente `producao` (D-334; primeira execução em 2026-09-14).
- Deploy do `web` pela integração nativa da Vercel com a branch — esse sim é automático.
- **Deploy de `api` e `worker` é MANUAL** — `bash infra/deploy-cloud-run.sh` (worker primeiro, depois api — secao 3). Não existe workflow do GitHub Actions que publique no Cloud Run. Quem roda o deploy é responsável por conferir CI verde antes ("nenhum deploy sem CI verde" é regra de operador, não trava automática).

**Achado real em 2026-08-24, D-065:** o `worker`/`api` de produção ficaram 36 commits atrás do HEAD e 5 jobs do Cloud Scheduler documentados como "rodando" nunca tinham sido criados de fato — ninguém rodou `deploy-cloud-run.sh`/`cloud-scheduler.sh` depois de várias sessões de trabalho de features. Nasceu daí a regra abaixo, agora also em `docs/HANDOFF.md`.

### Documentação não comprova deploy

Antes de declarar qualquer mudança operacional como implantada, verificar contra a infraestrutura real, nunca contra o texto do HANDOFF/ROADMAP:

- `gcloud run services describe api/worker --project <projeto> --region southamerica-east1 --format='value(status.latestReadyRevisionName)'` — **sempre com `--project`**, porque o padrão do `gcloud` na máquina do dono é produção (D-350) — e comparar a tag da imagem (`git rev-parse --short HEAD` no momento do deploy) contra o commit atual;
- **a revisão nova servindo o tráfego** — desde D-341 o `deploy-cloud-run.sh` falha se ela não serve 100%. Com o tráfego fixo numa revisão (depois de um `update-traffic --to-revisions`, como a volta de D-340), a revisão publicada nasce com 0% e o deploy sairia verde com o commit antigo no ar. **E nunca `--to-latest` com o tráfego fixo** (D-342): nesse estado `latestReadyRevisionName` não anda para a revisão nova — o próprio `gcloud run deploy` imprime o nome errado —, e "latest" seria a revisão anterior. Publique por nome (`--to-revisions <revisão>=100`, conferindo `APP_COMMIT` em `gcloud run revisions list`), confira `/health`, e só desfixe com `--to-latest` quando `latestReadyRevisionName` já for a revisão servindo;
- `gcloud scheduler jobs list --project <projeto> --location southamerica-east1` contra os jobs esperados (`infra/cloud-scheduler.sh` é a lista canônica);
- `pnpm exec supabase migration list --linked` (local == remoto, sem drift);
- CI do commit exato verde (`gh run list`/`gh run view`), não presumido;
- logs de boot sem `ERROR` (`gcloud logging read ... severity>=ERROR`) depois de um deploy novo;
- para um job que nunca rodou de verdade em produção, disparar manualmente uma vez (`gcloud scheduler jobs run <nome> --project <projeto> --location southamerica-east1`) e conferir **o que ele fez** antes de confiar na cadência automática. **O 200 do agendador e o `done` do job não provam trabalho** (D-350): o handler pode responder 200 falhando por dentro (`accounts_not_listed`), e o Full saiu `done` com 0 processados porque rodou antes dos vínculos. Confira `processed` em `job_runs` e a tabela que o job alimenta; respeite a dependência (anúncios e vínculos antes do Full); e lembre que a chave de vários jobs é por hora — redisparo na mesma hora é descartado.

---

## 8. Rollout da V3 (Fase 8)

1. Migrar `infra/` para Terraform.
2. Criar projeto Supabase de produção e serviços Cloud Run de produção.
3. Executar a carga inicial: backfill do Mercado Livre para pedidos e anúncios. ETL da V2 para vínculos/estoque/NF-e foi descartado por evidência medida (D-040); só resta, se ainda fizer sentido no momento, migrar o(s) pedido(s) de compra reais da V2.
4. Verificar backup e restore — restore testado, não apenas backup configurado. **O ensaio está pronto (D-332)**: roteiro em 8.1, corrigido em D-347.
5. Testes de carga e revisão de `pg_stat_statements`.
6. Revisão de segurança e de secrets — **fechada** (D-328 a D-331).
7. Corte da operação. Antes dele, criar o ambiente de produção: roteiro em 8.2.

### 8.1 Ensaio de restore

O que existe, medido em 2026-09-13 no projeto Dev: **backup físico diário** (~06:00 UTC, 03:00 em Brasília), **oito listados, ~7 dias de retenção**. PITR não confirmado. Os arquivos não moram no Supabase: estão no GCS (`erp-imports`, `documents`, `raw-ml`), com **soft delete de 7 dias** e **sem versionamento** — o backup do banco não os inclui, e o ensaio abaixo não os cobre.

> ⚠️ **Roteiro corrigido em D-347.** A primeira versão mandava escolher o backup na aba *Scheduled backups* — onde o botão "Restore" **sobrescreve o próprio Dev** —, trazia o comando em sintaxe bash (no Windows PowerShell desta máquina `pnpm` não roda: política `Restricted`), conectava sem SSL e usava o horário da lista como `BACKUP_AT`, o que pode reprovar um restore bom.

**A. Antes — só leitura no Dev**

1. Plano **Pro ou superior**: o restore em projeto novo só existe em plano pago, com backup físico ligado.
2. **Project Settings → Add-ons**: o PITR está ativo? Com PITR ligado não há backup diário, e o passo 6 vira escolher data e hora.
3. **Database Settings → SSL Configuration**: "Enforce SSL" está ligado? Só anotar — mudar reinicia o banco, e o clone herda a configuração.
4. Fazer fora da janela 05:30–07:00 UTC (02:30–04:00 em Brasília), onde já estão o backup e os jobs horários.

**B. Restaurar**

5. **Database → Backups → aba "Restore to new project"** (Beta). ⚠️ **Nunca** o "Restore" da aba *Scheduled backups*: ele restaura sobre o Dev ("Any new data since this backup will be lost"). Se a aba não aparecer ou recusar — plano, feature flag, permissão, projeto com High Availability, OrioleDB, Postgres abaixo de 15, projeto offline ou que já é clone —, pare: não improvise pela outra aba.
6. **Escolher o backup** na lista e anotar o horário mostrado — UTC, `DD MMM YYYY HH:mm:ss (+0000)`, campo `inserted_at`. Ele **não** é o `BACKUP_AT` (passo 10).
7. **Restore** → diálogo "Create new project": nome (ex.: `sb-restore-ensaio-AAAAMMDD`) e uma **Database password** nova, guardada no gerenciador de senhas. A tela mostra o custo **mensal** adicional (mesmo compute do Dev, disco 1,5×); o cobrado é por hora, e hora começada conta inteira. **"Restore to new project"**, anotando a hora do clique.
8. Anotar a hora em que o projeto ficou pronto — é o tempo de restore, que nunca foi medido.

**C. No restaurado, pelo SQL Editor — antes do comparador**

9. **Extensões que agem para fora vêm ATIVAS no clone** (documentação do Supabase). Nenhuma migration as cria (conferido em D-347), mas o Dashboard poderia ter criado. Uma consulta só, de propósito — o SQL Editor mostra apenas o resultado da última instrução:

   ```sql
   select
     (select string_agg(extname, ', ') from pg_extension where extname in ('pg_cron','pg_net','http','wrappers','dblink','postgres_fdw','pgmq')) as extensoes,
     to_regclass('cron.job') as cron,
     (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('supabase_functions','net')) as gatilhos_http,
     (select count(*) from pg_foreign_server) as foreign_servers,
     (select count(*) from vault.secrets) as segredos_vault;
   ```

   Esperado: `extensoes` e `cron` nulos, `gatilhos_http` e `foreign_servers` 0. `segredos_vault` acima de 0 não age sozinho, mas vai para o registro: a chave raiz do Vault vem junto no clone, e os segredos ficam legíveis nele. A tabela `supabase_functions.hooks` existir, sem gatilho, também não age. Se vier outra coisa, desligar **no restaurado** (confira o ref no topo) antes de seguir:

   - `cron` não nulo: `select jobid, jobname, schedule, active from cron.job;` e `select cron.alter_job(jobid, active := false) from cron.job;`
   - `gatilhos_http` acima de 0: `select t.tgrelid::regclass, t.tgname from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('supabase_functions','net');` e `drop trigger <tgname> on <tabela>;` para cada linha.
   - Os dois comandos de desligar **não foram executados**: o banco local não tem `pg_cron` nem gatilho desses para testar.

10. **Calcular o `BACKUP_AT`:**

    ```sql
    select to_char(
      date_trunc('minute', greatest(
        (select max(created_at) from public.job_runs),
        (select max(created_at) from public.domain_events),
        (select max(created_at) from public.stock_movements),
        (select max(created_at) from public.sync_runs)
      ) - interval '15 minutes') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as backup_at;
    ```

    Por que não o horário da lista: a documentação não diz se `inserted_at` é o início ou o fim do backup, e o comparador exige contagem **igual** até `BACKUP_AT` — um instante depois do ponto consistente faz o Dev contar a mais e reprova um restore bom. Toda linha presente no restaurado foi gravada antes desse ponto, então o maior `created_at` dele é um limite seguro; os 15 minutos cobrem transação aberta por até 15 minutos (`now()` marca o início dela). A margem certa não é verificável — por isso a leitura do FAIL, na parte E, não confia nela.

    - **Resultado nulo:** as quatro tabelas estão vazias no restaurado. É restore reprovado: não rode o comparador; registre e pare.
    - **Mais de 1 h longe do horário da lista:** confira se escolheu o backup certo.
    - **Se o passo 9 achou algo ativo,** um job pode ter gravado no restaurado antes de ser desligado e empurrado o maior `created_at` para depois do backup: use o menor entre o resultado e o horário da lista menos 15 minutos.

**D. Rodar o comparador** — só lê: as duas sessões abrem em `READ ONLY`, e as URLs nunca são impressas. O ref do restaurado está na URL do Dashboard (`.../project/<ref>`).

⚠️ **Cole um bloco por vez e espere cada um terminar.** Os blocos que pedem senha vão **sozinhos**: colados junto com outras linhas, dependendo de como o terminal cola, a linha seguinte pode ser lida como a senha — e falha repetida de autenticação bane o IP.

No **Windows PowerShell**:

**Bloco 0** — entrar na pasta:

```powershell
Set-Location 'C:\Users\usuario\Desktop\Projetos\speedbikers-gestao-v2'
```

**Bloco 1** — senha do Dev, sem eco e fora do histórico:

```powershell
$env:DEV_DB_URL = 'postgresql://postgres:' + [uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'Senha do banco DEV' -AsSecureString)))) + '@db.nmgccyqquwxecqffsidr.supabase.co:5432/postgres?sslmode=no-verify'
```

**Bloco 2** — senha do restaurado; antes de colar, troque `<REF_RESTAURADO>`:

```powershell
$env:RESTORED_DB_URL = 'postgresql://postgres:' + [uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'Senha do banco RESTAURADO' -AsSecureString)))) + '@db.<REF_RESTAURADO>.supabase.co:5432/postgres?sslmode=no-verify'
```

**Bloco 3** — o valor do passo 10:

```powershell
$env:BACKUP_AT = '<AAAA-MM-DDTHH:MM:00Z>'
```

**Bloco 4** — recusa placeholder esquecido, URL igual ou do Dev, e roda:

```powershell
if ($env:DEV_DB_URL -eq $env:RESTORED_DB_URL -or $env:RESTORED_DB_URL -like '*nmgccyqquwxecqffsidr*' -or $env:RESTORED_DB_URL -like '*<*' -or $env:BACKUP_AT -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$') { Write-Error 'RESTORED_DB_URL ou BACKUP_AT invalido: placeholder esquecido, ou URL do Dev' } else { pnpm.cmd --filter '@sb/db' run check:restore; "codigo de saida: $LASTEXITCODE" }
```

No **Git Bash**, o equivalente em três blocos:

**Git Bash 1** — troque os dois valores e cole:

```bash
cd /c/Users/usuario/Desktop/Projetos/speedbikers-gestao-v2
REF_RESTAURADO='<REF_RESTAURADO>'
BACKUP_AT_CALCULADO='<AAAA-MM-DDTHH:MM:00Z>'
enc() { printf '%s' "$1" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(encodeURIComponent(s)))'; }
```

**Git Bash 2** — as duas senhas, sem eco:

```bash
IFS= read -rsp 'Senha DEV: ' SD; echo; IFS= read -rsp 'Senha RESTAURADO: ' SR; echo
```

**Git Bash 3** — recusa placeholder esquecido ou ref do Dev, roda e apaga as senhas:

```bash
if [[ "$REF_RESTAURADO" == *nmgccyqquwxecqffsidr* || "$REF_RESTAURADO" == *'<'* || ! "$BACKUP_AT_CALCULADO" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$ ]]; then
  echo 'REF_RESTAURADO ou BACKUP_AT invalido: placeholder esquecido, ou ref do Dev'
else
  DEV_DB_URL="postgresql://postgres:$(enc "$SD")@db.nmgccyqquwxecqffsidr.supabase.co:5432/postgres?sslmode=no-verify" \
  RESTORED_DB_URL="postgresql://postgres:$(enc "$SR")@db.$REF_RESTAURADO.supabase.co:5432/postgres?sslmode=no-verify" \
  BACKUP_AT="$BACKUP_AT_CALCULADO" \
    pnpm --filter @sb/db run check:restore; echo "EXIT=$?"
fi
unset SD SR
```

- **As travas existem porque o placeholder engana:** o Node aceita `<AAAA-MM-DDTHH:MM:00Z>` como data válida, e o script então **conecta nos dois bancos** — gastando tentativa de senha — e reprova tudo com "invalid input syntax".
- **`pnpm.cmd`, não `pnpm`**, no PowerShell: `pnpm` resolve para `pnpm.ps1`, que a política `Restricted` recusa.
- **`sslmode=no-verify`** criptografa sem verificar o servidor. Sem `sslmode` a conexão sai em texto claro; `sslmode=require` no `pg-connection-string` 2.14 vira `verify-full` e falha com `SELF_SIGNED_CERT_IN_CHAIN` (a cadeia termina na Supabase Root 2021 CA). A verificação completa (`sslmode=verify-full&sslrootcert=<prod-ca-2021.crt>`) não foi testada.
- **A senha passa por percent-encoding**: `#`, `/` ou `?` crus dão `ERR_INVALID_URL`, e um `%41` cru vira outra senha sem aviso. No Git Bash ela chega ao `node` pela entrada padrão, não por variável: o Git Bash reescreve variável que parece caminho (`/abc` vira `C:/Program Files/Git/abc`), e o `IFS=` preserva espaço no começo e no fim.
- **A conexão direta `db.<ref>.supabase.co` é só IPv6** — esta máquina alcança (D-347). Sem IPv6 (`ENETUNREACH`/`EHOSTUNREACH`): botão **Connect** → *Session pooler*, e nas duas URLs troque `postgres:` por `postgres.<ref>:` e `db.<ref>.supabase.co` pelo host do pooler, mantendo a porta **5432** e `/postgres?sslmode=no-verify`. **Nunca a 6543**: em modo transaction o `READ ONLY` da sessão se perde.
- **Duas senhas erradas: pare.** Falha repetida de autenticação bane o IP. Se só a do restaurado falhar, redefina **no restaurado**. **Não redefina a do Dev**: o job de migrations da CI usa `SUPABASE_DB_PASSWORD` (`ci.yml`).

**E. Ler o veredito**

`RESTORE_OK` exige que nenhuma linha saia FAIL: toda migration do restaurado existe no Dev; RLS ligada em toda tabela de `public`; as 8 tabelas append-only com `created_at` com a MESMA contagem **dentro da janela datada** nos dois lados, e as 4 com a data do fato (`occurred_at`, `changed_at`, `requested_at`) com o restaurado ≤ Dev; `auth.users` criados até `BACKUP_AT` com o restaurado ≥ Dev; e o ledger de estoque batendo com a projeção dentro do restaurado, com ao menos uma organização. As tabelas de catálogo saem como INFO — a diferença é o Dev andando, não defeito —, mas uma contagem que quebra nelas também vira FAIL.

**A janela datada, e por que ela existe (D-348).** Nas 8 tabelas exatas a comparação não vai de zero até `BACKUP_AT`: vai da **linha mais antiga que o Dev ainda tem** até `BACKUP_AT`. "Append-only" fala do gatilho que recusa UPDATE/DELETE, não da RETENÇÃO — e há retenção rodando: medido em 2026-09-14, `job_runs` acumula 278.371 linhas apagadas e a mais antiga que restou é de 20 de agosto. Sem o piso, o clone guarda o que o Dev já expurgou e o comparador **reprovava um restore bom**, com o veredito "restaurado maior". Cada linha da saída agora nomeia o piso que usou (`de 2026-08-20T00:00:00.000Z até o backup: …`), e o que o restaurado tem abaixo dele sai como uma INFO `<tabela>: expurgo`, com a contagem — **essa INFO é esperada em `job_runs`**. O que a janela não prova está dito no cabeçalho do script: linha anterior ao piso que o restore tenha perdido é invisível daqui, porque o Dev também não a tem para comparar.

| saída | leitura |
|---|---|
| código 0, `RESTORE_OK` | passou — **só aceite** com `job_runs`, `domain_events` e `stock_movements` longe de zero e alguma INFO com diferença ≠ 0. Contagens zeradas = papel sem `BYPASSRLS`; toda INFO com diferença 0 = a mesma base nos dois lados |
| código 1 **sem** a linha `RESTORE_...` | não é veredito: quebrou fora das seções — ao conectar, ao abrir o `READ ONLY` ou ao fechar no fim. Leia a exceção |
| código 2 | variável faltando, ou `BACKUP_AT` que o Node não entende. Um placeholder esquecido **não** dá 2 (ver as travas acima) |
| exata com o Dev maior | o `BACKUP_AT` já está 15 min abaixo da linha mais nova do restaurado, então sobram duas explicações: transação aberta por mais de 15 min, ou **perda**. Rode nos DOIS projetos, no SQL Editor, `select date_trunc('minute', created_at) as minuto, count(*) from public.<tabela> where created_at > timestamptz '<BACKUP_AT>' - interval '2 hours' and created_at <= '<BACKUP_AT>' group by 1 order by 1;` e compare minuto a minuto: poucas linhas num minuto só é transação longa; diferença espalhada é perda. **Rodar de novo com um `BACKUP_AT` mais cedo não absolve** — só tira a janela da comparação |
| exata com o restaurado maior | **não é mais o expurgo** — desde D-348 a comparação tem piso datado e a retenção sai como INFO `<tabela>: expurgo`. Sobram duas explicações: linha gravada no Dev com `created_at` retroativo (nenhuma das 8 informa a coluna no INSERT, então seria defeito novo), ou perda de linha NO DEV dentro da janela. Compare minuto a minuto, como na linha acima |
| aproximada com o restaurado maior | defeito |
| `auth.users` com o restaurado menor | usuário perdido, ou transação longa: a mesma consulta da linha das exatas, com `auth.users` no lugar da tabela |
| migrations em FAIL, "só no restaurado" ou restaurado 0 | uma das URLs aponta para o projeto errado |
| RLS em FAIL | rode a mesma consulta no Dev: se lá também falta, a tabela nasceu sem RLS; se não, é defeito do restore |
| ledger em FAIL com "0 organização(ões)" | o restaurado não tem organização: restore reprovado |
| ledger × projeção em FAIL | rode a régua no SQL Editor do Dev (a consulta da seção 4 do script, só leitura). Bater hoje não prova que batia no backup — `v3-reconcile-balances` roda todo dia e pode ter corrigido; a referência é a execução da verificação do ledger mais próxima do backup, em `job_runs` |
| "a seção quebrou: …" | não é contagem: leia a mensagem na tabela abaixo |

| mensagem | causa |
|---|---|
| `pnpm.ps1 não pode ser carregado` | digitou `pnpm`; use `pnpm.cmd` |
| `SELF_SIGNED_CERT_IN_CHAIN` | URL com `sslmode=require` ou `verify-full` sem CA; use `no-verify` |
| `ERR_INVALID_URL` | senha colada sem codificar, ou `<` `>` sobrando no ref |
| `invalid input syntax for type timestamp with time zone` | `BACKUP_AT` com placeholder ou formato errado |
| `ENOTFOUND` | ref errado, ou o DNS do projeto novo ainda não publicou |
| `ENETUNREACH` / `EHOSTUNREACH` | rede sem IPv6; use o *Session pooler* |
| `connect ETIMEDOUT`, ou nenhuma resposta | firewall ou VPN, ou IP banido depois de falhas de senha — não insista |
| `password authentication failed` | senha errada |
| `Tenant or user not found` | pooler com host ou usuário errado |
| `canceling statement due to statement timeout` | uma contagem passou de 120 s; rode de novo |
| `permission denied for function compute_inventory_balances_from_ledger` | o usuário não é `postgres` |

**F. Encerrar**

11. No PowerShell, limpar e **fechar a janela**: `Remove-Item Env:DEV_DB_URL, Env:RESTORED_DB_URL, Env:BACKUP_AT -ErrorAction SilentlyContinue`. No Git Bash, o `unset SD SR` do bloco Git Bash 3 apaga as senhas; o que sobra na sessão (o ref, o `BACKUP_AT` e a função `enc`) não é segredo.
12. **Registrar numa D-xxx antes de apagar:** commit do `restore-check.mjs`; horário da lista, o maior `created_at` antes dos −15 min e o `BACKUP_AT` usado; estado do PITR e do SSL; custo mostrado; horas do clique e do projeto pronto; saída completa com o código de saída; resultado do passo 9; ref do restaurado; e, depois de apagar, a hora da exclusão.
13. **Apagar o projeto restaurado:** conferir no topo que o ref **não** é `nmgccyqquwxecqffsidr` → **Settings → General → Delete project** → digitar o nome. Irreversível; a cobrança para na hora.
14. Em nenhum momento apontar `.env.local`, `api` ou `worker` para o restaurado: ele leva hashes de senha, os tokens do Mercado Livre cifrados e a chave raiz do Vault.

**O que o ensaio não prova:** os arquivos do GCS; configuração de Auth e chaves de API (o clone não as copia); conteúdo de linha (só contagens); as tabelas de catálogo (a diferença é INFO); as demais tabelas de `public` — são 61 no banco local, e o comparador conta 21 —, como `support_cases`, `order_items` e `ml_credentials`, das quais só se sabe que têm RLS; as políticas de RLS (só que ela está ligada); `api` e `worker` rodando contra o restaurado; o RPO (até ~24 h de perda com backup diário); o PITR; o restore sobre o próprio projeto; e produção.

### 8.2 Criar o ambiente de produção (D-333)

Todo passo abaixo é **ato humano** — criar projeto, gerar chave e colar segredo não são coisas que um agente faz. O que o repositório garante é que os scripts **recusam misturar** produção com o Dev (`infra/README.md`, seção Ambientes).

**O buraco da Vercel está fechado (2026-09-14, D-350):** produção tem projeto próprio, `speedbikers-prod`, com as `NEXT_PUBLIC_*` de produção (conferido na CSP de `/login`), e o `speedbikers-gestao-v2-m71j` segue sendo o Dev. Antes, o único projeto servia o `web` com as variáveis do Dev — inclusive no alvo *production* da `v3`. (O outro buraco de D-333, migrations de produção sem caminho, fechou em D-334 — é o passo 2.)

**E a armadilha que ele esconde (D-348):** o projeto em questão é `speedbikers-gestao-v2-m71j`, e a URL dele é exatamente o `DEV_WEB_ORIGIN` de `infra/lib.sh`. **Apontar um domínio próprio para ele não cria produção** — cria um segundo nome para o Dev. O `NEXT_PUBLIC_SUPABASE_URL` é embutido no build, e o build é um só: a tela sob o domínio novo continuaria lendo o banco do Dev, e a guarda de ambiente nem veria, porque ela compara a string da origem e o domínio novo é uma string nova. Os dois caminhos coerentes são: **projeto novo na Vercel para produção** (o m71j segue sendo o Dev, e `DEV_WEB_ORIGIN` não muda), ou **transformar o m71j em produção** — trocando as três `NEXT_PUBLIC_*` para os valores de produção, criando um projeto novo para o Dev e **atualizando `DEV_WEB_ORIGIN` em `infra/lib.sh` e o caso correspondente de `infra/ambiente.test.sh`**, senão a guarda passa a defender um endereço que virou produção.

**O formato do `WEB_ORIGINS` passou a ser validado** em `infra/lib.sh` (D-348): origem completa com esquema, sem barra no fim e sem caminho, várias separadas por vírgula sem espaço. Antes nada conferia isso, e uma barra a mais só aparecia em produção, como CORS negado — o navegador manda `Origin: https://host` sem barra, e a comparação é igualdade exata. A **primeira** origem da lista é também para onde o link do convite leva.

**As variáveis de cada comando** (nenhuma tem padrão em produção):

```bash
export AMBIENTE=prod PROJECT_ID=<projeto-gcp-prod> \
  SUPABASE_PROJECT_REF=<ref-prod> SUPABASE_PUBLISHABLE_KEY=<publicável-prod> \
  WEB_ORIGINS=<https://web-prod> CONFIRMO_PRODUCAO=sim
```

1. **Projeto no Google Cloud**, com billing ligado.
2. **Projeto no Supabase**, em `sa-east-1`, com as migrations aplicadas por **`.github/workflows/migrations-producao.yml`** (D-334) — nunca `db push` do próprio computador, que não deixa registro nem sabe se o commit passou pela CI:
   - **Ambiente no GitHub**: Settings → Environments → `producao`, com *Required reviewers* (pelo menos um) e *Deployment branches* só na `v3`. Sem as duas travas o workflow recusa — e é a restrição de branch, não o arquivo do workflow, que impede um workflow alterado noutra branch de receber os segredos.
   - **No ambiente**: a variável `SUPABASE_PROD_PROJECT_REF` e os segredos `SUPABASE_PROD_ACCESS_TOKEN` e `SUPABASE_PROD_DB_PASSWORD`. Os nomes têm `PROD` de propósito: segredo do repositório também chega a um job com ambiente, e o `SUPABASE_DB_PASSWORD` do repositório é a senha do Dev.
   - **Disparo**: Actions → *Migrations de produção* → *Run workflow* na `v3`, digitando o ref de produção. `origem` recusa se a CI do mesmo commit não passou ou não aplicou no Dev; `plano` pede a primeira aprovação e mostra `migration list` e `db push --dry-run`; `aplicar` pede a segunda e aplica. O workflow só aparece em Actions porque a `v3` é a **branch padrão** do repositório (D-335): o GitHub só oferece disparo manual para workflow que exista na branch padrão. **Conferido no primeiro disparo** (2026-09-14, execução 34857929771): o GitHub pediu as duas aprovações em separado.
   - **Conferir**: `supabase migration list --linked` sem drift — o próprio `aplicar` deixa essa listagem no log.
3. **Base do GCP**, na ordem: `bash infra/setup-dev.sh`, `bash infra/cloud-tasks-queues.sh`, `bash infra/storage-buckets.sh`. O nome `setup-dev.sh` é histórico; ele serve a qualquer `AMBIENTE`. Ele liga as APIs, **cria o repositório `speedbikers-v3` no Artifact Registry** (D-349 — até ali nada o criava, e a falta só aparecia no push, depois do build inteiro), cria as quatro service accounts e concede `secretAccessor` dos **quatro** segredos — os mesmos que `deploy-cloud-run.sh` monta em `--set-secrets` (D-348). **Na primeira passada os segredos ainda não existem**, e em `AMBIENTE=prod` o script PARA listando o que falta: crie-os (item 4) e rode de novo, que ele é idempotente. Essa parada existe porque a montagem do segredo acontece na partida do container, não no deploy — sem ela o deploy do item 5 sai verde e a revisão nova nunca parte.
4. **Segredos no Secret Manager DO PROJETO DE PRODUÇÃO** (seção 5): `SUPABASE_SERVICE_ROLE_KEY` do Supabase de produção; `MERCADO_LIVRE_CLIENT_SECRET`; `ANTHROPIC_API_KEY`; e **`ML_TOKEN_ENCRYPTION_KEY` NOVA** — nunca a do Dev: é ela que cifra os tokens das contas, e compartilhar a chave entre ambientes compartilha a capacidade de ler os tokens um do outro. O formato é exato: **base64 que decodifica para 32 bytes** (AES-256). Gere com `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` ou, se preferir o openssl, com `openssl rand -base64 32`. **Nunca `openssl rand -hex 32`**: hex dá 64 caracteres, que lidos como base64 viram ~48 bytes, e a `api` e o `worker` recusam no boot com "precisa decodificar em base64 para 32 bytes (AES-256)" (`loadEncryptionKey`, `packages/mercado-livre/src/token-cipher.ts`). Prefira criar pelo **console** do Secret Manager, colando o valor no formulário: assim o segredo não passa pelo histórico do shell.
5. **Deploy**: `bash infra/deploy-cloud-run.sh`, que publica o `worker` antes da `api` (D-088). No primeiro deploy a `api` ainda não conhece a própria URL — o script avisa, e o segundo deploy a injeta.

   **A `api` fica com DUAS URLs** (D-349). O Cloud Run devolve a nova (`api-<número-do-projeto>.<região>.run.app`, a que o console mostra no cabeçalho) e a legada (`api-<hash>-<rg>.a.run.app`, que `status.url` devolve). O script lê `status.url`, então é a **legada** que vira `API_URL` — audience do OIDC — e o padrão de `MERCADO_LIVRE_REDIRECT_URI`. Use essa mesma em `NEXT_PUBLIC_API_URL` e no cadastro do Mercado Livre: as duas respondem, mas copiar a do console dá dois nomes para a mesma `api`.

   **A NF-e depende de `DOCUMENTS_BUCKET`**, que o deploy passa aos dois serviços desde D-349. Ela é opcional no schema — um ambiente sem o bucket sobe igual —, mas sem ela a rota de upload e o handler de parse não são registrados, e o sistema fica verde com a funcionalidade desligada.
6. **Agendador**: `bash infra/cloud-scheduler.sh`.
7. **Vercel**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e `NEXT_PUBLIC_API_URL` de produção (ver o buraco acima). `NEXT_PUBLIC_*` é embutida no build: trocar a variável exige novo deploy.
8. **Mercado Livre**: antes de tudo, **a fila de cada conta** — `bash infra/cloud-tasks-queues.sh <slug>` para cada uma. Sem ela o webhook devolve 500 (`PERMISSION_DENIED` em `cloudtasks.tasks.create`): foram 546 em 2026-09-14, entre a conexão das contas e a criação das filas (D-350). Depois, redirect do OAuth e URL do webhook apontando para a `api` de produção (seção 6.1). **Se o app do Mercado Livre é o mesmo do Dev**, a URL de notificação é uma só: apontá-la para produção deixa o Dev sem webhooks, e o Dev continua agindo sobre as mesmas contas até ser pausado ou ganhar app próprio.
9. **Primeiro ADMIN** (seção 10) e **conexão das contas** (seção 10.1).
10. **Conferir antes do corte**: `GET /health` da `api` devolvendo o commit publicado; `check:restore` depois do primeiro backup (8.1); a CSP com nonce e zero violações em `/login` (D-331); e um job de cada tipo disparado à mão uma vez (seção 7), **na ordem das dependências** — anúncios, depois vínculos (a planilha do UpSeller), depois Full —, conferindo `processed` e a tabela alimentada, não o 200 do agendador. **Antes de importar a planilha num banco que já tem o histórico de pedidos**, leia D-350 §5: pedido antigo atualizado depois da captura baixa estoque que o UpSeller já tinha descontado.

    **A guarda de D-351 tem ordem, e cada passo depende do anterior:** (1) as cinco migrations `20260915140000`–`20260915140400` pelo caminho de sempre (Dev pela CI, produção por `migrations-producao.yml`) — **antes** do worker, porque o worker novo grava `source = 'backfill'` e `ESTORNO_PRE_CAPTURA`, que o CHECK antigo recusa e o flush da página aborta, e lê `get_order_return_movements`. No Dev o `UPDATE` do corte não toca nada (organização reconciliada, D-351 §3); **(2) conferir o corte ANTES de publicar o worker**, e não importar planilha nenhuma entre a migration e o deploy: `select count(*) from public.erp_stock_snapshots s join public.erp_import_batches b on b.id = s.batch_id where b.kind = 'STOCK' and b.parsed_at is not null and s.captured_at = b.parsed_at and private.erp_stock_export_instant(b.file_name, b.parsed_at) <> b.parsed_at and not exists (select 1 from public.stock_movements a where a.organization_id = s.organization_id and a.movement_type = 'AJUSTE_RECONCILIACAO')` deve dar 0. Se der mais, uma planilha entrou pelo worker antigo com o corte do parse: rode de novo o `UPDATE` de `20260915140000_erp_corte_da_exportacao.sql` ANTES do deploy. Se ele ficar para depois, a F3 aborta até ser refeito; o worker novo não estorna a venda da janela entre exportação e parse nem com esse corte (`get_erp_stock_cutoffs` devolve a exportação lida do nome em `exported_at`, D-351 §10), e o `UPDATE` refeito depois fecha o alvo com o real; (3) `worker` e `api` por `deploy-cloud-run.sh`; (4) **só então** a compensação `packages/db/scripts/compensacao-estorno-pre-captura-d351.sql`, **por psql** (`psql "$URL" -v ON_ERROR_STOP=1 -f ...`: o SQL Editor não mostra os NOTICE com o que entrou e com a organização que ficou de fora), com `v3-reconcile-balances` ainda pausado — ela não é migration de propósito, porque o worker antigo continuaria gravando venda sem par depois dela. Ela estorna o `VENDA_ML` sem par, limitado ao que o legado ainda não reverteu (2.171 estornos em 2026-09-15, e nenhum para os 2 pedidos cancelados E devolvidos), e repõe (venda + estorno + cancelamento) a venda anterior à planilha que o worker antigo nunca gravou e que cancelou depois dela (34 pedidos em 2026-09-15). **Aborta** se ainda houver snapshot carimbado com o corte do parse numa organização elegível; (5) a prova do próprio arquivo repetida depois de 1 h e de 24 h; (6) despausar a reconciliação é decisão do dono (D-350 §5). Retomar o Dev pede outra decisão: o legado de cancelamento E devolução dele (563 vendas) não é compensado (D-351 §6). O corte do parse que o Dev mantém não impede publicar este worker lá: a venda entre a exportação da planilha do Dev e o parse não é estornada (D-351 §10). O resíduo são os pedidos pagos dessa janela ainda sem `VENDA_ML` (4 em 2026-09-15): a venda entra com `occurred_at` antes do corte, fora do alvo, e a reconciliação a desfaz com +1 por unidade até a planilha seguinte.

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

As quatro contas estão provisionadas no Dev **e em produção** — em produção as filas só vieram às 17:42 de 2026-09-14, depois das conexões (ver 8.2, item 8). Automatizar essa criação exige uma identidade controlada com permissão de administrar filas e fica para o provisionamento da Fase 8; conceder `queueAdmin` ao runtime público da `api` violaria o menor privilégio. OAuth e backfill inicial usam a tela normalmente, mas a reconciliação/webhook da conta dependem da fila `ml-sync-<slug>` existir.

---

## 11. Pendências

- Validar o ambiente de produção (passo 10 da 8.2) e fazer o corte — produção foi criada em 2026-09-14 (D-350).
- Um app do Mercado Livre próprio para o Dev, antes de retomá-lo (D-350 §2).
- Automatizar, na Fase 8, o provisionamento da fila `ml-sync-<slug>` para contas novas; até lá usar o script versionado.
- Migrar os scripts `gcloud` para Terraform na Fase 8.
