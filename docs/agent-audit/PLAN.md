# Plano priorizado do Sentinel

## Diagnóstico e critérios

Há 22 achados em [FINDINGS.md](FINDINGS.md). Vinte e um têm evidência direta ou medição. Dezesseis receberam correção local, incluindo o recorte de tentativas novas de A06. Seis seguem em aberto e dependem em algum ponto de acesso, ação ou medição externa: A01, A02, A07, A08, A10 e A11. A08 ainda é hipótese de limpeza. A publicação das correções locais é uma etapa à parte. API, worker e integrações concentram as falhas de consistência. Banco e desempenho concentram as lacunas de observação.

| Prioridade | Critério aplicado |
| --- | --- |
| P0 | Indisponibilidade observada ou risco de segurança com impacto crítico na operação. Preparar correções locais e respeitar a ordem de publicação. |
| P1 | Ato errado, perda de sincronização, bloqueio de atendimento ou falta de controle de publicação. Priorizar impacto comprovado e reprodução com baixo risco de mudança. |
| P2 | Desempenho, manutenção e limpeza. Remover apenas com dependências conferidas e exigir medição de ganho quando a mudança é motivada por custo ou latência. |
| P3 | Tipos e ajustes pontuais com baixo impacto operacional. Aproveitar cobertura existente para evitar trabalho duplicado. |

## Frentes de execução

| Grupo e prioridade | Problema, módulos e abordagem | Dependências, verificação e estado |
| --- | --- | --- |
| Disponibilidade, publicação e telemetria · P0/P1 · A01, A02, A07, A10, A21 | API, worker, Supabase, GitHub Actions e Vercel. Separar falha de serviço, versão implantada, migrations e fila. Exigir CI da revisão e restringir a leitura de `job_runs`. | Escopo de plataforma corrigido localmente em D-666. Recuperação externa antes de validar Auth/REST, `/health`, SHA, Scheduler, Tasks e `job_runs`. Revisão e checks obrigatórios dependem da administração do GitHub. |
| Dependências e entradas públicas · P0/P1/P2 · A03, A04, A12 | Next.js/Zod, Hono e parser de NF-e. Atualizações direcionadas e redução de dados arbitrários no log de push Shopee. | Pronto localmente com auditoria de dependências, teste de assinatura/ACK, servidor HTTP, NF-e e build/E2E. Publicação pela esteira. |
| OAuth e credenciais · P1 · A05, A14–A17 | Callbacks da API, RPCs e workers de refresh. Titularidade e gravação atômica, UUID por trava e proteção contra resultado de outra tentativa. | Pronto localmente. Concorrência, rollback, permissões e callback atrasado verificados. Migrations antes da API/worker, com encerramento de renovações antigas no corte. |
| SAC e avisos · P1 · A06, A13, A18 | Preservar tentativa de resposta e escopo da loja. Retomar no formulário a confirmação persistida do mesmo operador. | D-658, D-663 e toasts prontos localmente. Playwright exercitou as duas entradas do SAC com erro de fila simulado e o mesmo ID. C-82 precede a publicação web. |
| Limpeza e desempenho · P2/P3 · A08, A09, A11, A19, A20 | Git, scripts, web e SQL. Rastrear consumidores, medir chamadas/planos e devolver só os dados que a tela usa. Só versionar retirada de estruturas após conferir uso indireto, catálogo e retenção. | Inventário Git refeito, rotinas sem uso e casts removidos. Perguntas lê a primeira mensagem por caso e o detalhe pagina a conversa. Repetir Auth após #312. Confirmar frequência, cardinalidade, N+1 e dependências em tráfego representativo quando disponível. |

## Ordem e dependências

O trabalho começou pelos serviços e pela referência que publica a web para distinguir indisponibilidade, vulnerabilidade e atraso de versão. Em seguida, foram corrigidos dependências críticas, push Shopee, titularidade de OAuth, envio SAC, regras por loja e concorrência de credenciais. A segunda revisão das branches cruzou o Git remoto com PRs, worktrees e deploys.

A retomada do SAC, o carregamento do texto em Perguntas e a paginação da conversa foram exercitados localmente. A revisão de Sincronização corrigiu o escopo da telemetria e comparou as leituras de `get_sync_health`. A próxima fatia isola o custo da leitura Shopee de `get_stock_coverage_summary` com dados sintéticos, seguindo o ponto aberto de D-623. Seguem na fila vendas e faturamento, além da busca de consumidores estáticos de web e scripts. Inventário, análise estática e benchmarks locais podem avançar em paralelo com a recuperação externa. A publicação precisa respeitar a ordem migration, revisão de API/worker e web. No SAC, a versão de worker que conhece `support.reply.send.v2` precede a API, com conciliação das tentativas legadas ou de desfecho incerto.

## Fila por tarefa

| Prioridade | Tarefa | Critério de conclusão |
|---|---|---|
| P0 · depende do responsável | Restabelecer faturamento do GCP e acesso aos projetos Supabase necessários à operação | API `GET /health` responde com sucesso, Scheduler e Tasks voltam a ser observáveis, produção responde a consulta leve e `job_runs` confirma processamento recente. Conferir web, Auth e processamento em separado |
| P0 · pronto localmente | Atualizar Next.js e Zod | Auditoria alta, build e E2E selecionados aprovados. Publicação pelos fluxos existentes após revisão do responsável |
| P1 · pronto localmente | Restringir log do push Shopee | Regressão pelo endpoint demonstra 200, sem consulta ou enfileiramento para assinatura inválida, sem dados arbitrários no log |
| P1 · pronto localmente | Tornar vínculo OAuth de lojas Shopee/TikTok atômico e vinculado à organização | Concorrência, rollback, reconexão e papéis verificados. Publicar migration antes da API (D-657) |
| P1 · pronto localmente | Recuperar tentativa PENDING quando o enfileiramento falha | Mesmo ID retoma tentativa nova ainda sem início de envio. Verificados deduplicação, concorrência e POST único. Conciliação operacional para legado e desfecho incerto (D-658) |
| P1 · pronto localmente | Isolar regras de toast da Shopee por loja | Testes verificam lojas distintas, Mercado Livre e eventos sem conta. Publicar C-82 antes do build web |
| P1 · pronto localmente | Impedir resultado tardio de renovação de sobrescrever reconexão Shopee (A14, D-659) | Testes preservam o par, o status e a trava atuais. Migration deve preceder o worker |
| P1 · pronto localmente | Distinguir aquisições da trava Shopee com o mesmo prazo (A16, D-661) | UUID impede que sucesso, liberação ou recusa tardios alterem a credencial atual. Aplicar a migration antes do worker |
| P1 · pronto localmente | Proteger reconexão Mercado Livre de refresh anterior (A15, D-660) | Sucesso e recusa antigos preservam o novo par, a conta e a trava. Aplicar migration e coordenar a publicação da API e do worker |
| P1 · pronto localmente | Preservar conexão Mercado Livre diante de falha em outro callback OAuth (A17, D-662) | Duas autorizações da mesma conta confirmam que a recusa tardia preserva CONNECTED e a primeira tentativa recusada ainda registra ERROR. Publicar com a API |
| P1 · pronto localmente | Retomar confirmação pendente do SAC após recarregar o formulário (A18, D-663) | Falha de fila simulada e recarga preservaram a confirmação e o conteúdo nas duas telas. A ação manual repetiu o mesmo payload |
| P2 · pronto localmente | Limitar a leitura de mensagens na lista de Perguntas (A19, D-664) | Retornar a primeira mensagem por caso mesmo com mil eventos anteriores, preservar casos vazios e reduzir chamadas |
| P2 · pronto localmente | Paginar a conversa no detalhe do atendimento (A20, D-665) | Verificar 50 mensagens por página, empates de horário, chegada entre cliques e escopo por conta |
| P1 · pronto localmente | Restringir o escopo de plataforma das RPCs de saúde (A21, D-666) | Excluir da última execução, das contagens e dos motivos os jobs de organizações removidas. Preservar o heartbeat e publicar a migration pela esteira |
| P2 · medido localmente | Medir leituras de saúde de `/sincronizacao` | Três RPCs medidas com ADMIN e GESTOR em [volume sintético](../PERFORMANCE.md#rpcs-de-saúde-da-sincronização-12112026) |
| P2 · pronto localmente | Compartilhar a leitura dos indicadores de `get_sync_health` (A22, D-667) | Equivalência sob RLS em três volumes e regressão para última execução, sucesso, recência e contagens |
| P2 · próxima etapa local | Isolar o custo da Shopee em `get_stock_coverage_summary` (D-623) | Comparar blocos e resultado da leitura com SKUs, lojas e vendas sintéticas sob RLS |
| P1 · depende do responsável pelo GitHub | Exigir revisão e checks na `main` que publica a web | Configurar os checks de typecheck/lint/test/build, integração, E2E e scripts, e conferir as regras efetivas e uma tentativa de merge com check pendente |
| P2 · segunda triagem concluída | Classificar branches e artefatos com o [inventário](BRANCH_AUDIT.md) e as [evidências de uso](CLEANUP_CANDIDATES.md) | 106 exclusões novas verificadas. Restam 23 refs, com PR aberto, worktree ou finalidade histórica. Dois registros órfãos de worktrees e três rotinas sem consumidores removidos em sessões anteriores |
| P2 · depende de acesso | Medir consultas quentes e uso de estruturas com risco de descontinuação | Consultar catálogo e janela de estatísticas, inspecionar planos representativos em ambiente autorizado e confirmar consumidores indiretos e retenção |
| P2 · pronto localmente | Atualizar Hono, adaptador Node e parser XML | Auditoria passou. Testes locais cobrem o servidor HTTP e a leitura da NF-e |
| P2 · medido localmente | Medir chamadas ao Auth na navegação | Dois GETs por render completo nas três rotas medidas, com Auth simulado. Repetir o ensaio após o PR #312 |
| P3 · pronto localmente | Retirar casts temporários de Sugestões | Compilação e E2E de envio e triagem aprovados |

[Achados e evidências](FINDINGS.md) · [Checkpoint](SESSION_LOG.md)
