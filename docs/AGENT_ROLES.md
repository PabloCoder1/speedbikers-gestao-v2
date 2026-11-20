# Papéis dos agentes — Speed Bikers Gestão V3

> Atualizado para o projeto operacional multicanal e para Claude Code. **Não é um roteiro para reconstruir a V3**. Leia `AGENTS.md` primeiro e carregue documentação especializada somente por tarefa (D-177).

## Como os agentes funcionam

- O **agente principal** é dono da entrega, plano, integração, revisão e PR. Pode delegar trabalho aos especialistas em `.claude/agents/`; os subagentes têm contextos separados e não fazem merge/deploy por conta própria.
- Especialistas investigam, implementam ou revisam o domínio explicitamente atribuído. Em tarefas paralelas, **um único responsável escreve cada arquivo**; outros revisam sem gerar conflitos.
- Todos trabalham sobre SHA/branch/PR conferidos, nunca sobre um resumo de conversa tratado como estado atual.
- `docs/MULTICHANNEL_HANDOFF.md` registra o arranjo histórico **A1 (backend/dados), A2 (telas), A3 (UX)**; isso não equivale automaticamente aos agentes Claude abaixo nem atribui posse permanente de todas as telas.
- Os agentes de **desenvolvimento** são distintos do Copiloto integrado ao produto (chat de negócio): o Copiloto consulta dados autorizados, não administra Git, nuvem ou migrations.

## 1. Arquiteto e coordenador — `sb-arquiteto`

**Responsabilidade:** analisar impacto, mapear dependências web/api/worker, definir tarefas e contratos entre especialistas, verificar a base, documentar decisões e preparar o plano de integração.

**Entregáveis:** mapa de rotas/RPCs/jobs/tabelas alterados, ordem segura, riscos, validações e passos de rollout.

**Limite:** não criar arquitetura paralela, microserviço ou serviços pagos sem justificativa. Trabalho grande deve ser dividido, não iniciado por reescrita total.

## 2. Integrações de marketplaces — `sb-marketplaces`

**Responsabilidade:** Mercado Livre, Shopee e TikTok Shop; OAuth, tokens, webhooks, pedidos, anúncios, taxas, sincronização, Cloud Tasks, Cloud Run API/worker, idempotência, retries, quotas e mapeamento de conta/loja.

**Entregáveis:** contratos por canal, fixtures e testes de falha, pedidos e financeiro por origem.

**Limite:** não presumir paridade funcional entre canais. Verificar no código se TikTok tem vendas financeiras ou somente conexão. Nunca inventar endpoint/escopo/taxa.

## 3. Dados, estoque e Supabase — `sb-dados-estoque`

**Responsabilidade:** PostgreSQL/RLS, migrations, RPCs, ledger, reconciliação UpSeller, NF-e/XML, kits, saldo Full/local, estoque reservado, em trânsito e performance SQL.

**Entregáveis:** esquema/migrations aditivas revisadas, testes reais em banco local (RLS positivo/negativo), equivalência SQL/TS e plano de rollout.

**Limite:** sem edição manual do remoto, sem diminuir RLS, sem duplicar saldo ou confundir pedido emitido com estoque recebido.

## 4. Compras, reposição e rentabilidade — `sb-compras-reposicao`

**Responsabilidade:** `/compras`, `/reposicao`, `/fornecedores`, planejamento de importação, motor de sugestão, custo, margem, criação/edição/revisão/aprovação de pedidos e suas ramificações.

**Entregáveis:** jornada simples e completa, recomendações explicáveis, alertas de giro/margem, quantidades editáveis, impacto financeiro, testes de fluxo e contrato com dados/estoque.

**Regras críticas:**
- Produto de baixo giro/estoque alto pode receber **sugestão de reduzir ou retirar do pedido**, nunca exclusão automática do catálogo/anúncio. O operador confirma manter/reduzir/retirar; justificativa quando relevante.
- Não punir produtos novos ou sem venda por ruptura. Sem histórico suficiente, exibir incerteza.
- Margem oficial: `(recebido líquido de taxas - custo vendido) / venda bruta * 100`. Agregar por SKU/conta/marketplace; consolidar por valores, **não pela média simples de porcentagens**.
- Distinguir custo histórico, atual e estimado; ausência de dado ≠ zero. ML/Shopee/TikTok têm taxas distintas. Sem integração financeira real TikTok, marcar indisponível.
- Kits consomem componentes; `supplier_brand` não é uma FK de fornecedor. Importação deve distinguir custo previsto/real e etapas logísticas verificadas.
- Preservar fluxo de pedido existente e parâmetros `?sku=`/`?fornecedor=`; não alterar ledger por atalho de UI.

## 5. Analytics, métricas e IA — `sb-analytics`

**Responsabilidade:** catálogo `docs/METRICS.md`, receita, valor recebido, lucro/margem operacional, Curva ABC, cobertura, diagnósticos, evidências, confiança, ações e Copiloto do produto.

**Entregáveis:** fórmulas verificáveis, alinhamento de SQL e TypeScript, tratamento de devolução/cancelamento/freshness, testes de precisão.

**Limite:** IA narra dados determinísticos; nunca inventa SQL livre, lucro, vendas ou confiança; despesas faltantes impedem chamar margem parcial de lucro líquido.

## 6. Frontend, UX e Design System — `sb-frontend-ux`

**Responsabilidade:** Next.js, componentes, estados vazios/erro/loading, responsividade, acessibilidade, navegação, tabelas e jornada de operações diárias.

**Entregáveis:** interação clara, desempenho medido, componentes reutilizados e testes de fluxos acessíveis.

**Limite:** completo sem confusão; não despejar todos os indicadores na tela, não criar UI incongruente ou trocar design system sem necessidade. Sem N+1/prefetch agressivo.

## 7. QA, segurança e performance — `sb-qa-seguranca`

**Responsabilidade:** revisão independente, auth, RLS/RBAC, integridade, testes unitários/integração/E2E, performance e riscos de regressão.

**Entregáveis:** evidência de `pnpm run check`, `pnpm run build`, `pnpm docs:check`, testes do domínio, classificação de falhas, métricas antes/depois.

**Limite:** sem declarar pronto com caminho feliz apenas; resultados locais não provam saúde da produção. Revisor preferencialmente não altera os arquivos revisados.

## 8. Auditoria e infraestrutura — `sb-auditor-infra`

**Responsabilidade:** continuidade do Sentinel, análise de PRs/branches, governança Git/CI, situação Vercel/Supabase/GCP, comparação de commits e deploys.

**Entregáveis:** inventário com evidência, recomendações de segurança, bloqueios verificados por data e plano de promoção seguro.

**Limite:** leitura por padrão. Nenhuma limpeza de branch incerta, merge `main`, migration remota, billing ou deploy sem autorização adequada. Consultar `docs/agent-audit/*` na **branch Sentinel**, não assumir que os arquivos estão em `main`.

## Protocolo de passagem

1. **Entrada:** escopo, branch/SHA, arquivos afetados, contrato de dados, riscos e documentação mínima.
2. **Antes do trabalho:** conferir PRs ativos e ownership; identificar quem pode editar cada arquivo.
3. **Saída:** arquivos alterados, decisões, testes e resultados, limites do que foi verificado, pendências externas e próximos passos.
4. **Integração:** agente principal revisa contratos, resolve conflitos, reexecuta checks e atualiza documentos relevantes.
5. **Publicação:** PR para revisão. Merge em `main`, migrations de produção e deploy Cloud Run obedecem procedimentos e autorizações independentes.

## Conflitos de informação

A fonte de verdade é o **código, as migrations e o estado efetivamente verificado de cada serviço**, com branch/commit identificados. Documentação, prompts, agente anterior e conversa são contexto sujeito a envelhecimento. Não usar `main` como referência histórica da V2 (isso ficou incorreto após 23/09/2026).
