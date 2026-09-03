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

**Por que o fundo cinza não entrou nem em D1 nem em D2:** ver
"O passo branco e o passo cinza", abaixo. A resposta curta é que ele não é uma
linha — é a última linha de uma sequência, e a sequência é o trabalho.

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

## O passo branco e o passo cinza

O padrão do Figma é **cartão branco sobre fundo cinza**. O app é branco sobre
branco, separando por borda. Trocar isso parece uma linha —
`body { background: #f4f5fa }` — e **não é**. Medido:

| medição | número |
|---|---|
| separação do cartão branco contra o cinza, sem borda | **1,089:1** |
| `<table>` no app, e wrappers `overflowX:auto` | **44 e 44** — relação 1:1 |
| tabelas dentro de cartão | **nenhuma** |
| telas autenticadas que a mudança alcança de uma vez | **46** |
| testes que afirmam qualquer coisa sobre cor ou fundo | **zero** |

**O cartão branco não se separa do cinza sozinho** — 1,089:1 é quase nada. Quem
separa é a borda, antes e depois. O cinza compra hierarquia, não separação; e
trocar a borda pela do Figma (`#e4e5f0`) *piora* (1,68 → 1,25 contra o cartão),
porque o Figma compensa com sombra que o app não tem.

### Ordem: branco primeiro, cinza por último

Cada passo branco é um diff **visualmente nulo** — sobre página branca,
declarar `background: var(--sb-surface)` renderiza exatamente igual. Por ser
nulo, pode ser fatiado à vontade, sem estado intermediário quebrado em tela
nenhuma. A ordem inversa quebra 46 telas ao mesmo tempo, pelo tempo que as
fatias seguintes levarem, e sem nenhum teste para pegar.

### O que ainda falta para o cinza — medido, não estimado

Cada item abaixo foi verificado no código; nenhum é hipótese.

1. **`--sb-surface` significa duas coisas.** É o fundo do `body` **e** o token
   de "cartão branco" em 15 lugares. Repontá-lo para cinza pintaria de cinza a
   camada flutuante inteira — o dropdown da navegação, a paleta `Ctrl+K`, os
   toasts, a barra sticky da curadoria — que é justamente a camada cuja única
   função é parecer *acima*. **O cinza precisa de token próprio (`--sb-ground`),
   e `--sb-surface` continua branco.** É violação de "um dado, um dono"
   (D-224) que só a coincidência de ambos serem brancos escondia.
2. **Pintar o `<main>`, não o `body`.** O `<header>` é irmão do `<main>`: com o
   `body` cinza ele vai junto em 46 telas; com o `<main>` cinza ele fica branco
   de graça. E `app/login/page.tsx`, a única tela fora do Shell, fica intocada.
   D2 já pôs o `background` no `<main>` — trocar o token ali é a linha final.
3. **`status-pill.tsx` não tem borda: o fundo *é* a forma da pílula.** Sobre o
   cinza, `warn` (`#fff8dc`) fica **mais claro que o chão** e inverte, a
   1,02:1; `ok` e `bad` perdem 68% e 59% da separação. E elas vivem em tabelas
   que ficam direto no chão. **O cinza destruiria as pílulas que D1 consertou**
   se as tabelas já não fossem brancas — por isso a regra da tabela veio antes.
4. **`--sb-bg-soft` (`#f8f9fc`) colide com o cinza e é mais claro que ele.** As
   linhas de apoio de `/acoes` inverteriam de recuo para destaque, a 1,03:1.
   Precisa ser reescolhido contra o novo chão.
5. **Toda razão de contraste cai 8,2% de uma vez.** `--sb-muted-ink` (`#746d88`)
   vai de 4,90 para **4,499** — abaixo de AA, em ~30 lugares. A escolha de D1
   mirou 4,50 sobre o cinza e ficou de fora por arredondamento; ou escurece, ou
   o texto passa a viver dentro de cartão branco.
6. **A série de comparação do gráfico de `/vendas` já reprova hoje.** A
   tracejada do período anterior é `--sb-muted` a **1,68:1**, contra os 3:1 que
   a WCAG 1.4.11 pede de objeto gráfico que carrega informação. O cinza leva a
   1,54:1. É defeito existente, e é achado próprio desta fatia.
7. **~90 controles nativos.** Não há `color-scheme` em lugar nenhum: o
   navegador pinta os campos de branco, e os 31 `background: "transparent"`
   explícitos ficariam cinza — dois tipos de campo, duas cores, às vezes na
   mesma célula.
8. **Uma dívida que o cinza *paga*:** `app/notificacoes/notification-row.tsx:70`
   distingue lida de não-lida com `--sb-surface` vs `transparent`. Os dois
   ramos rendem branco hoje — **o realce existe no código e nunca apareceu na
   tela.** Com o chão separado, liga sozinho.

**Ausências verificadas** (procuradas e inexistentes, então não são risco):
nenhum gradiente, `@media print`, `color-scheme`, `::-webkit-scrollbar`,
`<canvas>`, `<img>`/`next/image`, diretório `public/`, logo ou SVG com fundo
branco embutido.

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
| `th`/`td`/`tdNumber`/`cardStyle` | `components/table-styles.ts` | **2 telas importam; 3 têm cópia nomeada; o resto é estilo inline ad-hoc** |

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
| Seletor de organização na sidebar | não há segunda organização, e `lib/membership.ts` **nomeia** esse estado em vez de escolher uma | D-232 |
| Central de Ajuda | não existe | — |
| Menu de perfil | esconderia o "Sair" atrás de um dropdown que não foi desenhado | — |
| Botão flutuante do Copiloto | Copiloto é rota, e está no menu | — |
| Trilho de 58px só com ícones | o app não tem **nenhum** ícone (medido: sem `<img>`, sem SVG, sem `public/`) — um trilho sem ícone é uma coluna vazia | — |

**A auditoria corretiva do Figma pede a mesma honestidade que o sistema já
pratica** ("Requer política logística", "Quantidade ainda não calculada",
"Não afirmar causalidade"). Nesses pontos os dois lados concordam.

---

## Navegação — Figma × real

**O brief decide, e ele é explícito.** `speed-bikers-design.md`, seção 7
"ESTRUTURA GLOBAL", pede "SIDEBAR VERTICAL ESQUERDA + TOP BAR + ÁREA CENTRAL",
com a sidebar podendo "ficar expandida", "ficar compacta", "agrupar
funcionalidades" e "destacar seção atual" — e fecha com a frase que condenava a
moldura anterior: **"Não usar dezenas de links horizontalmente no topo."** Eram
29 links em cinco dropdowns. "Sidebar escura" aparece em outros dois briefs
(`speed-bikers-design-evolution.md:42`, `speed-bikers-v3-tasks.md:912`).

D3 trocou a moldura. O agrupamento é o do Figma (`VISÃO GERAL | OPERAÇÃO |
INTELIGÊNCIA | ATENDIMENTO | ADMINISTRAÇÃO`), com duas regras:

- **nenhuma tela real ficou de fora por não estar no Figma** — Reposição,
  Importações, Copiloto e Sugestões entraram no grupo que lhes cabe;
- **nenhuma tela do Figma que não existe foi inventada** — Margem, Insights,
  Design System e as cinco de Atendimento seguem como diferenças intencionais.

Métricas e Templates de atendimento continuam linkadas do cabeçalho da própria
Caixa de Entrada: são ferramentas dela, não seções.

**Cuidado com o export do Figma:** ele RENDERIZA a sidebar branca, com o nome
da marca em branco por cima (invisível). É colisão de CSS no arquivo montado
por script, não decisão — o bloco escuro e o claro têm a mesma especificidade e
o claro vem depois. A intenção escura está provada em três lugares (os dois
briefs acima e o comentário `/* Correção da Logo (Forçar cor branca sobre fundo
escuro da Sidebar) */` no próprio CSS). **Copie o que o export declara, não o
que ele renderiza.**

## Status de implementação

| Lote | Superfície | Estado |
|---|---|---|
| D0 | Auditoria visual + Design Contract | **CONCLUÍDO** |
| D1 | Design foundation (tokens de cor) | **CONCLUÍDO** |
| D2 | Shell + o passo branco (superfícies declaram fundo) | **CONCLUÍDO** |
| — | O passo cinza (`--sb-ground` no `<main>`) | fila, com pré-requisitos medidos |
| D3 | Moldura: sidebar vertical, grupos e seção atual | **CONCLUÍDO** |
| D4 | Home | próximo |
| D5 | Vendas | fila |
| D6 | Produtos | fila |
| D6–D10 | Dashboard de SKU (fundação + 4 pares de abas) | fila |
| D11–D12 | Anúncios (listagem, depois dashboard em lotes) | fila |
| D13 | Republicação (só UX; motor real preservado) | fila |
| D14–D20 | Estoque, Cobertura/Reposição, Curva ABC, Movimentações, NF-e, Compras, Fornecedores | fila |
| D21–D30 | Vinculações, Diagnóstico, Ações, Alterações, Preços, Full, Tráfego, Atendimento, Conhecimento, Central | fila |
| D31–D36 | Usuários, Integrações, Sincronização, Saúde, Configurações, Copiloto | fila |
| D37 | Passe visual global | fila |
| — | Tipografia (Inter + DM Mono) | fatia própria, sem posição fixa |

## Última fatia concluída

**D3 — a moldura.** Sidebar escura à esquerda com os cinco grupos do Figma,
topbar com busca/notificações/usuário/sair, e a seção atual marcada — em cor
**e** em `aria-current="page"`, a mesma doutrina de `components/filter-pill.tsx`.
`components/nav.tsx` é o único client component novo, e existe por um motivo
só: "destacar seção atual" exige a rota atual, e o App Router não a entrega a um
Server Component. As quatro leituras em `Promise.all` do Shell (D-195) não foram
tocadas.

**Contraste medido antes de copiar**, contra o ponto mais claro do gradiente que
o Figma declara (`#161b68`, o pior caso) e contra o navy do app: item de menu
12,16x / 13,63x, rótulo de grupo 8,18x / 9,16x, item ativo (navy sobre o amarelo
da marca) 13,07x. Passa com folga em qualquer ponto — por isso a sidebar aqui é
navy chapado, e não gradiente: o gradiente não muda o veredito e o brief pede
"sem excesso de gradientes".

**Duas telas quebradas, achadas porque o menu novo passou a apontar para elas.**
Uma varredura dos 28 links encontrou duas HTTP 500, ambas da mesma causa: um
módulo `"use server"` exportando uma **constante**. O contrato do Next é que
todo export de um módulo assim seja função assíncrona — a constante chega ao
componente cliente como referência de servidor, e `.map(...)` não existe.
`build`, `typecheck` e `lint` passam; a tela morre em runtime (classe D-131).

- `/atendimento/conhecimento` quebrava **sempre**. Nada no menu antigo apontava
  para lá — só o cabeçalho da Caixa de Entrada.
- `/sugestoes` quebrava **só com dado**. Com a tabela vazia a linha nunca
  renderiza. Provado inserindo uma sugestão: 200 vira 500.

Corrigidas movendo os valores para um `constants.ts` irmão, e guardadas por
`apps/web/scripts/check-server-actions.mjs`, no CI ao lado do
`check:waterfalls`. O guarda foi provado contra o código de antes: reprova com
saída 1, e passa depois.

**Verificação:** 28/28 links do menu resolvem e cada um marca exatamente a si
mesmo como seção atual; em 1440/1100/860/700px a **página** nunca rola na
horizontal (só a tabela, dentro de si) — é o que o `min-width: 0` na coluna de
conteúdo promete; 273 unitários, 582 de integração em banco recriado, 19 e2e,
`check` 29/29, `build` 8/8, `check:waterfalls`, `check:server-actions`,
`docs:check`.

## Próxima fatia segura

**D4 — Home.** A tela mais curta do app (quatro cartões e um link), agora dentro
de uma moldura estável. É onde o "cartão de atenção" do Figma
(`.attention-card`, faixa esquerda de 4px na cor do estado) encontra os quatro
números que a Home já lê — e onde se decide se o cartão de diagnóstico do
`DesignSystem.tsx` vira componente real ou fica sendo padrão inline.
