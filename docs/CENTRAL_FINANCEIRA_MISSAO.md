# Missão — Central de Inteligência Financeira SpeedBikers

> Documento de controle contínuo da missão (Seção 23).
> Branch dedicada: `feat/central-inteligencia-financeira` (criada a partir de `origin/main` em `f0c35bab`, worktree `.worktrees/central-inteligencia-financeira`).

---

## 1. Missão original e escopo

Transformar a Central do SpeedBikers Gestão em uma **Central de Inteligência Financeira e Rentabilidade** completa, precisa, intuitiva, visualmente profissional e sustentável para uso diário em operação real multi-marketplace (Mercado Livre + Shopee) e multi-contas.

**Páginas no escopo prioritário:**
- `/central` — Cockpit executivo financeiro + DRE Gerencial + Ponto de Equilíbrio + Simulador What-If
- `/central/custos` — *(Nova)* Gestão de Custos Fixos/Variáveis, Rateios, Orçamento × Realizado e Entidades Fiscais (CNPJs/Regimes)
- `/central/metas` — Gestão de metas financeiras e alíquotas
- `/central/limites` — Limites de controle, prevenção de riscos e alerta de venda abaixo da margem
- `/central/frete` — Inteligência logística e detector de frete anômalo
- `/central/ads` — Inteligência financeira de publicidade (ROAS, ACOS, TACoS, ponto de equilíbrio)
- `/central/produtos` — Rentabilidade por produto, consolidação por SKU e simulação de margem

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
   - Ponto de Equilíbrio = `Despesas Fixas ÷ Margem de Contribuição (%)`, tratando explicitamente margem nula ou negativa como inalcançável.
3. **Diferenciação de variação (%) vs. pontos percentuais (p.p.):**
   - Margem de 20% → 25% = `+5 p.p.` e `+25%` relativo.

---

## 3. Auditoria inicial (Fase 1) — Achados e limitações

### Pontos fortes reaproveitados de `origin/main`
- Fórmula oficial de margem já consistente em `get_faturamento`, `get_ranking_produtos`, `get_sku_margins`, `calculadora-preco.ts` e `detectar_vendas_abaixo_da_margem` (D-858).
- Arquitetura de streaming sem waterfalls (`check:waterfalls`), degradação graciosa de migrations pendentes (`PGRST202`/`PGRST205`/`42P01`), e Design System `--sb-*` bem estruturado.
- Alerta de venda abaixo da margem já integrado ao sino e e-mail (D-858).

### Lacunas identificadas
1. **Ausência de despesas operacionais (fixas/variáveis)** → impedia calcular Lucro Operacional, Resultado Líquido Gerencial, Margem Líquida Final, Ponto de Equilíbrio e Orçamento × Realizado.
2. **Tributação restrita a alíquota única global** (`tax_rates`) → sem suporte a múltiplos CNPJs, vínculos conta→CNPJ, regimes tributários distintos (Simples Nacional, Lucro Presumido, Lucro Real) nem créditos tributários.
3. **DRE Gerencial e Simulador What-If ausentes na `/central`**.
4. **Glossário financeiro incompleto** na `/central` e explicação de **p.p. vs. %** sem exemplo numérico em `/central/limites`.
5. **Expansões pendentes nas páginas especializadas** (Rodadas seguintes): formulários CRUD completos em `/central/custos`, metas financeiras expandidas em `/central/metas`, limites financeiros adicionais em `/central/limites`, ACOS de equilíbrio/orçamento mensal em `/central/ads`, impacto logístico consolidado em `/central/frete`, simulador de preço por SKU e alertas de classificação em `/central/produtos`, e exportação de relatórios.

### Limitações de ambiente documentadas
- O checkout raiz local está na branch antiga `v3` com alterações pendentes de outros agentes (Configurações, SAC, Curva ABC). Para total isolamento e governança, esta missão opera em worktree dedicado `.worktrees/central-inteligencia-financeira` a partir de `origin/main` (`f0c35bab`).
- O Supabase local/Docker não foi iniciado nesta rodada; a migration `20261126100000_central_inteligencia_financeira_fundacao.sql` foi criada versionada e a UI degrada graciosamente (`<SendoAtivado>`) até sua aplicação via esteira/CI.

---

## 4. Plano de execução e checklist

- [x] **Fase 1 — Reconhecimento e auditoria** (100%): Git, branches, 6 telas da Central, RPCs, migrations, domínio e design system auditados.
- [x] **Fase 2 — Planejamento técnico e financeiro** (100%): Arquitetura financeira, modelo de dados e plano fatiado definidos.
- [~] **Fase 3 — Fundação financeira e backend** (65%):
  - [x] Motor puro em `packages/domain/src/financial/` (`margin.ts`, `dre.ts`, `expenses.ts`, `tax.ts`, `simulator.ts`) + 16 testes unitários.
  - [x] Migration versionada `20261126100000_central_inteligencia_financeira_fundacao.sql` (entidades fiscais, vigência tributária, despesas fixas/variáveis, rateio, histórico, metas financeiras, fechamento mensal, RLS completa).
  - [ ] Server Actions CRUD completas para despesas, rateios, entidades fiscais e fechamento mensal + leitura real de despesas fixas alimentando a DRE da `/central`.
- [~] **Fase 4 — Central principal e DRE gerencial** (60%):
  - [x] DRE Gerencial interativa na `/central` sem dupla contagem e com badges de origem.
  - [x] Indicadores de Ponto de Equilíbrio e Resultado Líquido Gerencial integrados.
  - [x] Simulador Financeiro (What-If) interativo sem alterar dados reais.
  - [x] Glossário Financeiro completo na `/central`.
  - [ ] Integrar despesas fixas/variáveis reais cadastradas na `/central/custos` diretamente na DRE da `/central` + gráfico de evolução histórica e exportação.
- [~] **Fase 5 — Evolução das páginas especializadas** (30%):
  - [x] Nova página `/central/custos` integrada à navegação da Central.
  - [x] Refinamento das explicações de `p.p.` vs. `%` em `/central/limites`.
  - [ ] Formulários CRUD de despesas e entidades fiscais em `/central/custos`.
  - [ ] Metas financeiras expandidas (lucro, margens, Ads, despesas) em `/central/metas`.
  - [ ] Limites financeiros adicionais (TACoS máx., frete máx., teto de despesas) em `/central/limites`.
  - [ ] Inteligência logística expandida em `/central/frete`.
  - [ ] Orçamento mensal e ACOS de equilíbrio explícito em `/central/ads`.
  - [ ] Simulador de preço/margem e classificação estratégica de SKUs em `/central/produtos`.
- [~] **Fase 6 — Funcionalidades complementares** (45%):
  - [x] Ponto de Equilíbrio e Simulador Financeiro (What-If).
  - [x] Estrutura de Orçamento × Realizado e Fechamento Mensal (domínio + migration).
  - [ ] Interface de fechamento mensal e exportação (CSV/XLSX).
- [~] **Fase 7 — Refinamento visual** (40%):
  - [x] Estilos `--sb-*` para DRE Gerencial e Simulador respeitando contraste e responsividade.
  - [ ] Validação visual no navegador em múltiplas resoluções (desktop/tablet/mobile).
- [~] **Fase 8 — Auditoria, testes e otimização** (45%):
  - [x] 16 testes unitários do motor financeiro + testes de navegação + guardas estáticas + build.
  - [ ] Testes de integração SQL em Postgres local e testes E2E Playwright.
- [~] **Fase 9 — Documentação e entrega** (50%):
  - [x] Documento de acompanhamento da missão criado (`docs/CENTRAL_FINANCEIRA_MISSAO.md`).
  - [ ] Atualização de `docs/METRICS.md`, `docs/DATABASE.md` e `docs/HANDOFF.md` ao final da entrega completa.

---

## 5. Progresso consolidado (Rodada 1 — 2026-11-26)

| Indicador | Progresso |
|---|---|
| Progresso geral da missão | 42% |
| Reconhecimento e auditoria | 100% |
| Arquitetura e backend | 60% |
| Regras e cálculos financeiros | 85% |
| Central principal | 60% |
| Gestão de metas | 20% |
| Gestão de limites | 35% |
| Inteligência de frete | 15% |
| Inteligência de ADS | 15% |
| Rentabilidade de produtos | 20% |
| UX/UI | 40% |
| Performance | 50% |
| Segurança e testes | 45% |
| Documentação | 50% |
