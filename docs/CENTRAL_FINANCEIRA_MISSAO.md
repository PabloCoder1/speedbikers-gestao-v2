# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (worktree `.worktrees/central-inteligencia-financeira`, rebased sobre `origin/main` `16f6ca60`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas entregues e auditadas:**
- `/central` — Cockpit executivo financeiro + Alertas de Custos (atraso/estouro) na Central de Atenção + Evolução Diária Faturamento × Margem + **DRE Gerencial Comparativa (Atual × Anterior em R\$ e p.p.) alimentada por agregação 100% em SQL (`get_resumo_despesas`)** + **Contexto Fiscal Multi-CNPJ integrado (Simples / Presumido / Lucro Real com créditos)** + Ponto de Equilíbrio + Simulador What-If (protegido contra custo zero fictício) + Exportação CSV comparativa + Glossário Financeiro
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis (CRUD + quitação pt-BR/cancelamento com **trilha de auditoria à prova de forjamento gravada por trigger no Postgres** + anti-duplicidade + CSV), Visão Regime de Caixa × Competência (Pago / A vencer / Em atraso), Geração idempotente de despesas recorrentes do próximo mês, **Prévia de Rateio ponderada pelo faturamento real de 30d agregado em SQL (`get_faturamento_por_conta`)**, Orçamento × Realizado, Entidades Fiscais (CNPJs/Regimes/Vigências), Vínculo exclusivo Conta → CNPJ e Fechamento Financeiro Mensal auditável
- `/central/metas` — Metas de faturamento (geral e por marketplace), Metas Financeiras Expandidas com acompanhamento Realizado × Meta e `StatePill` sensível à polaridade (lucro, margens, Ads, despesas, logística, ticket médio, volume) e Alíquotas
- `/central/limites` — Limites de controle, explicação `p.p.` × `%`, hierarquia de prioridade, prevenção de duplicidade e alerta de venda abaixo da margem
- `/central/frete` — Inteligência logística, custo médio por envio por modalidade, detector de frete anômalo, Exportação CSV de alertas, Simulador de impacto do frete na margem oficial e proteção contra dupla contagem
- `/central/ads` — Inteligência financeira de publicidade (orçamento ativo, projeção mensal, ROAS/ACOS de equilíbrio, risco de prejuízo e margem após Ads), Simulador de ROAS e ACOS de equilíbrio e Exportação CSV de campanhas
- `/central/produtos` — Rentabilidade por produto, Matriz de Quadrantes de Rentabilidade (Estrelas · Alto faturamento/baixa margem · Joias ocultas · Prejuízo · Sem cobertura), simulador de preço/margem pela fórmula oficial e exportação CSV

---

## 2. Regras financeiras obrigatórias (100% preservadas e testadas)

1. **Fórmula oficial da Margem do Produto (%):**
   $$\text{Margem do Produto (\%)} = \frac{\text{Valor Líquido Recebido} - \text{Custo do Produto}}{\text{Valor de Venda}} \times 100$$
   - Validada com o caso canônico: Venda R\$ 100,00 · Recebido R\$ 80,00 · Custo R\$ 50,00 → Resultado R\$ 30,00 · Margem 30%.
   - Consolidação **sempre ponderada** pela soma monetária (`Σ recebido − Σ custo ÷ Σ venda`), jamais média simples.
   - Custo desconhecido ou zero **nunca** é tratado como zero silenciosamente (inclusive bloqueado no Simulador What-If quando não há pedidos cobertos, evitando margem fictícia de 100%, e separado explicitamente em `semCobertura` na Matriz de Produtos).
   - Sem dupla contagem de descontos (D-356) nem de frete já descontado no repasse.
2. **Agregação 100% em SQL e Auditoria à Prova de Fraude:**
   - Resumo de despesas operacionais (atual + anterior) agregado diretamente no Postgres via `public.get_resumo_despesas` (zero risco de truncamento em 1.000 linhas; nulos preservados).
   - Faturamento por conta para rateio agregado em SQL via `public.get_faturamento_por_conta` (`SECURITY INVOKER`, respeitando RLS por conta).
   - Trilha `operational_expense_history` gravada exclusivamente pelo trigger `operational_expenses_audit` (`SECURITY DEFINER`, `search_path = ''`), com `INSERT` direto revogado de `authenticated`.
3. **DRE Gerencial Comparativa, Multi-CNPJ e Ponto de Equilíbrio:**
   - Separação clara entre Faturamento Bruto, Receita Líquida, Lucro Bruto, Margem de Contribuição, Resultado Operacional e Resultado Líquido Gerencial, com coluna **vs. Anterior** (R\$ e `p.p.`).
   - Contexto fiscal da conta filtrada aplica e sinaliza regime multi-CNPJ (Simples Nacional, Lucro Presumido e Lucro Real com abatimento de créditos sobre CMV), diferenciando explicitamente `"validado pela contabilidade"` vs. `"estimativa gerencial"`.
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando margem nula ou negativa como inalcançável.
4. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo (documentado em `/central`, `/central/limites`, `/central/frete` e Glossário).

---

## 3. Histórico de rodadas e commits

- **Rodada 1 (`59e32e7f`):** Auditoria completa, worktree isolado, motor financeiro canônico em `packages/domain/src/financial/` (16 testes), migration fundação, DRE Gerencial + Ponto de Equilíbrio + Simulador What-If + Glossário na `/central`, `/central/custos`, refinamento de `p.p.` vs. `%` em `/central/limites`.
- **Rodada 2 (`0216d113` + `bca7a4ff`):** Atualização segura Next.js `16.4.1 → 16.4.6`, CRUD completo em `/central/custos`, conexão real de despesas na DRE + CSV da DRE, evolução de `/central/metas`, `/central/ads`, `/central/frete`, `/central/produtos` e `/central/limites`.
- **Rodada 3 (`82cb0c2a`):** Vínculo exclusivo Conta → CNPJ, Fechamento Financeiro Mensal Auditável, Evolução Diária Faturamento × Margem na `/central`, CSVs em `/central/custos` e `/central/produtos`, testes SQL em Postgres 17 + Playwright E2E + `docs/METRICS.md` (5Z) e `docs/DATABASE.md`.
- **Rodada 4 (`bf7ceb2e`):** Visão Regime de Caixa × Competência, Geração idempotente de despesas recorrentes, Prévia de Rateio, Realizado × Meta em `/central/metas`, Alertas de Custos na `/central`, inspeção visual real por screenshots (desktop `1440×900` e mobile `390×844` nas 7 rotas, 0px overflow) e correção anti-zero-silencioso no Simulador What-If.
- **Rodada 5 (`f1ee3c9c`):** DRE Comparativa (`vs. Anterior` em R\$ e `p.p.`) + CSV comparativo, cancelamento auditável de despesas, Simuladores + CSVs de Frete e Ads, Matriz de Quadrantes de Rentabilidade em `/central/produtos`.
- **Rodada 6 (fechamento SQL/Auditoria/Multi-CNPJ sobre `origin/main` `473370ad`):**
  - **Rebase limpo** sobre `origin/main` `16f6ca60` (PR #421 `20261126200000_sugestao_do_pedido_por_sku.sql`) e ordenação estrita das migrations para **`20261126233000_central_inteligencia_financeira_fundacao.sql`** e **`20261126234000_resumo_e_auditoria_de_despesas.sql`**.
  - **Agregação 100% em SQL:** `public.get_resumo_despesas` (DRE/metas/alertas sem risco de truncamento em 1.000 linhas) e `public.get_faturamento_por_conta` (rateio ponderado pelo faturamento real dos últimos 30 dias em `/central/custos`).
  - **Auditoria à prova de forjamento no banco:** trigger `operational_expenses_audit` gravando `created`/`updated`/`status_changed` em `operational_expense_history` com revogação de `INSERT` direto de `authenticated` (escrita manual removida das Server Actions).
  - **Contexto fiscal Multi-CNPJ conectado à DRE da `/central`:** exibe CNPJ/regime/validação contábil da conta filtrada, aplica `calcularTributosEntidade` (inclusive créditos no Lucro Real) quando sem alíquota global e alerta divergências > 0,2 p.p.
  - **Validação total no monorepo (11 pacotes):** `pnpm run check` (37/37 tarefas, `755` `@sb/domain` + `1.566` `@sb/web` + `1.037` `@sb/worker` + demais pacotes), 6 guardas web, `docs:check`, **14/14 testes de integração SQL em Postgres 17**, `check:embeds` (40 projeções), `supabase db reset`, `next build` (Next.js `16.4.6`) e **13/13 Playwright E2E** no Chromium real.

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%)
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%)
- [x] **Fase 3 — Fundação financeira e backend** (99% — pendente apenas aplicação das migrations via PR/workflow em Dev e Prod)
- [x] **Fase 4 — Central principal e DRE gerencial** (100%)
- [x] **Fase 5 — Evolução das páginas especializadas** (100%)
- [x] **Fase 6 — Funcionalidades complementares** (100%)
- [x] **Fase 7 — Refinamento visual** (98%)
- [x] **Fase 8 — Auditoria, testes e otimização** (100%)
- [x] **Fase 9 — Documentação e entrega** (99% — pendente apenas abertura de PR/merge/deploy humano)

---

## 5. Progresso consolidado (Rodada 6 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| **Progresso geral da missão** | **99%** |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 99% |
| Regras e cálculos financeiros | 100% |
| Central principal | 100% |
| Gestão de metas | 99% |
| Gestão de limites | 98% |
| Inteligência de frete | 99% |
| Inteligência de ADS | 99% |
| Rentabilidade de produtos | 100% |
| UX/UI | 98% |
| Performance | 99% |
| Segurança e testes | 100% |
| Documentação | 99% |
