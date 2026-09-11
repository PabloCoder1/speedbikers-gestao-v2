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

~~**A diferença estrutural é uma só:** o Figma é **cartão branco sobre fundo
cinza**; o app real é branco sobre branco, separando por borda.~~ — **FECHADA em
D-285**: o chão é `--sb-ground` (`#f4f5fa`) no `<main>`, medido na tela em dez
rotas. O que resta é ajuste fino, e agora isso é literal.

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

### O que faltava para o cinza — e o veredito de cada item quando o passo foi dado

✅ **O passo cinza FOI DADO em D-285.** A lista abaixo é de 2026-09-03 e foi
conferida item a item antes de executar: **três eram registro envelhecido, um
estava errado, e quatro eram verdade.** O veredito está em cada um; o texto
original fica porque a lista é o que tornou a troca uma linha só.

1. ✅ **VERDADE, resolvido com `--sb-ground`.** **`--sb-surface` significa duas coisas.** É o fundo do `body` **e** o token
   de "cartão branco" em 15 lugares. Repontá-lo para cinza pintaria de cinza a
   camada flutuante inteira — o dropdown da navegação, a paleta `Ctrl+K`, os
   toasts, a barra sticky da curadoria — que é justamente a camada cuja única
   função é parecer *acima*. **O cinza precisa de token próprio (`--sb-ground`),
   e `--sb-surface` continua branco.** É violação de "um dado, um dono"
   (D-224) que só a coincidência de ambos serem brancos escondia.
2. ✅ **VERDADE, e foi a linha final.** **Pintar o `<main>`, não o `body`.** O `<header>` é irmão do `<main>`: com o
   `body` cinza ele vai junto em 46 telas; com o `<main>` cinza ele fica branco
   de graça. E `app/login/page.tsx`, a única tela fora do Shell, fica intocada.
   D2 já pôs o `background` no `<main>` — trocar o token ali é a linha final.
3. ⬜ **NÃO SE APLICA MAIS** — as pílulas vivem em tabelas, e `table { background: var(--sb-surface) }` (o passo branco de D2) as mantém em cartão branco; só **uma** `.sb-table` está fora de painel, e ela também é branca. **`status-pill.tsx` não tem borda: o fundo *é* a forma da pílula.** Sobre o
   cinza, `warn` (`#fff8dc`) fica **mais claro que o chão** e inverte, a
   1,02:1; `ok` e `bad` perdem 68% e 59% da separação. E elas vivem em tabelas
   que ficam direto no chão. **O cinza destruiria as pílulas que D1 consertou**
   se as tabelas já não fossem brancas — por isso a regra da tabela veio antes.
4. ⬜ **NÃO SE APLICA** — as 15 ocorrências vivem DENTRO de cartão (cabeçalho de tabela, hover, bloco de decisão de `/acoes`); sobre branco ele recua e nunca encosta no chão. **`--sb-bg-soft` (`#f8f9fc`) colide com o cinza e é mais claro que ele.** As
   linhas de apoio de `/acoes` inverteriam de recuo para destaque, a 1,03:1.
   Precisa ser reescolhido contra o novo chão.
5. ✅ **VERDADE, e por um fio: 4,5007:1.** Passa AA por sete milésimos, e por isso a tinta escureceu para `#6f6883` (4,84 no chão). **Toda razão de contraste cai 8,2% de uma vez.** `--sb-muted-ink` (`#746d88`)
   vai de 4,90 para **4,499** — abaixo de AA, em ~30 lugares. A escolha de D1
   mirou 4,50 sobre o cinza e ficou de fora por arredondamento; ou escurece, ou
   o texto passa a viver dentro de cartão branco.
6. ⬜ **JÁ ESTAVA CONSERTADO** — a série usa `--sb-muted-ink` desde D6, não `--sb-muted`; o registro envelheceu. **A série de comparação do gráfico de `/vendas` já reprova hoje.** A
   tracejada do período anterior é `--sb-muted` a **1,68:1**, contra os 3:1 que
   a WCAG 1.4.11 pede de objeto gráfico que carrega informação. O cinza leva a
   1,54:1. É defeito existente, e é achado próprio desta fatia.
7. ✅ **VERDADE** — `color-scheme: light` entrou no `:root`, e os `background: "transparent"` caíram de 31 para 3 (A5 comeu o resto). **~90 controles nativos.** Não há `color-scheme` em lugar nenhum: o
   navegador pinta os campos de branco, e os 31 `background: "transparent"`
   explícitos ficariam cinza — dois tipos de campo, duas cores, às vezes na
   mesma célula.
8. ❌ **ERRADO, e a correção é a parte boa: NÃO ligou sozinho.** A lista mora dentro de um `.sb-panel` branco, então o `transparent` da linha lida mostrava o PAINEL, não o chão — os dois ramos continuaram brancos. A lida passou a apontar para `--sb-ground` e o realce apareceu na tela pela primeira vez. **Uma dívida que o cinza *paga*:** `app/notificacoes/notification-row.tsx:70`
   distingue lida de não-lida com `--sb-surface` vs `transparent`. Os dois
   ramos rendem branco hoje — **o realce existe no código e nunca apareceu na
   tela.** Com o chão separado, liga sozinho.

**Ausências verificadas** (procuradas e inexistentes, então não são risco):
nenhum gradiente, `@media print`, `color-scheme`, `::-webkit-scrollbar`,
`<canvas>`, `<img>`/`next/image`, diretório `public/`, logo ou SVG com fundo
branco embutido.

---

## Componentes reais reutilizáveis

| Componente | Caminho | Situação (auditoria de 2026-09-04) |
|---|---|---|
| Shell (sidebar + grupos + topbar) | `components/shell.tsx`, `nav.tsx` | **camada nova**, refeita pelo frame; trilho de 58px em ≤850 desde A1 |
| `PageTitle`, `Panel`, `KpiStrip`, `ObjectHeader` | `components/*.tsx` | **camada nova** — `.page-title`, `.panel`, `.kpi-strip`/`.ops-metrics`, Object Header do Figma |
| `FilterMenu` | `components/filter-menu.tsx` | **novo em A1** — o `.button.ghost ⌄` com dropdown; substituiu dez cópias de `<details class="sb-menu">` |
| `tone.ts` (`TOM`, `tomDeStatus`) | `components/tone.ts` | **dono único** dos cinco tons do `.status`; `StatusPill`, `StatePill`, `KpiStrip`, `ObjectHeader` e a Home leem daqui (eram cinco mapas) |
| `StatusPill` (código do banco → tom) | `components/status-pill.tsx` | alinhado — `.sb-status` + `tone.ts` |
| `StatePill` (vocabulário da tela → tom) | `components/state-pill.tsx` | alinhado — era cápsula de contorno; virou o mesmo chip |
| `.sb-table`, `.sb-input`, `.sb-empty`, `.sb-menu`, `.sb-modal`, `.sb-backdrop`, `.sb-close` | `app/globals.css` | as formas únicas de tabela, campo, vazio, menu e camada flutuante; **adotar ao migrar cada tela** |
| `Drawer` + `DetailRow` + `.sb-drawer` | `components/drawer.tsx`, `app/globals.css` | **novo em D38, com CINCO consumidores desde D39** — a moldura das gavetas do frame (sobrancelha + fechar, corpo que rola, ações no rodapé), `DetailRow` para a linha de fato e `.sb-text-button` para o gatilho. **Renderiza por portal**: dentro da célula que a dispara, ela herdava a fonte mono (D-281). As gavetas vivem em `app/<rota>/inspecao*.tsx` — cada uma lê o que a lista dela não carrega |
| `TrendBadge` | `components/trend-badge.tsx` | alinhado (texto, não chip) |
| `SavedFilters` | `components/saved-filters.tsx` | alinhado em A2 — `.sb-menu` para as visões e `.sb-modal` para nomear (o `window.prompt` saiu) |
| `CommandPalette` | `components/command-palette.tsx` | alinhado em A2 — `.sb-command` (520px a 16vh, cabeçalho, ✕, `ESC`, resultados agrupados por tipo) |
| `FilterPill` | `components/filter-pill.tsx` | **legado** — 8 telas não migradas ainda o usam; some quando a fila D13+ fechar |
| ~~`th`/`td`/`tdNumber`/`cardStyle`~~ | ~~`components/table-styles.ts`~~ | **NÃO EXISTE MAIS** — apagado em D35 (D-275), quando os dois últimos consumidores migraram. A linha anterior aqui ainda o dava como legado vivo; conferido em D38, o arquivo não está no repositório |

**Não criar `Card`, `CardV2`, `FigmaCard`.** Adaptar o que existe.

---

## Diferenças intencionais (NÃO APLICAR)

| Figma | Motivo | Fonte |
|---|---|---|
| "Margem" como tela própria | margem é seção de `/vendas`, e sai NULL sob recorte de marca | D-166, D-237 |
| Ads / ROAS / investimento; tela "Insights" | sem integração Mercado Ads aprovada; impressões não existem | ROADMAP (C) |
| Seis telas de Atendimento (Perguntas, Mensagens, Reclamações, Devoluções, Mediações) | devem ser **filtros da mesma Caixa de Entrada**, não seis sistemas — nem como itens de menu | brief D28 do usuário |
| Aba Atendimento no SKU | não existe vínculo confiável SKU → `support_case` | D-084, D-224 |
| Aba Tráfego no SKU | visita é medida por `item_id`; o dono é o Dashboard do Anúncio | D-224 |
| "Enviar X unidades ao Full" | sem política logística defensável | auditoria corretiva do próprio Figma, item 6 |
| Receita líquida | nome vetado; existe margem operacional observada | METRICS 5C.1 |
| Variação percentual entre períodos | `variacao_percentual_periodo` está pendente em METRICS 5.4, e D-023 proíbe número sintetizado sem `metric_definitions` — a célula mostra os dois valores | D-023 |
| "Faturamento hoje" na Home | `/vendas` já tem o bloco "Hoje" com o aviso de dia parcial; repetir seria dois donos do mesmo dado | D-224 |
| "Estoque Full baixo — cobertura < 7 dias" na Home | cobertura de Full não é calculada (só a local, `get_stock_coverage`); número inventado | D-067 |
| **A quinta célula da faixa da Home** ("Estoque em risco · 19 SKUs") | seria o **mesmo escalar com outro nome a um scroll de distância**: `em_ruptura` já é impresso acima, no cartão "SKUs sem saldo local", **com o mesmo destino `/reposicao`**. E a delta "− 3 hoje" do frame não tem fonte — `get_stock_coverage_summary` é agregado do instante, sem série | D-311, D-224 |
| **O segundo cartão CRÍTICO da Home** ("Reclamações críticas · 3 casos próximos do SLA") | a lacuna é real (a Home não tem sinal de prazo), mas ler `get_support_metrics` faria o cartão e o link discordarem: a função conta **linhas** de `support_case_deadlines` e **exclui vencido**, e `/atendimento?prazo=risco` conta **casos** e **inclui vencido**. A forma defensável é a de D-242/D-243 — a MESMA consulta do link, em `head count`, dentro do `Promise.all` que já existe | D-311 |
| **Seletor global de conta** no rodapé da sidebar (modal "Definir escopo da aplicação") | a V3 recorta por conta **tela a tela** (menu "Todas as contas ▾" em `/vendas`, `/anuncios`…), com o recorte na URL — compartilhável e com voltar; um escopo global em cookie quebraria isso. O bloco mostra a organização e as contas conectadas (dado real) e leva a `/contas`. **O motivo anterior ("não há segunda organização") respondia a uma pergunta que o frame não faz** — corrigido na auditoria | A1 |
| **Inbox de TRÊS COLUNAS em `/atendimento`** (fila 300px + conversa + contexto do cliente 320px) | **medido antes de recusar** (D-286): o CENTRO fica vazio em **50,7% das reclamações** (960 de 1.895 chegam do ML sem uma mensagem sequer, e reclamação é 63% da base); a DIREITA não tem fonte (sem nome — `customer_external_id` é número, D-083 —, sem miniatura, sem Copiloto com contexto, e **92,6% dos clientes têm um caso só**); e a ESQUERDA seria regressão — a fila de 300px não cabe a triagem inline, e com **939 casos em NOVO e ZERO assumidos** o gargalo medido é a triagem, não a conversa | D-286 |
| Central de Ajuda | não existe conteúdo de ajuda | — |
| Menu de perfil (dropdown) | esconderia o "Sair" atrás de um dropdown que não foi desenhado | — |
| Botão flutuante do Copiloto (drawer contextual) | Copiloto é rota, e está no menu — um segundo Copiloto é escopo vetado | — |
| Logo em imagem na marca | o export traz uma captura de tela, não o asset da marca; sem `public/` nem logo por organização. Entra quando existir asset oficial | — |
| Botão de recolher a sidebar (`.collapse`) | o trilho de 58px existe em ≤850 (A1); recolher por clique em tela larga é estado de cliente sem frame de "recolhida" — fila A2 | — |
| ~~Drawer "Inspeção Rápida" (produtos)~~ | **entregue em D38** (D-281) — a linha continua levando ao dashboard completo, e a gaveta também | — |
| ~~`MlbDetailDrawer` e as outras três~~ | **entregues em D39** (D-282). O que ficou de fora são as ABAS que o frame desenha dentro de duas delas — oito no anúncio, cinco no fornecedor: elas são as telas cheias que já existem (D13, D-174), e reproduzi-las na gaveta seria a segunda implementação da mesma interface | — |
| Nome do comprador, logística e timeline da transportadora na gaveta do pedido | conferido em `\d`: `orders` guarda `buyer_id` (um número) e `shipping_id`, e não há tabela de envio nem de comprador. O que existe é o registro de EXCEÇÕES em `domain_events` | D-282 |
| "Saúde do Anúncio" (Full ativo · competitividade de preço · qualidade das fotos) | dos três sinais só o Full tem fonte — concorrência não é coletada e qualidade de foto não existe no esquema. Um bloco com um sinal de três não é o bloco do frame | D-282 |
| Célula "Com queda" e coluna "Saúde" em Anúncios | sem detecção de anomalia por anúncio e sem definição canônica de "saúde" | D-023 |
| Ação "Novo anúncio" | a V3 não cria anúncio no Mercado Livre — escrita no ML é ato com aprovação humana | escopo e segurança |

### Desvios registrados, no formato curto

> **Superfície:** `/skus/[id]`, abas que não a Visão geral · **Figma:** o frame
> mostra *"Conteúdo da aba em construção"* para todas · **V3 real:** conteúdo
> completo · **Decisão:** aplicar o **design system** (rótulo de seção, cartão
> de indicador, painel), não inventar um frame · **Motivo:** escopo — o Figma
> não desenhou essas abas, e o Design Contract é o que resolve componentes
> recorrentes quando o frame não fala.

> ~~**Superfície:** Figma tem um **drawer de "Inspeção Rápida"** disparado da
> tabela de produtos · **V3 real:** não existe · **Decisão:** adiar~~ —
> **ENTREGUE em D38** (D-281), quando a fila de migração fechou, como o próprio
> adiamento previa. O que sobrou de diferença está abaixo.

> **Superfície:** `/atendimento` · **Figma:** inbox de três colunas numa tela só
> — fila, conversa e contexto do cliente · **V3 real:** lista tabular com
> triagem inline + `/atendimento/[caseId]` · **Decisão:** manter as duas rotas,
> e fazer o RECORTE viajar com o caso (`?volta=`) · **Motivo:** dado inexistente
> na terceira coluna, centro vazio em metade das reclamações, e a fila estreita
> custaria a triagem — que é o gargalo medido (D-286). O que o desenho de três
> colunas realmente protege é não perder a fila ao responder, e isso custou um
> parâmetro.

> **Superfície:** `/produtos`, gatilho da Inspeção Rápida · **Figma:** o clique
> na CÉLULA do produto abre a gaveta, e não há link para a página cheia — ela é
> o botão do rodapé · **V3 real:** o título continua `<Link>` e a gaveta tem
> gatilho próprio ("Inspecionar") · **Decisão:** manter os dois ·
> **Motivo:** regra funcional — link é comportamento (nova aba, teclado,
> meio-clique), não aparência, e trocá-lo por `onClick` perderia navegação real
> para ganhar semelhança.

> **Superfície:** `/anuncios`, faixa de resumo · **Figma:** seis células —
> Ativos, Pausados, Sem estoque, No Full, Sem vínculo, **Com queda** ·
> **V3 real:** mede **cinco** — "No Full" entrou em A1 (D-243): o snapshot de
> Full (`fulfillment_stock_snapshots`) carrega `item_id`, o MLB, e a RPC passou
> a devolver `full_quantity` por anúncio (último snapshot por `inventory_id` nos
> últimos 3 dias — a definição canônica de D-173/D-204) e a filtrar por `p_full`. **O desvio
> anterior dizia que Full era grão de SKU — estava errado**, e a auditoria de
> fidelidade o pegou conferindo o schema. "Com queda" continua de fora: não há
> detecção por anúncio nem entrada em `metric_definitions` · **Decisão:** seis
> células — Total na âncora, Ativos, Pausados, Sem estoque, No Full, Sem vínculo ·
> **Motivo:** métrica canônica (D-023) para "queda"; Full agora é medido no grão
> certo.

> **Superfície:** `/anuncios`, tabela · **Figma:** colunas **Full** e **Saúde**
> ("Em risco", "Saudável") · **V3 real:** Full por anúncio existe (D-243);
> "saúde" de anúncio não existe como veredito · **Decisão:** a coluna Full entra
> (NULA sem snapshot vira "—", nunca "0"); "Saúde" sai; entram Visitas e Obs., que
> o frame não tem e a V3 mede; "Sincronizado em" vira `title` da célula do
> anúncio · **Motivo:** regra funcional — a conversão só é honesta ao lado dos
> dias observados (D-123), e um selo "Em risco" sem regra por trás é o oposto do
> que esta frente persegue.

> **Superfície:** `/anuncios`, filtros · **Figma:** o cabeçalho tem "Filtros ⌄" e
> a ação primária; **Status** e **Com estoque** ficam na barra do painel ·
> **V3 real:** tinha seis controles no cabeçalho · **Decisão:** cabeçalho com
> Conta, Vínculo e busca; barra do painel com Estado, Estoque, Full e a
> paginação · **Motivo:** composição do frame — o cabeçalho recorta *o que se
> olha*, a barra recorta *o estado da tabela*.

> **Superfície:** `/vendas`, blocos · **Figma:** três blocos — faixa, gráfico,
> tabela "Produtos que mais contribuíram" · **V3 real:** tem mais três (Hoje,
> métricas secundárias, Margem), todos com dado real e dono · **Decisão:** os
> três do frame primeiro, na ordem do frame, com a faixa âncora na composição dele
> (Receita bruta · Taxas ML · Unidades · Taxa de cancelamento · Pedidos); os blocos
> reais vêm DEPOIS, e "Cancelamentos e taxas" virou a faixa secundária "Mais
> sobre o período" · **Motivo:** conteúdo real preservado, apresentação do
> Figma. A tabela que faltava ganhou RPC própria (`get_sales_top_skus`, D-244).

> **Superfície:** `/vendas` e Home, estado "nunca calculado" · **Figma:** faixa e
> gráfico incondicionais · **V3 real:** trocava a composição inteira por um
> parágrafo · **Decisão:** a composição fica; as células mostram "—" com a
> ressalva e o painel do gráfico mostra o vazio honesto · **Motivo:** D-023
> continua valendo (nada vira zero) e a tela passa a ser reconhecível em qualquer
> estado.

> **Superfície:** `/produtos` · **Figma:** cabeçalho → cartão, sem faixa no meio;
> barra de lote com "Selecionar Todos", contagem e DUAS ações agrupadas; tabela
> de 5 colunas com "Anúncios" · **V3 real:** tinha uma faixa "Retrato do ERP"
> inventada, sete controles na barra e nenhuma coluna de anúncios · **Decisão:**
> faixa removida (as contagens moram no cabeçalho do cartão, onde o frame põe
> "N resultados"); barra com "Classificar estoque ⌄" + campo/botões de marca;
> coluna Anúncios com dado real (D-245: vínculo direto OU por variação, a
> definição de D-122); as colunas extras da V3 (Categoria, Saldo, Vendas 90d,
> Sugestão) ficam, porque a decisão se toma olhando saldo × venda · **Motivo:**
> composição do frame + regra funcional.

> **Superfície:** `/skus/[id]`, cabeçalho · **Figma:** cabeçalho de página
> ("CATÁLOGO / DETALHE DO PRODUTO" + "Detalhe do SKU") acima do cartão de
> entidade; ações "Risco de Ruptura !" (perigo) e "Ações ⌄" (primário); selos
> Ativo · **Curva A** · marca · **V3 real:** abria direto no cartão, com "←
> Estoque" como única ação · **Decisão:** cabeçalho de página + cartão (nome do
> produto vira `h2`); "Risco de ruptura" só quando a cobertura diz ruptura;
> "Ações ⌄" com as ações reais (ajustar estoque, registrar decisão, ver
> cobertura, voltar); o selo de curva ABC entrou em A2 (`get_sku_abc_curve`
> ganhou `p_sku_id`, D-247) · **Motivo:** composição do frame; o estado como ação
> só quando é medido.

> **Superfície:** Home, painel de atenção · **Figma:** só as situações
> DETECTADAS viram cartão, com frase de impacto em negrito e botão de largura
> total; 4 colunas · **V3 real:** seis cartões fixos, quatro deles "LIMPO 0" ·
> **Decisão:** a grade só com o que pede atenção (ou falhou — "não sei" é mais
> urgente); os medidos-e-limpos numa linha compacta com o zero visível; frase de
> impacto com a contagem dentro; CTA como botão (primário no crítico); entra o
> cartão "Anúncios pausados" (com estoque — dado real de `/anuncios`) ·
> **Motivo:** composição do frame; D-067 (o zero medido continua visível).

> **Superfície:** shell, ≤850px · **Figma:** trilho de 58px só com o item ativo ·
> **V3 real:** empilhava a sidebar sobre o conteúdo · **Decisão:** o trilho, em
> CSS puro — os glifos existem desde R1 (o motivo registrado para adiar, "o app
> não tem ícone", tinha caducado) · **Motivo:** composição do frame.

> **Superfície:** `/anuncios/[itemId]` · **Figma:** o anúncio é um **drawer**
> de 600px (`MlbDetailDrawer`) · **V3 real:** é uma ROTA desde D-168, linkada
> pela lista, pelo SKU e pelas notificações · **Decisão:** continua página, com a
> COMPOSIÇÃO do drawer (cabeçalho de entidade + as oito abas) · **Motivo:** no
> protótipo o anúncio não tem URL — o drawer nasce de `useState`, e é essa a
> razão de ele ser drawer. O próprio frame comenta o bloco como *"Operational
> Object Header"*, o mesmo da tela de SKU.

> **Superfície:** `/anuncios/[itemId]`, cabeçalho · **Figma:** miniatura 80×80,
> **"Tipo: Premium"** e **"Catálogo: Vencedor"** · **V3 real:** `listings` tem 14
> colunas e nenhuma é tipo de anúncio, catálogo ou imagem · **Decisão:** os três
> ficam de fora · **Motivo:** dado inexistente — reconferido no esquema em D-310.

> **Superfície:** `/anuncios/[itemId]`, a FILEIRA de fatos do cabeçalho ·
> **Figma:** três células separadas por fio — Preço · Tipo · Catálogo ·
> **V3 real:** duas — **Preço atual** e **Disponível (este anúncio)** ·
> **Decisão:** a composição do frame com os fatos que existem (D-310) ·
> **Motivo:** Tipo e Catálogo não têm coluna; `price` e `available_quantity` são
> NOT NULL, já vinham no `select` e **não eram impressos em nenhuma das oito
> abas**. Os rótulos são qualificados porque a tela mostra três saldos de
> origens diferentes e uma aba chamada "Preço".

> **Superfície:** `/anuncios/[itemId]`, Visão geral · **Figma:** faixa **"Exposição
> em Risco"** com botão "Repor Full", e painel **"Saúde do Anúncio"**
> (competitividade de preço, qualidade das fotos) · **V3 real:** nenhuma das três
> tem fonte; a faixa ainda encadeia catálogo e Full numa relação causal ·
> **Decisão:** os quatro cartões medidos ficam, a faixa e o painel saem; do que
> era "saúde" sobra o Full, que é medido e tem painel próprio · **Motivo:**
> métrica canônica (D-023) e a regra da própria tela — história, nunca causa.

> **Superfície:** `/anuncios/[itemId]` · **Figma:** botão **"Republicar anúncio"**
> no cabeçalho e o `RepublicationModal`, um assistente de cinco passos cujo passo
> 2 EXECUTA · **V3 real:** os dois atos existem desde **D-295** — o pedido, que
> roda a conferência prévia e não fecha nada, e a execução, que fecha o anúncio
> pai e é irreversível —, e moram no painel "Republicações" da aba Histórico ·
> **Decisão:** o cabeçalho leva ao painel com **"Republicações →"** (D-310), o
> nome do que ele abre; o ato fica onde está · **Motivo:** o rótulo do frame
> prometeria a quem não tem papel (ADMIN/GESTOR) um ato que o servidor recusa, e
> decidir o rótulo pelo papel custaria uma leitura nas oito abas. Caminho no
> cabeçalho, ato no painel, um lugar só de escrita. O assistente de cinco passos
> segue fora: o preflight do frame mostra Full e Catálogo como aviso, e no código
> os dois são BLOQUEIO.
>
> ⚠️ Este desvio dizia *"nenhum caminho de UI dispara — o e2e afirma a ausência
> do botão"*, e era **falso desde D-295**. Ficou aqui cinco fatias porque
> ninguém releu o registro ao entregar a feature que o contradizia.

> **Superfície:** `/anuncios/[itemId]`, aba Diagnóstico · **Figma:** não desenha ·
> **V3 real:** o diagnóstico de venda anômala usa a baseline do SKU; não existe
> baseline por anúncio · **Decisão:** a aba RECUSA e explica, levando ao
> diagnóstico do SKU vinculado · **Motivo:** D-023 — a mesma fórmula sobre outro
> grão é outro número com a mesma cara.

> **Superfície:** `/anuncios`, cabeçalho · **Figma:** ação **"Novo anúncio"** ·
> **V3 real:** a V3 não cria anúncio no Mercado Livre — o catálogo é lido, e
> escrita no ML é ato com aprovação humana · **Decisão:** sem ação no cabeçalho ·
> **Motivo:** escopo aprovado e segurança.

> **Superfície:** `/anuncios`, células "ver lista" · **Figma:** chip `<Status>`
> decorativo · **V3 real:** — · **Decisão:** o chip é um **link** para o recorte
> que produziu o número, e o número vem do `total_count` da MESMA função que
> monta a lista · **Motivo:** "um dado, um dono" (D-224) — contagem e lista não
> podem divergir se são a mesma consulta.



> **Superfície:** `/skus/[id]`, aba Visão geral · **Figma:** cartão "Estoque
> Total 32 un · 29 Local · 3 Full" · **V3 real:** "Estoque local 50 · 0
> reservado · 0 em trânsito · 0 no Full" · **Decisão:** consolidar os quatro
> cartões num só, mas **sem somar** · **Motivo:** métrica canônica — a soma de
> Local + Reservado + Trânsito + Full é um agregado que o sistema não define, e
> agregado sem definição não entra. Nenhum dos quatro números sumiu.

> **Superfície:** `/skus/[id]`, aba Visão geral · **Figma:** cada indicador tem
> uma variação ("↗ +12%", "Margem: 32%") · **V3 real:** a nota diz o que o
> número é · **Decisão:** trocar o conteúdo, manter a linha · **Motivo:**
> D-023 — variação percentual não tem definição em `metric_definitions`, e
> margem por SKU não é observada (a margem existe por PEDIDO, D-166).



> **Superfície:** `/skus/[id]` · **Figma:** abas incluem TRÁFEGO e ATENDIMENTO ·
> **V3 real:** nove abas, sem essas duas · **Decisão:** manter as nove ·
> **Motivo:** regra funcional — visita é medida por `item_id` e o dono é o
> Dashboard do Anúncio (D-224); e não existe vínculo confiável SKU →
> `support_case` (D-084). É também a ordem que o usuário aprovou.

> **Superfície:** `/skus/[id]` · **Figma:** miniatura de 64px com a imagem do
> produto e um botão primário "Ações ⌄" · **V3 real:** sem miniatura, e a única
> ação é voltar para Estoque · **Decisão:** omitir os dois · **Motivo:** dado
> inexistente (`image_url` existe na tabela mas nenhuma tela do app carrega
> imagem — não há `public/`, nem `<img>`) e escopo (não existe menu de ações de
> SKU; inventá-lo seria inventar produto).



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
| **—** | **O passo cinza (`--sb-ground` no `<main>`)** | **CONCLUÍDO em D-285** — chão `#f4f5fa` medido na tela; três dos oito pré-requisitos eram registro envelhecido e um estava errado |
| D3 | Moldura: sidebar vertical, grupos e seção atual | **CONCLUÍDO** · refeita pelo frame |
| D4 | Home orientada à atenção | **CONCLUÍDO** · composição refeita em R3 e A1 |
| D5 | Vendas — gráfico (seção 12 do brief) | **CONCLUÍDO** |
| D6 | Vendas — composição, refeita a partir do Figma | **CONCLUÍDO** · reordenada em A1 |
| R1 | Retrabalho da moldura, pelo **frame** do Figma | **CONCLUÍDO** |
| R2 | Sistema tipográfico e densidade (Inter + DM Mono) | **CONCLUÍDO** |
| R3 | Home, refeita pelo frame do Figma | **CONCLUÍDO** |
| D7 | Produtos | **CONCLUÍDO** · composição corrigida em A1 |
| D8–D11 | Dashboard de SKU (fundação + nove abas) | **CONCLUÍDO** · cabeçalho, tabelas e abas corrigidos em A1 |
| D12 | Anúncios — faixa de estados + painel, pelo frame `Listings` | **CONCLUÍDO** · Full por anúncio em A1 |
| **A1** | **Auditoria de fidelidade Figma × V3** + correções P0/P1 nas superfícies migradas + dead code pass | **CONCLUÍDO** |
| **A2** | **Acabamento das superfícies migradas** (paleta Ctrl+K, `.sb-modal`, selo Curva ABC, chips na aba Full, custo como cartão) | **CONCLUÍDO** |
| **D13** | **Dashboard do Anúncio** (`/anuncios/[itemId]`) — cabeçalho de entidade + as oito abas do frame | **CONCLUÍDO** |
| D14 | **Estoque** — `PageTitle` + `KpiStrip` + `Panel` + `.sb-table`; três das seis células do frame recusadas por medição (D-249) | ✔ |
| D15 | **Reposição** (`/reposicao`) — sete cartões de estado em vez dos cinco do frame, e o filtro que eles prometem (D-250). ⚠️ **`/cobertura` NÃO foi migrada**: o frame trata as duas como uma tela com abas, e unificá-las é composição, não acabamento (D-261) | parcial |
| D16 | **Curva ABC** — três cartões de classe com soma no banco; dois filtros rápidos devolvidos ao dono deles (D-251) | ✔ |
| D17 | **Movimentações** — KPIs que CONTAM linha; somar unidade daria milhões falsos (D-252) | ✔ |
| D18 | **NF-e / Entradas** — `PageTitle` + `Panel` + `.sb-table`, e **sem faixa de KPIs**: o frame desta variação é um esboço, não um desenho (D-253) | ✔ |
| D19 | **Compras** — `PageTitle` + `Panel` + `.sb-table` + RPC `get_purchase_orders`; duas colunas do frame não eram colunas, e o seed passou a existir (D-255) | ✔ |
| D20 | **Fornecedores** — mesmo esboço da `nfe`; a linha de apoio do frame prometia lead time por fornecedor, que não existe no modelo (D-256) | ✔ |
| D20b | **Fornecedores, 2ª metade** — "último pedido" e "valor comprado" pela RPC `get_suppliers`, e o `coalesce(sum,0)` que eu reintroduzi na função criada para tirá-lo (D-258) | ✔ |
| D21 | **Vinculações → Integridade de Catálogo** — a tela mudou de assunto, e as duas fontes de "vendeu" divergem em 12 (D-259) | ✔ |
| D22 | **Diagnóstico** — primeira tela mestre-detalhe da frente; o "91%" do frame não tem fonte e virou o z-score (D-260) | ✔ |
| D23 | **Central de Ações** — frame `IntelligenceScreen`, não `ProcessScreen`: painel de filtros lateral + fila em cartões. A tela escondia 449 ações chamando isso de total (D-263) | ✔ |
| D24 | **Histórico de Preços** — "Alterações" e "Preços" da fila eram a MESMA tela. A recusa é uma promessa com prazo, não um número (D-264) | ✔ |
| D25 | **Central Full** — o frame particiona errado: os três cartões dele somam o total e escondem o MAIOR estado, 41% do conjunto (D-265) | ✔ |
| ~~D26~~ | ~~**Tráfego**~~ — **RECUSADA COM MEDIÇÃO** (D-266): zero colunas de impressão/Ads/reputação no schema inteiro; o funil do frame perde o topo e os dois cartões de sinais não têm fonte. O que sobra já vive em `/anuncios` | ✖ |
| D27 | **Caixa de Entrada** — a recusa é uma AFIRMAÇÃO SOBRE A ORDEM: o frame diz "fila priorizada por prazo, risco e cliente" e ela ordena por atividade (D-267) | ✔ |
| D28 | **Base de Conhecimento** — base VAZIA no Dev, mas o esquema sustenta o frame inteiro: falta DADO, não coluna (D-268) | ✔ |
| D29 | **Central de Notificações** — o painel de detalhe do frame repete a linha e inventa um "Impacto estimado" que não tem coluna (D-269) | ✔ |
| D30 | **Sugestões** — o MESMO mestre-detalhe que D29 recusou, aqui entra: nove campos estruturados contra três repetidos (D-270) | ✔ |
| D31 | **Usuários** — três das cinco colunas e um dos cinco cartões do frame não têm fonte; e a tela tinha um DEFEITO VIVO da classe de D-234, justamente onde se cadastra o segundo usuário (D-271) | ✔ |
| D32 | **Integrações** — o frame nomeia Bling e Google Sheets, que têm ZERO ocorrências no repositório; e um selo por cartão desfaria a separação em três dimensões que criou a tela (D-272) | ✔ |
| D33 | **Sincronização** — um dos oito recursos não tinha nome nem veredito, e era o de PIOR taxa de falha; o defeito estava escrito como fixture num teste verde (D-273) | ✔ |
| D34 | **Saúde do Sistema** — o "99,97% de uptime" do frame não tem UMA tabela que o sustente; a âncora navy ganhou a pergunta que a tela nasceu para responder (D-274) | ✔ |
| D35 | **Configurações** — os dois interruptores do frame não têm onde gravar, e interruptor mente PIOR que número: um é lido, o outro é acionado. `table-styles.ts` apagado (D-275) | ✔ |
| D36 | **Copiloto** — a fila pedia uma TELA, e o frame tem uma gaveta; 11 das 12 perguntas que ela sugere não têm como ser respondidas (D-276) | ✔ |
| D37a | **As tres telas de DETALHE** (`/notas-fiscais/[id]`, `/compras/[id]`, `/fornecedores/[supplierId]`) — listas migradas, detalhes antigos; `ProcessSteps` extraido no segundo consumidor (D-277) | ✔ |
| D37b | **Importador do UpSeller** (lista, conferência, envio) + varrimento de `PageTitle` em 8 telas; o denominador da aplicação é `ok_rows`, e medir contra o total inventaria 14% de falha (D-278) | ✔ |
| D37c | **`/cobertura`, `/atendimento/[caseId]` e a tabela de `/compras/novo`** — o passe FECHOU: nenhuma tabela sem `.sb-table`, e só `/login` sem `PageTitle` (D-279) | ✔ |
| **D38** | **A GAVETA** — `.sb-drawer` no design system + a primeira das cinco do frame ("Inspeção Rápida" em `/produtos`). Quatro fontes que já eram donas dos números; o "12 anúncios em risco" do frame não tem detecção por anúncio e saiu. Dois defeitos que só o render pegou: herança de fonte (corrigida com portal) e ordem de cascata (D-281) | ✔ |
| **D39** | **AS QUATRO GAVETAS RESTANTES** — anúncio, fornecedor, usuário e pedido. A regra que decidiu as quatro de uma vez: a gaveta RESUME e leva à tela, então as abas do frame não entram. A do pedido é superfície NOVA (não existe tela de pedido de venda); o seed passou a criar um. Dois achados fora da fatia: link morto para `/anuncios/[itemId]` no Atendimento e o segundo mapa de tom prestes a nascer (D-282) | ✔ |

## Auditoria de Fidelidade Figma

Feita em 2026-09-04 (A1), **renderizando** cada superfície migrada (screenshots a
1440, 1100 e 850) e lendo o frame correspondente no export — nove leituras
independentes, cada achado com evidência dos dois lados (`App.tsx:linha` e
arquivo:linha da V3). A pergunta de controle em cada uma: *parece o Figma, ou
parece a aplicação antiga com o tema do Figma?*

| Superfície | Fidelidade antes → depois | Status | Diferença principal que restou | Código legado |
|---|---:|---|---|---|
| Shell (sidebar, topbar, busca) | 78% → 86% → **91%** (A2) | ALINHADO | sem botão de recolher em tela larga; logo em texto | nav horizontal antiga: **removida** (não existia mais consumidor); paleta refeita pelo `.command` |
| Design system (tokens, componentes) | 70% → 80% → **88%** (A2) | ALINHADO | ~~falta `.sb-drawer`~~ — **nasceu em D38** (D-281), com `.sb-detail-row` e `.sb-text-button`; `table-styles.ts` foi apagado em D-275 | cinco mapas de tom → **um** (`tone.ts`); `StatePill` cápsula → chip; `.sb-modal`/`.sb-command` nasceram; `table-styles.ts` MERGE pendente (2 consumidores não migrados) |
| Home | 78% → **87%** | ALINHADO | seletor "14 dias ⌄" do gráfico; hora relativa no feed | `TOM` local **removido**; `.sb-attention-value` **removida** |
| Vendas | 70% → 85% → **88%** (A2) | ALINHADO | legenda do gráfico no rodapé (frame põe no cabeçalho); altura do SVG proporcional | `FILTER_DATE_STYLE` **removido**; 3 menus → `FilterMenu`; "Cancelamentos e taxas" **dissolvido**; `SavedFilters` no design system |
| Produtos | 68% → 83% → **90%** (D38) | ALINHADO | botão "Buscar" visível (frame submete por Enter) — a gaveta "Inspeção Rápida" **entrou em D38** | consts `th`/`td` **removidos**; faixa inventada **removida**; 3 menus → `FilterMenu` |
| SKU — Visão geral, Vendas, Estoque | 78% → 85% → **89%** (A2) | ALINHADO | tom "abaixo do lead time" na cobertura | `statBox`/`th`/`td`/`tdNumber`/`SalesMetricCard` **removidos** (7 tabelas em `.sb-table`); selo Curva ABC entrou (D-247) |
| SKU — Anúncios, Preços, Full, Histórico, Diagnóstico, Decisões | 62% → 78% → **86%** (A2) | ALINHADO | ressalvas longas nos corpos de alguns painéis | `buttonStyle`/`cardStyle` do diagnóstico **removidos**; chips na aba Full e cartões no Histórico entraram |
| Anúncios (lista) | 72% → **86%** | ALINHADO | drawer `MlbDetailDrawer` (adiado); chip "ver lista" em sans (frame usa mono) | rodapé de metodologia **removido** (mora no `title` dos cabeçalhos); 4 menus → `FilterMenu` |
| Anúncio (detalhe) | — → **84%** (D13) | ALINHADO | miniatura do frame (sem coluna de imagem); `listing_relist_events` ainda não lido | `<h1>/<h2>` e consts `th`/`td` inline **removidos**; `SummaryCard` local **removido** |

**Três achados que não eram de design.** (1) O seed nunca criou métricas de
conta: `/vendas` e a Home renderizavam "nunca calculado" em todo teste e em toda
captura — a composição principal do frame nunca tinha sido vista rodando.
(2) O desvio do Full em `/anuncios` estava **factualmente errado** (o snapshot
carrega o MLB). (3) `summarizePagedWindow` dizia "1 anúncios." — visível pela
primeira vez quando o rótulo ganhou destaque no cabeçalho do painel.

**Superfícies alinhadas:** shell, Home, Vendas, Produtos, SKU (abas principais),
Anúncios. **Precisam de revisão (A2):** design system (modal/drawer/text-button;
paleta Ctrl+K) e as abas secundárias do SKU.

**Riscos encontrados:** nenhum de segurança. Dois de contrato: `get_listings_dashboard`
e `get_sku_curation` foram recriadas (DROP + CREATE) com argumento/coluna novos
**no fim**, e os grants recriados com `authenticated, service_role`; a suíte de
integração (583) e o guard D-182 são o que provam que nada abriu.

### Progresso visual Figma

Ponderado, não por contagem de páginas. Uma superfície "implementada" mas
distante do frame não vale 100: estrutura = 50, + dados reais = 65, + design
próximo = 80, validada contra o Figma = 95, + cleanup + testes = 100.

| Bloco | Peso | A1 | A2 | D13 | A3 | D38/D39 | A4 | A5 | **Cinza** | **Fusão** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Shell + navegação | 8 | 86% | 91% | 91% | 91% | 91% | 91% | 91% | 91% | 91% |
| Design system (tokens, componentes, tabela, campo, menu, chip, modal) | 10 | 80% | 88% | 88% | 88% | 88% | **82%** | **94%** | **97%** | **97%** |
| Home | 6 | 87% | 87% | 87% | 87% | 87% | 87% | 87% | 87% | 87% → **90%** (A11) |
| Vendas | 8 | 85% | 88% | 88% | 88% | 88% | 88% | 88% | 88% | 88% |
| **Produtos** | 5 | 83% | 83% | 83% | 83% | **90%** | 90% | 90% | 90% | 90% |
| Dashboard de SKU (nove abas) | 10 | 82% | 88% | 88% | 88% | 88% | 88% | 88% | 88% | 88% |
| Anúncios — lista | 6 | 86% | 86% | 86% | 86% | 86% | 86% | 86% | 86% | 86% |
| **Anúncio — detalhe (oito abas)** | 5 | 25% | 25% | **84%** | 84% | 84% | 84% | 84% | 84% | 84% → **88%** (A10) |
| **D14–D17** (Estoque, Reposição, Curva ABC, Movimentações) | 8 | 25% | 25% | 25% | **88%** | 88% | 88% | **90%** | **90%** | **93%** |
| **D18/D20** (NF-e, Fornecedores) — frames que são ESBOÇO | 4 | 25% | 25% | 25% | **90%** | 90% | 90% | 90% | 90% | 90% |
| **D19** (Compras) | 3 | 25% | 25% | 25% | **95%** | 95% | 95% | 95% | 95% | 95% |
| **D21** (Integridade de Catálogo) | 4 | 25% | 25% | 25% | **92%** | 92% | 92% | 92% | 92% | 92% |
| **14 telas D22–D36** (eram "16" por contagem errada) | 22 | 25% | 25% | 25% | 25% | 25% | **88%** | **90%** | **90%** | **90%** |
| **Drawers do frame** (Inspeção Rápida, MLB, pedido, fornecedor, usuário) | 4 | 0% | 0% | 0% | 0% | **86%** | 86% | 86% | 86% | 86% |
| Passe visual global + passo cinza | 3 | 0% | 0% | 0% | 0% | 0% | 0% | **40%** | **100%** | **100%** |

**A11 mexe em UMA linha, e por medição.** A Home foi renderizada a 1440px com
login real e comparada ao frame `Home`: as duas diferenças que o registro nomeava
desde 04/09 — o seletor de janela e a hora relativa — deixaram de existir, **87%
→ 90%**. Não vai mais alto porque três diferenças permanecem, e as três são
**recusa medida**: a quinta célula da faixa, o segundo cartão crítico e a
variação percentual da terceira linha. Recusa continua sendo diferença.

**A10 mexe em UMA linha, e por medição.** `/anuncios/[itemId]` foi renderizada a
1440px e 1100px com login real, em três situações, e comparada ao
`MlbDetailDrawer` do export: a diferença de composição que restava no cabeçalho
— a fileira de fatos e a ação — deixou de existir, **84% → 88%**. Não vai mais
alto porque a miniatura, "Tipo" e "Catálogo" continuam sem coluna no esquema
(recusa reconferida), e porque sobraram dois achados vivos DENTRO da aba
Histórico: o veredito por condição do preflight e `listing_relist_events`, que
nunca foi lido. As outras linhas são cópia da coluna anterior, não medição nova.

**A coluna "Fusão" mexe em UMA linha.** `/reposicao` foi renderizada a 1440px
com login real depois da fusão (D-288): a diferença de composição que restava
naquele bloco era o frame desenhar UMA tela onde o app tinha duas, e ela deixou
de existir — 90% → **93%**. Não vai mais alto porque o frame ainda desenha
"Visão geral" e "Configurações" como ABAS, e aqui são duas rotas (D-278), e
porque a tabela rola **835px** na horizontal (medido; 138 deles são da coluna
nova). As outras linhas são cópia da coluna anterior, não medição nova.

**A coluna D38/D39 mexe em DUAS linhas, e só nelas.** São as duas que estas
fatias renderizaram (1440px e 850px, Supabase local, login real): `/produtos`,
cuja única diferença de composição que restava era a gaveta adiada — sobra o
botão "Buscar" visível, que é acabamento —, e o bloco das gavetas, agora com
**as cinco entregues e fotografadas**. Ele não vai a 100 porque duas delas
recusam abas que o frame desenha (as oito do anúncio, as cinco do fornecedor),
e recusa medida continua sendo diferença. As outras treze linhas são cópia de
A3, não medição nova.

✅ **A dívida de medição que esta seção anunciava FOI PAGA em A4.** A linha
valia 22 pontos e estava em 25% porque nenhuma das telas fora re-fotografada;
as catorze foram, e o bloco subiu para 88%. A regra continua valendo para
qualquer bloco futuro: **coluna nova só depois de comparar o renderizado com o
frame** — nunca por contagem de código.

**≈ 90% concluído · ≈ 10% restante** (passo cinza). O número só sobe quando o resultado
renderizado se aproxima do frame — não quando código é escrito, e **também
desce**: em A4 o bloco do design system caiu de 88% para 82% porque a auditoria
fotografou duas gramáticas de controle na mesma tela. **A5 devolveu o bloco a
94%** — campo e botão passaram a ter UMA forma, medida no navegador
(32px/11px/raio 6 no botão, 5 no campo, em seis telas) —, e **o passo cinza
fechou o passe visual global**: 0 → 40% (A5) → **100%**. A diferença
ESTRUTURAL que o Design Contract nomeava desde D0 — "o Figma é cartão branco
sobre fundo cinza; o app é branco sobre branco" — deixou de existir.

O ≈72% anterior era o piso de A3, e o que o segurava era uma linha de 22 pontos
contada a 25% sem nunca ter sido medida. Agora foi: **88%** nas catorze telas de
D22–D36. O que resta é quase todo o **passe visual global + passo cinza**, que
segue em 0.

**A coluna A3 é a primeira em que essa regra foi cumprida desde D13.** As
fatias D14–D21 tinham ficado sem coluna de propósito: o bloco estava marcado
como parado porque não havia render para comparar, e estender por contagem de
código produziria exatamente o número que esta seção existe para não produzir.
As capturas de A3 (1440px, Supabase local, login real pelo Playwright)
destravaram a medição.

**Por que D18/D20 recebem 90 e não 95:** os frames dessas duas variações são
ESBOÇO — cabeçalho e painel desenhados, corpo com parágrafo de reserva. A tela
cumpre tudo o que o frame dita, mas "validada contra o Figma" vale menos quando
o Figma tem menos a dizer. **D14–D17 subiram para 88 em A3b** (D-261): foram fotografadas, e a captura
achou o que só ela acharia — o `const td` inline sobrevivendo em duas delas,
contra o que o commit de D-252 afirmava. Não chegam a 95 porque `/cobertura`
continua fora da migração, e o frame a trata como parte da mesma tela.

⚠️ **A tabela acima está parada em D13, e cinco fatias já passaram** (D14–D18).
Ela não foi estendida de propósito: pela própria regra do bloco, a coluna só
existe depois de comparar o **renderizado** com o frame, e as capturas de
D14–D18 não foram refeitas. Estender por contagem de código produziria
exatamente o número que esta seção existe para não produzir. **A próxima
auditoria de fidelidade (A3) mede as cinco de uma vez** — até lá, o 56% é o
piso conhecido, não o valor corrente.

## Auditoria A3 — conferência visual de D18 a D21

Feita em 2026-09-07, **renderizando** as quatro superfícies a 1440px contra o
Supabase **local**, com login real pelo Playwright. É a primeira vez que a
frente visual foi conferida nesta máquina: até D-257 não havia Docker aqui, e
"entregue" vinha significando "verde no CI", não "visto rodando".

**As quatro estão certas, e três coisas só o render provou:**

- **D19** mostra as três saídas do valor estimado LADO A LADO — `R$ 52,50` com
  "1 de 2 sem custo", `—` com "1 de 1 sem custo", e `R$ 0,00` com zero itens.
  O D-254 deixou de ser argumento e virou imagem;
- **D20** fecha a aritmética na tela: R$ 347,00 = 252,50 + 52,50 + 42,00,
  **excluindo o cancelado**, com a ressalva do item sem custo;
- **D21** mostra o D-122 numa linha só: "Guidão — vínculo por variação" com SKU
  "—" e estado **Por variação**. Quem contasse `sku_id is null` marcaria essa
  linha como fila de trabalho.

### Os dois achados

**P3 — os chips "ver lista" da faixa desalinham.** A ressalva da célula "Sem
vínculo" ocupa duas linhas e empurra o chip ~34px abaixo dos vizinhos; no frame
os cartões alinham. Causa: `.sb-kpi` é `grid` com `align-content: start`, então
cada célula empilha a partir do topo e o link fica onde o conteúdo o deixa.

**Não corrigido aqui, de propósito.** O conserto é pequeno (flex-column +
`margin-top: auto` no link) mas muda o **design system** para as 7+ faixas do
app — Home, Vendas, Estoque, Movimentações, Curva ABC, Cobertura, Anúncios. É a
mesma classe de risco que D-242 registrou sobre trocar o `td` global: mudar
todas num gesto sem medir nenhuma. Vai para uma fatia de acabamento, com
captura de cada faixa antes e depois.

**Cobertura ausente, não defeito:** duas coisas de D21 não aparecem com este
seed — a ressalva de divergência entre as fontes ("12 a mais pela fonte
independente") e a linha de receita sem vínculo. As duas saem de `order_items`,
e o seed cria métricas mas não pedidos. Fica anotado para quem semear pedidos.

### O erro de processo que a auditoria expôs

A primeira rodada de capturas saiu **toda igual**: as quatro imagens com
exatamente 22.784 bytes, mostrando a tela de login com "E-mail ou senha
incorretos". A causa não era a tela — era o **bundle apontando para o Dev**,
porque a verificação final tinha rodado `pnpm run build` sem exportar as
variáveis do Supabase local. A tentativa de login foi contra o ambiente
compartilhado com credenciais de fixture; falhou, e nada foi escrito.

**A lição operacional:** `NEXT_PUBLIC_*` é embutida NO BUILD, então rodar
`build` e `e2e`/captura em shells com ambientes diferentes produz um app que
fala com o banco errado — e o sintoma (login falhando) não aponta para a causa.
A guarda que ficou: **antes de capturar ou semear, conferir que
`.next/static` e `.next/server` não contêm o ref do Dev** — e varrer só esses
dois, nunca `.next/dev` ou `.next/cache`, que guardam resíduo do dev server e
dão falso positivo.


## Auditoria A4 — as 14 telas de D22 a D36, renderizadas

Feita em 2026-09-09, **renderizando as catorze** a 1440px contra o Supabase
local com login real, e as cinco de mestre-detalhe também a 850px. Cada uma
comparada ao frame que a origina no export. É a medição que faltava desde D22:
o bloco valia 22 dos 106 pontos do progresso e estava contado a 25% porque
**nenhuma tinha sido fotografada** — não porque alguém as tivesse medido baixo.

**Primeiro achado, e é de contagem:** a linha dizia "16 telas". São **14**.
D22→D36 são quinze fatias, D26 (Tráfego) foi recusada com medição (D-266), e
nenhuma das outras entregou duas rotas. O 16 nunca foi contado.

### O veredito por superfície

| Tela | Frame | Antes → depois | O que restou |
|---|---|---:|---|
| `/diagnostico` (D22) | `Diagnostic` | 25 → **90%** | a nota do Copiloto embrulha um cartão branco com botão; o frame tem parágrafo + `text-button` |
| `/acoes` (D23) | `IntelligenceScreen actions` | 25 → **95%** | a mais fiel do lote: painel de filtros, fila em cartões e as três recusas (lote, menu de ordenação, hover) medidas em D-263 |
| `/precos` (D24) | `IntelligenceScreen pricing` | 25 → **92%** | a faixa é `KpiStrip` onde o frame tem quatro cartões com borda de tom; "Direção" é texto, o frame usa chip |
| `/full` (D25) | `IntelligenceScreen full` | 25 → **92%** | cinco células contra as quatro do frame — e a partição fecha (D-265); "Atualizado há X" virou a coluna CAPTURADO |
| `/atendimento` (D27) | `Sac` | 25 → **78%** | **a mais distante, e o desvio não estava escrito** — ver abaixo |
| `/atendimento/conhecimento` (D28) | `KnowledgeScreen` | 25 → **80%** | metade de cima migrada; o formulário tem campo e botão CRUS |
| `/notificacoes` (D29) | `CentralScreen` | 25 → **85%** | o mestre-detalhe foi recusado com medição (D-269); o que sobrou é a lista mais simples do lote |
| `/sugestoes` (D30) | `CentralScreen` | 25 → **92%** | mestre-detalhe fiel ao `.central-list`/`.central-detail`, com a sobrancelha exata do frame |
| `/usuarios` (D31) | `AdminScreen users` | 25 → **90%** | o papel é `<select>` e não selo — é controle, não leitura (D-275); sem busca no painel |
| `/integracoes` (D32) | `AdminScreen integrations` | 25 → **88%** | seis painéis de largura inteira onde o frame tem grade de dois: **1.857px**, a tela mais alta do lote |
| `/sincronizacao` (D33) | `AdminScreen admin` | 25 → **90%** | painel "Contas conectadas" com um chip só ocupa uma faixa inteira |
| `/saude` (D34) | `AdminScreen systemHealth` | 25 → **92%** | a âncora navy ficou no lugar do banner de uptime que não tem fonte (D-274) |
| `/configuracoes` (D35) | `AdminScreen settings` | 25 → **90%** | grade de três; o frame tem nav lateral + dois interruptores, recusados em D-275 |
| `/copiloto` (D36) | gaveta do Copiloto | 25 → **85%** | a gaveta de 430px virou página de 1.150px e a lista de prompts herdou a largura estreita |

**Média do bloco: 88%.** Nenhuma das catorze tem defeito funcional: as catorze
responderam **200**, zero erro de console (fora o WebSocket do realtime local,
que não sobe no `supabase start`), e o `UNKNOWN` de `/saude` é o estado honesto
de quem capturou sem a API no ar.

### P2-1 — campo e botão nunca entraram no design system, e voltaram a nascer inline DEPOIS da migração

O achado mais caro da auditoria, e ele é sistêmico:

| | |
|---|---|
| evidência V3 | `app/atendimento/conhecimento/new-knowledge-form.tsx` declara `const input` (14px, raio 8px) em vez de `.sb-input`; **quatro** arquivos declaram um `const buttonStyle` próprio — `/acoes/action-card.tsx:66`, `/compras/[id]/actions-panel.tsx`, `/notas-fiscais/[id]/document-item-row.tsx`, `/vinculacoes/candidate-row.tsx` — com raio 8px e 12px |
| medido | **59 campos em 29 arquivos** sem `.sb-input`; **59 botões em 35 arquivos** sem classe do design system |
| evidência Figma | o export tem UMA forma de botão (`.button`: 32px, 11px, raio 6px) e uma de campo |
| por que passou | `check:table-styles` guarda a TABELA (D-262). **Campo e botão não têm guarda** — e é exatamente onde a migração pela metade reapareceu |

É a mesma classe dos cinco mapas de tom de D-246 e do `const td` que A3b achou:
o padrão volta quando não há quem o reprove. **Por isso o bloco "Design system"
CAI de 88% para 82% nesta coluna** — a auditoria mede o que está na tela, e o
que está na tela são duas gramáticas de controle convivendo.

### P2-2 — `/atendimento` é a superfície mais distante, e o desvio não estava registrado

O frame `Sac` é um **inbox de três colunas numa tela só** — fila de 300px,
conversa no centro, contexto do cliente em 320px. A V3 é uma **lista tabular**,
e a conversa mora em `/atendimento/[caseId]`, outra rota.

D-267 registrou a ORDEM da fila e as colunas que o dado não sustenta. **A
composição de três colunas não está registrada em lugar nenhum** — não é recusa
medida, é diferença que ninguém escreveu. Some-se: a faixa tem **uma célula
só** ("No recorte 1"), que é um `KpiStrip` virando cartão solitário, e três
fileiras de `FilterPill` onde o frame tem duas abas.

### P3 — quatro acabamentos, com evidência dos dois lados

✅ **Fechados em D-287:** três feitos e **um recusado com número** — a largura de
`/integracoes` (item 2) não muda, porque a maior observação ocupa 4 linhas em
largura inteira e **24 em metade**. A auditoria mediu por fora e não leu a
justificativa que já morava no arquivo; a lição é sobre o método, não sobre a
tela.

1. **o chip de estado estica** nos itens de `/diagnostico` e `/sugestoes`:
   `.sb-diagnostic-item` é `grid`, e o `.sb-status` ocupa a coluna inteira, com
   cara de faixa. **O export tem a mesma regra** (`.diagnostic-item{display:grid}`),
   então é herdado — mas o Design Contract define o chip como pílula de 4px, e
   `width: max-content` é uma linha;
2. **`/integracoes` desperdiça largura**: tabelas de três linhas em painéis de
   largura inteira, 1.857px de rolagem contra os ~880px de `/configuracoes`,
   que resolve o mesmo problema com grade de três;
3. **`/copiloto` tem área morta à direita** — a lista de prompts nasceu para
   uma gaveta de 430px;
4. **a nota do Copiloto em `/diagnostico`** virou caixa dentro de caixa.

### O que a auditoria NÃO achou

Nenhum defeito de dado, nenhuma tabela sem `.sb-table`, nenhum `PageTitle`
faltando, nenhuma tela sem `ObjectHeader` onde o frame pede um. As recusas
registradas (D-260, D-263, D-265, D-269, D-271, D-274, D-275, D-276)
**conferem uma a uma com o que a tela mostra** — foram conferidas contra o
render, não contra o texto delas.

### Método, para a próxima repetir

Um probe único: login real, navegação pelas catorze rotas, e em cada uma
`screenshot` + um JSON estrutural (sobrancelha, h1, subtítulo, células da
faixa, títulos de painel, cabeçalhos de tabela, contagem de linhas, estados
vazios, alertas). **A captura de página inteira não funciona neste shell**: o
`<html>` tem altura fixa e quem rola é `.sb-content`, então `fullPage: true`
devolve sempre a dobra — a viewport cresce até `.sb-content.scrollHeight` antes
do disparo. Foi o que revelou os 1.857px de `/integracoes`.

## Revisão visual necessária

**NENHUMA.** As três de A4 fecharam: campo e botão em A5 (D-284), o inbox de
três colunas em D-286 (recusado com medição) e os quatro P3 em D-287 — três
feitos, um recusado com número. O histórico das três fica abaixo:

1. ~~**P2 — campo e botão fora do design system**~~ — **fechado em A5**
   (D-284): 194 controles com a forma do sistema, e `check:control-styles` na
   esteira para o padrão não voltar;
2. ~~**P2 — `/atendimento`**~~ — **DECIDIDO em D-286**: as três colunas foram
   recusadas com medição e o desvio está escrito; o que o desenho protegia (não
   perder a fila ao responder) virou o parâmetro `?volta=`;
3. ~~**P3 — os quatro acabamentos** de A4~~ — **FECHADOS em D-287**: o chip
   deixou de esticar (43px e 36px, medidos), a nota do Copiloto perdeu a caixa
   dentro da caixa, o `/copiloto` usa a largura onde é escolha e guarda a medida
   onde é leitura — e a largura de `/integracoes` foi **recusada com número**: a
   maior observação ocupa 4 linhas em largura inteira e **24 em metade**.

O texto abaixo é de A3 e continua valendo para o que ele mediu.

**Nenhuma** (à época de A3). A dívida que A3 deixou — os chips "ver lista" desalinhando quando
uma célula tem ressalva de duas linhas — foi fechada em **A3b** (D-261):
`.sb-kpi` virou coluna flex com `margin-top: auto` no link, verificado com
captura antes/depois das **8** telas com faixa (eram 8, não "7+": Cobertura e
Curva ABC usam cartões próprios).

Fora dela, **nenhuma nas superfícies migradas**. A2 fechou os P2 de componente
que A1 listou, e A3 confirmou D18–D21 renderizadas. O que resta são P3 de
acabamento já registrados (legenda do gráfico, altura do SVG, tom de lead time
na cobertura) — nenhum muda composição, e todos cabem no passe visual global
(D37).

**D14–D17 foram capturadas em A3b** (D-261), e a captura virou correção de
código: o `const td` inline sobrevivia em `/estoque/movimentacoes` e
`/reposicao`, contra o que os commits afirmavam. O que restava ali era
`/cobertura`, que nunca passou pela frente — **e deixou de existir em D-288**:
foi fundida em `/reposicao`, que é migrada.

**Essa lição virou guarda em D-262** — `check:table-styles`, na esteira. Ele
reprova o arquivo que declara `.sb-table` e mantém a tipografia de célula
antiga, que é a **migração pela metade**: enquanto restarem ~22 telas por
migrar, esse modo de falhar continua disponível, e agora cada migração tem de
ser inteira ou vermelha.

**Ele cobre uma metade só, e a outra é justamente esta rotina.** Sem a classe
declarada não há contradição dentro do arquivo — foi o caso de
`/estoque/movimentacoes`, que não tinha `sb-table` nenhuma e onde a migração de
D-252 simplesmente nunca aconteceu. Quem pega isso é **abrir a tela**. É o
motivo de a captura do A3 ser rotina obrigatória e não acabamento.

Duas afirmações desta seção estavam erradas e foram corrigidas medindo o commit
anterior: `/reposicao` tinha **19 de 22** células sobrepondo a classe (não 23), e
`/estoque/movimentacoes` não era vazamento parcial de 3 células — eram **todas**
as 13.

⚠️ **Esta linha dizia "o que resta é a fila D31 em diante: 7 superfícies ainda
não migradas", e estava VELHA** — D31→D36 fecharam (D-271→D-276) e o passe
D37a/b/c também. Corrigida em D38: não resta superfície por migrar; o que resta
está na "Próxima fatia segura".

## Última fatia concluída

**A11 — A HOME CONTRA O FRAME (D-311)** — a Home era a **única superfície nunca
remedida** desde a primeira auditoria (04/09, 87%). A varredura de A10 a leu de
novo e achou quatro diferenças; cada uma foi atacada por um cético com uma lente
própria, e **duas caíram**. As duas que sobreviveram são esta fatia; as duas que
caíram viraram linha na tabela de "Diferenças intencionais", que é entrega
também.

| o frame | o que estava | agora |
|---|---|---|
| controle "14 dias ⌄" no cabeçalho do gráfico | um link para **fora** da tela ocupando o lugar do controle | `FilterMenu` com os cinco presets do app, e o link continua ao lado |
| "4 min atrás" no feed | data e hora absolutas | **a idade do FATO** (`occurred_at`), com o instante exato no `title` |

### O vocabulário de período ganhou dono antes de ganhar o terceiro consumidor

O achado propunha 7/14/30. A casa tem **uma lista fechada** — 7/15/30/60/90 — e
D-308 escreveu a regra em geral: *"últimos 30 dias" precisa querer dizer a mesma
coisa nas duas telas*. Então a fatia começa mudando o trio de casa: de
`lib/listings-dashboard.ts` (batizado por UMA tela) para **`lib/period.ts`**, e
`/vendas` apagou a própria cópia da lista. **O tipo virou a guarda**: o `fallback`
de `resolvePeriodDays` é tipado como `PeriodPreset`, então *"14 dias" não
compila*. O padrão da Home é 15 — um dia de diferença na leitura, em troca de uma
lista só no app inteiro.

### `?serie=` termina na série

A Home tem duas janelas na mesma tela: a faixa em 30 dias e o gráfico. Ligar o
seletor na `janela` faria os contadores dos cartões de atenção mudarem por causa
de um controle que está no cabeçalho de outro bloco. O caso de e2e afirma as duas
metades juntas: com `?serie=7`, o gráfico diz 7 e a faixa continua dizendo 30.

### A idade do FATO, não a do aviso

`formatAge` — a ferramenta que faltava — **nasceu quatro dias depois da auditoria
que registrou a lacuna**. Mas a proposta ao pé da letra estava errada e a revisão
pegou: `notifications.created_at` é quando o fan-out gravou, `domain_events.occurred_at`
é quando a mudança aconteceu, e o desvio máximo já medido entre as duas é de
**278 dias**. O embed ganhou `occurred_at` — a mesma expressão que
`/notificacoes` já usava, então as duas telas passaram a dizer o mesmo instante
para o mesmo evento.

### O que só a captura acharia (de novo)

Com o subtítulo mais longo, `.sb-panel-head` — que é `flex-wrap: wrap` — quebrou
em duas linhas e o `aside` foi para a **esquerda**: `justify-content:
space-between` não faz nada quando há um item por linha. `.sb-panel-aside` ganhou
`margin-left: auto`, que não muda nada na linha única e resolve a quebrada.

**Verificação:** `check` 29/29 (`--force`), build 8/8, e2e **127/127** em banco
recriado (+2), integração 658/658, cinco guardas verdes. Renderizada a 1440px em
três estados do painel: padrão, `?serie=7` e com a ressalva de série parcial.

## Fatias anteriores

**A10 — O CABEÇALHO DO ANÚNCIO (D-310)** — com a Administração fechada, a
pergunta virou *qual é a próxima fatia?*, e a resposta foi medida: **sete
superfícies lidas contra o frame**, com evidência dos dois lados, e os achados
acionáveis passados por uma rodada adversarial antes de virarem trabalho.

### O que a varredura achou

| | |
|---|---|
| achados | **49**, em 7 superfícies (Home, Vendas, Anúncios, Anúncio, SKU, Shell, gavetas) |
| acionáveis | 28 |
| recusa registrada e **ainda** verdadeira | 13 |
| registro velho (já estava feito) | 4 |
| sem fonte no esquema | 4 |

**Nenhuma superfície estava desalinhada na composição principal** — os sete
relatórios dizem o mesmo com palavras diferentes: os blocos do frame existem, na
ordem do frame. O que sobrou são fatos que o cabeçalho não diz, ação no lugar
errado e densidade. Dos oito melhores acionáveis, **sete sobreviveram à rodada
adversarial e um caiu**: a largura das gavetas (420px para as cinco) — 420 é a
largura do design system do export, e a pergunta já tinha sido decidida com
medição em D-297.

### A fatia, e por que não a de maior peso

`/anuncios/[itemId]` estava em **84%**, o menor percentual absoluto entre as
migradas, e foi a única com **dois achados que se resolvem na mesma passada, no
mesmo componente**. SKU (peso 10) e Vendas (peso 8) têm lacuna ponderada maior,
mas o que sobrou neles é um painel de três itens e uma proporção de SVG:
acabamento. Composição primeiro.

| o frame | o que estava | agora |
|---|---|---|
| fileira de fatos abaixo do título (Preço · Tipo · Catálogo) | nada — o preço só como rabisco na nota de outro cartão | **Preço atual · Disponível (este anúncio)**, com fio entre as duas |
| "Republicar anúncio ›" no cabeçalho | a única escrita da tela invisível, no `aside` de um painel da aba Histórico | **"Republicações →"** no cabeçalho, que LEVA ao painel e some quando já se está nele |

**`available_quantity` era select morto**: vinha na consulta desde D13 e não era
impresso em nenhuma das oito abas. O preço tinha dono duplicado — saiu da nota
do cartão de Faturamento e do subtítulo da aba Preço.

### O rótulo que mudou, e por quê

O frame promete o ATO; aqui o cabeçalho promete o CAMINHO. A republicação é
gated por papel (ADMIN/GESTOR, D-295) e o papel só é lido na aba Histórico —
prometer "Republicar" a quem o servidor recusa seria promessa falsa, e ler o
papel nas oito abas para decidir o rótulo custaria uma ida em todas elas. A
regra é a de D-309: **o link leva o nome do painel que abre**.

### O que só a captura acharia

`.sb-text-button` nasceu em D-281 vestindo `<button>` e nunca declarou
`text-decoration`. Este é o primeiro consumidor `<a>`: o sublinhado nativo do
link deixava a forma sublinhada **em repouso**, e o `:hover` — que é justamente
o sublinhado — parou de dizer qualquer coisa. Corrigido na classe; os cinco
consumidores em `<button>` não mudam de pixel. Nenhum teste pegaria isso.

**Verificação:** `check` 29/29 (`--force`), build 8/8, e2e **125/125** em banco
recriado (+3), integração 658/658, cinco guardas verdes. Renderizado a 1440px e
1100px em três situações: com preço e saldo, com `available_quantity = 0` (o
zero aparece — e há caso de e2e para reprovar quem "melhorar" isso com guarda
falsy) e na aba Histórico, onde o caminho some.

**A9 — `/saude` CONTRA O FRAME (D-309)** — A6 (D-296) deixou uma linha em aberto
na tabela da Administração: *"Saúde — seis cartões de serviço com latência — **a
medir**"*. Esta fatia mediu, e o resultado é **seis recusas e duas entradas**.

### Os seis cartões, cartão a cartão

| cartão do frame | a fonte, conferida agora | veredito |
|---|---|---|
| **Aplicação Web · 42 ms** | zero cronômetro em `apps/web` (nenhum `performance.now`, nenhum `instrumentation.ts`, nenhum web-vitals) | fora — e a célula âncora já diz MAIS: CURRENT/OUTDATED/UNKNOWN com o motivo |
| **API Mercado Livre · 186 ms** | o cliente HTTP do ML não se cronometra; `job_runs.duration_ms` é a janela do handler INTEIRO, com backoff de até 30 s dentro dela | fora — um 429 entraria como "latência" |
| **Workers · 3 filas em retry** | fila não existe no Postgres, e "em retry" é presente do verbo: `job_runs` só guarda execução encerrada | fora — o estado vivo é do Cloud Tasks, a permissão que D-176 excluiu |
| **Banco · 12 ms** | `pg_stat_statements` está povoado, e é ele que prova a impossibilidade: no mesmo instante sustenta 0,268 / 0,540 / 45,5 / 122,2 ms — **456×** | fora — seria a escolha de um agregado, não uma medição |
| **Armazenamento · 2,4 TB livres** | `documents` conta XML; ninguém guarda bytes, e "livres" é cota do provedor | fora — a mesma permissão excluída |
| **Fila de Atendimento · Estável** | a profundidade TEM fonte (`support_cases.internal_status`), mas "estável" é veredito sem limiar | fora — e a fila tem tela dona (D-224) |

A faixa navy com **"99,97% de uptime"** segue sem fonte: zero tabelas, views ou
colunas de incidente, uptime, SLA ou indisponibilidade. **A recusa foi
REMEDIDA, não herdada** — desde A6 nasceram `metric_refresh_state` (D-304) e a
varredura de `pg_stat_statements` (D-305→D-307), e era obrigatório conferir se
alguma delas servia. Nenhuma serve.

### O que entrou, e é pouco de propósito

**A ação do cabeçalho.** "Ver incidentes" do frame virou **"Execuções que
falharam →"** para `/sincronizacao`: incidente promete abertura, dono e
fechamento, e o que existe são famílias de execuções por assinatura de motivo
(D-291). O link leva o nome do painel que abre, palavra por palavra, e **sem
contagem** — um número ali brigaria com a coluna "Falhas 24h" da tabela logo
abaixo.

**O tempo da ida ao `/health`.** A tela já fazia a chamada para comparar
commits; cronometrá-la não custa leitura nova, e é o único número de latência
que esta casa pode imprimir honestamente — porque é o único que mede o que o
nome promete. Sai com a qualificação ao lado (*"uma ida, agora: 842 ms"*), e
**sem resposta não tem tempo de resposta**: as três formas de falhar dão em
"sem resposta", em vermelho.

### Três correções que a revisão adversarial pegou

| o que eu tinha escrito | por que estava errado |
|---|---|
| `tom: "perigo"` para pintar a célula quando a API cai | **`tom` não pinta célula** em `KpiStrip` — veste o chip "ver lista", que esta célula não tem. Quem tinge rótulo e valor é `destaque` (D-297) |
| `formatCount(ms)` + `" ms"` | `formatCount` agrupa milhar: **3842 viraria "3.842 ms"**, que se lê como três milissegundos. O tempo mais LENTO pareceria o mais rápido. Entrou `formatLatency`, com degrau em 1 s |
| o número sem dizer o que ele não cobre | o `/health` devolve objeto literal: **não consulta o banco**. Rápido ali é "o processo está de pé", não "o sistema está saudável" |

E uma quarta, vinda da própria suíte: a qualificação nasceu como *"não é média
nem SLA"* e o e2e **recusou a palavra** — ele proíbe "SLA" nesta tela desde a
primeira fatia. A frase mudou; a guarda ficou. Proibição que abre exceção para
o caso óbvio não proíbe mais nada.

**Verificação:** `check` 29/29 (`--force`), build 8/8, e2e **122/122** em banco
recriado (+2), integração 658/658, cinco guardas verdes. A célula da API foi
exercitada nos dois estados — com a api local de pé e sem ela —, e o caso novo
afirma a tinta `--sb-danger-ink` no "sem resposta", porque foi exatamente a
pintura que a revisão pegou errada.

**A8 — `/contas` CONTRA O FRAME (D-299)** — a tela que nunca tinha passado pelo
desenho (não estava em D0→D37) virou cartão por conta: selo, `seller_id`,
última sync, anúncios, permissões e ações. O registro completo, incluindo o
token que vive seis horas, está em `docs/DECISIONS.md` D-299.

**A7 — `/usuarios` REFEITA CONTRA O DESENHO (D-297)** — o usuário comparou a
captura do frame com a nossa tela: *"o seu está muito inferior, acompanhe 100%
o design figma"*. D-296 tinha entregado o DADO que faltava; o que ele estava
vendo era **composição**.

### O que estava inferior tinha número

Cada linha carregava um `<select>` de papel e **uma caixa por conta** — com
quatro contas, **cinco controles por pessoa**. Uma tabela assim não se lê: ela
se preenche. O frame põe **selo** em Papel, **texto** em contas, e abre a pessoa
numa **gaveta**.

| o frame | o que estava | agora |
|---|---|---|
| Papel como selo colorido | `<select>` em toda linha | selo (ADMIN perigo, GESTOR atenção, resto info) |
| contas em texto | uma caixa por conta, por linha | texto (`Loja A · Loja B`) |
| linha clicável abre a gaveta | coluna extra "Inspecionar" | o **nome** é o gatilho, e a coluna saiu |
| busca + "Status ⌄" no painel | nenhum recorte | os dois, na URL (`lib/member-filters.ts`) |
| "Convites Pendentes" em âmbar | célula neutra | célula pintada (`destaque` na faixa) |

### O controle mudou de lugar, não sumiu

Papel e alcance são editados no cartão "Papel e Permissões" **da gaveta**, que é
onde o frame já os desenha. Mesmos componentes, mesmas Server Actions, mesma
autorização (policies `*_admin_writes` + `guard_last_admin`). O caso de e2e
guarda **as duas metades juntas** — tabela sem controle E menu de papel vivo
dentro da gaveta —, porque separá-las deixaria passar a "correção" que some com
a edição em vez de movê-la.

E dentro da gaveta vale a mesma regra: quem edita vê o CONTROLE, quem lê vê o
SELO. A primeira versão mostrava os dois, "GESTOR" em cima de um menu já em
GESTOR — a captura pegou.

### "Desde" saiu da tabela

Ela entrou em D-271 como substituta de "Último acesso", que não tinha fonte.
D-296 abriu a fonte; manter os dois carimbos deixaria **seis** colunas onde o
frame tem cinco, para responder o que a gaveta já responde em "Membro desde".

**Verificação:** `check` 29/29 (`--force`, 448 unitários com os 13 novos), build
8/8, e2e **113/113** em banco recriado (+2), integração 648/648, cinco guardas
verdes. Renderizada a
1440px com seis membros de verdade — convite pendente, membro sem perfil, três
papéis — e a gaveta aberta em cada um.

### A auditoria do grupo, que continua valendo (A6, D-296)

O usuário pediu foco na ADMINISTRAÇÃO dizendo que muita coisa do desenho ainda
não existe nela, "inclusive o botão de colocar novos usuários". As seis telas
foram renderizadas a 1440px e lidas contra o frame:

| tela | o que o frame tem e a V3 não | veredito |
|---|---|---|
| **Usuários** | "Convidar usuário"; Status; Último acesso; e-mail; cartão de convites | **FEITO** (D-296), e a composição refeita em D-297 |
| **Contas ML** | a composição inteira (cartão por conta: selo, seller_id, última sync, anúncios, permissões, ações) | **NUNCA MIGRADA** — `/contas` não está em D0→D37. Próxima fatia |
| **Saúde** | seis cartões de serviço com latência; "Ver incidentes"; 99,97% de uptime | recusa **medida** e mantida (D-309: as seis fontes conferidas uma a uma). O link do cabeçalho entrou com o nome do painel que existe, e a ida ao `/health` entrou cronometrada |
| **Integrações** | cartão por parceiro | recusa medida e mantida (D-272 + D-287: 4 linhas × **24** em meia largura) |
| **Sincronização** | quatro cartões contando CONTAS | recusa medida e mantida (D-273: conta não é unidade de frescor) |
| **Configurações** | trilho + interruptores (2FA, manutenção) | recusa medida e mantida (D-275: não há onde gravar) |

A janela que abriu as três colunas é `get_organization_members`, `security
definer` com o guard do **tenant** (ADMIN daquela organização, não "ADMIN de
alguma"). O fluxo do convite é `generateLink` — **link, não e-mail enviado**: o
projeto não tem SMTP, e dizer "convite enviado" sobre entrega que ninguém provou
seria a promessa que esta casa recusa.

## Próxima fatia segura

**A COMPOSIÇÃO DO FIGMA FECHOU.** D0→D25, D27→D36, o passe D37a/b/c e **as
cinco gavetas** (D38, D39) estão entregues; D26 foi recusada com medição
(D-266). O guarda `check:table-styles` conta **29** telas — eram 30 até D-288,
e a que saiu foi `/cobertura`, que virou redirect — e não há mais nenhuma
fora. Não resta elemento do desenho por implementar.

O que resta é MEDIÇÃO e produto, cada item com dono e motivo já registrados.
Em ordem de risco medido:

1. ~~**Fundir `/cobertura` com `/reposicao`**~~ — **FEITA** (D-288). A
   definição escolhida foi a da reposição, e o número que decidiu é este: das
   **325** "rupturas" que `/cobertura` acusava, **150 tinham Full ou trânsito**
   — as duas discordavam em **186 SKUs**. `/cobertura` virou redirect 308 com
   o recorte junto.
2. ~~**Os drawers do frame**~~ — **as cinco entregues** (D38/D-281 e
   D39/D-282), sob a regra de que a gaveta resume e leva à tela. O que
   permanece fora são as ABAS que o frame desenha dentro de duas delas, e isso
   é recusa medida, não pendência.
3. ~~**A auditoria de render de D22–D36**~~ — **FEITA (A4)**: as catorze telas
   renderizadas e medidas, bloco de 25% para **88%**, e o total da frente de
   ≈72% (piso) para **≈85% medido**.
4. ~~**A5 — o passe de campo e botão**~~ — **FEITO** (D-284): 41 arquivos, 194
   controles, e o guarda `check:control-styles` na esteira. O bloco do design
   system voltou de 82% para **94%**.
5. ~~**`/atendimento`**~~ — **DECIDIDO** (D-286): recusado com medição, desvio
   registrado, e o `?volta=` entregue.
6. ~~**O passo cinza**~~ — **FEITO** (D-285). Com ele, o passe visual global
   fecha e a frente chega a **≈90%**.
7. Os **sete itens abertos** listados abaixo.

⚠️ **O que D-279 listou aqui como item 1 — "`get_purchase_suggestions` não
classifica nenhum SKU" — NÃO EXISTE.** Era erro de medição meu (`p_date_to`
nulo); corrigido em D-280, junto com a armadilha que o produziu.

A rotina de medição acumulou **treze** perguntas ao longo da frente, e elas
valem para qualquer fatia futura, não só de design: **o frame tem fonte?**
(D-266), **falta coluna ou falta dado?** (D-268), **quantas linhas no Dev?**
(D-263), **a faixa conta o mesmo conjunto da tabela ou é navegação?** (D-265),
**há spec?** (D-271), **capturei a tela depois do último build?** (D-272), **o
fixture do teste é um dado degradado de verdade?** (D-273), **o mapa já sabe
disso?** (D-274), **o elemento é lido ou é acionado?** (D-275), **este caso
passa na tela errada?** (D-276), **o desenho é desta ENTIDADE?** (D-277), **a
FORMA do meu fixture é a forma real?** (D-278), de D-279, **a recusa que eu
registrei foi medida ou só raciocinada?**, de D-281, **o que eu estou
afirmando aparece no `innerText` — ou só na captura?** e, de D-282, **este
registro ainda é verdade, ou a rota que ele nega já nasceu?** e, de A4,
**existe guarda para este padrão — ou ele volta assim que eu virar as costas?**
e, de A5, **a regex que eu usei para achar o elemento sabe onde a tag TERMINA?**
E, do passo cinza, a mais barata de todas: **esta lista de pré-requisitos ainda
é verdade, ou metade dela já foi paga por outras fatias?** E, de D-309, duas que
valem para qualquer número novo: **o formatador que eu reusei foi feito para
esta GRANDEZA — ou só para contar coisas?** e **a propriedade que eu passei
pinta o que eu acho que ela pinta?** De D-286: **o que
esta composição do frame protege pode ser entregue sem ela?** E, de D-288, a
que custou uma suíte inteira de diagnóstico: **o estado que este teste afirma é
do seed — ou algum spec anterior já escreveu por cima dele?**

**Sete itens seguem abertos fora da fila:**

- ~~**`/notas-fiscais/[id]`**~~ — **migrada em D-277**. Segue valendo a medição:
  dois dos quatro estados de item do brief §25 (`SUGESTAO`, `CONFLITO`) não têm
  dado em `document_items`, e são trabalho de backend antes de serem de tela.
- ~~**`/cobertura`**~~ — **fundida em D-288**: virou `/reposicao`, com a
  definição de ruptura da reposição e o `?marca=` preservado no redirect. O que
  o frame ainda desenha como ABAS ("Visão geral" / "Configurações") aqui são
  duas rotas (`/reposicao` e `/reposicao/configuracoes`, D-278) — desvio
  registrado, não pendência.
- ~~**Exportação de `/precos`**~~ — **FEITA** (D-292). A recusa de D-264 não era
  contra exportar: era contra pintar o botão sem a rota. Agora é link para
  `GET /precos/export/xlsx`, que exporta **o recorte da tela**, pagina de mil em
  mil (teto do PostgREST) até 20.000 linhas e **imprime o teto dentro do
  arquivo** quando o recorte é maior. A inspeção da planilha gerada pegou um
  defeito que teste de tela nenhum pegaria: o XLSX não guarda fuso, e a mesma
  alteração saía 17:52 na tela e **20:52 no arquivo**.
- ~~**Paginação de `/atendimento`**~~ — **FEITA** (D-289). Não era só a frase:
  a tela lia as 100 mais recentes e nenhum filtro dela separa essas 100 do
  resto, então **829 dos 929 abertos do Dev não tinham como ser abertos por
  ela**. De quebra, uma medição: `.range()` além do fim devolve **416
  `PGRST103`**, e sem tratar isso um `?pagina=9` antigo vira página vermelha —
  quatro outras telas com `.range()` têm a mesma exposição, registrada na
  decisão.
- ~~**Filtro de não lidas em `/notificacoes`**~~ — **FEITO** (D-290): duas
  pílulas, não o menu de filtros que o frame sugere — severidade, tipo e conta
  continuam fora porque nenhum número os pediu. A paginação veio junto (as
  42.411 fora da primeira página eram o mesmo beco de D-289), e a fatia
  **corrigiu D-289**: o 416 do PostgREST exige `count: exact` na mesma consulta
  — sem `count` o pedido volta 200 vazio, e aí quem sabe da página inexistente
  é a aritmética.
- ~~**Lista de execuções que FALHARAM**~~ — **FEITA** (D-291), com migration.
  A RPC `get_job_failures` é a janela: `job_runs` continua com RLS e zero
  policies, e quem lê é uma função `security definer` com autorização ADMIN
  refeita dentro, devolvendo AGREGADO. O firehose ATRAVESSA o recorte de falhas
  (78% delas também são webhook), então a lista crua não resolveria — quem
  resolve é agrupar por assinatura do motivo: **170 motivos crus viram 16
  linhas**. A migration foi aplicada no Dev pela esteira, e os tipos já vieram do gerador do MCP.
- ~~**A gaveta do Copiloto**~~ — **FEITA** (D-294), depois que D-293 pagou a
  pré-condição. O ✦ da barra de topo deixou de ser link: abre a gaveta por cima
  da tela em que você está, com o contexto publicado pela própria página (a
  rota traz o UUID e o MLB; a ferramenta pede o **código** do SKU e a **conta**
  do anúncio). As recusas sobreviveram — "Quanto enviar ao Full?" e "histórico
  de exposição" continuam fora, com asserção de e2e.
