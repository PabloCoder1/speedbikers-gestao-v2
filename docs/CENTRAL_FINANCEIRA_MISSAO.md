# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (worktree `.worktrees/central-inteligencia-financeira`, baseada em `origin/main` `f0c35bab`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas entregues e auditadas:**
- `/central` — Cockpit executivo financeiro + Evolução Diária Faturamento × Margem + DRE Gerencial conectada a despesas reais + Ponto de Equilíbrio + Simulador What-If + Exportação CSV + Glossário Financeiro
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis (CRUD + auditoria + anti-duplicidade + CSV), Rateios, Orçamento × Realizado, Entidades Fiscais (CNPJs/Regimes/Vigências), Vínculo exclusivo Conta → CNPJ e Fechamento Financeiro Mensal auditável
- `/central/metas` — Metas de faturamento (geral e por marketplace), Metas Financeiras Expandidas (lucro, margens, Ads, despesas, logística, ticket médio) e Alíquotas
- `/central/limites` — Limites de controle, explicação `p.p.` × `%`, hierarquia de prioridade, prevenção de duplicidade e alerta de venda abaixo da margem
- `/central/frete` — Inteligência logística, custo médio por envio por modalidade, detector de frete anômalo e proteção contra dupla contagem
- `/central/ads` — Inteligência financeira de publicidade (orçamento ativo, projeção mensal, ROAS/ACOS de equilíbrio, risco de prejuízo e margem após Ads)
- `/central/produtos` — Rentabilidade por produto, diagnóstico estratégico automático, simulador de preço/margem pela fórmula oficial e exportação CSV

---

## 2. Regras financeiras obrigatórias (100% preservadas e testadas)

1. **Fórmula oficial da Margem do Produto (%):**
   $$\text{Margem do Produto (\%)} = \frac{\text{Valor Líquido Recebido} - \text{Custo do Produto}}{\text{Valor de Venda}} \times 100$$
   - Validada com o caso canônico: Venda R\$ 100,00 · Recebido R\$ 80,00 · Custo R\$ 50,00 → Resultado R\$ 30,00 · Margem 30%.
   - Consolidação **sempre ponderada** pela soma monetária (`Σ recebido − Σ custo ÷ Σ venda`), jamais média simples.
   - Custo desconhecido ou zero **nunca** é tratado como zero silenciosamente.
   - Sem dupla contagem de descontos (D-356) nem de frete já descontado no repasse.
2. **DRE Gerencial e Ponto de Equilíbrio:**
   - Separação clara entre Faturamento Bruto, Receita Líquida, Lucro Bruto, Margem de Contribuição, Resultado Operacional e Resultado Líquido Gerencial.
   - Toda linha declara sua origem (`real` | `estimado` | `manual` | `calculado` | `ausente`).
   - Despesas operacionais cadastradas em `/central/custos` alimentam automaticamente a DRE e o Ponto de Equilíbrio na `/central` (provado em E2E real!).
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando explicitamente margem nula ou negativa como inalcançável.
3. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo (documentado em `/central`, `/central/limites` e Glossário).

---

## 3. Histórico de rodadas e commits

- **Rodada 1 (`55c67dca`):** Auditoria completa, criação do worktree isolado, motor financeiro canônico em `packages/domain/src/financial/` (16 testes), migration versionada, DRE Gerencial + Ponto de Equilíbrio + Simulador What-If + Glossário na `/central`, página `/central/custos` na navegação, refinamento de `p.p.` vs. `%` em `/central/limites`.
- **Rodada 2 (`66653a30` + `9189694e`):**
  - Atualização segura do **Next.js `16.4.1 → 16.4.6`** (patch de segurança validado sem regressões).
  - CRUD completo e auditável em `/central/custos`, conexão real de `operational_expenses` na DRE da `/central` + exportação CSV da DRE.
  - Expansão de `/central/metas` (metas financeiras expandidas), `/central/ads` (ACOS de equilíbrio, orçamento/projeção, risco de prejuízo e margem após Ads), `/central/frete` (custo médio/envio por modalidade e aviso de não dupla contagem), `/central/produtos` (diagnóstico estratégico + simulador de preço/margem) e `/central/limites` (hierarquia de prioridade e glossário `p.p.` × `%`).
- **Rodada 3 (em consolidação):**
  - Vínculo exclusivo Conta → CNPJ (`fiscal_entity_accounts`) e **Fechamento Financeiro Mensal Auditável** (`monthly_financial_closings`) com formulários, ações RLS e tabelas em `/central/custos`.
  - **Gráfico de Evolução Diária (Faturamento × Margem)** na `/central` reutilizando `<BarrasDiarias>` com zero queries extras.
  - Exportações CSV (UTF-8 BOM compatível com Excel pt-BR) adicionadas em `/central/custos` (despesas) e `/central/produtos` (rentabilidade por produto).
  - Ajuste de timestamp da migration para **`20261126180000_central_inteligencia_financeira_fundacao.sql`** (garantindo ordem estrita após `20261126150000` da `main`).
  - Validação real em **Postgres 17 (Supabase local isolado no Docker)**: `supabase db reset` do zero, `check:embeds` (40 projeções OK), **11/11 testes de integração SQL** (`central-financeira.integration.test.ts` + `alerta-margem.integration.test.ts`), e **13/13 testes E2E Playwright** no Chromium real (incluindo CRUD de custos → DRE conectada, simuladores e verificação de responsividade desktop 1440px / mobile 390px sem overflow).
  - Documentação normativa atualizada em `docs/METRICS.md` (Seção 5Z) e `docs/DATABASE.md`.

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%)
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%)
- [x] **Fase 3 — Fundação financeira e backend** (98%):
  - [x] Motor puro em `packages/domain/src/financial/` + 16 testes unitários.
  - [x] Migration `20261126180000_central_inteligencia_financeira_fundacao.sql` validada do zero em Postgres 17 real com `supabase db reset` e `check:embeds`.
  - [x] Server Actions CRUD sob RLS para despesas, entidades fiscais, vigências tributárias, vínculo conta→CNPJ, fechamento mensal e metas financeiras + leitura paralela de despesas reais alimentando a DRE da `/central`.
  - [x] Testes de integração SQL reais provando RLS, isolamento multi-tenant, idempotência e CHECKs.
  - [ ] Aplicação em Dev/Produção via PR + workflow `migrations-producao.yml` (governança humana).
- [x] **Fase 4 — Central principal e DRE gerencial** (95%):
  - [x] DRE Gerencial interativa alimentada por despesas reais, com badges de origem e exportação CSV.
  - [x] Evolução diária Faturamento × Margem, Ponto de Equilíbrio, Simulador What-If e Glossário Financeiro.
  - [ ] Visão de Fluxo de Caixa (regime de caixa) completa — depende de integração futura de contas a pagar/receber bancárias.
- [x] **Fase 5 — Evolução das páginas especializadas** (90%):
  - [x] `/central/custos`, `/central/metas`, `/central/limites`, `/central/frete`, `/central/ads` e `/central/produtos` todas evoluídas, integradas e validadas em E2E.
- [x] **Fase 6 — Funcionalidades complementares** (95%):
  - [x] Ponto de Equilíbrio, Simulador Financeiro, Simulador de Preço/Margem, Orçamento × Realizado, Fechamento Mensal Auditável e Exportações CSV (DRE, despesas, produtos).
- [x] **Fase 7 — Refinamento visual** (90%):
  - [x] Design Contract `--sb-*`, guardas estáticas de tabelas/controles/loading/navegação 100% verdes, responsividade validada em Chromium desktop (`1440px`) e mobile (`390px`) com overflow `<= 2px`.
- [x] **Fase 8 — Auditoria, testes e otimização** (95%):
  - [x] 755 testes `@sb/domain` + 1.560 testes `@sb/web` + 11 testes integração SQL Postgres 17 + 13 testes E2E Playwright + 6 guardas web + `check:embeds` + `docs:check` + `next build` (Next.js 16.4.6).
- [x] **Fase 9 — Documentação e entrega** (95%):
  - [x] `docs/METRICS.md` (5Z), `docs/DATABASE.md` e `docs/CENTRAL_FINANCEIRA_MISSAO.md` atualizados.
  - [ ] Abertura de PR e aprovação humana para merge na `main` e execução de `migrations-producao.yml`.

---

## 5. Progresso consolidado (Rodada 3 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| **Progresso geral da missão** | **94%** |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 98% |
| Regras e cálculos financeiros | 98% |
| Central principal | 95% |
| Gestão de metas | 90% |
| Gestão de limites | 90% |
| Inteligência de frete | 85% |
| Inteligência de ADS | 90% |
| Rentabilidade de produtos | 90% |
| UX/UI | 90% |
| Performance | 92% |
| Segurança e testes | 96% |
| Documentação | 95% |
