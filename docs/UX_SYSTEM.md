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
| **Bloco lento** dentro de uma tela montada | esqueleto só daquele painel | `<Suspense fallback={<CarregandoBloco/>}>` | D-382 |
| **Atualizar a mesma tela** (filtro, busca, paginação, aba, "ver lista") | o dado velho FICA; o controle clicado esmaece na hora, barra em 100 ms, conteúdo esmaecido em 400 ms, `aria-busy` | `CarregandoSeODemorar` dentro do `<Link>`, `ItemDeMenu`, `FormularioFiltro` → `AtualizandoTela` | **D-500** |
| **Ação que grava** (salvar, assumir, remover) | o botão desabilita e diz o que está fazendo ("Salvando…") | por tela hoje; componente compartilhado na fila (§3, item 11) | — |

**Regras** (valem para tela nova e para quem mexer numa existente):

1. Nenhum carregamento novo fora desta tabela. O que faltar evolui o componente
   da linha certa.
2. O pendente é o da operação real — `useLinkStatus`, a transição do
   `router.push`, o `pending` da ação. Nada de temporizador para "mostrar que
   carregou"; o atraso de 100/350/400 ms é só para não piscar.
3. Atualizar não é carregar: na mesma tela, o dado válido nunca é escondido.
4. Filtro e busca são navegação suave (`<Link>`, `ItemDeMenu`,
   `FormularioFiltro`) — `<a href>` e `<form method="get">` recarregam o
   documento inteiro. `<a>` só para download e destino externo.
5. `prefers-reduced-motion`: nada corre, mas o aviso continua (barra parada,
   esmaecimento sem transição, giros mais lentos).
6. `loading.tsx` em toda pasta com página, com a moldura (`check:loading`).

---

## 2. Auditoria de 2026-10-14 (Etapa 1)

Feita no código da `main` (`05537181`), com duas varreduras paralelas
(interação e estados especiais) e medição num build de produção com banco
isolado. Gravidade: **P1** = perceptível em toda sessão; **P2** = consistência e
robustez; **P3** = acabamento.

| # | Achado | Evidência | Grav. | Situação |
|---|---|---|---|---|
| 1 | Opção de menu de filtro era `<a>`: cada escolha recarregava o documento | `FilterMenu` (63 usos em 26 arquivos), `SeletorMarketplace` (7), `SavedFilters` (4) | P1 | **corrigido** (D-500) |
| 2 | Busca GET recarregava o documento | 25 `<form method="get">` | P1 | **corrigido em `/estoque`**; 24 na fila |
| 3 | Atualização na mesma tela trocava a tela inteira pelo esqueleto após 350 ms | `CarregandoSeODemorar` (~100 usos) | P1 | **corrigido** (D-500) |
| 4 | `Shell` dentro de cada página: toda troca de tela refaz as 7 leituras do cabeçalho, desmonta sidebar e barra superior, reassina o Realtime das notificações, perde a rolagem do menu (contornada em `nav.tsx`) e o estado do Copiloto; o esqueleto repete as classes do shell e já armou 3 testes e2e | 56 `page.tsx`, 94 `<Shell>` | P1 | **proposta ao dono** (§4) |
| 5 | `<Link>` de mesma tela sem sinal nenhum durante a espera | 45 links: `/atendimento` (3 telas), `/full`, `/produtos`, abas de `/anuncios/[itemId]`, `/faturamento` Todos, outros 8 | P1 | fila |
| 6 | `<a>` cru em ordenação, chips e paginação | 25 em `/anuncios`, `/anuncios/shopee`, `/vendas/shopee` | P1 | fila (telas do A2) |
| 7 | Erro de leitura em 7 formas visuais diferentes; `error.message` cru na tela | parágrafo inline (17 arquivos), `AVISO` (28 usos), `.sb-note-perigo` (~20), cartões por módulo (5 classes), caixa tracejada (5), `.sb-empty` vermelho (6), `.sb-skud-danger` (13); mensagem crua em 38 arquivos, só ~10 sanitizam | P2 | fila |
| 8 | Falha de leitura mostrada como "nenhum" | `/vinculacoes` (vínculos e contas), `/usuarios` (histórico de acesso), `/curva-abc` (opções), `/compras/novo`, `/diagnostico`, `/skus/[skuId]` | P2 | **A2, PR #175** (T-R6): 5 das 6 telas, com aviso provisório (`.sb-note-perigo`); `/curva-abc` depois do #164/#165 |
| 9 | Estado vazio sem distinguir "sem dado" de "filtro sem resultado" | `.sb-empty` em 94 usos/45 arquivos + ~15 classes por módulo; só 9 telas oferecem "limpar filtros" dentro do vazio | P2 | fila |
| 10 | Acesso restrito sem caminho de volta nem papel ARIA, e 6 telas com tratamento próprio | `AcessoRestrito` (9 telas) | P2 | fila |
| 11 | Ação sem proteção contra duplo envio ou sem rótulo de pendente | `/central/metas` (remover), `/central/limites` (voltar aos padrões), upload de NF-e reabilita antes de navegar, vincular anúncio; 5 botões desabilitam sem dizer nada | P2 | fila |
| 12 | Três animações de giro e 8 giros locais; textos de espera sem vocabulário comum | `sb-girar`, `sb-pco-girar`, `sb-vnc-girar` | P2 | fila |
| 13 | `role="alert"` em conteúdo estático renderizado no servidor — o leitor de tela anuncia como alerta a cada carga | 191 usos em 111 arquivos | P2 | fila |
| 14 | Só 10 de 58 páginas têm `Suspense` interno; as mais pesadas esperam todas as leituras para pintar qualquer coisa | `/skus/[skuId]` (2.123 linhas), `/anuncios/[itemId]`, `/anuncios`, `/sincronizacao`, Home | P2 | fila (medir antes) |
| 15 | Dois giros da NF-e sem regra de movimento reduzido | `.sb-nf-girando`, `.sb-nf-estado-doc-icone-girando` | P3 | **corrigido** (D-500) |
| 16 | CSS duplicado | `.sb-full-state*` ≡ `.sb-inbox-state*`; `.sb-vnc-vazio` e `.sb-sync-empty` definidos duas vezes | P3 | fila |
| 17 | "Tentar de novo" × "Tentar novamente" | 7 × 3 | P3 | fila |

**O que a auditoria conferiu e está certo:** `app/error.tsx` usa `retry` (é a
API do Next 16.3, conferida em `docs/01-app/.../error.md`); `loading.tsx`
cobre as 59 pastas com página; o esqueleto não inventa dado da organização.

---

## 3. Fila (Etapas 3 a 5)

Em ordem de impacto por custo. Cada item é uma fatia com medição antes/depois.

1. **Atualização no lugar no resto do app** — os 45 `<Link>` do item 5 e os 24
   formulários GET do item 2, começando pelas telas sem branch aberta do A2
   (`/atendimento`, `/full`, `/notificacoes`, `/precos`, `/reposicao`,
   `/fornecedores`, `/compras`, `/notas-fiscais`, `/usuarios`,
   `/vinculacoes`); `/anuncios`, `/vendas/shopee`, `/curva-abc`,
   `/faturamento` e `/produtos` quando o A2 liberar. Uma guarda estática
   (`<form method="get">` e `<a href="?` / `href="/rota?`) fecha a porta para a
   volta do padrão.
2. **Botão pendente compartilhado** (`useFormStatus`) para ação de servidor —
   fecha o item 11.
3. **`EstadoDaTela`**: erro, vazio (com e sem filtro), sem permissão — uma
   forma, um vocabulário, a mensagem sanitizada e a ação de recuperação. Fecha 7,
   9, 10, 13 e 17; e troca o aviso provisório do item 8 (o A2 usa a forma nova quando ela existir).
4. **Shell num layout** (§4), se o dono aprovar.
5. **Streaming nas telas pesadas** (item 14): medir quanto cada bloco espera e
   pôr `Suspense` só onde a primeira pintura melhora de fato.
6. Um giro só (item 12) e a limpeza do CSS duplicado (item 16).

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
