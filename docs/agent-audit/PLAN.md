# Plano priorizado do Sentinel

## Diagnóstico e critérios

Há 78 achados em [FINDINGS.md](FINDINGS.md). Setenta e sete têm evidência direta ou medição. Setenta e três receberam correção, incluindo o recorte de tentativas novas de A06, o prefetch da barra lateral de A11 e a remoção de 32 exports internos desnecessários de A25. Seis ainda têm ações ou medições externas (A01, A02, A07, A08, A10 e A11). A08 segue como hipótese de limpeza. A publicação das correções locais é uma etapa à parte. API, worker e integrações concentram as falhas de consistência. Banco e desempenho concentram as lacunas de observação. A varredura final de antecipação de queries (13/11) confirmou que todas as rotas de alto tráfego não cobertas pelo D-670–D-684 já estão otimizadas: nenhuma oportunidade nova foi encontrada. A segunda rodada de dependências (13/11) reduziu a auditoria de 6 avisos (1 alto + 5 moderados) para 1 moderado residual (uuid via GCS/exceljs, sem fix sem major bump).

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
| Limpeza e desempenho · P2/P3 · A08, A09, A11, A19, A20 | Git, scripts, web e SQL. Rastrear consumidores, medir chamadas/planos e devolver só os dados que a tela usa. Só versionar retirada de estruturas após conferir uso indireto, catálogo e retenção. | Inventário Git refeito, rotinas sem uso e casts removidos. Perguntas lê a primeira mensagem por caso e o detalhe pagina a conversa. O Chromium mediu Auth em documentos, prefetch e navegação real (D-686). Confirmar frequência, cardinalidade, N+1 e dependências em tráfego representativo quando disponível. |

## Ordem e dependências

O trabalho começou pelos serviços e pela referência que publica a web para distinguir indisponibilidade, vulnerabilidade e atraso de versão. Em seguida, foram corrigidos dependências críticas, push Shopee, titularidade de OAuth, envio SAC, regras por loja e concorrência de credenciais. A segunda revisão das branches cruzou o Git remoto com PRs, worktrees e deploys.

A retomada do SAC, o carregamento do texto em Perguntas e a paginação da conversa foram exercitados localmente. A revisão de Sincronização corrigiu o escopo da telemetria e comparou as leituras de `get_sync_health`. O resumo de cobertura usa os limites do dia de São Paulo no timestamp indexado dos pedidos Shopee. A contagem numérica de compras reduziu o custo de `get_faturamento` sob RLS. A Central compartilha a leitura do período atual e os três recortes de Faturamento antecipam as consultas quando o filtro dispensa a lista de contas. A Curva ABC inicia suas consultas assim que a organização e a seleção pedida estão resolvidas. A publicação precisa respeitar a ordem migration, revisão de API/worker e web. No SAC, a versão de worker que conhece `support.reply.send.v2` precede a API, com conciliação das tentativas legadas ou de desfecho incerto.

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
| P2 · pronto localmente | Recortar a Shopee em `get_stock_coverage_summary` pelo horário de criação (A23, D-668) | Equivalência em quatro janelas sob RLS, medição com 60 mil pedidos e regressão dos limites do dia em São Paulo |
| P2 · medido localmente | Medir `get_faturamento` com e sem detalhe nas chamadas da web | Ensaio com 60 mil pedidos, três janelas e filtros de conta sob ADMIN e GESTOR. Medidos tempo e blocos e verificada equivalência do resumo. [Medição](../PERFORMANCE.md#faturamento-do-ml-com-e-sem-detalhe-sob-rls-sentinel-13112026) |
| P2 · pronto localmente | Contar compras pelos IDs numéricos em `get_faturamento` (A26, D-669) | Equivalência do JSON completo em 36 combinações e regressão para colisão de IDs entre pedido avulso e pacote |
| P2 · medido localmente | Contar chamadas de faturamento por carga da Central | 13 cargas autenticadas confirmaram duas chamadas do ML e uma da Shopee no recorte consolidado. [Medição](../PERFORMANCE.md#chamadas-de-faturamento-por-carga-da-central-sentinel-13112026) |
| P2 · pronto localmente | Antecipar as consultas do período de `/faturamento` no ML (A27, D-670) | Medir início das RPCs e confirmar recortes sem slug, com conta permitida e com slug desconhecido |
| P2 · pronto localmente | Antecipar as consultas dos recortes Shopee e Todos em `/faturamento` (A28, D-671) | Rastrear as RPCs em quatro recortes e validar a organização, os filtros e o compartilhamento de leituras com a Central |
| P2 · pronto localmente | Antecipar as consultas de `/vendas` multicanal (A29, D-672) | Conferir organização, conta, período, marca e quantidade de chamadas em cinco recortes |
| P2 · pronto localmente | Encerrar a série de até 90 dias na primeira página completa (A30, D-673) | Medição das duas RPCs, contagem ausente e página parcial com teto menor, gráfico e CSV |
| P2 · pronto localmente | Antecipar as consultas do recorte ML em `/vendas` (A31, D-674) | Medir início, filtro de conta e marca, e validar gráfico, navegação e CSV |
| P2 · pronto localmente | Antecipar lista e contadores em `/anuncios` (A32, D-675) | Rastrear as duas RPCs em quatro recortes e conferir busca, estado e conta |
| P2 · pronto localmente | Antecipar lista e resumo em `/anuncios/shopee` (A33, D-676) | Quatro recortes com os mesmos argumentos e prova de zero consultas para GESTOR sem loja visível |
| P2 · pronto localmente | Antecipar as consultas de `/vendas/shopee` (A34, D-677) | Quatro recortes com argumentos iguais e zero RPCs para GESTOR sem loja visível |
| P2 · pronto localmente | Antecipar as consultas de `/curva-abc` (A35, D-678) | Sete recortes com os mesmos argumentos antes e depois e equivalência dos filtros aplicados à curva e ao XLSX |
| P1 · pronto localmente | Completar a leitura das regras em `/reposicao` e `/reposicao/configuracoes` (A36, D-679) | 1.003 regras lidas sob RLS, precedência por SKU e 1.002 exceções verificadas |
| P1 · pronto localmente | Restringir a leitura de regras na inspeção de `/produtos` (A37, D-680) | Uma chamada com até três regras. Precedência, marca com pontuação, ausência de regra e isolamento confirmados |
| P2 · pronto localmente | Antecipar a visão e os painéis de `/vinculacoes` (A38, D-681) | Quatro recortes com os mesmos argumentos e limites. Tabela alternativa conferida com falha simulada da visão |
| P2 · pronto localmente | Antecipar a consulta de `/precos` e evitar leitura sem conta no XLSX (A39, D-682) | Quatro recortes com os mesmos argumentos. O arquivo foi baixado e conferido em cada recorte |
| P2 · pronto localmente | Antecipar a consulta de `/full` no consolidado (A40, D-683) | Quatro recortes com os mesmos argumentos da tela e do CSV. Assinatura antiga conferida com falha simulada |
| P2 · pronto localmente | Antecipar lista e contadores em `/atendimento/perguntas` (A41, D-684) | No consolidado, a lista e os contadores iniciam junto com as contas. D-685 conferiu as chamadas em cinco recortes |
| P1 · pronto localmente | Segunda rodada de correções de dependências (A42) | Atualizações validadas em `c88ea687`. O `uuid` transitivo permaneceu como pendência registrada na rodada de 13/11 |
| P2 · pronto localmente | Recuperar paginação fora do recorte em Perguntas (A43, D-685) | Reproduzir o HTTP 416 e voltar à primeira página com o filtro de conta |
| P2 · pronto localmente | Reduzir as verificações de Auth disparadas pela barra lateral (A11, D-686) | Medir duas jornadas completas e conferir CSP, acesso sem sessão e sinal de troca de tela |
| P2 · pronto localmente | Consultar sob demanda os destinos dos atalhos de Configurações e dos cartões de Estoque (A44, D-687) | Comparar duas jornadas, verificar requisição RSC no clique e preservar a âncora de reposição |
| P2 · pronto localmente | Consultar os destinos por SKU na tabela de Estoque ao clicar (A45, D-688) | Rolar uma página de 100 SKUs e conferir o detalhe e o ajuste do mesmo item |
| P2 · pronto localmente | Consultar os destinos por linha em Anúncios do Mercado Livre ao clicar (A46, D-689) | Rolar uma página com 100 anúncios e verificar detalhe, SKU e abertura direta da aba Preços |
| P2 · pronto localmente | Consultar os SKUs vinculados em Anúncios da Shopee ao clicar (A47, D-690) | Rolar uma página com 50 anúncios, abrir o SKU correto e voltar ao mesmo filtro |
| P2 · pronto localmente | Consultar anúncio e SKU ao clicar na tabela de Vinculações (A48, D-691) | Rolar uma página com 50 anúncios e validar os detalhes e o retorno à busca |
| P2 · pronto localmente | Consultar SKU e Reposição ao clicar na tabela da Central Full (A49, D-692) | Rolar uma página com 50 SKUs, validar o detalhe e a busca pelo SKU em Reposição |
| P2 · pronto localmente | Incluir saldo Full positivo atual em Reposição e no alcance das regras (A50, D-693) | Validar busca, contagens, RLS e ausência de sugestão sem amostra. Publicar a migration pela esteira |
| P2 · pronto localmente | Consultar o detalhe do SKU ao clicar na tabela de Produtos (A51, D-694) | Rolar uma página com 100 SKUs, abrir o detalhe e verificar o retorno à busca e a Inspeção rápida |
| P2 · pronto localmente | Consultar o detalhe do SKU ao clicar na tabela de Reposição (A52, D-695) | Rolar uma página com 100 SKUs, abrir o detalhe e voltar à busca e ao filtro Sem estado |
| P2 · pronto localmente | Consultar o detalhe do SKU ao clicar na Curva ABC (A53, D-696) | Rolar uma página com 50 SKUs, abrir o detalhe e voltar à busca, ao período e ao critério |
| P2 · pronto localmente | Consultar o detalhe do SKU ao clicar no ranking de Produtos da Central (A54, D-697) | Rolar 50 SKUs e conferir o detalhe e o retorno à conta, ao período e à ordem |
| P2 · pronto localmente | Consultar o anúncio ao clicar no Detector de frete (A55, D-698) | Rolar 30 observações e conferir o detalhe e o retorno ao nível escolhido |
| P2 · pronto localmente | Consultar o SKU ao clicar nos rankings de Vendas (A56, D-699) | Rolar o ranking cheio nos recortes Mercado Livre e Todos e conferir o detalhe e o retorno ao recorte |
| P2 · pronto localmente | Consultar o SKU ao clicar na lista de pedidos de Vendas da Shopee (A57, D-700) | Rolar uma página de 50 pedidos e conferir o detalhe e o retorno à lista |
| P2 · pronto localmente | Consultar o SKU e a origem ao clicar em Movimentações (A58, D-701) | Rolar uma página de 50 movimentos e conferir o SKU, o pedido de compra, a nota fiscal e o retorno à lista |
| P2 · pronto localmente | Consultar o SKU ao clicar nas listas de produtos do Faturamento (A59, D-702) | Rolar o ranking por receita cheio e conferir o detalhe e o retorno ao recorte |
| P2 · pronto localmente | Consultar o SKU e o anúncio ao clicar no Histórico de Preços (A60, D-703) | Rolar uma página de 50 alterações e conferir o SKU, o anúncio e o retorno à tabela |
| P2 · pronto localmente | Consultar o SKU ao clicar nas exceções da Configuração de Reposição (A61, D-704) | Rolar 50 exceções e conferir o detalhe e o retorno à tela |
| P2 · pronto localmente | Consultar o SKU vinculado ao clicar no detalhe do pedido de compra (A62, D-705) | Rolar pedidos com 2 e 50 SKUs, abrir a posição medida e voltar ao mesmo pedido |
| P2 · pronto localmente | Consultar o SKU ao clicar na lista de produtos do fornecedor (A63, D-706) | Rolar a seção SKUs já comprados em tabelas de tamanhos diferentes, abrir o SKU e voltar ao mesmo fornecedor |
| P2 · pronto localmente | Consultar o anúncio do Mercado Livre ao clicar no detalhe do SKU (A64, D-707) | Medir Visão geral, Anúncios e Preços e conferir o retorno à mesma aba |
| P2 · pronto localmente | Consultar o pedido de compra ao clicar no painel do fornecedor (A65, D-708) | Rolar fornecedores com 2 e 50 pedidos, verificar número, item e retorno ao painel |
| P2 · pronto localmente | Consultar ao clicar os anúncios da Shopee no SKU e os SKUs em Devoluções (A66, D-709) | Conferir busca pelo item, SKU vinculado e retorno à aba ou loja no ensaio `loja-live` |
| P2 · pronto localmente | Abrir as abas do cabeçalho nos detalhes do SKU e do anúncio ao acioná-las (A67, D-710) | Comparar as trocas Visão geral e Preço nas duas direções. Verificar indicador de atualização, aba ativa e retorno |
| P2 · pronto localmente | Abrir ao clicar os atalhos de abas na Visão geral do SKU e do anúncio (A68, D-711) | Medir seis caminhos, inclusive Histórico pelo menu Ações, e conferir aba ativa e retorno |
| P2 · pronto localmente | Abrir os destinos do menu Ações do anúncio ao clicar (A69, D-712) | Conferir anúncio com e sem SKU, seis destinos, busca pelo MLB e retorno ao anúncio |
| P2 · pronto localmente | Abrir o atalho de Diagnóstico para Anúncios ao clicar (A70, D-713) | Comparar consolidado e conta na URL e conferir o retorno ao recorte de origem |
| P2 · verificado localmente | Verificar Reler agora no Diagnóstico do SKU | Regressão altera estoques de duas contas após a página abrir. A releitura inclui ambas no consolidado e apenas a selecionada no recorte, com indicador de atualização |
| P1 · pronto localmente | Completar a leitura dos anúncios ML do SKU e preservar a conta do vínculo sem leitura (A71, D-714) | Regressão com 1.002 anúncios, empates entre contas, variação, vínculo sem anúncio e excluído. Aplicar a migration `20261117171808` antes da web |
| P2 · pronto localmente | Completar a leitura dos anúncios Shopee do SKU (A72, D-715) | Fixture de 1.002 unidades, com variações, vínculo manual, lojas de mesmo nome, sandbox e excluídos. Migration `20261117173152` antes da web |
| P2 · verificado localmente | Conferir troca e remoção do vínculo manual Shopee no painel do SKU | Item e variação: criar manual para outro SKU, trocar entre os dois, remover e conferir os painéis pelo histórico do router |
| P2 · pronto localmente | Liberar os diálogos Shopee após falha de transporte (A73, D-716) | Vincular e remover recuperam os controles, conservam o preenchimento e avisam que a operação não foi confirmada. Recusa do catálogo e remoção concorrente também exercitadas |
| P2 · pronto localmente | Recuperar o popup de Vinculações após falha de transporte (A74, D-717) | Três regressões: vínculo manual, resolver candidato e descartar candidato. Controles liberados, SKU preservado e estado confirmado no banco antes e depois da nova tentativa |
| P1 · pronto localmente | Tirar as ferramentas de lint do audit de produção (A75) | `pnpm audit --prod --audit-level high` passa com três moderados. Conferir a publicação do `picomatch` 4.0.8 e o audit completo |
| P2 · pronto localmente | Liberar o diálogo de remover vínculo ML do SKU após falha de transporte (A76, D-718) | Regressão com POST bloqueado: controles liberados, aviso, vínculo intacto e remoção na nova tentativa |
| P2 · pronto localmente | Conservar o anúncio no diálogo de vincular do SKU após falha de transporte (A77, D-719) | Regressão com POST bloqueado: anúncio mantido, aviso, controles liberados e vínculo gravado na nova tentativa |
| P2 · pronto localmente | Liberar os controles de Notificações e Preferências após falha de transporte (A78, D-720) | Quatro regressões com o POST derrubado: aviso, controles liberados, nada gravado e estado do usuário devolvido |
| P2 · próxima verificação local | Conferir os componentes que aguardam Server Action sem tratar exceção | Restam do inventário de 17/11: `compras/novo/purchase-order-form.tsx`, `contas/new-account-form.tsx`, `notas-fiscais/[id]/document-item-row.tsx`, `sugestoes/new-suggestion-form.tsx`, `usuarios/acesso-membro.tsx`, `usuarios/member-controls.tsx`, `components/editar-nome.tsx` e `components/saved-filters.tsx`. `estoque/[skuId]/ajuste/adjustment-form.tsx`, `fornecedores/alternar-ativo.tsx`, `fornecedores/excluir-fornecedor.tsx`, `produtos/curation-table.tsx` e `reposicao/configuracoes/gaveta-regra.tsx` usam `useTransition` e precisam ser conferidos à parte. Reproduzir cada um com `derrubarPrimeiraAcao` antes de mudar |
| P1 · depende do responsável pelo GitHub | Exigir revisão e checks na `main` que publica a web | Configurar os checks de typecheck/lint/test/build, integração, E2E e scripts, e conferir as regras efetivas e uma tentativa de merge com check pendente |
| P2 · rechecado em 17/11 | Classificar branches e artefatos com o [inventário](BRANCH_AUDIT.md) e as [evidências de uso](CLEANUP_CANDIDATES.md) | 106 exclusões verificadas na segunda triagem. Permanecem 24 refs, 14 PRs abertos e sete refs integradas ligadas a worktrees |
| P2 · depende de acesso | Medir consultas quentes e uso de estruturas com risco de descontinuação | Consultar catálogo e janela de estatísticas, inspecionar planos representativos em ambiente autorizado e confirmar consumidores indiretos e retenção |
| P2 · pronto localmente | Atualizar Hono, adaptador Node e parser XML | Auditoria passou. Testes locais cobrem o servidor HTTP e a leitura da NF-e |
| P2 · medido localmente | Medir chamadas ao Auth na navegação | Dois GETs por render completo nas três rotas medidas, com Auth simulado. Repetir o ensaio após o PR #312 |
| P3 · pronto localmente | Retirar casts temporários de Sugestões | Compilação e E2E de envio e triagem aprovados |
| P2 · corrigido | Varredura de código morto em `apps/web/lib/` (A24) | Removidos os três helpers exclusivos de testes após cruzar referências com as implementações ativas |
| P3 · pronto localmente | Varredura de código morto em `packages/` e `apps/web` componentes/hooks (A25) | 34 funções e ~77 constantes sem import externo, todas vivas por cadeias internas. Zero código para apagar. 32 `export` desnecessários removidos (2 mantidos por `typeof` e o de `INCLUI` restaurado para a guarda de vocabulário da CI). `apps/web` componentes e hooks sem achados. [SESSION_LOG](SESSION_LOG.md#12112026--varredura-de-código-morto-em-packages) · [Candidatos](CLEANUP_CANDIDATES.md) |

[Achados e evidências](FINDINGS.md) · [Checkpoint](SESSION_LOG.md)
