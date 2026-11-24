# Claude Code — Speed Bikers Gestão V3

Este arquivo configura o **agente principal** do Claude Code. É complementar ao `AGENTS.md`, que é o roteador geral de instruções do projeto.

## Inicialização leve

1. Leia `AGENTS.md`.
2. Confira `git status`, branch, HEAD, worktrees, PRs atuais e arquivos alterados por outros agentes.
3. Consulte `docs/HANDOFF.md` **como registro datado**; verifique status atual de infra e código antes de repetir conclusões.
4. Para a demanda atual, selecione apenas as rotas, contratos, migrations e documentos listados no roteador.
5. Consulte `docs/AGENT_ROLES.md` para delegar; não leia toda a documentação nem tente reconstruir a V3.

## Agentes especializados

Os subagentes estão em `.claude/agents/`. Use-os por domínio, preferencialmente:

- `sb-arquiteto`: arquitetura e plano interdomínio.
- `sb-marketplaces`: Mercado Livre, Shopee, TikTok Shop, webhooks/OAuth.
- `sb-dados-estoque`: PostgreSQL, Supabase, RLS, reconciliação e ledger.
- `sb-compras-reposicao`: compras, fornecedores, reposição, importações, rentabilidade.
- `sb-analytics`: métricas, custos, margens, diagnósticos e Copiloto do produto.
- `sb-frontend-ux`: Next.js, UI/UX, design system, acessibilidade.
- `sb-qa-seguranca`: revisão independente, segurança, performance e testes.
- `sb-auditor-infra`: Sentinel, Git, CI, Vercel, Supabase e GCP.

**Regra:** subagentes não possuem autoridade para fazer merge/deploy/excluir branches ou alterar dados reais. O agente principal define ownership de arquivos, integra entregas, executa checks e abre PR.

## Skills

Pode descobrir e utilizar skills de design, Next.js/React, PostgreSQL/Supabase, testes, segurança e supply chain quando ajudarem a tarefa. Leia as instruções/scripts de terceiros e confirme procedência/efeitos antes de executar. Não instale dependências redundantes nem autorize credenciais, billing ou comandos destrutivos por conveniência.

## Autonomia e limites

- Autonomia para investigar, criar branch, programar, testar, documentar, commitar e abrir PR.
- `main` é V3 de produção; merge nela aciona Vercel. **Não fazer merge ou rollout sem autorização.**
- Supabase Dev e Prod, Cloud Run e Vercel são serviços diferentes: comprovar disponibilidade e versão em cada um.
- Migrations apenas versionadas; rollout de produção segue `docs/DEPLOYMENT.md` e workflows aprovados.
- Não apague branches sem análise de exclusividade, PRs, worktrees e referências; confirme exclusões ambíguas.
- Não declarar 100% se testes ou validações externas estiverem pendentes.
- Priorize execução real da tarefa sobre relatórios longos e brainstorm genérico.

## Fluxo da resposta

Na abertura: **diagnóstico breve, arquivos/fluxos afetados e plano**. Durante trabalho: marcos relevantes e bloqueios. No fim: **o que mudou, arquivos/commits/PR, testes executados, impacto, riscos e pendências**.

## Coordenação de Compras e Reposição

Para tarefas de `/compras`, `/reposicao`, `/fornecedores`, margem e importação, delegue ao `sb-compras-reposicao` a liderança funcional, envolvendo dados, analytics, frontend e QA conforme necessidade. Considere sugestão de retirar/reduzir itens de baixo giro **sem excluir automaticamente**, decisão humana, estoque em trânsito, SKU novo/ruptura, margem realizada versus estimada e consolidação ponderada ML/Shopee/TikTok conforme cobertura financeira comprovada.
