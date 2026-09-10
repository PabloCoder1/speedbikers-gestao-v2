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
| **Atualizado em** | 2026-09-10 |
| **Branch** | `v3` (a `main` é a V2, só referência — nunca copiar) |
| **HEAD conhecido** | `a4a3098` (D-305) — o timeout de `/anuncios` era o **plano**: no PostgreSQL 17 o corpo de uma funcao `language sql` e planejado sem os valores dos argumentos, e o generico troca hash join por nested loop (228 ms → +60 s). Corrigida com `plpgsql` + `plan_cache_mode = force_custom_plan`. Antes: `f1a3d4f` (D-304) — o piso de frescor das métricas. ⚠️ **a api e o Cloud Scheduler NÃO foram implantados** (escolha do usuário): o piso (`/internal/schedule/metrics-refresh` + `v3-refresh-sales-metrics`) está no código e fora do ar — rodar `deploy-cloud-run.sh api` e `cloud-scheduler.sh` para ativá-lo. Antes: `3a2d570` (D-303) — link de acesso reemitível. ⚠️ **falta a URL da aplicação na lista de redirecionamentos do projeto Supabase** (painel, fora do repositório): sem ela todo link continua caindo em `http://localhost:3000`. |
| **Fechamento da V3** | **185 de 213 itens do ROADMAP fechados (87%)** — 26 abertos e 2 parciais. Dos 26, **6 são bloqueadores**, e todos são hardening/lançamento: nenhum é feature faltando (D-223) |
| **Deploy no ar** | ✅ **`721f4c6`, implantado em 2026-09-10** — worker (`worker-00049-r62`) e depois api (`api-00033-cmn`), na ordem de D-088, autorizado pelo usuário. `GET /health` da api responde `{"commit":"721f4c6"}` e `POST /v1/organization/invites` responde **401 em vez de 404**: a rota existe. **O que motivou o deploy foi um defeito de usuário**: o botão de convidar respondia 404 em produção porque a api no ar era `6baa641`, de 07/09, e a rota nasceu em `4ef8d18`, três dias depois (D-301) — 110 commits de atraso, 32 tocando `apps/api` ou `packages/`. **Esta linha envelhece sozinha** (o risco de D-070): ela dizia "sem atraso" em 02/09, `0702969` em 09/09, e nos dois casos o `HEAD` seguiu andando. Deploy é manual: `bash infra/deploy-cloud-run.sh` com `MERCADO_LIVRE_CLIENT_ID` no ambiente. **O worker não é medível por fora** — `/health` dele responde 403 sem credencial —, então o que se afirma dele é a revisão, não o commit que responde. |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | **157 locais, 156 no Dev** — conferido pelo catálogo em 2026-09-10: as 156 do Dev batem com as locais até `20260910120000` (D-296, `get_organization_members` presente), o que **fecha o ⚠️ de "não conferida"** que estava aqui. A 157ª é `20260910180000` (D-299), ainda não empurrada. ⚠️ Quem aplica no Dev é a integração GitHub do Supabase, **não** a CI (D-257); o caminho é o push, **nunca** o MCP (D-207). Verde no job de migrations significa "não sobrou o que aplicar", não "o portão segurou" |
| **Frente atual** | **A8 — `/contas` REFEITA CONTRA O FRAME (D-299):** era a única tela que nunca esteve em fatia nenhuma. O frame pede três linhas de detalhe por conta e **as três tinham fonte** — `sync_runs`, `listings` e `ml_credentials.scopes` —, ou seja, a tela estava atrasada em relação ao banco. **O achado: o token do ML vive 6,0 h** nas quatro contas e é renovado o dia inteiro, então o "Token expira em 2 dias" do frame é ficção dupla; contagem regressiva seria alarme permanente. Só token VENCIDO numa conta `CONNECTED` vira aviso. `ml_credentials` é cofre (RLS sem policy, sem grant), então os derivados chegam por `get_ml_account_cards` — `security definer` cujo predicado é **cópia** do de `ml_accounts_select_permitted`, e que não devolve campo cifrado nem o instante de expiração. ⚠️ **migration `20260910180000` NÃO conferida no Dev daqui** (é o push que aplica). **Próxima da auditoria: `/saude`, com seis cartões de serviço a medir**; Integrações, Sincronização e Configurações seguem com recusa medida (D-272/D-287, D-273, D-275). Antes disso: A7 (`/usuarios`, D-297), A6 (auditoria de ADMINISTRAÇÃO, D-296) e a frente visual fechada (D-281→D-287). Trilha 8B com P0 fechado (A–H) e em P1 |

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

- **Toda RPC acima de 500 ms neste banco é `language sql`, e isso não é
  coincidência (D-305).** O corpo dessas funções é planejado sem os valores
  dos argumentos, e o plano genérico erra as estimativas por 100x. Medido no
  Dev: `get_sales_expanded_summary` **7.416 ms** e `get_sku_correlated_events`
  **7.392 ms** de pior caso, contra um teto de **8 s** para `authenticated`.
  Duas já encostaram. A cura é a de D-305 (`plpgsql` + `force_custom_plan`),
  uma função por vez, cada uma com revisão de colisão de variável — não em
  lote silencioso.

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
- **2 pedidos estão sem linha em `order_items`** (`2000017347483988` e
  `2000017394032682`): `paid`, com o movimento de estoque gravado e nenhum
  item. A dedução está certa. **Os dois caminhos que produzem esse estado
  estão fechados** (D-184 tirou a leitura da janela, D-189 tirou a janela e
  parou de apagar itens a partir de resposta vazia); qual dos dois aconteceu
  não dá para saber. **Medido em D-208, e o item mudou de natureza:**
  - **o dano hoje é zero** — os dois estão `delivered` desde julho, com **0**
    casos de atendimento, **0** eventos de devolução e **0** movimentos de
    reversão. Não é "pequeno": é zero, e foi contado;
  - **reprocessar não é ato pendente de aprovação, é ato sem mecanismo** —
    `sync.orders.window` e `backfill.orders` só aceitam `{ mlAccountId }`, e o
    cliente só tem `fetchOrdersWindow` por período: **não existe
    `GET /orders/{id}` no código**. Não adianta aprovar; não há o que rodar;
  - **reconstruir a linha do movimento seria inventar dado** — `item_id`,
    `variation_id` e preço só o Mercado Livre tem;
  - **o que tornava a falta perigosa já foi fechado.** `claim-return` pulava
    com um `logger.warn` e o job fechava `done` — a reversão perdida não
    deixava vestígio no banco, e `done` com `processed` baixo é
    indistinguível de um no-op legítimo (D-205 mediu 4.903 deles saudáveis).
    Agora a perda vira `order.return.unreversed`, `critico`, em
    `domain_events`. **Isso vale para qualquer pedido futuro, não só estes
    dois** — que é o motivo de a fatia ter sido essa, e não o reprocessamento.
- **Conflito à vista em `20260902005023_stock_balances_page_first.sql`.**
  D-207 recuperou essa migration do banco porque ela existia só no Dev.
  Quando a outra frente empurrar a fatia dela, o git vai acusar conflito neste
  arquivo: o SQL é idêntico, a diferença é o cabeçalho. **Fique com a versão
  deles** — tem a intenção original e o registro da decisão.
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
3. Relatar **Dashboard → Database → Backups** do projeto Dev (decide a
   abordagem de backup da Fase 8).
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
| backup e restore **verificados** | a metade do SCHEMA já é provada todo dia (CI recria as migrations); falta a do DADO |
| revisão de segurança e de secrets | — |
| load tests e revisão de `pg_stat_statements` | — |
| Supabase e Cloud Run de **produção** | depende de ato humano para criar |
| rollout da V3 | — |
| ~~UX final da republicação~~ | ✅ **FEITA em D-295** — pedir e executar, dois atos, no Dashboard do Anúncio. Falta o **ensaio humano** (seção própria) |

**Pendências saudáveis (B)** — agregam e cabem antes do lançamento:

| | |
|---|---|
| filtros de Conta e Marca | **PARCIAL**: `/curva-abc` (D-235) e `/cobertura` (D-236) feitos; falta `/vendas`. **Origem fica de fora** — `is_imported` medido como não confiável |

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

✅ **Entregues e verificados** (o porquê de cada um está na decisão; aqui só o
que já não é pendência): as **nove abas do Dashboard de SKU** (D-224 fechado em
D-228, três das quatro últimas por reuso), a **Central de Integrações**
(D-231), a **revisão adversarial dela** (D-232 — sanitizador de erro nas cinco
telas, uma lista de chave sensível com dois consumidores) e o **Hub de
Configurações** (D-233 — sete seções numa viagem, o Hub não edita, aponta).
Bateria da última: **577/577**, 29/29, 8/8, **33** embeds, 55, **19/19** (com
os DOIS membros no seed).

---

✅ **D-234 fechou o defeito do segundo usuário.** 26 telas liam
`organization_members` sem filtrar por usuário e devolviam `PGRST116` assim
que a organização ganhava o segundo membro — *"sem organização"* para o
próprio ADMIN. Agora leem `lib/membership.ts`, que chama
`get_current_membership()`: o filtro por `auth.uid()` acontece no BANCO, então
continua sendo **uma ida** (fazer em JS exigiria `getUser()` antes da consulta,
e as duas ficariam em série). **O seed cria o segundo usuário**, e a suíte
ficaria vermelha se alguém reintroduzir a leitura sem filtro.

⚠️ **`/usuarios` continua lendo direto, de propósito** — ela lista membros.

✅ **Filtro de Marca em `/curva-abc` (D-235) e `/cobertura` (D-236).** Marca é
`skus.supplier_brand` — `skus.brand` guarda a categoria do UpSeller e diverge
em 2.320 dos 3.554 SKUs.

✅ **Filtro de Marca em `/vendas` (D-237) — item P1 dos filtros CONCLUÍDO.** A
mais difícil das três, e a dificuldade não era SQL: **nem todo número de vendas
tem versão por marca**. O que decompõe foi provado (a soma dos itens bate
exatamente com o total dos pedidos); o que não decompõe volta **NULL** —
compras por pack, ticket médio, trio de cancelamento e a margem inteira. A
tabela por métrica está em `docs/METRICS.md` **5E**, e é lá que se consulta
antes de recortar qualquer número de vendas por marca de novo.

🟡 **A lição desta fatia, e ela custou um build vermelho:** a conferência de
D-236 (*"pergunte ao catálogo quem chama, ANTES de escrever"*) estava certa e
**insuficiente** — `pg_proc` só enxerga dentro do banco, e o **Copiloto
(`apps/api/src/copilot.ts`) chama `get_sales_summary` de fora dele**. A
pergunta certa tem duas metades: a consulta ao catálogo **e** um `grep` no
monorepo. Faça as duas antes de mudar assinatura de RPC.

⚠️ **Linha de base contra o Dev não é prova.** O Dev processa ~221 webhooks por
hora: capturei os números antes de aplicar a migration e quatro dos cinco
"mudaram" depois — era o banco andando, não regressão. A prova que vale compara
a RPC com a leitura direta da mesma fonte **no mesmo instante**.

🔴 **A próxima tarefa NÃO foi medida.** As pendências saudáveis (B) que restam
no `docs/ROADMAP.md` são o **Aprendizado humano supervisionado** (reusa a Base
de Conhecimento de D-113; a regra "nada promovido sem humano" já vive na policy
de insert, então a fatia é sobre o que ALIMENTA sugestões) e os **filtros de
Conta e Marca** em telas ainda não cobertas — este item acabou de fechar para
as três telas que o mediam, então reabri-lo exige medir onde mais faz sentido.
Ler o item no ROADMAP e a tela dona antes de escrever.

⚠️ **Dívida menor, registrada para não virar terceira cópia:** `/saude`,
`/sincronizacao` e `/skus/[skuId]` ainda carregam suas próprias cópias de
`th`/`td`/`tdNumber`/`cardStyle`; o módulo único é
`components/table-styles.ts` (D-232). É uma linha por tela.

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
