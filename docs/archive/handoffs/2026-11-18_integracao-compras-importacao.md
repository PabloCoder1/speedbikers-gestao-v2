# Integração de compras e importação — 18/11/2026

## Estado recuperado

- #328 integrado em `ec6b5e26`; #330 aberto em `d451cfd9`, com conflitos
  apenas em DECISIONS, índice e PERFORMANCE; #332 aberto em `24c8da20`,
  já contendo #330 e o merge do #328. Nenhum merge de #330/#332 estava feito.
- O checkout antigo `v3` em `9642d921`, com alterações alheias, foi preservado.
  Trabalho em worktrees `codex/integrar-compras-330` e
  `codex/finalizar-pedidos-importacao`.
- Os blocos de decisões e medições dos dois lados foram conservados; o índice
  foi regenerado. As alterações do Sentinel no detalhe do pedido e fornecedor
  foram mantidas no merge.

## CI: evidência e correções

Run original: `44374907367`, SHA `24c8da20`. Integração SQL verde.

- E2E parou antes dos testes: Docker não conseguiu publicar `54322`.
  Os jobs usam VMs hospedadas independentes; não há evidência de colisão entre
  os jobs. O log antigo não identifica o processo dono da porta. A fragilidade
  verificável é depender de um bloco fixo sem verificar sua disponibilidade.
  `scripts/isolate-supabase.mjs` escolhe um bloco livre, usa ID por job/run/
  tentativa e não remove serviços alheios. A CI registra os containers e
  transmite o DB_URL escolhido aos dois caminhos da suíte SQL.
- Build: reproduzido localmente com lockfile intacto, Next 16.4.1. A resposta
  real da Inter continha `/l/font?kit=…&skey=…&v=…`; o parser do Turbopack
  divide a opção nos `&` e acusa `queries have exactly one entry` e módulo
  interno ausente. Mesmo defeito em
  <https://github.com/vercel/next.js/issues/99114>. Mantidas Inter e DM Mono,
  pesos e variáveis CSS; WOFF2 oficiais e licenças versionados, servidos por
  `next/font/local`. Build completo passou após a mudança.
- A execução local expôs outra corrida: as limpezas de compras desligavam
  `trigger user` em autocommit. Um teste de estoque gravou movimentos sem
  atualizar `inventory_balances` (esperava ajuste 0, recebeu 10). A limpeza
  agora mantém os ALTER TABLE e a reativação numa transação, com rollback em
  falha. Com banco recriado, **1.197/1.197 testes SQL passaram**, incluindo
  trânsito único, planejado, duplicidade, recebimento parcial, cancelamento,
  referências/arquivo idempotentes, permissões e outra organização.

## Banco e recuperação

Produção real consultada por IAP/SSH: VM `sb-db`, projeto `speedbikers-prod`,
zona `southamerica-east1-b`, container `supabase-db`, database `postgres`.
Nenhuma migration foi reaplicada nem objeto de produção alterado nesta sessão.

- Catálogo consultado em `BEGIN READ ONLY`: 17 versões posteriores a
  `20261022170000`, até `20261118211000`, correspondentes aos arquivos do Git.
- 53 nomes de função afetados (incluindo suas assinaturas) têm definição
  idêntica ao banco local recriado; dez tabelas de compras/importação coincidem
  em colunas/defaults, constraints, índices e policies/RLS. Há grants adicionais
  de `service_role` na VM, oriundos do padrão de privilégios do ambiente;
  permissões de `anon`/`authenticated` coincidem. Não foram removidos grants.
- Snapshot `sb-db-antes-migrations-nov-20261118`: `READY`, criado em
  18/11 às 18:45 UTC. Dump `manual/antes-migrations-nov-20261118.dump`, bucket
  `speedbikers-prod-db-backups`: **181.558.306 bytes**, atualizado 18:49 UTC.
  Download íntegro pelo gcloud, fora do Git; `pg_restore --list` lê as 2.596
  entradas do arquivo CUSTOM, PostgreSQL 17.6, criado às 18:48:31 UTC.
- **Restore completo confirmado:** container descartável
  `sb-codex-pedidos-restore-20261118`, sem portas publicadas, sem rede e sem
  volumes de produção. `pg_restore --no-owner --exit-on-error` terminou em 0;
  a versão restaurada era `20261022170000`, sem índices inválidos nem itens de
  compra com organização diferente do pedido. Foram ensaiados os 17 SQLs
  versionados, em ordem e com `ON_ERROR_STOP`/transação por arquivo: todos
  passaram. Os 64 objetos comparados com produção ficaram idênticos em
  definição (ACLs/owners de restauração não entram nessa comparação).
  `get_replenishment_overview` respondeu como `authenticated` sobre a cópia
  real, em READ ONLY, com limite de cinco linhas. Container parado e cópia
  conservada fora do Git.
- **Requisitos para repetir o restore:** o dump é de database, não de roles.
  Usar `supabase_admin`, preparar os nomes dos roles referidos nos GRANTs
  (sem copiar senhas), pré-carregar `pg_cron`/`pg_net`/`pg_stat_statements` e
  configurar `cron.database_name` para o database de ensaio. Manter
  `cron.launch_active_jobs=off` e rede desativada. A tentativa inicial numa
  database secundária sem essa configuração falhou em `pg_cron`; a imagem
  crua também não tinha `supabase_functions_admin`. Nenhuma dessas adaptações
  foi feita na VM de produção.
- A aplicação por SSH em 18/11 foi relatada pelo executor anterior. O catálogo
  confirma o resultado, mas não registra o canal nem a data por versão. Não é
  aplicação pelo workflow. O workflow oficial ainda aponta ao Supabase hosted
  e exige CI/Dev e duas aprovações; não foi disparado. Reconciliar o destino
  oficial é trabalho de infraestrutura separado. Ver `infra/vm/README.md`.

## Integridade e workflow

Consultas agregadas em READ ONLY na VM encontraram zero divergências entre
saldo pendente por pedido/SKU e o ledger TRANSITO, e zero referências externas
duplicadas entre pedidos não cancelados. Isso cobre os pedidos existentes;
não foram fabricados casos em produção. Planejado, confirmação, cancelamento,
recebimento parcial e isolamento seguem comprovados pelos testes locais/CI.

MCP em 18/11 confirmou `INACTIVE` nos Supabase hosted Dev e produção.
O run da `main` do #328 (`44371457229`, `ec6b5e26`) tinha os quatro checks
de código verdes e falhava somente em aplicar migrations no Dev; o run
anterior `39819868730` registra `project is paused`. Esse é um problema
anterior à entrega. Não houve desligamento de check, retomada do Dev ou
redirecionamento do workflow para a VM.

## Pendências verificáveis

Correção comum publicada no #330 em `27a267be`, incorporada ao #332 por merge,
sem cherry-pick nem repetição dos commits. No #332, a limpeza SQL recebeu a
mesma proteção transacional. Verificação local da combinação: `check`, build,
docs, guardas estáticas; 1.197 testes SQL e quatro cenários Chromium de compras,
pedido já feito e importação. O Playwright usou a porta 60100, pois a 3000
pertencia à worktree do Gemini Sentinel. Nenhum processo alheio foi parado.

- As três planilhas reais não foram encontradas nas pastas locais consultadas
  (Desktop, Documents, Downloads e downloads do Claude), nem nas buscas por
  nome exato no Drive conectado. Os casos existentes
  usam fixtures sintéticas com abas, coluna sem referência, `200 + 200`, código
  desconhecido e imagem embutida; não substituem o ensaio dos arquivos reais.
  Nenhuma planilha ou dado de cliente foi versionado nem importado em produção.

## Integração e produção conferidas

- O E2E independente do #330 (`44380328519`, `27a267be`) executou 320 casos:
  319 verdes e um erro real de hierarquia de títulos em `/reposicao`
  (`h2` → `h4`). A correção já existia em `24c8da20`, do #332.
- Estratégia equivalente à ordem sequencial: integrar atomicamente o #332,
  que contém todo o #330 e o #328 e já corrige o título. Evitou publicar a
  etapa intermediária defeituosa ou duplicar o commit de correção. A ancestry
  do #330 foi conferida antes do merge. Nenhum teste foi alterado para ignorar
  a falha.
- CI `44381338715`, HEAD **`2da04c9345db353866fe17d1538c1c04ac488239`**:
  check/build/audit, infraestrutura, **1.197 testes SQL e 342 E2E verdes**.
  Merge condicionado ao mesmo HEAD via `--match-head-commit`.
- **#332 mergeado** às 16:47 BRT em
  `c6b4588187fdfb9f90686e51fb1386bceb19cc91`; **#330 marcado MERGED pelo
  GitHub** em seguida, por estar integralmente incluído. Nenhuma branch alheia
  foi apagada nem checkpoint do Sentinel editado.
- Vercel Production **`dpl_CHapXyGvMR73VtV4Gxsq1yMPa5bF`**, commit `c6b45881`,
  estado READY, alias `speedbikers-prod.vercel.app` confirmado. Consulta de
  runtime desse deployment sem registros error/fatal na janela de 15 min.
- Navegador autenticado do dono, somente leitura: `/compras`, `/compras/novo`,
  detalhe de pedido existente, `/compras/importar` e `/reposicao` carregaram.
  Confirmados origem/referência no detalhe, entrada da importação, filtro
  **Compras planejadas**, indicação de que planejado não reduz a necessidade
  e abertura/cancelamento do formulário **Já fiz o pedido**. Nenhum pedido
  foi registrado, recebido ou cancelado pela validação; nenhum arquivo foi
  enviado em produção. Não havia pedidos ORDERED no recorte consultado para
  testar chegada real; esses cenários estão na suíte SQL/E2E isolada.
