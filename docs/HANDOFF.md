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
| **Atualizado em** | 2026-11-21 |
| **Branch** | `main` (única; em 23/09 a `fix/guardas-prod-d348` foi renomeada para `main`, virou a branch padrão do repositório e a `v3` foi aposentada — a tag `v2-final` guarda o último estado da main antiga, da V2). |
| **HEAD conhecido** | Base de integração `origin/main` em `a81f5235` (#348). O candidato usa branch própria. [Checkpoint](agent-audit/SESSION_LOG.md). |
| **Fechamento da V3** | 137/226 pontos (60,6%), 24/43 entregas pelo inventário Sentinel. [Evidências](agent-audit/STATE_AND_COMPLETION_2026-11-18.md). |
| **Sentinel: próximo passo** | Upgrade PG17 isolado de 324 para 328. Falha no quarto SQL e recuperação de schema e histórico ensaiadas. Faltam CI completa, catálogo atual da VM e registro das quatro migrations no Dev. |
| **Deploy Dev** | Supabase Dev `nmgccyqquwxecqffsidr` inativo. Em 21/11, o provedor recusou a retomada: banco de 2,0 GB acima do plano gratuito. Rotinas GCP pausadas (D-350). |
| **Supabase** | Produção usa a VM `sb-db` (`speedbikers-prod`). O antigo projeto hosted `imvjfgnaprqsfjlnsyev` estava `INACTIVE` em 18/11. Convite, SMTP e recuperação Auth seguem pendentes. [VM](../infra/vm/README.md). |
| **Produção** | Cloud Run em leitura de 20/11: API `api-00041-8m8` e worker `worker-00059-mjc`, 100% de tráfego nas respectivas revisões. A validação do alias web do catálogo de compras está registrada no #333. |
| **Migrations** | Última versão da base Git `20261119180000`. A leitura histórica da VM confirmou 323 versões até `20261119120000`. Ordem definitiva e workflow para a VM pendentes. [VM](../infra/vm/README.md). |
| **Compras (D-720 a D-725, D-760 a D-764, D-767, D-792)** | Compras inteligentes, importação anterior e invoice/proforma entregues. D-792 acrescenta entrada no LOCAL e criação do SKU na conferência. [Evidências](archive/handoffs/2026-11-18_integracao-compras-importacao.md). |
| **Notas (D-765, D-766)** | #334 registrou saída para Full. #335 incorporou Saída Manual e edição de itens. O aceite operacional de ponta a ponta segue no fechamento. |
| **UX (Agente 3)** | Central integrada até D-519. [Escopo e evidências](UX_SYSTEM.md). |
| **Frente atual** | Recuperação e fechamento após o corte de banco. Estoque Shopee no Go Live e TikTok transacional seguem pendentes. [Multicanal](MULTICHANNEL_HANDOFF.md). |

### O que está pronto

Entregas até setembro em `docs/archive/handoffs/2026-10-15_o-que-esta-pronto-de-setembro.md`. Margem de venda por SKU na Curva ABC e no Ranking (METRICS 5N e 5X).

Detalhe por fase: `docs/ROADMAP.md`. Motivo de cada decisão:
`docs/DECISIONS_INDEX.md` → `D-xxx` em `docs/DECISIONS.md`.

---

## P0 ativos

- **Recuperação após corte para a VM.** Navegação autenticada registrada pelo #333. Provar convite/reset, atraso de pedidos/financeiro/SAC e saldos contra ERP. Conferir os efeitos dos agendamentos no banco.
- **Recuperação de desastre e migrations.** #333 registra restore isolado completo e ensaio dos 17 SQLs. Em 19/11 há snapshot automático READY. Prefixo `diario/` vazio na listagem. Faltam confirmar o dump recorrente, alertas e adequação do workflow à VM.
- **Segurança: patches locais.** Next (`16.4.6`), Zod, ERP/NF-e apply e webhook Shopee corrigidos localmente; falta publicar. `pnpm audit --prod --audit-level high` passa com 1 moderado transitivo (`uuid`). [Evidências](agent-audit/STATE_AND_COMPLETION_2026-11-18.md).
- **Publicação sem proteção efetiva.** GitHub em 18/11: `main.protected=false`, sem checks obrigatórios ou rulesets. A07 exige ação do responsável antes de considerar os portões de publicação cumpridos.

---

## Riscos ativos

- **O faturamento do ML perto do `statement_timeout`** (19/10, `docs/PERFORMANCE.md`): D-499 em produção, 47 vezes menos páginas; 90 dias com detalhe ainda 2,1 s quente, todo CPU.
- **Produção sem alerta externo** (rechecado em 18/11: zero uptime checks e políticas no Monitoring): a parada de D-414 durou ~27 h com o Scheduler verde. No app,
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

- **Disco da VM:** Ops Agent publica utilização. Política em revisão, pendente de canal de alerta e ativação.

- **As 22 RPCs foram varridas; sobra vigilância, não suspeita (D-305→D-307).** Duas tinham
  plano genérico, uma tinha desperdício e 16 estavam saudáveis. **A lição que fica é sobre a
  FONTE:** `get_stock_coverage` aparecia com 89 ms no `pg_stat_statements` e custava **27 s** na
  forma que a tela usa. Toda RPC nova pede ensaio deliberado como `authenticated`, em cada forma
  de chamada (detalhe no arquivo de 2026-09-17 e em `docs/PERFORMANCE.md`).
- **CI:** o E2E da Shopee usa datas de São Paulo. Os jobs de testes usam
  Actions com Node 24. Em falha ao subir a stack, confira o log e reproduza
  com um projeto Supabase local isolado. [Testes](TESTING.md).

- **Backup da VM:** sondagem diária às 04:25 BRT. Scheduler, incidente e entrega do alerta confirmados. [Detalhes](../infra/vm/README.md).

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
- **O teto de 1.000 do PostgREST e o `n_live_tup` que mente** — dois riscos estáveis, sem mudança desde setembro: texto em `docs/archive/handoffs/2026-11-17_trechos-do-handoff.md`.

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

- **Sentinel.** PR #328 com CI verde em `60784059` (338 casos de E2E). D-716–D-719, D-726–D-728 e D-754–D-759 recuperam diálogos e formulários após falha de transporte. A última fatia conserva os campos dos quatro cadastros da Central após falha ou recusa, incluindo o marketplace escolhido e os limites ao restaurar padrões. Os cinco componentes com `useTransition` e os quatro formulários diretos com `useActionState` inventariados foram conferidos (D-726–D-728 e D-758–D-759). Próxima reprodução: confirmação compartilhada de remover e voltar aos padrões, no plano. As migrations `20261117171808` e `20261117173152` (D-714, D-715) foram aplicadas só no banco local e precedem a web. Publicação e validação com carga real seguem pendentes. [Plano](agent-audit/PLAN.md)

### Fechamento da V3 — as cinco categorias de D-223

**Bloqueadores técnicos (A)** — sem isto a V3 não fecha:

| | |
|---|---|
| backup e restore **verificados** | O dump diário de 19/11 restaurou 322 migrations em contêiner isolado. A sondagem de leitura confirmou a cópia no Cloud Storage. Falta agendamento externo e confirmação do canal em falha controlada. [VM](../infra/vm/README.md) |
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

**Aprendizado humano supervisionado** (Trilha 7C): destrava com uso, não com código (D-235; a medida de 03/09 em `docs/archive/handoffs/2026-10-20_trechos-do-handoff.md`) ·
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

**Rollout Sentinel:** o [#366](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/366)
valida o catálogo da VM e permite conferir o mesmo plano entre aprovações.
O backup de 20/11 contém 324 versões compatíveis com a base do candidato.
Antes de aplicar o [#364](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/364),
obter o catálogo atual da VM, registrar as quatro migrations no Dev e
reconciliar o workflow com o destino VM. A correção dos anúncios ML segue
separadamente no [#368](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/368),
sem migration. [Checkpoint](https://github.com/PabloCoder1/speedbikers-gestao-v2/issues/351).

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
