# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (worktree `.worktrees/central-inteligencia-financeira`, rebased sobre `origin/main` `3fda54d0`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas entregues e auditadas:**
- `/central` — Cockpit executivo financeiro + Alertas de Custos (atraso/estouro) na Central de Atenção + Evolução Diária Faturamento × Margem + DRE Gerencial conectada a despesas reais + Ponto de Equilíbrio + Simulador What-If (protegido contra custo zero fictício) + Exportação CSV + Glossário Financeiro
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis (CRUD + auditoria + anti-duplicidade + CSV), **Visão Regime de Caixa × Competência** (Pago / A vencer / Em atraso), **Geração idempotente de despesas recorrentes do próximo mês**, **Prévia de Rateio de custos compartilhados**, Orçamento × Realizado, Entidades Fiscais (CNPJs/Regimes/Vigências), Vínculo exclusivo Conta → CNPJ e Fechamento Financeiro Mensal auditável
- `/central/metas` — Metas de faturamento (geral e por marketplace), **Metas Financeiras Expandidas com acompanhamento Realizado × Meta e `StatePill` sensível à polaridade** (lucro, margens, Ads, despesas, logística, ticket médio, volume) e Alíquotas
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
   - Custo desconhecido ou zero **nunca** é tratado como zero silenciosamente (inclusive bloqueado no Simulador What-If quando não há pedidos cobertos, evitando margem fictícia de 100%).
   - Sem dupla contagem de descontos (D-356) nem de frete já descontado no repasse.
2. **DRE Gerencial e Ponto de Equilíbrio:**
   - Separação clara entre Faturamento Bruto, Receita Líquida, Lucro Bruto, Margem de Contribuição, Resultado Operacional e Resultado Líquido Gerencial.
   - Toda linha declara sua origem (`real` | `estimado` | `manual` | `calculado` | `ausente`).
   - Despesas operacionais cadastradas em `/central/custos` alimentam automaticamente a DRE, o Ponto de Equilíbrio e a Central de Atenção na `/central` (provado em E2E real).
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando explicitamente margem nula ou negativa como inalcançável.
3. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo (documentado em `/central`, `/central/limites` e Glossário).

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
- **Rodada 4 (consolidada sobre `origin/main` `3fda54d0`):**
  - **Rebase limpo** sobre `origin/main` `3fda54d0` (incluindo `20261126170000_sugestao_de_compra_por_sku.sql`), mantendo `20261126180000` estritamente posterior sem conflitos.
  - **Visão Regime de Caixa × Competência** em `/central/custos` (`resumirRegimeCaixa`: Pago no caixa / A vencer / Vencidas em atraso), **Geração idempotente de despesas recorrentes do próximo mês** (`gerarRecorrentesProximoMes` com `idempotency_key` determinístico) e **Prévia de Rateio de custos compartilhados** (`ratearDespesa`).
  - **Acompanhamento Realizado × Meta** nas Metas Financeiras Expandidas de `/central/metas` (`avaliarMetaFinanceira` com polaridade correta — menor-é-melhor para teto de Ads, redução de despesas e eficiência logística; maior-é-melhor para lucro, margens, faturamento, volume e ticket).
  - **Alertas de Custos na Central de Atenção (`/central`)** reutilizando a leitura paralela já existente (zero queries extras) para despesas atrasadas e estouro de orçamento acima de 10%.
  - **Auditoria visual real por screenshots** em Chromium (desktop `1440×900` e mobile `390×844` nas 7 telas da Central — 0px de overflow horizontal e zero erros de página), que detectou e permitiu corrigir falha de integridade financeira no **Simulador What-If** (bloqueado quando CMV/comissão/frete não estão observados no período para nunca exibir margem fictícia de 100%, com aviso explícito quando há base parcial).

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%)
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%)
- [x] **Fase 3 — Fundação financeira e backend** (99%):
  - [x] Motor puro em `packages/domain/src/financial/` + 16 testes unitários.
  - [x] Migration `20261126180000_central_inteligencia_financeira_fundacao.sql` validada do zero em Postgres 17 real com `supabase db reset` e `check:embeds` (40 projeções OK).
  - [x] Server Actions CRUD sob RLS para despesas, geração recorrente idempotente, entidades fiscais, vigências tributárias, vínculo conta→CNPJ, fechamento mensal e metas financeiras + leitura paralela de despesas reais alimentando DRE e alertas da `/central`.
  - [x] Testes de integração SQL reais provando RLS, isolamento multi-tenant, idempotência e CHECKs (11/11).
  - [ ] Aplicação em Dev/Produção via PR + workflow `migrations-producao.yml` (governança humana).
- [x] **Fase 4 — Central principal e DRE gerencial** (98%):
  - [x] DRE Gerencial interativa alimentada por despesas reais, com badges de origem e exportação CSV.
  - [x] Evolução diária Faturamento × Margem, Ponto de Equilíbrio, Simulador What-If (com guarda anti-zero-silencioso), Alertas de Custos na Central de Atenção e Glossário Financeiro.
- [x] **Fase 5 — Evolução das páginas especializadas** (98%):
  - [x] `/central/custos`, `/central/metas`, `/central/limites`, `/central/frete`, `/central/ads` e `/central/produtos` todas evoluídas, integradas, validadas em E2E e inspecionadas visualmente em Chromium.
- [x] **Fase 6 — Funcionalidades complementares** (98%):
  - [x] Ponto de Equilíbrio, Simulador Financeiro, Simulador de Preço/Margem, Orçamento × Realizado, Visão Caixa × Competência, Geração Recorrente Idempotente, Prévia de Rateio, Fechamento Mensal Auditável e Exportações CSV (DRE, despesas, produtos).
- [x] **Fase 7 — Refinamento visual** (98%):
  - [x] Design Contract `--sb-*`, guardas estáticas de tabelas/controles/loading/navegação 100% verdes, inspeção real de screenshots desktop (`1440×900`) e mobile (`390×844`) em todas as 7 telas com **0px de overflow horizontal** e zero erros de página.
- [x] **Fase 8 — Auditoria, testes e otimização** (98%):
  - [x] 755 testes `@sb/domain` + 1.564 testes `@sb/web` + 11 testes integração SQL Postgres 17 + 13 testes E2E Playwright + 6 guardas web + `check:embeds` + `docs:check` + `next build` (Next.js 16.4.6).
- [x] **Fase 9 — Documentação e entrega** (98%):
  - [x] `docs/METRICS.md` (5Z), `docs/DATABASE.md` e `docs/CENTRAL_FINANCEIRA_MISSAO.md` atualizados.
  - [ ] Abertura de PR e aprovação humana para merge na `main` e execução de `migrations-producao.yml`.

---

## 5. Progresso consolidado (Rodada 4 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| **Progresso geral da missão** | **98%** |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 99% |
| Regras e cálculos financeiros | 100% |
| Central principal | 98% |
| Gestão de metas | 98% |
| Gestão de limites | 95% |
| Inteligência de frete | 92% |
| Inteligência de ADS | 95% |
| Rentabilidade de produtos | 96% |
| UX/UI | 98% |
| Performance | 96% |
| Segurança e testes | 99% |
| Documentação | 98% |
