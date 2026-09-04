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

| Componente | Caminho | Situação (auditoria de 2026-09-04) |
|---|---|---|
| Shell (sidebar + grupos + topbar) | `components/shell.tsx`, `nav.tsx` | **camada nova**, refeita pelo frame; trilho de 58px em ≤850 desde A1 |
| `PageTitle`, `Panel`, `KpiStrip`, `ObjectHeader` | `components/*.tsx` | **camada nova** — `.page-title`, `.panel`, `.kpi-strip`/`.ops-metrics`, Object Header do Figma |
| `FilterMenu` | `components/filter-menu.tsx` | **novo em A1** — o `.button.ghost ⌄` com dropdown; substituiu dez cópias de `<details class="sb-menu">` |
| `tone.ts` (`TOM`, `tomDeStatus`) | `components/tone.ts` | **dono único** dos cinco tons do `.status`; `StatusPill`, `StatePill`, `KpiStrip`, `ObjectHeader` e a Home leem daqui (eram cinco mapas) |
| `StatusPill` (código do banco → tom) | `components/status-pill.tsx` | alinhado — `.sb-status` + `tone.ts` |
| `StatePill` (vocabulário da tela → tom) | `components/state-pill.tsx` | alinhado — era cápsula de contorno; virou o mesmo chip |
| `.sb-table`, `.sb-input`, `.sb-empty`, `.sb-menu`, `.sb-modal`, `.sb-backdrop`, `.sb-close` | `app/globals.css` | as formas únicas de tabela, campo, vazio, menu e camada flutuante; **adotar ao migrar cada tela** |
| `TrendBadge` | `components/trend-badge.tsx` | alinhado (texto, não chip) |
| `SavedFilters` | `components/saved-filters.tsx` | alinhado em A2 — `.sb-menu` para as visões e `.sb-modal` para nomear (o `window.prompt` saiu) |
| `CommandPalette` | `components/command-palette.tsx` | alinhado em A2 — `.sb-command` (520px a 16vh, cabeçalho, ✕, `ESC`, resultados agrupados por tipo) |
| `FilterPill` | `components/filter-pill.tsx` | **legado** — 8 telas não migradas ainda o usam; some quando a fila D13+ fechar |
| `th`/`td`/`tdNumber`/`cardStyle` | `components/table-styles.ts` | **legado** — 2 telas não migradas (`/integracoes`, `/configuracoes`); MERGE em `.sb-table` ao migrá-las. **Nenhuma tela migrada tem mais const inline de tabela.** |

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
| **Seletor global de conta** no rodapé da sidebar (modal "Definir escopo da aplicação") | a V3 recorta por conta **tela a tela** (menu "Todas as contas ▾" em `/vendas`, `/anuncios`…), com o recorte na URL — compartilhável e com voltar; um escopo global em cookie quebraria isso. O bloco mostra a organização e as contas conectadas (dado real) e leva a `/contas`. **O motivo anterior ("não há segunda organização") respondia a uma pergunta que o frame não faz** — corrigido na auditoria | A1 |
| Central de Ajuda | não existe conteúdo de ajuda | — |
| Menu de perfil (dropdown) | esconderia o "Sair" atrás de um dropdown que não foi desenhado | — |
| Botão flutuante do Copiloto (drawer contextual) | Copiloto é rota, e está no menu — um segundo Copiloto é escopo vetado | — |
| Logo em imagem na marca | o export traz uma captura de tela, não o asset da marca; sem `public/` nem logo por organização. Entra quando existir asset oficial | — |
| Botão de recolher a sidebar (`.collapse`) | o trilho de 58px existe em ≤850 (A1); recolher por clique em tela larga é estado de cliente sem frame de "recolhida" — fila A2 | — |
| Drawer "Inspeção Rápida" (produtos) e `MlbDetailDrawer` (anúncios) | padrão válido, mas caminho NOVO (client component + `.sb-drawer`), não substituição de apresentação antiga; as linhas levam ao dashboard completo, que é o destino que os drawers apontam | escopo |
| Célula "Com queda" e coluna "Saúde" em Anúncios | sem detecção de anomalia por anúncio e sem definição canônica de "saúde" | D-023 |
| Ação "Novo anúncio" | a V3 não cria anúncio no Mercado Livre — escrita no ML é ato com aprovação humana | escopo e segurança |

### Desvios registrados, no formato curto

> **Superfície:** `/skus/[id]`, abas que não a Visão geral · **Figma:** o frame
> mostra *"Conteúdo da aba em construção"* para todas · **V3 real:** conteúdo
> completo · **Decisão:** aplicar o **design system** (rótulo de seção, cartão
> de indicador, painel), não inventar um frame · **Motivo:** escopo — o Figma
> não desenhou essas abas, e o Design Contract é o que resolve componentes
> recorrentes quando o frame não fala.

> **Superfície:** Figma tem um **drawer de "Inspeção Rápida"** disparado da
> tabela de produtos · **V3 real:** não existe · **Decisão:** adiar ·
> **Motivo:** escopo — é padrão desenhado e válido, mas acrescenta caminho novo
> em vez de substituir apresentação antiga; entra quando a fila de migração
> fechar.

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
> ficam de fora · **Motivo:** dado inexistente.

> **Superfície:** `/anuncios/[itemId]`, Visão geral · **Figma:** faixa **"Exposição
> em Risco"** com botão "Repor Full", e painel **"Saúde do Anúncio"**
> (competitividade de preço, qualidade das fotos) · **V3 real:** nenhuma das três
> tem fonte; a faixa ainda encadeia catálogo e Full numa relação causal ·
> **Decisão:** os quatro cartões medidos ficam, a faixa e o painel saem; do que
> era "saúde" sobra o Full, que é medido e tem painel próprio · **Motivo:**
> métrica canônica (D-023) e a regra da própria tela — história, nunca causa.

> **Superfície:** `/anuncios/[itemId]` · **Figma:** botão **"Republicar anúncio"**
> e o `RepublicationModal`, um assistente de cinco passos cujo passo 2 EXECUTA ·
> **V3 real:** o motor existe e só o worker escreve; a primeira republicação real
> é ato humano deliberado, pendente em `docs/HANDOFF.md` · **Decisão:** a aba
> Histórico LÊ o histórico de republicação (pai, filho, estado, motivo da falha)
> e **nenhum caminho de UI dispara** — o e2e afirma a ausência do botão ·
> **Motivo:** segurança. O preflight do frame ainda diverge do real em
> severidade: ele mostra Full e Catálogo como aviso, e no código os dois são
> BLOQUEIO.

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
| — | O passo cinza (`--sb-ground` no `<main>`) | fila, com pré-requisitos medidos |
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
| D14–D20 | Estoque, Cobertura/Reposição, Curva ABC, Movimentações, NF-e, Compras, Fornecedores | fila |
| D21–D30 | Vinculações, Diagnóstico, Ações, Alterações, Preços, Full, Tráfego, Atendimento, Conhecimento, Central | fila |
| D31–D36 | Usuários, Integrações, Sincronização, Saúde, Configurações, Copiloto | fila |
| D37 | Passe visual global | fila |

## Auditoria de Fidelidade Figma

Feita em 2026-09-04 (A1), **renderizando** cada superfície migrada (screenshots a
1440, 1100 e 850) e lendo o frame correspondente no export — nove leituras
independentes, cada achado com evidência dos dois lados (`App.tsx:linha` e
arquivo:linha da V3). A pergunta de controle em cada uma: *parece o Figma, ou
parece a aplicação antiga com o tema do Figma?*

| Superfície | Fidelidade antes → depois | Status | Diferença principal que restou | Código legado |
|---|---:|---|---|---|
| Shell (sidebar, topbar, busca) | 78% → 86% → **91%** (A2) | ALINHADO | sem botão de recolher em tela larga; logo em texto | nav horizontal antiga: **removida** (não existia mais consumidor); paleta refeita pelo `.command` |
| Design system (tokens, componentes) | 70% → 80% → **88%** (A2) | ALINHADO | falta `.sb-drawer` (drawers adiados); 30 telas não migradas ainda com `th`/`td` inline | cinco mapas de tom → **um** (`tone.ts`); `StatePill` cápsula → chip; `.sb-modal`/`.sb-command` nasceram; `table-styles.ts` MERGE pendente (2 consumidores não migrados) |
| Home | 78% → **87%** | ALINHADO | seletor "14 dias ⌄" do gráfico; hora relativa no feed | `TOM` local **removido**; `.sb-attention-value` **removida** |
| Vendas | 70% → 85% → **88%** (A2) | ALINHADO | legenda do gráfico no rodapé (frame põe no cabeçalho); altura do SVG proporcional | `FILTER_DATE_STYLE` **removido**; 3 menus → `FilterMenu`; "Cancelamentos e taxas" **dissolvido**; `SavedFilters` no design system |
| Produtos | 68% → **83%** | ALINHADO | drawer "Inspeção Rápida" (adiado); botão "Buscar" visível (frame submete por Enter) | consts `th`/`td` **removidos**; faixa inventada **removida**; 3 menus → `FilterMenu` |
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

| Bloco | Peso | A1 | A2 | D13 |
|---|---:|---:|---:|---:|
| Shell + navegação | 8 | 86% | 91% | 91% |
| Design system (tokens, componentes, tabela, campo, menu, chip, modal) | 10 | 80% | 88% | 88% |
| Home | 6 | 87% | 87% | 87% |
| Vendas | 8 | 85% | 88% | 88% |
| Produtos | 5 | 83% | 83% | 83% |
| Dashboard de SKU (nove abas) | 10 | 82% | 88% | 88% |
| Anúncios — lista | 6 | 86% | 86% | 86% |
| **Anúncio — detalhe (oito abas)** | 5 | 25% | 25% | **84%** |
| 23 telas ainda não migradas (D14–D36) | 41 | 25% | 25% | 25% |
| Drawers do frame (Inspeção Rápida, MLB, pedido, fornecedor, usuário) | 4 | 0% | 0% | 0% |
| Passe visual global + passo cinza | 3 | 0% | 0% | 0% |

**≈ 56% concluído · ≈ 44% restante.** O número só sobe quando o resultado
renderizado se aproxima do frame — não quando código é escrito.

## Revisão visual necessária

**Nenhuma nas superfícies migradas.** A2 fechou os P2 de componente que A1
listou. O que resta nelas são P3 de acabamento, registrados na tabela acima
(legenda do gráfico, altura do SVG, tom de lead time na cobertura) — nenhum
muda composição, e todos cabem no passe visual global (D37).

O que resta é a fila **D13 em diante**: 24 superfícies ainda não migradas.

## Última fatia concluída

**A2 — acabamento das superfícies migradas.** Cinco itens de componente, todos
sem inventar dado, e três achados que valeram registro (D-247).

**A paleta de comando virou o `.command` do frame:** 520px encostados a 16vh,
cabeçalho "BUSCAR NA SPEED BIKERS" com ✕, campo com a lupa e um `ESC`, e os
resultados **agrupados por tipo** sob rótulo monoespaçado, cada linha com `↵`.
O agrupamento não é enfeite: `search_entities` devolve até 5 por tipo, então a
lista plana repetia "SKU" cinco vezes. O placeholder passou a nomear o que a
RPC realmente busca — o texto do frame prometia "ação", que não está na união.

**Os filtros salvos saíram do `window.prompt`.** O modal mostra o recorte antes
de nomear ("Serão salvos 2 parâmetros da URL: days=7 · account=e2e-loja"), que
é o que o prompt do navegador nunca disse — a doutrina do painel de conferência
de D-127, em escala menor. As visões viraram um `.sb-menu`, e com isso a última
pílula de raio 999px saiu do app.

**O selo "Curva A" entrou no cabeçalho do SKU** (D-247). `get_sku_abc_curve`
ganhou `p_sku_id` **depois do ranking** — provado com três SKUs numa transação
revertida: pedindo só a cauda, ela volta C com acumulado 100,00, idêntico ao da
curva inteira. O custo da leitura (~196 ms medidos em D-166) está declarado no
código, com a saída registrada caso pese.

**Dois defeitos que só a tela mostrou.** A faixa de KPIs deixava uma **fatia
cinza** quando cinco células caíam em três colunas: o truque de `gap` sobre
fundo de borda exige a grade cheia, e A1 tinha trocado o `auto-fit` por colunas
fixas. Agora os fios são sombra da célula e a última fecha a linha. E
`.sb-empty` pedia `--sb-space-6`, que **não existe** — variável indefinida
invalida a declaração inteira, então todo estado vazio estava com `padding: 0`.

**Verificação:** `check` 29/29, build 8/8, integração 583/583, Playwright 25/25
sobre seed limpo, `check:waterfalls`, `check:server-actions`, `docs:check`. A
paleta, o modal e o SKU foram dirigidos no navegador (login real, busca com
resultado, visão salva e apagada) e capturados.

## Próxima fatia segura

**D14 — Estoque (`/estoque`).** Volta às telas de tabela, que são o resto da
fila. O design system já está completo para elas: `.sb-table`, `.sb-input`,
`.sb-menu`/`FilterMenu`, `.sb-status`/`tone.ts`, `.sb-empty`, `Panel`,
`PageTitle`, `KpiStrip` e `.sb-modal`. Antes de desenhar, conferir o que
`/estoque` mede hoje contra o frame `Inventory` (App.tsx@2954) e registrar cada
célula que o sistema não observa — o mesmo procedimento que pegou o grão errado
do Full em D13.

Depois, pela fila: Cobertura/Reposição, Curva ABC, Movimentações, NF-e,
Compras, Fornecedores — todas candidatas naturais a adotar `.sb-table` e apagar
os consts inline ao migrar.
