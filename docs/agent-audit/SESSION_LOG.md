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
- **Próxima etapa.** Identificar e medir as variantes de `get_faturamento` usadas pela web. [Plano](PLAN.md)
