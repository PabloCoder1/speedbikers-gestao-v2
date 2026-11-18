# Plano de migração e de retomada

> Database Sentinel, 17/11/2026. **Nada aqui foi executado.** Todo passo
> marcado **[dono]** é ato com cobrança, visível ao cliente ou em produção, e
> espera aprovação explícita.

## Parte 1 — Caminho recomendado: retomar a produção numa organização Pro

### 1.1 Antes (sem cobrança, sem tocar produção)

1. Conferir no painel do Supabase: data e motivo da pausa da produção, prazo
   de retomada, e se o projeto pausado aceita transferência.
2. Conferir se o projeto Dev deve continuar existindo (D-350: pausado desde
   14/09, sem app ML próprio).
3. Aplicar no **stack local** as migrations de otimização R5, R3/R4 e R1
   ([OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)) e rodar as suítes
   ([VALIDATION.md](VALIDATION.md)).

### 1.2 Retomada [dono]

Opção 1, se o pausado aceitar transferência:

1. **[dono]** Criar a organização `Speed Bikers` no plano **Pro** (US$ 25/mês;
   o crédito de US$ 10 cobre o Micro).
2. **[dono]** Transferir `imvjfgnaprqsfjlnsyev` para ela. A transferência não
   muda URL, chaves nem *ref*: Vercel, Cloud Run e OAuth continuam valendo.
3. **[dono]** Retomar o projeto.

Opção 2, se não aceitar:

1. **[dono]** Subir a `Neurix` para Pro, retomar a produção e transferir o
   Dev para uma organização Free. Se o Dev ficasse, cobraria ~US$ 10 a mais.

Sem cópia de dados, sem troca de URL e sem corte de banco: é a mesma
instância.

### 1.3 Depois de retomar

1. Medir no projeto real o que o backup não deu: `pg_database_size`,
   *bloat*, *dead tuples*, `pg_stat_user_indexes`, WAL. Atualizar o
   SIZE_REPORT.
2. Conferir que o worker e a api voltaram (revisões fixas, `APP_COMMIT`) e
   que `job_runs` cresce.
3. Recuperar o período da pausa: estado das contas (`ERROR` = nova
   autorização, pedido ao dono), janela de pedidos do ML, Shopee e TikTok.
4. Publicar as migrations de otimização pelo workflow de produção (CI da
   `main` verde, duas aprovações, nunca pelo MCP).
5. Ativar o backup diário do Pro e registrar o teste de restore (item
   bloqueador do ROADMAP: "backup e restore verificados").

## Parte 2 — Contingência: migrar o banco para o Neon (cenário C)

Só se o dono escolher C ([ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md)).
**Não restaurar o dump de cluster num destino novo:** o restore de ensaio
mostrou ~40 erros só no schema `auth` (colunas que divergem entre versões do
GoTrue, chaves primárias duplicadas, FKs que caem) e `\connect` bloqueado
pelo `\restrict`.

1. **Origem atualizada:** a produção retomada, nunca o backup de 22/10.
   Dump por schema (`pg_dump --schema=public --schema=private`), sem
   `auth`/`storage`/`realtime`/`supabase_*`.
2. **Destino:** projeto Neon novo, `speedbikers-prod`, em `aws-sa-east-1`, PG
   17. **[dono]** aprova o custo antes de criar. Projetos Neon existentes
   não são tocados.
3. **Schema pelas migrations do Git** (305 na `main`; mais 10 só na
   `codex/sentinel-audit`), com os ajustes de compatibilidade: *shim* de
   `auth.uid()`/`auth.jwt()`, `pg_cron` ou
   agendador externo. Conferir `supabase_migrations.schema_migrations`
   contra o Git antes.
4. **Dados:** `pg_restore --data-only --disable-triggers` (os gatilhos
   append-only recusariam), na ordem das FKs. Depois, `setval` de todas as
   sequências e `analyze`.
5. **Auth:** fica no Supabase. Os `user_id` não mudam, porque `profiles.id`
   = `auth.users.id`.
6. **Acesso:** Neon Data API com JWKS do Supabase Auth; papéis `anon`,
   `authenticated` e `service_role` recriados com os mesmos *grants*.
7. **Código:** cliente de dados configurável por URL (web, api, worker);
   Realtime → *polling*; CI com Postgres próprio no lugar de `supabase start`.
8. **Captura de mudanças:** janela de escrita congelada (worker escalado
   a 0, Scheduler pausado, webhooks enfileirados no ML/Shopee por até a
   janela de reentrega), dump incremental das tabelas que mudaram,
   conferência pela VALIDATION §1. Sem escrita dupla.
9. **Corte [dono]:** troca das variáveis na Vercel e no Cloud Run (revisão
   nova, tráfego fixo, D-342), OAuth e webhooks continuam na api (URL igual).
   A origem fica intacta e pausada por pelo menos 30 dias ([ROLLBACK.md](ROLLBACK.md)).

## Parte 3 — Supabase próprio numa VM do Google Cloud (caminho sem cartão novo)

> Aberta em 18/11/2026, quando o dono informou que não consegue um cartão
> Visa ou Mastercard para o Supabase (a bandeira dele não passa). A cobrança
> do Google Cloud já existe para o Cloud Run, então a VM não pede meio de
> pagamento novo. **Nada aqui foi provisionado.**

**Por que este caminho e não o Neon (Parte 2).** Os componentes do Supabase
(Postgres, GoTrue, PostgREST, Realtime, Storage, Kong) são de código aberto e
rodam por `docker compose`. Web, api e worker só conhecem `SUPABASE_URL` e as
chaves, então trocar a URL basta: nenhuma tela, RPC ou política de acesso
muda. A stack local que o projeto já usa em todo teste (`supabase start`) é
essa mesma pilha, o que prova a compatibilidade com o código.

**Credenciais dos marketplaces não são problema.** Os tokens são cifrados na
aplicação (AES-256-GCM, chave no Secret Manager). O banco só guarda o texto
cifrado, e ele migra e continua decifrável. O schema `vault` do backup tem
24 kB. (A primeira versão destes documentos dizia, errado, que dependia do
Vault.)

### 3.1 Desenho

| Peça | Escolha |
|---|---|
| Máquina | Compute Engine em `southamerica-east1`, 2 vCPU e 8 GB, disco SSD de 100 GB, IP externo reservado |
| Pilha | `docker compose` oficial do Supabase: Postgres 17, Kong, Auth, PostgREST, Realtime, Storage. Sem Studio e sem edge functions (o projeto não usa) |
| HTTPS | Domínio próprio (ex.: `db.<domínio>`) + Caddy com certificado automático |
| Chaves | `JWT_SECRET` novo, chaves anon/service_role e publishable geradas por mim e guardadas no Secret Manager; nunca no Git |
| Backup | `pg_dump` diário para um bucket do Cloud Storage + snapshot diário do disco, com **teste de restauração** registrado |
| Atualização | Imagens fixadas por versão; subir versão é ato planejado, com o stack local de ensaio |
| Custo | **Estimativa: US$ 60–90/mês** (VM de 8 GB, disco, IP e tráfego). A estimativa anterior, de US$ 30–50, era baixa para uma máquina que roda a pilha inteira. Confirmar na calculadora do Google antes de criar |

### 3.2 Ensaio local (antes de gastar um centavo)

1. Subir a pilha oficial por `docker compose` na máquina local, com a mesma
   versão das imagens que irão para a VM.
2. Aplicar as migrations do Git (schema) e restaurar os dados do backup de
   22/10 em modo só-dados, com gatilhos suspensos, na ordem das chaves
   estrangeiras. Usuários do Auth entram pelo `auth.users` com o hash de
   senha original.
3. Apontar web, api e worker locais para ela e rodar `test:integration` e o
   e2e completo.
4. Medir o consumo de CPU e memória da pilha com a carga do seed, para
   fechar o tamanho da VM.

### 3.3 Atos do dono (sem cartão)

1. **Retomar a produção no plano Free** (`speedbikers-prod` → *Resume
   project*). Ela volta em somente leitura, que é o que basta para exportar o
   estado atual: nenhum dado novo entra e nada é perdido. Conferir antes, no
   painel, que o prazo de 90 dias da pausa não acabou.
2. Autorizar a criação da VM (custo em 3.1) no projeto `speedbikers-prod` do
   Google Cloud.
3. Decidir o domínio do banco e ajustar o DNS.

### 3.4 Corte

1. Escalar o worker a zero e pausar o Scheduler (sem escrita nova).
2. Dump final do Supabase de produção (somente leitura) e restauração na VM.
3. Conferência da [VALIDATION.md](VALIDATION.md) §1: contagem, soma de valores
   por mês, FKs e sequências.
4. Trocar `SUPABASE_URL` e as chaves na Vercel e no Cloud Run (revisão nova,
   tráfego fixo, D-342). Todos os usuários precisam entrar de novo, porque o
   `JWT_SECRET` é outro.
5. Reativar o worker e o Scheduler. Reler a janela do que ficou parado
   (`backfill.orders` e a janela de Shopee e TikTok).
6. O Supabase antigo fica intacto por 30 dias ([ROLLBACK.md](ROLLBACK.md)).
   Depois disso o projeto pode ser excluído, e o Free deixa de importar.

### 3.5 Riscos

| Risco | Mitigação |
|---|---|
| A manutenção passa a ser nossa (atualização, segurança, disco cheio) | Imagens fixas, alerta de disco e CPU, backup com restauração testada |
| Ponto único de falha (uma VM) | Snapshot diário e roteiro de recriação em minutos a partir do bucket |
| Realtime e Storage com ajuste fino diferente do gerenciado | Cobertos pelo e2e do ensaio (toast de notificação, avatar) |
| Prazo de 90 dias da pausa | Conferir no painel antes de tudo (3.3, item 1) |

### 3.6 Resultado do ensaio local (18/11/2026)

Pilha oficial do Supabase para auto-hospedagem (`docker compose`; imagens:
Postgres 17.6.1.136, GoTrue 2.197, PostgREST 14.18, Realtime 2.148, Storage
1.89, Envoy), com chaves novas e descartáveis, e o backup de 22/10 carregado.
O que foi provado, e o que não foi:

| Verificação | Resultado |
|---|---|
| 315 migrations do Git numa instalação vazia | Aplicadas sem erro em ~65 s |
| Carga dos dados do backup (91 tabelas, só-dados, FKs suspensas) | 63 s, sem erro |
| Contagem por tabela, origem × destino | **91 de 91 iguais** |
| Chaves estrangeiras do `public` | 216 verificadas, **0 órfãos** |
| Sequências | Todas à frente do maior id |
| Usuários do Auth e identidades | Migram com o hash de senha original (8 e 8) |
| Seis telas pesadas como `authenticated` (ADMIN) | Todas sem erro; a mais lenta, faturamento de 90 dias com detalhe, ~0,75–0,85 s |
| Mesmas telas com o banco limitado a 2 CPUs | Sem mudança relevante (0,74 s) |
| 3 usuários pesados ao mesmo tempo, 2 CPUs | Pior caso 1,9 s (o limite do papel é 8 s) |
| Auth próprio: criar usuário, entrar com senha, token `HS256` | Funciona (100–200 ms) |
| PostgREST pelo gateway com o token do usuário | RLS aplicada; anônimo recebe 401; usuário sem vínculo vê 0 linhas |
| Web real (build de produção) contra a pilha própria, banco só com o seed: login, notificações, home, faturamento, ajuste de estoque e saúde | **29 de 29 casos do Playwright passaram** |
| Storage: os 2 avatares do ZIP enviados e lidos pela URL pública | Idênticos byte a byte |
| Realtime: assinatura de `notification_recipients` e um UPDATE provocado | Evento recebido em ~1,2 s |
| Memória da pilha ociosa | ~2,1 GB com Studio, imgproxy, meta e functions; ~1,7 GB sem eles |

**Ajustes que o ensaio exigiu (valem para a VM):**

- **Disco.** Postgres não pode gravar numa pasta do NTFS do Windows (PANIC
  por `fsync`). Na VM Linux a pasta de dados é um disco SSD comum, sem esse
  problema. No ensaio local usei volume nativo do Docker.
- **Linhas-padrão.** Algumas migrations plantam linhas (`metric_definitions`,
  organização padrão, buckets). A carga apaga as linhas da tabela antes do
  `COPY` dela.
- **Colunas.** O `auth` do Supabase hospedado e o da pilha própria podem ter
  versões diferentes de GoTrue: a carga leva só as colunas comuns. Sessões e
  refresh tokens não migram (o `JWT_SECRET` muda, ninguém continuaria logado).
- **Tempos.** Medidos numa máquina de desenvolvimento. Uma vCPU de nuvem é
  mais lenta; o dimensionamento da VM (2 vCPU, 8 GB) tem folga de memória e
  precisa ser reconferido nas primeiras semanas.
- **Sem cron ainda.** O `pg_cron` existe na imagem, mas o agendamento (vigia,
  expurgo) é ato posterior ao corte.

**Não coberto pelo ensaio:** os demais ~280 casos de e2e (só rodei os de login, notificações, home, faturamento, estoque e saúde), o envio de e-mail do convite (a pilha local usa um SMTP falso; a VM precisa de SMTP real) e qualquer integração com marketplace (webhooks e OAuth dependem da URL final).

### 3.7 Atualização de 18/11/2026 (o painel recusou a retomada no Free)

- **O projeto não volta no Free:** o painel diz "database (2.0 GB) is too large to restore on the Free Plan". O número é o do disco. O banco lógico restaurado mede ~1,1 GB, e a diferença é *bloat* (linhas mortas que o autovacuum ainda não devolveu). Isso é mais um motivo para a retenção da D-721.
- **Não precisa retomar.** A mesma tela diz que os dados, os backups e os objetos de Storage seguem seguros e podem ser baixados (*Download backups*), e que o prazo para retomar vai até 27/11/2027. O ato 1 da §3.3 (retomar no Free) cai. Fica um ato: confirmar na lista de *Download backups* a data do último backup. Se for o de 22/10 16:26, esse backup é o estado de quando o projeto foi pausado, e o que já está baixado é completo.
- **Custo medido, e maior que o estimado.** Catálogo público do Google, São Paulo, sob demanda: VM `e2-standard-2` (2 vCPU, 8 GB) US$ 77,65/mês; disco SSD balanceado de 50 GB ~US$ 7,50; IP externo e snapshots ~US$ 5–10. **Total ~US$ 90–105/mês**, contra US$ 25 do Supabase Pro. Esse é o preço de não ter um cartão aceito pelo Supabase. Compromisso de 1 ano baixa a VM em cerca de um terço, mas prende o gasto.
- **Fora do ar desde a pausa.** Se a pausa foi em 22/10, o sistema está parado há quase 4 semanas: pedidos, estoque e SAC desse período entram pela releitura dos marketplaces (D-721 não tem relação). A data da pausa precisa ser confirmada.

### 3.8 A VM existe e está carregada (18/11/2026)

Autorizada pelo dono em 18/11 ("Sim, prepare"). Detalhes e operação em
`infra/selfhost-db/README.md`. **Não está em uso**: nenhum app aponta para ela, e ela não tem porta
aberta para a internet.

| Verificação na VM | Resultado |
|---|---|
| Pilha (11 contêineres) subiu sozinha pelo script de inicialização | Saudável, 2,0 GB de memória em uso, disco 26% |
| 305 migrations da `main` (o conjunto que o código implantado conhece) | Aplicadas; `schema_migrations` com 305 |
| Dados do backup | Carga em 1 min 47 s, sem erro; 91 de 91 tabelas com a mesma contagem; 216 FKs, 0 órfãos |
| Avatares no Storage | Enviados e lidos, idênticos byte a byte |
| Backup diário para o bucket | Dump de ~162 MB no bucket; **restaurado num banco descartável com as mesmas contagens** |
| Snapshot do disco | Diário, 7 dias |
| Portas de fora (22, 80, 443, 5432, 8000) | Todas sem resposta |

**Decisão de conteúdo:** só as migrations da `main` (até `20261022170000`). A `main` não tem nada
posterior a 22/10; as migrations de novembro (`codex/sentinel-audit`, #328, e as D-720 e D-721, #331)
chegam pelo fluxo normal depois do merge, com o código que depende delas. O banco de produção tinha
aplicado 298 das 305, e nenhuma que a `main` não conheça.

**O que falta para o corte**, em `infra/selfhost-db/README.md` (Pendências): domínio e HTTPS, SMTP,
paridade do Auth, agendamento do vigia, alertas, caminho das migrations de produção e a troca das
variáveis na Vercel e no Cloud Run.

### 3.9 Corte executado (18/11/2026, ~11:40 a 12:10 em Brasília)

Autorizado pelo dono ("Sim, pode cortar"). A produção passou a usar a VM `sb-db`, com os dados do
backup de 22/10 (o último que existe: a pausa foi em 22/10). Endereço provisório
`https://34-39-221-164.sslip.io` (sem domínio próprio; ver README de `infra/selfhost-db`).

| Peça | Antes | Depois |
|---|---|---|
| Segredo `SUPABASE_SERVICE_ROLE_KEY` (Secret Manager, lido pela `api` e pelo `worker` em `latest`) | versão 1 (Supabase hospedado) | versão 2 (VM) |
| `api` (Cloud Run) | `api-00038-qsf` | `api-00039-22b`, 100% do tráfego; `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` novos |
| `worker` (Cloud Run, tráfego fixado) | `worker-00056-wjk` | `worker-00058-mbc`, 100%; `SUPABASE_URL` novo |
| Web (Vercel, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`) | deploy `dpl_64mHs5sni1awBJEqjqcjF7UNmWtt` | `dpl_6zpmnqQQ1ibHguhxkq2Snfq24zv7`, mesmo commit `d6169205`, build com as variáveis novas |

**Verificado depois do corte:** `api` responde `/health`; o worker grava `job_runs` na VM (sincronização de
anúncios, SAC, devoluções e financeiro da Shopee, webhooks do ML e da Shopee chegando); as 4 contas do
ML seguem `CONNECTED`; a produção serve CSP com a VM em `https` e `wss`, e o pacote do navegador não
tem mais nenhuma referência ao projeto antigo. **Não verificado:** o login de um usuário real pela
interface (credenciais não são minhas) e a recuperação completa do atraso.

**Achado depois do corte:** `GET /items` do Mercado Livre devolve 403 em ~10% dos itens (anúncios ativos
na maioria), sem nenhum 403 igual em outubro. Ocorre durante a rajada de notificações represadas e cai
a cada faixa de 5 minutos. Acompanhar; se persistir depois da rajada, ver `ml-403-por-instancia`
(revisão nova do worker).

**O que deixa de existir:** a escrita que o banco hospedado teria recebido. O Supabase hospedado fica
pausado e intacto (retomável até 27/11/2027). A VM é a fonte da verdade a partir daqui.
