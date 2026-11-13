# Auditoria de branches

Inventário iniciado em 2026-11-11 para [PabloCoder1/speedbikers-gestao-v2](https://github.com/PabloCoder1/speedbikers-gestao-v2), com `main` em `d6169205ca0ea51d615d2e70cd0b944b5c491adb`. Segunda revisão em 2026-11-12.

| Resultado no inventário | Branches |
| --- | ---: |
| Preservadas após a segunda revisão | 23 |
| Removidas em 11/11 | 12 |
| Removidas em 12/11 | 106 |
| Total encontrado | 141 |
| Referências remotas após a limpeza | 23 |

## Referências prioritárias

- **main** — branch padrão e fonte do domínio de produção na Vercel. A consulta autenticada encontrou o deploy READY de `d6169205ca0ea51d615d2e70cd0b944b5c491adb`. O GitHub respondeu `Branch not protected` para a proteção tradicional e `[]` para as regras efetivas de `main`. A CI existe, mas o GitHub não exige seus checks para alterar essa branch.
- **v3** — aposentada na documentação, com zero commits exclusivos remotos. Tem exclusão desabilitada, a worktree original em uso com alterações pendentes e é a base do PR [#76](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/76). A política do ambiente GitHub `producao` ainda admite `main` e `v3`. Na versão auditada, o job `origem` do workflow aceita somente `main`.
- **v2-legacy** — ponta preservada pela tag anotada `v2-final`. Há um commit exclusivo em relação à `main` e a referência histórica exige autorização específica para descarte.

## Evidências e limites

- Os 141 nomes e SHAs de `git ls-remote --heads origin` coincidiram com as duas páginas da API de branches. A comparação usa ancestralidade exata por SHA. O número à frente indica commits alcançáveis pela branch e ausentes da `main`. A data da tabela é a mais recente entre o commit da ponta, a atualização do PR de origem e o deploy atribuído à branch, em UTC.
- Foram conferidos 327 PRs paginados, dos quais 13 abertos. PRs abertos contam quando a branch é origem ou destino. O histórico de merge ou de fechamento considera apenas PRs originados no repositório oficial. Os estados ativos consultados no GitHub Actions foram `in_progress`, `queued`, `waiting`, `requested`, todos sem runs.
- No clone compartilhado, a comparação considerou 246 refs locais e 22 branches ligadas a worktrees, inclusive quando uma branch local aponta para a remota por upstream. HEAD destacado no mesmo SHA e divergência local foram cruzados separadamente. As referências operacionais foram buscadas nos workflows, em `infra/` e nos handoffs e guias ativos de deploy e marketplaces. Clones de outras máquinas e links privados externos estão fora dessa observação.
- O GitHub retornou 1.563 deployments nas páginas consultadas. Os 161 com nome de branch referem-se à `main` ou à `v3`. Os demais usam SHA, o que cobre a ponta exata, mas não atribui todos os previews à branch. O inventário da Vercel do projeto acessível `speedbikers-prod` retornou 686 deployments e 265 aliases. O domínio configurado não está amarrado a uma branch específica e o projeto não tem ambientes personalizados. Deploy READY, em andamento ou com alias Git identificado foi motivo para preservar. [GitHub Deployments](https://docs.github.com/en/rest/deployments/deployments) · [URLs de deploy da Vercel](https://vercel.com/docs/deployments/generated-urls)
- Tráfego configurado no Cloud Run em `southamerica-east1` por consulta de serviço e revisão. Produção usa `api-00038-qsf` e `worker-00056-wjk`, ambos em `dc69d1fb`. Dev usa `api-00042-8wd` em `da130c0` e `worker-00053-z26` em `1dc83ee`. Nenhuma ponta elegível coincide com esses commits. A configuração de tráfego descreve o destino.

## Aliases residuais reavaliados

A busca inicial por branch retornou zero deployments para as seis refs abaixo. Em 12/11, os sete aliases ainda tinham registro, com `redirect=null`, e as sete consultas autenticadas dos destinos retornaram `404 Deployment not found`. O redirecionamento observado antes para a autenticação da Vercel era da proteção do hostname. As seis refs foram removidas após confirmar os demais critérios. Os registros de aliases permanecem na Vercel.

| Branch | Aliases registrados |
| --- | --- |
| `docs/producao-d414` | `speedbikers-prod-git-docs-producao-d414-pablocoder1s-projects.vercel.app` |
| `feat/backfill-user-product` | `speedbikers-prod-git-feat-backfill-5d1d08-pablocoder1s-projects.vercel.app` |
| `feat/curva-abc-excel` | `speedbikers-prod-git-feat-curva-ab-c816d1-pablocoder1s-projects.vercel.app`, `speedbikers-prod-git-feat-curva-abc-excel-pablocoder1s-projects.vercel.app` |
| `feat/notificacao-alertas-central` | `speedbikers-prod-git-feat-notifica-ed2b20-pablocoder1s-projects.vercel.app` |
| `fix/log-ml-sem-404` | `speedbikers-prod-git-fix-log-ml-sem-404-pablocoder1s-projects.vercel.app` |
| `fix/user-product-na-reconciliacao` | `speedbikers-prod-git-fix-user-prod-86a3cc-pablocoder1s-projects.vercel.app` |

## Candidatas e histórico de limpeza

Em 11/11/2026, as 12 referências abaixo foram removidas em uma única operação atômica com lease no SHA de cada ponta. A revalidação conferiu as pontas remotas, integração por ancestralidade, proteção, PRs abertos, worktrees e tags. A etapa anterior verificou deploys e aliases, configurações operacionais e histórico de PRs.

A consulta independente com `git ls-remote --heads origin` confirmou a ausência das 12 branches, 129 refs restantes e presença de `main`, `v3` e `v2-legacy`. Os commits removidos como referências permanecem alcançáveis pela `main` auditada. O SHA da tabela permite restaurar uma referência com `git push origin <SHA>:refs/heads/<nome>`.

## Segunda revisão em 12/11/2026

As 12 exclusões de 11/11 foram reconferidas. Os SHAs continuam alcançáveis pela `main`, com PRs integrados, e as refs permanecem ausentes. A nova consulta encontrou 129 branches, 115 pontas alcançáveis pela `main` e 14 com commits exclusivos. Há 13 PRs abertos, com 15 branches envolvidas como origem ou destino. As 13 branches de origem com commits exclusivos têm PR aberto. A outra ponta exclusiva é `v2-legacy`, preservada pela tag `v2-final`.

As 106 excluídas têm merge confirmado, zero commits exclusivos e ausência de PR aberto, proteção, tag na ponta, checkout associado, alteração local exclusiva, deploy utilizável ou dependência operacional ativa. São 100 da classificação anterior de preservação e seis da fila de aliases residuais. Cada nome, SHA e justificativa foi registrado antes da operação. O dry-run e o push atômico com lease confirmaram as 106 exclusões. Uma segunda consulta `git ls-remote --heads origin` conferiu a ausência das 118 refs removidas nas duas rodadas e os 23 nomes e SHAs restantes. As 106 exclusões incluem 13 branches `docs/` e 16 `fix/`.

Para a verificação foram cruzados 327 PRs, 1.563 deployments GitHub, 686 deployments e 262 aliases do projeto Vercel, 246 refs locais, 31 worktrees, tags, ambientes GitHub e referências do repositório. A Vercel retornou 404 para os sete IDs de deployment dos aliases residuais. O domínio configurado não tem branch específica e o projeto não tem ambiente personalizado. Os dois projetos antigos consultados retornaram 404. O preview de `fix/push-chave` consta como `inactive` no GitHub e `CANCELED` na Vercel.

Os handoffs citavam `chore/sem-outros-restante`, `feat/ux-central-bloco4` e `feat/vendas-por-anuncio-shopee-dados`. São referências de etapas integradas nos PRs #240, #261 e #250. A tela dependente do #250 também entrou na `main` no #251. Os handoffs passaram a apontar aos PRs.

As 23 refs que ficam têm PR aberto (15), vínculo exclusivo com worktree (7) ou finalidade histórica (`v2-legacy`). Entre elas, `v3` também tem proteção ativa, política do ambiente `producao`, preview READY e alterações locais pendentes. O workflow atual exige `main`. As 106 refs sem uso observado foram classificadas com dados do clone, dos chats recentes deste host e dos serviços acessíveis. Clones independentes e links privados externos ficam fora desse recorte.

## Inventário por branch

Rechecagem de 13/11/2026. `git ls-remote` retornou 24 branches, incluindo `codex/sentinel-audit` em `4d94686f`. `main` permaneceu em `d6169205`. O GitHub retornou 13 PRs abertos. A classificação atual tem 13 branches de origem de PR, sete branches integradas ainda vinculadas a worktrees existentes, a branch de trabalho Sentinel, `main`, `v3` e `v2-legacy`. A `v3` continua como base do PR #76.

As sete refs integradas foram cruzadas com os upstreams e caminhos de worktree. `feat/d654-barra-com-nome-longo` (`49a43442`), integrada no PR #325, ainda é upstream de `revisao-325`. As outras seis são `feat/curva-abc-filtros-excel`, `feat/notificacoes-triagem`, `feat/tiktok-fatia1-conexao`, `fix/faturamento-campanhas-visiveis`, `fix/sku-da-venda-pela-variacao` e `fix/web-vitals-rota-da-carga`. Nenhuma exclusão nesta rodada. Os dados de deploy e alias na tabela são da verificação anterior.

À frente e atrás são medidos em relação à `main` auditada. PRs fechados nesta tabela são PRs sem merge.

| Branch | SHA | Última atividade observada (UTC) | À frente / atrás | PRs | Classificação | Evidência |
| --- | --- | --- | ---: | --- | --- | --- |
| `chore/c58-c61-obrigatorias` | `4b0c51e12e11cfa0b4976272e3f5558d95c1449a` | 2026-10-19 | 0 / 246 | integrados #245 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `chore/rpcs-orfas` | `a4164831e4d9ae4ecdc8cf66940ad67e190ef460` | 2026-09-28 | 0 / 723 | integrados #128 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `chore/sem-outros-restante` | `d728be0ad8ef2323315f9a06a189ce7b598ea517` | 2026-10-19 | 0 / 262 | integrados #240 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado e referência de handoff histórica, sem dependência ativa |
| `docs/api-00026` | `39b0f66a1424ff9e13d82880bb11d407d54a0a00` | 2026-10-13 | 0 / 686 | integrados #143 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/d419-publicado` | `38bd68b6a8b0a5fa090b552e6ad9e8037e756be7` | 2026-09-29 | 0 / 713 | integrados #131 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `docs/estado-d471` | `57171921e18e0b134a209fc5a9196abc51387194` | 2026-10-15 | 0 / 394 | integrados #210 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d475` | `62387efdac527334e9447cd418cc36e57f69b251` | 2026-10-16 | 0 / 359 | integrados #216 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d479` | `9625b26ca1b12411ef697ae1246135f06f3d7c88` | 2026-10-16 | 0 / 341 | integrados #223 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d481` | `aedabe6394704b3b56f74f4a031081fef6448442` | 2026-10-16 | 0 / 315 | integrados #228 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d483f2` | `5c954a74470dc045bbbc2b25ff4c6d1105e03636` | 2026-10-16 | 0 / 283 | integrados #235 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d483` | `84aadc28e2fd89cc785ca8227fd7017edea087f7` | 2026-10-16 | 0 / 296 | integrados #231 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d485-d487` | `8061699be2ddf0c35e379152afad971423f9152e` | 2026-10-19 | 0 / 250 | integrados #243 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d489` | `43c1d90bd96284422b081568536a7c8d3ec0c024` | 2026-10-19 | 0 / 226 | integrados #248 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/estado-d493-diagnostico-faturamento` | `dd66c2147d3c3a36699fdb4427e8528b0f96a31d` | 2026-10-19 | 0 / 211 | integrados #253 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/producao-d393-d411` | `12e0fabc99a454669e6e980b4266cc64ed3c5e18` | 2026-09-25 | 0 / 777 | integrados #104 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `docs/producao-d414` | `e1449ee41ceb08bdff01619779912b4166f7fc7c` | 2026-09-28 | 0 / 757 | integrados #114 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `docs/producao-up-janela` | `c78e0d5b1be42260476c341ecd51c590eb8d9cc8` | 2026-09-28 | 0 / 742 | integrados #121 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `docs/shopee-no-ar` | `d5684aa1200a28b2caf7988988d2bc428534568f` | 2026-10-13 | 0 / 690 | integrados #141 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `docs/ux-leitura-1910` | `18b1d9a2b4b28ba4c9af6ab083c7995b5a5815a5` | 2026-10-22 | 28 / 0 | abertos #264 | PRESERVAR | PR aberto #264 · alias Git Vercel (CANCELED) |
| `docs/web-vitals-d504-d505` | `563648f0b0605dc21e474da2558f977e7951b57e` | 2026-10-15 | 0 / 415 | integrados #199 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ads-shopee` | `826dd78a5e0fdaebb9c538bb24dd4d61860f89c6` | 2026-10-14 | 0 / 616 | integrados #166 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ajustes-e-contribuicao-shopee` | `3617bba3513b7862467838f0d2b403e439244089` | 2026-10-19 | 0 / 257 | integrados #241 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ajustes-shopee-resultado` | `227ddc0b1e7fcd0d59a712a64e951e334dd163ac` | 2026-10-16 | 0 / 276 | integrados #238 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/alerta-sincronizacao-parada` | `1ebc3745f0c0fc09c9ac3b9577a41a0ad5b4cfec` | 2026-09-28 | 0 / 735 | integrados #122 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `feat/backfill-user-product` | `9a5eac72ad28f35d645327ebed9baffbe54be9b1` | 2026-09-28 | 0 / 727 | integrados #129 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `feat/busca-shopee` | `b54a1fd96afb97efd8e0a92dc6940c371120160b` | 2026-10-15 | 0 / 436 | integrados #201 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c77-dispersao-de-preco` | `19ba917464f22ac2c3d39d91901c9efe4ece89de` | 2026-10-21 | 0 / 71 | integrados #297 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c79-queda-nas-vendas` | `b4ab558986895f642230af76021c1c79231ce5f8` | 2026-10-21 | 0 / 63 | integrados #301 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c80-c85-anuncios` | `c324ba1539f0c1ef0586cbf1a5aaffc58da4bfac` | 2026-10-22 | 0 / 30 | integrados #313 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c81-preco-da-shopee` | `827cdf20de2f1aa0613656f314455f73868fe251` | 2026-10-22 | 0 / 34 | integrados #308 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c82-avisos-por-loja` | `9ce6757e73c16116d72538cff675cb537297975e` | 2026-10-22 | 0 / 31 | integrados #311 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c83-diagnostico-por-canal` | `e7a80bf80035030196e328079fa327c5e53582a9` | 2026-10-22 | 0 / 29 | integrados #315 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/c84-copiloto-com-a-shopee` | `4c5a8c939352c6debec5811fa0b880f3e02bacb5` | 2026-10-22 | 0 / 27 | integrados #316 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/calculadora-sem-frete-gratis` | `af7da68ef935b70b72aab8850dd338ac277bdfe9` | 2026-10-07 | 0 / 705 | integrados #133 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `feat/campanhas-disponiveis` | `ed32bbf1d58336b3389af125ec8052715ca8590a` | 2026-09-29 | 0 / 711 | integrados #132 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `feat/cascata-protecao-envio` | `81d22ec5964b57783b2d41ec1a920fa27ed7e3aa` | 2026-10-16 | 0 / 292 | integrados #232 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/contas-cadastro-e-saude` | `5487da232ab138e1695193ac3878212f28722f9d` | 2026-09-23 | 1 / 853 | abertos #76 | PRESERVAR | PR aberto #76 |
| `feat/contas-e-lojas` | `35cdf99ea944372fb724e167423e4273b6288116` | 2026-10-19 | 0 / 252 | integrados #242 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/contribuicao-shopee` | `b7eab26ebc266fc3439505e2aa3816736d12771d` | 2026-10-16 | 0 / 274 | integrados #239 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/copiloto-notificacoes` | `87d8b15da21ab41ed0110278a0e71e4f10bc7100` | 2026-09-23 | 3 / 964 | abertos #53 | PRESERVAR | PR aberto #53 · 1 deploy(s) GitHub por ref ou SHA |
| `feat/curva-abc-excel` | `77a6aacaa537bdc920665e2777db25238c5f1bf5` | 2026-10-07 | 0 / 703 | integrados #135 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `feat/curva-abc-filtros-excel` | `15ba662ae6941f6d193925bcfec94bddab351609` | 2026-10-07 | 0 / 699 | integrados #137 | PRESERVAR | worktree `feat/curva-abc-filtros-excel` |
| `feat/curva-abc-multicanal` | `6fc2d32d3c96f7be10fdea7765bc076eba5f8629` | 2026-10-14 | 0 / 630 | integrados #157 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `feat/d495a-fulfillment-shopee` | `74de045bc3a6566b25e0ff874f8113ea62d2d7f7` | 2026-10-19 | 0 / 166 | integrados #263 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d495b-baixa-shopee` | `f9024d4db4eb71178773c60e3e62708ac13fa9ae` | 2026-10-20 | 0 / 164 | integrados #265 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d497b-guarda-venda-marketplace` | `8e70c1d6c62e6ca7059ac8b680e346b12f28b121` | 2026-10-19 | 0 / 173 | integrados #260 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d499-faturamento-pelas-linhas` | `5e0dd6209ec217e1dd3c1b579af468ad54745801` | 2026-10-19 | 0 / 190 | integrados #259 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d499-linhas-de-venda-ml` | `96d26c0b4018a2b04cfbe59c6d99039be3559896` | 2026-10-19 | 0 / 196 | integrados #256 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d603-cancelamento-e-hoje` | `cc45c484f37166e6c9ff0741dcbc28adb6aac6e5` | 2026-10-20 | 0 / 129 | integrados #280 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d617-shopee-prejuizo` | `207915d51cd90dd56cc6c52caa1097416974f58a` | 2026-10-21 | 0 / 108 | integrados #288 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d619-estoque-shopee-fresco` | `fb3f2a86ed6b6906d5073df430c006595d7666a2` | 2026-10-21 | 0 / 106 | integrados #289 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d627-shopee-divergencia` | `d12ffbe8ecc967a73bf25b9d307f62096cdacadf` | 2026-10-21 | 0 / 66 | integrados #299 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d640-precos-com-shopee` | `49f752a3cea672931f2a10b48e4ec33d07ab6ec8` | 2026-10-22 | 8 / 20 | abertos #310 | PRESERVAR | PR aberto #310 · alias Git Vercel (CANCELED) |
| `feat/d642-avisos-por-loja` | `41c7c282897010a18a3f699259ca26dcd3385e64` | 2026-10-22 | 6 / 20 | abertos #314 | PRESERVAR | PR aberto #314 · alias Git Vercel (CANCELED) |
| `feat/d643-venda-anomala-episodio` | `2047e1f55b8515bbd0c372e01fcae51e87b8eec3` | 2026-10-22 | 0 / 26 | integrados #319 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d644-diagnostico-por-canal` | `e0f5645cf605308091aacc26bd0feac0492b015a` | 2026-10-22 | 5 / 20 | abertos #317 | PRESERVAR | PR aberto #317 · alias Git Vercel (CANCELED) |
| `feat/d646-rotulos-do-copiloto` | `017a87ad59b57e831947d1075cdebf0249c20bca` | 2026-10-22 | 0 / 14 | integrados #318 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d648-episodio-no-cartao` | `6fed65f3fc3f74ba37335121885227796ad0a612` | 2026-10-22 | 6 / 20 | abertos #321 | PRESERVAR | PR aberto #321 · alias Git Vercel (CANCELED) |
| `feat/d650-sair-no-celular` | `db413338362e54a473be8f1b8bcaffe002ec795a` | 2026-10-22 | 0 / 12 | integrados #323 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/d652-tiktok-na-contas` | `84a9e5fbdb48c8a292cd8d5ecfb4921d5a35e778` | 2026-10-22 | 4 / 0 | abertos #324 | PRESERVAR | PR aberto #324 · worktree `feat/d652-tiktok-na-contas` · alias Git Vercel (CANCELED) |
| `feat/d654-barra-com-nome-longo` | `49a434424bef5bfebf66992f521e28dff8c1dae1` | 2026-10-22 | 0 / 1 | integrados #325 | PRESERVAR | worktree `revisao-325` · alias Git Vercel (CANCELED) |
| `feat/d656-dia-de-negocio` | `3490d28be6b3fe53905d80ec8e9ea40730aecbd9` | 2026-10-22 | 2 / 3 | abertos #326 | PRESERVAR | PR aberto #326 · worktree `feat/d656-dia-de-negocio` · alias Git Vercel (CANCELED) |
| `feat/devolucoes-shopee` | `d611151c0a5cc63e0d4c217b011cfa9ffdfb1a45` | 2026-10-14 | 0 / 620 | integrados #163 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ensaio-go-live-t9` | `928f955085d9ba12b96aa56944898764549ef037` | 2026-10-16 | 0 / 318 | integrados #226 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/exportar-shopee` | `e266efbe479852dd58aa29725ef77735caa6e2a0` | 2026-10-16 | 0 / 298 | integrados #230 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/faturamento-shopee` | `31d25e0a0f661fd89bfd1ded37c2f1e2e6bb7d9d` | 2026-10-14 | 0 / 670 | integrados #152 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/faturamento-shopee-composicao` | `21feb9e3c7e43846f0fff0c718ec16d100945f7b` | 2026-10-14 | 0 / 627 | integrados #160 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/filtro-promocao` | `dbfe775586ad03c9d781a9897454dc37fb471347` | 2026-09-29 | 0 / 715 | integrados #130 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `feat/filtros-salvos-shopee` | `89d11fafc901770d1f9c890716dd9b03d27da846` | 2026-10-16 | 0 / 280 | integrados #234 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/home-vendas-todos` | `69bccc0a3302c012bfe1d4505c4cef44b6ef3738` | 2026-10-16 | 0 / 310 | integrados #227 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ip-fixo-nat` | `5ada0c78e58e12e1461a690c7c15146915dd0a4a` | 2026-10-15 | 0 / 539 | integrados #178 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/marketplace-accounts-e-vigia` | `30bc6827418a84e6c3172385edb4a7843a028a8d` | 2026-10-14 | 0 / 675 | integrados #150 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/metas-por-marketplace` | `3788cf2a6a02ad3882449f308d8d7ae0b06c77c6` | 2026-10-15 | 0 / 387 | integrados #212 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/navegacao-suave-abc-produtos` | `baa9fc983474b4c39b55d49127330fb7c0ba60d7` | 2026-10-16 | 0 / 332 | integrados #222 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/notificacao-alertas-central` | `721bd79a298dc2755eb2daf47f500aa07d3e05a0` | 2026-09-25 | 0 / 779 | integrados #103 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `feat/notificacoes-triagem` | `a2d95b6497bea8248ea0a26760998595e98b8c71` | 2026-09-25 | 0 / 781 | integrados #77 | PRESERVAR | worktree `feat/notificacoes-triagem` · trabalho local `feat/notificacoes-triagem` (+6) |
| `feat/produtos-multicanal` | `d6713b5e7a1b2b68dd71d9a1f20c061946b863d4` | 2026-10-14 | 0 / 623 | integrados #161 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/protecao-envio-fase2` | `94bc014328b4efa4379afb2980d4039a7f70ff4c` | 2026-10-16 | 0 / 285 | integrados #233 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/protecao-envio-shopee` | `cd268f22a81e9c98fd15c11d1422dd0e477eb5ac` | 2026-10-16 | 0 / 303 | integrados #229 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/push-shopee` | `1a7f6a4cb20afca1ec3739b0eebca0f02c3ae14f` | 2026-10-15 | 0 / 604 | integrados #172 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/repasse-shopee` | `5f0733f680324cd6bc5d0a58135be1d76994373e` | 2026-10-14 | 0 / 614 | integrados #169 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/reposicao-demanda-shopee` | `cf2e65bb06d39e363742019d588efd4b899f3545` | 2026-10-15 | 0 / 517 | integrados #186 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `feat/shopee-conexao` | `79415002ed186b629b0c4a4e83a38da68bc9d6a4` | 2026-10-13 | 0 / 696 | integrados #138 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-financeiro` | `92ffca12425e2bc6c573270f3c042afdc1c1d4ef` | 2026-10-13 | 0 / 692 | integrados #140 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-ingestao-robusta` | `8330fac35a12d47f49da740a74cc4583d43f08cf` | 2026-10-14 | 0 / 677 | integrados #147 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-pedidos` | `626884d30ded96bdf3fbd67756b4c4cf9069aaa6` | 2026-10-13 | 0 / 695 | integrados #139 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-permissao-por-loja` | `58f96753b949a0fa66116a17a64f4d539955e8be` | 2026-10-14 | 0 / 676 | integrados #148 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-produtos` | `6fa8d3ea84cb86e8535f67c33b504c380d3b8569` | 2026-10-13 | 0 / 684 | integrados #144 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-vendas` | `ea44df59372d6d76ea4f3dbdb152707bee5b936b` | 2026-10-14 | 0 / 680 | integrados #146 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/shopee-vinculo-manual` | `5787b096562cd085602fc45d758d8f2a439972b1` | 2026-10-14 | 0 / 682 | integrados #145 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/sku-demanda-shopee` | `2517e5892e34862d270868d88b8700e23e31fbb7` | 2026-10-15 | 0 / 493 | integrados #190 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/templates-resposta` | `7261fc2559feb55f5678a92c3589410e7fb667b7` | 2026-09-23 | 4 / 833 | abertos #74 | PRESERVAR | PR aberto #74 |
| `feat/tiktok-fatia1-conexao` | `8a79adbc9540f685e38e89149123ac3b670cf6b1` | 2026-10-22 | 0 / 5 | integrados #320 | PRESERVAR | worktree `feat/tiktok-fatia1-conexao` · alias Git Vercel (CANCELED) |
| `feat/ux-a11y-vendas` | `c535c8aae4fa280f19d69486396afccbb830a336` | 2026-10-15 | 0 / 435 | integrados #204 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-alertas-e-giro` | `1edc60c0d52fdfa4ffdacaaf389728c5fbee37d4` | 2026-10-15 | 0 / 500 | integrados #189 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-atualizacao-no-lugar` | `77b39790700fb238321420f542716296309e477b` | 2026-10-15 | 0 / 522 | integrados #182 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-central-bloco4` | `301bd8f88c740319cbbfb2e0d872ea1d63769ce3` | 2026-10-19 | 0 / 168 | integrados #261 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado e referência de handoff histórica, sem dependência ativa |
| `feat/ux-central-paginas` | `104ca292a846a61297fe5f8ea5bbc6acbe25020f` | 2026-10-19 | 0 / 177 | integrados #258 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-central-reformulacao` | `e477598b5f224a63bc63113181c07e1dd5521a6b` | 2026-10-19 | 0 / 199 | integrados #255 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-central-streaming` | `e90163a785e4d52bb3350faea2f77c2af1e63f08` | 2026-10-22 | 45 / 0 | abertos #266 | PRESERVAR | PR aberto #266 · alias Git Vercel (CANCELED) |
| `feat/ux-estados-e-acoes` | `a05f5eb5f51d0fcf2687140ece94cbd15745bbbf` | 2026-10-15 | 0 / 503 | integrados #187 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-home-streaming` | `9c7238345a00b90251638fa460c6bfc7d8e65eac` | 2026-10-15 | 0 / 471 | integrados #194 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-loading` | `eef110b1fc6603ac87c0cc0cefbd079eb5cd0157` | 2026-10-15 | 0 / 546 | integrados #176 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-sku-streaming` | `cf84d45f28184bc5e30df88480e52daca2660ddc` | 2026-10-15 | 0 / 462 | integrados #196 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/ux-tela-estreita` | `0db6a6062c2e07f73f8bd57793bd6d99cb63a056` | 2026-10-16 | 0 / 369 | integrados #214 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/vendas-exportar` | `641861636bad88d1408d75cb0d634cbd2f87c562` | 2026-10-19 | 0 / 266 | integrados #236 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/vendas-ml-exportar` | `335e4571b974b61100856456d87b0b1912263ebb` | 2026-10-19 | 0 / 245 | integrados #244 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/vendas-por-anuncio-shopee-dados` | `ff43393b6947b6d3db975a11138632b785a5de04` | 2026-10-19 | 0 / 222 | integrados #250 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado e referência de handoff histórica, sem dependência ativa |
| `feat/vendas-por-marketplace` | `e54b817401e8cf19c5ac5a96b2b4703afe1d4f99` | 2026-10-14 | 0 / 671 | integrados #151 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/vendas-por-sku-multicanal` | `8df5aa48e4ab9e3bdb9805db9f7f5a329816d117` | 2026-10-14 | 0 / 651 | integrados #155 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `feat/vigia-da-sincronizacao` | `75b5bd7d368f63b59967d1f343cefdb930c55bcc` | 2026-09-28 | 0 / 729 | integrados #125 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `fix/ads-sem-retentativa` | `b83572674a7f76019d102705a412203d4c351ebf` | 2026-10-16 | 0 / 377 | integrados #213 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/cascata-sem-outros-restante` | `23b30a17347c5539f1290d63b6bcc4211db20dc3` | 2026-10-19 | 0 / 278 | integrados #237 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/ci-store-path` | `2a5b0a060c8d6ff0a79c9fc6092e08cfcd04699f` | 2026-10-16 | 0 / 363 | integrados #217 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d621-pergunta-apagada` | `fb8021365fbe14e08270ca094443c185c72c2468` | 2026-10-21 | 0 / 91 | integrados #291 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d621b-releitura-na-backfill` | `1acb57fa838499cb645a2129e696f52d76664a40` | 2026-10-21 | 0 / 79 | integrados #296 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d623-cobertura-com-shopee` | `b7b7fa77261307b3cf2eca4f669e79629de2d3f0` | 2026-10-21 | 0 / 87 | integrados #294 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d631-anuncio-apagado` | `b00076581796b1b38fc2ec5dba3b004994d71c0c` | 2026-10-21 | 0 / 58 | integrados #303 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d631b-excluido-fora-das-contagens` | `a62a91f75aa4a9550a4bf39b8662d164de292c64` | 2026-10-21 | 0 / 52 | integrados #304 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/d647-motivo-e-busca` | `122956752c9781f1b3833c890644f9487bc54244` | 2026-10-22 | 0 / 9 | integrados #322 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/deps-next-brace` | `a442e87b21cfc6a2edf1e9ff294fd6088fc88adf` | 2026-10-07 | 0 / 709 | integrados #134 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `fix/faturamento-campanhas-visiveis` | `4fe32ea2451e0da423e9ceb98303d778f47e07c5` | 2026-09-23 | 0 / 844 | integrados #75 | PRESERVAR | worktree `fix/faturamento-campanhas-visiveis` |
| `fix/log-ml-sem-404` | `01e7a856bbfadc3d0a843a392672f797d9b630a9` | 2026-09-28 | 0 / 733 | integrados #124 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `fix/push-assinatura-diagnostico` | `2e5da4fbccfa2556841f5679a7e00b3dbce62272` | 2026-10-15 | 0 / 588 | integrados #179 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/push-chave` | `260a32af6249d6713870756d79259ea39f33c01b` | 2026-10-15 | 0 / 538 | integrados #181 | REMOVIDA EM 12/11 | merge confirmado, preview GitHub inativo e Vercel cancelado, sem dependência ativa |
| `fix/push-segredo` | `6f13e990e3b6c87ed535068d50f71e86dcd48fda` | 2026-10-15 | 0 / 531 | integrados #184 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/renovacao-token-resiliente` | `5b22c9500cb67d912622ec205583bc1ad4a57105` | 2026-09-28 | 0 / 759 | integrados #113 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `fix/shopee-leitura-em-dobro` | `65dd0e0979ef849d8924d3caf156e49e1f16fa77` | 2026-10-16 | 0 / 329 | integrados #224 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/shopee-sandbox-auth` | `8eb777c6d2e72ff7a896cbb29e974b4a2c470007` | 2026-10-13 | 0 / 688 | integrados #142 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `fix/sku-da-venda-pela-variacao` | `51cb4a232821480c39798b0c3cf14ab846fddfae` | 2026-10-07 | 0 / 701 | integrados #136 | PRESERVAR | worktree `fix/sku-da-venda-pela-variacao` |
| `fix/user-product-na-reconciliacao` | `19751675b67e5fb35679af51cd8a83fc748668b3` | 2026-09-28 | 0 / 755 | integrados #119 | REMOVIDA EM 12/11 | merge confirmado, alias sem destino ou preview cancelado, sem dependência ativa |
| `fix/ux-kpi-celular` | `d1dfc328598dbac8580bdec0e1fc8197a0f3bb30` | 2026-10-22 | 2 / 0 | abertos #327 | PRESERVAR | PR aberto #327 · worktree `fix/ux-kpi-celular` · alias Git Vercel (CANCELED) |
| `fix/web-vitals-rota-da-carga` | `740eed7360306349f68223ddfd71a52a595034f3` | 2026-10-15 | 0 / 402 | integrados #200 | PRESERVAR | worktree `fix/web-vitals-rota-da-carga` · alias Git Vercel (CANCELED) |
| `infra/scheduler-retry` | `466fcea04278770db2acd1301d681f4a2bb5e91d` | 2026-09-28 | 0 / 722 | integrados #127 | REMOVIDA | merge confirmado, sem vínculos observados, exclusão verificada |
| `main` | `d6169205ca0ea51d615d2e70cd0b944b5c491adb` | 2026-10-22 | 0 / 0 | abertos #327, #326, #324, #321, #317, #314, #312, #310, #266, #264, #74, #53 | PRESERVAR | branch padrão e web em produção · PR aberto #327, #326, #324, #321, #317, #314, #312, #310, #266, #264, #74, #53 · worktree `chore/next-16-4-1`, `codex/sentinel-audit`, `docs/d423-handoff`, `fix/curva-abc-desempenho` · trabalho local `chore/next-16-4-1` (+1), `feat/ux-vitals-com-elemento` (+2), `main` (+1) · alias Git Vercel (READY) · 171 deploy(s) Vercel READY · 120 deploy(s) GitHub por ref ou SHA |
| `perf/faturamento-shopee-sem-laco` | `e2e5ab59710b681ba9c76716a023af96f7f68e70` | 2026-10-16 | 0 / 343 | integrados #220 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `perf/financeiro-shopee-colunas` | `060e3e930d39210d1e6cc7513310979e2b16e328` | 2026-10-19 | 0 / 239 | integrados #247 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `perf/proxy-getclaims` | `9fa510cf5aac8d5473ceabc2c855db471c1d044f` | 2026-10-22 | 13 / 0 | abertos #312 | PRESERVAR | PR aberto #312 · alias Git Vercel (CANCELED) |
| `test/tela-estreita-multicanal` | `47dfcdf13eef31db2945f766b21601daa6b27321` | 2026-10-19 | 0 / 231 | integrados #249 | REMOVIDA EM 12/11 | merge confirmado, preview cancelado, sem dependência ativa |
| `v2-legacy` | `f877193d17b827a2e7840949d4761e39e435da44` | 2026-08-19 | 1 / 1834 | — | PRESERVAR | tag `v2-final` · 2 deploy(s) GitHub por ref ou SHA |
| `v3` | `a9a91d091ad9d2f61cb2f1084f532a9a52ecffa3` | 2026-09-23 | 0 / 853 | abertos #76 | PRESERVAR | ambiente producao, exclusão vedada · protegida · PR aberto #76 · worktree `v3` · trabalho local `perf/auditoria-v3` (+1), `v3` (+1) · alias Git Vercel (READY) · 9 deploy(s) Vercel READY · 44 deploy(s) GitHub por ref ou SHA |
