# Handoff V3

> Última atualização: 2026-08-19 — encerramento da sessão de arquitetura da Fase 0.

## Estado atual

- Branch: `v3`
- Referência V2: commit `8573d971a5cd427702575b52ed249c53588ec5ca` da `main`
- V3 reconstruída como branch limpa, **sem código de aplicação e sem migrations**.
- Supabase V3 Dev: criado em São Paulo (`sa-east-1`), mantido **sem tabelas de domínio**.
- Google Cloud V3: fundação criada em São Paulo (`southamerica-east1`). Cloud Run, Cloud Tasks, Scheduler, Secret Manager e Storage ainda não provisionados.
- Vercel V3: **ainda não criado**. Depende da fundação técnica da Fase 1.
- Monorepo, CI e ambientes: **ainda não criados**.

## Última etapa concluída

**Arquitetura inicial da V3 aprovada** e registrada na documentação:

- `docs/ARCHITECTURE.md` — reescrito como mapa da arquitetura, com dono documental por assunto.
- `docs/DECISIONS.md` — decisões **D-011 a D-026** registradas com motivo, alternativas e evidência medida na V2.
- `docs/ROADMAP.md` — Fases 0 a 8 refinadas com entregáveis, marcos e dependências.
- Documentação especializada criada: `DATABASE.md`, `API.md`, `METRICS.md`, `MERCADO_LIVRE.md`, `NOTIFICATIONS.md`, `COPILOT.md`, `DEPLOYMENT.md`, `TESTING.md`.

## Auditoria da V2 realizada nesta sessão

A `main` foi consultada **apenas como referência**, sem cópia de código. O que foi levantado:

- **57 tabelas** e **~90 funções** no schema da V2.
- Volumes reais: 4 contas ML · 328.211 pedidos e 328.211 itens (o Mercado Livre não entrega pedido multi-linha; compra de vários itens vira vários pedidos ligados por `pack_id`, e 189.158 tinham um) · 180.306 linhas de métricas diárias por produto · ~5.243 alertas operacionais abertos · 17 respostas HTTP 429 em 24 h.
- O relatório de auditoria técnica da V2 (`auditoria/RELATORIO.md` na `main`) forneceu as evidências medidas que sustentam D-014, D-015, D-017, D-019 e D-026.

### Achado que a documentação da V3 não cobria: UpSeller

A V2 tem **13 tabelas `upseller_*`**, um bucket privado de Storage e dois workers dedicados. Na prática, **o catálogo de produtos, os kits, o estoque e a relação canal-SKU não nasciam no sistema — nasciam de planilhas XLSX exportadas do UpSeller** e promovidas em chunks.

O `docs/PRODUCT_REQUIREMENTS.md` menciona "planilha de estoque" apenas de passagem, na Central de Vinculações. Isso subdimensiona o que era, na V2, a fonte primária do catálogo. Virou a **decisão pendente B**.

### Segundo achado

A V2 **já tinha** diagnóstico por IA e oportunidades (`product_diagnostic_runs`, `product_market_research_runs`, `product_opportunities`, `organization_ai_settings`). O que ela **nunca teve** foi notificação em tempo real, Copiloto, sugestões de feature, memória de decisões e catálogo de métricas — esses cinco são genuinamente novos na V3.

---

## Decisões respondidas em 2026-08-19

Os oito itens **A** a **H** foram respondidos e registrados como **D-027 a D-034** em `docs/DECISIONS.md`. **Nenhuma decisão de produto segue aberta.**

| Item | Resposta | Decisão |
|---|---|---|
| **A** — migração de dados da V2 | Backfill do ML para pedidos e anúncios; ETL apenas do insubstituível (vínculos, estoque, NF-e, compras) | D-027 |
| **B** — UpSeller | Permanece como ERP; a V3 reconstrói o importador e mantém as duas pontas alinhadas | D-028 |
| **B2** — divergência de estoque | UpSeller vence, com movimento `AJUSTE_RECONCILIACAO` auditável e evento crítico | D-029 |
| **C** — retenção do payload bruto | 90 dias quente mais arquivamento frio, por lifecycle do bucket | D-030 |
| **D** — Modelo A | Confirmado | D-012 |
| **E** — `organization_id` | Manter em todas as tabelas | D-031 |
| **F** — visitas, conversão e Ads | Fase 5B | D-032 |
| **G** — tela âncora | Dashboard de vendas Geral e por Conta; Fase 5 dividida em 5A e 5B | D-033 |
| **H** — exportação de compra | Excel é o principal; PDF secundário; XML adiado | D-034 |

### As três consequências que mais alteraram o plano

**1. O UpSeller vira parte do núcleo, não um anexo (D-028, D-029).** Como o lançamento manual acontece nos dois sistemas, a reconciliação deixa de ser opcional. O ledger da V3 nasce **completo e autossuficiente** — não é espelho do UpSeller — e o ERP entra como fonte de alinhamento por snapshot. Isso preserva o caminho para a V3 assumir como ERP no futuro sem reescrita: o que sai naquele dia é a importação e a conciliação, não o modelo de estoque.

**2. A ordem das fases mudou (D-033).** A tela âncora é o Dashboard de vendas, que **não depende do estoque**. A Fase 5 foi dividida: **5A** (métricas de venda e dashboards Geral/Conta) roda logo após a Fase 3, antes da Fase 4; **5B** (cobertura, ABC, Full, visitas, Ads) roda depois da Fase 4. A ordem do `docs/PROMPT_MASTER.md` §37 é preservada, porque a Fase 3 já entrega pedidos confiáveis e nenhuma métrica de estoque aparece antes da Fase 4.

**3. O domínio `catalog` cresceu (D-028).** Entram tabelas de importação, catálogo e kits importados, snapshots de estoque do ERP, aliases de loja e candidatos de vínculo.

### Pendência operacional aberta

**Modelos de exportação do pedido de compra (Excel e PDF)** serão fornecidos pelo usuário mediante solicitação. **Solicitar antes do início da Fase 4.**

---

## Pendência técnica externa

Antes de congelar o capítulo de sincronização é preciso **confirmar a documentação oficial atual do Mercado Livre**: tópicos de webhook disponíveis, mecanismo oficial de recuperação de notificação perdida, política de rate limit vigente e modelo de autorização multi-conta.

Conforme `docs/PROMPT_MASTER.md` §9, nada disso será inventado. `docs/MERCADO_LIVRE.md` contém a lista de verificação e está marcado como pendente nesses pontos.

---

## Regra de início de sessão

Antes de alterar código, ler:

1. `README.md`
2. `AGENTS.md`
3. `docs/PROMPT_MASTER.md`
4. `docs/HANDOFF.md`
5. `docs/ROADMAP.md`
6. `docs/ARCHITECTURE.md`
7. `docs/PRODUCT_REQUIREMENTS.md`
8. `docs/AGENT_ROLES.md`
9. `docs/DECISIONS.md`
10. a documentação especializada do assunto da tarefa (`DATABASE`, `API`, `METRICS`, `MERCADO_LIVRE`, `NOTIFICATIONS`, `COPILOT`, `DEPLOYMENT`, `TESTING`)

Depois verificar branch, `git status` e commits recentes.

---

## Próximo passo

**Fase 1 — fundação técnica.** Monorepo pnpm e Turborepo, TypeScript estrito, lint, Vitest, CI, Supabase local, `apps/api` e `apps/worker` publicados no Cloud Run, projeto Vercel conectado à `v3`.

A Fase 1 **não cria nenhuma tabela de domínio**. O objetivo é um pipeline verde ponta a ponta: um job atravessa `api -> Cloud Tasks -> worker -> Postgres` e o `web` mostra o resultado, sem nenhuma regra de negócio envolvida.

Frente paralela, independente da Fase 1: confirmar a documentação oficial do Mercado Livre e preencher `docs/MERCADO_LIVRE.md`. Ela bloqueia a Fase 3, então quanto antes melhor.

## Bloqueios atuais

- **Nenhum bloqueio para a Fase 1.**
- Confirmação da documentação oficial do Mercado Livre bloqueia a Fase 3.
- Modelos de exportação do pedido de compra (Excel e PDF) precisam ser solicitados ao usuário antes da Fase 4.
