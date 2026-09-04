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

## Princípio — CORRIGIDO em 2026-09-04

**O Figma é a REFERÊNCIA PRINCIPAL da experiência visual final.** Correção de
direção dada pelo usuário: as fatias D1–D5 vinham *adaptando a tela antiga* com
as cores do Figma, e não é isso que esta frente existe para fazer.

| O Figma dita | O código real dita |
|---|---|
| estrutura visual, composição, hierarquia | dados, comportamento, regras de negócio |
| navegação, tabs, cards, filtros, tabelas | permissões, RLS, integrações |
| drawers, modais, densidade, spacing | Server Actions, RPCs, estados reais |
| identidade visual, UX final | métricas canônicas, lógica de domínio |

**Não é** "tela antiga + cores do Figma". **É** "tela do Figma + dados e
comportamento reais da V3".

### Ordem obrigatória antes de mexer em qualquer tela

1. ler este documento;
2. **ler a tela correspondente no Figma** (o frame, não só os tokens);
3. entender a composição do Figma;
4. **só então** abrir a implementação antiga;
5. mapear quais dados e comportamentos precisam sobreviver;
6. reconstruir a apresentação seguindo o Figma.

Nunca o contrário. A pergunta não é "como adapto esta tela ao Figma", é
**"como implemento esta tela do Figma com os dados reais que já temos"**.

### Regra de conflito

| conflito | quem vence |
|---|---|
| Figma × UI antiga | **Figma** |
| Figma × regra funcional real | regra funcional |
| Figma × segurança | segurança |
| Figma × métrica canônica | métrica canônica |
| Figma × feature fora de escopo | escopo aprovado |

Quando o Figma mostra algo que o sistema não tem (Ads, ROAS, concorrência,
automação), **mantém-se o desenho e remove-se o conteúdo incompatível** —
recompondo o bloco sem ele, nunca preenchendo com número falso.

### Classificação do legado, por superfície

`KEEP` comportamento continua adequado · `ADAPT` lógica boa, apresentação segue
o Figma · `MERGE` duplicação vira componente único · `REMOVE` ficou sem
consumidor depois da migração · `DEFER` fora do escopo atual.

**Dead code pass** depois de cada superfície migrada e validada: imports,
componentes, rotas, links, busca universal, testes, CSS. Não deixar duas
implementações da mesma interface convivendo, e **nunca** `DashboardV2` ao lado
de `Dashboard`. Backend (RPC, migration, tabela, policy, job, contrato) **não**
se remove por não aparecer no Figma — a limpeza é de frontend.

### Formato de desvio intencional

> **Superfície:** `/rota` · **Figma:** … · **V3 real:** … · **Decisão:** … ·
> **Motivo:** dado inexistente / decisão de produto / segurança / regra
> funcional / escopo enxuto.

Serve para distinguir "não ficou igual" de "não **deveria** ficar igual".

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
| Variação percentual entre períodos na Home | `variacao_percentual_periodo` está pendente em METRICS 5.4, e D-023 proíbe número sintetizado sem `metric_definitions` — a tela mostra os dois valores lado a lado | D-023 |
| "Faturamento hoje" na Home | `/vendas` já tem o bloco "Hoje" com o aviso de dia parcial; repetir seria dois donos do mesmo dado com o mesmo aviso | D-224 |
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
| D4 | Home orientada à atenção | **CONCLUÍDO** · `REVISÃO VISUAL NECESSÁRIA` |
| D5 | Vendas — gráfico (seção 12 do brief) | **CONCLUÍDO** |
| D6 | Vendas — composição, refeita a partir do Figma | próximo |
| D6 | Produtos | fila |
| D6–D10 | Dashboard de SKU (fundação + 4 pares de abas) | fila |
| D11–D12 | Anúncios (listagem, depois dashboard em lotes) | fila |
| D13 | Republicação (só UX; motor real preservado) | fila |
| D14–D20 | Estoque, Cobertura/Reposição, Curva ABC, Movimentações, NF-e, Compras, Fornecedores | fila |
| D21–D30 | Vinculações, Diagnóstico, Ações, Alterações, Preços, Full, Tráfego, Atendimento, Conhecimento, Central | fila |
| D31–D36 | Usuários, Integrações, Sincronização, Saúde, Configurações, Copiloto | fila |
| D37 | Passe visual global | fila |
| — | Tipografia (Inter + DM Mono) | fatia própria, sem posição fixa |

## Revisão visual necessária

Telas migradas **antes** da correção de direção de 2026-09-04, que seguem
presas à composição antiga. Não serão refeitas agora — a fila não para — mas
cada uma precisa de um passe Figma-first antes de a frente fechar.

| Superfície | O que está preso ao legado |
|---|---|
| `/` (D4) | conteúdo e severidade estão certos; a composição é grade de cards herdada, não o `.kpi-strip` + `.attention-card` do Figma |
| `/vendas` (D5) | só o gráfico foi refeito; cabeçalho, filtros em linhas de pílulas e os três blocos de cards são a estrutura antiga — é o assunto de D6 |

## Última fatia concluída

**D5 — o gráfico de vendas** (seção 12 do brief: "tooltip detalhado; zoom/hover;
legenda"). Duas coisas, e a primeira é defeito medido:

**A série de comparação era invisível.** Usava `--sb-muted` (`#ccc5d5`) —
**1,68:1** contra o cartão branco, onde a WCAG 1.4.11 pede **3:1** de objeto
gráfico que carrega informação. Uma tracejada de 1,5px é o caso mais frágil que
existe: sem preenchimento, sem borda, sem nada atrás. O gráfico desenhava a
comparação e ninguém a via. Agora é `--sb-muted-ink` (**4,90:1**), que ainda
fica a 3,45:1 da série atual — a hierarquia se mantém por peso e traço, não por
apagamento.

**Hover por faixa, não por ponto.** O que existia era o `<title>` nativo num
círculo de raio 3: para ler um valor era preciso acertar 6px, e com 90 dias isso
é impraticável. Agora cada dia do período tem faixa invisível de altura inteira;
passar em qualquer altura acende a cruz, engorda o ponto e abre a leitura com os
dois valores. **CSS puro** — `:hover` sobre um `<g>`, sem estado, sem
hidratação, sem componente cliente. E `@media (hover: hover)`, porque em tela de
toque o `:hover` gruda e a caixa ficaria aberta sem forma de fechar.

**As faixas cobrem o período, não os pontos.** Dia sem métrica calculada agora
**diz** que não tem métrica, onde antes era silêncio — a série não fabrica zero,
então "o dia não existe no dado" e "o dia vendeu zero" são afirmações
diferentes.

**Verificado com dado**, o que exigiu um fixture local de 60 dias (o seed não
tem série): 30 faixas em 30 dias e 90 em 90; exatamente **uma** leitura abre por
vez; a formatação segue a métrica (`R$ 1.279,70` em faturamento, `19` em
unidades); e a recusa de D-237 continua intacta — sob "Compras + Sem marca" o
gráfico não desenha nada e explica por quê.

**Verificação:** `check` 29/29, build 8/8, integração 582/582 em banco recriado,
20/20 Playwright, `check:waterfalls`, `check:server-actions`, `docs:check`.

## Próxima fatia segura

**D6 — a composição de `/vendas`, refeita a partir do Figma.** Não é adaptar o
que está lá: é implementar o frame `Sales` do Figma com os dados reais. A
composição dele, já extraída:

`page-title` (eyebrow "COMERCIAL / RESULTADOS" + h1 + subtítulo, com toolbar de
botões-fantasma à direita) → `kpi-strip` (UM cartão dividido em 5 células, a
primeira com fundo navy) → `panel` do gráfico (cabeçalho com título, subtítulo e
legenda à direita; controle segmentado de métrica; eixo Y fora do SVG) →
`table-panel` "Produtos que mais contribuíram".

**Desvios já conhecidos:** o `kpi-strip` do Figma traz "Receita líquida ML"
(nome vetado, METRICS 5C.1) e uma variação percentual em cada célula (proibida
por D-023 sem `metric_definitions`) — a composição fica, o conteúdo vira o valor
do período anterior, que é o que `/vendas` já mostra hoje.
