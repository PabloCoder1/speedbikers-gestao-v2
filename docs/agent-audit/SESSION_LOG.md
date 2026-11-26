# Registro de sessão

## 11/11/2026 · Primeira execução

- **Base de trabalho.** `codex/sentinel-audit` em worktree isolada, criada de `origin/main` no commit `d6169205ca0ea51d615d2e70cd0b944b5c491adb`. O checkout original está em `v3`, `9642d921`, com trabalho staged e unstaged de Configurações e SAC.
- **Correções concluídas localmente.** Atualização de Next.js, Zod, Hono, adaptador Node e parser XML nos manifests e no lockfile. Diagnóstico do webhook Shopee com metadados permitidos. Server Actions de Sugestões usando tipos do schema. O [handoff](../HANDOFF.md) registra os incidentes operacionais.
- **Validação.** `pnpm run check` passou com 37 tarefas, `pnpm run build` com 10 e `pnpm docs:check` aprovou o contexto. Os dez documentos e 172 links locais foram conferidos. Instalação, lint e Playwright foram serializados após conflitos na resolução de tipos e nos arquivos temporários do navegador. Teste do webhook passou em 11 casos, incluindo reprodução vermelha e verde. Auditoria de produção passou no corte alto e caiu de nove avisos para dois moderados. As sete guardas estáticas da web e os 38 embeds PostgREST passaram. Smoke tests locais confirmaram o adaptador Hono por HTTP e a leitura de XML de NF-e pelo worker.
- **Banco local.** Replay de 305 migrations em stack exclusiva, 1.135 testes de integração aprovados, reset local separado para o seed do Playwright. A stack de teste foi encerrada. [Catálogo local e limites do remoto](DATABASE_MAP.md).
- **Playwright.** 19 casos de Sugestões, Configurações, login, cabeçalhos, navegação e Web Vitals passaram. O spec de Sugestões repetido com o novo caso de envio e triagem passou em três casos, somando 20 casos distintos cobertos.
- **Branches.** 12 remoções verificadas, 123 preservadas e seis em análise por aliases residuais. `main`, `v3` e `v2-legacy` seguem presentes. [Inventário com SHAs](BRANCH_AUDIT.md)
- **Em aberto.** Recuperação de produção, acesso ao Supabase remoto, proteção da `main`, medição em carga representativa, correção transacional de OAuth e recuperação de respostas pendentes no SAC. [Plano](PLAN.md) · [Achados](FINDINGS.md) · [Candidatos](CLEANUP_CANDIDATES.md)
- **Próxima ação.** Após a reativação pelo responsável, repetir `GET /health` da API, confirmar Scheduler e Tasks e consultar a atividade recente em `job_runs` de produção. A05 pode avançar no Supabase local com um teste que sincronize dois callbacks até a etapa de gravação da mesma loja.

### Skills

| Recurso | Revisão e uso |
|---|---|
| `systematic-debugging`, `verification-before-completion` | Instaladas no perfil Codex a partir de [Superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2), commit `22f0b463e7a5e579904dd6211a520321035526f7`. Depuração por reprodução e verificação com teste |
| `security-review` | Instalada no perfil Codex de [Sentry Skills](https://github.com/getsentry/skills/tree/e94f22214528d69899d09c627b3315ddc3544816/skills/security-review), commit `e94f22214528d69899d09c627b3315ddc3544816`. Rastreio de entradas públicas e dados que chegam ao log |
| `openai-docs`, `skill-installer`, `skill-creator` | Disponíveis no host. Catálogo OpenAI examinado em `49f948faa9258a0c61caceaf225e179651397431`. Instalador local usado com referências fixas, sem executar scripts dos pacotes instalados. As skills instaladas passam a ser descobertas em novos turnos. [Catálogo OpenAI](https://github.com/openai/skills) · [Formato oficial](https://learn.chatgpt.com/docs/build-skills) |
| `supabase`, `supabase-postgres-best-practices` | Já instaladas. Orientaram inspeção de RLS, permissões, catálogo e migrations. [Supabase Database](https://supabase.com/docs/guides/database/overview) · [Changelog](https://supabase.com/changelog.md) |
| `vercel:react-best-practices` | Já disponível no host. A fonte oficial foi conferida em `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`. [Vercel Agent Skills](https://github.com/vercel-labs/agent-skills) |

O mapa, o plano e o registro dão continuidade a esta auditoria. Skills locais serão consideradas se surgir uma rotina que exija instruções reaproveitáveis além dessas fontes.

## 12/11/2026 · Continuidade no ambiente local

- **Base.** `codex/sentinel-audit` partiu de `3dce1b19`. A worktree original da `v3` segue fora da intervenção.
- **Concluído.** D-657 protege a titularidade e torna atômica a gravação de lojas e credenciais. D-658 retoma o enfileiramento de tentativas novas com a mesma confirmação e autoriza um POST por tentativa. D-659 impede que refresh antigo sobrescreva a reconexão Shopee. Regras de toast respeitam a loja Shopee. Saíram três rotinas sem consumidores e dois registros órfãos de worktree.
- **Validação.** Replay de 308 migrations, 1.148 testes de integração, 33 casos Playwright selecionados, 38 embeds, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. As regressões do OAuth incluem concorrência PostgreSQL, rollback, renovação Shopee e permissões. O SAC foi testado com fila e HTTP simulados, além da disputa da trava em duas conexões PostgreSQL. O navegador percorreu Atendimento, Notificações, Fornecedores e Pedido de Compra. A stack isolada foi encerrada.
- **Medição e inventário.** Os callbacks passaram a gravar o lote em uma ida ao PostgREST. O ensaio de Auth registrou dois GETs por render completo em três rotas com serviço simulado. A comparação de índices locais encontrou zero pares de definição equivalente. Permanecem seis branches em análise por aliases e 31 registros locais de worktree.
- **Publicação.** Migrations OAuth, SAC e renovação Shopee antes dos deploys correspondentes, C-82 antes da web e drenagem dos envios legados do SAC. A retomada automática do SAC cobre o mesmo ID antes do início do envio. Legado e desfecho incerto ficam para conciliação. A indisponibilidade de produção permanece registrada em [Handoff](../HANDOFF.md).
- **Próxima ação executável.** A15. Escrever regressões em `ml-token.test.ts` para sucesso e recusa de um refresh anterior à reconexão. No caminho atual, a gravação da API em `ml-accounts.ts` preserva a trava anterior. A sequência equivalente em PostgreSQL sobrescreveu o par novo. [Achados](FINDINGS.md) · [Plano](PLAN.md)

### 12/11/2026 · Reconexão e renovação do Mercado Livre

- **Base.** `codex/sentinel-audit` em `a2032eb7` ao iniciar A15.
- **Concluído.** D-660 confirma organização e vendedor ao persistir a conexão. A API invalida a trava no mesmo commit de banco que grava o par e o estado CONNECTED. O worker usa UUID por aquisição para gravar, soltar ou registrar uma recusa definitiva.
- **Verificação.** Passaram `pnpm run check`, `pnpm run build`, `pnpm docs:check`, o replay das 309 migrations, 1.151 testes de integração e 38 embeds. Duas conexões PostgreSQL confirmaram o bloqueio da recusa concorrente. Foram validados o descarte do resultado anterior mesmo com prazo idêntico, a recusa vigente, o rollback, os escopos e as permissões.
- **Publicação.** Aplicar a migration `20261112122618` antes de atualizar API e worker. Coordenar o corte das revisões e drenar as renovações antigas antes de liberar novas reconexões. [D-660](../DECISIONS.md#d-660---reconexão-mercado-livre-invalida-a-renovação-anterior)

### 12/11/2026 · Identidade da trava Shopee

- **Base.** `codex/sentinel-audit` em `2948800b` ao iniciar A16.
- **Concluído.** Reproduzido em PostgreSQL que duas aquisições com o mesmo prazo aceitavam escrita e recusa antigas. D-661 dá um UUID a cada aquisição, usa o UUID na finalização e limpa prazo e UUID na reconexão. O contrato legado por prazo atende linhas sem UUID.
- **Validação.** Replay das 310 migrations, 1.151 testes de integração, 38 embeds, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A regressão cobre prazo igual, preservação do par e do estado, recusa atual e permissões das duas sobrecargas.
- **Publicação.** Aplicar a migration `20261112124430` antes do worker. Encerrar renovações da revisão anterior antes de liberar reconexões no corte.

### 12/11/2026 · Recusa tardia no OAuth Mercado Livre

- **Base.** `codex/sentinel-audit` em `7b038b66` ao iniciar A17.
- **Concluído.** Uma troca de token atrasada com `invalid_grant` rebaixava a conta conectada por outro callback. D-662 condiciona a gravação de erro à organização do state e ao status vigente da conta.
- **Validação.** O ensaio com dois states e PostgREST local reproduziu o erro antes da mudança. Depois, preservou CONNECTED e `last_error`, registrou a primeira recusa em conta pendente e confirmou o consumo único do state. A regressão unitária verifica os filtros da atualização. Passaram `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A stack isolada foi encerrada.
- **Publicação.** A correção segue no deploy da API. A migration de D-660 continua sendo pré-requisito para publicar o conjunto Sentinel.
- **Próxima etapa.** Verificar a retomada da mesma tentativa pendente do SAC após recarregar o formulário. O componente mantém o `clientRequestId` apenas em memória. [Plano](PLAN.md)

### 12/11/2026 · Segunda revisão das branches e cobertura

- **Base.** `codex/sentinel-audit` em `1902e198` e `main` remota em `d6169205`.
- **Branches.** Revalidadas as 12 exclusões antigas. Excluídas 106 refs integradas com lease por SHA e push atômico. Leitura independente confirmou 23 refs restantes, com `main`, `v3` e `v2-legacy`. Os sete destinos dos aliases residuais retornaram 404. A `v3` segue com worktree, PR #76, proteção, preview e política do ambiente. [Inventário](BRANCH_AUDIT.md)
- **Cobertura e limpeza.** O plano reúne os 17 achados existentes, estados, critérios de prioridade e dependências. O mapa registra as lacunas por área. Três referências de branches integradas nos handoffs passam a apontar aos PRs. O README de infraestrutura agora aponta à `main` para migrations. A triagem de funções exportadas reencontrou a candidata `retargetLink`. [Plano](PLAN.md) · [Mapa](PROJECT_MAP.md) · [Limpeza](CLEANUP_CANDIDATES.md)

### 12/11/2026 · Retomada do formulário do SAC

- **Concluído.** D-663 recupera a confirmação pendente do autor em Perguntas e no detalhe. O mesmo ID, texto final e sugestão persistida são enviados na retomada manual. O seed de atendimento agora restaura também o responsável do caso antes de repetir os testes.
- **Validação.** O Playwright reproduziu o campo vazio depois de falha simulada da fila e recarga. Depois, confirmou o mesmo payload nas duas telas, com sessão e Supabase locais. Passaram 14 casos de Atendimento, os seis casos da seleção de retomada, `pnpm run check`, `pnpm run build`, `pnpm docs:check` e a guarda local de migrations. Capturas inspecionadas em desktop e celular.
- **Próxima ação.** Reduzir a leitura de mensagens em Perguntas. O ensaio PostgREST encontrou 1.000 eventos anteriores ao inbound e reproduziu a perda do texto. A consulta com embed limitado à primeira mensagem recebida retornou a pergunta e preservou casos sem mensagem.

### 12/11/2026 · Primeira mensagem por cartão em Perguntas

- **Concluído.** D-664 inclui a primeira mensagem recebida na consulta dos casos, com ordenação por data e ID. Saiu a chamada adicional para ler e agrupar todos os transcripts na web. [Medição](../PERFORMANCE.md#mensagens-transferidas-na-lista-de-perguntas-sentinel-a19-12112026)
- **Validação.** A regressão com mil eventos anteriores à pergunta falhou antes da mudança e passou depois. Passaram 15 casos Playwright de Atendimento, 39 projeções com embed, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A limpeza dos eventos sintéticos e o encerramento da stack local foram conferidos.
- **Retomada.** Paginar a conversa no detalhe do atendimento e exercitar mais de 1.000 mensagens. Consultar [Handoff](../HANDOFF.md), [Plano](PLAN.md), [Mapa](PROJECT_MAP.md) e [Medição](../PERFORMANCE.md#mensagens-transferidas-na-lista-de-perguntas-sentinel-a19-12112026). Permanecem seis achados dependentes de ação ou verificação externa. A publicação do conjunto segue a ordem registrada no plano.

### 12/11/2026 · Conversa paginada no detalhe do SAC

- **Concluído.** D-665 abre nas 50 mensagens mais recentes e navega nas duas direções por data e ID. A consulta carrega uma linha extra para decidir se há outra página.
- **Validação.** O Playwright reproduziu a omissão da última mensagem em uma conversa sintética com 1.050 linhas. A correção passou com horários iguais, chegada concorrente, retorno à fila preservado e tentativa de acesso de um gestor sem permissão. Foram 16 testes Playwright de Atendimento, sete testes de cursor, 39 embeds, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. Conferidas capturas desktop e celular.
- **Próxima etapa.** Exercitar as consultas de saúde de `/sincronizacao` com dados locais por conta e papel. [Plano](PLAN.md) · [Medição da conversa](../PERFORMANCE.md#tamanho-da-leitura-da-conversa-no-sac-sentinel-a20-12112026)

### 12/11/2026 · Escopo e medição da telemetria

- **Concluído.** D-666 corrige a classificação de jobs sem organização no catálogo. A migration `20261112181422` reserva a telemetria de plataforma ao tipo e UUID do heartbeat. A prova anterior à correção fez as duas RPCs exibirem um job de uma organização sintética excluída. `get_job_failures` também exibiu seu motivo.
- **Validação.** O replay aplicou 311 migrations. Passaram 1.153 testes de integração, incluindo última execução, contagens e motivos, e 39 embeds. Passaram `pnpm run check`, `pnpm run build` e `pnpm docs:check`. As transações de prova e medição foram revertidas e a stack local foi encerrada.
- **Medição e retomada.** `get_sync_health` foi a RPC mais custosa no cenário sintético, com mediana de 65,46 ms para ADMIN. Comparar a leitura compartilhada de `sync_runs` e validar equivalência sob RLS. Consultar [Handoff](../HANDOFF.md), [Plano](PLAN.md), [Banco](DATABASE_MAP.md) e [Medição](../PERFORMANCE.md#rpcs-de-saúde-da-sincronização-12112026).

### 12/11/2026 · Agregação de indicadores de Sincronização

- **Concluído.** D-667 concentra os indicadores de `get_sync_health` numa agregação e busca status e motivo da última execução pelo índice existente. Empates no horário usam o maior ID. A migration é `20261112182921`.
- **Medição.** Em 40 mil linhas sintéticas, ADMIN passou de 68,82 ms para 16,39 ms e de 2.938 para 1.061 blocos compartilhados. `EXCEPT ALL` conferiu a equivalência em três volumes para ADMIN, GESTOR e organização alheia. [Comparação](../PERFORMANCE.md#uma-agregação-em-get_sync_health-sentinel-a22-12112026)
- **Validação.** Replay de 312 migrations, 1.154 testes de integração, 39 embeds, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. O catálogo confirmou execução por `authenticated`, recusa de `anon` e `security invoker`.
- **Próxima etapa.** Isolar a leitura Shopee de `get_stock_coverage_summary` e medir com o mesmo recorte de dias de São Paulo. [Plano](PLAN.md)

### 12/11/2026 · Recorte de pedidos da Shopee no resumo de cobertura

- **Concluído.** D-668 converte os dois limites do período em horários de São Paulo e usa o índice existente de pedidos. A migration é `20261112184110`.
- **Medição.** Com 60 mil pedidos sintéticos e janela de 30 dias, a mediana caiu de 38,14 ms para 13,10 ms para ADMIN e de 24,28 ms para 8,83 ms para GESTOR. A comparação das duas consultas deu zero diferenças sob RLS. [Medição](../PERFORMANCE.md#janela-shopee-no-resumo-de-cobertura-sentinel-a23-12112026)
- **Validação.** Replay de 313 migrations, 1.156 testes de integração e 39 embeds. Passaram `pnpm run check`, `pnpm run build` e `pnpm docs:check`. O catálogo confirmou `security invoker` e execução por `authenticated`. Os limites do dia passaram nas versões anterior e atual, inclusive na transição para o horário de verão. Conferidos o rollback dos ensaios e o encerramento da stack local.
- **Próxima etapa.** Identificar e medir as variantes de `get_faturamento` usadas pela web.

### 12/11/2026 · Análise dos call sites de `get_faturamento`

- **Levantamento.** Seis chamadas em quatro páginas: Central (2: período atual com `p_detalhe: true`, anterior com `false`), Ads (1: `p_detalhe: false`, sem conta), Faturamento (2: atual sem `p_detalhe` explícito = `true`, anterior com `false`) e Multicanal (1: fallback com `p_detalhe: false`). Em todas, `p_ml_account_id` é `null` ou selecionado pelo usuário.
- **RPC.** A definição em `20261019210000_faturamento_ml_pelas_linhas.sql` usa 13 CTEs sobre `ml_sales_lines` (D-499), `work_mem = '32MB'` e `force_custom_plan`. Com `p_detalhe = false`, `diario`, `por_conta` e `por_sku_base` retornam vazio/null.
- **Medição existente.** D-499 em [PERFORMANCE.md](../PERFORMANCE.md) registra: 90 dias com detalhe = 8.500 páginas (antes 395 mil), 2,1 s quente (antes 2,5 s), 3,2 s frio (antes 5,1 s). O comentário na Central indica ~0,5 s sem detalhe e ~0,6 s com.
- **Conclusão.** O gargalo restante é CPU (custo, agrupamento, 36 agregações). A próxima otimização prevista é pré-agregação diária — uma mudança estrutural que requer decisão do responsável. A tarefa de medição do faturamento está substantivamente concluída; não há ganho incremental sem redesenho.
- **Worktrees.** Três registros órfãos removidos (`wt-devolucao`, `wt-guardas`, `wt-marca`) — diretórios apagados pela limpeza do Temp do Windows. Branches intactos. Restam 29 registros.
- **Próxima etapa.** Varredura de código morto em `apps/web` e `packages/` para identificar exports e componentes sem consumidor.

### 12/11/2026 · Varredura de código morto em `apps/web/lib/`

- **Método.** Extração estática de 703 exports não-tipo de `lib/`, conferidos por grep com fronteira de palavra em todo o monorepo. Dois filtros: (1) sem referência em nenhum arquivo fora do próprio módulo; (2) dentre esses, sem uso sequer dentro do módulo (apenas a definição).
- **Resultados.** 76 exports sem consumidor fora do módulo de definição. Desses, 5 pareciam nunca usados; 2 são falsos positivos (`gerarNonce`, `montarCsp` — usados em `proxy.ts`, fora de `lib/`). Os 3 confirmados:
  - `buildManualLinkHref` em `lib/link-integrity-filters.ts` (D-374) — monta URL para vinculação manual; testado mas não importado pela página.
  - `valorDaOrdem` em `lib/ranking-produtos.ts` — formata valor por coluna do ranking; testado mas não importado por `/central/produtos`.
  - `sobMarca` em `lib/vendas-multicanal.ts` (C-72, D-237) — guarda de filtro de marca; testado mas não importado por nenhuma tela.
- **71 exports internos.** Usados dentro do próprio módulo por outras funções exportadas e consumidas. A palavra-chave `export` é desnecessária — poderiam ser módulo-privados.
- **Classificação.** Os 3 órfãos são helpers bem documentados e testados, provavelmente aguardando conexão na UI ou desconectados por refatoração. Não é remoção segura sem decisão do responsável — registrar em FINDINGS como A24.

### 12/11/2026 · Varredura de código morto em `packages/`

- **Método.** `grep` cruzando declarações (`export function|const`) em `packages/*/src/` contra referências em `apps/` e `packages/*/src/` fora do pacote de origem, excluindo testes, `.d.ts` e `dist/`. Rastreio em três camadas: (1) referência direta em apps, (2) referência em outros pacotes, (3) consumo interno por funções que passam nos critérios 1 ou 2.
- **Resultado — funções.** 34 funções exportadas sem import direto em apps/ ou outros pacotes. Rastreio completo de cadeias internas confirmou **todas vivas**: inventory (12) → `computeSaleDeductions`/`computeCancellationMovements` → `persist-order.ts`/`claim-return.ts`; documentos (5) → `documentoDaNfe`/`lerDocumentoPdf` → `nfe-import-parse.ts`; mercado-livre/retry (3) → `http-client.ts` (81 consumidores); mercado-livre/messages (3) → barrel sem consumidor direto, mas usadas internamente; observability/`redact` → logger (102 consumidores); upseller (5) → `rows.ts` → `erp-import-parse.ts`; listings (2) → `relist-execute.ts`; purchasing (2) → `composeSkuReplenishment` → copilot + web/reposição; shopee/`toShopeeAdsDate` → `ads.ts` interno.
- **Resultado — constantes.** ~77 constantes/schemas sem referência fora do pacote. Todas consumidas internamente: schemas por funções de parse, constantes de página por funções de listagem, hosts por clientes HTTP.
- **Resultado — `apps/web` componentes/hooks.** Varredura de `components/`, `hooks/` e `lib/` por exports com zero consumidores em `apps/web/`: nenhum achado adicional além dos 3 de A24.
- **Conclusão.** Não há código morto para apagar em packages/. A oportunidade é P3: remover `export` e a re-exportação no barrel de funções que são detalhe interno (34 funções, ~77 constantes). Tree-shaking já elimina o código não alcançável. Registrado como A25.
- **Próxima etapa.** Verificar o build da worktree e decidir próxima tarefa do plano. [Candidatos](CLEANUP_CANDIDATES.md) · [Plano](PLAN.md)

### 12/11/2026 · Remoção de `buildManualLinkHref` (A24 parcial)

- Função desconectada desde D-374: sem consumidor em nenhuma página, apenas no teste próprio.
- Removida a definição em `link-integrity-filters.ts` e o bloco `describe("href da vinculação manual")` com 3 `it()` no teste.
- Build, typecheck e 1452 testes passaram. Commit `3855cdd7`.
- `valorDaOrdem` e `sobMarca` preservadas — possivelmente aguardando conexão na UI; decisão do responsável.
- Push: 3 commits (A25 docs, HANDOFF, remoção A24) enviados ao remote.

### 13/11/2026 · Fechamento de A24 e medição de faturamento

- **A24.** Confirmada a retirada anterior de `buildManualLinkHref` em `3855cdd7`. A busca de referências e a leitura das páginas mostraram que `valorDaOrdem` e `sobMarca` também eram chamados apenas nos testes próprios. Foram removidos os dois helpers e suas asserções exclusivas. A formatação de variação e o recorte de marca continuam cobertos.
- **Faturamento.** O inventário de chamadas do checkpoint anterior serviu de base para o ensaio local sob RLS. Com 60 mil pedidos sintéticos, as 12 combinações de papel, conta e janela produziram o mesmo resumo com ou sem detalhe. Para ADMIN em 90 dias com todas as contas, foram 338,7 ms sem detalhe e 419,4 ms com detalhe. [Medição](../PERFORMANCE.md#faturamento-do-ml-com-e-sem-detalhe-sob-rls-sentinel-13112026)
- **Validação.** 47 testes dos três módulos auditados, 1.451 testes da web no `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A stack local aplicou 313 migrations e foi encerrada após a confirmação do rollback dos fixtures.
- **Próxima etapa.** Isolar o custo do agrupamento e da classificação dos pedidos de `get_faturamento`, preservando regras de custo e escopo por conta. [Plano](PLAN.md)

### 13/11/2026 · Contagem de compras no faturamento

- **D-669.** A migration `20261113131644` conta pacotes e pedidos avulsos separadamente pelos IDs numéricos. A comparação com 60 mil pedidos encontrou o mesmo JSON em 36 combinações sob RLS. Em 90 dias para ADMIN, a mediana caiu de 314,32 para 271,82 ms sem detalhe e de 365,60 para 326,82 ms com detalhe. [Medição](../PERFORMANCE.md#contagem-de-compras-no-faturamento-do-ml-sentinel-a26-13112026)
- **Validação.** A regressão de colisão de IDs passou antes e depois da migration. O replay aplicou 314 migrations. Passaram 1.157 testes de integração, 39 projeções com embed, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A stack local foi encerrada após a confirmação do rollback dos dados de ensaio.
- **Próxima etapa.** Medir as chamadas reais de faturamento por carga da Central. O código atual compartilha a leitura do período entre alertas, indicadores e o bloco por marketplace. [Plano](PLAN.md)

### 13/11/2026 · Chamadas de faturamento da Central

- **Medição.** 13 cargas autenticadas em Chromium com PostgREST local. Cada carga fez duas chamadas de faturamento e duas de Ads do ML, uma por período. O recorte consolidado acrescentou uma leitura de faturamento da Shopee. Com conta permitida, as duas consultas de faturamento receberam o UUID selecionado. [Medição](../PERFORMANCE.md#chamadas-de-faturamento-por-carga-da-central-sentinel-13112026)
- **Validação.** Passaram dois casos Playwright da Central, `pnpm run check`, `pnpm run build` e `pnpm docs:check`. A primeira rodada mostrou que o GESTOR do seed não tinha concessão da conta na URL. A medição final incluiu esse recorte e o cenário com a concessão, removida após o ensaio. A stack local foi encerrada.
- **Próxima etapa.** Medir a espera pela lista de contas e pela contagem de lojas Shopee antes de iniciar as RPCs em `/faturamento`. A publicação, a proteção da `main`, a verificação de infraestrutura e as medições em produção continuam no plano. [Plano](PLAN.md)

### 13/11/2026 · Início das consultas de Faturamento

- **D-670.** As duas consultas de faturamento e a de Ads começam em paralelo. No consolidado, partem enquanto as contas e lojas são lidas. Com slug na URL, aguardam a lista de contas visíveis. A contagem de lojas segue para o seletor de marketplace.
- **Validação.** Chromium e PostgREST local compararam cinco cargas medidas por versão e recorte com atraso controlado. A mediana até a primeira RPC caiu de 367 para 2 ms no consolidado e de 372 para 169 ms com conta. Passaram dez casos Playwright, 1.451 testes web no `pnpm run check`, `check:waterfalls`, `pnpm run build` e `pnpm docs:check`. [Medição](../PERFORMANCE.md#início-das-consultas-do-período-em-faturamento-sentinel-a27-13112026)
- **Próxima etapa.** Medir o que os recortes Shopee e Todos precisam esperar antes de iniciar as leituras. [Plano](PLAN.md)

### 13/11/2026 · Consultas do Faturamento multicanal

- **D-671.** Todos e Shopee sem filtro iniciam as leituras após resolver a organização. Com filtro explícito, Shopee aguarda a lista de lojas visíveis. A mediana até a primeira RPC caiu de 367 para 151 ms em Todos e de 372 para 150 ms na Shopee sem filtro no ensaio controlado. Quantidade e argumentos das chamadas conferidos nos quatro recortes. [Medição](../PERFORMANCE.md#início-das-consultas-de-faturamento-nos-recortes-shopee-e-todos-sentinel-a28-13112026)
- **Validação.** Passaram 19 testes Playwright de Faturamento e Central, `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir se a lista de contas e os filtros salvos atrasam o início das consultas em Vendas multicanal. [Plano](PLAN.md)

### 13/11/2026 · Vendas multicanal e revisão de branches

- **Base.** `codex/sentinel-audit` em `f719eed8`, depois de `a3be2512` e `f2bae07d`. Checkout original em `v3`, `9642d921`.
- **D-672.** `apps/web/app/(app)/vendas/multicanal.tsx` inicia as RPCs sem aguardar os filtros salvos. A lista é aguardada antes das RPCs só com conta explícita. O ensaio em cinco recortes confirmou os mesmos argumentos e antecipou a mediana de Todos de 467 para 149 ms. [Medição](../PERFORMANCE.md#início-das-consultas-de-vendas-multicanal-sentinel-a29-13112026)
- **Validação.** Passaram 14 testes Playwright de Vendas, 1.451 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Limpeza.** Rechecadas 24 branches e 13 PRs abertos. Sete refs integradas continuam vinculadas a worktrees existentes. [Inventário](BRANCH_AUDIT.md#inventário-por-branch)
- **Próxima etapa.** Comparar no PostgREST a página vazia que encerra a série diária com uma leitura que informe a contagem exata. Produção e publicação continuam pendentes. [Plano](PLAN.md)

### 13/11/2026 · Fim da paginação nas séries de Vendas

- **Base.** `codex/sentinel-audit` em `4a7c450c`, que antecipa as consultas de Vendas multicanal.
- **D-673.** `serie-de-vendas.ts` pede contagem exata na primeira página para janelas de até 90 dias. `rpc-pages.ts` encerra a leitura quando essa página contém o total. A resposta parcial continua sendo paginada. No PostgREST local, as séries de 7 a 90 dias passaram de duas chamadas para uma. [Medição](../PERFORMANCE.md#fim-da-paginação-nas-séries-de-vendas-sentinel-a30-13112026)
- **Validação.** Passaram seis testes do paginador, 1.453 testes web no `pnpm run check`, `pnpm run build`, `pnpm docs:check` e três casos Playwright de gráfico e CSV depois de D-673.
- **Próxima etapa.** Medir o início das consultas do recorte Mercado Livre em `/vendas` com e sem conta, sob atraso controlado nas leituras do cabeçalho. A validação em produção depende da publicação e da disponibilidade do ambiente. [Plano](PLAN.md)

### 13/11/2026 · Consultas de Vendas no Mercado Livre

- **Base.** `codex/sentinel-audit` em `304b015b`. Checkout original em `v3`, `9642d921`.
- **D-674.** `apps/web/app/(app)/vendas/page.tsx` inicia as RPCs de vendas assim que a conta é resolvida. A consulta de marcas espera a organização. No ensaio controlado, a mediana até a primeira RPC de vendas passou de 468 para 1 ms sem slug e de 464 para 277 ms com conta permitida. A quantidade de chamadas e os argumentos coincidiram nos quatro recortes. [Medição](../PERFORMANCE.md#início-das-consultas-de-vendas-do-mercado-livre-sentinel-a31-13112026)
- **Validação.** Passaram 14 casos Playwright de Vendas, 1.453 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir quais leituras do cabeçalho de `/anuncios` atrasam as RPCs de lista e contadores. Publicação e validação em produção continuam pendentes. [Plano](PLAN.md)

### 13/11/2026 · Lista e contadores de Anúncios do ML

- **Base.** `codex/sentinel-audit` em `41526ca2`. Checkout original em `v3`, `9642d921`.
- **D-675.** `apps/web/app/(app)/anuncios/page.tsx` inicia lista e contadores após resolver organização e conta solicitada. No ensaio controlado, a mediana até a primeira RPC caiu de 467 para 151 ms sem conta e de 470 para 283 ms com conta. Os argumentos coincidiram em quatro recortes. [Medição](../PERFORMANCE.md#início-das-consultas-de-anúncios-do-mercado-livre-sentinel-a32-13112026)
- **Validação.** Passaram 19 casos Playwright de Anúncios, 1.453 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir as dependências de lista e resumo em `/anuncios/shopee`. A publicação e a validação em produção seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Lista e resumo de Anúncios da Shopee

- **Base.** `codex/sentinel-audit` em `98ac2815`, com D-675 concluída no recorte ML.
- **D-676.** `apps/web/app/(app)/anuncios/shopee/page.tsx` inicia as duas RPCs após organização e lojas visíveis. Com atrasos controlados, a primeira saiu em 272 ms contra 473 ms antes, na mediana de todas as lojas. Argumentos conferidos nos quatro recortes. [Medição](../PERFORMANCE.md#início-das-consultas-de-anúncios-da-shopee-sentinel-a33-13112026)
- **Validação.** Passaram 19 casos Playwright de Anúncios, 1.453 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`. O ensaio como GESTOR sem concessão exibiu o aviso e fez zero RPCs de catálogo.
- **Próxima etapa.** Medir em `/vendas/shopee` o início das consultas de vendas, pedidos e devoluções. A publicação, a proteção da `main` e a verificação com carga real seguem no plano. [Plano](PLAN.md)

### 13/11/2026 · Consultas de Vendas da Shopee

- **Base.** `codex/sentinel-audit` em `894ffc13`, com D-676 concluída em Anúncios. Checkout original em `v3`, `9642d921`.
- **D-677.** `apps/web/app/(app)/vendas/shopee/page.tsx` inicia vendas, pedidos e devoluções após resolver organização e lojas. No ensaio controlado, a primeira RPC saiu em 279 ms contra 471 ms antes, na mediana de todas as lojas. Argumentos conferidos nos quatro recortes. [Medição](../PERFORMANCE.md#início-das-consultas-de-vendas-da-shopee-sentinel-a34-13112026)
- **Validação.** Passaram dez casos Playwright de Vendas da Shopee, 1.453 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`. O GESTOR sem concessão recebeu o aviso e fez zero RPCs de vendas, pedidos e devoluções.
- **Próxima etapa.** Medir dependências das consultas da Curva ABC e preservar o recorte usado pela tela e pelo XLSX. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Consultas da Curva ABC

- **Base.** `codex/sentinel-audit` em `eeb0ac9f`, com D-677 concluída em Vendas da Shopee. Checkout original em `v3`, `9642d921`.
- **D-678.** A Curva ABC inicia as consultas de marca e categoria após resolver a organização. A curva espera pela lista de contas quando a URL pede uma seleção. No ensaio local, a mediana até iniciar a análise do ML caiu de 469 para 145 ms no consolidado. Sete recortes mantiveram os argumentos das três RPCs e os filtros compartilhados com o XLSX. [Medição](../PERFORMANCE.md#início-das-consultas-da-curva-abc-sentinel-a35-13112026)
- **Validação.** Passaram cinco casos Playwright da Curva ABC, 1.453 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** A próxima fatia vai reproduzir o limite de 1.000 regras em `/reposicao` e `/reposicao/configuracoes` e conferir a escolha de regra específica por SKU. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Regras de reposição acima do limite do PostgREST

- **Base.** `codex/sentinel-audit` em `3ad2f5e9`. Checkout original em `v3`, `9642d921`.
- **D-679.** Reposição e Configuração leem as regras por cursor na organização da sessão. No ensaio local, duas chamadas recuperaram 1.003 regras em cada rota. A linha do SKU passou a exibir a janela de 101 dias e a configuração passou a mostrar 1.002 exceções. A regra de outra organização ficou fora. [Medição](../PERFORMANCE.md#leitura-das-regras-de-reposição-sentinel-a36-13112026)
- **Validação.** Passaram sete casos Playwright, 1.455 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Reproduzir o truncamento na inspeção de Produtos e medir uma leitura restrita às regras aplicáveis ao SKU. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Regras da Inspeção Rápida de Produtos

- **Base.** `codex/sentinel-audit` em `3e5632c0`. Checkout original em `v3`, `9642d921`.
- **D-680.** A gaveta filtra por organização e carrega até três regras de reposição. O alvo do SKU de prova passou de 25 para 66 dias. As leituras caíram de 1.000 para três linhas em uma chamada. O ensaio conferiu a regra de marca com pontuação, o padrão, a ausência de política e o isolamento entre organizações. [Medição](../PERFORMANCE.md#regras-da-inspeção-de-produtos-sentinel-a37-13112026)
- **Validação.** Passaram seis casos Playwright de Produtos após reiniciar a stack e aplicar o seed padrão. A primeira rodada compartilhou os dados sintéticos do ensaio com a suíte e deixou o SKU principal marcado como virtual após uma asserção falhar. Uma falha no interceptador de navegação também desapareceu na rodada limpa. Passaram `pnpm run check` com 1.456 testes web, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir as dependências entre a visão e os painéis de Vinculações. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Visão e painéis de Vinculações

- **Base.** `codex/sentinel-audit` em `4aa227f7`. Checkout original em `v3`, `9642d921`.
- **D-681.** Visão, candidatos e vínculos manuais começam após a organização e o slug quando informado. No ensaio controlado, o bloco de todas as contas caiu de 954 para 611 ms. Quatro recortes mantiveram os argumentos. A falha simulada preservou a tabela alternativa, com duas consultas de painéis descartadas. [Medição](../PERFORMANCE.md#consultas-dos-painéis-de-vinculações-sentinel-a38-13112026)
- **Validação.** Passaram sete casos Playwright de Vinculações, 1.456 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir a dependência da lista de contas em Preços e no XLSX. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Histórico de Preços e XLSX

- **Base.** `codex/sentinel-audit` em `d1ddf667`. Checkout original em `v3`, `9642d921`.
- **D-682.** Em Preços, a consulta do consolidado começa após a organização. O XLSX sem conta na URL faz zero leituras da lista. O ensaio preservou os argumentos em quatro recortes. [Medição](../PERFORMANCE.md#consultas-do-histórico-de-preços-e-do-xlsx-sentinel-a39-13112026)
- **Validação.** Passaram quatro casos Playwright de Preços, 1.456 testes web no `pnpm run check`, `pnpm run build` e `pnpm docs:check`.
- **Próxima etapa.** Medir a dependência da lista de contas em `/full` e conferir o CSV e a assinatura alternativa da RPC. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Consulta da Central Full

- **Base.** `codex/sentinel-audit` em `509cdf84`, após a etapa de Preços.
- **D-683.** Full inicia a RPC do consolidado quando a organização responde. No ensaio, o início passou de 273 para 179 ms. Quatro recortes preservaram os argumentos, os CSVs responderam com o mesmo filtro da tela e a assinatura antiga funcionou com falha simulada. [Medição](../PERFORMANCE.md#consultas-da-central-full-sentinel-a40-13112026)
- **Validação.** Passaram seis casos Playwright de Full, 1.456 testes web no `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir em Perguntas do SAC se a lista e os contadores podem começar antes da lista de contas no consolidado. Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Perguntas do SAC — antecipação de consultas

- **Base.** `codex/sentinel-audit` em `06a63778`, após a etapa de Full.
- **D-684 (A41).** Em `/atendimento/perguntas`, três otimizações: (1) a lista de contas inicia sem `await` — quando não há filtro por conta (recorte "Todas as contas"), a consulta principal e os contadores por aba iniciam em paralelo com as contas em vez de depois delas; (2) `reply_templates` e `auth.getUser()` iniciam no topo da aba Pendente em vez de depois do resultado das perguntas; (3) `support_reply_attempts` continua sequencial porque depende do id da pergunta selecionada.
- **Verificação das outras telas.** A Caixa de Entrada (`/atendimento/page.tsx`) já usa um único `Promise.all` para contas, auth e métricas na linha 194. O Detalhe (`/atendimento/[caseId]/page.tsx`) faz o mesmo na linha 184 com seis leituras. Nenhuma antecipação adicional é possível.
- **Validação.** `pnpm run check` (37 tarefas, 1.456 + 1.015 testes) e `pnpm run build` passaram sem erros.
- **Próxima etapa.** Limpeza P3 de exports internos, publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Limpeza P3 — exports internos desnecessários (A25)

- **Base.** `codex/sentinel-audit` em `d10d1ad4`, após a etapa de Perguntas do SAC.
- **Varredura.** Script em ESM encontrou 79 exports de valor sem import externo em `apps/web/lib/`. 44 são importados por arquivos `.test.ts` (precisam do `export`). 2 (`TIPOS_DOCUMENTO` e `CAMPOS_FORNECEDOR`) são usados apenas via `typeof` e o eslint reclama sem `export`. 33 restantes são seguros.
- **Remoção.** `export` removido de 33 declarações em 21 arquivos: constantes, funções e enums que só são consumidos dentro do próprio módulo.
- **Validação.** `pnpm run check` (37 tarefas, 1.456 testes web, lint limpo) e `pnpm run build` (10 tarefas) passaram sem erros.
- **Próxima etapa.** Publicação e medição com carga real seguem pendentes. [Plano](PLAN.md)

### 13/11/2026 · Varredura final de antecipação de queries

- **Base.** `codex/sentinel-audit` em `4ac59beb`, após A25 e as 14 otimizações D-670 a D-684.
- **Páginas analisadas.** Home (`/page.tsx`), Central (`/central/page.tsx`), Diagnóstico (`/diagnostico/page.tsx`), Estoque (`/estoque/page.tsx`), Contas (`/contas/page.tsx`), Central de Ações (`/acoes/page.tsx`), Saúde (`/saude/page.tsx`), Compras (`/compras/page.tsx`), Configurações (`/configuracoes/page.tsx`), Usuários (`/usuarios/page.tsx`).
- **Resultado.** Nenhuma oportunidade nova de antecipação encontrada. Todas as páginas já usam `Promise.all` para queries independentes, promises encadeadas quando há dependências parciais, ou cadeias estritas (cada etapa precisa do resultado da anterior). O padrão é consistente no projeto: `currentMembership()` resolve a organização, e as RPCs dependentes disparam juntas.
- **Páginas previamente otimizadas (D-670 a D-684).** Faturamento ML, Faturamento Shopee/Todos, Vendas multicanal, Vendas ML, Anúncios ML, Anúncios Shopee, Vendas Shopee, Curva ABC, Reposição, Produtos, Vinculações, Preços, Full e Perguntas do SAC.
- **Conclusão.** A auditoria de antecipação de queries cobre todas as rotas de alto tráfego. Os 35 achados locais estão completos. Restam 6 pendentes de ação ou acesso externo (A01, A02, A07, A08, A10, A11). [Plano](PLAN.md)

### 13/11/2026 · Segunda rodada de dependências (A42)

- **Base.** `codex/sentinel-audit` após a varredura de queries.
- **Auditoria.** `pnpm audit --audit-level moderate` encontrou 6 avisos novos desde a última rodada (A03/A12): 1 alto e 4 moderados em vite 8.2.1 via vitest (launch-editor: bypass de `fs.existsSync` no Windows, omissão de `%` no escaping, CLI flag e server.fs), 2 moderados em hono <4.13.16 (mount bypass e RegExpRouter skip), 2 moderados em @hono/node-server <2.1.6 (WebSocket upgrade crash e backslash bypass), 1 moderado em minimatch <11.0.1 via eslint (DoS por globparts), 1 moderado em uuid <11.1.1 via GCS/gaxios.
- **Correções.** vitest 4.1.11 → 4.1.12 em 10 workspaces. Override de vite `>=8.2.0 <=8.2.3` → `^8.2.4` no `pnpm-workspace.yaml`. hono 4.13.11 → 4.13.18 e @hono/node-server 2.1.3 → 2.1.8 na api e no worker. Override de minimatch `>=7.0.0 <11.0.1` → `^11.0.1`.
- **Residual.** uuid 9.0.1 (gaxios) e 8.3.2 (exceljs) — o fix exige uuid >=11.1.1, dois majors acima. O advisory (GHSA-w5hq-g745-h8pq) afeta apenas chamadas com parâmetro `buf` em v3/v5/v6, que nenhum consumidor usa. Risco negligível; registrado sem forçar.
- **Validação.** `pnpm audit` de 6 avisos para 1 moderado. `pnpm run check` (37 tarefas, 2.471 testes), `pnpm run build` (10 tarefas) e `pnpm docs:check` passaram.

### 16/11/2026 · Retomada e revisão de Perguntas do SAC

- **Base.** `codex/sentinel-audit` em `c88ea687`, igual à referência local de `origin/codex/sentinel-audit`. O checkpoint inclui D-684, a limpeza A25 e as atualizações A42. `git cherry HEAD sentinel-continue` não apontou correções exclusivas nessa branch. Checkout original em `v3`, `9642d921`.
- **D-685.** O Supabase local devolveu 416 para uma página além do fim em Perguntas. A tela passou a oferecer retorno à primeira página da mesma aba e conta. A revisão também reutilizou a promessa de contas e limitou as leituras do formulário ao caso selecionado e aberto. O rastreio manteve o paralelismo do consolidado e registrou as mesmas chamadas HTTP de contas e Auth por documento. [Medição](../PERFORMANCE.md#leituras-e-paginação-de-perguntas-do-sac-sentinel-a43-16112026)
- **Validação.** Os 17 casos Playwright de Atendimento passaram, incluindo o retorno ao recorte da conta e a retomada de resposta pendente. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir as chamadas de Auth na navegação cliente, incluindo prefetch e carregamento de recursos, para retomar A11. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Auth na navegação cliente

- **Base.** `codex/sentinel-audit` em `69fa9232`.
- **D-686 (A11).** Os links da barra lateral passaram a buscar a tela no clique. Em quatro repetições de cada jornada, o total de Auth de Perguntas → Estoque passou de 57 para 29 e o de Configurações → Vendas, de 55 para 29. O indicador de troca de tela e o redirecionamento sem sessão foram exercitados. [Medição](../PERFORMANCE.md#auth-na-navegação-cliente-sentinel-a11-16112026)
- **Validação.** O build anterior falhou na nova asserção de prefetch e o build corrigido passou. Passaram sete casos Playwright de navegação, rolagem e cabeçalhos, além de `pnpm run check`, `pnpm run build` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos atalhos de Configurações e dos cartões de Estoque para decidir quais consultas antecipadas ajudam a primeira navegação. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch em Configurações e Estoque

- **Base.** `codex/sentinel-audit` em `8eebecd2`.
- **D-687 (A44).** Atalhos de Configurações e cartões de Estoque consultam o destino ao clicar. O ensaio registrou 31 para 13 chamadas de Auth até Configuração de Reposição e 30 para 25 até Central Full. As duas primeiras navegações fizeram uma requisição RSC em cada execução. [Medição](../PERFORMANCE.md#prefetch-em-configurações-e-estoque-sentinel-a44-16112026)
- **Validação.** Os dois testes de prefetch falharam no build anterior e passaram no corrigido. Na primeira rodada ampla, o Auth local retornou 500 no login de um caso de Full. A repetição em sequência passou nos 23 casos Playwright selecionados. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links por SKU na tabela de Estoque durante a rolagem e a abertura do primeiro detalhe. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch por SKU na tabela de Estoque

- **Base.** `codex/sentinel-audit` em `b554b3bc`.
- **D-688 (A45).** A tabela de Estoque passou a consultar o detalhe e o ajuste de SKU ao clicar. O ensaio de rolagem por uma página com 100 SKUs registrou mediana de 59 → 0 verificações de sessão para esses destinos antes do clique. Uma requisição RSC por clique abriu o SKU escolhido. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-em-estoque-sentinel-a45-16112026)
- **Validação.** O teste de prefetch falhou no build anterior e passou no corrigido. Após remover os 100 SKUs sintéticos do banco isolado, passaram os 12 casos Playwright de Ajuste de Estoque e Dashboard de SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links por anúncio e SKU na listagem de Anúncios do Mercado Livre, incluindo a abertura direta da aba Preços. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch por linha em Anúncios do Mercado Livre

- **Base.** `codex/sentinel-audit` em `940d8abd`.
- **D-689 (A46).** O ensaio com 100 anúncios registrou mediana de 70 → 0 verificações de sessão dos links por linha antes do clique. Cada clique abriu o anúncio, o SKU vinculado ou a aba Preços com uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-em-anúncios-do-mercado-livre-sentinel-a46-16112026)
- **Validação.** A regressão registrou seis pré-buscas no build anterior e passou no corrigido. Após remover os registros sintéticos do banco isolado, passaram os 19 casos Playwright selecionados de Anúncios e Detalhe do Anúncio. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links para SKU em Anúncios da Shopee e conferir a abertura do SKU vinculado. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do SKU em Anúncios da Shopee

- **Base.** `codex/sentinel-audit` em `ab6c52e1`.
- **D-690 (A47).** A mediana de verificações de sessão para links de SKU antes do clique caiu de 48 para zero no ensaio com 50 anúncios. O primeiro clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-em-anúncios-da-shopee-sentinel-a47-16112026)
- **Validação.** O teste registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os dados sintéticos, passaram os 14 casos Playwright selecionados, incluindo dois do projeto que usa uma loja marcada como live em ambiente local. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de anúncio e SKU na Central de Vinculações. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch por linha em Vinculações

- **Base.** `codex/sentinel-audit` em `268d4401`.
- **D-691 (A48).** Em uma página com 50 anúncios, a mediana de verificações de sessão dos links por linha antes do clique caiu de 69,5 para zero. Cada clique abriu o anúncio ou o SKU esperado em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-na-central-de-vinculações-sentinel-a48-16112026)
- **Validação.** A regressão registrou quatro pré-buscas no build anterior e passou no corrigido. Após a remoção dos dados sintéticos, passaram os 26 casos Playwright selecionados de Vinculações, Anúncio e SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU e reposição na tabela da Central Full. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch por linha na Central Full

- **Base.** `codex/sentinel-audit` em `2bf0d1ef`.
- **D-692 (A49).** Em uma página com 50 SKUs, a mediana de verificações de sessão dos links por linha antes do clique caiu de 77 para zero. Cada clique abriu o SKU ou a Reposição filtrada em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-na-central-full-sentinel-a49-16112026)
- **Validação.** A regressão registrou quatro pré-buscas no build anterior e passou no corrigido. Após a remoção dos dados sintéticos, passaram os 21 casos Playwright selecionados de Central Full, Reposição e SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Investigar por que um SKU com saldo apenas no Full fica fora da busca de Reposição (A50). Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · SKUs com saldo exclusivo no Full em Reposição

- **Base.** `codex/sentinel-audit` em `5353e58a`.
- **D-693 (A50).** A lista de Reposição e o alcance das regras incluem o Full positivo atual pela última captura de cada bucket visível. O ensaio passou de 1.000 para 1.400 SKUs elegíveis, com os mesmos dados para os 1.000 anteriores. [Medição](../PERFORMANCE.md#skus-com-saldo-exclusivo-no-full-na-reposição-sentinel-a50-16112026)
- **Validação.** A regressão falhou na busca e no alcance com a versão anterior. Após o reset local e o registro da migration `20261116164846`, passaram 1.158 testes de integração. Passaram 21 casos Playwright e a jornada do SKU exclusivo do Full sem sugestão de compra. Passaram `pnpm run check`, `pnpm run build` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links da tabela de Produtos e conferir a abertura do SKU. Publicação e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do detalhe de SKU em Produtos

- **Base.** `codex/sentinel-audit` em `7ddf09e0`.
- **D-694 (A51).** A mediana de verificações de sessão para links de SKU antes do clique caiu de 49 para zero no ensaio com 100 SKUs. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-em-produtos-sentinel-a51-16112026)
- **Validação.** A regressão registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os SKUs sintéticos, passaram os 16 casos Playwright selecionados de Produtos e SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU na tabela de Reposição. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do detalhe de SKU em Reposição

- **Base.** `codex/sentinel-audit` em `698aebf3`.
- **D-695 (A52).** A mediana de verificações de sessão para links de SKU antes do clique caiu de 54 para zero no ensaio com 100 SKUs. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-em-reposição-sentinel-a52-16112026)
- **Validação.** A regressão registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os SKUs sintéticos, passaram os 24 casos Playwright selecionados de Reposição, Configuração, Central Full e SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU na tabela da Curva ABC. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do detalhe de SKU na Curva ABC

- **Base.** `codex/sentinel-audit` em `891334a5`.
- **D-696 (A53).** A mediana de verificações de sessão para links de SKU antes do clique caiu de 38 para zero no ensaio com 50 SKUs. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-na-curva-abc-sentinel-a53-16112026)
- **Validação.** A regressão registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os SKUs sintéticos, passaram os 16 casos Playwright selecionados, incluindo o recorte com loja Shopee live de teste local. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU no ranking de Produtos da Central. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do SKU no ranking de Produtos da Central

- **Base.** `codex/sentinel-audit` em `77f8cdb6`.
- **D-697 (A54).** A mediana de verificações de sessão para links de SKU antes do clique caiu de 54 para zero no ensaio com 50 SKUs. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-no-ranking-de-produtos-da-central-sentinel-a54-16112026)
- **Validação.** A regressão registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os dados sintéticos, passaram os 19 casos Playwright selecionados de Central e SKU. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de anúncio no painel de Frete da Central. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch de anúncios no Detector de frete

- **Base.** `codex/sentinel-audit` em `a057f52c`.
- **D-698 (A55).** A mediana de verificações de sessão para links de anúncio antes do clique caiu de 24 para zero no ensaio com 30 observações. O clique abriu o anúncio do cartão em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-anúncio-no-detector-de-frete-sentinel-a55-16112026)
- **Validação.** O ensaio exercitou os dois builds, o anúncio esperado e o retorno ao filtro Forte indício. Após recriar o banco local e aplicar o seed padrão, passaram os 19 casos Playwright selecionados de Central e Detalhe do Anúncio. Passaram `pnpm run check`, `pnpm run build`, `check:waterfalls`, `check:navegacao-suave` e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU no ranking de Vendas, nos recortes Mercado Livre e Todos. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Guarda de vocabulário na CI do PR #328

- **Base.** `codex/sentinel-audit` em `4baaffb7`, 14 commits à frente de `origin/codex/sentinel-audit` (`c88ea687`).
- **CI.** A execução do PR em `c88ea687` reprovou em dois passos. A guarda `check:settings-vocabulary` não achou a tabela `INCLUI`: a limpeza A25 tirou o `export` que o script localiza por texto. O passo roda só na CI, fora de `pnpm run check`. O `export` voltou em `868efe5f`, com o motivo no comentário da tabela. No job de E2E, o build web falhou ao resolver os arquivos da fonte Inter em `next/font/google`, na primeira execução da CI com Next 16.4.1. O build local com a mesma versão passa e o Google Fonts devolve as URLs no formato esperado. A causa não foi reproduzida.
- **Validação.** As sete guardas que só a CI roda (`settings-vocabulary`, `waterfalls`, `server-actions`, `table-styles`, `control-styles`, `loading` e `navegacao-suave`) e `pnpm audit --prod --audit-level high` passaram localmente.
- **Reexecução.** Na CI de `93ae87d6`, o job de typecheck, lint, test e build passou com a guarda, e o build web do job de E2E passou. A falha das fontes não se repetiu. Os testes E2E ainda estavam em curso neste registro.

### 16/11/2026 · Prefetch do SKU nos rankings de Vendas

- **Base.** `codex/sentinel-audit` em `868efe5f`.
- **D-699 (A56).** Com o ranking cheio, de 10 SKUs, a mediana de pré-buscas de SKU antes do clique caiu de 14 para zero nos recortes Mercado Livre e Todos, e cada jornada fez 14 verificações de sessão a menos. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-no-ranking-de-vendas-sentinel-a56-16112026)
- **Validação.** A regressão registrou duas pré-buscas em cada recorte no build anterior e passou no corrigido. Após remover os SKUs sintéticos, passaram os 29 casos Playwright selecionados de Vendas e SKU. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU nos pedidos e nas devoluções de Vendas da Shopee. Movimentações, ranking de Faturamento, Histórico de Preços e exceções da Configuração de Reposição também têm links por linha com prefetch. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do SKU nos pedidos de Vendas da Shopee

- **Base.** `codex/sentinel-audit` em `93ae87d6`.
- **D-700 (A57).** Em uma página com 50 pedidos, a mediana de pré-buscas de SKU antes do clique caiu de 46 para zero, e cada jornada fez 46 verificações de sessão a menos. O clique abriu o SKU do item em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-nos-pedidos-de-vendas-da-shopee-sentinel-a57-16112026)
- **Devoluções.** O link de SKU do painel de devoluções não mudou. Com a loja de teste do seed, o painel não lista itens, mesmo com devoluções gravadas e a leitura marcada. O ensaio precisa de loja real no banco local.
- **Validação.** A regressão registrou quatro pré-buscas no build anterior e passou no corrigido. Após remover os pedidos e SKUs sintéticos, passaram os 20 casos Playwright de Vendas da Shopee e de Vendas multicanal. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU em Movimentações. Ranking de Faturamento, Histórico de Preços e exceções da Configuração de Reposição também têm links por linha com prefetch. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Decisão D-684 ausente

- **Base.** `codex/sentinel-audit` em `2f22565a`.
- **Lacuna.** O commit `d10d1ad4` citou a D-684 no plano, nos achados, no handoff e neste registro, mas não escreveu a seção em `DECISIONS.md`. O índice passava de D-683 para D-685. A seção foi escrita a partir do registro de 13/11 e diz o que a D-685 revisou depois.
- **Validação.** `pnpm docs:index` e `pnpm docs:check` passaram.

### 16/11/2026 · Prefetch por linha em Movimentações

- **Base.** `codex/sentinel-audit` em `620f0b02`.
- **D-701 (A58).** Em uma página com 50 movimentos, a mediana de pré-buscas antes do clique caiu de 62 para zero, entre links de SKU e de origem, e cada jornada fez 62 verificações de sessão a menos. Cada clique abriu o SKU, o pedido de compra ou a nota fiscal da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-por-linha-em-movimentações-sentinel-a58-16112026)
- **Validação.** A regressão nova, em `movimentacoes.spec.ts`, registrou duas pré-buscas no build anterior e passou no corrigido. Ela cobre o link de SKU: o seed não tem movimento com origem. Os movimentos sintéticos foram removidos com os gatilhos de imutabilidade suspensos só nessa transação, e o banco voltou às contagens do seed. Passaram os 9 casos Playwright de Movimentações, troca de tela e Ajuste de Estoque. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU no ranking de Faturamento. Histórico de Preços e exceções da Configuração de Reposição também têm links por linha com prefetch. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do SKU nas listas de produtos do Faturamento

- **Base.** `codex/sentinel-audit` em `dec9c0ed`.
- **D-702 (A59).** Com o ranking por receita cheio, de 30 produtos, a mediana de pré-buscas de SKU antes do clique caiu de 31 para zero, e cada jornada fez 31 verificações de sessão a menos. O clique abriu o SKU da posição em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-no-ranking-de-faturamento-sentinel-a59-16112026)
- **Validação.** A regressão registrou duas pré-buscas no build anterior e passou no corrigido. Após remover os pedidos e SKUs sintéticos, o banco voltou às contagens do seed e passaram os 11 casos Playwright de Faturamento e Faturamento multicanal. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch dos links de SKU e de anúncio no Histórico de Preços. As exceções da Configuração de Reposição também têm link por linha com prefetch. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Corrida no teste de filtros de Produtos

- **Base.** `codex/sentinel-audit` em `60befc36`.
- **CI.** Na execução de `620f0b02`, a primeira com a suíte E2E inteira nesta branch, passaram 288 casos e um falhou: o caso dos filtros que atualizam no lugar, em `produtos.spec.ts`, com `route.continue: Route is already handled!`. Os 17 casos do projeto `loja-live` não rodaram, porque dependem do projeto principal.
- **Causa.** O teste segura por 1 s toda resposta RSC de `/produtos` para ver a barra de atualização. As pré-buscas dos links de filtro passam pela mesma rota, e quatro ainda estavam seguradas quando o teste removia a rota. O caso não mudou nesta branch e passava na `main`. Não foi apurado o que mudou o tempo dessas pré-buscas.
- **Correção.** A primeira tentativa, em `48c562b4`, passou a `page.unroute` uma opção que ela não aceita. Reprovou no typecheck da CI e, em execução, deixava a rota instalada: por isso as 25 repetições locais passaram. O commit saiu sem typecheck depois da edição. A correção válida remove as rotas com `unrouteAll({ behavior: "ignoreErrors" })`. Esperar os handlers não serve, porque as requisições seguradas são devolvidas ao navegador quando a rota sai e o `continue()` delas falha do mesmo jeito. Localmente o caso falhou em 5 de 8 execuções antes e passou em 30 de 30 depois, com typecheck e lint.
- **Próxima etapa.** Conferir a suíte E2E e o projeto `loja-live` na CI do próximo push.

### 16/11/2026 · Prefetch por linha no Histórico de Preços

- **Base.** `codex/sentinel-audit` em `b902ef2b`.
- **D-703 (A60).** Em uma página com 50 alterações, a mediana de pré-buscas antes do clique caiu de 93 para zero, entre links de SKU e de anúncio, e as verificações de sessão antes do clique caíram de 103 para 10. Cada clique abriu o SKU ou o anúncio da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-por-linha-no-histórico-de-preços-sentinel-a60-16112026)
- **Validação.** A regressão registrou cinco pré-buscas no build anterior e passou no corrigido. Os eventos sintéticos entraram e saíram com os gatilhos suspensos na transação, para não gerar avisos, e o banco voltou às contagens do seed. Passaram os 5 casos Playwright de Preços. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Medir o prefetch do link de SKU nas exceções da Configuração de Reposição. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 16/11/2026 · Prefetch do SKU nas exceções de Reposição

- **Base.** `codex/sentinel-audit` em `046a3bff`.
- **D-704 (A61).** Com 50 exceções por SKU, a mediana de pré-buscas de SKU antes do clique caiu de 52 para zero, e cada jornada fez 52 verificações de sessão a menos. O clique abriu o SKU da linha em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-do-link-de-sku-nas-exceções-de-reposição-sentinel-a61-16112026)
- **Validação.** A regressão grava uma exceção no banco local e a apaga ao final, porque a tela não cria regra por SKU. Ela registrou duas pré-buscas no build anterior e passou no corrigido. Após remover as regras e os SKUs sintéticos, passaram os 9 casos Playwright de Configuração de Reposição e de Reposição, e a tabela de regras voltou a ficar vazia. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** A fila de tabelas com link por linha terminou. Medir as telas de detalhe (itens do pedido de compra, produtos do fornecedor e abas do SKU) antes de decidir se mudam. O painel de devoluções da Shopee segue esperando loja real no banco local. Publicação das correções e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch do SKU nos itens do pedido de compra

- **Base.** `codex/sentinel-audit` em `513c38f4`.
- **D-705 (A62).** Nos pedidos com 2 e 50 SKUs, as chamadas ao Auth por pré-busca antes do clique caíram de 4 e 51 para zero, na mediana. O clique abriu o SKU correto em uma requisição RSC. A mediana do clique subiu 27 ms e 6 ms, respectivamente. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-nos-itens-do-pedido-de-compra-sentinel-a62-17112026)
- **Validação.** O novo caso Playwright detectou duas pré-buscas no build anterior. Com a correção e o banco isolado recriado com o seed padrão, passaram os 16 casos de Compras, Pedido de compra e Detalhe do SKU. Passaram o check, o build e as guardas de leituras em série e navegação.
- **Próxima etapa.** Medir os links nos produtos do fornecedor e depois nas abas do SKU. A fixture local de devoluções da Shopee, a publicação e a validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch do SKU nos produtos do fornecedor

- **Base.** `codex/sentinel-audit` em `f4455eab`.
- **D-706 (A63).** Com 2 e 49 links de SKU, as chamadas ao Auth por pré-busca antes do clique caíram de 4 e 53 para zero na mediana. O clique abriu o SKU certo em uma requisição RSC. A comparação identificou cada jornada no trace. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-sku-nos-produtos-do-fornecedor-sentinel-a63-17112026)
- **Validação.** O caso novo detectou duas pré-buscas no build anterior. Após recriar o banco local e carregar o seed padrão, passaram os 26 casos Playwright de Fornecedores, Compras, Pedido de compra e Detalhe do SKU. O check e o build passaram.
- **Próxima etapa.** Medir as abas do SKU e os links da seção Pedidos de compra do fornecedor. O painel de devoluções da Shopee pede uma loja live com devoluções no banco local. Publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch de anúncios do Mercado Livre no detalhe do SKU

- **Base.** `codex/sentinel-audit` em `1dcf35aa`.
- **D-707 (A64).** As chamadas ao Auth por pré-busca antes do clique caíram de 6 para zero na Visão geral, de 51 para zero em Anúncios e de 50 para zero em Preços, na mediana. O clique abriu o anúncio esperado em uma requisição RSC. [Medição](../PERFORMANCE.md#prefetch-dos-links-do-mercado-livre-no-detalhe-do-sku-sentinel-a64-17112026)
- **Validação.** Os três casos novos detectaram duas pré-buscas cada no build anterior. No build corrigido passaram os 26 casos Playwright de Detalhe do SKU, Detalhe do anúncio e Preços com o seed padrão em banco recriado. Passaram o check, o build, as guardas de leituras em série e navegação e o `docs:check`.
- **Próxima etapa.** Medir os pedidos do fornecedor. Os links da Shopee no detalhe do SKU e em Devoluções seguem na fila de medição local. Publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Retomada e prefetch de pedidos no painel do fornecedor

- **Base.** Worktree isolada em `codex/sentinel-audit`, `91077075` antes da etapa. A `v3` local tem trabalho em curso e `sentinel-continue` não trouxe patch exclusivo no `git cherry`. O GitHub mostrou 24 refs e 14 PRs abertos. PR #328 em `513c38f4`, com E2E, integração, scripts e check verdes no run `43959475822`. A etapa de aplicar migrations no Dev foi pulada. A `main` retornou sem proteção efetiva. [Branches](BRANCH_AUDIT.md)
- **D-708 (A65).** No painel do fornecedor, as chamadas ao Auth por pré-busca antes do clique caíram de 3 e 49 para zero para listas com 2 e 50 pedidos. A mediana do clique na lista cheia foi de 121 ms nos dois builds. [Medição](../PERFORMANCE.md#prefetch-dos-links-de-pedido-no-painel-do-fornecedor-sentinel-a65-17112026)
- **Validação.** O caso novo detectou sete requisições de prefetch no build anterior. Passaram os 18 casos Playwright de Fornecedores e Compras com o seed padrão em banco recriado, além do check e build. A página, o spec e os mapas da auditoria foram atualizados.
- **Próxima etapa.** Reutilizar a loja live sintética do Playwright para medir os anúncios da Shopee no SKU e os links de SKU nas devoluções. Nenhuma migration alterada nesta etapa. Publicação e validação real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch de anúncios da Shopee no SKU e de SKUs em Devoluções

- **Base.** `codex/sentinel-audit` em `a3c789dd`. O ensaio local reaproveitou a loja sintética do projeto Playwright `loja-live` com 50 anúncios e 10 devoluções.
- **D-709 (A66).** As chamadas ao Auth por pré-busca caíram de 48 e 13 para zero, na mediana, nos anúncios e em Devoluções. Foram alterados os links nas duas telas, o spec `ensaio-loja-live.spec.ts` e os mapas da auditoria. [Medição](../PERFORMANCE.md#prefetch-dos-links-da-shopee-no-sku-e-em-devolucoes-sentinel-a66-17112026)
- **Validação.** Cada caso novo mostrou duas pré-buscas no build anterior. No corrigido passaram os 34 casos Chromium de SKU, Anúncios e Vendas da Shopee e os 19 casos de `loja-live`, incluindo o retorno à aba ou ao filtro da loja. Passaram check, build, docs e as guardas de leituras em série e navegação.
- **Próxima etapa.** Medir as abas do `ObjectHeader` nos detalhes de SKU e anúncio. As cinco repetições da jornada de anúncios da Shopee registraram sete chamadas ao Auth para outras abas do SKU. Nenhuma migration foi alterada nas duas etapas desta retomada. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch do seletor de abas no SKU e no anúncio

- **Base.** `codex/sentinel-audit` em `d121f271`.
- **D-710 (A67).** Em quatro jornadas com o seed padrão, a pré-busca de outras abas caiu de 8 para 2 e 0 no SKU, e de 7 para 3 e 1 no anúncio. O clique continuou a abrir a aba com uma requisição RSC. Os links para outras abas que aparecem fora do seletor explicam as requisições restantes. [Medição](../PERFORMANCE.md#prefetch-do-seletor-de-abas-no-sku-e-no-anuncio-sentinel-a67-17112026)
- **Validação.** Os dois casos novos acusaram uma pré-busca cada no build anterior. No corrigido, passaram os 28 casos de Troca de tela, Detalhe do SKU e Detalhe do anúncio. As regressões acionaram a aba com Enter, atrasaram a resposta e verificaram o painel anterior, o indicador e o retorno à aba inicial.
- **Próxima etapa.** Medir os atalhos para abas fora do seletor. Esta etapa alterou o cabeçalho e o spec de navegação. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch dos atalhos para abas no SKU e no anúncio

- **Base.** `codex/sentinel-audit` em `f2053c06`.
- **D-711 (A68).** A comparação de seis jornadas registrou zero chamadas ao Auth por pré-busca de outras abas após o ajuste. Antes eram duas no SKU e três no anúncio. Um clique abriu o destino em uma requisição RSC, marcou a aba ativa e a volta restaurou a Visão geral. [Medição](../PERFORMANCE.md#prefetch-dos-atalhos-para-abas-nos-detalhes-sentinel-a68-17112026)
- **Validação.** Os dois casos novos acusaram duas e três pré-buscas no build anterior. No build corrigido passaram os 30 casos Playwright de Troca de tela, Detalhe do SKU e Detalhe do anúncio, incluindo Decisões e Histórico pelo menu Ações.
- **Próxima etapa.** Medir os links para outras telas no menu Ações do anúncio. A abertura do menu elevou o Auth antes do clique de 9 para 21 na comparação corrigida. Esta etapa alterou as duas páginas e o spec de navegação. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch dos links do menu Ações do anúncio

- **Base.** `codex/sentinel-audit` em `07365a48`.
- **D-712 (A69).** Nos seis caminhos, abrir o menu passou de medianas de 8 a 10 chamadas ao Auth por pré-busca para zero. Cada clique abriu o destino esperado em uma requisição RSC. O MLB entrou na busca de Preços e de Anúncios, e a volta restaurou a Visão geral do anúncio. [Medição](../PERFORMANCE.md#prefetch-dos-links-do-menu-acoes-do-anuncio-sentinel-a69-17112026)
- **Validação.** Os dois novos casos detectaram pré-buscas no build anterior após levar o link à área visível. No corrigido passaram os 36 casos Playwright de navegação, Detalhe do anúncio, anúncio excluído, Anúncios e Preços. Os novos casos atrasaram a requisição e conferiram o indicador durante a navegação.
- **Próxima etapa.** Medir o atalho de Diagnóstico para Anúncios no detalhe do SKU. D-712 alterou uma página e o spec de navegação. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Prefetch do atalho de Diagnóstico para Anúncios no SKU

- **Base.** `codex/sentinel-audit` em `e90f14ce`.
- **D-713 (A70).** Consolidado e conta na URL passaram de uma pré-busca de Anúncios para zero. Os cliques abriram a aba em uma requisição RSC e a volta restaurou a URL original. [Medição](../PERFORMANCE.md#prefetch-do-atalho-de-diagnostico-para-anuncios-no-sku-sentinel-a70-17112026)
- **Validação.** O caso novo detectou uma pré-busca no build anterior. No corrigido passaram os 24 casos Playwright de Troca de tela e Detalhe do SKU, incluindo espera com o painel anterior visível e retorno ao Diagnóstico.
- **Próxima etapa.** Verificar se Reler agora em Diagnóstico lê uma alteração feita no banco local após abrir a página e preserva o escopo. Esta etapa alterou a página do SKU, o spec de navegação e os mapas. Nenhuma migration alterada. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Verificação da releitura do Diagnóstico do SKU

- **Base.** `codex/sentinel-audit` em `f6252b55`.
- **Resultado.** Reler agora já buscava dados novos. Uma reprodução no build de produção observou uma requisição RSC com HTTP 200 no consolidado e no recorte de conta. A URL permaneceu a mesma.
- **Regressão.** O novo caso em `sku-dashboard.spec.ts` cria uma segunda conta com anúncio do mesmo SKU e altera os estoques de ambas após abrir a página. O consolidado incorpora as duas alterações, e o recorte incorpora só a selecionada. Uma resposta atrasada verifica o valor anterior visível e o indicador de atualização até a nova leitura chegar.
- **Validação.** Passaram os 25 casos Playwright de SKU e navegação e a repetição isolada do caso de releitura após o ajuste das asserções de limpeza. A conta e o anúncio do teste foram removidos, e o estoque original voltou ao valor do seed. Check, build e docs passaram. O teste e os mapas foram atualizados.
- **Próxima etapa.** Auditar o limite de 1.000 anúncios nas leituras do detalhe do SKU, com cardinalidade sintética e contagens conhecidas. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Leitura completa dos anúncios ML do SKU

- **Base.** `codex/sentinel-audit` em `989b2d47`.
- **D-714 (A71).** O caso novo mostrou 1.000 linhas para 1.002 anúncios esperados. A página passou a usar o paginador de RPC existente, com ordem que desempata contas com o mesmo nome e MLB. A leitura completa expôs a conta nula do vínculo sem anúncio sincronizado, que fazia o Diagnóstico selecionar só esse vínculo. A migration `20261117171808` corrige a origem da conta na RPC. [Medição](../PERFORMANCE.md#leitura-completa-dos-anuncios-ml-no-sku-sentinel-a71-17112026)
- **Validação.** Em banco local recriado com as migrations, passaram 1.159 testes de integração e 39 projeções com embed. Após outra recriação e o seed padrão, passaram os 44 casos Chromium de SKU, navegação, Anúncios e Vinculações. O caso novo confere as 1.002 linhas na tabela e no Diagnóstico, variação, anúncio ainda sem leitura e exclusão. A regressão SQL confere a conta do vínculo e as permissões por conta e organização. Check, build, docs e guardas de leituras em série e navegação passaram. A consulta de limpeza confirmou zero contas e SKUs da nova fixture.
- **Próxima etapa.** Verificar o teto de 200 da RPC de anúncios Shopee do SKU com uma fixture maior que a janela. A migration desta etapa foi aplicada apenas no banco local e deve preceder a publicação da web. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Leitura completa dos anúncios Shopee do SKU

- **Base.** `codex/sentinel-audit` em `c697beee`.
- **D-715 (A72).** A fixture de 1.002 unidades mostrou 200 linhas no original e 1.000 após remover apenas o teto SQL. A migration `20261117173152` retira o limite e desempata pela loja, e a web lê a RPC em páginas. O trace confirmou lotes de 1.000, 2 e zero linhas. SKUs com um anúncio terminaram na primeira chamada. [Medição](../PERFORMANCE.md#leitura-completa-dos-anuncios-shopee-no-sku-sentinel-a72-17112026)
- **Validação.** Em banco recriado com as migrations, passaram 1.160 testes de integração. O caso novo verifica 402 anúncios para o ADMIN, 201 para quem alcança só uma loja e zero sem acesso ou de outra organização, com recusa de anônimo. Após outro reset e seed, passaram 39 embeds, 48 casos Chromium de SKU, navegação, Anúncios e Vendas da Shopee e os 20 casos do ensaio `loja-live`. A nova regressão cobre nomes e IDs iguais entre lojas, variações, precedência manual, sandbox e itens apagados. A consulta de limpeza confirmou zero lojas e SKUs da nova fixture, e o advisor local de segurança não apontou problemas. Check, build, docs e guardas de leituras em série e navegação passaram.
- **Próxima etapa.** Conferir troca e remoção do vínculo manual Shopee nos painéis dos dois SKUs envolvidos. A migration foi aplicada apenas no banco local e deve preceder a publicação da web. CI dos novos commits, publicação e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Verificação da troca e remoção do vínculo Shopee no SKU

- **Base.** `codex/sentinel-audit` em `2fbfaf08`.
- **Resultado.** O fluxo já atualizava a lista e os dois painéis. Duas regressões em `anuncios-shopee.spec.ts` cobrem o item sem variação e a variação: vínculo pelo SKU do anúncio, criação manual para outro SKU, duas trocas e remoção com motivo. Cada alteração confere a ausência no SKU anterior pelo histórico do router, a presença no destino e a origem do vínculo. O contador de vinculados permanece estável nas trocas.
- **Validação.** Passaram os dois casos isolados e os 39 casos Chromium de Anúncios da Shopee, SKU e navegação. A conferência SQL confirmou os dois anúncios de volta ao SKU do anúncio, sem manual remanescente. Nas duas execuções de cada jornada, o histórico registrou duas criações, quatro trocas e duas remoções por unidade. Check, build e docs passaram.
- **Próxima etapa.** Conferir recusas do servidor ao gravar o vínculo e a remoção concorrente por outra sessão, incluindo mensagem e nova tentativa. Esta etapa altera testes e mapas. As migrations pendentes das entregas anteriores, a CI dos novos commits, a publicação e a validação com tráfego real seguem no [plano](PLAN.md).

### 17/11/2026 · Falhas na gravação do vínculo Shopee

- **Base.** `codex/sentinel-audit` em `5629830b`.
- **D-716 (A73).** Bloquear o POST da Server Action deixava Vincular e Remover presos no estado pendente. As duas regressões falharam no build anterior, sem alerta e com os botões desabilitados. Os diálogos agora tratam a exceção, liberam o estado em `finally` e conservam o SKU e o motivo. A mensagem informa que a operação não pôde ser confirmada e pede conferir a lista antes de tentar novamente.
- **Validação.** As duas regressões passaram após a correção e confirmaram ausência de gravação no POST bloqueado, controles liberados e sucesso na nova tentativa. Outro caso verificou a recusa real do banco após o item sair do catálogo e a remoção concorrente em duas sessões autenticadas. Após reset e seed, passaram os 42 casos Chromium de Anúncios da Shopee, SKU e navegação. Os dois diálogos foram conferidos em desktop e celular, e o detector Impeccable não apontou problemas no arquivo alterado. A consulta de limpeza confirmou o item em UNLIST e sem vínculo manual restante. Check, build e docs passaram.
- **Próxima etapa.** Verificar falhas de transporte em gravar e descartar na Central de Vinculações do Mercado Livre. Esta etapa altera um componente, o spec, a decisão e os mapas. As migrations pendentes das entregas anteriores, a CI dos novos commits, a publicação e a validação com tráfego real seguem no [plano](PLAN.md).

### 17/11/2026 · Falhas de transporte na Central de Vinculações

- **Base.** `codex/sentinel-audit` em `e9975de4`.
- **D-717 (A74).** Bloquear o POST da ação reproduziu o diálogo preso sem alerta no vínculo manual, na resolução e no descarte de candidato. Os três casos falharam no build anterior. A correção trata a exceção, libera o estado pendente em `finally` e conserva o SKU escolhido. O aviso pede conferir a lista antes de tentar novamente, pois a gravação pode ter ocorrido antes de uma perda de comunicação.
- **Validação.** Passaram os três casos isolados. As consultas confirmaram ausência de vínculo e, nos casos de candidato, status OPEN após o POST bloqueado. Após nova tentativa, o vínculo apontou para o SKU escolhido, a resolução terminou em RESOLVED e o descarte em DISMISSED. Após reset e seed, passaram os 47 casos Chromium de Vinculações, Anúncios, SKU e navegação. Os avisos foram conferidos em desktop e celular, e o detector Impeccable não apontou problemas no componente. A limpeza arquivou o anúncio da fixture com SKU nulo e confirmou zero vínculos, candidatos e lotes temporários restantes. Check, build e docs passaram.
- **Próxima etapa.** Verificar falha de transporte no diálogo de remover vínculo ML do SKU. Esta etapa altera o componente, o spec, a decisão e os mapas. As migrations pendentes das entregas anteriores, a CI dos novos commits, a publicação e a validação com tráfego real seguem no [plano](PLAN.md).

### 17/11/2026 · Aviso alto do picomatch no audit de produção

- **Base.** `codex/sentinel-audit` em `2418fa99`, com 15 commits locais à frente de `origin/codex/sentinel-audit`.
- **A75.** Antes de enviar os commits, `pnpm audit --prod --audit-level high` reprovou com o aviso alto GHSA-fc5q-39xc-vjpf no `picomatch` 4.0.7, por 14 caminhos, todos vindos de `typescript-eslint` em `@sb/config`. O lockfile não mudou nesta branch, e a correção indicada, 4.0.8, não está publicada no npm. O passo da CI reprovaria qualquer PR do repositório.
- **Correção.** `@sb/config` declarava `@eslint/js`, `eslint`, `globals` e `typescript-eslint` em `dependencies`, embora os dez pacotes que o usam o declarem em `devDependencies`. As quatro passaram para `devDependencies`, e o lockfile mudou uma linha. O audit de produção passou com três moderados: `uuid`, já registrado, e dois do Next 16.4.1, que exigem `'use cache'` ou `unstable_cache`, ausentes no código. O aviso do `picomatch` segue no audit completo.
- **Validação.** `pnpm run check` passou nas 37 tarefas, com o lint de todos os pacotes. O `pnpm deploy --legacy --prod` da API terminou sem `@sb/config` e sem ferramentas de lint. Passaram `pnpm run build`, as sete guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Retomar a falha de transporte no diálogo de remover vínculo ML do SKU. Conferir a publicação do `picomatch` 4.0.8. [Plano](PLAN.md)

### 17/11/2026 · Falha de transporte ao remover vínculo ML no SKU

- **Base.** `codex/sentinel-audit` em `7f96f6bc`.
- **Banco local.** Ao retomar, o banco isolado estava vazio, sem usuários, SKUs nem vínculos, depois de um reset sem seed. O seed foi reaplicado antes da etapa.
- **D-718 (A76).** Bloquear o POST da ação reproduziu o diálogo de remover vínculo preso em Removendo, sem alerta, com Remover e Cancelar desabilitados. A correção segue as D-716 e D-717: trata a exceção, libera o estado em `finally` e anuncia o aviso como alerta.
- **Validação.** O caso novo em `sku-dashboard.spec.ts` falhou no build anterior e passou em três repetições no corrigido, ao lado do caso existente de vincular e remover. Ele confere o vínculo intacto após o POST bloqueado e removido na nova tentativa. Passaram os 38 casos Playwright de SKU, Vinculações e troca de tela, e o banco ficou só com o vínculo do seed. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Procurar outros diálogos que aguardam Server Action sem tratar exceção e conferir cada um antes de mudar. Publicação das correções, incluindo as migrations `20261117171808` e `20261117173152`, e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Falha de transporte ao vincular anúncio no SKU

- **Base.** `codex/sentinel-audit` em `1204e525`.
- **Inventário.** Um script listou os componentes cliente que importam ações de servidor. Doze aguardam a ação sem `try` e cinco usam `useTransition` sem `try`, listados no [plano](PLAN.md). O diálogo de vincular anúncio do SKU, vizinho do corrigido na D-718, foi o primeiro conferido.
- **D-719 (A77).** Bloquear o POST da ação deixou o diálogo em Gravando o vínculo, sem alerta, com Cancelar, Confirmar e Esc desligados. A correção volta ao anúncio encontrado com um alerta e mantém Confirmar disponível. A mensagem de erro existente passou a ser alerta.
- **Validação.** O caso novo em `sku-dashboard.spec.ts` falhou no build anterior e passou em três repetições no corrigido, junto com os casos de vincular e remover. Passaram os 39 casos Playwright de SKU, Vinculações e troca de tela, e o banco ficou só com o vínculo do seed. O diálogo foi conferido em 1440 e 390 px de largura, com o aviso dentro do cartão do anúncio. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Seguir a fila do inventário, reproduzindo cada componente com POST bloqueado antes de mudar. Publicação das correções, incluindo as migrations `20261117171808` e `20261117173152`, e validação com carga real seguem pendentes. [Plano](PLAN.md)

### 17/11/2026 · Dados deixados por specs novos no E2E da CI

- **Base.** `codex/sentinel-audit` em `474e173b`.
- **CI.** Na execução de `7f96f6bc`, com os 15 commits da manhã, passaram 314 casos e dois falharam: a gaveta do fornecedor em `gavetas.spec.ts` e a contagem de itens sem SKU em `vendas-shopee.spec.ts`. Os 20 casos do `loja-live` não rodaram. Os dois passavam na CI de `b902ef2b`. A ordem alfabética `fornecedores` e `anuncios-shopee` antes de `gavetas` e `vendas-shopee` reproduziu as duas falhas localmente.
- **Fornecedor.** O caso do SKU comprado criava um rascunho de pedido pelo formulário para ter um item com SKU. O rascunho não pode ser apagado, porque o histórico do pedido só aceita inclusão, e a gaveta passava a contar um pedido e um SKU a mais. O caso agora vincula por alguns segundos um item do seed ao SKU de teste e desfaz no fim.
- **Shopee.** Vincular um anúncio preenche o SKU dos itens de pedido ainda sem SKU, e remover o vínculo não desfaz, por desenho: o pedido guarda a atribuição. Os casos de falha de conexão e de recusa de catálogo vinculavam o item sem SKU e deixavam o pedido do seed atribuído. A limpeza agora chama a mesma resolução do fim do seed.
- **Validação.** Os quatro specs em sequência passaram, 42 casos, e o banco terminou com as contagens do seed. Passaram `pnpm run check`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Conferir a suíte completa na CI. Depois, seguir a fila do inventário de Server Actions sem tratamento de exceção. [Plano](PLAN.md)

### 17/11/2026 · Falha de transporte em Notificações e Preferências

- **Base.** `codex/sentinel-audit` em `60784059`, com a CI verde: 338 casos de E2E, incluindo os 20 do `loja-live`.
- **D-720 (A78).** Os quatro componentes de Notificações da fila ligavam o estado pendente antes da ação e só o desligavam depois da resposta. Derrubar o POST deixou cada um com os controles presos: Marcando na linha e na confirmação de marcar todas, Adicionando no formulário e a severidade, a caixa Ativa e o diálogo de remoção desabilitados. A correção segue as D-716 a D-719.
- **Regressões.** O helper `derrubarPrimeiraAcao`, em `e2e/helpers.ts`, derruba a primeira Server Action da página. Dois casos novos em `notificacoes.spec.ts` e o arquivo novo `notificacoes-preferencias.spec.ts` falharam no build anterior e passaram em duas repetições no corrigido. Eles guardam e devolvem as leituras e as regras do usuário. Repetir `notificacoes.spec.ts` inteiro quebra a contagem inicial em casos antigos, porque o caso do recorte de não lidas deixa uma lida de propósito; uma rodada única passa, como na CI.
- **Validação.** Passaram os 24 casos de Notificações, Preferências e troca de tela. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Usuários e o nome do perfil: `acesso-membro.tsx`, `member-controls.tsx` e `editar-nome.tsx`. [Plano](PLAN.md)

### 17/11/2026 · Falha de transporte em Usuários e no nome do perfil

- **Base.** `codex/sentinel-audit` em `e6cff19a`.
- **D-721 (A79).** Derrubar o POST deixou o seletor de papel desabilitado na gaveta do GESTOR e o formulário do nome em Salvando, com o campo e Cancelar desabilitados. Alternar acesso e remover da organização têm a mesma forma e receberam a mesma correção. Suspender e reativar já passavam por `chamarApi`, que trata a falha de rede.
- **Regressões.** Dois casos novos em `usuarios.spec.ts` falharam no build anterior e passaram em duas repetições no corrigido. O da gaveta derruba o POST três vezes, em papel, conta e remoção, sem repetir as tentativas, e confere no banco o mesmo membro com o mesmo papel. O do nome repete a tentativa e devolve o nome original.
- **Validação.** Passaram os 12 casos de Usuários, e o banco terminou com os mesmos papéis, concessões e nomes. Passaram `pnpm run check`, `pnpm run build`, as guardas da CI e `pnpm docs:check`.
- **Próxima etapa.** Contas, sugestões e filtros salvos: `new-account-form.tsx`, `new-suggestion-form.tsx` e `saved-filters.tsx`. [Plano](PLAN.md)

### 18/11/2026 · Falha de transporte em Contas, Sugestões e visões salvas

- **Base.** `codex/sentinel-audit` em `7a5528fb`. D-718 a D-721 já estavam integradas à branch, e a worktree estava limpa. O Docker Desktop foi iniciado pelo caminho da instalação por usuário, e a stack isolada foi recriada com as migrations e o seed.
- **D-722 (A80).** Os quatro casos de transporte falharam no build anterior: cadastro em Cadastrando, sugestão em Enviando, visão em Salvando e exclusão da visão desabilitada. As três interfaces agora tratam a exceção e liberam o estado pendente em `finally`, preservando os campos e avisando que a operação não foi confirmada. O aviso de salvamento da visão fica dentro do diálogo aberto.
- **Validação.** Os quatro casos passaram no corrigido, com ausência de escrita no POST bloqueado e nova tentativa confirmada no banco: conta PENDING, sugestão com o texto original e visão com os parâmetros esperados. Um quinto caso conferiu a recusa do banco por nome longo, a mensagem dentro do diálogo e a correção do nome para salvar. Após outra recriação do banco, passaram os 25 casos de Contas, Sugestões, filtros salvos e navegação. A redação final de Sugestões passou em repetição isolada. As três interfaces foram conferidas em desktop e celular, e o detector Impeccable não apontou problemas. A consulta de limpeza confirmou zero contas, sugestões e visões das novas fixtures. Check, build, guardas da CI e docs passaram.
- **Próxima etapa.** Formulários de compra e de item de nota fiscal. Depois, os cinco componentes com `useTransition` do inventário de 17/11. Publicação, CI dos novos commits e validação com tráfego real seguem pendentes. [Plano](PLAN.md)

### 18/11/2026 · Falha de transporte em Compras e nos vínculos da NF-e

- **Base.** `codex/sentinel-audit` em `9747f146`, com a worktree limpa ao retomar.
- **D-723 (A81).** Os quatro casos falharam no build anterior: criação e edição do pedido ficavam em Salvando, e vincular ou desvincular o item da NF-e deixava os controles desabilitados. As duas interfaces agora tratam a exceção, conservam os campos e liberam a nova tentativa com aviso de resultado não confirmado. Compras conserva o botão desabilitado após sucesso até a navegação, para evitar outro envio nesse intervalo.
- **Validação.** Os quatro casos passaram após a correção e conferiram o banco antes da nova tentativa. Após reset e seed, passaram os 24 casos Chromium de pedido, compras, NF-e e troca de tela. A redação curta final do aviso da NF-e passou em nova execução isolada, inclusive no celular. Os avisos foram conferidos em desktop e celular; a tabela da NF-e conserva sua rolagem horizontal existente. O detector Impeccable não apontou problemas nos dois componentes. Check, build, as sete guardas da CI e docs passaram.
- **Fixtures.** As regressões de criar pedido e vincular NF-e foram incorporadas aos casos existentes. A suíte terminou com sete pedidos, os cinco do seed e os dois já criados pelo spec original. O teste de edição devolveu o destino do rascunho ao valor original e conservou SKU, quantidade 7 e custo ausente. O teste de remoção devolve o vínculo e o contador aos valores anteriores; o primeiro caso existente continua deixando a NF-e vinculada. Os eventos de auditoria legítimos permanecem.
- **Próxima etapa.** Conferir os cinco componentes com `useTransition` listados no [plano](PLAN.md), começando pelo ajuste de estoque. Publicação, CI dos novos commits e validação com tráfego real seguem pendentes.

### 18/11/2026 · Falha de transporte no ajuste de estoque

- **Base.** `codex/sentinel-audit` em `80e16dbf`, com a worktree limpa ao retomar. Supabase Dev continua identificado como `nmgccyqquwxecqffsidr`; a etapa usou só a stack local isolada `sb-sentinel-20261111`.
- **D-724 (A82).** O teste novo falhou no build anterior: bloquear o POST trocou o formulário pela fronteira de erro, com “Algo deu errado nesta tela”. A ação rodava dentro de `useTransition`, sem tratar a exceção. O tratamento local agora conserva os campos, mostra um alerta e permite nova tentativa. O aviso pede conferir as movimentações, pois uma falha de resposta não prova ausência de gravação. Não há repetição automática.
- **Validação.** A regressão passou após a correção, com saldo e ledger intactos no POST bloqueado e uma única saída de cinco unidades na nova tentativa, com motivo e autor corretos. Após reset e seed, passaram os 33 casos Chromium de ajuste, movimentações, SKU e troca de tela. A regressão passou novamente com conferência do local e capturas em desktop e celular; o alerta ficou legível nos dois tamanhos. O detector Impeccable não apontou problemas no componente. Check, build, as sete guardas da CI e docs passaram.
- **Fixtures.** O teste identifica a saída pela referência única e registra uma contrapartida ao terminar. A consulta após a suíte confirmou saldo 50 e os dois movimentos da fixture somando zero. O histórico é preservado, sem exclusão de movimentos nem alteração de triggers.
- **Próxima etapa.** Conferir as ações de alternar ativo e excluir fornecedor. Depois, a tabela de curadoria de Produtos e a gaveta de regra de Reposição: quatro componentes restantes deste inventário. Publicação, CI dos novos commits e validação com tráfego real seguem no [plano](PLAN.md).

### 18/11/2026 · Falha de transporte nas ações de Fornecedores

- **Base.** `codex/sentinel-audit` em `1c4e7daa`, com a worktree limpa. A etapa usou apenas a stack local isolada `sb-sentinel-20261111`, com Storage ligado para o caso existente de logo.
- **D-725 (A83).** Os três casos falharam no build anterior: reativar, inativar e excluir trocavam a edição pela fronteira de erro, perdendo o rascunho. As duas interfaces tratam a exceção dentro da transição, conservam o formulário e as confirmações e avisam que o resultado não foi confirmado. O alerta pede conferir o fornecedor ou a lista antes de tentar novamente; não há repetição automática.
- **Validação.** As três regressões passaram após a correção, com o nome ainda não salvo preservado e o cadastro intacto no POST bloqueado. Na nova tentativa, só o estado ativo mudou nos dois primeiros casos; no terceiro, o cadastro foi excluído. Passaram os 33 casos Chromium de Fornecedores, Compras, gavetas e troca de tela, incluindo logo e a proteção de fornecedor com pedido. Os três avisos foram conferidos em desktop e celular. O detector Impeccable não apontou problemas nos dois componentes. Check, build, as sete guardas da CI e docs passaram.
- **Execução.** O primeiro check, em paralelo com o Playwright, parou com ENOENT no ESLint: o runner recriou `test-results` durante a varredura. A repetição sequencial após o E2E passou nas 37 tarefas, sem alteração de configuração. Não paralelizar esses dois comandos neste ambiente.
- **Fixtures.** A consulta final confirmou zero fornecedores temporários; os dois fornecedores do seed conservaram seus estados ativo/inativo e ficaram sem logo, como antes. As novas regressões não alteram os cadastros do seed.
- **Próxima etapa.** Conferir a tabela de curadoria de Produtos; depois, a gaveta de regra de Reposição. São os dois componentes restantes deste inventário. CI dos novos commits, publicação e validação com tráfego real seguem no [plano](PLAN.md).

### 18/11/2026 · Falha de transporte na curadoria de Produtos

- **Base.** `codex/sentinel-audit` em `2db2f2b5`, com a worktree limpa. A etapa usou somente a stack local isolada `sb-sentinel-20261111`.
- **D-726 (A84).** Os cinco casos falharam no build anterior. Classificar, aplicar marca, limpar marca e desfazer não mostravam aviso após bloquear o POST. Com a chamada segurada, a confirmação já estava bloqueada, mas a seleção continuava editável. O callback assíncrono agora trata a exceção, preserva seleção, marca e confirmação e anuncia o erro como alerta. Os controles do lote ficam bloqueados até a resposta. Desfazer conserva só os IDs originalmente alterados na nova tentativa.
- **Validação.** As cinco regressões passaram no corrigido. As consultas conferiram os campos intactos no POST bloqueado e a gravação na nova tentativa. O caso de Desfazer enviou um SKU pendente junto de um já virtual e confirmou que a nova tentativa só limpou a decisão do primeiro. Passaram os 30 casos Chromium de Produtos, transporte da curadoria, Reposição e troca de tela. Check passou nas 37 tarefas; build, as sete guardas da CI e docs também passaram, executados sem a corrida entre ESLint e Playwright registrada na etapa anterior.
- **Conferência visual.** Os avisos de classificação, limpeza de marca e Desfazer ficaram legíveis em desktop e celular. O detector apontou uma borda lateral de 4px no painel de conferência, verificada também no HEAD de base. A etapa não altera estilos nem suprime o aviso do detector.
- **Fixtures.** As regressões devolvem os sete campos de classificação e marca, incluindo autores e datas. A consulta final confirmou o SKU principal sem classificação e sem marca e o SKU de anomalia ainda virtual, com a data de decisão preservada. Não houve mudança de schema nem escrita no ledger.
- **Próxima etapa.** Conferir a gaveta de regra de Reposição, último componente deste inventário com `useTransition`. CI dos novos commits, publicação e validação com tráfego real seguem no [plano](PLAN.md).

### 18/11/2026 · Falha de transporte na gaveta de regra de Reposição

- **Base.** `codex/sentinel-audit` em `367c4e40`, com a worktree limpa. A etapa usou somente a stack local isolada `sb-sentinel-20261111`; o Dev segue identificado como `nmgccyqquwxecqffsidr`, sem acesso remoto nesta fatia.
- **D-727 (A85).** Os três casos de transporte falharam no build anterior: criar, editar e remover regra substituíam a gaveta pela fronteira de erro do segmento. A recusa real de salvar uma regra removida enquanto a edição estava aberta já passava. O salvamento agora devolve falha tratada pelo `useActionState`, e a remoção trata a exceção na transição. Campos, escopo e confirmação permanecem; os avisos pedem conferir as regras antes de repetir, sem nova tentativa automática.
- **Validação.** Os quatro casos passaram após a correção. As consultas confirmaram nenhuma inserção ou alteração no POST bloqueado e o resultado da nova tentativa, incluindo a mesma identidade na edição e a ausência da regra após remoção. A recusa real continua visível sem apagar o rascunho. Passaram os 32 casos Chromium de configuração e transporte de Reposição, Reposição, Produtos e troca de tela. Check passou nas 37 tarefas; build, as sete guardas da CI e docs também passaram. ESLint e Playwright rodaram em sequência.
- **Conferência visual e limpeza.** Os três avisos ficaram legíveis em desktop e celular, com os botões de nova tentativa disponíveis. O detector Impeccable não apontou problemas no componente. A consulta final confirmou zero regras na organização do seed e zero fixtures de transporte. Não houve alteração de schema nem escrita no ledger.
- **Inventário.** Os cinco componentes com `useTransition` listados em 17/11 estão conferidos: ajuste de estoque, alternar ativo e excluir fornecedor, curadoria de Produtos e gaveta de Reposição (D-724 a D-727). O rastreio de `useActionState` encontrou quatro formulários diretos restantes, em dois arquivos da Central: limites, meta geral, meta por marketplace e alíquota. É inventário estático, ainda sem reprodução de defeito nesses quatro.
- **Próxima etapa.** Reproduzir o transporte nos formulários de Limites e Metas da Central antes de alterar. CI dos novos commits, publicação e validação com tráfego real seguem no [plano](PLAN.md).

### 18/11/2026 · Falha e perda de preenchimento nos cadastros da Central

- **Base.** `codex/sentinel-audit` em `ad903d41`, com a worktree limpa. A etapa usou somente a stack local isolada `sb-sentinel-20261111`.
- **D-728 (A86).** Os seis casos falharam no build anterior: quatro interrupções do POST derrubaram os cadastros para a fronteira de erro; duas recusas de validação devolveram mês e limites aos padrões, perdendo o preenchimento. O estado compartilhado agora guarda só os campos editados e trata a exceção. O reset nativo é cancelado porque também trocava o seletor da Shopee para ML na falha. No sucesso, as props atualizadas do servidor voltam a fornecer os valores. Isso preserva a limpeza das metas e da alíquota e permite restaurar os campos dos limites sem sair da página.
- **Validação.** Passaram as seis regressões, com banco intacto na falha e escrita na nova tentativa. Elas conferem mês, data, valores monetários e percentuais normalizados, observação, marketplace e os nove limites. O caso dos limites inclui salvar e voltar aos padrões, com os próprios campos atualizados. Passaram os 39 casos Chromium de transporte da Central, Central, Configurações, configuração de Reposição e troca de tela. Check passou nas 37 tarefas; build, as sete guardas da CI e docs também passaram. ESLint e Playwright rodaram em sequência.
- **Conferência visual e limpeza.** Os quatro avisos foram conferidos em desktop e celular, e o detector Impeccable não apontou problemas nos dois componentes. As fixtures usam meses e vigências futuras, com nota única, e são removidas no fim; os limites anteriores são restaurados. A consulta final confirmou zero metas gerais, zero metas por marketplace, zero alíquotas e zero limites na organização do seed. Não houve mudança de schema, ações de servidor ou fórmulas.
- **Inventário e próxima etapa.** Os quatro formulários diretos de `useActionState` da Central estão cobertos. O componente compartilhado `RemoverComConfirmacao` recebe a ação por prop e usa `<form action>`: há quatro operações nas páginas de Metas e Limites (três remoções e voltar aos padrões). Reproduzir a interrupção nesses caminhos antes de alterar. CI dos novos commits, publicação e validação com tráfego real seguem no [plano](PLAN.md).

### 18/11/2026 · Revisão da missão, corte de banco e confirmação da Central

- **Base e limites.** Sentinel em `010c252d`, nove commits além da remota; main remota `d6169205`. Preservadas pasta original e worktrees de compras/banco. Inventário readonly: 24 refs, 31 worktrees e 17 PRs. PR328 verde não cobre os commits locais nem PR330/331. Há colisões D-720–D-725 e 17 migrations candidatas das três frentes; nenhuma foi aplicada remotamente nesta etapa.
- **Relatório apresentado antes de alterar.** [Estado e finalização](STATE_AND_COMPLETION_2026-11-18.md) e [43 entregas](CLOSURE_INVENTORY.json), com critérios, pesos, responsáveis, evidências, dependências e cinco fases. ROADMAP bruto: 300 checkboxes, 261 marcados, 7 parciais e 32 abertos; agregados/duplicatas/futuros impedem usar esse total como fechamento. CLI `node scripts/report-closure-progress.mjs` calcula o inventário e recusa IDs/estados/pesos inválidos.
- **Infra atual.** API 200, Run Ready com 100% em api-00039-22b/worker-00058-mbc, código dc69d1fb; Vercel d6169205/deployment dpl_6zpmnqQQ1ibHguhxkq2Snfq24zv7, login 200 e CSP da VM. VM sb-db RUNNING, e2-standard-2/50GB, Supabase hospedados inativos. A frente de banco registra restauração do backup de 22/10 e corte em 18/11; login real, recuperação e catálogo da VM não foram revalidados aqui. SSH não passou da confirmação de identidade do host; não desativamos essa verificação. Dev GCP negou acesso.
- **Riscos comprovados.** 18 agendamentos habilitados, oito últimos status14; sete filas RUNNING; cinco buckets; nenhum uptime check ou política Monitoring observados. Snapshot policy anexada, mas nenhum snapshot/diario no corte antes da primeira rodada. VM única/HTTPS provisório, SMTP e pipeline de migrations pendentes. Billing429 impede custo realizado; estimativa mais recente da outra frente é US$90–105/mês. GitHub main protected=false, sem checks obrigatórios/rulesets. Não houve alteração dessas configurações.
- **Bancos.** Free não comporta a medição histórica restaurada de 1092MB. Neon Launch compras foi consultado readonly: cerca de 8MB/sete tabelas; não é réplica V3. Preservados PR331, otimizações R1–R5 e projeto Neon. A decisão de novo provedor fica condicionada a custo total e compatibilidade comprovados, sem outro corte nesta sessão.
- **D-729/A87.** Os quatro testes falharam no build anterior: remover meta geral, meta Shopee, alíquota e voltar aos padrões substituía a confirmação pela fronteira de erro. O componente compartilhado trata a exceção com useActionState; conserva a confirmação/IDs, avisa para conferir antes de repetir, não repete automaticamente e bloqueia Cancelar durante envio. As ações de servidor e RLS não mudam.
- **Verificação.** Passaram os 43 E2E relacionados; os quatro novos passaram novamente com capturas e, após ajustar a tipagem da limpeza, em repetição final. Uma resposta segurada confere os dois controles bloqueados; as consultas conferem nenhuma escrita no POST bloqueado e o resultado da nova tentativa. Alertas legíveis em desktop e celular; alíquota foi recapturada após estabilizar o scroll horizontal. Detector estático TSX sem achados, limitado a regex. Check: 37 tarefas; build: 10 tarefas; sete guardas e docs:check passaram. As primeiras passagens encontraram tipagem/assertions/throw no finally da fixture e excesso do HANDOFF; foram corrigidos e os comandos repetidos. Histórico multicanal movido para archive, sem ampliar o budget.
- **Auditoria de dependências.** O comando no corte alto continua retornando 1: três moderados (uuid/dois Next) e um alto picomatch. GHSA-fc5q-39xc-vjpf foi retirado hoje e versão4.0.8 indicada pelo registry não está publicada; nenhuma dependência foi alterada e nenhum aviso suprimido. Não houve demonstração de exploração no app. Evidências/fontes no relatório; atualização Next e investigação uuid ficam registradas para revisão.
- **Estado local e progresso.** Consulta após os testes: zero metas gerais, metas por marketplace, alíquotas e limites na organização seed. A87 fecha F04: 127→129 de 226 pontos (56,2→57,1%); 21→22 de 43 entregas (51,2% simples). Fase3: 81/108=75%. Nenhum outro crédito foi dado por documentos ou commits. Publicação/validação seguem abertas.
- **Próxima tarefa.** Revisão integrada PR330/331 e correções locais: contratos, decisões únicas e ordem/compatibilidade das 17 migrations. Depois preparar CI exata e caminho de migrations da VM. Recuperação real, proteção main, políticas destrutivas, contratação, merge e deploy dependem das autorizações/atos do dono. Não houve push, merge, deploy ou escrita de negócio real nesta sessão.


### 18/11/2026 · Recusa do banco nas confirmações da Central

- **Base e coordenação.** Sentinel em `31715480`, limpa ao retomar. A orientação nova do dono reserva pedidos de importação realizados, compras e reposição ao Claude. A revisão de integração #330 foi adiada; não houve alteração na branch/worktree dele, nesses módulos, em migrations ou lockfiles. `RemoverComConfirmacao` só tem consumidores nas duas páginas da Central.
- **D-730/A88.** Quatro regressões falharam no build anterior: abrir a confirmação como GESTOR, mudar o papel para OPERADOR e confirmar não mostrava resultado da recusa. As ações ignoravam o erro e as linhas afetadas do DELETE. Agora o próprio DELETE devolve apenas a chave afetada; o servidor retorna aviso ou null no sucesso. Erro e zero linhas não revalidam consumidores. O componente mostra a recusa e conserva o tratamento de transporte de D-729, sem repetição automática nem detalhes internos do banco. RLS e filtros de alvo não mudam; não há leitura prévia adicional.
- **Regressões.** Os quatro casos de acesso reaproveitam as fixtures dos quatro de transporte. Conferem o papel efetivamente alterado, resposta da ação, linha intacta, aviso e controles disponíveis; restauram o papel antes de uma tentativa autorizada e também no finally. A tentativa autorizada remove/restaura e o foco de Cancelar continua correto. Oito contratos cobrem erro do banco, zero linhas, sucesso com invalidação, tabela fora da lista e sessão sem organização.
- **Verificação.** Passaram os oito casos de confirmação isolados e os 47 Chromium relacionados de Central, Configurações, configuração de Reposição e navegação. Check passou nas 37 tarefas (web: 136 arquivos/1464 testes); build passou nas dez tarefas. Sete guardas e docs:check passaram. Alertas conferidos em desktop e celular; detector estático TSX sem achados, com a limitação de regex registrada pelo próprio comando. Capturas temporárias foram retiradas do spec antes do check final.
- **Estado local.** Só foi usada a stack `sb-sentinel-20261111`, portas56321/56322. Consulta após a suíte: zero metas gerais, metas por marketplace, alíquotas e limites no seed; papéis ADMIN1 e GESTOR1 restaurados. Eventos de auditoria dos testes são preservados. Não houve verificação remota nova, deploy, merge, push ou escrita em produção.
- **Progresso e próximo passo.** F04 recebeu evidência adicional sem novos pontos: permanece129/226 (57,1%;22/43 entregas). Próxima reprodução segura em Usuários: `changeMemberRole`, `revokeAccountAccess` e `revokeShopeeShopAccess` verificam erro, mas não linhas afetadas. Diferenciar recusa por autorização de operação já satisfeita antes de corrigir. Publicação, recuperação operacional e integração das outras frentes continuam no plano.


### 18/11/2026 · Confirmação real de papel e revogações em Usuários

- **Base e coordenação.** Retomada em `6396e597`, Sentinel limpa. Compras, pedidos de importação realizados, reposição, branch/worktree e migrations do Claude foram preservados; lockfiles também não mudaram. Só foi usada a stack local `sb-sentinel-20261111`, portas 56321/56322.
- **D-731/A89.** Cinco casos falharam no build anterior após conferir o estado do banco: perda de autorização antes da troca de papel, revogação ML e revogação Shopee; concessão ML/Shopee já removida por outra sessão. As três ações só olhavam erro e retornavam ok=true com zero linhas. Agora UPDATE/DELETE devolvem somente user_id; zero linhas retorna aviso não confirmado e não revalida Usuários. O aviso menciona alvo já removido ou permissões alteradas, sem inventar a causa. Filtros, RLS, guarda do último ADMIN e concessões por INSERT não mudam. Não há consulta prévia adicional.
- **Regressões e fixtures.** Os cenários de autorização perdida criam um ADMIN local de reserva para respeitar a guarda de lockout. Conferem dados após o POST, aviso e controles disponíveis; restauram o operador e confirmam a tentativa autorizada. Os cenários já removidos conferem ausência e releitura, sem atribuir a situação automaticamente à permissão. Finally restaura papéis/concessões, remove o membro de reserva e sua conta Auth; auditoria permanece append-only. Treze contratos cobrem zero linhas, sucesso/filtros, erro de autorização, erro inesperado e a orientação do último ADMIN.
- **Histórico.** A suíte ampliada expôs uma suposição antiga: havia várias células "entrou como ADMIN", e entradas iniciais podem sair da janela de 50 eventos. O teste agora confirma os dois eventos originais do seed no banco, produz duas mudanças conhecidas e compara a janela exibida com uma consulta limitada a 50. A leitura de auditoria usa ADMIN autenticado, pois a service_role não tem SELECT nessa tabela. Nenhum grant foi ampliado nem evento apagado. A primeira compilação também apontou tipagem de dados nullable capturados pelas fixtures; foram usados valores já conferidos e inserção só quando a concessão falta.
- **Verificação.** Passaram os cinco casos isolados, treze contratos e os 40 casos Chromium relacionados de Usuários, Configurações e navegação, incluindo o histórico corrigido. Check passou nas 37 tarefas (web: 137 arquivos/1477 testes); build nas dez tarefas, sete guardas e docs:check passaram. Avisos conferidos em desktop e celular; capturas temporárias retiradas do spec antes das verificações finais.
- **Limpeza e progresso.** SQL final: um ADMIN e um GESTOR, zero contas Auth de reserva, zero concessões ML/Shopee no seed. A evidência de F03 foi ampliada, sem novos pontos: 129/226=57,1% (22/43 entregas). Não houve verificação remota nova, migration, merge, push ou deploy.
- **Próxima ação.** Reproduzir `updatePreference` e `deletePreference` em regra excluída por outra sessão, antes de alterar: ambas só conferem erro. Publicação/aceite operacional e integração das frentes reservadas continuam nas condições do plano.

### 18/11/2026 · Checkpoint Gemini Sentinel (D-732 a D-737)

- **Escopo e isolamento.** Trabalho realizado exclusivamente na branch `agent/gemini-sentinel` (`.worktrees/gemini-sentinel`, base `codex/sentinel-audit` `76a27296`), com stack Supabase isolada em `127.0.0.1:56421/56422` (`sb-gemini`). Sem alterações em `codex/sentinel-audit`, `v3`, `main`, nem nos módulos/branches/worktrees reservados ao Claude Code (`/compras`, `/reposicao`, `feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`). Sem push, merge ou escrita em produção/Dev.
- **Entregas locais commitadas (`679cd74d..8af66328`).**
  - `679cd74d` (`D-732`): Notificações e Preferências confirmam linhas afetadas via `.select(...)` e limpam erros de modal ao cancelar/Esc (`PreferenceRow`);
  - `4c493535` (`D-733`): Sugestões e Atendimento — `updateSuggestionStatus` rejeita zero linhas sem `revalidatePath`, `<SuggestionDetail key={selecionada.id} ...>` evita estado residual entre itens, mais correções em conhecimento/templates/triagem;
  - `5e55e5dc` (`D-734`): `resolveMlAccountRead` em `apps/worker/src/handlers/ml-account-read.ts` aplicado a 10 handlers ML e `ml-token.ts`, separando falha transitória do banco de conta/credencial ausente;
  - `c55ae28d` (`D-735`): `confirmAndEnqueueApply` em `apps/api/src/confirm-import-apply.ts` para `erp-import` e `nfe-import`, evitando corrida dupla e revertendo `APPLYING` se o enqueue falhar;
  - `5b26f5fe` (`D-736`): `apps/worker/src/chunk.ts` (`LOOKUP_CHUNK = 200`), paginação `readAllPages` em `erp-import-apply` e `measure-decision-outcomes` e memoização `snapshotBySku`;
  - `8af66328` (`D-737`): atualização do Next.js `16.4.1 -> 16.4.6` eliminando `GHSA-mfr8-8qww-v76h` e `GHSA-vc7v-qv4w-wrv8`.
- **Verificação pós-`8af66328`.**
  - Banco, build e análise estática (`task-699`): `supabase db reset --no-seed`, `@sb/db run test:integration` (11 arquivos, 1.160 testes), `check:embeds` (39 projeções aceitas), `pnpm run check` (37/37 tarefas: web 139/1.489, worker 68/1.042, api 39/513, domain 43/690, mercado-livre 14/161, shopee 8/36, db 6/28, observability 3/35, contracts 1/10, tiktok-shop 1/10), `pnpm run build` (10/10 tarefas), 7 guardas estáticas web e `pnpm audit --prod --audit-level high` (código 0; apenas 1 moderado transitivo em `uuid <11.1.1` via `gaxios`/`exceljs`).
  - Playwright E2E: na suíte completa (`task-704`), 371 passaram em `chromium`, 2 falharam por timeout de 5s sob carga contínua (`faturamento-multicanal.spec.ts:99` e `sugestoes.spec.ts:122`), causando skip dos 20 testes de `loja-live` (`dependencies: ["chromium"]`). Em reexecução limpa (`task-723`) após reset/seed: os 2 specs passaram em `chromium` (13/13 em 33,7s) e `--project loja-live --no-deps` passou integralmente (20/20 em 55,7s).
- **Checkpoint e retomada.** Progresso de fechamento preservado em `129/226 = 57,1%` (`22/43` entregas), sem promover itens para publicado/validado em produção. Guia detalhado de retomada para o Codex registrado em [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 18/11/2026 · Continuidade Gemini Sentinel (D-738 a D-741)

- **Escopo e isolamento.** Trabalho mantido em `agent/gemini-sentinel` (`.worktrees/gemini-sentinel`), na stack Supabase isolada `sb-gemini-sentinel` (`127.0.0.1:56421/56422`), preservando `codex/sentinel-audit` (`76a27296`), `v3` (`9642d921`), `main` e toda a frente do Claude Code (`/compras`, `/reposicao`, `feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`). Sem push, merge, deploy ou escrita remota.
- **Entregas locais commitadas (`4747086f..fb4a8e1f`).**
  - `4747086f` (`D-738`): detectores diários do worker (`detect-sales-anomaly-actions.ts` e `detect-support-pattern-actions.ts`) passam a paginar `get_sku_sales_baseline`, `get_sku_correlated_events`, `get_sku_average_prices` e `support_case_links` além de 1.000 linhas com ordenação determinística, lotes `.in` de 200 e descarte do sinal parcial de SAC em erro de lote; reproduzido pré-correção (`4 failed | 19 passed`) e aprovado em `@sb/worker` (`68` arquivos / `1.048` testes).
  - `2508aa70` (`D-739`): leitura da página `/diagnostico` extraída para `apps/web/lib/diagnostico-leitura.ts` (`lerBaselineDoDiagnostico`, `lerEvidenciasDoDiagnostico`, `lerPrecosMediosDoDiagnostico`), reusando `lerPaginasDaRpc` com `{ count: "exact" }` apenas em `offset === 0` e lotes paralelos `.in` de 200 para SAC; reproduzido (`4 failed | 1 passed`) e aprovado com 5 contratos + `diagnostico.spec.ts`.
  - `92357ea6` (`D-740`): extraído `useLeituraDeGaveta` (`apps/web/components/drawer.tsx`) para as 4 gavetas de inspeção e protegidas as ações/painéis de `action-card.tsx`, `diagnosis-panel.tsx`, `vincular-anuncio.tsx` e `relist-panel.tsx` em `try/catch/finally`; reproduzido (`3` falhas E2E) e aprovado (`40/40` nos 6 specs selecionados).
  - `fb4a8e1f` (`D-741`): extraídos `lerTokenDeSessao` e `confirmarAplicacaoNaApi` (`apps/web/lib/chamar-api.ts`) e `iniciarConexaoOAuth` (`apps/web/app/(app)/contas/iniciar-conexao.ts`), protegendo `getSession()` e leitura JSON/`authorizationUrl` em `connect-button.tsx`, `shopee-connect-button.tsx`, `importacoes/[id]/confirm-apply-form.tsx`, `notas-fiscais/[id]/confirm-apply-form.tsx` e `reply-form.tsx` do SAC; reproduzido e validado em `e2e/contas.spec.ts` (ML + Shopee com resposta `200 OK` HTML).
- **Verificação completa pós-`fb4a8e1f`.**
  - Banco: `supabase db reset --no-seed`, `@sb/db run test:integration` (`11` arquivos / `1.160` testes), `check:embeds` (`39` projeções aceitas).
  - Monorepo e web: `pnpm run check` (`37/37` tarefas: `@sb/web` 140/1.494, `@sb/worker` 68/1.048, `@sb/api` 39/513, `@sb/domain` 43/690, `@sb/mercado-livre` 14/161, `@sb/shopee` 8/36, `@sb/db` 6/28, `@sb/observability` 3/35, `@sb/contracts` 1/10, `@sb/tiktok-shop` 1/10), `pnpm run build` (`10/10`, `Next.js 16.4.6`), 7 guardas estáticas web (`111`/`26`/`46`/`428`/`56`/`193`/`17` termos) e `pnpm audit --prod --audit-level high` (código `0`, 1 moderado transitivo em `uuid`).
  - Playwright E2E completo (após `db reset --no-seed` + `e2e:seed`, com `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080`): **397 passed (18.2m)** nos projetos `chromium` e `loja-live` (zero falhas, zero skips).
- **Progresso e pendências.** Progresso segue em `129/226 = 57,08%` (`22/43 = 51,16%`), restando `42,92%` (`97/226` pontos) condicionados às portas externas/atos do dono (branch protection, pipeline de migrations na VM `sb-db`, backup/restore, alertas Monitoring, SMTP/Auth, `P02` na VM e deploy coordenado) além da revisão integrada de PR #330/#331. Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Guarda de versão no início da leitura de NF-e

- D-748/A102 parte de `70d661e3` na branch `codex/sentinel-audit`. Sete cenários reproduziram a leitura do bucket ou a substituição de itens a partir de estado vencido, de nota lida ou de nota cancelada. Agora a transição para `PARSING` exige o status e o timestamp lidos. A próxima entrega relê o documento após perder a transição, e uma retentativa com versão atual de `PARSING` ainda recupera trabalho interrompido.
- Validação local. Os sete cenários passaram e o parser totalizou 30 testes. Em Postgres isolado, o papel `service_role` comprovou que o filtro preserva `APPLYING` e que o trigger atualiza a versão em `PARSING` para `PARSING`. As fixtures foram revertidas. `pnpm run check` passou em 37 tarefas com 1.073 testes no worker. `pnpm run build` passou em 10 tarefas.
- Progresso técnico de 134/226 pontos (59,3%) e 23/43 entregas por contagem (53,5%). D-748 amplia a evidência de B02. O recorte desta etapa inclui somente NF-e no worker e documentação Sentinel.
- Próxima investigação. Reproduzir a sobreposição se duas leituras já tiverem entrado em `PARSING`. O parser do UpSeller/ERP tem uma atualização inicial incondicional da mesma família, a verificar com os contratos próprios de reenvio. Integração documental e portas operacionais seguem no [plano](PLAN.md).

### 19/11/2026 · Retomada do Gemini e aplicação completa de NF-e

- Localizei `agent/gemini-sentinel` limpa em `58fc91fb`, com 18 commits sobre `76a27296`. Avancei `codex/sentinel-audit` por fast-forward na worktree Sentinel. Preferências, Sugestões, Atendimento, OAuth, Copiloto, paginação, Next e importações de D-732 a D-746 já tinham cobertura registrada. O Gemini relatou 397 E2E e 1.160 testes de integração nesse conjunto. Preservei as worktrees e branches do Gemini e do Claude.
- D-747/A101 reproduziu três conclusões indevidas depois de ler documento com cabeçalho integralmente vinculado. Itens a menos, a mais ou sem SKU levavam a `APPLIED`. O worker agora exige correspondência entre o cabeçalho e os itens paginados antes do ledger. Divergência retorna falha retentável e a reentrega relê a nota. Se a divergência persistir após as tentativas, o caso exige investigação operacional. Teste de recuperação registrou somente os dois movimentos esperados. Essa etapa não altera migrations, lockfiles ou arquivos de compras/reposição.
- Os três casos falharam antes da correção. Passaram 85 testes de parse/apply de ERP e NF-e e o check de 37 tarefas, incluindo 1.065 testes do worker. O build passou nas dez tarefas. A auditoria de dependências de produção no corte alto saiu com código 0 e um aviso moderado. Os resultados do E2E completo acima são do Gemini. A retomada executou regressões no worker.
- Conferi `main` remota e alias Vercel READY em `f2eb787c`, incluindo #330/#332. O run de compras registra 1.197 testes SQL e 342 E2E. #333 documenta 17 versões na VM e restauração isolada. Conferi snapshot automático READY, prefixo diário vazio, 18 agendamentos habilitados com dois últimos códigos 14 e revisões Run mantidas. A `main` continua sem proteção ou rulesets. #331 aberto em `db695e82`.
- F05 passou a Publicado. Fechamento técnico de 129 para 134 pontos de 226 (57,1% para 59,3%), com 23 de 43 entregas (53,5%) e 40,7% restante pelo peso. B02 ganhou evidência de NF-e com o mesmo peso. Dump recorrente, alertas, SMTP e publicação conjunta continuam pendentes.
- A simulação de integração de `58fc91fb` com `f2eb787c` apontou conflitos em DECISIONS, índice e HANDOFF, com colisão D-720 a D-725. Próxima reprodução no worker é a corrida entre a leitura de estado e a entrada em `PARSING`. Revisar a integração documental numa etapa própria. Consultas remotas somente leitura.

### 19/11/2026 · Continuidade Gemini Sentinel (D-742 a D-746)

- **Escopo e isolamento.** Trabalho mantido em `agent/gemini-sentinel` (`.worktrees/gemini-sentinel`), na stack Supabase isolada `sb-gemini-sentinel` (`127.0.0.1:56421/56422`), preservando `codex/sentinel-audit` (`76a27296`), `v3` (`9642d921`), `main` e toda a frente do Claude Code (`/compras`, `/reposicao`, `feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`). Sem push, merge, deploy ou escrita remota.
- **Entregas locais commitadas (`c39f7114..048b9774`).**
  - `c39f7114` (`D-742` / `A96`): `relist-prepare.ts` avalia `evaluateRelistPreflight` antes do `INSERT` (nascendo atomicamente em `PREFLIGHT_FAILED` ou `REQUESTED`, sem ficar preso em `REQUESTED` após falha de `UPDATE` + `23505`), checa operação ativa antes de consultar o ML e retenta erros transitórios do multiget (`undefined`, `429`, `5xx`); reproduzido pré-correção (`3 failed | 18 passed (21)`).
  - `fec9d87a` (`D-743` / `A97`): Copiloto API — `runSkuReplenishment` filtra `replenishment_settings` pelos até 3 escopos (`D-680`), `structure_feature_suggestion` valida `ADMIN`/`GESTOR` antes de gastar Anthropic, `runSuggestSupportReply` lê as 40 mensagens mais recentes do SAC (`desc` + `reverse`, deduplicando `skuIds`) e `runCopilotChat` suprime `done` após teto de rodadas e protege `emit` desconectado mantendo `ai_runs`; reproduzido pré-correção (`4 failed | 65 passed (69)`).
  - `d8a50aca` (`D-744` / `A98`): API uploads/convites/rotas — `receiveUpload` e `receiveNfeUpload` tratam `existing.error !== null` como `{ status: "error" }` (`500 erroInterno`) antes do bucket e compensam falha de `enqueue` condicionalmente em `UPLOADED` (`DELETE` para registros novos; `FAILED` no reenvio NF-e); `invites.ts` deduplica `mlAccountIds`/`shopeeShopIds`; `app.ts` valida UUID em `/v1/ml-accounts/connect` e captura `parseBody()` malformado retornando HTTP 400; reproduzido pré-correção (`9 failed | 171 passed (180)`).
  - `e6786d2c` (`D-745` / `A99`): fecha o inventário de `getSession()` fora de `try/catch` nos 7 componentes cliente restantes da web (`usuarios/convidar.tsx`, `usuarios/reemitir-link.tsx`, `copiloto/chat.tsx`, `sugestoes/suggestion-detail.tsx`, `faturamento/calculadora-preco.tsx`, `importacoes/nova/upload-form.tsx`, `notas-fiscais/nova/upload-form.tsx`), protege `conferirLojas` e valida JSON em `convidar.tsx` preservando `inviteLink`, e extrai `extrairEventosSse` (`apps/web/lib/copilot-sse.ts`) com flush EOF/CRLF; +7 contratos unitários (`chamar-api.test.ts`, `copilot-sse.test.ts`).
  - `048b9774` (`D-746` / `A100`): handlers de parse/apply ERP e NF-e no worker (`erp-import-parse.ts`, `nfe-import-parse.ts`, `erp-import-apply.ts`, `nfe-import-apply.ts`) barram `APPLYING` nos parsers, checam `.error !== null` em todos os `DELETE`, `markRows` e `UPDATE` finais retornando `retryable: true` e paginam `document_items` via `readAllPages` em `nfe-import-apply.ts`; reproduzido pré-correção (`9 failed | 72 passed (81)`).
- **Verificação completa pós-`048b9774`.**
  - Banco: `supabase db reset --no-seed`, `@sb/db run test:integration` (`11` arquivos / `1.160` testes), `check:embeds` (`39` projeções aceitas).
  - Monorepo e web: `pnpm run check` (`37/37` tarefas: `@sb/web` 142/1.501, `@sb/worker` 68/1.061, `@sb/api` 39/526, `@sb/domain` 43/690, `@sb/mercado-livre` 14/161, `@sb/shopee` 8/36, `@sb/db` 6/28, `@sb/observability` 3/35, `@sb/contracts` 1/10, `@sb/tiktok-shop` 1/10), `pnpm run build` (`10/10`, `Next.js 16.4.6`), 7 guardas estáticas web (`111`/`26`/`46`/`428`/`56`/`193`/`17` termos) e `pnpm audit --prod --audit-level high` (código `0`, 1 moderado transitivo em `uuid`).
  - Playwright E2E completo (após `db reset --no-seed` + `e2e:seed`, com `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080`): **397 passed (15.8m)** nos projetos `chromium` e `loja-live` (zero falhas, zero skips). Stack Supabase isolada encerrada ao final.
- **Progresso e pendências.** Progresso segue em `129/226 = 57,08%` (`22/43 = 51,16%`), restando `42,92%` (`97/226` pontos) condicionados às portas externas/atos do dono (branch protection, pipeline de migrations na VM `sb-db`, backup/restore, alertas Monitoring, SMTP/Auth, `P02` na VM e deploy coordenado) além da revisão integrada de PR #330/#331. Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Guarda de versão no UpSeller e ensaio após PARSING

- D-748/A102 está em `e997bc16`. D-749/A103 reproduziu cinco falhas no UpSeller, entre perda da transição e entregas tardias a lotes `PARSED`, cancelados ou com leitura prévia. O parser agora compara estado e versão antes da leitura. Foram validadas as reentradas legítimas de `PARSING` e `FAILED` sem `parsed_at`.
- Validação de D-749. Antes da correção, 5 testes falharam e 15 passaram no parser ERP. Depois, passaram 100 testes nos quatro handlers de ERP e NF-e, 37 tarefas no check (1.080 testes no worker) e 10 no build. O Postgres isolado confirmou as duas condições da atualização de `erp_import_batches` com o papel `service_role`.
- A104 reproduziu em Postgres a ordenação das operações da NF-e. A segunda entrega pode iniciar com o `updated_at` atual de `PARSING`. Se o primeiro job terminar, a exclusão pelo ID ainda encontra os itens do documento já `PARSED`. As evidências são de uma simulação SQL com rollback. O teste de requisições concorrentes completas e a gravação atômica vinculada à versão são o próximo passo.
- O fechamento técnico segue em 134/226 pontos (59,3%), com 23/43 entregas (53,5%) e 40,7% por peso a concluir. B02 recebeu evidências locais. As duas correções ficaram na branch Sentinel, com o escopo de compras e reposição preservado. A integração documental, o #331 e as validações operacionais seguem pendentes no [plano](PLAN.md).
- Após `493da74b`, a referência local `origin/main` estava em `f243b7c1` (#334/D-765). A simulação com `git merge-tree` encontrou conflitos apenas em DECISIONS, DECISIONS_INDEX e HANDOFF. O resultado simulado da aplicação de NF-e conserva a guarda D-747 e a saída para Full de D-765. Ainda é preciso testar o fluxo integrado. O Supabase Dev `nmgccyqquwxecqffsidr` retornou `INACTIVE` no MCP. A futura migration de A104 exige validar em Dev e coordenar os tipos gerados com a frente Claude.

### 19/11/2026 · Persistência atômica da NF-e e reprodução no ERP

- D-750/A104 partiu de `0d43483e`. Duas execuções do handler reproduziram regravação de itens e regressão de `PARSED` para `FAILED` (2 falhas, 30 passaram). A RPC `persist_nfe_parse` protege a substituição de itens e a mudança de estado com a versão retornada em `PARSING`. A mesma versão limita as atualizações que registram erros de leitura.
- A migration `20261119094000` aplicou e reaplicou em reset da stack isolada. Passaram 102 testes focados no worker e 1.163 de integração em 12 arquivos no banco limpo, com dois workers. Os novos testes enviaram versões concorrentes via PostgREST, verificaram 1.001 itens sem vínculo, rollback ao rejeitar o cabeçalho e execução restrita a `service_role`. A primeira rodada completa teve timeouts e falhas em cascata. O teste limpo passou em todos os casos.
- O Supabase Dev retornou `INACTIVE`. A migration ainda precisa ser aplicada e renomeada a partir do registro em Dev antes de atualizar o worker que usa a RPC. Os tipos compartilhados de compras foram preservados com um contrato local no worker, a remover na regeneração coordenada.
- A105 reproduziu no Postgres isolado a remoção de staging e a regressão de `APPLYING` para `FAILED` após duas entradas em `PARSING` no UpSeller/ERP. O próximo passo é testar e proteger as saídas de erro do handler e medir a gravação atômica para planilhas com o limite existente de 25 MiB. A integração documental com a `main` segue no [plano](PLAN.md).
- O check passou em 37 tarefas, com 1.082 testes do worker. O build passou em 10 tarefas e `docs:check` concluiu. A comparação com a frente Claude encontrou interseção somente nos arquivos de decisões e handoff. Código, tipos e migrations de compras ficaram fora da mudança.
- Progresso de 134/226 pontos (59,3%) e 23/43 entregas por contagem (53,5%). D-750 acrescenta evidência local a B02.

### 19/11/2026 · Erros do parser ERP vinculados à versão

- A partir de `40771b17`, D-751 reproduziu dois casos em que uma execução anterior do UpSeller podia sobrescrever o lote `PARSED`. Um falhava no bucket e o outro recebia uma planilha sem cabeçalho compatível. Ambos agora exigem a versão obtida quando a execução entrou em `PARSING` para marcar `FAILED`. A tentativa original continua elegível para retentativa se o erro for transitório ou se o registro do erro falhar.
- Reproduzido com 2 falhas e 20 testes verdes no parser ERP. Após a correção passaram 104 testes focados, 1.084 testes do worker no check de 37 tarefas, 10 tarefas no build e `docs:check`. Trabalho local na Sentinel, sem migration para D-751.
- A105 permanece aberto para a troca das linhas e snapshots. O próximo ensaio deve preservar o processamento em lotes que atende planilhas de até 25 MiB e usar a versão para publicar a conferência inteira. D-750 continua aguardando Dev. A integração documental segue na fila. O fechamento técnico se mantém em 59,3%.

### 19/11/2026 · Publicação atômica da conferência ERP

- D-752 conclui A105 localmente a partir de `55802bf9`. Uma execução antiga e válida conseguiu publicar uma linha após a tentativa mais nova publicar duas (1 falha e 22 testes verdes). A leitura agora envia blocos privados vinculados à versão. A publicação atualiza linhas, snapshots e lote na mesma transação, com agregação em SQL. Qualquer tentativa superada perde o direito de escrever.
- A migration `20261119101000` foi aplicada e reaplicada em reset local. Via PostgREST, uma fixture de 23.924 linhas normalizadas passou em 24 blocos. Duas publicações concorrentes produziram um único resultado. O teste de posição ausente confirmou rollback de linhas e snapshots. Também passaram o caso vazio e a verificação de permissões. O ensaio começou nas linhas normalizadas.
- Passaram 105 testes focados, 1.085 testes do worker no check de 37 tarefas, 10 tarefas no build, `docs:check` e 1.167 testes SQL em 13 arquivos na stack limpa. O Supabase Dev `nmgccyqquwxecqffsidr` está `INACTIVE`. D-750 e D-752 aguardam aplicação em Dev e regeneração dos tipos em coordenação com compras. O código e as migrations do Claude ficaram fora da alteração.
- A simulação com `f243b7c1` manteve os conflitos em DECISIONS, DECISIONS_INDEX e HANDOFF. O próximo passo local é preparar a integração D-720–D-725 e depois testar D-747 com D-765. O fechamento técnico permanece em 134/226 (59,3%), com 23/43 entregas.

### 19/11/2026 · Proteção contra IDs duplicados na integração documental

- D-753/A106 parte de `b1c305f2`. Em cópia temporária, inserir outro `D-720` na fonte com o índice original fez `docs:check` passar. O gerador também passou e sobrescreveu o índice. Após a correção, os dois comandos rejeitam a duplicidade. O gerador preserva o índice existente e a checagem também rejeita repetição apenas no índice.
- Na fonte válida, foram indexadas 655 decisões. Passaram a checagem dos dois scripts, `docs:check`, o check de 37 tarefas e o build de 10 tarefas.
- A próxima ação é reconciliar os seis IDs D-720–D-725 da Sentinel com as decisões já publicadas de compras, revisar as referências e testar a integração com D-765 em checkout isolado. As migrations de D-750 e D-752 seguem pendentes em Dev. Fechamento técnico de 59,3%.

### 19/11/2026 · Integração local do #335 e reconciliação documental

- A `main` avançou de `f243b7c1` para `1ff173ca` com D-766 (#335). Foi integrado o corte Sentinel `1ca93157` em `codex/sentinel-integration-20261119`. O corte resolveu DECISIONS, DECISIONS_INDEX e HANDOFF. Os 634 registros da base publicada conservaram o texto e o número. O índice final contém 668 decisões únicas.
- Os IDs Sentinel originais D-720, D-721, D-722, D-723, D-724 e D-725 passaram respectivamente a D-754, D-755, D-756, D-757, D-758 e D-759. Foram alinhadas as referências correntes e os comentários dos specs. Entradas históricas deste log conservam o ID vigente no commit de cada sessão.
- O formulário de compras e o spec de pedido de compra permanecem byte a byte no corte publicado. O ajuste de transporte de compras de D-757 permanece na branch Sentinel de origem até coordenação com Claude. Seu ajuste de NF-e integra o candidato local. Nenhum arquivo ativo de código, migration ou tipos da frente Claude mudou neste recorte.
- A regressão de D-747 foi exercitada para NF-e e envio ao Full de D-765. Uma leitura incompleta retorna falha retentável sem movimento. A nova entrega completa gera as duas saídas `SAIDA_DOCUMENTO` no caso Full, com as chaves por item. Check de 37 tarefas verde, com 1.086 testes no worker, 545 na API e 1.547 na web. Build de 10 tarefas verde. A suíte local aplicou 324 migrations no reset e passou 1.204 testes de banco em 15 arquivos. O reset separado com seed passou 8 E2E de NF-e e compras.
- O Supabase Dev `nmgccyqquwxecqffsidr` continua inativo. D-750 e D-752 aguardam aplicação em Dev e regeneração dos tipos. O #331 foi inventariado em `db695e82`: traz o índice de Full `20261117182500` e a retenção de `job_runs` em `20261117182600`. Seus IDs D-720/D-721 ainda colidem com compras. Próximo passo é revisar as duas migrations em recorte próprio da Sentinel antes de CI e de qualquer publicação. Progresso de 134/226 pontos (59,3%) e 23/43 entregas.

### 19/11/2026 · Recorte de banco do #331 validado localmente

- O recorte em `codex/sentinel-db-331-20261119` parte de `849e4b78` e incorpora apenas as duas migrations e o teste de `5d647eb5`. A branch do #331 segue em `db695e82`, aberta contra `codex/sentinel-audit`. Os IDs do recorte passaram a D-767 e D-768. Os IDs publicados de compras foram preservados.
- D-767 trocou os dois índices da timeline do Full por um índice unique na ordem mista, em DDL transacional com limite de espera por bloqueio. A duplicata retornou 23505 com todas as FKs habilitadas. O plano local confirmou `Unique → Index Scan` sem ordenação extra ao desabilitar a varredura sequencial no ensaio. A janela de bloqueio no banco de destino ainda exige medição.
- D-768/A107 reproduziu perda de `reconciled_at` no corte real do UpSeller (1 falha e 7 passaram com a proposta original). Após a correção, o expurgo conserva a última conclusão por organização e tipo inclusive quando houve falhas posteriores. A chave de serviço manteve INSERT, com DELETE e EXECUTE do expurgo negados. A migration deixou zero agendamentos do expurgo local.
- Passaram as 326 migrations no reset local, 1.212 testes de banco em 16 arquivos, 37 tarefas de check, 10 de build e `docs:check`. A stack Sentinel foi encerrada. D03 passou a Testado localmente e somou três pontos. Avanço de 134/226 (59,3%) para 137/226 (60,6%), com 24/43 entregas.
- Próxima ação é conferir a matriz de CI e comparar a sequência com o histórico da VM. `ci.yml` e `migrations-producao.yml` usam `db push` sem `--include-all`. As versões locais do #331 são de 17/11 e precedem a última registrada no corte da VM (`20261118211000`). O Dev segue inativo. Aplicação em Dev, versionamento a partir do registro, CI remota, produção e agendamento continuam pendentes.

### 19/11/2026 · Upgrade incremental, grants e bloqueio no Full

- D-769/A108 partiu de `b220f994`. A leitura `READ ONLY` na VM confirmou as 322 versões de `1ff173ca`, sem diferenças e com máxima `20261118211000`. O dry-run local no padrão da CI recusou `20261117182500` e `20261117182600`. A cópia descartável aplicou NF-e, ERP, índice Full e retenção em ordem, com os dois últimos reenumerados para `20261119101001` e `20261119101002` só no ensaio. O catálogo passou a 326 versões e o novo dry-run ficou sem pendências.
- D-768/A109 acrescentou a revogação de UPDATE, DELETE e TRUNCATE em `job_runs`. A VM tem os três grants diretos a `service_role`, com os gatilhos UPDATE e DELETE ativos e sem gatilho de TRUNCATE. Os catálogos mostraram zero grants por coluna de UPDATE e zero outros grants herdados de mutação para o papel. A fixture reproduziu os grants e comprovou a revogação, a preservação de SELECT/INSERT e das duas linhas antigas. Nenhum expurgo estava agendado na VM ou no ensaio.
- A tabela Full tinha estimativa de 346.394 linhas na VM. Nessa escala em Postgres isolado, D-767 concluiu em 549 ms sem concorrência. Sob bloqueio, abortou em 10,718 s com `55P03` e conservou a constraint e os dois índices anteriores. Após liberar a sessão, a reaplicação preservou todas as linhas e deixou um índice unique válido. As duas instâncias locais usadas no ensaio foram encerradas. [Benchmark](../PERFORMANCE.md#timeline-do-full-d-790-19112026)
- Passaram 1.213 testes de banco, 39 embeds do PostgREST, 15 E2E de Full e Saúde, 37 tarefas de check, 10 de build e `docs:check`. A CI de `1ff173ca` passou em check, scripts, banco de integração e Playwright, e falhou na aplicação de migrations porque o Dev estava pausado. A consulta ao Supabase confirmou `nmgccyqquwxecqffsidr` em `INACTIVE`. [Run 44530607960](https://github.com/PabloCoder1/speedbikers-gestao-v2/actions/runs/44530607960)
- Fechamento em 137/226 (60,6%) e 24/43 entregas. Próximas ações são registrar os timestamps definitivos quando o Dev estiver ativo, regenerar os tipos em coordenação com compras e validar a CI do candidato. O fluxo oficial ainda aponta ao Supabase hospedado. Reconciliação do destino, janela de migração na VM, publicação e agendamento seguem pendentes. A consulta online foi em leitura e a branch do Claude permaneceu no mesmo HEAD.

### 19/11/2026 · Continuidade Gemini Sentinel sobre `e0bedddf` (D-770 a D-772)

- **Sincronização e isolamento.** A branch `agent/gemini-sentinel` (`.worktrees/gemini-sentinel`) confirmou que sua rodada anterior (`58fc91fb`, D-732–D-746) já era ancestral estrita de `codex/sentinel-db-331-20261119` (`e0bedddf`) e acompanhou por fast-forward para `e0bedddf`. Nenhuma branch do Codex (`e524f346`, `f5df5ab4`, `e0bedddf`), nem a `v3` (`9642d921`), nem `origin/main` (`1ff173ca`), nem arquivos/migrations/worktrees/branches do Claude Code (`feat/compras-reposicao-inteligente`, `feat/importacoes-pedidos-ja-feitos`, `sentinel/custo-do-banco`) foram alterados. Sem push, merge, deploy ou escrita remota.
- **Entregas locais commitadas (`872d9079..9646d3e8`).**
  - `872d9079` (`D-770` / `A110`): endurecimento da API da D-766 — `document-items.ts` separa erro transitório de banco (`status: "failed"` / 500) de ausência real (`not_found` / 404) e exige `.select("id").maybeSingle()` nas três escritas (devolvendo 409 `rejected` se o documento saiu de `PARSED` antes da recontagem); `manual-exit.ts` fatia `.in("id", lote)` em blocos paralelos de 100 UUIDs (evita HTTP 414); `app.ts` valida `/^\d+$/` em `POST /v1/nfe-imports/:id/items/:itemId`. Reproduzido pré-correção (`7 failed | 126 passed (133)`).
  - `7f71c63d` (`D-771` / `A111`): endurecimento web da D-766 — fecha os 2 últimos `getSession()` sem proteção em cliente (`saida-manual-form.tsx`, `item-quantity.tsx`) via `lerTokenDeSessao`; valida JSON de `200 OK` (`respostaDeSaidaValida`, `respostaDeEdicaoDeItemValida`) impedindo falso sucesso em HTML 200; fatia `.in()` em lotes paralelos de 100 em `lerSaldos`, `importarLista` e `notas-fiscais/[id]/page.tsx`; envolve busca, saldos, importação e leitura de arquivo em `try/catch/finally`; suporta até 1.000 chaves distintas na importação sem marcar válidos > 300 como inexistentes; limita soma acumulada e protege `Enter`/`Escape` durante gravação. +3 contratos (`saida-manual.test.ts`, 9) e regressão E2E `D-771` em `nota-fiscal.spec.ts`.
  - `9646d3e8` (`D-772` / `A112`): endurecimento no worker — `shopee-stock.ts` pagina `shopee_order_items` e `stock_movements` além de 1.000 linhas via `readAllPages` (evita truncamento silencioso em pedidos grandes/kits que revertia SKU/quantidade errados em cancelamentos) e fatia `.in()` em 100 UUIDs / 200 pedidos; `ml-listings-fetch.ts` fatia `.in("item_id", ...)` em 200 para `inexistentes` e `itemIds`; `shopee-items-hydrate.ts` garante `soltar()` no `finally` com log `shopee_items_hydrate_unlock_failed` preservando a continuação (`temMais`). Reproduzido pré-correção (`5 failed | 51 passed (56)`).
- **Verificação completa pós-`9646d3e8`.**
  - Banco isolado (`sb-gemini-sentinel`, `127.0.0.1:56421/56422`): `supabase db reset --no-seed` (**326 migrations**), `@sb/db run test:integration` (**16 arquivos / 1.213 testes**), `check:embeds` (**39 projeções aceitas**).
  - Monorepo e web: `pnpm run check` (**37/37 tarefas**, **336 arquivos / 4.214 testes unitários**: `@sb/web` 147/1.550, `@sb/worker` 68/1.091, `@sb/api` 42/555, `@sb/domain` 46/738, `@sb/mercado-livre` 14/161, `@sb/shopee` 8/36, `@sb/observability` 3/35, `@sb/db` 6/28, `@sb/contracts` 1/10, `@sb/tiktok-shop` 1/10), `pnpm run build` (**10/10 tarefas**, `Next.js 16.4.6`), 7 guardas estáticas web (`115`/`27`/`52`/`542`/`59`/`206`/`17` termos), `pnpm audit --prod --audit-level high` (código `0`, 1 moderado transitivo em `uuid`) e `pnpm docs:check` (`674` decisões únicas).
  - Playwright E2E completo (após `db reset --no-seed` + `e2e:seed`, com `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e `NEXT_PUBLIC_API_URL=http://127.0.0.1:18080`): **401 passed (15.8m)** em `chromium` + `loja-live` (zero falhas, zero skips). Stack Supabase isolada encerrada ao final.
- **Progresso e retomada.** Fechamento técnico permanece em **137/226 = 60,6%** (**24/43 = 55,8%**), restando **39,4% (89 pontos)** nos gates de ambiente/publicação (Dev ativo para timestamps definitivos das 4 migrations, CI remota, proteção de `main`, pipeline de migrations para VM, backup/Monitoring/SMTP, `P02` na VM, estoque Shopee/TikTok e aceite pós-deploy). Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Continuidade Gemini Sentinel (D-773 a D-775)

- **Entregas locais commitadas (`61047db1..73f886e3`) sobre `3de8774f`:**
  - `61047db1` (`D-773` / `A113`): clientes HTTP dos marketplaces — `@sb/shopee` e `@sb/tiktok-shop` classificam HTTP `200` com HTML/corpo não-JSON como `ShopeeApiError`/`TikTokShopApiError` com `errorClass: "retryable"` (evitando abortar sync e suprimir pedidos/itens Shopee por 24 h como `fora_do_contrato`) e aplicam `query`/`params` antes dos parâmetros de credenciais/assinatura; `@sb/mercado-livre` cancela `response.body` antes do retry em `429`/`5xx` evitando vazamento de socket keep-alive. Reproduzido pré-correção (`5 failed | 43 passed (48)`).
  - `07c06d94` (`D-774` / `A114`): 7 rotas de exportação web (fora `/compras`) e CSV — `/anuncios/exportar`, `/curva-abc/export/xlsx` e `/precos/export/xlsx` falham fechado com HTTP `502` em erro de `ml_accounts`/`marketplace_accounts` (Curva ABC multicanal também deixa de consultar `ml_accounts` sem uso); rotas CSV devolvem `503` em erro de `get_current_membership` em vez de `403`; `csvCell` neutraliza fórmulas precedidas por espaço, tab ou CR (`/^[\t\r ]*[=+\-@]|^[\t\r]/`). Reproduzido pré-correção (`5 failed | 5 passed (10)`).
  - `73f886e3` (`D-775` / `A115`): segurança na API e resiliência no worker — `apps/api/src/auth.ts` lê `.limit(2)`, recusa usuário com 2+ organizações (`403`), devolve `503` em erro do banco ou 5xx/rede do Auth e exige Bearer `/^\S+$/`; `apps/api/src/oidc.ts` exige `email_verified === true` e Bearer estrito; `apps/worker/src/handlers/shopee-orders-sync.ts` envolve o unlock do `finally` em `try/catch` preservando erro original e enfileiramento de `seguintes`. Reproduzido pré-correção (`6 failed | 17 passed (23)`).
- **Verificação completa pós-`73f886e3`:**
  - Banco isolado (`sb-gemini-sentinel`, encerrado ao final): `supabase db reset --no-seed` (**326 migrations**), `@sb/db run test:integration` (**16 arquivos / 1.213 testes**), `check:embeds` (**39 projeções aceitas**).
  - Monorepo e web: `pnpm run check` (**37/37 tarefas**, **338 arquivos / 4.231 testes unitários**: `@sb/web` 148/1.555, `@sb/worker` 68/1.093, `@sb/api` 43/561, `@sb/domain` 46/738, `@sb/mercado-livre` 14/162, `@sb/shopee` 8/38, `@sb/observability` 3/35, `@sb/db` 6/28, `@sb/tiktok-shop` 1/11, `@sb/contracts` 1/10), `pnpm run build` (**10/10 tarefas**, `Next.js 16.4.6`), 7 guardas estáticas web (`115`/`27`/`52`/`542`/`59`/`206`/`17` termos), `pnpm audit --prod --audit-level high` (saída `0`, 1 moderado transitivo em `uuid`) e `pnpm docs:check` (`677` decisões únicas).
  - Playwright E2E completo (`chromium` + `loja-live` após `db reset --no-seed` + `e2e:seed`): **401 passed (15.7m)**, zero falhas e zero skips.
- **Isolamento e progresso.** Nenhuma branch do Codex (`e524f346`, `f5df5ab4`, `e0bedddf`), da `v3` (`9642d921`), da `origin/main` (`1ff173ca`) ou do Claude Code (`d451cfd9`, `24c8da20`, `db695e82`) foi modificada. Fechamento técnico permanece em **137/226 = 60,6%** (**24/43 = 55,8%**), faltando **39,4%** nos gates externos/publicação. Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Candidato integrado e regra de modelo (Codex Sentinel)

- `codex/sentinel-policy-20261119` partiu do checkpoint de banco `e0bedddf` com os commits do Gemini incorporados em avanço linear até `29ec52a1` (D-770–D-775). A política de modelo fica em `AGENTS.md` e o estado corrente em `docs/HANDOFF.md`.
- No candidato local, passaram 37 tarefas do check com 4.231 testes unitários, 10 tarefas do build e `docs:check`. Em worktree recém-instalada, compile os pacotes compartilhados antes do check para o lint resolver os tipos em `dist`. Os 401 E2E e 1.213 testes SQL do Gemini estão no checkpoint dele.
- O Supabase Dev `nmgccyqquwxecqffsidr` respondeu `INACTIVE`. As quatro migrations aguardam timestamps definitivos. A revisão remota e a CI do candidato antecedem qualquer integração à `main`.

### 19/11/2026 · Reconciliação da invoice de Compras com o Sentinel

- Base publicada `d3a9debb` (#337), integrada ao candidato `d45ce2e6` em `codex/sentinel-invoices-integration`. D-767 de Compras fica como publicada. O índice Full, anteriormente D-767 no Sentinel, passa a D-790. Os checkpoints históricos conservam o ID vigente à época. Código e migration de Compras mantêm o conteúdo da `main`.
- A CI do corte anterior #336 passou check, integração, Playwright e scripts. Este corte exige nova CI. A cópia isolada aplicou as 323 versões até a invoice. O dry-run recusou os quatro nomes originais. Com timestamps temporários `20261119120001` a `20261119120004`, o upgrade chegou a 327 versões e o dry-run final ficou limpo. Os SQLs e nomes no Git conservam o conteúdo original. Dev segue inativo; faltam timestamps definitivos e conferência dos destinos. Passaram 37 tarefas de check, 4.246 testes unitários, 10 tarefas de build e a checagem de documentação.

### 19/11/2026 · Correção de colunas da invoice incorporada ao candidato

- O corte b552bfd6 passou check, integração, Playwright e scripts na CI do #336. Em leitura na VM, a migration de invoice e as cinco colunas estavam presentes; catálogo com 323 versões até `20261119120000`.
- A `main` avançou a `b3099724` (#341). A integração manteve os quatro arquivos de Compras byte a byte. Passaram 37 tarefas de check, 4.247 testes unitários, 10 tarefas de build e documentação. Próxima etapa é a CI deste corte. As quatro migrations do Sentinel seguem pendentes de registro definitivo em Dev.

### 19/11/2026 · Continuidade Gemini Sentinel em equipe com Codex (D-776 a D-779)

- **Entregas locais commitadas (`8b37d676..f3ae0df6`) sobre `29ec52a1` (que já foi incorporado pelo Codex no PR `#336`):**
  - `8b37d676` (`D-776` / `A116`): `apps/worker/src/handlers/ml-fulfillment-fetch.ts` — `readPreviousSnapshots()` fatia `.in("inventory_id", ...)` em lotes de `100` (contas reais têm 1.640–2.012 vínculos), elimina a varredura de todo o histórico de `fulfillment_stock_snapshots` (346.394 linhas na VM) usando janela recente de 48 h com ordenação determinística (`captured_at DESC, inventory_id ASC`) + parada antecipada por lote e fallback pontual paralelo (`concorrência 10`, `.limit(1).maybeSingle()`) falhando fechado em erro de banco. Reproduzido pré-correção (`4 failed | 43 passed (47)`).
  - `6e7f2d41` (`D-777` / `A117`): API (`apps/api/src/app.ts`, `order-financials-backfill.ts`, `order-user-products-backfill.ts`) — backfills internos retornam `failed: true` + HTTP `503` via `respostaDoAgendador` em erro de `ml_accounts`; `/v1/nfe-imports/:id/items/:itemId` e `/v1/stock/manual-exits` usam `erroInterno()` (`request_id` + log `request_internal_error`); `/oauth/shopee/callback` valida `Number.isSafeInteger(n) && n > 0` para `shop_id`/`main_account_id`. Reproduzido pré-correção (`7 failed | 115 passed (122)`).
  - `1946a22e` (`D-778` / `A118`): Server Actions e `/atendimento` (`apps/web`) — `claimAction(id)` passa a derivar o usuário estritamente de `supabase.auth.getUser()` no servidor; `acoes/page.tsx` separa `membership.error` com `role="alert"`; `assignToMe` e 6 módulos de Server Actions falham fechado sem vazar `error.message` do Postgres; `escaparIlike()` protege busca por SKU em `/atendimento` e `contaIndisponivel` impede ignorar `?account=` quando `ml_accounts` falha. Reproduzido pré-correção (`6 failed (6)`).
  - `f3ae0df6` (`D-779` / `A119`): `packages/observability/src/logger.ts` — redige segredos no campo principal `message`, protege ciclos via `WeakSet` de ancestrais (`"[Circular]"`, preservando DAGs compartilhados), serializa/redige `Error` em qualquer profundidade (`name`, `message`, `stack`, `cause`) e converte `Date` para ISO string. Reproduzido pré-correção (`3 failed | 35 passed (38)`). Superconjunto do PR `#339`, conforme nota de coordenação do Codex.
- **Verificação completa pós-`f3ae0df6`:**
  - Banco isolado (`sb-gemini-sentinel`, encerrado ao final): `supabase db reset --no-seed` (**326 migrations**), `@sb/db run test:integration` (**16 arquivos / 1.213 testes**), `check:embeds` (**39 projeções aceitas**).
  - Monorepo e web: `pnpm run check` (**37/37 tarefas**, **339 arquivos / 4.250 testes unitários**: `@sb/web` 149/1.562, `@sb/worker` 68/1.097, `@sb/api` 43/566, `@sb/domain` 46/738, `@sb/mercado-livre` 14/162, `@sb/shopee` 8/38, `@sb/observability` 3/38, `@sb/db` 6/28, `@sb/tiktok-shop` 1/11, `@sb/contracts` 1/10), `pnpm run build` (**10/10 tarefas**, `Next.js 16.4.6`), 7 guardas estáticas web (`115`/`27`/`52`/`542`/`59`/`206`/`17` termos), `pnpm audit --prod --audit-level high` (saída `0`, 1 moderado transitivo em `uuid`) e `pnpm docs:check` (`681` decisões únicas).
  - Playwright E2E completo (`chromium` + `loja-live` em `:3000` após `db reset --no-seed` + `e2e:seed`): **401 passed (15.9m)**, zero falhas e zero skips.
- **Coordenação GitHub e progresso.** Branch `agent/gemini-sentinel` publicada em PR Draft `#343` no GitHub com revisões cruzadas nos PRs `#336`, `#338`, `#339` (encerrado pelo Codex em favor de `D-779`), `#340` e `#342` (`D-791`, `/items/bulk`), sem tocar na `main` (`b3099724`), nas branches do Codex ou na frente do Claude Code.
- **Novas entregas independentes (`dd0c27f..b7d459ea`, `D-780` e `D-781`):**
  - `dd0c27f` (`D-780` / `A120`): worker — `ml-listing-visits-fetch.ts` propaga erro no `upsert` de `daily_listing_visits` (preservando o checkpoint de 12 h sem marcar `sync_runs.status = "done"` silenciosamente); `backfill-order-financials.ts` move `readAllPages` (`orders`) e o checkpoint (`order_financials`) para dentro do `try/catch` gravando `sync_runs`/`sync_errors`; `ml-token.ts` e `shopee-token.ts` protegem `release()`/`soltar()` em `try/catch` (TTL 60 s) e `shopee-token.ts` separa erro de banco de trava ocupada. Reproduzido (`6 failed | 47 passed (53)`); `@sb/worker` verde (`68` arquivos / `1.102` testes).
  - `b7d459ea` (`D-781` / `A121`): web — encerra os últimos 3 `getSession()` diretos em clientes web (`action-card.tsx`, `relist-panel.tsx`, `diagnosis-panel.tsx`) migrando para `lerTokenDeSessao`, e valida payloads `200 OK` JSON em `confirmarAplicacaoNaApi` (`queued === true`), republicação (`respostaDeRepublicacaoValida`) e narração IA (`extrairNarrativaDoCopiloto`). Reproduzido (`3 failed | 4 passed (7)`); `@sb/web` verde (`149` arquivos / `1.565` testes + 7 guardas).
- **Verificação pós-`b7d459ea`:** `pnpm run check` (**37/37 tarefas**, **339 arquivos / 4.258 testes unitários**), `pnpm run build` (**10/10 tarefas**, `Next.js 16.4.6`), 7 guardas web, `pnpm docs:check` (**683 decisões únicas**) e `pnpm audit --prod --audit-level high` (exit `0`). Fechamento técnico permanece em **137/226 = 60,6%** (**24/43 = 55,8%**), faltando **39,4%**. Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Candidato combinado depois do handoff Gemini

- Integração em worktree própria de `5364c544` e `c25e75c8`. Preserva byte a byte o código de #341 e as alterações do Gemini D-776–D-779. Inclui as correções de lint e de portas Docker de #338 e #340. O índice documental foi regenerado com 682 decisões únicas.
- Passaram 37 tarefas de check com 4.266 testes unitários, 10 tarefas de build, o teste de isolamento e a checagem de documentação. A CI do #336 continua no corte anterior até concluir a rodada.
- O multiget do ML retornou 31 respostas `403 ResourceDeprecated` na amostra. D-791/#342 usa `/items/bulk` e exige validação em produção após aprovação. A entrega M05 permanece em andamento.

### 19/11/2026 · CI do candidato combinado e auditoria do dump diário

- A CI 44587757810 foi disparada na branch própria `codex/sentinel-gemini-handoff-20261119`, SHA `87038af1`. Consultas de build, integração e scripts passaram. Playwright em execução nesta captura. O job de aplicação em Dev é restrito à `main`.
- O dump diário de 19/11 passou na verificação de checksum por fluxo e no catálogo de 2.786 entradas. A definição arquivada de `purchase_import_rows` ainda não contém as colunas de `20261119120000`. Restore integral do diário e alerta de falha seguem pendentes. [Registro da VM](../../infra/vm/README.md).
- Novo recorte de ACK após recuperação. A revisão `api-00041-8m8` respondeu 200 nos 1.500 POSTs consultados (p95 242,4 ms). Lookup p95 0 ms e enqueue p95 285 ms em amostra distinta de 1.000 eventos. [Medição](../PERFORMANCE.md#ack-observado-após-a-recuperação-da-vm-19112026).

### 19/11/2026 · Restore diário e conjunto Sentinel para CI

- A CI 44587757810 concluiu verde no SHA `87038af1`, e os PRs #336 e #342 passaram Playwright em seus cortes anteriores.
- Restore integral da geração `1795068954797517` em container local sem rede, portas publicadas ou jobs ativos. `pg_restore --no-owner --exit-on-error` terminou em 0. Catálogo com 322 migrations até `20261118211000` e zero índices inválidos. Reaplicação transacional do SQL da invoice criou as cinco colunas esperadas. Container e volume removidos. Falta alerta de backup.
- Integração local em worktree própria preserva D-780/D-781 do #343, a correção de Compras #341 e o contrato bulk do #342. Índice regenerado com 685 decisões únicas. Passaram 4.274 testes unitários, 37 tarefas de check, 10 de build, o teste de isolamento Docker e docs. A CI exata deste conjunto e o registro das quatro migrations em Dev continuam pendentes.
- No artefato local de `87038af1`, um ensaio Hono em processo enviou duas rajadas de 320 POSTs, com quatro contas fictícias e 80 recursos distintos por rajada. Na falha simulada do diretório, uma carga compartilhada produziu 320 respostas 503 e zero tentativas de enqueue. Na recuperação, uma carga compartilhada produziu 320 respostas 200 e 80 chaves distintas no enqueuer simulado. Q03 fica em andamento até o ensaio com Postgres e Cloud Tasks em stack equivalente.

### 19/11/2026 · Continuidade Gemini Sentinel em equipe com Codex (D-782 e D-783)

- **Sincronização de equipe.** Codex incorporou `D-776..D-781` (`4204a223`), `#338`, `#340`, `#342` (`D-791`), `#341` e o ensaio de restore/rajada (`77872061`) no PR `#336` (`0b4bcae3`), e abriu `#345` (sondagem de backup diário no GCS); Claude abriu `#344` (`D-792`, invoice/recebimento). Gemini manteve zero interseção de arquivos e entregou duas novas fatias independentes (`157553df..4d2a90e1`):
  - `157553df` (`D-782` / `A122`): API (`invites.ts`, `webhook.ts`, `app.ts`, `pricing-quote.ts`, `support-reply.ts`) — corrida `23505` em `organization_members.insert` devolve `already_member` (`409`) em vez de `500`; webhook ML exige inteiro positivo seguro em `user_id` e `questionId > 0`, tratando falha de `enqueuer.enqueue()` com log `ml_webhook_enqueue_failed` e HTTP `503` `enqueue_unavailable`; `quoteMlShipping` envolve `decryptToken()` em `try/catch`, usa `AbortController` no timeout de `TIMEOUT_MS` para não disparar `quoteSaleFixedFee` após expiração e para de vazar `error.message` bruto em erros de transporte no `503`; `requestSupportReply` exige `/^[1-9]\d*$/` + `Number.isSafeInteger` em `external_case_id`. Reproduzido pré-correção (`8 failed | 98 passed (106)`); `@sb/api` verde (`43` arquivos / `574` testes).
  - `4d2a90e1` (`D-783` / `A123`): Web Server Components (`apps/web/lib/postgrest-search.ts`, `precos/page.tsx`, `full/page.tsx`, `atendimento/perguntas/page.tsx`, `atendimento/conhecimento/page.tsx`, `atendimento/page.tsx`) — extrai `resolverContaSolicitada()` para falhar fechado quando `?conta=`/`?account=` é pedido e `ml_accounts` falha (pulando RPCs/queries dependentes e preservando a antecipação paralela de D-682/D-683 no consolidado); separa `membershipError` (`EstadoDaTela tipo="erro"`) em `/precos`, `/full` e `/atendimento/conhecimento`; escapa busca `ILIKE` via `escaparIlike()` em `/atendimento/conhecimento`; limita `SEARCH_LIMIT` de `500` para `100` UUIDs (<= 3,7 KB) em `/atendimento/page.tsx` evitando HTTP 414. Reproduzido pré-correção (`5 failed (5)` em `server-pages-seguranca.test.ts`); `@sb/web` verde (`150` arquivos / `1.570` testes + 7 guardas).
- **Verificação completa pós-`4d2a90e1`:** `pnpm run check` (**37/37 tarefas**, **340 arquivos / 4.271 testes unitários**: `@sb/web` 150/1.570, `@sb/worker` 68/1.102, `@sb/domain` 46/738, `@sb/api` 43/574, `@sb/mercado-livre` 14/162, `@sb/shopee` 8/38, `@sb/observability` 3/38, `@sb/db` 6/28, `@sb/tiktok-shop` 1/11, `@sb/contracts` 1/10), `pnpm run build` (**10/10 tarefas**, `Next.js 16.4.6`), 7 guardas estáticas web, `pnpm docs:check` (**685 decisões únicas**) e `pnpm audit --prod --audit-level high` (exit `0`). Fechamento técnico permanece em **137/226 = 60,6%** (**24/43 = 55,8%**), faltando **39,4%**. Ver [`GEMINI_HANDOFF.md`](GEMINI_HANDOFF.md).

### 19/11/2026 · Continuidade Gemini Sentinel (D-784)

- `9d3c9280` (`D-784` / `A124`): `resolverContasSolicitadas()` fecha o filtro de conta/loja nos demais Server Components (`/anuncios`, `/vinculacoes`, `/curva-abc`, `/faturamento` + multicanal, `/vendas` + multicanal, `/central`, `/central/produtos`) quando a leitura de contas falha, sete telas separam `membershipError` e `BuscaSku` trata rejeição de transporte. Reproduzido (`5 failed | 5 passed (10)`).
- Ao retomar, a worktree tinha os 14 arquivos de código revertidos ao conteúdo exato de `9cff4cdc` sem commit (origem não identificada; nenhum trabalho novo). O patch foi guardado no scratch da sessão e os arquivos voltaram a `HEAD` com `git restore`.
- Verificação: `@sb/web` `typecheck`, `eslint`, `test` (**150 arquivos / 1.575 testes**), 7 guardas e `pnpm run build` (**10/10**). Sem migration. Fechamento segue em **137/226 = 60,6%**.

### 20/11/2026 · Candidato integrado sobre a main

O candidato combina a base `a81f5235`, #336, D-782 a D-784 do #343, as sete correções validadas em paralelo e a sondagem do #345. Os conflitos de decisões, índice, handoff e checkpoints foram resolvidos na branch de integração. A Curva ABC passou a conservar a seleção de contas ao tentar novamente após uma falha.

No PostgreSQL 17 isolado, o histórico inicial tinha 324 migrations até `20261119180000`. O dry-run com os nomes originais recusou as quatro anteriores à base. A cópia temporária `20261119180001` a `20261119180004` aplicou NF-e, ERP, índice de Full e retenção, nesta ordem, e chegou a 328 versões. O dry-run final ficou limpo. Os nomes originais seguem no Git enquanto o Dev hospedado estiver inativo e o catálogo-alvo não for reconciliado.

A sondagem de leitura validou o dump de 20/11 de 187.580.692 bytes. O teste da notificação e a publicação coordenada ficam pendentes.

### 24/11/2026 · Retomada do candidato #378

- O candidato `2ae7a4b4` integra `origin/main` em `5a49133b` e está empilhado em #364 (`fcaf257d`). A worktree isolada `codex/sentinel-integracao-20261124` preserva o trabalho staged e unstaged do checkout histórico `v3` (`9642d921`).
- D-882 reproduzido na rota com HTTP 200. A correção `9f0fc8ef` marcou a falha de enqueue como retentável, seguiu para a segunda organização e verificou recuperação e deduplicação na mesma hora. D-881 usa o catálogo com quebras de linha preservadas pela CLI.
- O ensaio regional `9d0af86b` e as 19 fatias do Gemini foram incorporados. Quatro conflitos entre os documentos de decisão foram reconciliados. A Curva ABC já tinha o ajuste local e o merge preservou as contribuições de saúde da sincronização. Sem diff de migrations contra `2ae7a4b4`.
- Claude: #329 permanece draft. #384 de margem foi integrado na main. #347 de compras e #383 de catálogo continuam com seus responsáveis. A presença de worktrees não confirma atividade de sessões. #377 reúne #368 e #376 para M05.
- Cloud Run confirmou 100% de tráfego em `api-00042-7bl` e `worker-00060-z8h`, ambos no SHA `5a49133b`. Scheduler de métricas ativo com duas retentativas. Secret Manager confirmou somente o estado ENABLED das cinco referências SMTP. Supabase Dev confirmou INACTIVE. Quatro migrations definitivas, publicação e aceite continuam pendentes.
- O inventário calculou 155/226 (68,58%), 28/43 entregas. V01 segue condicionado ao registro definitivo e ao ensaio de upgrade da VM com o novo SHA.

- Verificação integrada local em `de846564`: check 37/37 (4 tarefas de cache), build 10/10 (7 de cache), seis testes do preflight e documentação com 720 decisões indexadas. A CI do SHA anterior `2ae7a4b4` concluiu os quatro jobs e omitiu o apply Dev. Cloud Monitoring listou apenas a política habilitada de backup, com zero uptime checks. A VM estava ativa com `e2-standard-2` e disco de 50 GB.

### 24/11/2026 · Regressão da composição e validação independente

- O Playwright de `f9b9ec26` (45395072874) passou 367 testes e falhou 15. D-803 tratava `Infinity` como zero, apesar de os leitores ML e Shopee do SKU usarem esse teto para ler todos os anúncios. A regressão de 1.002 linhas falhou antes do ajuste. O teste de Contas depende do estado que a jornada de vínculo Shopee restaura ao terminar. O novo corte precisa validar os dois fluxos em conjunto.
- O #377 foi reconciliado com a main em `87636bf9`. Os quatro checks passaram (45396006316), com aplicação de migrations no Dev omitida. Issue #367 tem a janela de 63 HTTP 403 em seis horas e o requisito de preservação do SMTP. A publicação isolada depende de autorização.

### 24/11/2026 · Composição com a main de produção

- O corte `034ffb34` passou a CI `45399007243` com 402 jornadas Playwright, 1.229 testes de integração PostgreSQL e 42 projeções PostgREST. A nova base `9670cde3` incorpora D-859 a D-862 e a correção de invoice #347. A publicação funcional dessa base está registrada no #388.
- D-882 continua na rota dedicada de margem de D-859, com 503 por falha de fila, paginação, dedupe e tentativa das demais organizações. A composição mantém a confirmação protegida e o parâmetro `markAbsent` até o worker. O teste de erro de transporte da Central verifica também a execução da fonte D-861 após a falha de frete. O #377, separado, foi atualizado para `2d9a06d2` sobre a mesma base e segue na CI `45434819641`.
- Gemini em `879ac5b9`, com D-807 a D-811 preparados. Revisar D-808/D-810 sobre a API da nova base antes de incorporar. Os dois projetos Supabase hospedados responderam INACTIVE. O Dev bloqueia quatro timestamps definitivos do candidato.

- A CI de `da2139f0` encontrou o teste simulado que ainda esperava 18 agendamentos após D-859. A expectativa agora valida os 19 jobs e a criação de `v3-low-margin-sales`. Os sete scripts de provisionamento simulados passaram localmente. A correção altera apenas teste e documentação.

### 24/11/2026 · D-863 e fatias Gemini D-807–D-811

- `origin/main` em `d21fb902` (#389). O #378 permanece empilhado no #364 (`fcaf257d`), branch remota `codex/sentinel-candidato-v3-catalogo`, worktree `codex/sentinel-integracao-20261124`. A composição D-863 em `e482d9f4` passou check 37/37 (34 em cache), build 10/10 (9 em cache) e docs:check. O SHA anterior `b68dda60` teve quatro jobs verdes na CI 45439871885.
- Fonte do batch Gemini #343: `30319b7c`, `43ccb988`, `f2c4c50c`, `2e778a02` e `4241b18a`. No único conflito, a tabela da API ganhou a linha TikTok e conservou as duas cadências de D-859. Sem novas migrations ou filas. O webhook pode observar com as credenciais existentes. O agendador transacional aguarda handlers e tabelas.
- Após a integração D-807–D-811, check 37/37 (16 em cache), build 10/10 (7 em cache) e docs:check. Suítes: cliente TikTok 33, domínio 788, API 638, web 1.727 e worker 1.186. A CI 45441658929 de `main` falhou antes dos testes SQL ao iniciar o Docker na porta 60022. O #377 passou o mesmo job com migrations idênticas.
- O #377 (`codex/sentinel-ml-catalogo-integrado`) subiu para `0f7a98de`, CI 45444838540. Check 37/37 em cache, build 10/10 (9 em cache), docs:check e comparação de arquivos do worker, cliente Mercado Livre e migrations sem diferenças em relação a `2d9a06d2`.
- Reservas: Gemini D-812 (contratos de jobs); Claude conserva Auth D-863 e sua frente funcional; Codex conserva a composição #378 e M05 #377. O estado externo foi verificado pelo Git e pelos PRs. Reservas e branches dos demais agentes seguem sob controle de seus respectivos responsáveis.
- Fechamento em 155/226 (68,58%), 28/43 entregas. Aceite M04 depende de persistência e jornadas integradas. O Dev pausado impede os quatro registros definitivos. M05 aguarda aprovação do rollout isolado; V02 e V03 aguardam a esteira e o aceite do dono. Próxima etapa: verificar os quatro jobs de cada SHA e, em seguida, revisar os contratos D-812 quando publicados.
- O batch Gemini foi registrado em `5fb20839`. D-883 corrige a coleta de traces no mesmo #378. O ensaio Chromium 1.62.1, com uma asserção intencionalmente vermelha e página sintética, produziu um ZIP de 6.441 bytes. A investigação do bind da porta 60022 foi encaminhada para o PR já existente #340.
- O primeiro dispatch de `e2c7b8dc` recusou o ID `playwright` duplicado com a etapa de versão. O reparo usa `playwright_e2e` para os testes e preserva a chave de cache.

### 24/11/2026 · Segundo batch Gemini D-812–D-814

- O primeiro batch está em `c1ef6afd`, CI 45446906931. Gemini publicou novo corte `eb2eb34e` no #343 durante essa execução.
- Origem da segunda integração: `ce3d2d63`, `f5d7f7d0`, `fcc5010f` e `0072e5ac`. Inclui os contratos de fila TikTok, as projeções de catálogo e devolução e sete guardas de escopo do worker. Nenhuma alteração de migrations ou lockfile.
- D-815 fica na frente Gemini. D-863 continua sob Claude com SMTP real como dependência. O Codex mantém #377, #378 e #340. O #340 foi reconciliado em `8edf669d` com dois testes do alocador de portas, check, build e docs:check aprovados. CI 45446867460.
- Check 37/37 (16 em cache), build 10/10 (7 em cache) e docs:check. O check somou 4.699 testes, com 22 nos contratos, 796 no domínio, 639 na API, 1.193 no worker e 1.727 na web.
- As correções Shopee #379 e #380 e a fixture #373 já estão no histórico do candidato. #381 e #382 seguem como evidências de P02 e Q03 referenciadas no inventário.
- M04 ainda precisa de tabelas versionadas, handlers, ligação da fila e teste integrado da loja. V01 aguarda as quatro versões definitivas e o ensaio de upgrade da VM. O inventário permanece em 155/226 (68,58%), 28/43 entregas.
- CI externa concluída com quatro jobs verdes em `c1ef6afd` (45446906931), `0f7a98de` (45444838540) e `8edf669d` (45446867460). Os dois PRs isolados tiveram 346 E2E cada. O runner Linux do #340 escolheu 61021/61022. O dispatch seguinte do #378 valida o segundo batch inteiro no SHA final.

### Continuidade em 25/11/2026

- A composição de D-864 sobre `ff0de2c9` ficou em `55e20b5b`. Check 37/37, build 10/10 e docs:check.
- D-815 a D-819 do #343: `daa30b3a`, `ce980cdc`, `e895084c`, `5dfeeebf`, `570b6e45`. Check 37/37, build 10/10 e docs:check. Conteúdo de migrations, lockfile e workflows preservado.
- O dono prevê a retomada do Supabase Pro em 01/12/2026. Confirmar o Dev saudável antes de registrar versões oficiais.
- A próxima fatia de M04 tem o caso de reconexão durante refresh encaminhado ao Gemini. [Coordenação](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/343#issuecomment-7140347544)

### Composição de 25/11

- Claude até D-869 sobre `f4c0be64`. O #394 documenta o aceite do dono para recuperação de senha. Em leitura, conferidos HTTP 200 com “Esqueci a senha”, três políticas ativas e três uptime checks. O catálogo da VM confirmou `20261124140000`.
- Gemini `ad78823a`, decisões D-820 a D-830 integradas no #378 com doze patches após D-819. D-831 segue sob Gemini. A regressão de reconexão de M04 foi encaminhada no #343.
- Inventário em 163/226 (72,12%), 30/43. S04 e I04 contabilizam oito pontos. M05 continua em validação no #377.
- O #397 foi composto em `2b893b9f` com check 37/37, build 10/10 e docs:check. Vercel READY em `8f39cddc`.
- D-831, commit Gemini `0599064d`. D-832 permanece reservado. O teste de reconexão OAuth de M04 segue no #343.
- #377 `cf6dae2d`: sonda real explicou a ausência do envelope sob projeção. Um anúncio foi processado na revisão isolada. O candidato incorpora a correção sem as etapas experimentais intermediárias.
- M05 validado em produção com o código do #377 em `cf6dae2d`. O bulk completo foi conferido, a reconciliação encerrou nas contas agendadas e as exceções recuperadas pelo job regular. A consulta cruzou as falhas anteriores com as listagens atualizadas. O #377 foi reconciliado com a main em `dfbce8f3`, com os arquivos do worker e cliente idênticos ao corte publicado.
- A CI do código composto é 45606453406 para `c5882974`. O checkpoint de aceite altera somente documentação. Fechamento técnico recalculado em 168/226 (74,34%), 31/43.

### 25/11/2026 · Claude Sentinel: verificação de produção depois da troca do banco para a VM

- **Base.** `main` em `8f39cddc`. Tudo foi lido sem alterar nada: Cloud Scheduler e Cloud Run pela API REST, Cloud Logging, e `job_runs`, `inventory_balances`, `erp_stock_snapshots` e `listings` pela VM `sb-db` com `default_transaction_read_only`.
- **Agendamentos.** Os 20 jobs do Scheduler de produção estão `ENABLED`, e todos tiveram sucesso na última chamada. O item P0 do plano ("próxima execução dos oito agendamentos com último erro") deixa de ter pendência no Scheduler.
- **Jobs no banco, 24 h.** Fecharam sem falha final: pedidos, logística, financeiro, Full, SAC, Shopee, ledger, reconciliação, margem e ping. Exceções:
  - `sync.listing.item` e `sync.listings.snapshot` (ver abaixo);
  - 404 e 429 isolados em devoluções do ML no `sync.webhook.received`;
  - uma `diagnostics.detect-support-patterns` com `fetch failed`.
- **Incidente: anúncios do ML.** O Mercado Livre passou a recusar o `GET /items` antigo com 403 `ResourceDeprecated` desde 24/11 05:40 UTC.
  - De 24/11 18:16 a 25/11 ~11:05 UTC, a revisão `worker-m05-0f7a98de` (o `/items/bulk` do #377) esteve com o tráfego e reprovou o envelope real no zod: `[0].id` e `[0].status_code` ausentes. A falha de `sync.listing.item` passou de cerca de 5% ao dia para mais de 99%.
  - Às 11:05 UTC o tráfego voltou para `worker-00061-gwr`, que ainda recebe o 403 no `GET /items`.
  - O Codex publicou a correção `d0c2790f` na branch do #377, ainda não implantada. A revisão cruzada, com um ponto sobre a resposta 404 sem `id` num pedido de um ID só, está no #377.
- **Estoque contra o ERP.** A reconciliação diária comparou 3.151 SKUs de 22/11 a 25/11, sem nenhum ajuste.
  - A última captura do UpSeller é de 19/11.
  - Os 25 saldos LOCAL negativos são iguais ao alvo do ERP: são vendas depois da captura acima do saldo da planilha, e não um defeito do ledger. Somem com uma planilha nova do UpSeller.
- **Para o inventário.**
  - S04: SMTP, recuperação e troca de senha validados pelo dono em 24/11 (D-863).
  - I04: alerta de disco e três verificações de disponibilidade ativos desde 24/11 (D-868). Falta forçar um disparo de ensaio.
  - M05 continua aberto.
- **Próxima etapa.** Publicar o worker com `d0c2790f`, ou o sucessor, com autorização do dono, e medir de novo `sync.listing.item`. Planilha nova do UpSeller.

### 25/11/2026 · Claude Sentinel: correção dos anúncios do ML no ar e ensaio do I04

- **Anúncios do ML.** O Codex pôs `worker-m05-cf6dae2d` com 100% do tráfego às 11:39 UTC. Essa revisão tira a projeção `attributes=` do `/items/bulk`, e o envelope volta a trazer `id`, `status_code` e `body`. O dono tinha autorizado a publicação, e ela já estava feita, então não houve implantação nova.
  - Primeiros minutos, lidos pela VM em modo só leitura: `sync.listing.item`, `sync.listings.snapshot` e `sync.webhook.received` fecharam sem nenhuma falha. A tabela `listings` voltou a receber atualizações.
- **UpSeller.** Captura nova aplicada em 25/11 11:32 UTC. Os 25 saldos LOCAL negativos devem sumir na próxima reconciliação diária; isso se confere amanhã.
- **I04.** Ensaio feito com uma política temporária (disco acima de 20%). O incidente abriu em cerca de 3 minutos, e a política foi apagada logo depois (D-868). Falta o dono confirmar que o e-mail chegou.
- **Próxima etapa.** Medir `sync.listing.item` num dia inteiro com a `cf6dae2d`. Conferir os negativos depois da reconciliação de 26/11.

### 25/11/2026 · D-884, upgrade local e conferência do catálogo

- O #378 foi integrado ao #364 em `29adf54c`. Usei a main `6a3471ff` (#399) como base do laboratório e mantive a responsabilidade de M04/D-832 com Gemini (checkpoint `8b70857d` no #343). A regressão de reconexão foi encaminhada com execução em PostgreSQL local.
- A stack descartável iniciou com 330 migrations até `20261124140000`. O preflight encontrou exatamente quatro adições anteriores à última versão. Apliquei cópias byte a byte no laboratório, na ordem NF-e, ERP, índice de Full e retenção, com versões temporárias `20990101000001` a `20990101000004`. O catálogo terminou com 334 versões e sem lacunas. Passaram 1.254 testes em 19 arquivos. A stack foi encerrada.
- O planejador local em `cd22fa0c` conferiu o catálogo contra os commits e seus objetos Git. Os dez testes do planejador e do preflight passaram. Check 37/37, build 10/10 e docs:check.
- A consulta à VM em transação somente leitura encontrou as mesmas 334 versões do candidato, nas versões originais. As quatro adições já estavam no catálogo da VM. Nove comparações de definições e permissões passaram. O agendamento de expurgo está desativado. A consulta verifica o estado instalado, sem inferir autoria nem canal de aplicação.
- Fechamento 168/226 (74,34%), 31/43. Após a retomada do Dev, conferir seu catálogo antes de decidir qualquer registro. Preservar a identidade das versões já registradas na VM. O ensaio usou dados sintéticos. A etapa com cópia de backup e o aceite da publicação do SHA completo continuam no plano.

### 25/11/2026 · Claude Sentinel: Full desconhecido na faixa de /estoque (D-870)

- **Contexto.** O Supabase hospedado só volta em 01/12, e isso bloqueia o Dev e a ordenação oficial das migrations. A produção roda na VM `sb-db`. Enquanto isso, a rodada segue nas frentes que não dependem dele.
- **Entrega.** O #400, branch `claude/estoque-full-ausente`, tem a migration `20261125120000_full_ausente_no_resumo_do_estoque.sql` e a tela de `/estoque`.
  - Sem captura do Full em 3 dias, a faixa mostra "—" com a ressalva em vez de "Full 0".
  - Assinatura e retorno são os mesmos, e a ordem entre migration e web não importa.
- **Testes.**
  - `estoque-resumo.integration.test.ts`: falha na função antiga e passa na nova.
  - Suíte de integração do `@sb/db`: as mesmas 10 falhas de OAuth e estorno com e sem a migration (baseline medido).
  - Passaram `check`, as 7 guardas da web, `build` e `docs:check`. A tela não foi aberta no navegador.
- **Varredura do mesmo padrão.** Das funções que leem `fulfillment_stock_snapshots`, só `get_sku_dashboard` ainda soma o Full com `coalesce(..., 0)`.
  - Ela atende o detalhe do SKU e a inspeção de `/produtos`.
  - `get_purchase_analysis` já devolve nulo sem saldo nem captura.
- **Próxima etapa.**
  1. A mesma correção em `get_sku_dashboard` e nas duas telas, como fatia própria.
  2. Publicar a migration da D-870 em produção pela VM, com autorização do dono, depois do merge.
  3. Em 26/11, conferir os 25 negativos do UpSeller e um dia inteiro de `sync.listing.item`.

### 25/11/2026 · Claude Sentinel: D-870 em produção

- **Publicação.** Com autorização do dono, o #400 entrou na `main` em `bf6e420e`. Os 4 jobs obrigatórios passaram; o do Dev falhou com "project is paused", como esperado. A migration `20261125120000` foi aplicada pela VM com `psql -1` e registrada no histórico, e a Vercel concluiu a web.
- **Conferência.** Corpo novo e grants certos. O Full continua conhecido para a organização, que tem captura de hoje. O `exists` novo custa 0,2 ms.
- **Achado para performance.** `get_stock_summary` como membro autenticado: 52 mil páginas e 1,9 s, custo anterior à D-870.
- **Próxima etapa.**
  1. A mesma correção em `get_sku_dashboard`.
  2. Medir e reduzir o custo de `get_stock_summary`.
  3. Em 26/11, conferir os negativos do UpSeller e um dia inteiro de `sync.listing.item`.

### 25/11/2026 · Claude Sentinel: Full desconhecido no dashboard do SKU (D-871)

- **Base.** `main` em `3ee30291`. Branch `claude/sku-full-ausente`.
- **Entrega.** A migration `20261125130000_full_ausente_no_dashboard_do_sku.sql` aplica a regra da D-870 em `get_sku_dashboard`.
  - O detalhe do SKU e a inspeção de `/produtos` mostram "—" no Full sem captura em 3 dias.
  - A cobertura e o diagnóstico continuam com o Full ausente como 0, a mesma conta de `/reposicao` (D-314).
  - `inspecao-rapida.tsx` ficou intocada, porque o candidato #378 mexe nela.
- **Testes.**
  - Integration estendido: falha na função antiga e passa na nova.
  - Suíte do `@sb/db`: as mesmas 10 falhas de baseline, e a guarda da D-204 passou.
  - Passaram `check`, as 7 guardas, `build` e `docs:check`. As telas não foram abertas no navegador.
- **Pendente do dono.** Decidir se a cobertura deve ficar desconhecida quando o Full é desconhecido, nas duas telas juntas (SKU e `/reposicao`).
- **Próxima etapa.**
  1. Publicar a D-871 (merge e migration pela VM), com autorização.
  2. Medir e reduzir o custo de `get_stock_summary`: 1,9 s como membro.
  3. Em 26/11, conferir os negativos do UpSeller e um dia inteiro de `sync.listing.item`.

### 25/11/2026 · Claude Sentinel: faixa de /estoque no plano genérico (D-872)

- **Branch.** `claude/resumo-estoque-plano-generico`, empilhada sobre `claude/sku-full-ausente`. O #404 tem base no #403.
  - A CI só roda em PR contra a `main`: depois do merge do #403, trocar a base do #404 para `main` e esperar a CI.
- **Entrega.** A migration `20261125140000_resumo_do_estoque_sem_laco_generico.sql` reescreve `get_stock_summary` sem mudar assinatura nem regra.
  - Em produção, só leitura: 1,7 a 2,1 s por chamada como membro. No plano genérico forçado, o corpo novo leva 296 ms contra 3,2 s do antigo.
  - Os dois corpos devolveram a mesma linha nos 7 recortes. Os números estão em `PERFORMANCE.md`.
- **Testes.** Suíte do `@sb/db` com as mesmas 10 falhas de baseline. D-249, D-870 e a guarda da D-204 passaram.
- **Fila de publicação, toda dependendo de autorização do dono.**
  1. #403 (D-871): merge e migration `20261125130000` pela VM.
  2. #404 (D-872): troca de base, CI, merge e migration `20261125140000` pela VM.
- **Próxima etapa.** Em 26/11, conferir os negativos do UpSeller e um dia inteiro de `sync.listing.item`. Depois, medir as outras funções `language sql` com `search_path` fixo e filtros opcionais, que podem cair no mesmo plano genérico.

### 25/11/2026 · Claude Sentinel: D-871 e D-872 em produção

- **Publicação.** Com autorização do dono:
  - #403 na `main` em `a8a0d7cf`, com a migration `20261125130000` pela VM;
  - #404 retargetado para `main`, com um commit vazio para disparar a CI, e na `main` em `d3f90239`, com a migration `20261125140000` pela VM.
  - Em cada merge, os 4 jobs obrigatórios passaram e o do Dev falhou com "project is paused". Produção tem 337 migrations. A Vercel publicou as duas webs.
- **Conferência.**
  - D-871: corpo novo, grants iguais, Full positivo num SKU com captura, como membro.
  - D-872: 180 a 197 ms por chamada como membro, contra 1,7 a 2,1 s antes.
- **Próxima etapa.**
  1. Em 26/11, conferir os 25 negativos do UpSeller depois da reconciliação das 09:00 UTC e um dia inteiro de `sync.listing.item`.
  2. Procurar o mesmo plano genérico em outras funções `language sql` com `search_path` fixo e filtros opcionais, comparando função e SQL por extenso.

### 25/11/2026 · Claude Sentinel: varredura do plano genérico e curva ABC (D-873)

- **Base.** `main` em `873548ce`. Branch `claude/curva-abc-plano-generico`.
- **Varredura.** Sete funções `language sql` com filtros opcionais foram medidas em produção, com os números em `PERFORMANCE.md`. Duas passam de 1 s:
  - `get_sku_abc_curve` sofre de plano genérico e foi corrigida aqui;
  - `get_fulfillment_overview` é cara mesmo por extenso e fica para investigar.
- **Entrega.** A migration `20261125150000_curva_abc_full_materializado.sql` usa `full_by_sku as materialized`.
  - Plano genérico forçado: 3,1 s para 483 ms.
  - As duas versões deram as mesmas linhas em 10 recortes.
- **Testes.** Suíte do `@sb/db` com as mesmas 10 falhas de baseline, e os testes da curva ABC passaram. `docs:check` ok.
- **Pendências.**
  - Decisão do dono: "sem Full" na curva ABC quando não há captura nenhuma (padrão da D-870).
  - Investigar `get_fulfillment_overview`.
  - Em 26/11, conferir UpSeller e `sync.listing.item`.

### 25/11/2026 · Conciliação da main #406 e aceite de L04

- Candidato #364 em `32bfc540` passou nos quatro jobs do run `45612527995`. A main avançou até `628ff887` com D-870 a D-873. As sobreposições do merge eram documentais. A comparação completa do catálogo encontrou 337 versões na VM e 338 no candidato. Só a migration da D-873 aparece exclusivamente no candidato.
- Gemini publicou D-832 a D-837 em `2550a9bc`. O #401 reúne worker, TikTok, Auth e infraestrutura. Solicitei a CI do candidato, a separação de retenção e o teste de concorrência OAuth em M04. [Revisão](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/401#issuecomment-7167748577)
- A leitura do Google Cloud confirmou retenção no Artifact Registry e no bucket temporário de builds, remoção do papel Editor da conta padrão e retirada das tags temporárias do worker. L04 ganha 2 pontos. I06 aguarda custo real. S05 aguarda adoção da identidade dedicada nos builds regulares; os seis builds regionais recentes não a usaram.
- D04 tem leitura do arquivo na Central, commit `b1542fe7` no #407, com integração local 1.243/1.243 e Chromium 8/8. A política de retenção e `sync_runs` continuam abertos. O Dev alojado permanece pendente até a retomada combinada.

### 25/11/2026 · D-885, leitura do histórico da Central

- Branch `codex/sentinel-d04-historico`, a partir da main `628ff887` (#406). Migration `20261125160000` e cliente em `/notificacoes`. A migration precede a publicação web.
- Validação local: `check` 37/37, `build` 10/10, integração SQL 1.243/1.243 e Chromium 8/8. A Data API autenticada manteve a notificação sintética após movê-la para o arquivo, contou uma ocorrência e a excluiu de não lidas. A RPC anônima foi recusada. [Medição](../PERFORMANCE.md#histórico-da-central-com-arquivo-sentinel-d04-25112026)
- D04 continua em andamento. A rotina de transferência, a janela de retenção e a referência de `sync_runs` precisam de decisões próprias. O #401 fica com Gemini. Claude mantém as frentes da avaliação do Full e de `get_fulfillment_overview`.

### 25/11/2026 · D04 no candidato e aceite de I06

- Main `628ff887`. O candidato `codex/sentinel-integracao-20261124` em `2063463e` recebeu o #407 (`b1542fe7`). A resolução conservou os atalhos de contadores e a marcação em lote sob RLS, usando a RPC de histórico para a lista e a view para as contagens.
- No Supabase local, o catálogo anterior (`32bfc540`, 334 versões) recebeu cinco migrations até `20261125160000`. As duas notificações prévias permaneceram com o mesmo hash. `check` 37/37, `build` 10/10, integração SQL/PostgREST 1.259/1.259 em 20 arquivos e Chromium da Central 11/11.
- I06 aceito. O dono forneceu o custo efetivo de outubro de 2026 do projeto a partir de consulta ao Google Cloud Billing em 25/11. A retenção e o dimensionamento já tinham evidência. Inventário em 173/226 pontos e 33/43 entregas.
- O #401 fica com Gemini. A revisão de D-832 apontou que a falha de publicação da próxima janela Shopee pode ser seguida de retorno `done`. Pedi teste de falha de fila após o marco. M04 segue com o teste de concorrência OAuth. [Revisão](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/401#issuecomment-7168241930)
- Próximo passo: conferir a CI do novo HEAD do #364, validar o catálogo oficial do Dev na retomada e sequenciar as migrations antes da web. A política de retenção de D04, S05 e a aplicação em produção permanecem abertas.

### 25/11/2026 · D-886, índice temporal no histórico da Central

- Base `b1542fe7`, PR #407, candidato `237d287d` e main `628ff887`. A migration aditiva `20261125170000` usa o índice temporal na leitura sem filtros até o deslocamento 1.000. A visão de contagens de D-885 continua na consulta existente.
- Check 37/37, build 10/10 e integração serial 1.243/1.243. A execução paralela registrou um deadlock no teste de cancelamento de compras. O benchmark preservou os resultados em dez recortes. A comparação incluiu cópias duplicadas, filtros seletivos, limite entre os planos e página vazia. [Medição](../PERFORMANCE.md#índice-temporal-para-as-primeiras-páginas-do-histórico-d-886-25112026)
- S05: a conta dedicada existe. A leitura das políticas do projeto, repositório de imagens, bucket de origem e conta de serviço não encontrou as concessões do ensaio anterior. A adoção aguarda autorização para conceder os acessos mínimos e confirmar o primeiro build pela rotina regular. #401 permanece com Gemini e #406 com Claude.
- A CI `45656368865` do candidato `237d287d` terminou com os quatro jobs verdes e 414 cenários de Playwright. A fatia seguinte de D-886 é `99a8d64c` no #407. Os pontos aceitos permanecem em 173/226.
- Com D-886 no candidato, a suíte serial passou 1.259/1.259 em 20 arquivos, o preflight passou 10/10 e `check` passou 37/37. A Data API local confirmou retorno idêntico da página indexada e filtrada, exclusão nas não lidas e recusa de acesso anônimo à view.

### 25/11/2026 · D04, ensaio repetível de transferência e restauração

- Base `99a8d64c` no #407, candidato `55a4b14a` no #364 e main `628ff887`. Acrescentei um teste de integração com lote lido, corte sintético e restauração. O ensaio mantém os registros de notificação e evento necessários à restauração.
- A colisão abortou a tentativa e preservou o vínculo original. As duas operações puderam ser repetidas com zero novas mudanças. Estados de leitura e datas bateram, e a notificação continuou invisível a outra organização. Em duas sessões, a segunda pulou a linha bloqueada e viu uma única ocorrência antes e depois do commit.
- Check 37/37, build 10/10 e integração serial 1.244/1.244. A CI de `99a8d64c` (#407) terminou verde. A implantação da rotina efetiva depende da política de retenção. M04 continua com Gemini (#401) e S05 aguarda autorização para IAM.
- O #408 aguarda correção do modo de prévia, que atualmente atualiza a configuração de simulação do Artifact Registry, e proteção contra substituição das regras já existentes no bucket. [Revisão](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/408#issuecomment-7169230719)
- No candidato, a conciliação dos documentos e do teste passou em `check` 37/37, `build` 10/10, `docs:check` e integração serial 1.260/1.260 em 20 arquivos. O inventário continua em 173/226.

### 25/11/2026 · D04, recuperação sintética da referência de sync_runs

- Main `628ff887`, candidato `998cc5e3` (#364) e #407 em `4bc320f4`. O #407 fechou os quatro jobs no run `45662332196`. A CI `45663343009` do #364 em `998cc5e3` fechou com os quatro jobs verdes, 1.260 testes de integração e 414 E2E. O #401 segue em `3e983e7c` com M04 reservado ao Gemini. O #408 segue em `0067981d`, com revisão de prévia e lifecycle encaminhada.
- Em PostgreSQL 17.11 descartável, 12.782 de 58.000 execuções foram movidas. O teste recuperou a linha original no erro tardio, preservou a FK nas duas ordens de concorrência e verificou repetição após `40001`. A redução sintética de espaço foi 21,97% no ativo e 6,85% no conjunto antes da recuperação.
- A conferência dos leitores mostrou risco de perder checkpoints de contas inativas em corte por idade. Com as linhas que sustentam esses checkpoints preservadas, nove resultados sintéticos foram idênticos. Na cópia do catálogo real, confirmei a recusa de DELETE, o sumiço de conta inativa em `get_sync_health` após corte por idade e a emissão de alerta novo ao reinserir falha histórica sem evento prévio. A transação foi revertida.
- Revisão técnica e observações de armazenamento em `PERFORMANCE.md`. D04 segue em andamento. Inventário em 173/226, com V01/V02 dependentes do Dev alojado e S05 da autorização de IAM.

### 25/11/2026 · D04, ensaio repetível de permissões e checkpoints de sync_runs

- Acrescentei `packages/db/scripts/rehearse-sync-run-archive.mjs`. O ensaio local separa o papel da movimentação do papel da recuperação, delimita a conta permitida e reverte todas as alterações ao terminar. A recuperação de erro tardio preservou a referência e suprimiu o alerta histórico. Falha operacional comum ainda gerou alerta.
- O corte recusou os checkpoints. Saúde, cartões de conta, checkpoints de pedidos e claims e o resultado do vigia corresponderam antes do corte, depois dele e após a recuperação. O ensaio recusou o acesso fora do escopo, a escrita direta pelo operador e o host externo.

### 25/11/2026 · Claude Sentinel: publicação da D-873, I06, L03 e L04

- **D-873.** Merge do #406 autorizado pelo dono. A `main` está em `628ff887`.
  - O GitHub teve incidente nesse horário, perdeu o evento do push e o PR segue aberto.
  - A CI foi disparada à mão (`workflow_dispatch`, run 45662352513).
  - Os quatro jobs obrigatórios passaram. O job do Dev falhou com "project is paused", como esperado.
  - A migration `20261125150000` foi aplicada na VM e registrada no histórico.
  - Como membro, a curva de 30 dias levou de 346 a 440 ms, contra 1,3 a 1,6 s antes.
  - O #406 foi fechado à mão com comentário. Não houve deploy da Vercel para `628ff887`, que não muda a web.
- **I06.** Detalhes em `docs/agent-audit/CLOUD_COST_AND_RETENTION.md`, só com leituras, e complementa o #408 do Gemini (D-836).
  - VM e Cloud Run adequados, com as medições no documento.
  - O Postgres está com parâmetros de fábrica (`shared_buffers` e `effective_cache_size` de 128 MB).
  - Custo estimado de tabela: ~R$ 740 por mês na parte fixa.
  - O bucket de backups tem versionamento sem regra para versões antigas.
  - O orçamento "Dev" cobre a conta inteira.
- **S05.** O `editor` saiu da conta padrão às 13:23 UTC, mas nem ela nem o `v3-builder` têm hoje permissão no repositório de imagens. O próximo deploy de `api` ou `worker` deve falhar até o dono conceder os papéis ao `v3-builder`.
- **L04 e L03.** Novas linhas em `CLEANUP_CANDIDATES.md`.
  - 15 PRs do Codex já estão contidos no #378.
  - 13 PRs de telas de setembro e outubro esperam decisão do dono.
- **Testes.** Só `pnpm docs:check`; não houve mudança de código.
- **Próxima etapa.**
  - Em 26/11, conferir UpSeller e `sync.listing.item`.
  - Quando o dono conceder os papéis ao `v3-builder`, fazer o deploy seguinte com `--service-account`.
  - Investigar `get_fulfillment_overview`.

### 25/11/2026 · Claude Sentinel: Central Full (D-874) e fechamento do S05

- **Respostas do dono.**
  - Concedeu os três papéis ao `v3-builder`.
  - Leu o custo dos últimos 30 dias, bem abaixo da estimativa. O valor fica fora do repositório.
  - Autorizou a regra de versões antigas no bucket de backups, aplicada às 18:02 UTC só em `diario/`.
  - O orçamento "Dev" segue sem filtro de projeto.
- **S05 fechado.** Conferi os três vínculos e rodei um build de teste como `v3-builder` (`cdb5c897`, SUCCESS, imagem `worker-sentinel-iam:*`). O deploy seguinte usa `--service-account`. A imagem de teste entra na lista do L04.
- **D-874.** `get_fulfillment_overview` agora soma o saldo local só do SKU de cada linha.
  - Em produção, só leitura: de 1,5 a 2,0 s para 155 a 164 ms, também no plano genérico.
  - 12 recortes iguais em linhas e ordem.
  - A migration é `20261125183000`.
- **Testes.** Suíte de integração do `@sb/db` com a migration: as mesmas 10 falhas de baseline. Mais `pnpm docs:check`.
- **Próxima etapa.**
  - Autorização do dono para o merge e a migration da D-874 na VM.
  - Em 26/11, conferir UpSeller e `sync.listing.item`.

### 25/11/2026 · Claude Sentinel: D-874 em produção

- **Merge:** o #411 foi mergeado com autorização do dono, e a `main` está em `57eb7961`.
  - Os quatro jobs obrigatórios passaram no run 45676090002.
  - Na primeira tentativa, o e2e falhou porque o runner estava com a porta 60022 ocupada. Nenhum teste rodou, e o job passou na segunda tentativa.
  - O job do Dev falhou com "project is paused", como esperado.
- **Migration:** `20261125183000` foi aplicada na VM com `psql -1`, e o hash do arquivo bateu com o da `main`.
- **Conferido depois:** o corpo novo, o comentário, os grants e o registro no histórico.
- **Tempo, como membro:** a Central Full de 30 dias levou 282 ms, contra 1,49 a 1,54 s antes.
- **Vercel:** publicou o `57eb7961`. A web não muda.
- **Próxima etapa:** em 26/11, conferir UpSeller e `sync.listing.item`.

### 25/11/2026 · Claude Sentinel: portas da stack de testes (D-875)

- **Causa:** o e2e da `main` falhou hoje com a 60022 ocupada. O bloco de portas da stack de testes caía na faixa temporária do Linux.
- **Correção:** o `isolate-supabase` passa a começar em 61000, e o teste confere o limite.
- **Testes:** `node --test scripts/isolate-supabase.test.mjs`.
- **Próxima etapa:** varredura das consultas mais caras na VM, só com leitura.

### 25/11/2026 · Claude Sentinel: consultas mais caras e ledger pela chave (D-876)

- **Leitura:** `pg_stat_statements` na VM, só leitura. A soma maior é a do worker em `sync.order-logistics`, que lê o ledger inteiro por `OFFSET` (última página ~28 vezes a primeira).
- **D-876:** `readAllPagesByKey` no worker, usado pelo `lerLedger`. As linhas e a ordem são as mesmas.
- **Achado:** o `ml-fulfillment-fetch` lê todo o histórico de snapshots por `OFFSET`, ordenado por coluna não única (D-131). É a próxima fatia.
- **Testes:** `tsc`, `eslint` e os 1.037 testes do worker.
- **Próxima etapa:**
  - deploy do `worker`, com autorização do dono;
  - a última captura do Full no SQL;
  - medir como membro as RPCs de 4 a 5 s.

### 25/11/2026 · Claude Sentinel: análise de compra (D-877) e merges

- **#413 (D-875) e #414 (D-876):** mergeados com autorização do dono. A `main` está em `32e8372b`.
- **Deploy do worker não feito:** produção roda a imagem `c5882974`, do candidato do Codex, fora da `main`. Publicar a `main` desfaria ~7 mil linhas do worker, entre elas a D-776 e as correções do M05.
  - A parte do worker da D-876 entra limpa sobre o `c5882974`.
  - **Decisão do dono (26/11):** a D-876 chega ao worker de produção pelo candidato do Codex. Não há imagem própria. Pedido feito no #351.
- **Correção:** o achado do Full na D-876 já estava resolvido pela D-776, na imagem de produção.
- **Central medida como membro:** meta do mês, detector de frete e faturamento ficam abaixo de 1,1 s com o cache quente.
- **D-877:** `get_purchase_analysis` caiu de 3,0 a 3,6 s para ~0,3 s (50 SKUs), com seis recortes iguais. A migration é `20261125200000`.
- **Testes:** suíte de integração do `@sb/db` com a migration, com as 10 falhas de baseline. Mais `pnpm docs:check`.
- **Próxima etapa:**
  - publicar a D-877 com autorização;
  - conferir o `APP_COMMIT` quando o candidato publicar o worker com a D-876;
  - a 1ª venda da Shopee na análise de compra.

### 26/11/2026 · Claude Sentinel: conferências do dia (UpSeller e M05)

Tudo lido pela VM em modo só leitura.
- **Anúncios do ML (M05).** Desde que a `worker-m05-cf6dae2d` assumiu o tráfego (25/11 11:39 UTC), `sync.listing.item` teve uma única falha num dia inteiro: menos de 0,1 %. Foi um envelope do multiget com status conflitante. As 17 falhas da hora das 11 UTC de 25/11 são de antes da troca. `sync.listings.snapshot` fechou sem falha. **Para o inventário:** o M05 pode ser aceito.
- **Saldos LOCAL negativos.** Caíram de 25 para 8 depois da captura de 25/11. A verificação diária do ledger (`maintenance.verify-ledger-integrity`, 09:30 UTC) terminou sem divergência.
  - **6 dos 8** são SKUs que saíram da planilha do UpSeller. Estão marcados como ausentes desde 24/11, inativos e descontinuados. A última captura deles é de setembro ou outubro, e as vendas posteriores passaram do saldo daquela planilha. Captura nova nenhuma vai corrigi-los, porque eles não estão mais nela. Só um teve saída depois de marcado como ausente, no próprio dia 24/11.
  - **2 dos 8** estão na planilha nova. São vendas depois da captura acima do saldo dela, e somem com a próxima planilha.
  - **Ação do dono:** decidir o que fazer com o saldo negativo de SKU descontinuado. As opções são zerar com um ajuste manual ou deixar como está, já que o SKU está inativo.
- **Próxima etapa:** publicar a D-877 com autorização. Conferir o `APP_COMMIT` quando o candidato publicar o worker com a D-876.

### 26/11/2026 · Claude Sentinel: D-877 em produção

- **Publicação.** Com autorização do dono, o #415 entrou na `main` em `14d8c9bc`.
  - Os 4 jobs obrigatórios passaram. O do Dev falhou com "project is paused", como esperado.
  - A migration `20261125200000` foi aplicada pela VM com `psql -1`, com o mesmo sha256 dos dois lados, e registrada no histórico. A Vercel concluiu a web, que não muda.
- **Conferência.** Corpo novo, grants, comentário e registro certos. Como membro, com 50 SKUs:
  - 0,35 s sem sugestão e com o cache quente (era 3,16 s);
  - 1,31 s com sugestão (era 3,81 s).
- **Próxima etapa:** a 1ª venda da Shopee na análise de compra.

### 26/11/2026 · Claude Sentinel: 1ª venda da análise de compra (D-878)

- **Entrega:** a migration `20261126150000`. A 1ª venda da Shopee lê os itens pelo índice do SKU e cruza com os pedidos por hash. A do ML é a primeira linha do índice do SKU.
- **Em produção, só leitura e como membro:** oito recortes iguais pelo hash do JSON, contra a função da D-877. Com 50 SKUs sem sugestão, o tempo foi de 0,34–0,48 s para 0,21–0,23 s, medido nas duas ordens.
- **Testes:**
  - suíte de integração do `@sb/db` com a migration: 17 arquivos, todos passaram;
  - teste novo da 1ª venda da Shopee, que pega a falta do filtro `live` (mutação conferida);
  - `pnpm run check` e `pnpm docs:check`. O `build` não rodou: a mudança não toca código de app.
- **Próxima etapa:** publicar a D-878 com autorização do dono. Depois, `get_purchase_suggestions`, que é o que sobra com a sugestão ligada.

### 26/11/2026 · Claude Sentinel: D-878 em produção

- **Publicação.** Com autorização do dono, o #417 entrou na `main` em `f0c35bab`.
  - Os 4 jobs obrigatórios passaram. O do Dev falhou com "project is paused", como esperado.
  - A migration `20261126150000` foi aplicada pela VM com `psql -1`, com o mesmo sha256 dos dois lados, e registrada no histórico. A Vercel concluiu a web, que não muda.
- **Conferência.** Corpo novo, grants, comentário e registro certos. Como membro, com 50 SKUs: 0,25 s sem sugestão e com o cache quente, e 1,19 s com sugestão.
- **Próxima etapa:** `get_purchase_suggestions`, que é quase todo o tempo com a sugestão ligada. A numeração de decisões depois do D-879 está proposta no #351.

### 26/11/2026 · Claude Sentinel: sugestão de compra por SKU (D-879)

- **Medição:** `get_purchase_suggestions` custa 0,75–1,0 s, com o catálogo inteiro calculado a cada chamada. Duas trocas seguras sem lista tiravam só ~13 %. O dono escolheu a variante por SKU.
- **Entrega:** a migration `20261126170000`. `p_sku_ids` é opcional em `get_purchase_suggestions`, e `get_purchase_analysis` passa a lista. A curva ABC e o histórico continuam do catálogo inteiro.
- **Em produção, só leitura:** sem lista, o catálogo saiu IGUAL com a ordem. Com lista, dez recortes saíram IGUAIS. Com 50 SKUs, o tempo foi de 0,69–0,84 s para 0,47–0,51 s.
- **Testes:**
  - suíte de integração do `@sb/db`, 17 arquivos, todos passaram;
  - teste novo com um bucket do Full que trocou de SKU (mutação conferida);
  - `pnpm run check` e `pnpm docs:check`.
- **Próxima etapa:** publicar a D-879 com autorização do dono. A faixa de números do Claude acabou: a próxima decisão espera a resposta sobre a faixa nova no #351.

### 26/11/2026 · Conciliação do ensaio de D04 e da main #414

- O ensaio manual de D04, `a9ef1247` (#407), entrou localmente em `db68fd0d`. Foi repetido com rollback e recusou banco populado, host externo e redirecionamento por parâmetro da URL. As CIs de `32d4ad4b` (#364, run `45667109649`) e `a9ef1247` (#407, run `45669808681`) terminaram verdes.
- Main `32e8372b` (#414). A conciliação preserva D-874, D-875 e D-876 de Claude. Para as portas, o candidato começa em 61.000 e mantém a detecção da faixa efêmera real e das portas publicadas pelo Docker.
- Preflight em leitura: VM com 339 versões, candidato com 341. A VM tem `20261125183000` (D-874); `20261125160000` e `20261125170000` faltam abaixo dela. A guarda bloqueou a aplicação. Próximo passo é ensaiar e revisar a conciliação das duas versões antes de qualquer publicação web.
- O #409 em `7cd9753b` colide com a versão de D-886. Gemini recebeu o pedido de versão livre e teste do catálogo conjunto. #401 e #408 seguem reservados. S05 aguarda autorização de IAM. Dev e o Supabase hosted antigo seguem inativos. Inventário em 173/226.
- A instalação limpa do candidato com 341 versões passou no ensaio manual e em 1.260 testes SQL/PostgREST. Check 37/37, build 10/10, docs:check e isolamento/preflight 12/12. Em outro laboratório, duas cópias byte a byte das migrations D04 receberam versões temporárias posteriores a D-874. O upgrade de 339 para 341 passou, e as definições e permissões das duas views, da RPC e da policy corresponderam à instalação limpa. As versões temporárias ficaram no laboratório.

### 26/11/2026 · Numeração da Central conciliada com a VM e a main #415

- Candidato anterior `2ec1a00e` (#364), main `14d8c9bc` (#415). Integrei D-877 de Claude e preservei os checkpoints documentais de ambas as frentes.
- A VM tinha 339 versões até D-874 e nenhum registro dos números antigos da Central. Renumerei D-885 e D-886 de `20261125160000`/`20261125170000` para `20261126120000`/`20261126121000`. Os blobs SQL são idênticos. O #407 conserva os números originais como histórico da entrega, e o #364 é a referência do plano.
- Em laboratório com as 339 versões da VM, as três pendências entraram em ordem: D-877, D-885 e D-886. O catálogo final coincidiu com as 342 versões do checkout. Integração 1.260/1.260, ensaio de recuperação de sync_runs, preflight 10/10, check 37/37, build 10/10 e docs:check passaram.
- Próxima etapa: acompanhar a nova CI, reconferir o catálogo da VM antes da aplicação e conferir o Dev quando voltar. O #409 recebeu as novas reservas de versão. M04 e D-836 seguem com Gemini; S05 aguarda autorização de IAM. Nenhuma migration foi aplicada em produção nesta rodada. Progresso em 173/226.

### 26/11/2026 · D04, lotes de sync_runs no laboratório

- Base do ensaio: candidato `1067fd57` (#364), main `14d8c9bc`. O script manual passou a medir lotes limitados com seleção única dos checkpoints, bloqueio das linhas e rechecagem da FK. O corte conserva a janela de 24 horas.
- Em PostgreSQL local, 58 mil execuções adicionais e 8.285 erros vinculados. Lotes de 100, 500 e 1.000 preservaram saúde, cartões, pedidos, claims, vigia e pais com erros. Dois lotes consecutivos moveram 200 IDs distintos. Para mil linhas: 582–643 ms sem índice na FK e 144–157 ms com o índice parcial. Script padrão e modo benchmark passaram. [Medição](../PERFORMANCE.md#lotes-de-arquivamento-com-erros-vinculados-d04-26112026)
- CI de código, infraestrutura e integração do #364 passou, com E2E ainda em andamento ao preparar a mudança. #401, #408 e #409 continuam com Gemini. O ensaio de lotes segue para revisão separada para preservar a execução de CI do candidato.
- Progresso em 173/226. Próximo ensaio: medir concorrência com escritores e impacto do índice. A política de retenção, S05/IAM, a aplicação das migrations na VM e a homologação no Dev continuam pendentes.

### 26/11/2026 · D04, concorrência e custo de escrita do índice

- Base `1067fd57` (#364), main `14d8c9bc` e ensaio do #416 em `bed30c68`. A conciliação no candidato preservou o ensaio de lote. #401, #408 e #409 continuam sem avanço na revisão.
- No catálogo real do Supabase local, com dados sintéticos, medi as duas ordens de concorrência. O arquivador pulou o pai bloqueado por um escritor. Na ordem inversa, o escritor aguardou e recuperou a linha original. Uma escrita em outra conta concluiu durante a espera.
- Com erros já presentes, o índice parcial elevou a mediana do WAL de inserção em 24,4%. Os intervalos de latência se sobrepuseram. A conclusão é local, sem commit ou tráfego operacional. [Medição](../PERFORMANCE.md#lotes-de-arquivamento-com-erros-vinculados-d04-26112026)
- A leitura agregada da VM mediu os erros recentes e comparou janelas de 30, 60 e 90 dias. Próxima etapa: escolher a janela de retenção e revisar a implantação do índice. O índice e a política continuam fora das migrations de produção. A aprovação do IAM de S05 e a recuperação do Dev continuam pendentes. Inventário em 173/226.
- O dono confirmou a janela de 60 dias para preparar e testar. O ensaio passou a limitar o corte a essa janela e verificou proteção aos 59 dias, elegibilidade aos 61 e possibilidade de ampliar a retenção com um corte mais antigo. O ensaio padrão e o benchmark passaram. A aplicação operacional usa aprovação própria.
- A CI de `1067fd57` (#364, run `45811993635`) encerrou verde com 1.260 testes SQL/PostgREST e 414 E2E antes do push do candidato atualizado.

### 26/11/2026 · D04, reversão integral de lote de 60 dias

- Base `64d0aac9` do candidato #364 e main `14d8c9bc`. O ensaio confere a igualdade entre as linhas copiadas e retiradas do ativo. A falha simulada de uma exclusão disparou `23514`, preservou as duas linhas no ativo e deixou o arquivo vazio. A nova tentativa moveu as duas e preservou saúde, cartões e checkpoints.
- O ensaio padrão e o benchmark passaram no catálogo local de 342 versões. O laboratório descartável foi encerrado. O [procedimento](../../infra/vm/README.md#conferência-de-lotes-de-sync_runs-na-preparação-de-d04) registra as verificações antes e depois do lote, com os critérios de interrupção. A mudança está reservada ao ensaio e ao procedimento de D04.
- Próxima etapa de D04: ensaiar a recuperação de um lote já confirmado, incluindo erro tardio e repetição. A rotina e o índice ainda dependem de revisão. A aplicação operacional exige aprovação própria. V01/V02 dependem da recuperação do Dev e S05 depende da aprovação de IAM. Inventário em 173/226.
- Os gates locais passaram: `pnpm run check` 37/37, `pnpm run build` 10/10, `pnpm docs:check` e `git diff --check`. O candidato tinha código, infraestrutura e integração verdes, com E2E em execução ao isolar esta alteração na branch `codex/sentinel-d04-guardas-lote`.

### 26/11/2026 · D04, recuperação após commit e catálogo atualizado

- A reversão do lote está em 3e8cd07b, no [#418](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/418), sobre 64d0aac9 do #364. A CI [45816404079](https://github.com/PabloCoder1/speedbikers-gestao-v2/actions/runs/45816404079) cobre essa revisão de código.
- Em um Supabase local isolado com 342 migrations, arquivei duas execuções e confirmei a transação. Em transação separada, o erro tardio recuperou um pai. A recomposição por IDs, escopo e a cópia fria recuperou a outra execução e manteve a referência do erro. Repetir a recomposição inseriu zero linhas. As duas linhas recuperadas tinham o mesmo conteúdo das cópias frias. Saúde, cartões, checkpoints e vigia permaneceram equivalentes. Nenhum alerta histórico. O seletor também pulou a linha recuperada sem erro, pois seu ID já constava no arquivo. O ensaio foi temporário e o laboratório foi encerrado.
- Leitura da VM via IAP confirmou 340 versões, com D-877 em 20261125200000. No candidato 64d0aac9, o verificador aprovou o plano vinculado à revisão com apenas as duas migrations da Central pendentes. Simular D-878 aplicada primeiro fez o verificador bloquear as duas. A próxima leitura deve preceder a revisão de qualquer publicação. [Evidência no #364](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/364#issuecomment-7191576075).
- Claude entregou D-878 no [#417](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/417), revisão 8c7d1ad0. Comparei o SQL com D-877. A primeira venda é a única lógica alterada. A integração passou e o E2E estava em execução. A reserva 20261126150000 exige coordenação com a Central antes de aplicar. Gemini mantém #401, #408 e #409 nas revisões anteriores. Dev e o Supabase hospedado antigo seguem inativos. S05 aguarda autorização de IAM. Inventário em 173/226.
- Próximo passo de D04: definir a identidade dos lotes, o registro da recuperação e a condição explícita de reingresso no arquivo antes de propor uma rotina operacional. A ativação dos 60 dias e a publicação da Central continuam sob aprovação própria.

### 26/11/2026 · Conciliação da D-878 e recibo de recuperação de D04

- Base do candidato 64d0aac9 (#364), ensaio 3e8cd07b (#418) e checkpoint de05924e. Ambas as CIs de origem passaram. Main f0c35bab (#417) traz D-878 e suas evidências. O merge local 62e68257 preservou as duas frentes e regenerou o índice com 769 decisões. O teste de Compras passou em 20 de 20 casos com 343 migrations.
- A VM permaneceu em 340 versões, até D-877. O catálogo conciliado tem 343, com D-885, D-886 e D-878 pendentes nessa ordem. Simular D-878 primeiro bloqueou ambas as versões da Central. Recapturar o catálogo antes do corte e reordenar as versões pendentes se a D-878 tiver sido aplicada.
- D04 registra UUID, parâmetros e IDs removidos na mesma transação. A recuperação por recibo confere escopo e igualdade, grava o resultado e mantém a cópia fria. O ensaio padrão e o benchmark passaram. Em três sessões locais, após commit e erro tardio, duas recuperações concorrentes inseriram 1 e 0 linhas. Cópia ausente, falta de permissão e escopo incorreto foram recusados. Novo arquivamento pulou o ID recuperado. A rotina segue limitada ao laboratório.
- Gemini mantém #401, #408 e #409 nas revisões anteriores. Nenhuma mudança na reserva da Central. D04 reserva somente objetos de ensaio. S05 depende de autorização de IAM e V01/V02 seguem condicionados à retomada do Dev. Pontuação em 173/226.
- Próxima etapa: acompanhar a CI do novo candidato, preparar o piloto de D04 com identidade do operador, regra de exceção de reingresso e estratégia do índice. O corte de produção permanece sujeito a aprovação própria.

### 26/11/2026 · Catálogo após D-878 e preparação do piloto D04

- Base 8ca5e19c (#364) e main f0c35bab. A VM confirmou 341 versões e D-878 em 20261126150000. O verificador bloqueou D-885/D-886 nas versões anteriores. Renumerei as duas, sem mudar os blobs, para 20261126160000 e 20261126161000. A reserva foi comunicada no #409. Gemini mantém #401, #408 e #409 nas revisões anteriores. #407 conserva o histórico.
- O laboratório reproduziu exatamente as 341 versões lidas da VM. O upgrade aplicou as duas pendências e chegou a 343 versões, iguais às do checkout. As três regressões do histórico da Central passaram, com os demais casos fora do filtro.
- D04 usa papéis distintos para arquivar e recuperar, registra login, papel e corte efetivo. O ensaio recusou funções cruzadas e acesso direto, manteve os indicadores e preservou as linhas recuperadas. Duas conexões autenticadas com logins PostgreSQL distintos registraram autores diferentes e recusaram a troca de papel. O ensaio padrão e o benchmark passaram. Mil linhas em 666 ms sem índice e 149 ms com índice, sob dados sintéticos. A criação concorrente fora de transação resultou em índice pronto e válido. A remoção também passou. O fluxo transacional recebeu 25001.
- O piloto preparado mantém cópia fria e deixa a linha recuperada fora de novos lotes. Próxima etapa: validar identificação individual no ambiente de homologação e preparar a aplicação versionada do índice se o ganho justificar o custo. A produção requer aprovação própria. Dev/V01/V02 e S05/IAM continuam pendentes. Inventário em 173/226.

### 26/11/2026 · D04, conciliação com #419/#420 e reserva final da rodada

- A main avançou para 473370ad (#420). A VM passou a 342 versões com 20261126170000. A revisão 90f12ca0 preservou os blobs de D-885/D-886 e reservou 20261126230000 e 20261126231000, posteriores à correção #420 e à versão reservada de #421. Claude e Gemini receberam as reservas nos PRs #421 e #409.
- O laboratório reproduziu todas as 342 versões observadas. O upgrade aplicou 20261126190000 e as duas migrations da Central, totalizando 345 versões iguais ao checkout. Ensaio de D04, três casos da Central e 21 de Compras passaram. A CI do candidato anterior 8ca5e19c terminou verde.
- O piloto usa papéis separados e registra ambos os autores com dois logins PostgreSQL locais autenticados. A conexão compartilhada e a implantação do índice em carga representativa ainda dependem de homologação. Não houve aplicação em produção pelo Sentinel. Na próxima leitura, conferir se #420 ou #421 já foi aplicada, recalcular o plano e preservar a proteção do verificador.
- Inventário em 173/226. Dev e hosted antigo inativos. S05 depende de autorização. A próxima etapa local é preparar o ensaio representativo do índice para decidir se entra no primeiro piloto e conferir a atribuição de autoria no meio de execução escolhido.

### 26/11/2026 · Decisão de índice para o piloto D04

- Base 459bab7a (#364) e main 473370ad. A VM foi conferida em leitura e permaneceu com 342 versões. A correção Shopee #420 e a Central continuam pendentes. O #421 segue aberto em 1788c836. O novo commit é vazio e reacionou a CI sobre a main; a migration 20261126200000 permanece igual. Gemini mantém #401, #408 e #409 nas revisões anteriores, sem mudança de reservas.
- Consulta agregada observou 64.147 execuções, 706 erros vinculados e 214 nos últimos sete dias. O modo --benchmark-pilot repetiu seis pares alternados de lotes de 100 com a distribuição sintética. Lote em 224,5 ms sem índice e 237 ms com índice nas medianas. Escrita de 31 erros em 11.514 e 13.798 bytes de WAL, respectivamente. O ensaio com índice venceu três dos seis pares. Ensaio padrão executado pelos modos de benchmark, lote inicial e carga densa passaram.
- Proposta: iniciar homologação de até 100 linhas com os índices atuais, registrar latência por lote e espera por trava, e confirmar autoria, referências e recuperação. Reavaliar o índice antes de elevar o lote. Sem aplicação operacional. Dev/V01/V02 e S05/IAM continuam pendentes. Inventário em 173/226.

### 26/11/2026 · Primeiro lote D04 sob concorrência e catálogo após #420

- Base 629db01a (#422), candidato 459bab7a (#364), main 473370ad. A consulta em leitura confirmou 343 migrations na VM, com a correção da demanda Shopee em 20261126190000. O candidato contém 345 e apenas 20261126230000/20261126231000 pendentes. Nenhuma lacuna ou versão extra. #421 segue em 1788c836. Reservas de Gemini #401/#408/#409 permanecem.
- Ensaio isolado com 101 execuções, dois logins autenticados e dois escritores. O primeiro escritor reteve uma trava e o lote pulou o pai, arquivando 100. O segundo escritor esperou o commit, com bloqueador confirmado por pg_blocking_pids, e reidratou um pai. A recuperação autenticada repôs 99 e a repetição repôs zero. As 100 cópias corresponderam ao ativo, as duas FKs permaneceram válidas e os indicadores e o vigia ficaram iguais. Sem alerta histórico. Tempos de uma amostra sintética pequena: lote 22 ms, recuperação 23 ms, erro tardio 44 ms no total.
- Atividade limitada ao laboratório e à leitura da VM. Próxima etapa: integrar após a CI e fechar conta, identidades e orçamento de espera para homologação. O corte de produção aguarda aprovação própria. V01/V02 dependem do Dev e S05 depende da autorização para IAM. Inventário em 173/226.

### 26/11/2026 · D04, cancelamento durante a exclusão e recorte do piloto

- Base 2381b9f6 (#364), main 473370ad. A VM seguiu com 343 versões. O preflight mantém somente 20261126230000 e 20261126231000 pendentes. Claude conserva #421 em 1788c836. Gemini mantém #401, #408 e #409. Nenhuma reserva de migration nova.
- A consulta em leitura contou 17.240 execuções elegíveis em quatro escopos de conta, todos com pelo menos 100. Aplicou o corte de 60 dias, preservou os checkpoints e excluiu pais com erro. A consulta não selecionou conta para o piloto nem retornou identificadores.
- No Supabase descartável, o ensaio forçou o vencimento do prazo depois de o trigger de exclusão ser alcançado. O PostgreSQL retornou 57014. Duas linhas ativas, zero cópias e zero recibos parciais. A repetição com o mesmo UUID moveu as duas uma vez. Passaram o ensaio padrão e o benchmark-pilot com os indicadores e o vigia equivalentes.
- Próxima etapa: submeter a regressão à integração e definir a conta, os dois executores e os limites da sessão no ambiente de homologação. Dev/V01/V02 e S05/IAM seguem pendentes. Retenção e Central exigem aprovação para a aplicação operacional. Inventário 173/226.

### 26/11/2026 · Conciliação do #421 e colisão financeira do #424

- Base 9a6de46a (#423) sobre 2381b9f6 do #364. A main avançou para 16f6ca60 (#421). A conciliação em codex/sentinel-reconciliar-421 preservou as duas contribuições documentais e a extensão de sugestão do pedido de compra.
- A VM permaneceu em 343 versões. O candidato reconciliado tem 346 e lista 20261126200000, 20261126230000 e 20261126231000 como pendentes, nessa ordem. O upgrade local partiu do mesmo catálogo de 343 versões e terminou idêntico ao checkout. Passaram o ensaio de cancelamento D04, três casos da Central, o caso novo de sugestão por marca e 21 casos de Compras. A suíte RLS completa falhou no banco reutilizado após os testes focados. Após um reset limpo com 346 migrations, passou em 1.058/1.058 casos.
- O #424 em 9bd1c1dd reutiliza 20261126200000 para a fundação financeira. A guarda rejeitou os dois nomes reais carregados juntos. O responsável recebeu o aviso para atualizar a base e renumerar o par financeiro depois das reservas atuais. D-885 e D-886 mantêm 20261126230000 e 20261126231000. [Coordenação no #424](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/424#issuecomment-7198488770).
- Gemini mantém #401/#408/#409. Dev/V01/V02 e S05/IAM aguardam os mesmos desbloqueios. A próxima leitura da VM deve confirmar o estado da extensão de Compras antes de vincular um plano de corte. A homologação D04 ainda precisa da conta, dos executores e dos limites da sessão. Progresso mantido em 173/226.
