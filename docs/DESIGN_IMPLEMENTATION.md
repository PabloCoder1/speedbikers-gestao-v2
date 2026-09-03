# Implementação Visual — Speed Bikers Gestão V3

Memória da frente **visual**. Não substitui `docs/HANDOFF.md` (estado do
produto) nem `docs/ROADMAP.md` (escopo). História detalhada fica no Git.

## Referência

| | |
|---|---|
| Figma | Telas SpeedBikers Gestão |
| URL | `https://www.figma.com/make/W6rEyVNX39b1RBJDmGiaL1/Telas-SpeedBikers-Gestão` |
| File key | `W6rEyVNX39b1RBJDmGiaL1` |
| Tipo | **Figma Make** — `get_metadata`, `get_screenshot` e `get_variable_defs` **não suportam** `/make/`; só `get_design_context` (nodeId `0:1`) |
| Export local | `Telas SpeedBikers Gestão.zip` (Desktop do usuário) — tokens, design system e briefs |

**O export local é a fonte preferida.** Ele traz `src/theme.css` (tokens
completos), `src/DesignSystem.tsx` (padrões de componente) e nove briefs em
`src/imports/pasted_text/`. Consultar o MCP só quando o export não responder —
`src/App.tsx` tem 228 KB e é monólito de protótipo: **referência, nunca base**.

## Princípio

**Figma = verdade visual/UX. Código, migrations, `METRICS.md` e `DECISIONS.md`
= verdade funcional.** Onde divergirem, o comportamento real vence e o layout
do Figma acomoda o significado real.

---

## Design Contract

### Cores — mapeamento Figma → token real

O real usa `--sb-*` em `apps/web/app/globals.css` (81 linhas, definidas por
D-007). A identidade **bate**: os três tons de marca são o mesmo desenho, com
ajuste fino. O que falta são tons de apoio.

| Papel | Figma | `--sb-*` hoje | Situação |
|---|---|---|---|
| Marca escura (navy) | `#0E1259` | `--sb-primary` `#0f1158` | alinhado |
| Marca clara (violeta) | `#3F44A6` | `--sb-secondary` `#373993` | alinhado |
| Marca destaque (amarelo) | `#F2E30C` | `--sb-accent` `#f8e523` | alinhado |
| Superfície | `#ffffff` | `--sb-surface` | alinhado |
| Borda | `#e4e5f0` | `--sb-border` `#ccc5d5` | **mais escura no real** |
| Texto principal | `#12142b` | `--sb-text` = navy | **real usa navy como texto** |
| Texto secundário | `#4a4d65` | — | **ausente** |
| Texto suave | `#737791` | `--sb-text-soft` `#655d89` | próximo |
| **Fundo da página** | `#f4f5fa` | — | **ausente — body é branco** |
| Hover de superfície | `#f8f9fc` | — | **ausente** |
| **Sucesso** | `#148065` | — | **ausente — telas usam `--sb-secondary` como "ok"** |
| Atenção | `#d98a00` | `--sb-accent-ink` `#8a7a00` | mais escuro no real |
| Perigo | `#e32b2b` | `--sb-danger` `#e83736` | alinhado |

**A diferença estrutural é uma só:** o Figma é **cartão branco sobre fundo
cinza**; o app real é branco sobre branco, separando por borda. Tudo o mais é
ajuste fino.

**Alavanca e risco de D1:** as telas escrevem estilo inline referenciando
`var(--sb-*)`. Mudar o token em `globals.css` propaga para **as 32 telas de
uma vez**; mudar forma de componente, não. Por isso D1 é token, não varredura.

### Tipografia

Sem `next/font`: o real usa a pilha do sistema. O Figma pede **Inter** (texto)
e **DM Mono** (números/IDs). A escala do Figma é densa — `text-[10px]` é o
segundo seletor mais usado do protótipo inteiro:

| Uso | Figma | real (inline) |
|---|---|---|
| Rótulo/eyebrow | 10px, maiúsculas, `letter-spacing` | 0.6875rem / 0.75rem |
| Corpo denso | 12px (`text-xs`) | 0.8125rem |
| Corpo | 14px (`text-sm`) | 0.875rem |
| Título de seção | 17–20px | 1.0625rem |
| Título de página | 24px | 1.375rem |

### Espaçamento e raio

Real: escala de 5 (`--sb-space-1..5` = 0.25/0.5/1/1.5/2.5rem) e **um** raio
(`--sb-radius` 0.5rem). Figma: `p-3`/`p-4`/`p-6` e raio em escala
(4/6/8/12px). D1 acrescenta a escala de raio sem mexer no default.

### Componentes do Figma (de `DesignSystem.tsx`)

- **Badge** — pílula por tom (`neutral | success | warning | danger | info`).
- **Button** — `primary` (navy sólido) e `ghost` (branco, borda, texto navy;
  hover vira violeta). Altura 32px, 11px, `rounded-md`.
- **Object Header** — o padrão de entidade: eyebrow monoespaçado (ID) →
  título → linha de badges + frescor → ações à direita → tabs abaixo de uma
  borda. É o cabeçalho de SKU, anúncio, pedido de compra e fornecedor.
- **Cartão de diagnóstico** — borda esquerda 4px na cor do estado, cabeçalho
  com ícone + instante, grade de dois números, bloco de recomendação
  destacado, ações à direita.
- **Superfície** — `bg-white` + `border` + `rounded-lg` sobre fundo cinza.

### Estados

O real já é mais honesto que o Figma e **isso se preserva**: frescor,
`UNKNOWN`, "não verificável", "dias observados", recusa de número sem base
(D-127/D-237), cobertura da métrica. O layout do Figma acomoda; nenhum desses
sinais sai da tela.

### Responsividade

Prioridade: desktop operacional → tablet razoável → telas menores sem quebra
grave. Tabelas já usam `overflow-x: auto` com `minWidth`.

---

## Componentes reais reutilizáveis

| Componente | Caminho | Situação |
|---|---|---|
| Shell (sidebar + grupos) | `components/shell.tsx` | adaptar em D2 |
| `StatusPill` (fundo por tom) | `components/status-pill.tsx` | ≈ Badge do Figma |
| `StatePill` (contorno) | `components/state-pill.tsx` | ≈ Badge, variante |
| `TrendBadge` | `components/trend-badge.tsx` | alinhado |
| `FilterPill` | `components/filter-pill.tsx` | ≈ filtros do Figma |
| `SavedFilters` | `components/saved-filters.tsx` | alinhado |
| `CommandPalette` | `components/command-palette.tsx` | alinhado |
| `th`/`td`/`tdNumber`/`cardStyle` | `components/table-styles.ts` | **módulo único existe; 32 telas ainda têm cópia privada** |

**Não criar `Card`, `CardV2`, `FigmaCard`.** Adaptar o que existe.

---

## Diferenças intencionais (NÃO APLICAR)

| Figma | Motivo | Fonte |
|---|---|---|
| "Margem" como tela própria | margem é seção de `/vendas`, e sai NULL sob recorte de marca | D-166, D-237 |
| Ads / ROAS / investimento | sem integração Mercado Ads aprovada | ROADMAP (C) |
| Seis telas de Atendimento (Perguntas, Mensagens, Reclamações, Devoluções, Mediações) | devem ser **filtros da mesma Caixa de Entrada**, não seis sistemas | brief D28 do usuário |
| Aba Atendimento no SKU | não existe vínculo confiável SKU → `support_case` | D-084, D-224 |
| Aba Tráfego no SKU | visita é medida por `item_id`; o dono é o Dashboard do Anúncio | D-224 |
| "Enviar X unidades ao Full" | sem política logística defensável | auditoria corretiva do próprio Figma, item 6 |
| Receita líquida | nome vetado; existe margem operacional observada | METRICS 5C.1 |

**A auditoria corretiva do Figma pede a mesma honestidade que o sistema já
pratica** ("Requer política logística", "Quantidade ainda não calculada",
"Não afirmar causalidade"). Nesses pontos os dois lados concordam.

---

## Navegação — Figma × real

O Figma agrupa em `VISÃO GERAL | OPERAÇÃO | INTELIGÊNCIA | ATENDIMENTO |
ADMINISTRAÇÃO`. O real agrupa em `Comercial | Estoque | (compras) |
Inteligência | Atendimento | Gestão`. **Quase todo item existe dos dois
lados**; o que muda é o agrupamento. D2 reconcilia — sem esconder tela real
que o Figma não listou (`Copiloto`, `Reposição`, `Importações`, `Sugestões`,
`Notificações`).

---

## Status de implementação

| Lote | Superfície | Estado |
|---|---|---|
| D0 | Auditoria visual + Design Contract | **CONCLUÍDO** |
| D1 | Design foundation (tokens) | próximo |
| D2 | Shell global | fila |
| D3 | Home | fila |
| D4 | Vendas | fila |
| D5 | Produtos | fila |
| D6–D10 | Dashboard de SKU (fundação + 4 pares de abas) | fila |
| D11–D12 | Anúncios (listagem, depois dashboard em lotes) | fila |
| D13 | Republicação (só UX; motor real preservado) | fila |
| D14–D20 | Estoque, Cobertura/Reposição, Curva ABC, Movimentações, NF-e, Compras, Fornecedores | fila |
| D21–D30 | Vinculações, Diagnóstico, Ações, Alterações, Preços, Full, Tráfego, Atendimento, Conhecimento, Central | fila |
| D31–D36 | Usuários, Integrações, Sincronização, Saúde, Configurações, Copiloto | fila |
| D37 | Passe visual global | fila |

## Última fatia concluída

**D0** — Figma MCP confirmado conectado (não precisou instalar). Tokens,
design system e briefs extraídos do export local, sem gastar consulta ao MCP.
Contrato acima; inventário de componentes; sete diferenças intencionais
registradas.

## Próxima fatia segura

**D1 — Design foundation.** Só `apps/web/app/globals.css`, acrescentando o que
falta (fundo de página, `success`, texto secundário, hover de superfície,
escala de raio) e aproximando borda e texto dos valores do Figma. **Sem tocar
nas 32 telas**: elas leem os tokens. Verificar que o contraste continua
acessível e que nenhuma tela regride — o risco é justamente a propagação.
