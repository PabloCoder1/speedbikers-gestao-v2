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
- Um restore de ensaio numa database secundária local parou no `pg_cron`, que
  exige o database configurado em `cron.database_name`. Isso não comprova
  corrupção do dump e também não comprova restore completo. O snapshot está
  disponível; falta concluir o restore completo em instância isolada com a
  configuração das extensões da VM.
- A aplicação por SSH em 18/11 foi relatada pelo executor anterior. O catálogo
  confirma o resultado, mas não registra o canal nem a data por versão. Não é
  aplicação pelo workflow. O workflow oficial ainda aponta ao Supabase hosted
  e exige CI/Dev e duas aprovações; não foi disparado. Reconciliar o destino
  oficial é trabalho de infraestrutura separado. Ver `infra/vm/README.md`.

## Pendências verificáveis

Correção comum publicada no #330 em `27a267be`, incorporada ao #332 por merge,
sem cherry-pick nem repetição dos commits. No #332, a limpeza SQL recebeu a
mesma proteção transacional. Verificação local da combinação: `check`, build,
docs, guardas estáticas; 1.197 testes SQL e quatro cenários Chromium de compras,
pedido já feito e importação. O Playwright usou a porta 60100, pois a 3000
pertencia à worktree do Gemini Sentinel. Nenhum processo alheio foi parado.

- Acompanhar CI dos HEADs publicados, integrar #330 antes de #332 e conferir
  o SHA/alias/runtime da Vercel após cada merge.
- As três planilhas reais não foram encontradas nas pastas locais consultadas
  (Desktop, Documents, Downloads e downloads do Claude). Os casos existentes
  usam fixtures sintéticas com abas, coluna sem referência, `200 + 200`, código
  desconhecido e imagem embutida; não substituem o ensaio dos arquivos reais.
  Nenhuma planilha ou dado de cliente foi versionado nem importado em produção.
