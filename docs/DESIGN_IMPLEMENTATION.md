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

O real usa `--sb-*` em `apps/web/app/globals.css`, definidos por D-007. A
identidade **bate**: os três tons de marca são o mesmo desenho. D1 mediu
contraste WCAG de cada token contra a superfície em que ele **realmente**
aparece — e o veredito inverteu três suposições desta tabela.

| Papel | Figma | `--sb-*` depois de D1 | Contraste medido |
|---|---|---|---|
| Marca escura (navy) | `#0E1259` | `--sb-primary` `#0f1158` | 16,92x |
| Marca clara (violeta) | `#3F44A6` | `--sb-secondary` `#373993` | 9,68x |
| Marca destaque | `#F2E30C` | `--sb-accent` `#f8e523` | só fundo, nunca texto (D-007) |
| Borda | `#e4e5f0` | `--sb-border` `#ccc5d5` | **mantida** — clarear só faz sentido junto do fundo cinza (D2) |
| Texto principal | `#12142b` | `--sb-text` = navy | 16,92x — o Figma também usa navy como texto |
| Texto suave | `#737791` | `--sb-text-soft` `#655d89` | **real 6,03x × Figma 4,40x — o do Figma reprova** |
| Fundo da página | `#f4f5fa` | ausente | **movido para D2** (motivo abaixo) |
| Linha de apoio | `#f8f9fc` | `--sb-bg-soft` | novo |
| Sucesso | `#148065` | `--sb-success` `#136c34` | **real 5,74x × Figma 4,30x sobre o próprio fundo suave** |
| Atenção (tinta) | `#d98a00` | `--sb-accent-ink` `#807100` | 4,05x → **4,61x** corrigido |
| Perigo | `#e32b2b` | `--sb-danger` `#dd1d1d` | 4,17x → **4,92x** corrigido |
| Perigo (tinta) | — | `--sb-danger-ink` `#d61a18` | 3,60x → **4,51x** corrigido |
| Menor peso | — | `--sb-muted-ink` `#746d88` | 4,37x → **4,90x** corrigido |

**Três vezes o real venceu o Figma na medição** (texto suave, verde, e a
tinta de perigo que o Figma não tem). O Figma é verdade visual; não é verdade
de contraste. Onde ele reprovou, ficou o valor real — e onde os dois
reprovaram, entrou um terceiro valor de mesma matiz, só escurecido.

**A regra que fechou o escopo de D1:** *só entra token que ganha consumidor na
mesma fatia.* Token declarado sem leitor é promessa, não fato. Por isso a
escala de raio e o fundo cinza ficaram de fora — e por isso as cinco cores de
estado entraram: elas já tinham 16 consumidores, escritos como hex literal.

**A diferença estrutural é uma só:** o Figma é **cartão branco sobre fundo
cinza**; o app real é branco sobre branco, separando por borda. Tudo o mais é
ajuste fino.

**Por que o fundo cinza é de D2, e não de D1:** `cardStyle` em
`components/table-styles.ts` **não define `background`** — o cartão herda o
fundo da página. Pintar o `body` de `#f4f5fa` hoje daria cartão cinza sobre
cinza, e só 4 das 32 telas importam o módulo único (as outras 28 carregam
cópia privada). O cinza entra junto com o `background` do cartão, em D2.

### Tipografia

Sem `next/font`: o real usa a pilha do sistema. O Figma pede **Inter** (texto)
e **DM Mono** (números/IDs).

**A fonte não entrou em D1, de propósito.** Cor e métrica de fonte são classes
de risco diferentes: cor se prova com número (contraste), fonte se prova com
tela renderizada (deslocamento de layout em tabela densa). Juntas numa fatia
só, uma tabela quebrada não diria qual das duas a quebrou — a mesma classe de
erro da D-200. A fonte é fatia própria, com telas densas renderizadas antes e
depois. A escala do Figma é densa — `text-[10px]` é o segundo seletor mais
usado do protótipo inteiro:

| Uso | Figma | real (inline) |
|---|---|---|
| Rótulo/eyebrow | 10px, maiúsculas, `letter-spacing` | 0.6875rem / 0.75rem |
| Corpo denso | 12px (`text-xs`) | 0.8125rem |
| Corpo | 14px (`text-sm`) | 0.875rem |
| Título de seção | 17–20px | 1.0625rem |
| Título de página | 24px | 1.375rem |

### Espaçamento e raio

Real: escala de 5 (`--sb-space-1..5` = 0.25/0.5/1/1.5/2.5rem) e **um** raio
(`--sb-radius` 0.5rem = 8px, que é o `lg` do Figma). Figma: `p-3`/`p-4`/`p-6`
e raio em escala (4/6/8/12px). A escala de raio entra quando um componente
pedir — hoje nenhum pede, e token sem leitor não entra (regra de D1).

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
| D1 | Design foundation (tokens de cor) | **CONCLUÍDO** |
| D2 | Shell global + fundo cinza + `background` do cartão | próximo |
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
| — | Tipografia (Inter + DM Mono) | fatia própria, sem posição fixa |

## Última fatia concluída

**D1 — tokens de cor.** Mediu contraste WCAG de todo par (texto, fundo) que o
app pinta: **18 pares, 4 reprovavam**. Depois: 18 pares, **zero reprovações**,
pior caso 4,51x. As quatro falhas eram antigas e invisíveis — pílula de
atenção (4,05x), pílula de perigo (3,60x), `--sb-muted-ink` (4,37x) e
`--sb-danger` (4,17x, que também é o fundo do botão destrutivo com texto
branco em `compras/[id]/actions-panel.tsx`).

Na varredura apareceu o achado que definiu a fatia: o app **já tinha** uma
paleta de estado completa — `#fdeaea`, `#e6f4ea`, `#fff8dc`, `#136c34` — como
hex literal em 16 lugares de 7 arquivos, contra o que o próprio cabeçalho do
`globals.css` mandava. E `app/acoes/action-row.tsx` escrevia
`var(--sb-bg-soft, #f7f7f8)`: um `var()` de um token **que nunca existiu**,
então o fallback era o valor real. D1 deu nome aos quatro, criou o quinto, e
hoje **não há um único hex literal em `apps/web`**.

Verificação: contraste conferido também no navegador (5,74 / 4,61 / 4,51 /
10,08 — bateu com a aritmética na segunda casa); 273 unitários, 582 de
integração, 19 e2e, `build` e `docs:check`. As duas falhas de e2e da primeira
rodada eram estado acumulado, não regressão: provado com `db reset` + reseed.

## Próxima fatia segura

**D2 — Shell global.** `components/shell.tsx` mais duas linhas em
`components/table-styles.ts`: `background: var(--sb-surface)` no `cardStyle` e
o `--sb-ground` no `body`. Essa ordem importa — o fundo cinza sem o cartão
branco é regressão em 28 telas. A dívida das cópias privadas de `cardStyle`
(já registrada no HANDOFF) passa a ter consequência visual, e é o que decide
se D2 cabe numa fatia ou vira duas.
