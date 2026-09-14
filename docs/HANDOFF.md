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
| **Atualizado em** | 2026-09-13 |
| **Branch** | `v3`, **branch padrão do repositório desde 2026-09-13** (D-335) — a `main` é a V2, só referência, nunca copiar |
| **HEAD conhecido** | `59f49dd` (D-343) — **o log do webhook mede cada etapa do ACK** (`lookup_ms`, `enqueue_ms`), para escolher a correção do pico com dado; publicado em `api-00039-9vm` — **a leitura do pico das ~09:00 UTC decide a correção**. `0062b94` (D-342) — **o deploy recusa revisão publicada sem tráfego, pelo nome certo**: com tráfego fixo, `latestReadyRevisionName` fica velho e `--to-latest` publicaria a revisão anterior. api em `45be035`, tráfego no LATEST. `45be035` (D-341): a primeira versão da guarda. `be6fc89` (D-340) — **a correção do webhook de D-339 foi publicada e VOLTOU**, no ar e no código: tirou o I/O do tópico sem consumidor, mas esfriou as conexões e levou os ACKs lentos de `orders_v2` de ~1% a ~9%. `89da6fa` (D-339): carga real medida — o pico diário passa de 7 s e **segue aberto**. `cacb844` (D-338): api e worker em `d828eac`. `9f1b5da` (D-337): 189 de 213, 4 bloqueadores. `c8bb539` (D-335): **a `v3` virou a branch padrão** — sem isso `migrations-producao.yml` nem existia para o GitHub (404). `765d8c0` (D-334): esse workflow só aplica com o ambiente `producao` travado e a CI do commit verde e já aplicada no Dev; **hoje para no primeiro job**, porque o ambiente não existe (ato humano, `DEPLOYMENT.md` 8.2). Antes: `db7890b` (D-333) `AMBIENTE` explícito em `infra/` · `536e2ae` (D-332) ensaio de restore pronto — **falta o restore real** (ato humano, 8.1). ⚠️ **Toda página nova precisa ser dinâmica** (D-331): estática sai sem nonce e a CSP a bloqueia em silêncio. ⚠️ **Armadilhas de ambiente em `TESTING.md`:** `.env.local` aponta para o Dev (exporte as variáveis locais ANTES do `build`); o OneDrive trava o `.next` em `EPERM`; e o Docker Desktop pode não subir depois de reiniciar — **nunca "Reset to factory defaults"**, que apaga os volumes; mova a pasta `run`. Hashes anteriores: `docs/archive/handoffs/2026-09-13_a_2026-09-13.md`. |
| **Fechamento da V3** | **189 de 213 itens do ROADMAP fechados (89%)** — 22 abertos e 2 parciais, **recontados no arquivo em 2026-09-13 (D-337)**. Dos 22, **4 são bloqueadores**, todos hardening/lançamento (D-223): backup e restore verificados, testes de carga, produção e rollout. Saíram a revisão de segurança (D-331) e a UX da republicação (D-295; o checkbox só fechou em D-337) |
| **Deploy no ar** | ✅ **api em `59f49dd`** (`api-00039-9vm`, 2026-09-14 03:01 UTC, D-343), com o log do webhook medindo cada etapa do ACK, e **worker em `d828eac`** (`worker-00050-qnt`, D-338). Desde `d828eac` o runtime só ganhou esses campos de log; segue com `hono` 4.13.7 (D-328) e a redação de log por valor (D-330). `GET /health` responde `{"commit":"59f49dd"}`; tráfego no **LATEST**. ⚠️ **`api-00037-bqb` é o código revertido de D-339** (D-340): **não mande tráfego para ela**, e nunca use `--to-latest` com tráfego fixo sem conferir `latestReadyRevisionName` (D-342). Para voltar: api `api-00038-2hg`; worker `worker-00049-r62`. **Piso de frescor no ar** (D-304): `v3-refresh-sales-metrics`, `35 * * * *`. **Esta linha envelhece sozinha** (D-070): `/health` só cobre a api — o worker se confere por `gcloud run services describe worker`, comparando a imagem com o `HEAD`. |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | **166 locais** — a última é `20260911230000` (D-319). ⚠️ Quem aplica no Dev é a integração GitHub do Supabase, **não** a CI (D-257); o caminho é o push, **nunca** o MCP (D-207). O nome do arquivo precisa ser um **instante válido**, não só um número crescente: `...240000` (hora 24) deixou seis casos de `get_system_health` vermelhos, e é esse teste que serve de guarda (D-307) |
| **Frente atual** | **Sem item de desenho acionável** — a fila da auditoria de design de D-310 fechou (D-320 → D-327), e o pedido do dono sobre o Dashboard do SKU está entregue (D-316, D-317; régua em D-318). **Único item com condição:** o chão cinza das gavetas de anúncio, fornecedor e usuário, que entra quando o conteúdo delas virar cartão. **Sem fonte, e por isso não se promete:** Shopee e a dimensão plataforma (D-037), divergência de estoque por conta, tipo de anúncio, catálogo, logística, qualidade da publicação e substatus de pausa. O que falta para fechar a V3 é lançamento, e depende de ato humano. Com duas sessões no repo: portas 3000/3100 e `db reset` combinado. |

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
  falha, com `claim_return_missing` (warn) e a idade. **Ainda não publicado.**
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
- **Se a frente de 02/09 um dia empurrar `20260902005023_stock_balances_page_first.sql`**,
  o git acusa conflito: D-207 recuperou essa migration do banco, o SQL é
  idêntico e muda o cabeçalho. **Fique com a versão deles.** Em 13/09, onze
  dias depois, ela não tinha aparecido (texto completo no arquivo de 13/09).
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
   roteiro em `docs/DEPLOYMENT.md` 8.1. Nunca restaurar sobre o próprio Dev.
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
6. **Auth → Leaked Password Protection** está desligado no Supabase
   (configuração externa, não migration). O agente NÃO consegue ligar: a
   Management API exige o access token do Dashboard, que a CLI guarda no
   cofre do Windows. Caminho, 30 segundos: Dashboard → projeto
   `nmgccyqquwxecqffsidr` → Authentication → Sign In / Providers → Email →
   *Prevent use of leaked passwords* → Save.
7. ~~**Branch protection da `v3`**~~ — **FEITO em 2026-09-03**, MÍNIMA: sem
   force-push e sem apagar a branch; **sem** PR nem status check obrigatório, o
   push direto continua igual. Exigir PR/CI é decisão de fluxo, não de agente.
8. ~~**Deploy de `worker`/`api` para D-229 valer**~~ — **FEITO em
   2026-09-03**: validado no ar com `order_financials` indo de 1 para centenas
   de linhas (leitura em D-229/D-230).
9. ~~**O repositório está PÚBLICO.**~~ — **DECIDIDO pelo usuário em
   2026-09-03: fica público**, porque o plano gratuito do GitHub não aceita
   mais commits em repositório privado. Consequência que vale para todo mundo
   que escreve aqui: **os docs são públicos** — nunca um segredo, uma chave,
   um dado pessoal de cliente ou um número que a empresa não publicaria.
10. **Rotacionar a credencial do GitHub do Git Credential Manager.** Ao
    aplicar a proteção da `v3`, o agente imprimiu por engano o token OAuth
    (`gho_…`) no transcript da sessão. GitHub → Settings → Applications →
    Authorized OAuth Apps → *Git Credential Manager* → **Revoke**; o próximo
    `git push` pede login de novo. Um minuto, e fecha a exposição.

---

## Próximos passos

### Fechamento da V3 — as cinco categorias de D-223

**Bloqueadores técnicos (A)** — sem isto a V3 não fecha:

| | |
|---|---|
| backup e restore **verificados** | a metade do SCHEMA é provada todo dia (CI recria as migrations). A do DADO: **backup medido** (diário, ~7 dias) e **ensaio pronto** (D-332) — o comparador `check:restore` foi provado contra dano simulado. Falta o restore real num projeto novo, que é ato humano |
| ~~revisão de segurança e de secrets~~ | ✅ **FEITA em quatro fatias**: segredos e dependências (D-328); superfície de entrada conferida ao vivo, D-045 fechada e cabeçalhos da `web` confirmados na Vercel (D-329); redação de log por VALOR (D-330); CSP completa com nonce, com e2e que exige zero violações (D-331). **Sem lacuna técnica aberta.** A guarda de `pnpm audit` que ficou sem dono entrou na CI em D-336 (`--prod`, corte em alta) |
| load tests e revisão de `pg_stat_statements` | **carga real medida (D-339)**: 65,8 mil webhooks/dia, pico de 1.050/min, e o ACK passa de 7 s nos picos. **A correção de D-339 foi publicada e voltada** (D-340): esfriou as conexões e piorou `orders_v2`. O pico continua aberto. O log do webhook passou a medir cada etapa (`lookup_ms`, `enqueue_ms`; D-343) — publicado em `api-00039-9vm`. Fora de pico, a Cloud Task custa ~185 ms fixos e a consulta da conta ~50 ms, que esfria depois de pausa. **Falta ler o pico das ~09:00 UTC** antes de escolher a correção (a candidata, contas em memória, está em D-343). Falta também a revisão de `pg_stat_statements` (`report:health` pede a senha do Dev — ato humano) |
| Supabase e Cloud Run de **produção** | depende de ato humano para criar. **Os scripts estão prontos e guardados** (D-333): `AMBIENTE=prod` sem padrão, com `CONFIRMO_PRODUCAO=sim`, e recusa de mistura com o Dev testada na CI; roteiro em `DEPLOYMENT.md` 8.2. Migrations de produção têm caminho desde D-334 (`migrations-producao.yml`, guarda testada na CI; criar o ambiente `producao` com revisor é ato humano). Resta a Vercel servindo produção com as variáveis do Dev |
| rollout da V3 | — |
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

**Não há tarefa de código segura na fila.** A de design fechou (linha **Frente
atual**), e os 4 bloqueadores dependem de ato humano (seção própria). Antes de
puxar item de backlog, confira a categoria dele em D-223 — quase todos dependem
de dado. Duas lições que continuam valendo: **mudança de assinatura de RPC pede
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
