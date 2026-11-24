# AGENTS — Speed Bikers Gestão V3

**Roteador de contexto (D-177).** Este arquivo atende Codex, Claude Code e outros agentes. Não carregue o repositório inteiro nem documentos históricos por padrão. O produto já está implementado; **não reinicie a construção da V3**.

## Antes de agir

1. Confirme repositório, `git status`, branch, HEAD local/remoto, worktrees e PRs relacionados. Desde 23/09/2026, **`main` é a V3 e publica o web em produção**. `v2-legacy` e a tag `v2-final` são referências históricas.
2. Leia `docs/HANDOFF.md` como orientação, **não como status ao vivo**: compare data/commit do documento com GitHub, CI e recursos reais. Para decidir o que mudou, compare `main` com as branches/PRs abertos, inclusive `codex/sentinel-audit`/PR #328 quando ainda existirem.
3. Confirme saúde **separadamente** em Vercel, Supabase Dev (`nmgccyqquwxecqffsidr`), Supabase produção (`imvjfgnaprqsfjlnsyev`) e Google Cloud. Não presuma que deploy READY significa API/DB saudável. O estado de infraestrutura pode mudar; relatórios do Sentinel são evidência datada, não monitoramento permanente.
4. Defina o escopo e leia **apenas** o código, os contratos, migrations e documentos que a tarefa exige. Não carregue `DECISIONS.md` inteiro: use `docs/DECISIONS_INDEX.md` para localizar a decisão.

## Documentos por domínio

| Tarefa | Consultar |
|---|---|
| Papéis de agentes, delegação e coordenação | `docs/AGENT_ROLES.md`; Claude Code: `.claude/agents/` |
| Auditoria Sentinel, risco, branches | Na branch Sentinel: `docs/agent-audit/{FINDINGS,PLAN,SESSION_LOG,BRANCH_AUDIT}.md`; verificar PR atual |
| Mercado Livre | `docs/MERCADO_LIVRE.md`, `docs/API.md` |
| Shopee / multicanal | `docs/SHOPEE.md`, `docs/MULTICHANNEL_HANDOFF.md`, `docs/MULTICHANNEL_CONTRACTS.md` |
| TikTok Shop | `docs/TIKTOK_SHOP.md` e código atual; distinguir OAuth de ingestão real de vendas |
| Compras, reposição, fornecedores, importação | `apps/web/app/(app)/{compras,reposicao,fornecedores}/`, `packages/domain/src/purchasing/`, migrations/RPCs relacionadas e `docs/METRICS.md` |
| Estoque, NF-e, ledger, RLS, SQL | `docs/DATABASE.md`, migrations e código em `packages/db` |
| Preço, margem, faturamento, analytics | `docs/METRICS.md`, `docs/PRODUCT_REQUIREMENTS.md` e contratos reais de cada canal |
| Telas e design | `docs/UX_SYSTEM.md`, `docs/DESIGN_IMPLEMENTATION.md` e componentes existentes |
| Performance e testes | `docs/PERFORMANCE.md`, `docs/TESTING.md`, benchmarks/CI |
| Infraestrutura/deploy | `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `infra/`, workflows |
| Motivo de decisão | `docs/DECISIONS_INDEX.md` → trecho relevante de `docs/DECISIONS.md` |

`docs/PROMPT_MASTER.md` contém princípios gerais **e histórico de planejamento**; fases de criação da V3 não são ordens para reconstruir o sistema. A documentação especializada e o comportamento implementado prevalecem sobre trechos de planejamento antigos.

## Arquitetura real — limites

- `apps/web`: Next.js na Vercel; interface, SSR e ações rápidas, sem tarefas longas nem `service_role`.
- `apps/api`: Hono no Cloud Run; OAuth, webhooks, comandos e agendamento autenticado.
- `apps/worker`: Hono no Cloud Run; jobs Cloud Tasks, sincronização, reconciliação e projeções.
- `packages/domain`: regras determinísticas; `packages/db`: contratos e acesso Supabase/Postgres; `packages/contracts`: Zod/contratos; clientes em `packages/mercado-livre`, `packages/shopee` e `packages/tiktok-shop`.
- SKU interno é a identidade do produto. Anúncio/variante/conta/loja pertencem ao escopo de origem. Kits exigem composição. **Marca não é fornecedor.** UpSeller segue como fonte ERP relevante no fluxo de estoque; preservar ledger/reconciliação.

## Invariantes

- **Nenhuma migration manual** em Dev ou produção via MCP/SQL Editor. Versionar, revisar e testar migrations. Dev via CI no merge da `main`; produção via `.github/workflows/migrations-producao.yml` com aprovações.
- **Não fazer merge na `main` por autonomia presumida**: merge publica web. Cloud Run/worker têm ciclo separado; confirme compatibilidade e ordem de rollout antes de solicitar publicação.
- Não mexer em secrets, faturamento cloud, projetos remotos, dados reais, PRs de outros agentes ou branches incertas sem autorização explícita.
- Isolamento por organização/conta/loja, RLS/RBAC, idempotência, concorrência e histórico auditável são obrigatórios.
- Agregações escaláveis no SQL/RPC, não carregando milhares de linhas no navegador. Consulta acima de 1.000 linhas exige paginação ou agregação.
- Ausência de dado **não é zero**. Separe realizado, estimado e indisponível. Na margem: `(recebido após taxas - custo vendido) / venda bruta * 100`; consolidado é ponderado pelos valores, sem misturar contas ou inventar taxas Shopee/TikTok.
- Reposição deve explicar quantidade, considerar rupturas, idade do SKU, estoque em trânsito e baixo giro. **Sugestão de retirar do pedido não apaga SKU/anúncio e exige decisão humana.**
- Não introduzir infraestrutura, dependência ou skill sem justificar necessidade e segurança; inspecione scripts de terceiros.
- Faça mudanças pequenas e reversíveis, mantenha PR com testes; não apague branches por nome/idade. Confirmar merge, commits exclusivos, PRs, worktrees e referências antes de qualquer remoção.
- Antes de afirmar que algo funciona em produção, verifique saúde/versões **dos serviços correspondentes**.
- Registre decisões em `docs/DECISIONS.md`; handoff só com o estado atual, sem diário; histórico no lugar apropriado.

## Validação

```bash
pnpm run check
pnpm run build
pnpm docs:check
```

Execute também integração com Supabase local, Playwright e guardas de segurança conforme o código alterado. Não declarar 100% sem validação real; comunicar bloqueios externos separadamente.
