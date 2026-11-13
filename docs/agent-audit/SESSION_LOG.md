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
