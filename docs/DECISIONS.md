# Decisões — Speed Bikers Gestão V3

Este arquivo registra decisões já aprovadas para evitar que agentes futuros reabram escolhas sem motivo.

## D-001 — Mesmo repositório, branch V3 limpa

**Decisão:** manter `PabloCoder1/speedbikers-gestao-v2` como repositório único. A `main` preserva a V2 e a `v3` é reconstruída de forma limpa.

**Motivo:** preservar histórico e permitir consulta à V2 sem carregar código/migrations antigas para a nova implementação.

## D-002 — Repositório é a memória oficial

**Decisão:** código + migrations + documentação versionada são a fonte de verdade. Conversas e memória de IA não substituem o repositório.

## D-003 — Infraestrutura principal

**Decisão:**

- Frontend: Next.js na Vercel.
- Banco/Auth/RLS: Supabase V3 Dev em São Paulo (`sa-east-1`).
- Backend pesado/workers/webhooks/jobs: Google Cloud em São Paulo (`southamerica-east1`).
- Código: GitHub.

## D-004 — SKU como entidade central

**Decisão:** SKU canônico é entidade principal de produto. MLB é anúncio/canal e pode mapear para SKU, inclusive por `variation_id`.

## D-005 — Dados antes de IA

**Decisão:** IA interpreta evidências; SQL, regras e cálculos determinísticos fornecem fatos e métricas sempre que possível.

## D-006 — Estoque auditável

**Decisão:** estoque deve ser baseado em movimentos/ledger auditáveis e idempotentes. Vendas, cancelamentos, devoluções e documentos não podem ser aplicados duas vezes.

## D-007 — UX com progressive disclosure

**Decisão:** evitar telas infinitas e excesso de informação. Preferir abas, drill-down, drawers, tooltips, filtros e hierarquia visual.

Paleta inicial:

- `#FFFFFF`
- `#0F1158`
- `#373993`
- `#E83736`
- `#CCC5D5`
- `#655D89`
- `#F8E523`

## D-008 — Eventos e notificações

**Decisão:** alterações relevantes em anúncios e operação devem ser persistidas como eventos. Notificações em tempo real respeitam permissões, severidade e agrupamento para evitar avalanche de popups.

## D-009 — Copiloto contextual

**Decisão:** o assistente integrado deve usar contexto da tela e dados autorizados para responder sobre produto, conta, estoque, compras e desempenho. Também poderá estruturar sugestões de features enviadas pelos usuários.

## D-010 — Evitar infraestrutura prematura

**Decisão:** não adicionar Redis, Kafka, Kubernetes, Elasticsearch ou microserviços adicionais sem gargalo medido ou requisito comprovado.

## Como adicionar nova decisão

Registrar:

- ID;
- contexto;
- decisão;
- motivo;
- alternativas consideradas quando relevante;
- impacto;
- data/commit quando útil.

Não reverter decisão existente silenciosamente. Registrar nova decisão que substitui a anterior e explicar o motivo.
