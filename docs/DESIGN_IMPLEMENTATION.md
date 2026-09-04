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

### Tipografia — extraída do export, não estimada

**Inter** (texto) e **DM Mono** (rótulos e números), carregadas por `next/font`
em `app/layout.tsx`: baixadas no build e servidas do próprio domínio, sem
requisição ao Google em tempo de execução.

**A escala do Figma é MUITO mais densa do que parecia.** Contadas todas as
regras de `font-size` do export:

| tamanho | regras |
|---|---|
| 9px | 69 |
| 10px | 90 |
| 11px | 54 |
| 12px | 14 |
| 13px | 10 |
| 14–31px | 65 somados |

**213 das ~300 regras estão em 9, 10 e 11px.** O corpo é `body{font-size:13px}`
— o app herdava os 16px do navegador. Pesos usados: 400, 500, 600, 700.

**O mono aparece em 38 seletores**, e essa alternância é o que dá a "cara" do
desenho — nenhuma cor substitui: sobrancelha, **pílula de status**, **cabeçalho
de tabela**, **eixos do gráfico**, tecla de atalho, avatar, marca de conta,
identificador de métrica, quantidade.

### Espaçamento e raio

Raios contados no export: **8px (18×), 6px (16×), 5px (15×), 50% (13×), 7px
(13×), 4px (9×)**. Definidos aqui: `--sb-radius-sm` 4px (a pílula de estado),
`--sb-radius-md` 6px (item de menu, botão) e `--sb-radius` 8px (cartão).

**Sombra:** o Figma tem 16 distintas; a do cartão é `0 6px 18px #0e125908` —
navy a 3%. O brief proíbe "sombras fortes", então é uma só e é fraca
(`--sb-shadow-panel`).

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

### Desvios registrados, no formato curto

> **Superfície:** `/produtos` · **Figma:** tabela com 5 colunas (Produto/SKU,
> Marca, Tipo de Estoque, Anúncios) · **V3 real:** 8 colunas — acrescenta
> Categoria (ERP), Saldo no ERP, Vendas 90d, Sugestão e Classificação ·
> **Decisão:** manter as oito · **Motivo:** regra funcional — a decisão de
> curadoria se toma OLHANDO o sinal (saldo do ERP contra venda de 90 dias); sem
> essas colunas a tela vira uma lista, e a sugestão medida perde o lastro.

> **Superfície:** `/produtos` · **Figma:** ações em lote esmaecidas e
> `cursor-not-allowed` · **V3 real:** `disabled` de verdade, e **visíveis** ·
> **Decisão:** não escondê-las quando nada está selecionado · **Motivo:** um
> botão que só aparece depois da seleção esconde do operador o que ele PODE
> fazer antes de decidir selecionar.



> **Superfície:** moldura · **Figma:** `.brand` com arquivo de logo · **V3
> real:** símbolo com as iniciais da organização · **Decisão:** usar a variante
> `.brand-symbol` que o próprio Figma declara · **Motivo:** dado inexistente —
> o app não tem **nenhuma** imagem (medido: sem `<img>`, sem SVG, sem `public/`).

> **Superfície:** moldura · **Figma:** `.account-switch` abre um seletor de
> escopo · **V3 real:** bloco de informação com link para `/contas` ·
> **Decisão:** manter a composição, trocar a ação · **Motivo:** regra funcional
> — não há segunda organização, e `lib/membership.ts` **nomeia** esse estado em
> vez de escolher uma (D-232).

> **Superfície:** moldura · **Figma:** `.profile` com chevron de menu ·
> **V3 real:** perfil é informação e "Sair" fica visível · **Decisão:** não
> criar o menu · **Motivo:** escopo enxuto — o dropdown não foi desenhado, e
> esconder o "Sair" atrás dele piora o que existe.

> **Superfície:** moldura · **Figma:** "Central de ajuda" no rodapé da sidebar,
> botão flutuante do Copiloto, botão de recolher a sidebar · **V3 real:**
> ausentes · **Decisão:** omitir os dois primeiros, adiar o terceiro ·
> **Motivo:** não existe / seria um terceiro caminho para uma rota que já está
> no menu e no topbar / o recolher só faz sentido com o trilho de 58px, que
> pede estado de cliente.



> **Superfície:** `/vendas` · **Figma:** célula "Receita líquida ML" na faixa de
> KPIs · **V3 real:** a célula não existe · **Decisão:** recompor a faixa sem
> ela · **Motivo:** nome vetado por METRICS 5C.1 — existe margem operacional
> observada, que tem painel próprio.

> **Superfície:** `/vendas` · **Figma:** cada célula da faixa mostra variação
> percentual ("+9,3%") · **V3 real:** mostra o valor do período anterior ·
> **Decisão:** manter a terceira linha da célula, trocar o conteúdo ·
> **Motivo:** `variacao_percentual_periodo` está pendente em METRICS 5.4, e
> D-023 proíbe número sintetizado sem `metric_definitions`.

> **Superfície:** `/vendas` · **Figma:** célula da faixa tem 3 linhas · **V3
> real:** tem até 5 · **Decisão:** acrescentar id da métrica e ressalva ·
> **Motivo:** METRICS 5C.2 exige a ressalva "visível ao lado do número, nunca
> só em tooltip", e o id é a rastreabilidade até a definição canônica.

> **Superfície:** `/vendas` · **Figma:** `page-title` sem selo de estado · **V3
> real:** tem o veredito de frescor na barra · **Decisão:** manter ·
> **Motivo:** regra funcional — D-143/D-219 fazem de `lib/sync-health.ts` o
> dono único do veredito, e ele diz se o número lido foi recalculado.

> **Superfície:** `/vendas` · **Figma:** tabela "Produtos que mais
> contribuíram" ao pé da tela · **V3 real:** ausente · **Decisão:** adiar ·
> **Motivo:** escopo — exige uma consulta que a tela não faz hoje; `/curva-abc`
> já responde a mesma pergunta e é para lá que o link deve apontar quando a
> tabela entrar.

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
| D3 | Moldura: sidebar vertical, grupos e seção atual | **CONCLUÍDO** · refeita pelo frame |
| D4 | Home orientada à atenção | **CONCLUÍDO** · composição refeita em R3 |
| D5 | Vendas — gráfico (seção 12 do brief) | **CONCLUÍDO** |
| D6 | Vendas — composição, refeita a partir do Figma | **CONCLUÍDO** |
| R1 | Retrabalho da moldura, pelo **frame** do Figma | **CONCLUÍDO** |
| R2 | Sistema tipográfico e densidade (Inter + DM Mono) | **CONCLUÍDO** |
| R3 | Home, refeita pelo frame do Figma | **CONCLUÍDO** |
| D7 | Produtos | fila |

| D8–D12 | Dashboard de SKU (fundação + 4 pares de abas) | fila |
| D11–D12 | Anúncios (listagem, depois dashboard em lotes) | fila |
| D13 | Republicação (só UX; motor real preservado) | fila |
| D14–D20 | Estoque, Cobertura/Reposição, Curva ABC, Movimentações, NF-e, Compras, Fornecedores | fila |
| D21–D30 | Vinculações, Diagnóstico, Ações, Alterações, Preços, Full, Tráfego, Atendimento, Conhecimento, Central | fila |
| D31–D36 | Usuários, Integrações, Sincronização, Saúde, Configurações, Copiloto | fila |
| D37 | Passe visual global | fila |
| — | Tipografia (Inter + DM Mono) | fatia própria, sem posição fixa |

## Revisão visual necessária

**Nenhuma.** A auditoria de retrabalho fechou: a moldura (R1) e a Home (R3)
foram refeitas a partir dos frames, `/vendas` (D6) já nasceu Figma-first, e
D1/D2/D5 não têm composição a revisar.

O que resta são superfícies **ainda não migradas** — a fila D7 em diante.

## Última fatia concluída

**D7 — `/produtos`, a curadoria.** Primeira superfície da fila normal sob a
regra nova, e a primeira em que **o que precisa sobreviver é a ESCRITA**.

Composição, do frame `ProductsCuration`:

| antes | agora |
|---|---|
| `<h1>` + parágrafo | `PageTitle` com sobrancelha "INTELIGÊNCIA / CURADORIA" e a barra de filtros à direita |
| três linhas de pílulas + busca | três menus `<details>` + busca, na barra |
| tarja cinza com os contadores em texto corrido | rótulo de seção "Retrato do ERP" + **faixa de indicadores** com quatro contagens |
| barra `sticky` solta acima da tabela | **cabeçalho do cartão**: "Selecionar todos", contagem e ações, sobre o fundo de apoio |
| colunas SKU e Título separadas | célula única **"Produto / SKU"** — título em negrito, SKU em monoespaçado embaixo |

**O `sticky` saiu porque deixou de fazer sentido:** desde R1 a moldura rola só o
conteúdo, então a barra já não sai de vista.

**A faixa de indicadores estreou sem id de métrica.** As quatro contagens são
estados do catálogo ("nunca classificados", "a revisar"), não métricas de
`metric_definitions` — `metricId` virou opcional no componente, porque apontar
para uma definição que não existe é pior do que não apontar.

**A escrita foi exercitada inteira, até o banco.** O novo `e2e/produtos.spec.ts`
percorre o caminho na ordem que a tela impõe: ação nasce desabilitada →
selecionar habilita e o contador acompanha → a confirmação mostra a
**CONSEQUÊNCIA** ("a Cobertura deixará de calcular dias") → confirmar escreve e
oferece **desfazer**. Verificado também por consulta direta: `stock_is_virtual`
saiu de nulo para `true`.

O passo da consequência é o que mais importa: sem ele, um clique em "É virtual"
apaga da Cobertura o cálculo de dias de 2.306 SKUs sem que ninguém tenha lido o
que isso significa.

**Verificação:** `check` 29/29, build 8/8, integração 582/582, **22/22
Playwright**, `check:waterfalls`, `check:server-actions`, `docs:check`.

## Próxima fatia segura

**D8 — Dashboard de SKU, a fundação.** O brief pede header persistente + KPIs +
abas (`speed-bikers-design.md`, seção 17), e a regra especial do usuário fixa a
ordem: Visão Geral, Vendas, Estoque, Anúncios, Preços, Full, Histórico,
Diagnóstico, Decisões. A tela já tem abas; o que muda é a composição do
cabeçalho e a ordem. **Atendimento e Tráfego seguem fora** — diferenças
intencionais registradas (D-084, D-224).
