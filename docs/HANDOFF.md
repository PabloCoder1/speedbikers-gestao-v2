# Handoff V3 — estado corrente

> **Este documento é só o AGORA.** História não mora aqui: está em
> `docs/archive/handoffs/`, em `docs/DECISIONS.md` (por `D-xxx`) e no git.
> Se você veio parar aqui procurando "o que aconteceu na sessão tal",
> procure lá. Regra de D-177: quem lê este arquivo precisa saber onde o
> projeto está, não como chegou.

---

## Estado


| | |
|---|---|
| **Atualizado em** | 2026-09-16 |
| **Branch** | `v3` (D-354 em produção; D-356 na `v3`). `feat/faturamento`: D-357 (anúncio) e D-358 (reposição), PR #10 aberto |
| **HEAD conhecido** | `cf824a7` na `v3` — merge do PR #9 (D-356 `/faturamento`). Migrations chegam ao Dev pela CI só depois do merge. Toda página nova precisa ser dinâmica (D-331): estática sai sem nonce. Armadilhas de ambiente/build em `docs/TESTING.md`. |
| **Fechamento da V3** | **190 de 213 itens do ROADMAP fechados (89%)** — 21 abertos e 2 parciais (recontados em D-337; o item de produção fechou em D-350). Dos 21, **3 são bloqueadores**, todos hardening/lançamento (D-223): backup e restore verificados, testes de carga e rollout. Saíram a revisão de segurança (D-331), a UX da republicação (D-295) e a criação de produção (D-350) |
| **Deploy Dev** | ⏸️ **pausado** desde 2026-09-14 18:33 UTC (15 jobs e 7 filas, D-350). ✅ api `api-00041-lzn` e worker `worker-00052-jpk` em **`da130c0`** (19:22 UTC), com a NF-e ligada (`DOCUMENTS_BUCKET`, D-349); `/health` em `da130c0`, 100% do tráfego nas revisões novas. Para voltar: api `api-00040-qrk`, worker `worker-00051-thq`. ⚠️ Nunca `--to-latest` com tráfego fixo sem conferir `latestReadyRevisionName` (D-342); `api-00037-bqb` é o código revertido de D-339. **Esta linha envelhece sozinha** (D-070): o worker se confere por `gcloud run services describe worker --project speedbikers-gestao-v3`. |
| **Supabase** | Dev `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) · **produção `imvjfgnaprqsfjlnsyev`** (`speedbikers-prod`) |
| **Produção** | Verificada em 15/09 (D-354): GCP `speedbikers-prod`, API `api-00005-89w` em `cfb7291` (volta: `api-00004-n7c`) e worker `worker-00005-pcz` em `f88e0b2` (sem mudança), 100% do tráfego; health confirma commit. Vercel Production `dpl_5332PCoAwb3mjHMestdLLXDHppQu`, promoção de `cfb7291` (volta: `dpl_BMC4tyD93fQEco1CQv6gpnT7axuF`). Supabase com 168 migrations. Webhooks só em produção; Dev pausado (D-350). `v3-reconcile-balances` continua pausado pela guarda de estoque pendente. |
| **Migrations** | **168 locais e aplicadas em Dev/produção** — última `20260915160000` (D-354), conferida no banco dos dois em 15/09. **Pendentes:** `20260916123747` (D-357) e `20260916130908` (D-358), PR #10; sobem no Dev pela CI no merge — aplicar pelo MCP foi negado; sobe no Dev pela CI no merge — aplicar pelo MCP foi negado); produção via workflow `35013982423`. No Dev, o caminho é o push na `v3` (a CI tem o job *aplicar migrations no Supabase Dev*, verde em 2026-09-14; D-257 registrava a integração do Supabase); **em produção, só `migrations-producao.yml`**, com duas aprovações (D-334). **Nunca** pelo MCP (D-207). O nome do arquivo precisa ser um **instante válido**, não só um número crescente: `...240000` (hora 24) deixou seis casos de `get_system_health` vermelhos, e é esse teste que serve de guarda (D-307) |
| **Frente atual** | **Performance promovida para `v3`** (`aa847f5`, `54385ef`, `7ae7741`, `abc67dd`): Full com concorrência limitada e leitura paginada de snapshots, visitas em lote, busca com debounce/ordenação de respostas, Copiloto sob demanda, membership compartilhado por request, margem/ranking de Vendas sob `Suspense`, diretório de contas com refresh antecipado, vitals por rota e cache de build sensível a `.env*`. Check, build e `docs:check` passam. Produção verificada em `f88e0b2`: worker `worker-00005-pcz`, API `api-00004-n7c` (100% do tráfego, health confirmado), Vercel `dpl_4D8FTefUk3PueEJgsdyZVDBmqbmi`. Full medido, primeira amostra autenticada de navegador e seis RPCs de Vendas medidas com RLS: `docs/PERFORMANCE.md`. Restam telemetria de retries HTTP, coletor oficial de Web Vitals e amostra representativa. |

### O que está pronto

Fases 0–4, 5A–5D, 6, 6B, 7, 7B e 9 (backend) concluídas nos critérios
registrados. A trilha 5E entregou as seis centrais analíticas
(Movimentações, Dashboard 360º do Anúncio, abas do SKU, Preços, Full,
Fornecedor). A 8A entregou Usuários/Permissões (D-175) e Saúde do
Sistema (D-176). **Integrações e Configurações também existem** — a checagem de
D-271 desmentiu a nota anterior, que dizia faltarem.

Detalhe por fase: `docs/ROADMAP.md`. Motivo de cada decisão:
`docs/DECISIONS_INDEX.md` → `D-xxx` em `docs/DECISIONS.md`.

---

## P0 ativos (trilha 8B)

Medidos contra o Dev em 2026-09-01, não herdados de documentação.

**Todo o P0 da trilha 8B fechou** — A a H, cada um com a sua decisão: contexto
dos agentes (D-177), writes sem verificação (D-178), webhooks sem consumidor
(D-179), `has_role` sem organização (D-180), `SECURITY DEFINER` (D-182, sem
vulnerabilidade), e as três de desempenho (D-181, D-183). A frente passa para o
P1.

✅ **O bloco P0 está completo — os nomeados E os três sem letra.** Ficam
listados porque "P0 fechado, A a H" já foi o recorte só dos que tinham letra, e
isso tornava os outros três invisíveis:

| item | estado |
|---|---|
| ~~`get_system_health` com escopo de plataforma~~ | ✅ **fechado em D-209** |
| ~~`ml_accounts` com UPDATE/DELETE para `authenticated`~~ | ✅ **fechado em D-210** |
| ~~`pg_default_acl` de funções~~ | ✅ **fechado em D-211** |

Números completos e método: `docs/PERFORMANCE.md`.

---

## Riscos ativos

- **Um só app do Mercado Livre para Dev e produção** (D-350). A URL de notificação é
  uma só e está em produção desde 2026-09-14 17:30 UTC; o Dev ficou sem webhooks e
  está **pausado** (15 jobs e 7 filas). Retomá-lo sem app próprio volta a disputar a
  cota e a renovar os tokens das mesmas contas.
- **Baixa de estoque em dobro em produção, contida e ainda não corrigida** (D-350 §5):
  pedido antigo atualizado depois da planilha do UpSeller gera `VENDA_ML` de venda
  que o UpSeller já tinha descontado. `v3-reconcile-balances` de produção está
  **pausado** até a guarda e a compensação — não o retome antes.
- **O padrão do `gcloud` nesta máquina é `speedbikers-prod`.** Todo comando manual com
  `--project`; e no Windows `--format=value()` termina a linha com `\r` — em laço,
  `tr -d '\r'`, senão só o último item funciona.

- **As 22 RPCs foram varridas; sobra vigilância, não suspeita (D-305→D-307).**
  **Duas** tinham a doença do plano genérico
  (`get_listings_dashboard`, `get_stock_coverage`), uma tinha desperdício
  (`get_sales_expanded_summary`, `orders` lido duas vezes) e **16 estão
  saudáveis** — de 1 ms a 1,2 s de estado estável, nenhuma perto do teto de
  8 s. **A lição que fica é sobre a FONTE:** `get_stock_coverage` aparecia
  com 89 ms de média no `pg_stat_statements` e custava **27 s** na forma que
  a tela inicial usa — a estatística mede o que foi chamado, não o que pode
  ser. Toda RPC nova, ou toda mudança de volume, pede o ensaio deliberado:
  6 a 8 execuções como `authenticated`, **cada forma de chamada**, e comparar
  com o mesmo corpo em literais. Corpo rápido + função lenta = é o plano.

- **`supabase start` da CI falha as vezes, e a falha nao se distingue de
  defeito de migration pelo que a interface mostra** — aconteceu em `8dfea93`
  (09/09): reprovou em *Subir Supabase local*, ANTES de migration ou teste, e a
  anotação publica diz so `exit code 1`. **Baixar o log do job exige ADMIN**, e
  um agente nao tem. Sem o log, o roteiro: o job de e2e roda `supabase start`
  identico (`ci.yml` 100 e 153) — se passou no MESMO run, a stack sobe; e
  reproduzir com `supabase stop --no-backup && supabase start`, que aplica as
  migrations do zero como o runner. Os dois verdes e a CI vermelha = **re-run
  do job**, nao correcao de codigo.

- **Nada avisa quando o que está no ar ficou velho** (D-070). O deploy do
  Cloud Run é MANUAL; entre um e outro chegaram a se acumular 66 commits, e a
  correção que "já está pronta" não estava valendo. Quem mexe no `worker` ou
  na `api` confere `APP_COMMIT` contra o `HEAD` antes de concluir qualquer
  coisa sobre produção.
- **`ERROR` numa conta do Mercado Livre é estado SEM SAÍDA.** `ml-token.ts`
  só escreve `status = 'ERROR'`; nada devolve a conta a `CONNECTED` exceto
  uma nova autorização OAuth. Um problema **transitório** de credencial
  desativa a conta permanentemente, e todo job que itera contas para de
  enfileirar em silêncio (D-217).
- **Um job que para de ser ENFILEIRADO não falha — emudece.** O Cloud
  Scheduler mostra verde, o endpoint responde 200, e `job_runs` simplesmente
  para de crescer. Não há linha `failed` para achar. Foi assim que 13 horas
  passaram despercebidas em D-217.
- **Os ~54 `job_failed` por dia do worker em `claims/{id}/returns` são
  propagação, não perda** (D-344): 145 de 147 claims destravam sozinhos em
  até 4,1 min, e a reversão de estoque só acontece com a devolução
  `delivered`, dias depois. O worker passa a tratar 404 em claim com menos de
  60 min como `claim_return_not_yet_available` (info); fora da janela segue
  falha, com `claim_return_missing` (warn) e a idade. **No ar desde
  2026-09-14 09:51 UTC** (`worker-00051-thq`).
- **Relist nunca foi exercitado contra o ML real.** A primeira execução
  precisa ser ensaio humano deliberado, com anúncio sacrificável.
- **As duas suítes locais não convivem no mesmo banco, e a ordem é a cura.**
  `test:integration` exige banco recriado; e rodá-la quebra o seed do
  Playwright depois (usuários criados por SQL deixam `confirmation_token`
  nulo, e o seed morre em `AuthRetryableFetchError: Database error finding
  users`). **`supabase db reset` antes de CADA uma das duas** — o risco já
  estava escrito aqui e mesmo assim custou uma rodada (D-225), e uma segunda em
  D-265. O sintoma exato está no log do container
  (`docker logs supabase_auth_...`): `Scan error on column index 3, name
  "confirmation_token": converting NULL to string is unsupported`. Quando o
  reset sozinho não bastar, o reparo é normalizar os oito campos de token:

  ```sql
  update auth.users set
    confirmation_token = coalesce(confirmation_token,''),
    recovery_token = coalesce(recovery_token,''),
    email_change = coalesce(email_change,''),
    email_change_token_new = coalesce(email_change_token_new,''),
    email_change_token_current = coalesce(email_change_token_current,''),
    phone_change = coalesce(phone_change,''),
    phone_change_token = coalesce(phone_change_token,''),
    reauthentication_token = coalesce(reauthentication_token,'');
  ```
- **O Playwright reusa servidor existente fora da CI** (`reuseExistingServer`).
  Um `next dev` esquecido na porta 3000 faz a suíte rodar contra o dev
  server, que compila sob demanda, e 13 casos estouram por timeout. Não é
  regressão: é o servidor no caminho. **Encerre a 3000 antes** (D-225).
- **Não rode `gen:types` da CLI local para conferir tipo.** `packages/db/src/types.ts`
  é gerado pelo **MCP** e carrega correções manuais marcadas "CORRECAO MANUAL"
  (D-133/D-147). O gerador da CLI produz outro formato e as apaga: em D-209 a
  conferência produziu **476 linhas de diff** que não tinham nada a ver com a
  mudança. Para "a assinatura mudou?", a fonte é o catálogo
  (`pg_get_function_result`), não o gerador.
- **Docker não está no PATH do shell.** Existe em
  `C:\Program Files\Docker\Docker\resources\bin`; exporte antes de
  `supabase status`/`db reset`, senão a CLI diz "docker: command not found" como
  se não estivesse instalado.
- **O teto de 1000 do PostgREST, e a única tela que ainda o ignora.**
  `max_rows = 1000` (`supabase/config.toml`). Ler uma tabela sem `limit` e
  imprimir `rows.length` como total faz a tela publicar o **teto do servidor**
  achando que é o total — foi o que D-263 achou em `/acoes`, com 1.449 abertas.
  Varri as demais páginas: sobra **uma**, `/sugestoes`, que conta por `.length`
  sem janela. Hoje é **latente, não vivo** — `feature_suggestions` tem **0
  linhas** no Dev (medido em 2026-09-08), e uma lista de sugestões enviadas por
  humanos não chega a mil tão cedo. Fica registrado para não ser redescoberto;
  vira dívida real no dia em que essa tabela crescer.
- **`n_live_tup` mente, e mentiu feio.** As estatísticas do Dev estão velhas:
  `job_runs` estimava ~6 mil e tem **271.184**; `ml_credentials` estimava 0 e
  tem **4 credenciais reais**. Para qualquer raciocínio de segurança ou de
  volume, `count(*)` — nunca a estimativa (D-182).

---

## Atos humanos pendentes

Nada disto pode ser feito por um agente.

1. ~~**Deploy** dos dois serviços~~ — **FEITO em 2026-09-02** (D-162→D-216).
2. ~~`bash infra/cloud-scheduler.sh`~~ — **FEITO**, **14** jobs `ENABLED`. A
   lista canônica é `infra/cloud-scheduler.sh` (`DEPLOYMENT.md` §7); o «15
   esperados» que já esteve escrito aqui era falso.
3. ~~Relatar **Dashboard → Database → Backups** do projeto Dev~~ — **MEDIDO
   em 2026-09-13 (D-332)**: backup físico diário, ~7 dias de retenção. **Falta
   só confirmar o PITR** (aba *Point in time*, que não renderizou para as
   ferramentas). **3a. O ensaio de restore** é o próximo ato: restaurar um
   backup num projeto NOVO e rodar `pnpm --filter @sb/db run check:restore` —
   roteiro em `docs/DEPLOYMENT.md` 8.1, **corrigido em D-347**: a aba é
   *Restore to new project* — o "Restore" de *Scheduled backups* sobrescreve o
   Dev —, o comando é PowerShell com `pnpm.cmd` e `sslmode=no-verify`, e o
   `BACKUP_AT` se calcula no restaurado, não se lê da lista.
3b. **Conferir o saldo do estoque contra o UpSeller** — o usuário vai subir a
   planilha do UpSeller quando as etapas atuais fecharem (2026-09-03). É a segunda metade da
   condição que o item da reconciliação impõe a si mesmo, e a única que falta
   (D-223). D-134 já leu a rodada e mediu **zero divergências em 3.472
   chaves** — mas isso é consistência interna, projeção contra ledger. Abrir o
   UpSeller, comparar o saldo de alguns SKUs e relatar fecha o `[~]`.
3c. ~~**As duas contas em `ERROR`** (`sbmotos`, `gmr`)~~ — **FEITO pelo
   usuário em 2026-09-03** (reautorização OAuth às 13:31/13:34 UTC; medido:
   as quatro contas `CONNECTED`, última sincronização `done` às 14:40 UTC).
   Se alguma tela ainda mostrar ERROR, é cache — o banco diz CONNECTED.
4. Ensaio de `/produtos` (5 SKUs sentinela) e preencher
   `/reposicao/configuracoes`.
5. Primeiro relist real, deliberado, com anúncio sacrificável.
6. **Auth → Leaked Password Protection, no Dev e em produção** — estado **não
   verificável** por ferramenta: o lint sumiu do advisor nos dois projetos em
   2026-09-14, o que não prova que está ligada (D-350). Conferir no painel:
   Authentication → Sign In / Providers → Email → *Prevent use of leaked
   passwords*, em `nmgccyqquwxecqffsidr` e em `imvjfgnaprqsfjlnsyev`.
7. ~~**Branch protection da `v3`**~~ — **FEITO em 2026-09-03** e **reforçado
   depois** (medido em 2026-09-14, D-350): 2 checks obrigatórios
   (`typecheck, lint, test, build` e integração), só para quem **não** é admin.
   O push direto do agente na `v3` passou a ser **barrado pelo modo automático**
   (merge sem revisão): a junção sai por PR, com CI verde, pela interface do GitHub.
8. ~~**Deploy de `worker`/`api` para D-229 valer**~~ — **FEITO em
   2026-09-03**: validado no ar com `order_financials` indo de 1 para centenas
   de linhas (leitura em D-229/D-230).
9. ~~**O repositório está PÚBLICO.**~~ — **DECIDIDO pelo usuário em
   2026-09-03: fica público**, porque o plano gratuito do GitHub não aceita
   mais commits em repositório privado. Consequência que vale para todo mundo
   que escreve aqui: **os docs são públicos** — nunca um segredo, uma chave,
   um dado pessoal de cliente ou um número que a empresa não publicaria.
10. ~~**Rotacionar a credencial do GitHub do Git Credential Manager**~~ —
    **FEITO em 2026-09-14**: o push passou a ser recusado com "Invalid username
    or token" e voltou depois de um novo login.
11. **Produção (D-350 §7):** apagar o *ambiente* do GitHub
    `SUPABASE_PROD_DB_PASSWORD` (sem trava) e confirmar os `SUPABASE_PROD_*`
    dentro de `producao`; na Vercel `speedbikers-prod`, `NEXT_PUBLIC_*` só em
    Production, remover as 5 variáveis de infra e decidir o deploy automático
    da `v3`; no Supabase de produção, Site URL e redirects do Auth, SMTP e PITR;
    no painel do Mercado Livre, tópicos e redirects — e um app próprio para o
    Dev antes de retomá-lo.

---

## Próximos passos

### Fechamento da V3 — as cinco categorias de D-223

**Bloqueadores técnicos (A)** — sem isto a V3 não fecha:

| | |
|---|---|
| backup e restore **verificados** | a metade do SCHEMA é provada todo dia (CI recria as migrations). A do DADO: **backup medido** (diário, ~7 dias) e **ensaio pronto** (D-332) — o comparador `check:restore` foi provado contra dano simulado, e o roteiro foi conferido e corrigido (D-347). Falta o restore real num projeto novo, que é ato humano |
| ~~revisão de segurança e de secrets~~ | ✅ **FEITA em quatro fatias**: segredos e dependências (D-328); superfície de entrada conferida ao vivo, D-045 fechada e cabeçalhos da `web` confirmados na Vercel (D-329); redação de log por VALOR (D-330); CSP completa com nonce, com e2e que exige zero violações (D-331). **Sem lacuna técnica aberta.** A guarda de `pnpm audit` que ficou sem dono entrou na CI em D-336 (`--prod`, corte em alta) |
| load tests e revisão de `pg_stat_statements` | **carga real medida (D-339)**: 65,8 mil webhooks/dia, pico de 1.050/min, e o ACK passa de 7 s nos picos. **A correção de D-339 foi publicada e voltada** (D-340): esfriou as conexões e piorou `orders_v2`. O pico continua aberto. O log do webhook passou a medir cada etapa (`lookup_ms`, `enqueue_ms`; D-343) — publicado em `api-00039-9vm`. Fora de pico, a Cloud Task custa ~185 ms fixos e a consulta da conta ~50 ms, que esfria depois de pausa. **A primeira rajada medida respondeu: é a consulta da conta** — p95 de 2,8 s na rajada, contra 103 ms fora dela, com a Cloud Task igual (D-345). Em 10 dias foram 26.748 ACKs acima de 2 s, em 78 rajadas sem horário fixo. **A correção foi publicada em D-346** (contas em memória, com carga única em voo e recarga limitada; `api-00040-qrk`): depois da primeira carga, `lookup_ms` caiu para 0 ms, e na rajada de 319/s das 13:49 UTC ficou em 0, com ACK máx 190 ms numa instância (D-346 §6). **O pico do ACK fechou.** Falta também a revisão de `pg_stat_statements` (`report:health` pede a senha do Dev — ato humano) |
| ~~Supabase e Cloud Run de **produção**~~ | ✅ **CRIADOS em 2026-09-14** (D-348, D-349, D-350): GCP, Supabase e Vercel `speedbikers-prod`; migrations por `migrations-producao.yml`, com duas aprovações; api e worker em `36a23ad`, juntado na `v3` pelo PR #2 (`da130c0`) com CI verde |
| rollout da V3 | produção já recebe os webhooks e tem as 4 contas e a planilha do UpSeller. **Antes do corte:** a guarda contra baixa de venda anterior ao snapshot do ERP (em andamento), o passo 10 da 8.2 e os atos da seção própria |
| ~~UX final da republicação~~ | ✅ **FEITA em D-295** — pedir e executar, dois atos, no Dashboard do Anúncio. Falta o **ensaio humano** (seção própria) |

**Pendências saudáveis (B)** — agregam e cabem antes do lançamento:

| | |
|---|---|
| ~~filtros de Conta e Marca~~ | ✅ **CONCLUÍDO** nas três telas que o mediam (D-235→D-237). **Origem fica de fora** — `is_imported` medido como não confiável |

**Dependentes de dado/tempo (D)** — não é possível hoje, e forçar seria inventar:

**Aprendizado humano supervisionado** (Trilha 7C) — medido em 03/09: a Base de
Conhecimento tem **0 entradas** e **0 templates**, foram **4 respostas enviadas
pelo produto** (a última em 27/08) e **0 atendimentos assumidos**. Os 1.189
casos resolvidos vieram importados do ML: a operação responde no painel do
Mercado Livre. O item é "converter correções HUMANAS em conhecimento" — não há
o que converter. **Destrava com uso, não com código** (D-235) ·
vendas perdidas estimadas (sem saldo inicial no ledger, D-061) · Nacional × Importado
(confiabilidade de `is_imported`) · alias fornecedor→SKU (relação não existe, D-174) ·
antes/depois de Preços e de Full (série curta demais)

**Futuro V3.1+ (C)** — decisão deliberada de não fazer agora:

Ads · recebimento parcial · DANFE/PDF · XML de pedido de compra · Terraform ·
expansão do "O que aconteceu?" · eventos adicionais de SAC · os 2 pedidos sem
`order_items` (dano medido em ZERO, D-208)

**Atos humanos (E)** — ver a seção própria acima.

---

### Próxima tarefa segura

**A próxima tarefa é a guarda do estoque** (D-350 §5): não baixar venda anterior
ao snapshot do ERP, compensar as baixas já gravadas e tirar do backfill as
notificações — com testes, PR e deploy do worker, e só então retomar
`v3-reconcile-balances` de produção. Antes de puxar item de backlog, confira a
categoria dele em D-223 — quase todos dependem de dado. Duas lições que continuam valendo: **mudança de assinatura de RPC pede
consulta ao catálogo E `grep` no monorepo**, e **linha de base contra o Dev só
prova no mesmo instante** (histórico em `docs/archive/handoffs/`).

---

⚠️ **Dois defeitos vivos foram encontrados e consertados em 03/09 ao medir
`job_runs`** (D-229 sweep financeiro; D-230 snapshot do Full) — os dois já
estavam no ar e nenhum aparecia em tela. A Central de Integrações mostra a
sincronização em `erro` nesses casos; **`/saude` e `/sincronizacao` já
mostravam** as falhas em `job_runs`/`sync_runs` e ninguém olhou. A lição vale
mais que as duas correções: **um vermelho que ninguém lê não protege nada** —
antes de cada fatia, abrir `/saude` (ou `report:health`) e ler.

⚠️ **`apps/web/next-env.d.ts` alterna** entre `./.next/dev/types/...` e
`./.next/types/...` conforme o último comando foi `next dev` ou `next build`.
É gerado (o Next manda não editar) e `git add -A` o leva junto — inofensivo,
mas é ruído no diff; conferir antes de commitar.

⚠️ **O `web` lê os tipos do BUILD de `@sb/db`** (e o `worker`, do de
`@sb/domain`): depois de editar `types.ts` ou `packages/domain/src`, rode o
`build` do pacote antes do `tsc` do consumidor, senão o erro que aparece é de
outro lugar (D-208, D-227).

**O comando da bateria** (a ordem importa — ver os dois riscos de ambiente):

```bash
pnpm exec supabase db reset && pnpm --filter @sb/db run test:integration && pnpm run check && pnpm run build && pnpm exec supabase db reset && pnpm --filter web run e2e:seed && pnpm --filter web run e2e
```

⚠️ **Os cinco guardas estáticos não estão no `check`** — rodam como passos
próprios da esteira, e cada um mora num pacote:

| guarda | onde | o que reprova |
|---|---|---|
| `check:embeds` | `pnpm --filter @sb/db run check:embeds` (exige as variáveis do `supabase status` exportadas) | embed do PostgREST sem FK que o sustente |
| `check:waterfalls` | `pnpm --filter web run check:waterfalls` | leitura em fila sem dependência num Server Component (D-195/D-197) |
| `check:server-actions` | `pnpm --filter web run check:server-actions` | export que não é função assíncrona em módulo `"use server"` (D-234) |
| `check:table-styles` | `pnpm --filter web run check:table-styles` | tela que declara `.sb-table` e mantém o `const td` antigo — a migração pela metade (D-262) |
| `check:control-styles` | `pnpm --filter web run check:control-styles` | campo ou botão sem a forma do design system — `.sb-input`/`.sb-button` (D-284) |

Os quatro de `web` são estáticos e não precisam de banco. **`check:waterfalls`,
`check:table-styles` e `check:control-styles` se auto-provam na carga** — se a detecção quebrar numa
manutenção, falham alto em vez de ficar verdes sem detectar nada. **`check:server-actions`
não tem essa rede**: é a regex mais simples dos três, mas hoje nada avisaria se
ela parasse de casar.

**Fora dos cinco, um de dependências:** `pnpm audit --prod --audit-level high`, último
passo da job `check` (D-336). Precisa de rede e **reprova pela data**: aviso alto
publicado hoje deixa a esteira vermelha sem mudança nossa — ler antes de culpar o commit.

---

## Onde procurar o resto

| Preciso de… | Leia |
|---|---|
| fases, itens abertos, Definition of Done | `docs/ROADMAP.md` |
| por que uma decisão foi tomada | `docs/DECISIONS_INDEX.md` → `D-xxx` |
| benchmarks, antes/depois, planos | `docs/PERFORMANCE.md` |
| história de sessões anteriores | `docs/archive/handoffs/` |
| a lição de método por trás de um erro já cometido | `docs/LICOES.md` |
| banco, RLS, tabelas | `docs/DATABASE.md` |
| API do Mercado Livre | `docs/MERCADO_LIVRE.md` |
| métricas canônicas | `docs/METRICS.md` |
