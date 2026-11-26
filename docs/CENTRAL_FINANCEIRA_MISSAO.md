# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (worktree `.worktrees/central-inteligencia-financeira`, rebased sobre `origin/main` `3fda54d0`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas entregues e auditadas:**
- `/central` — Cockpit executivo financeiro + Alertas de Custos (atraso/estouro) na Central de Atenção + Evolução Diária Faturamento × Margem + **DRE Gerencial Comparativa (Atual × Anterior em R\$ e p.p.)** conectada a despesas reais + Ponto de Equilíbrio + Simulador What-If (protegido contra custo zero fictício) + Exportação CSV comparativa + Glossário Financeiro
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis (CRUD + **quitação/cancelamento com trilha de auditoria real em `operational_expense_history`** + anti-duplicidade + CSV), Visão Regime de Caixa × Competência (Pago / A vencer / Em atraso), Geração idempotente de despesas recorrentes do próximo mês, Prévia de Rateio de custos compartilhados, Orçamento × Realizado, Entidades Fiscais (CNPJs/Regimes/Vigências), Vínculo exclusivo Conta → CNPJ e Fechamento Financeiro Mensal auditável
- `/central/metas` — Metas de faturamento (geral e por marketplace), Metas Financeiras Expandidas com acompanhamento Realizado × Meta e `StatePill` sensível à polaridade (lucro, margens, Ads, despesas, logística, ticket médio, volume) e Alíquotas
- `/central/limites` — Limites de controle, explicação `p.p.` × `%`, hierarquia de prioridade, prevenção de duplicidade e alerta de venda abaixo da margem
- `/central/frete` — Inteligência logística, custo médio por envio por modalidade, detector de frete anômalo, **Exportação CSV de alertas**, **Simulador de impacto do frete na margem oficial** e proteção contra dupla contagem
- `/central/ads` — Inteligência financeira de publicidade (orçamento ativo, projeção mensal, ROAS/ACOS de equilíbrio, risco de prejuízo e margem após Ads), **Simulador de ROAS e ACOS de equilíbrio** e **Exportação CSV de campanhas**
- `/central/produtos` — Rentabilidade por produto, **Matriz de Quadrantes de Rentabilidade** (Estrelas · Alto faturamento/baixa margem · Joias ocultas · Prejuízo), simulador de preço/margem pela fórmula oficial e exportação CSV

---

## 2. Regras financeiras obrigatórias (100% preservadas e testadas)

1. **Fórmula oficial da Margem do Produto (%):**
   $$\text{Margem do Produto (\%)} = \frac{\text{Valor Líquido Recebido} - \text{Custo do Produto}}{\text{Valor de Venda}} \times 100$$
   - Validada com o caso canônico: Venda R\$ 100,00 · Recebido R\$ 80,00 · Custo R\$ 50,00 → Resultado R\$ 30,00 · Margem 30%.
   - Consolidação **sempre ponderada** pela soma monetária (`Σ recebido − Σ custo ÷ Σ venda`), jamais média simples.
   - Custo desconhecido ou zero **nunca** é tratado como zero silenciosamente (inclusive bloqueado no Simulador What-If quando não há pedidos cobertos, evitando margem fictícia de 100%, e separado explicitamente em `semCobertura` na Matriz de Produtos).
   - Sem dupla contagem de descontos (D-356) nem de frete já descontado no repasse.
2. **DRE Gerencial Comparativa e Ponto de Equilíbrio:**
   - Separação clara entre Faturamento Bruto, Receita Líquida, Lucro Bruto, Margem de Contribuição, Resultado Operacional e Resultado Líquido Gerencial, com coluna **vs. Anterior** (em R\$ e `p.p.`).
   - Toda linha declara sua origem (`real` | `estimado` | `manual` | `calculado` | `ausente`).
   - Despesas operacionais cadastradas em `/central/custos` alimentam automaticamente a DRE (atual e anterior em 1 única consulta), o Ponto de Equilíbrio e a Central de Atenção na `/central`.
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando explicitamente margem nula ou negativa como inalcançável.
3. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo (documentado em `/central`, `/central/limites`, `/central/frete` e Glossário).

---

## 3. Histórico de rodadas e commits

- **Rodada 1 (`269d2f66`):** Auditoria completa, criação do worktree isolado, motor financeiro canônico em `packages/domain/src/financial/` (16 testes), migration versionada, DRE Gerencial + Ponto de Equilíbrio + Simulador What-If + Glossário na `/central`, página `/central/custos` na navegação, refinamento de `p.p.` vs. `%` em `/central/limites`.
- **Rodada 2 (`4b9b2874` + `52d464d3`):**
  - Atualização segura do **Next.js `16.4.1 → 16.4.6`** (patch de segurança validado sem regressões).
  - CRUD completo e auditável em `/central/custos`, conexão real de `operational_expenses` na DRE da `/central` + exportação CSV da DRE.
  - Expansão de `/central/metas`, `/central/ads`, `/central/frete`, `/central/produtos` e `/central/limites`.
- **Rodada 3 (`e7ab2c5a`):**
  - Vínculo exclusivo Conta → CNPJ (`fiscal_entity_accounts`) e Fechamento Financeiro Mensal Auditável (`monthly_financial_closings`) em `/central/custos`.
  - Gráfico de Evolução Diária (Faturamento × Margem) na `/central` reutilizando `<BarrasDiarias>` com zero queries extras.
  - Exportações CSV UTF-8 BOM em `/central/custos` e `/central/produtos`.
  - Migration reordenada para `20261126180000_central_inteligencia_financeira_fundacao.sql`, validação real em Postgres 17 + `check:embeds` + 13 testes E2E Playwright + atualização de `docs/METRICS.md` (5Z) e `docs/DATABASE.md`.
- **Rodada 4 (`2c637787`):**
  - Rebase limpo sobre `origin/main` `3fda54d0`, Visão Regime de Caixa × Competência, Geração idempotente de despesas recorrentes, Prévia de Rateio, Realizado × Meta em `/central/metas`, Alertas de Custos na `/central`, inspeção visual real por screenshots (desktop `1440×900` e mobile `390×844` nas 7 rotas, 0px overflow) e correção anti-zero-silencioso no Simulador What-If.
- **Rodada 5 (fechamento completo de ferramentas decisórias e auditoria):**
  - **DRE Comparativa (`vs. Anterior` em R\$ e `p.p.`) + CSV comparativo** em `/central` com `carregarDespesasComparadas` (uma única consulta cobrindo período atual + anterior).
  - **Trilha de auditoria real (`operational_expense_history`) + Cancelamento auditável** em `/central/custos` (`marcarDespesaPaga` e `cancelarDespesa` gravam eventos `status_changed` e exibem histórico recente recolhível).
  - **Inteligência de Frete (`/central/frete`):** **Simulador de impacto do frete na margem oficial** (calcula corrosão em R\$, `p.p.`, impacto mensal e preço para preservar margem) + **Exportação CSV de alertas**.
  - **Inteligência de Ads (`/central/ads`):** **Simulador de ROAS e ACOS de equilíbrio** (disponível inclusive antes da 1ª semana consolidada e pré-preenchido com margem real quando disponível) + **Exportação CSV de campanhas**.
  - **Rentabilidade de Produtos (`/central/produtos`):** **Matriz de Quadrantes de Rentabilidade** mutuamente exclusivos (`classificarMatrizRentabilidade`: Estrelas · Alto faturamento/baixa margem · Joias ocultas · Prejuízo · Sem cobertura).
  - Validação end-to-end completa: `755` `@sb/domain` + `1.565` `@sb/web` + `11` integração SQL Postgres 17 + `13` Playwright E2E Chromium + 6 guardas web + `check:embeds` + `docs:check` + `next build`.

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%)
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%)
- [x] **Fase 3 — Fundação financeira e backend** (99%):
  - [x] Motor puro em `packages/domain/src/financial/` + 16 testes unitários.
  - [x] Migration `20261126180000_central_inteligencia_financeira_fundacao.sql` validada do zero em Postgres 17 real com `supabase db reset` e `check:embeds` (40 projeções OK).
  - [x] Server Actions CRUD sob RLS com trilha de auditoria real (`operational_expense_history`), geração recorrente idempotente, entidades fiscais, vigências tributárias, vínculo conta→CNPJ, fechamento mensal e metas financeiras.
  - [ ] Aplicação em Dev/Produção via PR + workflow `migrations-producao.yml` (governança humana).
- [x] **Fase 4 — Central principal e DRE gerencial** (100%)
- [x] **Fase 5 — Evolução das páginas especializadas** (99%)
- [x] **Fase 6 — Funcionalidades complementares** (100%)
- [x] **Fase 7 — Refinamento visual** (98%)
- [x] **Fase 8 — Auditoria, testes e otimização** (99%)
- [x] **Fase 9 — Documentação e entrega** (98% — pendente apenas abertura de PR/merge/deploy humano)

---

## 5. Progresso consolidado (Rodada 5 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| **Progresso geral da missão** | **99%** |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 99% |
| Regras e cálculos financeiros | 100% |
| Central principal | 100% |
| Gestão de metas | 98% |
| Gestão de limites | 96% |
| Inteligência de frete | 98% |
| Inteligência de ADS | 98% |
| Rentabilidade de produtos | 99% |
| UX/UI | 98% |
| Performance | 98% |
| Segurança e testes | 99% |
| Documentação | 99% |
