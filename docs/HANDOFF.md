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
| **Atualizado em** | 2026-09-01 |
| **Branch** | `v3` (a `main` é a V2, só referência — nunca copiar) |
| **HEAD conhecido** | `0f7ff83` (D-205) — esta fatia, D-206, é o commit seguinte |
| **Deploy no ar** | `fc39c27` (`worker-00044-ps5` / `api-00029-vkg`) — **34 commits atrás** |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | **122 locais, 123 no Dev — o drift continua.** Ver "Dev à frente do repositório", abaixo |
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
| ~~P0-C~~ | ~~Webhooks sem consumidor viram task~~ | ✅ corrigido em D-179 — allowlist em `@sb/contracts`; **218.750 execuções/zero trabalho** deixam de ser enfileiradas ⚠️ só vale após o deploy |
| ~~P0-D~~ | ~~`has_role` sem organização~~ | ✅ corrigido em D-180 — `has_org_role` em 21 policies e 8 funções; `has_role` removido; +5 testes cross-org |
| ~~P0-E~~ | ~~`SECURITY DEFINER` / `search_path` / policies duplicadas~~ | ✅ inventariado em D-182 — **nenhum dos três tinha vulnerabilidade**; advisor 33 → 26 WARN; allowlist das 25 RPCs virou teste de CI |
| ~~P0-F~~ | ~~`get_stock_balances`~~ | ✅ corrigido em D-181 — **9.104 ms → 681 ms**, sem tocar na RPC |
| ~~P0-G~~ | ~~`get_listings_dashboard`~~ | ✅ corrigido em D-181 — **timeout em 60 s → 271 ms**, sem tocar na RPC |
| ~~P0-H~~ | ~~Demais RPCs fora do budget~~ | ✅ fechado em D-183 — `get_sku_sales_baseline` **1.334 ms → 49 ms**; `get_sku_timeline` nunca foi problema (3.308 ms era cache frio, o real é 57 ms); a Central de Notificações não estava lenta, estava **contando errado** |

**Todo o P0 da trilha 8B fechou** — A a H. A frente passa para o P1.

Números completos e método: `docs/PERFORMANCE.md`.

---

## Riscos ativos

- **O que está no ar é velho.** O deploy é de `fc39c27`; D-171 (que corrige
  o 429 das visitas) e D-176 (`APP_COMMIT` no `/health`) **não estão
  valendo**. Até o próximo deploy, `/saude` mostra `UNKNOWN` — corretamente.
- **Relist nunca foi exercitado contra o ML real.** A primeira execução
  precisa ser ensaio humano deliberado, com anúncio sacrificável.
- **A suíte de integração local exige banco recriado.** `supabase db reset`
  antes de rodar; e rodá-la quebra o seed do Playwright depois (usuários
  criados por SQL deixam `confirmation_token` nulo e o GoTrue estoura).
- **2 pedidos estão sem linha em `order_items`** (`2000017347483988` e
  `2000017394032682`): `paid`, com o movimento de estoque gravado e nenhum
  item. A dedução está certa; falta a linha que `claim-return` precisa para
  reverter devolução — sem ela ele registra `claim_return_order_item_not_found`
  e pula. **Os dois caminhos que produzem esse estado estão fechados** (D-184
  tirou a leitura da janela, D-189 tirou a janela e parou de apagar itens a
  partir de resposta vazia); qual dos dois aconteceu não dá para saber.
  **Reprocessar os dois continua sendo ato pendente.**
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
- **`n_live_tup` mente, e mentiu feio.** As estatísticas do Dev estão velhas:
  `job_runs` estimava ~6 mil e tem **271.184**; `ml_credentials` estimava 0 e
  tem **4 credenciais reais**. Para qualquer raciocínio de segurança ou de
  volume, `count(*)` — nunca a estimativa (D-182).

---

## Dev à frente do repositório (2026-09-02) — a CI está vermelha por isto

O Supabase Dev tem uma migration que **o repositório não tem**:

| | |
|---|---|
| versão | `20260902005023` |
| nome | `stock_balances_page_first` |
| o que faz | reescreve `public.get_stock_balances` (a RPC de `/estoque`) |
| no git | **não existe**, em nenhum branch |

O comentário dentro dela se identifica como **"Page-first (D-196)"** — ou seja,
é trabalho de **outra frente**, aplicado no Dev e ainda não empurrado. Foi ela
que deixou o job `aplicar migrations no Supabase Dev` vermelho em `28eeaa7`
(D-195): o `db push` encontra no remoto um histórico que o local não contém.
Os outros 5 checks daquele commit passaram, incluindo o Playwright.

**Não recuperei o arquivo para dentro do repositório de propósito.** O SQL é
integralmente legível em `supabase_migrations.schema_migrations`, então
reconstruí-lo é trivial — mas adotar DDL de outra frente sob autoria alheia,
sem a fatia e os testes que a acompanham, trocaria um problema visível por um
invisível. **Quem tem a fatia é quem deve empurrá-la**; quando isso acontecer,
o `db push` volta a passar sozinho.

Duas consequências práticas enquanto isso não acontece:

- **o número D-196 está tomado** — esta sessão pulou para D-197;
- **`get_stock_balances` no Dev não é mais o que as migrations do repositório
  produzem.** Um `supabase db reset` local dá a versão antiga; o Dev tem a
  nova. Qualquer medição da RPC precisa dizer contra qual das duas rodou.

---

## Atos humanos pendentes

Nada disto pode ser feito por um agente.

1. **Deploy** dos dois serviços (`bash infra/deploy-cloud-run.sh`) — leva ao
   ar D-162→D-179: a correção do 429, o `APP_COMMIT` e o fim dos 218.750
   jobs vazios de webhook. **É o ato de maior efeito pendente.** (D-180 e
   D-181 são de banco e já valem no Dev, sem depender do deploy.)
2. `bash infra/cloud-scheduler.sh` depois do deploy (15 jobs esperados).
3. Relatar **Dashboard → Database → Backups** do projeto Dev (decide a
   abordagem de backup da Fase 8).
4. Ensaio de `/produtos` (5 SKUs sentinela) e preencher
   `/reposicao/configuracoes`.
5. Primeiro relist real, deliberado, com anúncio sacrificável.
6. **Auth → Leaked Password Protection** está desligado no Supabase
   (configuração externa, não migration).
7. **Branch protection da `v3`**: hoje `protected: false` — a CI não é
   tecnicamente obrigatória para merge.

---

## Próximos passos

1. **O deploy é o que trava a medição, e agora com peso.** **Seis** fatias
   seguidas (D-184 a D-190) mudaram o worker e **nenhuma pôde ser medida
   ponta a ponta**. O caminho de pedidos saiu de 7 idas ao banco por pedido
   para ~0,16 — na estrutura, fixada em teste. O número real precisa do
   deploy, e a consulta está em `docs/PERFORMANCE.md`.

   **O caminho de pedidos fechou como frente.** O que resta do P1 é outro
   assunto.
2. **P1 — retenção de `job_runs`, e ela também espera o deploy.** São
   **271.184 linhas** reais. Bloqueado por regra própria — "só depois de
   reduzir a origem", e a origem (218.750 jobs vazios de webhook, D-179) só
   some com o deploy. Junto com o item 1, é o segundo do P1 travado pelo
   mesmo ato humano.
3. **~~P1 — read models e o resto do item de frontend~~ — FECHADO.** O item
   de frontend saiu em D-193/D-194/D-195/D-197. E **read models virou outra
   coisa em D-204**: investigado, o que havia para consolidar não era custo,
   era **definição**. "Full atual" era reimplementado em cinco funções com
   TRÊS definições diferentes, e as três devolviam o mesmo número — a
   divergência era latente. `get_purchase_suggestions`, que decide quanto
   comprar, usava `max(captured_at)` sem bucket nem janela. As duas
   divergentes adotaram a canônica de D-173; a garantia é **guarda de
   catálogo**, não função compartilhada.

4. **~~P1 — remedir o Realtime~~ — FECHADO, e o resultado corrige o
   enquadramento que eu tinha dado.** D-198 registrou o decodificador de WAL
   em **43,4% do tempo do banco** e eu apresentei isso como o maior consumidor.
   A pergunta que faltava era **"43,4% de quanto?"**: em 86.310 s de relógio o
   banco consumiu **1.234 s de CPU (1,43% de ocupação)**, e o Realtime foram
   **543 s — 0,63% do relógio**. Era 43,4% de um banco **98,6% ocioso**. Os
   dois slots lógicos estão ativos e em dia (224 kB retidos), e o decodificador
   faz polling em intervalo próprio: por isso o custo por chamada caiu só 8,5%
   quando as escritas de métrica foram a zero. **Não há o que otimizar.**
   D-199 continua valendo pelos próprios méritos — 485 mil escritas por dia é
   desperdício em qualquer escala — mas **não pela razão que eu registrei**.

5. **~~P1 — falha "permanente" não é permanente~~ — CORRIGIDO em D-202.**
   Falha definitiva e envelope inválido respondem **200** (só 2xx faz o Cloud
   Tasks descartar); tipo de job desconhecido passa a **503**, porque pode ser
   a janela de um deploy. O número da tentativa passa a vir de
   `X-CloudTasks-TaskRetryCount`. **Sem efeito antes do deploy** — o worker no
   ar é anterior.

6. **~~P1 — o snapshot de visitas leva 429~~ — ITEM DERRUBADO em D-203, e
   quem o escreveu fui eu.** O espaçamento que eu ia propor **já existe e já
   está no ar** (D-156, ancestral do commit em produção). E o dano é quase
   nulo: a cobertura diária é parcial (32% a 75%), mas na semana são 573 de
   3.409 sem visita (17%) e — entre os **1.204 anúncios que venderam** —
   exatamente **1** ficou sem dado. `taxa_conversao` já é `SUM(pedidos nos
   dias com visita observada) / SUM(visitas)`: absorve cobertura parcial por
   construção. Registrado com os números para ninguém re-escalar ao ver "80%
   de falha" em `job_runs`.

7. **Antes da segunda organização** — `get_system_health` tem escopo de
   plataforma com guard de tenant (D-182). Não é urgente hoje e não tem
   correção óbvia: as duas tentativas naturais causam regressão verificada.

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
