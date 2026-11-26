# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (criada a partir de `origin/main` em `f0c35bab`, worktree `.worktrees/central-inteligencia-financeira`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas no escopo prioritário:**
- `/central` — Cockpit executivo financeiro + DRE Gerencial + Ponto de Equilíbrio + Simulador What-If + Exportação CSV
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis (CRUD + auditoria + anti-duplicidade), Rateios, Orçamento × Realizado e Entidades Fiscais (CNPJs/Regimes/Vigências)
- `/central/metas` — Gestão de metas de faturamento (geral e por marketplace), metas financeiras expandidas (lucro, margens, Ads, despesas, logística) e alíquotas
- `/central/limites` — Limites de controle, prevenção de riscos, hierarquia de prioridade e alerta de venda abaixo da margem
- `/central/frete` — Inteligência logística, custo médio por modalidade, detector de frete anômalo e prevenção de dupla contagem
- `/central/ads` — Inteligência financeira de publicidade (orçamento ativo, projeção mensal, ROAS/ACOS de equilíbrio, risco de prejuízo e margem após Ads)
- `/central/produtos` — Rentabilidade por produto, diagnóstico estratégico automático e simulador de preço/margem pela fórmula oficial

---

## 2. Regras financeiras obrigatórias

1. **Fórmula oficial da Margem do Produto (%):**
   $$\text{Margem do Produto (\%)} = \frac{\text{Valor Líquido Recebido} - \text{Custo do Produto}}{\text{Valor de Venda}} \times 100$$
   - Validada com o caso canônico: Venda R\$ 100,00 · Recebido R\$ 80,00 · Custo R\$ 50,00 → Resultado R\$ 30,00 · Margem 30%.
   - Consolidação **sempre ponderada** pela soma monetária (`Σ recebido − Σ custo ÷ Σ venda`), jamais média simples.
   - Custo desconhecido ou zero **nunca** é tratado como zero silenciosamente.
   - Sem dupla contagem de descontos (D-356) nem de frete já descontado no repasse.
2. **DRE Gerencial e Ponto de Equilíbrio:**
   - Separação clara entre Faturamento Bruto, Receita Líquida, Lucro Bruto, Margem de Contribuição, Resultado Operacional e Resultado Líquido Gerencial.
   - Toda linha declara sua origem (`real` | `estimado` | `manual` | `calculado` | `ausente`).
   - Despesas operacionais cadastradas em `/central/custos` alimentam automaticamente a DRE e o Ponto de Equilíbrio da `/central` (em paralelo, zero waterfall).
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando explicitamente margem nula ou negativa como inalcançável.
3. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo (documentado em `/central`, `/central/limites` e Glossário).

---

## 3. Histórico de rodadas e commits

- **Rodada 1 (`55c67dca`):** Auditoria completa, criação do worktree isolado, motor financeiro canônico em `packages/domain/src/financial/` (16 testes), migration versionada `20261126100000_central_inteligencia_financeira_fundacao.sql`, DRE Gerencial + Ponto de Equilíbrio + Simulador What-If + Glossário na `/central`, página `/central/custos` na navegação, refinamento de `p.p.` vs. `%` em `/central/limites`.
- **Rodada 2 (em consolidação):**
  - Atualização segura do **Next.js `16.4.1 → 16.4.6`** (patch de segurança validado sem regressões).
  - CRUD completo e auditável em `/central/custos` (`actions.ts`, `formularios.tsx`, `custos-fiscal.ts` + testes): despesas fixas/variáveis com prevenção de duplicidade mensal, marcar como paga, remoção com confirmação, histórico em `operational_expense_history`, cadastro de CNPJs (validação matemática de DV) e vigências tributárias multi-regime.
  - Integração real de `operational_expenses` na DRE e Ponto de Equilíbrio da `/central` (leitura paralela sem waterfall, degradação graciosa se tabela ausente) + botão **Exportar DRE (CSV)** em UTF-8 BOM.
  - Expansão de `/central/metas` com **Metas Financeiras Expandidas** (`financial_goals`: lucro líquido, margens, ticket médio, teto de Ads, despesas e logística por escopo global/marketplace/conta/marca).
  - Evolução de `/central/ads`: **ACOS de equilíbrio** ao lado do ROAS de equilíbrio, painel de orçamento diário ativo / projeção mensal (30d) / campanhas em risco de prejuízo após Ads e coluna **Margem após Ads** com `StatePill`.
  - Evolução de `/central/frete`: coluna **Custo médio por envio (vendedor)** comparando modalidades logísticas e aviso explícito de prevenção de dupla contagem + link para custos logísticos complementares.
  - Evolução de `/central/produtos`: **Diagnóstico estratégico automático** (alto faturamento/baixa margem, frete > 15%, custo atual sem histórico) e **Simulador de Preço e Margem Desejada** usando a fórmula oficial.
  - Evolução de `/central/limites`: **Hierarquia de prioridade** (específico > empresa > padrão), garantia de zero duplicidade de alertas e glossário `p.p.` × `%`.

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%)
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%)
- [~] **Fase 3 — Fundação financeira e backend** (85%):
  - [x] Motor puro em `packages/domain/src/financial/` + 16 testes unitários.
  - [x] Migration versionada `20261126100000_central_inteligencia_financeira_fundacao.sql` com RLS completa.
  - [x] Server Actions CRUD sob RLS para despesas, entidades fiscais, vigências tributárias e metas financeiras + leitura paralela de despesas reais alimentando a DRE da `/central`.
  - [ ] Vínculo UI conta→CNPJ (`fiscal_entity_accounts`), fluxo UI de fechamento mensal (`monthly_financial_closings`) e aplicação/teste SQL da migration em Supabase local/Docker.
- [~] **Fase 4 — Central principal e DRE gerencial** (85%):
  - [x] DRE Gerencial interativa alimentada por despesas reais (quando cadastradas), com badges de origem e exportação CSV.
  - [x] Ponto de Equilíbrio, Simulador Financeiro (What-If) e Glossário Financeiro completo.
  - [ ] Gráfico visual de evolução histórica faturamento × rentabilidade + visão competência vs. caixa quando dados de repasse/pagamento estiverem povoados.
- [~] **Fase 5 — Evolução das páginas especializadas** (75%):
  - [x] `/central/custos`: CRUD de despesas, previsto × realizado, CNPJs e vigências tributárias.
  - [x] `/central/metas`: metas financeiras expandidas além do faturamento.
  - [x] `/central/limites`: explicação `p.p.` × `%`, hierarquia de prioridade e prevenção de duplicidade.
  - [x] `/central/frete`: custo médio por envio por modalidade logística e proteção contra dupla contagem.
  - [x] `/central/ads`: ACOS de equilíbrio, orçamento ativo, projeção mensal, risco de prejuízo e margem após Ads.
  - [x] `/central/produtos`: diagnóstico estratégico automático e simulador de preço/margem desejada.
  - [ ] Filtros avançados adicionais (ex.: filtro de marca/categoria na `/central/produtos` via RPC, orçamento manual vs. automático em `/central/ads`, edição inline de despesas existentes e alocação detalhada em `/central/custos`).
- [~] **Fase 6 — Funcionalidades complementares** (75%):
  - [x] Ponto de Equilíbrio, Simulador Financeiro, Orçamento × Realizado e Exportação CSV da DRE.
  - [ ] UI completa de Fechamento Mensal Auditável + exportação CSV/XLSX de despesas e rentabilidade de produtos.
- [~] **Fase 7 — Refinamento visual** (65%):
  - [x] Design Contract `--sb-*`, tabelas responsivas, formulários padronizados e todas as guardas visuais verdes.
  - [ ] Validação visual no navegador (desktop/tablet/mobile) com evidências de tela.
- [~] **Fase 8 — Auditoria, testes e otimização** (65%):
  - [x] Testes unitários (`@sb/domain` + `@sb/web`), `typecheck`, `lint`, todas as 6 guardas estáticas, `docs:check` e `build` em Next.js 16.4.6.
  - [ ] Subir Supabase local no Docker para testar a migration `20261126100000` em Postgres real (RLS, constraints, triggers) e executar E2E Playwright.
- [~] **Fase 9 — Documentação e entrega** (70%):
  - [x] `docs/CENTRAL_FINANCEIRA_MISSAO.md` mantido atualizado a cada rodada.
  - [ ] Atualizar `docs/METRICS.md`, `docs/DATABASE.md` e `docs/HANDOFF.md` na rodada de fechamento.

---

## 5. Progresso consolidado (Rodada 2 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| Progresso geral da missão | 74% |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 85% |
| Regras e cálculos financeiros | 95% |
| Central principal | 85% |
| Gestão de metas | 75% |
| Gestão de limites | 75% |
| Inteligência de frete | 65% |
| Inteligência de ADS | 75% |
| Rentabilidade de produtos | 70% |
| UX/UI | 65% |
| Performance | 75% |
| Segurança e testes | 70% |
| Documentação | 70% |
