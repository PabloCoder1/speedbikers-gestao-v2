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

### 26/11/2026 · Claude Sentinel: D-879 em produção

- **Publicação.** Com autorização do dono, o #419 entrou na `main` em `3fda54d0`.
  - Os 4 jobs obrigatórios passaram. O do Dev falhou com "project is paused", como esperado.
  - A migration `20261126170000` foi aplicada pela VM com `psql -1`, com o mesmo sha256 dos dois lados, e registrada no histórico. O PostgREST recarregou o cache de schema às 13:57 UTC.
- **Conferência.** `get_purchase_suggestions` agora só existe com `p_sku_ids`. Corpos, grants, comentário e registro estão certos, e as funções que chamam a sugestão responderam.
- **Tempo como membro, com 50 SKUs:** `get_purchase_analysis` com sugestão foi de 1,00–1,58 s para 0,83–0,87 s.
- **Próxima etapa:** a faixa de números do Claude acabou. A próxima decisão espera a confirmação da faixa D-887–899 no #351.

### 26/11/2026 · Claude Sentinel: checkpoint do fim da rodada

- **Branch e HEAD:** `claude/sessao-26-11`, a partir de `3fda54d0` (main com a D-879). O worktree é `.worktrees/sentinel-rodada`.
- **Em produção hoje, conferido:** D-877 (#415), D-878 (#417) e D-879 (#419), todas aplicadas pela VM e registradas no histórico.
- **Candidato integrado** (`8ca5e19c`): 173 de 226 pontos (76,55 %) e 33 de 43 entregas. Nada mudou nesta rodada, porque as três entregas são de compras, fora do inventário.
- **SKUs descontinuados com saldo negativo:** o dono pediu para excluí-los. Por enquanto só houve leitura.
  - A exclusão de fato esbarra em chaves `restrict`: ledger, pedidos, métricas, histórico de custo e vínculos. Dois deles são componentes de kit.
  - Ela também contraria a D-860, que manda marcar, nunca apagar.
  - A alternativa é um ajuste manual pela tela de ajuste, que zera o saldo LOCAL e mantém o histórico. Ela espera a escolha do dono.
- **Esperando o Codex (#351):**
  - confirmação da faixa D-887–899;
  - o worker do candidato com a D-876, para conferir o `APP_COMMIT` e medir a leitura do ledger.
- **Gemini:** sem comentário novo no #351 hoje.
- **Próxima etapa:**
  - a escolha do dono sobre os SKUs;
  - depois, `get_purchase_order_suggestions` com `p_sku_ids` (hoje filtra por marca sobre o catálogo inteiro). Essa fatia precisa de número de decisão.

### 26/11/2026 · Claude Sentinel: saldo negativo dos SKUs descontinuados zerado

- **Pedido do dono:** excluir os SKUs descontinuados com saldo LOCAL negativo. Ele escolheu zerar por ajuste, em vez de apagar, que quebraria ledger, pedidos e vínculos e contraria a D-860.
- **Feito em produção pela VM:**
  - um `create_manual_stock_adjustment` por SKU, como ADMIN da organização, com o modo Balanço e o motivo "SKU descontinuado, fora do catálogo do UpSeller";
  - o script só pega SKU marcado fora do catálogo, inativo e ainda negativo, então rodar de novo não grava nada;
  - foi ensaiado antes numa transação desfeita.
- **Conferido depois:**
  - seis movimentos `AJUSTE_MANUAL`, com autor;
  - o saldo LOCAL de cada um é zero e igual à soma do ledger;
  - nenhum SKU fora do catálogo ficou negativo.
- **O que não mudou:** os SKUs, o histórico de vendas, os vínculos e a marca de fora do catálogo.
