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
| **Atualizado em** | 2026-09-02 |
| **Branch** | `v3` (a `main` é a V2, só referência — nunca copiar) |
| **HEAD conhecido** | `a3a42e4` (D-222) — esta fatia, D-223/D-224, é o commit seguinte |
| **Fechamento da V3** | **185 de 213 itens do ROADMAP fechados (87%)** — 26 abertos e 2 parciais. Dos 26, **6 são bloqueadores**, e todos são hardening/lançamento: nenhum é feature faltando (D-223) |
| **Deploy no ar** | **`0702969` — o mesmo do `HEAD`, sem atraso** (`api-00030-gqw` / `worker-00045-cwq`, 2026-09-02). Depois de 66 commits parado. Verificado contra a infraestrutura, não contra o script: `APP_COMMIT=0702969` nos dois serviços, imagem `api:0702969`, `/health` respondendo `{"commit":"0702969"}` e **zero `ERROR`** no Cloud Logging desde o boot |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | **131 locais, 130 no Dev** — o expurgo (`20260903120000`) está no git e **não pousou**; a CI não o aplicou, sem drift — D-209→D-212 aplicadas pela CI em 2026-09-02 e CONFERIDAS lá (`anon` alcança 0 funções; `ml_accounts` sem UPDATE/DELETE para `authenticated`; `created_by` presente). O caminho é o push, **nunca** o MCP (lição de D-207) |
| **Frente atual** | Trilha 8B — P0 fechado (A–H); em P1 |

### O que está pronto

Fases 0–4, 5A–5D, 6, 6B, 7, 7B e 9 (backend) concluídas nos critérios
registrados. A trilha 5E entregou as seis centrais analíticas
(Movimentações, Dashboard 360º do Anúncio, abas do SKU, Preços, Full,
Fornecedor). A 8A entregou Usuários/Permissões (D-175) e Saúde do
Sistema (D-176); faltam Integrações e Configurações.

Detalhe por fase: `docs/ROADMAP.md`. Motivo de cada decisão:
`docs/DECISIONS_INDEX.md` → `D-xxx` em `docs/DECISIONS.md`.

---

## P0 ativos (trilha 8B)

Medidos contra o Dev em 2026-09-01, não herdados de documentação.

| | Item | Evidência |
|---|---|---|
| ~~P0-A~~ | ~~Contexto dos agentes~~ | ✅ corrigido em D-177 — bootstrap de ~1.245 KB para **7,6 KB**; `pnpm docs:check` guarda |
| ~~P0-B~~ | ~~Writes sem verificação~~ | ✅ corrigido em D-178 — `assertWritten` aborta; 3 testes provam que nada posterior roda |
| ~~P0-C~~ | ~~Webhooks sem consumidor viram task~~ | ✅ corrigido em D-179 — allowlist em `@sb/contracts`; **218.750 execuções/zero trabalho** deixam de ser enfileiradas — **no ar desde 2026-09-02** |
| ~~P0-D~~ | ~~`has_role` sem organização~~ | ✅ corrigido em D-180 — `has_org_role` em 21 policies e 8 funções; `has_role` removido; +5 testes cross-org |
| ~~P0-E~~ | ~~`SECURITY DEFINER` / `search_path` / policies duplicadas~~ | ✅ inventariado em D-182 — **nenhum dos três tinha vulnerabilidade**; advisor 33 → 26 WARN; allowlist das 25 RPCs virou teste de CI |
| ~~P0-F~~ | ~~`get_stock_balances`~~ | ✅ corrigido em D-181 — **9.104 ms → 681 ms**, sem tocar na RPC |
| ~~P0-G~~ | ~~`get_listings_dashboard`~~ | ✅ corrigido em D-181 — **timeout em 60 s → 271 ms**, sem tocar na RPC |
| ~~P0-H~~ | ~~Demais RPCs fora do budget~~ | ✅ fechado em D-183 — `get_sku_sales_baseline` **1.334 ms → 49 ms**; `get_sku_timeline` nunca foi problema (3.308 ms era cache frio, o real é 57 ms); a Central de Notificações não estava lenta, estava **contando errado** |

**Todo o P0 da trilha 8B fechou** — A a H. A frente passa para o P1.

✅ **E agora o bloco P0 está completo de verdade — os nomeados E os três
sem letra.** A ressalva abaixo nasceu porque "P0 fechado — A a H" era o
recorte dos itens que tinham letra: o bloco do `docs/ROADMAP.md` tinha mais
três, e chamá-lo de fechado os tornava invisíveis. Ficam listados porque a
lição é essa, não porque restem:

| item | estado |
|---|---|
| ~~`get_system_health` com escopo de plataforma~~ | ✅ **fechado em D-209** |
| ~~`ml_accounts` com UPDATE/DELETE para `authenticated`~~ | ✅ **fechado em D-210** |
| ~~`pg_default_acl` de funções~~ | ✅ **fechado em D-211** |

Números completos e método: `docs/PERFORMANCE.md`.

---

## Riscos ativos

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
  estava escrito aqui e mesmo assim custou uma rodada (D-225).
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
- **`n_live_tup` mente, e mentiu feio.** As estatísticas do Dev estão velhas:
  `job_runs` estimava ~6 mil e tem **271.184**; `ml_credentials` estimava 0 e
  tem **4 credenciais reais**. Para qualquer raciocínio de segurança ou de
  volume, `count(*)` — nunca a estimativa (D-182).

---

## Atos humanos pendentes

Nada disto pode ser feito por um agente.

1. ~~**Deploy** dos dois serviços~~ — **FEITO em 2026-09-02**, e com ele
   entraram no ar D-162→D-216: a correção do 429, o `APP_COMMIT`, o fim dos
   218.750 jobs vazios de webhook, a falha definitiva respondendo 200 e o
   caminho de pedidos reescrito.
2. ~~`bash infra/cloud-scheduler.sh`~~ — **FEITO**, 14 jobs `ENABLED`.
   ⚠️ **O «15 esperados» que estava escrito aqui era falso.** A lista canônica
   é `infra/cloud-scheduler.sh` (`docs/DEPLOYMENT.md` §7 diz isso), e ela tem
   **14**. Conferido dos dois lados: 14 no script, 14 no Cloud Scheduler.
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
7. ~~**Branch protection da `v3`**~~ — **FEITO em 2026-09-03**, a proteção
   MÍNIMA e reversível: sem force-push, sem apagar a branch, **sem** PR
   obrigatório e **sem** status check obrigatório — o fluxo de push direto na
   `v3` continua igual. Exigir PR/CI é decisão de fluxo, não de agente; quando
   vier, os nomes reais dos jobs estão em `.github/workflows/ci.yml`.
8. ~~**Deploy de `worker` (e `api`) para D-229 valer.**~~ — **FEITO em
   2026-09-03 (autorizado pelo usuário, executado pelo agente)**: `worker` e
   `api` em `6baa641` e depois `worker` de novo com D-230. Validação no ar:
   `v3-order-financials-sweep` disparado a mão às 14:56 UTC e
   `order_financials` passou de **1 para centenas de linhas** em minutos, com
   frete e desconto observados (a leitura final está em D-229/D-230).
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
| UX final da republicação | backend pronto (D-159→D-164); falta a superfície de confirmação humana |

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
em 2.320 dos 3.554 SKUs. Na curva, o recorte **recalcula** as classes; na
cobertura, os totais do cabeçalho (que vêm de outra RPC) recebem o mesmo
filtro, e `history_days_90` **não** segue o recorte de propósito.

🔴 **A próxima tarefa é o filtro de Marca em `/vendas`**, a última do item.
**O caminho está medido, e ela é maior que as duas anteriores:**

| | |
|---|---|
| RPCs a mudar | **6** — `get_sales_summary`, `get_sales_daily_series`, `get_sales_expanded_summary`, `get_sales_today_summary`, `get_sales_margin_summary` (a sexta é a repetição do período comparativo) |
| chamadas na tela | **cada uma duas vezes** (período atual + comparativo) — o filtro precisa ir nas duas, senão a comparação mente |
| antes de escrever | perguntar ao catálogo quem chama cada uma (`select proname from pg_proc where prosrc like '%get_sales_%'`) — foi assim que D-236 não repetiu o erro de D-235 |

⚠️ **`/vendas` JÁ TEM filtro de conta**, então ali entram as duas dimensões do
item — e o cuidado de D-236 vale em dobro: quando um número do cabeçalho vem
de RPC diferente da tabela, os dois têm de receber o mesmo recorte.

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

⚠️ **`check:embeds` e `check:waterfalls` não estão no `check`** e cada um
mora num pacote: `pnpm --filter @sb/db run check:embeds` (exige as variáveis
do `supabase status` exportadas) e `pnpm --filter web run check:waterfalls`.

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
