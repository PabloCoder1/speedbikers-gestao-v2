# Sistema de UX — carregamento, estados e retorno de interação

> Documento do **Agente 3** (UX/UI, design system, carregamento, acessibilidade e
> performance percebida), aberto em 2026-10-14. **Só o AGORA:** o padrão em
> vigor, a auditoria com o que falta e a fila. O porquê de cada padrão vira
> `D-5xx` (faixa do Agente 3, combinada com A1 e A2), e a medição vai junto da
> decisão. A aparência (cores, tipografia, componentes do Figma) continua em
> `docs/DESIGN_IMPLEMENTATION.md`.
>
> **Coordenação:** A3 edita `apps/web` só em componentes compartilhados de
> carregamento/estado, no CSS desses blocos e nas telas que o Agente 2 não tem
> em branch aberta (`docs/MULTICHANNEL_HANDOFF.md`, seção "Agente 3"). Não muda
> dado, consulta, parâmetro de URL nem regra de negócio.

---

## 1. O padrão de carregamento — cinco situações, um componente para cada

| Situação | O que a pessoa vê | Componente | Desde |
|---|---|---|---|
| **Trocar de tela** (o caminho muda) | a tela anterior FICA, com o sinal da atualização no lugar: o link clicado esmaece, a barra da moldura aparece aos 100 ms e o conteúdo esmaece aos 400 ms; a moldura nunca sai (é do layout) | `IndicadorDeNavegacao` no `Shell` (todo link interno) e `CarregandoSeODemorar` nos links da sidebar → `AtualizandoTela` | **D-512** (até ela, `loading.tsx` por pasta, D-382) |
| **Carga inicial** de uma tela (primeira visita, recarga) | o esqueleto com a moldura, no lugar do que vai chegar | `app/loading.tsx`, acima do layout do grupo `(app)` → `CarregandoTela` | D-382, D-512 |
| **Bloco lento** dentro de uma tela montada | esqueleto só daquele painel, com a altura do que vem (o cabeçalho real fica) | `<Suspense fallback={<CarregandoBloco/>}>`, ou um esqueleto próprio quando o bloco tem forma conhecida (`AtencaoCarregando` da Home); um **selo** lento do cabeçalho de entidade chega depois no lugar reservado (`ObjectBadgeTardio` + `SeloCarregando`, a curva ABC do SKU); uma **célula** lenta da faixa, idem (`KpiCellTardia` + `KpiCellCarregando`, a taxa de cancelamento da `/vendas`) | D-382, D-504, D-505, D-509 |
| **Atualizar a mesma tela** (filtro, busca, paginação, aba, "ver lista") | o dado velho FICA; o controle clicado esmaece na hora, barra em 100 ms, conteúdo esmaecido em 400 ms, `aria-busy` | `LinkDeFiltro` (o `<Link>` com `CarregandoSeODemorar`), `ItemDeMenu`, `FormularioFiltro` → `AtualizandoTela` | **D-500**, D-501 |
| **Ação que grava** (salvar, assumir, remover) | o botão desabilita, põe `aria-busy` e diz o que está fazendo ("Removendo…") até a resposta | `BotaoEnviar` (ação de servidor, `useFormStatus`); nos formulários de cliente, o rótulo do botão que corre | **D-502** |

**Regras** (valem para tela nova e para quem mexer numa existente):

1. Nenhum carregamento novo fora desta tabela. O que faltar evolui o componente
   da linha certa.
2. O pendente é o da operação real — `useLinkStatus`, a transição do
   `router.push`, o `pending` da ação. Nada de temporizador para "mostrar que
   carregou"; o atraso de 100/350/400 ms é só para não piscar.
3. Atualizar não é carregar: na mesma tela, o dado válido nunca é escondido.
4. Filtro e busca são navegação suave (`LinkDeFiltro`, `ItemDeMenu`,
   `FormularioFiltro`) — `<a href>` e `<form method="get">` recarregam o
   documento inteiro. `<a>` só para download e destino externo. A guarda
   `check:navegacao-suave` reprova os dois; as telas que faltam estão na lista
   de pendências dela, com o motivo.
5. `prefers-reduced-motion`: nada corre, mas o aviso continua (barra parada,
   esmaecimento sem transição, giros mais lentos).
6. Tela autenticada mora em `app/(app)/` e NÃO tem `loading.tsx`: o React só
   troca um esqueleto mostrado pelo conteúdo 300 ms depois, e isso travava toda
   troca de tela (D-511). Bloco lento vai num `Suspense` dentro da tela
   (`check:loading`, D-512).
7. Rolagem lateral se mede no `.sb-content`, pela borda INTERNA (sem o respiro:
   texto que invade o respiro num sistema sai dele em outro) — quem rola é o `<main>`, e o
   `<html>` diz sempre que não rola —, com celular emulado (barra
   sobreposta). E tabela larga vai num contêiner que rola: o `.sb-panel` tem
   `overflow: hidden`, e a tabela solta some pela borda. Tela nova com forma
   nova entra na lista de `e2e/tela-estreita-e-acessibilidade.spec.ts` (D-510).

**Quando não há tabela para mostrar**, a forma é uma só: `EstadoDaTela`
(D-502). `erro` = a leitura falhou (o dado pode existir; é o único com
`role="alert"`, com o detalhe técnico sanitizado e "Tentar de novo"); `vazio`
= leu e não há nada (diz quando passa a haver); `filtro` = há dados, não neste
recorte (oferece "Limpar filtros"); `permissao` = o papel não alcança (diz o
papel e o caminho de volta). Ausência de dado nunca vira "nenhum": falha de
leitura é `erro`, não `vazio`.

---

## 2. Auditoria de 2026-10-14 (Etapa 1)

Feita no código da `main` (`05537181`), com duas varreduras paralelas
(interação e estados especiais) e medição num build de produção com banco
isolado. Gravidade: **P1** = perceptível em toda sessão; **P2** = consistência e
robustez; **P3** = acabamento.

| # | Achado | Evidência | Grav. | Situação |
|---|---|---|---|---|
| 1 | Opção de menu de filtro era `<a>`: cada escolha recarregava o documento | `FilterMenu` (63 usos em 26 arquivos), `SeletorMarketplace` (7), `SavedFilters` (4) | P1 | **corrigido** (D-500) |
| 2 | Busca GET recarregava o documento | 25 `<form method="get">` | P1 | **corrigido** em 18 dos 25 (`/estoque` na D-500, 17 na D-501); 7 nas telas pendentes do A2 |
| 3 | Atualização na mesma tela trocava a tela inteira pelo esqueleto após 350 ms | `CarregandoSeODemorar` (~100 usos) | P1 | **corrigido** (D-500) |
| 4 | `Shell` dentro de cada página: toda troca de tela refaz as 7 leituras do cabeçalho, desmonta sidebar e barra superior, reassina o Realtime das notificações, perde a rolagem do menu (contornada em `nav.tsx`) e o estado do Copiloto; o esqueleto repete as classes do shell e já armou 3 testes e2e | 56 `page.tsx`, 94 `<Shell>` | P1 | **proposta ao dono** (§4) |
| 5 | `<Link>` de mesma tela sem sinal nenhum durante a espera | 45 links: `/atendimento` (3 telas), `/full`, `/produtos`, abas de `/anuncios/[itemId]`, `/faturamento` Todos, outros 8 | P1 | **corrigido** (D-501, `LinkDeFiltro`) fora das telas pendentes; os grupos de filtro de `/produtos` ficam com o A2 |
| 6 | `<a>` cru em ordenação, chips e paginação | 25 em `/anuncios`, `/anuncios/shopee`, `/vendas/shopee` | P1 | **corrigido** (D-501) |
| 7 | Erro de leitura em 7 formas visuais diferentes; `error.message` cru na tela | parágrafo inline (17 arquivos), `AVISO` (28 usos), `.sb-note-perigo` (~20), cartões por módulo (5 classes), caixa tracejada (5), `.sb-empty` vermelho (6), `.sb-skud-danger` (13); mensagem crua em 38 arquivos, só ~10 sanitizam | P2 | **corrigido** em 19 telas (D-502, `EstadoDaTela`); sobram as telas da fila do A2 e a constante `AVISO` de `central/*` e `faturamento/*` |
| 8 | Falha de leitura mostrada como "nenhum" | `/vinculacoes` (vínculos e contas), `/usuarios` (histórico de acesso), `/curva-abc` (opções), `/compras/novo`, `/diagnostico`, `/skus/[skuId]` | P2 | **resolvido pelo A2** (T-R6, #175 e #180): as seis telas dizem a falha, e desde a D-468 (#192) com o `EstadoDaTela` e "Tentar de novo" na mesma URL |
| 9 | Estado vazio sem distinguir "sem dado" de "filtro sem resultado" | `.sb-empty` em 94 usos/45 arquivos + ~15 classes por módulo; só 9 telas oferecem "limpar filtros" dentro do vazio | P2 | **corrigido** nas mesmas 19 telas (tipos `vazio` × `filtro`, com \"Limpar filtros\") |
| 10 | Acesso restrito sem caminho de volta nem papel ARIA, e 6 telas com tratamento próprio | `AcessoRestrito` (9 telas) | P2 | **corrigido** (D-502): título da tela no cabeçalho, estado de permissão e \"Ir para o início\" |
| 11 | Ação sem proteção contra duplo envio ou sem rótulo de pendente | `/central/metas` (remover), `/central/limites` (voltar aos padrões), upload de NF-e reabilita antes de navegar, vincular anúncio; 5 botões desabilitam sem dizer nada | P2 | **corrigido** (D-502, `BotaoEnviar` e rótulos de pendente); o \"Sair\" do cabeçalho fica como está (D-508): POST HTML idempotente, com o progresso do navegador |
| 12 | Três animações de giro e 8 giros locais; textos de espera sem vocabulário comum | `sb-girar`, `sb-pco-girar`, `sb-vnc-girar` | P2 | **corrigido** (D-503): as três animações viraram `sb-girar`; os giros locais ficam, cada um com a sua velocidade |
| 13 | `role="alert"` em conteúdo estático renderizado no servidor — o leitor de tela anuncia como alerta a cada carga | 191 usos em 111 arquivos | P2 | **reavaliado** (D-503) e **fechado pelo A2** (D-470/D-472): os de falha real ficam como alerta; o \"Período personalizado inválido\" virou `role=\"status\"` nas oito telas que o mostram |
| 14 | Só 10 de 58 páginas têm `Suspense` interno; as mais pesadas esperam todas as leituras para pintar qualquer coisa | `/skus/[skuId]` (2.123 linhas), `/anuncios/[itemId]`, `/anuncios`, `/sincronizacao`, Home | P2 | **Home feita** (D-504: Suspense na "Atenção necessária" e pausados em contagem direta); **SKU feito** (D-505: só o selo da curva ABC espera); **`/vendas` feita** (D-509: só a célula da taxa de cancelamento espera); **medido** (D-503): o LCP real de produção aponta Home (7,6 s), `/skus/[id]` (5,9 s) e `/vendas` (3,3–4,7 s); as três telas da medição estão feitas |
| 15 | Dois giros da NF-e sem regra de movimento reduzido | `.sb-nf-girando`, `.sb-nf-estado-doc-icone-girando` | P3 | **corrigido** (D-500) |
| 16 | CSS duplicado | `.sb-full-state*` ≡ `.sb-inbox-state*`; `.sb-vnc-vazio` e `.sb-sync-empty` definidos duas vezes | P3 | **corrigido**: as 13 famílias de estado por módulo saíram (59 regras, D-502); `.sb-vnc-vazio` era um defeito visível na busca de SKU, corrigido em D-503; `.sb-sync-empty` não era duplicado |
| 17 | "Tentar de novo" × "Tentar novamente" | 7 × 3 | P3 | **corrigido** (`TENTAR_DE_NOVO`, D-502) |

**Acessibilidade, auditada em 15/10 (D-508)**, no navegador do Playwright e
sem dependência nova, em 20 telas do build local:

| Regra | Resultado |
|---|---|
| Um h1 por tela; nível de título sem pulo | um h1 em todas; um pulo (h1 → h3 na `/acoes`, a fila sem h2) — **corrigido** |
| Regiões (`main`, `nav`, `header`) | presentes em todas |
| Nome acessível de todo controle visível; rótulo de campo | nenhum controle sem nome, nenhum campo só com placeholder |
| Imagem sem `alt`; id repetido | nenhum |
| Contraste AA | nenhuma falha real; os alertas eram texto claro sobre gradiente (sidebar 8,2–14:1, cartão-âncora 5,2–16,9:1) |
| Paradas de Tab até o conteúdo | 42 em todas as telas → **"Pular para o conteúdo"**: Tab + Enter |
| Rolagem lateral a 390 px (celular, no `.sb-content`) | 3 de 56 rotas rolavam — Home 106 px, `/central/metas` e `/faturamento` 8 px — **corrigidas** (D-510) |
| Foco visível | os 9 `outline: none` têm anel no contêiner ou são a única entrada de um diálogo |

Desde a D-510, as regras viraram guarda de e2e
(`e2e/tela-estreita-e-acessibilidade.spec.ts`, 22 rotas): tela estreita, h1,
títulos, nomes, `alt`, ids e o primeiro Tab. O contraste fica fora — a medida
por `background-color` não enxerga gradiente, e guarda que alarma em falso vira
ruído.

**O que a auditoria conferiu e está certo:** `app/error.tsx` usa `retry` (é a
API do Next 16.3, conferida em `docs/01-app/.../error.md`); `loading.tsx`
cobre as 59 pastas com página; o esqueleto não inventa dado da organização.

---

## 3. Fila (Etapas 3 a 5)

Em ordem de impacto por custo. Cada item é uma fatia com medição antes/depois.

1. ~~**Atualização no lugar no resto do app**~~ — **feita** (D-501): 17
   buscas, 27 `<a>` e 41 `<Link>` em 22 arquivos, com a guarda
   `check:navegacao-suave` e o `e2e/atualizacao-no-lugar.spec.ts`. Sobram as
   telas da lista de pendências da guarda (`/central`, `/central/produtos`,
   `/compras`, `/curva-abc`, `/reposicao`, na fila do A2) e os grupos de filtro
   de `/produtos` — quem tocar nelas troca pelo componente e tira da lista.
2. ~~**Botão pendente compartilhado**~~ — **feito** (D-502, `BotaoEnviar`).
3. ~~**`EstadoDaTela`**~~ — **feito** (D-502) em 19 telas, nos seis avisos
   da T-R6 (D-468, #192) e nas telas da fila do A2 (D-470/D-472, #197), que
   também fechou o item 13 (o período inválido como `role="status"`).
4. ~~**Shell num layout**~~ — **feito**: medido na D-511 e migrado na D-512 —
   a troca de tela foi de 336 para 102 ms sem atraso no banco (255 com 30 ms por
   chamada), com 6 leituras a menos por troca.
5. **Streaming nas telas pesadas** (item 14) — a ordem vem do LCP de
   produção (§5): Home, `/skus/[id]`, `/vendas`. **Home feita (D-504):** a
   "Atenção necessária" espera sozinha a segunda rodada; indicadores e gráfico
   de 3.220 para 209 ms com a cobertura atrasada em 3 s no banco de teste; e os
   "Anúncios pausados" deixam a `get_listings_dashboard` (a leitura fria mais
   pesada, medida pelo A1) por uma contagem direta na primeira rodada. **SKU
   feito (D-505):** a curva ABC, a leitura mais cara da aba padrão, só alimenta
   o selo "Curva X" — e agora só ele espera, no lugar reservado; cabeçalho e LCP
   de ~3,1 s para ~0,2–0,5 s com a curva atrasada em 3 s, CLS 0. **`/vendas`
   feita (D-509):** as duas `get_sales_expanded_summary` (3,8 s e 0,9 s a
   frio, A1) só alimentavam a 5ª célula da faixa âncora, a taxa de
   cancelamento — agora só ela espera; faixa e gráfico de ~3,3 s para ~0,45 s
   com a leitura atrasada em 3 s, CLS 0. A receita continua a mesma para a
   próxima tela que a medição apontar: streaming só onde a lentidão medida
   está, esqueleto do mesmo tamanho e o sim do dono da tela.
6. ~~Um giro só e a limpeza do CSS duplicado~~ — **feitos** (D-502, D-503).
7. ~~**Acessibilidade dos compartilhados**~~ — **feita** (D-508): o "Pular
   para o conteúdo" e o h2 da `/acoes`; e a guarda de e2e, com a tela
   estreita junto (D-510), que corrigiu a Home e a `.sb-pair-grid` no celular.

---

## 4. Proposta estrutural — o `Shell` num layout (feita: D-511 e D-512)

**Feita.** O dono escolheu medir antes (D-511): o ganho maior não era o
`Shell`, e sim a trava de ~300 ms que o React põe depois de mostrar um
esqueleto — e as duas coisas só andam juntas, porque o `loading.tsx` da raiz
dispara em toda troca de primeiro nível. Aprovada, a migração (D-512) pôs o
`Shell` em `app/(app)/layout.tsx`, tirou os `loading.tsx` do grupo e deu a
toda troca de tela o sinal da D-500. O texto abaixo é a proposta como foi
escrita em 14/10.

**Problema medido no código:** o `Shell` é um Server Component chamado por cada
`page.tsx`. Um `layout.tsx` persiste entre navegações; uma página não. Por isso
cada troca de tela: refaz as 7 leituras do cabeçalho (usuário, organização,
não lidas, preferências, contas, atendimentos, perfil) antes de responder;
desmonta e remonta sidebar, barra superior, gaveta do Copiloto e toasts
(reassinando o canal Realtime); e obriga o `loading.tsx` a desenhar uma moldura
falsa, com o menu sem o papel e o perfil em branco.

**Proposta:** `app/(app)/layout.tsx` com o `Shell`; as pastas autenticadas
entram no grupo (a URL não muda) e as páginas deixam de embrulhar o próprio
conteúdo. O `loading.tsx` passa a desenhar só o miolo.

**Custo e risco:** toca as 56 páginas — conflito com toda branch aberta de tela.
Os contadores do cabeçalho deixam de se atualizar a cada navegação (o de
notificações já tem Realtime; os outros dois precisam de `router.refresh` nos
pontos que os mudam). **Combinado com o A2:** só depois de #164, #165 e #167
mergeados, com aviso antes.

**Ganho esperado (a medir na fatia, não prometido):** hoje a página espera as
leituras dela e SÓ DEPOIS o `Shell` faz as dele — uma ida em série a menos por
navegação entre telas, e moldura que nunca pisca.

---

## 5. A espera medida em produção (web vitals)

A web grava cada carga completa no log da Vercel (`app/web-vitals.tsx` →
`POST /api/vitals` → `web_vital`, só nome, valor, rota e `softNav`). Para ler:
Vercel MCP `get_runtime_logs` no projeto `speedbikers-prod`, `query:
"web_vital"`, janela de 24 h (7 dias estoura o tempo da consulta). Desde a
D-507, uma carga tem uma rota só — a de quando o documento abriu: o TTFB sai na
montagem, o LCP no primeiro clique ou tecla (ou quando a aba se esconde) e o
CLS e o INP quando a aba se esconde. `softNav: true` = a URL (rota ou filtro)
mudou no mesmo documento antes do envio, e o CLS/INP soma as telas que vieram
depois; o CLS da tela é o das linhas com `softNav: false`. Aba aberta em
segundo plano não manda LCP. Sem sessão, o `proxy` desvia o envio para o login:
de `/login` só chega o que sai depois de entrar (o CLS).

**Corte do reporter (D-507).** Linha **com** `softNav` é do reporter novo;
**sem** ele, do antigo, que dava ao LCP e ao CLS a rota em que a aba se
escondeu — leia essas pelo par com o TTFB anterior (D-506). O corte é o
primeiro deploy de produção com a D-507: data e `dpl_` **a preencher no
deploy** (`list_deployments`). Aba aberta antes dele manda o formato antigo até
recarregar: conte pelo campo, não pelo horário.

**Como ler as linhas sem `softNav` (D-506).** Até a D-507, o TTFB saía na
montagem, com a rota **carregada**, e LCP e CLS saíam quando a aba se escondia,
com a rota **daquele momento** — depois de uma navegação suave, o log punha o
LCP da carga na rota de destino. Então: pareie cada LCP/CLS com o
TTFB anterior (é ele que diz qual tela abriu do zero); conte a janela "depois
do deploy" pelo horário do TTFB, não pelo `dep=` do envio (é o deploy que
recebeu, não o que serviu); e lembre que o CLS soma o documento inteiro,
inclusive as navegações suaves.

Leitura de 13–15/10, antes da D-504, pareada (uma pessoa, poucas cargas): Home
com quatro cargas completas, LCP em duas (3,5 e 7,6 s), TTFB de 14 a 169 ms,
CLS 0; `/vendas` com LCP de 1,1, 1,6, 4,7 e 5,9 s; `/faturamento` com uma de
3,3 s; `/skus/[id]` **sem nenhuma carga completa** — o 5,9 s que a D-503 leu
como SKU era uma carga de `/vendas` que terminou num SKU. O TTFB fica abaixo de
170 ms em todas, menos uma `/contas` de 13/10 (1,1 s): o esqueleto chega rápido
e quem demora é a leitura. O CLS de 0,51 é de uma carga de `/vendas` de verdade,
mas pode vir de uma navegação suave dentro dela — por isso não se reproduz numa
carga local (17 telas com CLS 0).

**A causa, medida pelo A1** (15/10, Dev, como `authenticated`): quentes, as RPCs
dessas telas ficam abaixo de 150 ms; o que pesa é o cache frio. Na Home, a
segunda rodada fazia ~14 mil acessos a páginas frias (`get_listings_dashboard` com `p_limit 1`
montava a lista inteira só para contar os pausados; `get_stock_coverage_summary`)
e só começava depois da primeira — desde a D-504, os pausados são uma contagem
direta na primeira rodada e só a cobertura fica na segunda, dentro do Suspense. No SKU, a `get_sku_abc_curve` da aba padrão (5,4 mil
acessos a páginas; desde a D-505 só o selo da curva espera por ela) e, na aba Histórico, a `get_sku_timeline` (~37 mil acessos, ~2,2 mil páginas distintas, para qualquer SKU,
corrigida na D-461 do A1). Os números são **acessos** a páginas (`Buffers: shared hit`), não páginas distintas — o A1 corrigiu em 15/10, e os "MB" que estavam aqui eram acessos × 8 KB. Releia
antes de cada fatia de performance; o número de antes/depois vai para
`docs/PERFORMANCE.md`.

### Antes e depois da D-504 e da D-505 (D-506)

Lido em 15/10, 17:33 UTC. A D-504 está em produção desde 16:44 UTC
(`dpl_G6M3eoVm7f5XtNbAvyjuCJ5R6Zy7`, `691ab024`) e a D-505 desde 17:04 UTC
(`dpl_BFVfoWJJjGKdBL3LjBP8d3z3eMdH`, `27323206`).

| tela | métrica | antes (13–15/10, pareado) | depois |
|---|---|---|---|
| Home | LCP | 3.500 e 7.612 ms (n = 2) | n = 0 |
| Home | TTFB | 13,7, 108,8, 112,9 e 168,7 ms (n = 4) | n = 0 |
| Home | CLS | 0 e 0 (n = 2) | n = 0 |
| `/skus/[id]` | LCP, TTFB, CLS | n = 0 (nenhuma carga completa) | n = 0 |

Nenhum ganho afirmado sem amostra. **Próxima leitura:** 24 h depois de cada
deploy (a da D-504 a partir de 16/10, 16:45 UTC; a da D-505, de 17:05 UTC),
pareada pelo TTFB. No SKU,
conte também o CLS rotulado `/skus/…` sem TTFB lá: o selo tardio da D-505
desloca depois de uma navegação suave, e o deslocamento cai no documento que
veio de outra tela. Se aparecer CLS num SKU sem classe ABC (o esqueleto do selo
some), reabra a reserva de espaço que o A2 sugeriu.
