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

- ~~**O que está no ar é velho.**~~ **RESOLVIDO em 2026-09-02**: o deploy
  levou os dois serviços de `fc39c27` para `0702969`, o mesmo do `HEAD`.
  D-171 e D-176 passaram a valer, e `/saude` deixa de mostrar `UNKNOWN`.
  **O risco não sai daqui, muda de forma:** o que voltou a valer é a regra de
  D-070 — 66 commits se acumularam entre um deploy e outro, e nada no sistema
  avisa. Quem trabalha no `worker` ou na `api` confere `APP_COMMIT` contra o
  `HEAD` antes de concluir que uma correção está valendo.
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
- **O truncamento de 1.000 do PostgREST volta sempre.** D-131 corrompeu o
  estoque; D-183 achou um contador errado; D-193 achou mais dois cortes vivos
  no worker; D-194 achou um **na tela**, escondendo 10 das 19 marcas do
  filtro. Ao escrever qualquer leitura, pergunte quantas linhas ela pode
  devolver **no pior caso** — e num `in(...)`, o que a chave multiplica, não
  o tamanho do lote.
- **"Cosmético" é um julgamento, e julgamento sem medição é chute.** Eu
  mesmo registrei o filtro de marcas como sintoma cosmético em D-193. Medido
  em D-194: a tela mostrava **9 de 19 marcas**. Antes de rebaixar a
  prioridade de um defeito, produza o número que justifica o rebaixamento.
- **O tipo gerado não conhece a RLS.** `supabase gen types` deriva a
  nulabilidade de um embed da chave estrangeira; a RLS é avaliada depois, e
  uma linha invisível ao chamador faz o embed voltar `null` numa coluna que o
  tipo declara não-nula (medido em D-192). Não remova um `?.` sobre embed só
  porque o compilador diz que é desnecessário — pergunte antes se a RLS pode
  esconder aquela linha daquele leitor.
- **A primeira medição pode ser cache frio.** `get_sku_timeline` mediu
  3.308 ms na primeira passada e **57 ms** na segunda — quase virou uma
  otimização inútil. Sempre duas passadas seguidas; se divergirem muito, a
  primeira era I/O de disco (D-183).
- **O guarda estático precisa provar que ainda detecta.** `check:waterfalls`
  (D-195) roda quatro casos-fixture na própria carga e aborta se algum falhar,
  porque um guarda que para de detectar em silêncio deixa a esteira verde com a
  garantia vazia. Ele também foi conferido contra o código ANTERIOR à correção:
  acusa 12 dos 14 sítios reais. Todo guarda novo nasce com essa dupla prova.
- **O recorte da varredura decide o que ela pode achar.** A de D-195 começou
  olhando só `page.tsx` e quase perdeu o achado de maior alcance do app: o
  `Shell` fazia três leituras em fila e embrulha **toda** página autenticada.
  Antes de rodar uma varredura, pergunte se a unidade escolhida é a unidade
  onde o defeito mora.
- **Guarda estático se confere contra o DEFEITO, não contra a correção.**
  `check:waterfalls` passava verde no repo inteiro e estava cego para quatro
  classes (D-197). A pior só apareceu ao rodá-lo contra o código anterior: a
  variável se chamava `order` e o bloco continha `.order("position")`, então
  ele via dependência onde não havia — falso NEGATIVO silencioso. Rode todo
  guarda nas duas versões: a corrigida não pode acusar, a anterior tem que.
- **Uma dependência textual pode ser inventada por um filtro redundante.**
  `/precos` e `/full` amarravam a leitura de `ml_accounts` à da organização
  por um `.eq("organization_id", ...)` que a RLS já garantia — e mais
  estreito. Antes de aceitar que duas leituras estão em fila por necessidade,
  pergunte se o que as amarra é dado ou é um filtro que não filtra nada.
- **Um agente que escreve no repositório precisa ser conferido com `git
  status`.** A varredura de D-200 deixou `apps/worker/src/handlers/__cast_probe.ts`
  para trás — um arquivo criado para inspecionar um tipo e nunca apagado. Quem
  pegou foi o `tsc`, não a leitura do resultado do agente.
- **O embed pode voltar nulo quando a policy do PAI não se apoia na mesma
  tabela do EMBED.** É a regra que D-206 extraiu atacando os quatro casts que
  sobraram: em `listings → ml_accounts` a policy usa `accessible_accounts()`,
  derivada da própria `ml_accounts`, então um órfão esconde o PAI e o nulo é
  inalcançável; em `organization_members → profiles` a policy usa
  `accessible_orgs()`, que não olha `profiles`, e o nulo aflora. Antes de
  remover um cast sobre embed, faça essa pergunta — ela é mais curta que
  reconstruir o raciocínio.
- **"Tem CASCADE, logo não existe órfão" é falso.** CASCADE é implementado por
  gatilhos, e `pg_restore --disable-triggers` os desliga — que é exatamente
  como se restaura dado, e "backup/restore verificado" é item aberto do
  roadmap. Foi essa perna que caiu no ataque de D-206 e salvou um cast.
- **Relatório de número cru repete o engano de quem o leu.** O `report:health`
  (D-205) imprime a armadilha ao lado de cada valor porque esta sessão leu
  estes mesmos números errado seis vezes. Rode-o com
  `DB_URL=... pnpm --filter @sb/db run report:health`, e leia os ⚠️ JUNTO dos
  números, não depois.
- **A janela das estatísticas é conhecível — eu tinha dito que não.**
  `pg_stat_database.stats_reset` fica NULO após um restart, mas
  `pg_stat_statements_info.stats_reset` tem a data exata (validada contra
  `count(*)`: 1 linha de erro em 54 mil). D-198 concluiu "não dá para saber" a
  partir da view errada.
- **Fixture com data fixa apodrece, e apodrece em silêncio.** O de
  `get_purchase_suggestions` fixava `captured_at` em `2026-08-13`, e dependia
  sem dizer de a função NÃO ter janela de frescor. Ficou verde por semanas
  porque a função que ele testava tinha o defeito complementar; quebrou no
  instante em que o defeito foi corrigido. Data em fixture se escreve
  relativa ao `now()`, salvo quando a data É o que está sob prova.
- **Não pergunte ao Dev o que é verdade no repositório.** A guarda de D-204
  passou no Dev e quebrou o `db reset`: no Dev, `get_stock_balances` já é
  canônica por uma migration de OUTRA frente que não está no git. Consulta a
  catálogo responde sobre o BANCO consultado — e enquanto houver drift, o
  banco e o repositório são coisas diferentes. Para "o que o repositório
  produz", a fonte é `supabase/migrations/`, não `pg_proc`.
- **Asserção sobre outras funções não cabe dentro de uma migration.** Ela roda
  uma vez, no meio da fila, e o que vale naquele instante depende de tudo que
  veio antes — que difere entre ambientes. Guarda desse tipo mora no teste de
  integração, que roda contra um banco recriado do zero.
- **Varredura de arquivo herda o recorte de quem a montou; de catálogo, não.**
  Em D-204 os agentes leram as seis migrations que eu listei e não viram a
  terceira definição de Full — porque `get_sku_dashboard` não estava na minha
  lista. Quem a achou foi uma consulta a `pg_proc`, que pergunta ao banco em
  vez de ao repositório. Quando a pergunta é "quem faz X hoje", pergunte ao
  catálogo.
- **Meça o DANO, não o sintoma — e o erro tem os dois sinais.** Em D-194 eu
  tinha chamado de "cosmético" um filtro que escondia 10 de 19 marcas; em
  D-203 chamei de urgente um 429 cujo dano real é **1 anúncio em 1.204**. As
  duas vezes converti um sintoma em prioridade sem perguntar o que ele
  custava. Antes de escalar ou rebaixar, produza o número do dano.
- **Antes de propor a correção, leia se ela já existe.** O "espalhar a rajada"
  de D-203 já estava implementado e no ar desde D-156. Um `git log` no arquivo
  teria poupado o item inteiro.
- **Num sistema com fila externa, a tabela de execuções não sabe quantas
  vezes foi chamada.** `job_runs.attempt` marcava **1** em 2.234 execuções
  extras porque ninguém escreve `X-CloudTasks-TaskRetryCount` nela. Minha
  primeira leitura concluiu "zero retentativas, não há pressão" — eu li o
  instrumento, e o instrumento mentia. O que revelou foi contar `job_id`
  repetido. Antes de concluir "não há retry", pergunte quem escreve o número.
- **Percentagem sem o total é enquadramento, não medição.** "O Realtime é
  43,4% do tempo do banco" (D-198) e "o Realtime é 0,63% do relógio" descrevem
  o MESMO fato — e só o segundo diz se vale mexer. Num ambiente ocioso, toda
  participação percentual infla. Antes de chamar algo de maior consumidor,
  responda: consumidor de quanto?
- **Taxa de refutação zero é sinal de cético frouxo, não de achado forte.**
  Aconteceu em D-182 (0 de 16) e de novo em D-200 (0 de 16) — e em D-200 a
  lista incluía o sítio que D-192 já tinha revertido. Quando a varredura
  aprova tudo, o filtro tem que vir de outro lugar: em D-200 veio do
  compilador (remover o cast e ver se o lint exige apagar um `?.`).
- **Uma otimização de materialização se prova por IGUALDADE, não por
  economia.** D-199 cortou 485 mil escritas por dia numa tabela de métricas —
  e o número que autoriza a fatia não é esse, é a assinatura md5 idêntica
  entre a forma antiga e a nova depois de estragar os dados de propósito.
  Economia sem prova de igualdade, numa tabela de números, é risco puro.
- **`stats_reset` NULO não quer dizer "desde sempre".** Um restart do
  Postgres leva as estatísticas junto e deixa `stats_reset` nulo assim mesmo.
  Confira contra um número que você conhece — em D-198, `n_tup_ins` de
  `job_runs` era 42.936 contra 307.756 linhas reais, e isso revelou que a
  janela era de 23 horas, não de 13 dias. Toda conclusão tirada de
  `idx_scan = 0` depende dessa janela.
- **Conflito à vista em `20260902005023_stock_balances_page_first.sql`.**
  D-207 recuperou essa migration do banco porque ela existia só no Dev.
  Quando a outra frente empurrar a fatia dela, o git vai acusar conflito neste
  arquivo: o SQL é idêntico, a diferença é o cabeçalho. **Fique com a versão
  deles** — tem a intenção original e o registro da decisão.
- **Comparar predicados por abrangência só vale dentro do mesmo universo de
  linhas.** Em D-210 conferi que a policy de SELECT de `ml_accounts` era
  "mais larga" que a de escrita que eu removia, e concluí que nada se perdia.
  Era mais larga **para as linhas que já existem** — e o INSERT cria um
  universo com uma linha a mais. Uma policy apoiada em conjunto derivado
  (`accessible_accounts()`, STABLE) **não alcança a linha que a própria
  instrução está criando**; uma que lê a coluna da linha, sim. Resultado:
  `insert ... returning` passou a ser recusado, e a decisão dizia o
  contrário (corrigido em D-212).
- **`proacl` é armazenamento; privilégio efetivo é `has_function_privilege`.**
  Em D-211 comparei os dois bancos contando a string `authenticated=X` na ACL
  crua e achei **58 contra 64** — registrei uma divergência que não existia.
  ACL nula significa "default embutido", que concede a `PUBLIC`, que inclui
  os dois papéis. Medido direito, os bancos eram **idênticos**. Para "quem
  pode executar", pergunte a `has_function_privilege`, nunca ao texto de
  `proacl`.
- **Um guarda pode ser mais estreito que o próprio nome.** "nenhuma funcao
  SECURITY DEFINER de public e alcancavel por anon" (D-182) filtra
  `p.prosecdef` — ficou **verde o tempo todo** enquanto 6 funções
  não-DEFINER eram alcançáveis por `anon` (D-211). Antes de confiar num
  guarda, leia o `where` dele e pergunte que população fica de fora.
- **Não rode `gen:types` da CLI local para conferir tipo.** `packages/db/src/types.ts`
  é gerado pelo **MCP** e carrega correções manuais marcadas "CORRECAO MANUAL"
  (D-133/D-147). O gerador da CLI produz outro formato e as apaga: em D-209 a
  conferência produziu **476 linhas de diff** que não tinham nada a ver com a
  mudança. Para "a assinatura mudou?", a fonte é o catálogo
  (`pg_get_function_result`), não o gerador.
- **Um guarda pode estar consultando a fonte errada e passar sempre.**
  `information_schema.columns` descreve TABELA e VIEW, nunca FUNÇÃO. Um teste
  de D-176 afirmava "a função não devolve `statements`" sobre uma lista **vazia**
  — verde desde que nasceu, e teria passado igual se a função vazasse o SQL
  inteiro das migrations. Antes de confiar num guarda, pergunte se a consulta
  dele devolve alguma linha **na versão correta** (D-209).
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
| Hub de Configurações | um dado, um dono: aponta para a tela dona, não duplica |
| Aprendizado humano supervisionado | reusa a Base de Conhecimento (D-113); nada promovido sem humano |
| filtros de Conta e Marca | **Origem fica de fora** — `is_imported` é medido como não confiável |

**Dependentes de dado/tempo (D)** — não é possível hoje, e forçar seria inventar:

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

✅ **As nove abas do Dashboard de SKU estão entregues** — D-224 fechado em
D-228: `Visão geral | Vendas | Estoque | Anúncios | Preços | Full | Histórico |
Diagnóstico | Decisões`. Três das quatro últimas por reuso (`Full` D-225,
`Preços` D-226, `Decisões` D-228, esta por leitura direta sob RLS com embed);
`Vendas` (D-227) com a única RPC nova, `get_sku_sales_breakdown`. Bateria
completa na última: **559/559**, 29/29, 8/8, **34/34** embeds, 52, **17/17**.

✅ **Central de Integrações — primeira versão entregue em D-231** (`/integracoes`,
ADMIN): compõe as fontes existentes e aponta para as telas donas; três
dimensões por integração; configuração nunca verde sem coletor. Bateria:
**559/559**, 29/29, 8/8, 34/34, 53, **18/18**.

**A próxima pendência saudável (B), na ordem da tabela acima, é o Hub de
Configurações** — "um dado, um dono: aponta para a tela dona, não duplica"
(item "Administração → Configurações" do ROADMAP). **O caminho NÃO foi
medido**: ler o item e as telas que já são donas de cada configuração
(`/reposicao/configuracoes`, `/notificacoes/preferencias`, `/contas`,
`/usuarios`) antes de escrever — a decisão registrada no item é "embutir ou
apontar", e a resposta da casa tem sido apontar.

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
| banco, RLS, tabelas | `docs/DATABASE.md` |
| API do Mercado Livre | `docs/MERCADO_LIVRE.md` |
| métricas canônicas | `docs/METRICS.md` |
