# Lições de método

Regras de trabalho extraídas das decisões — o que **não** descreve o estado de
hoje do sistema (isso é `HANDOFF.md`), mas continua valendo para qualquer
fatia futura. Saíram do `## Riscos ativos` do HANDOFF em 03/09/2026, ao
fechar D-232 e D-233 — não por decisão de produto, mas porque a seção tinha
virado arquivo de método, e um HANDOFF que ninguém termina de ler é
exatamente o que o budget de `docs:check` existe para impedir.

Cada linha nasceu de um erro real. A decisão que a gerou está em
`DECISIONS.md` — procure pelo termo no `DECISIONS_INDEX.md`.

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
- **Um guarda pode estar consultando a fonte errada e passar sempre.**
  `information_schema.columns` descreve TABELA e VIEW, nunca FUNÇÃO. Um teste
  de D-176 afirmava "a função não devolve `statements`" sobre uma lista **vazia**
  — verde desde que nasceu, e teria passado igual se a função vazasse o SQL
  inteiro das migrations. Antes de confiar num guarda, pergunte se a consulta
  dele devolve alguma linha **na versão correta** (D-209).
