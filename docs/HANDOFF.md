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
| **Atualizado em** | 2026-10-19 |
| **Branch** | `main` (única; em 23/09 a `fix/guardas-prod-d348` foi renomeada para `main`, virou a branch padrão do repositório e a `v3` foi aposentada — a tag `v2-final` guarda o último estado da main antiga, da V2). |
| **HEAD conhecido** | `main` em `f984b647` (PR #103) em 25/09 — envelhece a cada merge: confira com `git log -1 origin/main`. Toda página nova precisa ser dinâmica (D-331): estática sai sem nonce. Armadilhas de ambiente/build em `docs/TESTING.md`. |
| **Fechamento da V3** | **190 de 213 itens do ROADMAP fechados (89%)** — 21 abertos e 2 parciais (recontados em D-337; o item de produção fechou em D-350). Dos 21, **3 são bloqueadores**, todos hardening/lançamento (D-223): backup e restore verificados, testes de carga e rollout. Saíram a revisão de segurança (D-331), a UX da republicação (D-295) e a criação de produção (D-350) |
| **Deploy Dev** | ⏸️ **pausado** desde 2026-09-14 (D-350), com 15 jobs e 7 filas parados: api `api-00042-8wd` (min 0) e worker `worker-00053-z26` em `1dc83ee` (21/09; conferido em 28/09). Nunca `--to-latest` com tráfego fixo sem conferir `latestReadyRevisionName` (D-342). Confira com `gcloud run services describe worker --project speedbikers-gestao-v3`. |
| **Supabase** | Dev `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) · **produção `imvjfgnaprqsfjlnsyev`** (`speedbikers-prod`) |
| **Produção** | Worker `worker-00052-gz9` (`b48f150f`, 20/10, D-495 b) e api `api-00036-lwr` (`262ba23a`, D-497), saindo pelo IP fixo `34.95.145.35` (D-457); **Shopee LIVE** desde 16/10 (`SHOPEE_PARTNER_ID=2048641`, segredos `SHOPEE_LIVE_PARTNER_KEY` e `SHOPEE_LIVE_PUSH_PARTNER_KEY`, publicação autorizada pelo dono); duas lojas reais conectadas em 16/10, em dia em 19/10, com o push live chegando das duas (`docs/SHOPEE.md` §9); a loja sandbox foi removida de produção em 19/10, a pedido do dono. Volta ao sandbox: `worker-00048-hl2`/`api-00034-qxw` (a loja real para de sincronizar). Worker fixo na revisão (D-342). Dev pausado (D-350). |
| **Migrations** | Produção até `20261020130000` (D-441 a D-499; os runs de 19/10 no histórico do workflow). D-497 e D-495 a, run `39414488323`; D-495 b, run `39420778882`; D-491, run `39439068303`. Pendentes: `20261020150000`, `…160000` e `…170000` (D-603, D-607, D-605). Dispara-se depois da CI da `main` do mesmo commit (com a entrada `confirmacao` = ref de produção), segurando merges até o job `origem` passar; aprovações no ambiente; sem `--include-all`; nunca MCP. |
| **UX (Agente 3)** | D-500 a D-519 no ar: a Central reformulada pelos #255, #258 e #261 (19/10). Próximo: reler os web vitals da Home e da `/central` depois da D-499 (`docs/UX_SYSTEM.md` §3, itens 10 e 11, e §5). |
| **Frente atual** | **Multicanal** (Shopee, D-425; `docs/MULTICHANNEL_HANDOFF.md` e `_CONTRACTS.md`): dados E1–E7c no ar (D-432 a D-451; migrations até `20261015100000`, worker e api de 15/10 saindo pelo IP fixo, D-457); E7d (push, D-453) no ar e conferido (chave de push própria); telas T4–T6c, T5b–T5d, T6b/T6b2, T-R6 e devoluções no ar; Go Live da Shopee em análise (15/10); C-65 (D-459) e D-455 em produção; desempenho (medição do A3, `docs/PERFORMANCE.md`): D-461, D-463 e D-465 no ar (15/10); C-57 (busca universal com a Shopee, D-467) no ar com a T7 (15/10); C-66 (metas por marketplace, D-473) no ar (16/10); T8a (a Shopee lado a lado na `/central`, D-480) e T8b (a meta de cada marketplace, D-482, sobre o C-66) no ar (16/10): telas T0 a T8 completas; D-484 (a `/curva-abc` sem recarga e a `/produtos` com o sinal de pendente) no ar; T9 (o ensaio do Go Live das telas com loja live no e2e, D-486) no ar; T10 (a Home e a `/vendas` em todos os marketplaces por padrão, D-488) no ar; T11 (os pedidos e os anúncios da Shopee em CSV, D-490) na `main`; D-492 (a proteção de envio da Shopee como degrau da cascata, sobre a D-483) no ar; D-494 (filtros salvos nas telas da Shopee) no ar; D-496 (o CSV de `/vendas` no "Todos" e na Shopee, e a série diária em páginas) no ar; D-498 (os ajustes depois do repasse e o lucro após imposto e Ads da Shopee, a tela da D-485 e da D-487) no ar; D-600 (a faixa de `/contas` com as contas do ML e as lojas Shopee) no ar; D-602 (o CSV de `/vendas` no recorte do Mercado Livre) no ar; D-604 (as notificações recortadas por loja Shopee) no ar; a guarda de tela estreita com `/contas`, `/anuncios/shopee`, `/vendas/shopee` e o `/faturamento` da Shopee; 5 (estoque) no Go Live. A 5J segue com o detector de frete (D-405). |

### O que está pronto

Entregas de tela e de backend até setembro (as centrais, `/estoque`, `/anuncios`, `/sincronizacao`, `/notificacoes`, `/central`): `docs/archive/handoffs/2026-10-15_o-que-esta-pronto-de-setembro.md` e os arquivos de 18/09 e 14/10 na mesma pasta. O que está no ar agora: a linha **Frente atual** acima.

Detalhe por fase: `docs/ROADMAP.md`. Motivo de cada decisão:
`docs/DECISIONS_INDEX.md` → `D-xxx` em `docs/DECISIONS.md`.

---

## P0 ativos (trilha 8B)

**Nenhum.** O bloco inteiro fechou — os oito com letra e os três sem (D-177 a D-183,
D-209 a D-211). História e números: `docs/archive/handoffs/2026-09-17_p0-8b-e-varredura-das-rpcs.md`
e `docs/PERFORMANCE.md`.

---

## Riscos ativos

- **O faturamento do ML perto do `statement_timeout`** (19/10, `docs/PERFORMANCE.md`): D-499 em produção, 47 vezes menos páginas; 90 dias com detalhe ainda 2,1 s quente, todo CPU.
- **Produção sem alerta externo** (28/09): a parada de D-414 durou ~27 h com o Scheduler verde. No app,
  D-417/D-418, com o vigia agendado pelo dono em 14/10 (`vigiar-sincronizacao`, 30 min; cobre as lojas live); canal externo e Cloud NAT são do dono. O app ML da V2
  (6429063609355665) ainda deve notificar o `.vercel.app` excluído: tirar a URL no painel.
- **`frete_anomalo` passa de 8 s a frio** (D-404): na rodada de 25/09, 9,7 s na 1ª tentativa e 2,4 s na repetição do
  Cloud Tasks, que fechou o ciclo. Atacado em D-409 (migration `20260923195958`): conferir o tempo a frio depois dela.
- **Um só app do Mercado Livre para Dev e produção** (D-350). A URL de notificação é
  uma só e está em produção desde 2026-09-14 17:30 UTC; o Dev ficou sem webhooks e
  está **pausado** (15 jobs e 7 filas). Retomá-lo sem app próprio volta a disputar a
  cota e a renovar os tokens das mesmas contas.
- **Estoque: D-351 publicada e F3 aplicada em 17/09** (§13), provada em 18/09; D-352 publicada em 18/09 (§8) e
  `v3-reconcile-balances` despausado pelo dono. Entrada manual das
  devoluções pela lista do ledger, não pelas notificações: 26 já voltaram sozinhas.
  A última planilha do UpSeller é de 24/09: a venda da Shopee paga desde então só baixa quando o pedido é relido (D-495 b). O dono importa uma nova (20/10); o ajuste sai na conciliação das 06:00.
- **O padrão do `gcloud` nesta máquina é `speedbikers-prod`.** Todo comando manual com
  `--project`; e no Windows `--format=value()` termina a linha com `\r` — em laço,
  `tr -d '\r'`, senão só o último item funciona.

- **As 22 RPCs foram varridas; sobra vigilância, não suspeita (D-305→D-307).** Duas tinham
  plano genérico, uma tinha desperdício e 16 estavam saudáveis. **A lição que fica é sobre a
  FONTE:** `get_stock_coverage` aparecia com 89 ms no `pg_stat_statements` e custava **27 s** na
  forma que a tela usa. Toda RPC nova pede ensaio deliberado como `authenticated`, em cada forma
  de chamada (detalhe no arquivo de 2026-09-17 e em `docs/PERFORMANCE.md`).
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
- **MLB1476804187 fora do ar, sem relist possível** (D-369): o ML recusou as
  retomadas de 17/09 com `item.variations.relist.invalid` (variações em conta de
  user products). O destino do anúncio é decisão do dono.
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
2. ~~`bash infra/cloud-scheduler.sh`~~ — feito; a lista canônica é o script
   (`DEPLOYMENT.md` §7). Produção tem 17 jobs, iguais a ele (28/09).
3. ~~Relatar **Dashboard → Database → Backups** do projeto Dev~~ — **MEDIDO
   em 2026-09-13 (D-332)**: backup físico diário, ~7 dias de retenção. **Falta
   só confirmar o PITR** (aba *Point in time*, que não renderizou para as
   ferramentas). **3a. O ensaio de restore** é o próximo ato: restaurar um
   backup num projeto NOVO e rodar `pnpm --filter @sb/db run check:restore` —
   roteiro em `docs/DEPLOYMENT.md` 8.1, **corrigido em D-347**: a aba é
   *Restore to new project* — o "Restore" de *Scheduled backups* sobrescreve o
   Dev —, o comando é PowerShell com `pnpm.cmd` e `sslmode=no-verify`, e o
   `BACKUP_AT` se calcula no restaurado, não se lê da lista.
3b. **Conferir o saldo do estoque contra o UpSeller** — planilha nova só
   **depois da 1ª rodada da `v3-reconcile-balances`** (19/09; D-351 e D-352 publicadas). É a segunda metade da
   condição que o item da reconciliação impõe a si mesmo, e a única que falta
   (D-223). D-134 já leu a rodada e mediu **zero divergências em 3.472
   chaves** — mas isso é consistência interna, projeção contra ledger. Abrir o
   UpSeller, comparar o saldo de alguns SKUs e relatar fecha o `[~]`.
3c. ~~As duas contas em `ERROR` (03/09)~~ — reautorizadas pelo usuário.
4. Ensaio de `/produtos` (5 SKUs sentinela) e preencher
   `/reposicao/configuracoes`.
5. Primeiro relist real, deliberado, com anúncio sacrificável.
6. **Auth → Leaked Password Protection, no Dev e em produção** — estado **não
   verificável** por ferramenta: o lint sumiu do advisor nos dois projetos em
   2026-09-14, o que não prova que está ligada (D-350). Conferir no painel:
   Authentication → Sign In / Providers → Email → *Prevent use of leaked
   passwords*, em `nmgccyqquwxecqffsidr` e em `imvjfgnaprqsfjlnsyev`.
7. **Branch protection da `main` — FALTA.** A proteção de 2026-09-03 (2 checks
   obrigatórios, `typecheck, lint, test, build` e integração, D-350) ficou na
   `v3` aposentada; a `main`, que publica produção, não tem proteção nem
   ruleset (conferido em 2026-09-28): push direto e force-push passam. Recriar
   a mesma regra na `main` e tirar a `v3` da política de branch do ambiente
   `producao`.
8. ~~Deploy de `worker`/`api` para D-229~~ — feito em 2026-09-03.
9. ~~**O repositório está PÚBLICO.**~~ — **DECIDIDO pelo usuário em
   2026-09-03: fica público**, porque o plano gratuito do GitHub não aceita
   mais commits em repositório privado. Consequência que vale para todo mundo
   que escreve aqui: **os docs são públicos** — nunca um segredo, uma chave,
   um dado pessoal de cliente ou um número que a empresa não publicaria.
10. ~~Rotacionar a credencial do GitHub~~ — feito em 2026-09-14.
11. **Produção (D-350 §7):** apagar o *ambiente* do GitHub
    `SUPABASE_PROD_DB_PASSWORD` (sem trava) e confirmar os `SUPABASE_PROD_*`
    dentro de `producao`; na Vercel `speedbikers-prod`, `NEXT_PUBLIC_*` só em
    Production (conferido em 28/09) e remover as 5 variáveis de infra, que
    nenhum código da `web` lê; no Supabase de produção, Site URL e redirects do Auth, SMTP e PITR;
    no painel do Mercado Livre, tópicos e redirects — e um app próprio para o
    Dev antes de retomá-lo.
12. **Shopee (no ar desde 16/10):** cadastrar a **alíquota de imposto** em `/central/metas` — produção não tem nenhuma, e o imposto sai nulo no ML e na Shopee (`docs/SHOPEE.md` §8). Os ajustes pós-escrow: decididos por delegação (D-485, o resultado desconta).

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
| rollout da V3 | produção já recebe os webhooks e tem as 4 contas e a planilha do UpSeller. **Antes do corte:** ler a 1ª rodada da reconciliação (19/09) e os atos da seção própria |
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

**Curva ABC em 17/09:** filtro A/B/C no SQL, 50 linhas e rolagem interna.

**Estoque:** D-351 e D-352 em produção. D-362 e D-423 em produção; o histórico (365 dias, sem estoque) disparado em 07/10 por job temporário do Scheduler com o OIDC da `v3-scheduler-invoker`, apagado depois. Receita com SKU em 90 dias: R$ 7,14 mi -> R$ 8,50 mi de R$ 8,62 mi.

**Anúncios:** filtro de promoção (D-419) em produção; conferir no log a queda de `listing_promotion_fetch_failed` (~13 por rodada antes). D-420 (campanhas) em código: migration `20260929180000` antes do worker.

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
