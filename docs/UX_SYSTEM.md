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
| **Trocar de tela** (um segmento do caminho muda) | moldura na hora; esqueleto e barra só depois de 350 ms | `loading.tsx` por pasta → `CarregandoTela` | D-382 |
| **Carga inicial** de uma tela | o mesmo esqueleto, no lugar do que vai chegar (título, faixa de KPIs, painel) | `CarregandoTela` / `CarregandoConteudo` | D-382 |
| **Bloco lento** dentro de uma tela montada | esqueleto só daquele painel, com a altura do que vem (o cabeçalho real fica) | `<Suspense fallback={<CarregandoBloco/>}>`, ou um esqueleto próprio quando o bloco tem forma conhecida (`AtencaoCarregando` da Home); um **selo** lento do cabeçalho de entidade chega depois no lugar reservado (`ObjectBadgeTardio` + `SeloCarregando`, a curva ABC do SKU) | D-382, D-504, D-505 |
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
6. `loading.tsx` em toda pasta com página, com a moldura (`check:loading`).

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
| 11 | Ação sem proteção contra duplo envio ou sem rótulo de pendente | `/central/metas` (remover), `/central/limites` (voltar aos padrões), upload de NF-e reabilita antes de navegar, vincular anúncio; 5 botões desabilitam sem dizer nada | P2 | **corrigido** (D-502, `BotaoEnviar` e rótulos de pendente); sobra o \"Sair\" do cabeçalho |
| 12 | Três animações de giro e 8 giros locais; textos de espera sem vocabulário comum | `sb-girar`, `sb-pco-girar`, `sb-vnc-girar` | P2 | **corrigido** (D-503): as três animações viraram `sb-girar`; os giros locais ficam, cada um com a sua velocidade |
| 13 | `role="alert"` em conteúdo estático renderizado no servidor — o leitor de tela anuncia como alerta a cada carga | 191 usos em 111 arquivos | P2 | **reavaliado** (D-503): quase todos são falha real e ficam; sobra o \"Período personalizado inválido\" em seis telas do A2, que vira `role=\"status\"` quando ele tocar nelas |
| 14 | Só 10 de 58 páginas têm `Suspense` interno; as mais pesadas esperam todas as leituras para pintar qualquer coisa | `/skus/[skuId]` (2.123 linhas), `/anuncios/[itemId]`, `/anuncios`, `/sincronizacao`, Home | P2 | **Home feita** (D-504: Suspense na "Atenção necessária" e pausados em contagem direta); **SKU feito** (D-505: só o selo da curva ABC espera); **medido** (D-503): o LCP real de produção aponta Home (7,6 s), `/skus/[id]` (5,9 s) e `/vendas` (3,3–4,7 s); falta `/vendas`, depois da fatia do A2 |
| 15 | Dois giros da NF-e sem regra de movimento reduzido | `.sb-nf-girando`, `.sb-nf-estado-doc-icone-girando` | P3 | **corrigido** (D-500) |
| 16 | CSS duplicado | `.sb-full-state*` ≡ `.sb-inbox-state*`; `.sb-vnc-vazio` e `.sb-sync-empty` definidos duas vezes | P3 | **corrigido**: as 13 famílias de estado por módulo saíram (59 regras, D-502); `.sb-vnc-vazio` era um defeito visível na busca de SKU, corrigido em D-503; `.sb-sync-empty` não era duplicado |
| 17 | "Tentar de novo" × "Tentar novamente" | 7 × 3 | P3 | **corrigido** (`TENTAR_DE_NOVO`, D-502) |

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
3. ~~**`EstadoDaTela`**~~ — **feito** (D-502) em 19 telas, e nos seis avisos
   da T-R6 pelo A2 (D-468, #192). Falta: as telas da fila do A2 e o item 13
   (`role="alert"` em aviso que não é falha, como o período inválido da
   `/curva-abc`), tela a tela.
4. **Shell num layout** (§4), se o dono aprovar.
5. **Streaming nas telas pesadas** (item 14) — a ordem vem do LCP de
   produção (§5): Home, `/skus/[id]`, `/vendas`. **Home feita (D-504):** a
   "Atenção necessária" espera sozinha a segunda rodada; indicadores e gráfico
   de 3.220 para 209 ms com a cobertura atrasada em 3 s no banco de teste; e os
   "Anúncios pausados" deixam a `get_listings_dashboard` (a leitura fria mais
   pesada, medida pelo A1) por uma contagem direta na primeira rodada. **SKU
   feito (D-505):** a curva ABC, a leitura mais cara da aba padrão, só alimenta
   o selo "Curva X" — e agora só ele espera, no lugar reservado; cabeçalho e LCP
   de ~3,1 s para ~0,2–0,5 s com a curva atrasada em 3 s, CLS 0. Falta
   `/vendas`, depois da fatia do `EstadoDaTela` do A2 nas telas dele, com a
   mesma receita: streaming só onde a lentidão medida está, esqueleto do mesmo
   tamanho para não deslocar o layout, e o sim do A2.
6. ~~Um giro só e a limpeza do CSS duplicado~~ — **feitos** (D-502, D-503).

---

## 4. Proposta estrutural — o `Shell` num layout (aguarda o dono)

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
`POST /api/vitals` → `web_vital`, só nome, valor e rota). Para ler: Vercel MCP
`get_runtime_logs` no projeto `speedbikers-prod`, `query: "web_vital"`, janela
de 24 h (7 dias estoura o tempo da consulta). Navegação suave não reporta: o
número é de quem abriu a tela do zero.

Leitura de 14–15/10 (amostra pequena): Home com LCP de 7,6 s, `/skus/[id]` com
5,9 s, `/vendas` com 3,3–4,7 s; o resto abaixo de 1 s, e o TTFB sempre abaixo de
150 ms — o esqueleto chega rápido e quem demora é a leitura. Um CLS de 0,51 numa
carga de `/vendas` não se reproduz no build local (17 telas com CLS 0).

**A causa, medida pelo A1** (15/10, Dev, como `authenticated`): quentes, as RPCs
dessas telas ficam abaixo de 150 ms; o que pesa é o cache frio. Na Home, a
segunda rodada lia ~110 MB de disco (`get_listings_dashboard` com `p_limit 1`
montava a lista inteira só para contar os pausados; `get_stock_coverage_summary`)
e só começava depois da primeira — desde a D-504, os pausados são uma contagem
direta na primeira rodada e só a cobertura fica na segunda, dentro do Suspense. No SKU, a `get_sku_abc_curve` da aba padrão (5,4 mil
páginas; desde a D-505 só o selo da curva espera por ela) e, na aba Histórico, a `get_sku_timeline` (~300 MB para qualquer SKU,
corrigida na D-461 do A1). Releia
antes de cada fatia de performance; o número de antes/depois vai para
`docs/PERFORMANCE.md`.
