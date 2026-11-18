# Pedidos já feitos e importação de pedidos anteriores — handoff de coordenação (2026-11-18)

Para o Codex Sentinel e para quem integrar. Decisões: D-760 a D-764 em `docs/DECISIONS.md`.

**Atualização independente de 18/11:** a nota abaixo registra a entrega
original. O catálogo da VM de produção já contém as migrations até
`20261118211000`, conferidas por leitura; #330/#332 ainda aguardam integração
com CI no HEAD publicado. Estado, backups e ensaios:
[integração de compras/importação](2026-11-18_integracao-compras-importacao.md).

## Onde está

- Branch `feat/importacoes-pedidos-ja-feitos`, worktree `.claude/worktrees/pedidos-ja-feitos`.
- Base: `feat/compras-reposicao-inteligente` (PR #330), que por sua vez está sobre `codex/sentinel-audit` (PR #328). Ordem de merge: #328 → #330 → este.
- Nada no Dev nem na produção. Validado só num Supabase local isolado (projeto `sb-pedidos`, portas 586xx).

## O que esta frente assumiu

| Área | Arquivos |
|---|---|
| Banco | `supabase/migrations/20261118210000_pedidos_ja_feitos.sql`, `20261118211000_importacao_pedidos_anteriores.sql` |
| Domínio | `packages/domain/src/purchasing/open-purchase.ts` (+ teste), uma linha em `purchasing/index.ts` |
| Tipos | `packages/db/src/types.ts` (blocos de `purchase_orders`, das 3 tabelas e 11 RPCs; duas `CORRECAO MANUAL`) |
| Web | `app/(app)/reposicao/ja-fiz-pedido.tsx`, `app/(app)/compras/pedidos-ja-feitos-actions.ts`, `app/(app)/compras/importar/**`, `app/(app)/compras/[id]/previsao-e-referencia.tsx`, `lib/open-purchases.ts`, `lib/importacao-pedidos/*` |
| Testes | `packages/db/src/pedidos-ja-feitos.integration.test.ts`, `e2e/pedido-ja-feito.spec.ts`, `e2e/importar-pedidos-anteriores.spec.ts` |

## Pontos de contato com arquivos compartilhados

- **`get_replenishment_overview`** foi recriada com `p_compra` no fim (drop + create). Se o Sentinel mexer nela, parta desta versão: o corpo é o de `20261015070000` mais o CTE `compras` e os filtros.
- **`purchase_order_events_event_type_check`** foi recriada com 4 tipos novos (depois dos de D-724/D-725).
- **`packages/db/src/rls.integration.test.ts`**: 7 nomes na lista versionada de `SECURITY DEFINER` (D-182), cada um com a justificativa de escopo.
- Edições pequenas: `reposicao/page.tsx` (filtro, leitura dos pedidos em aberto, painel na linha), `compras/[id]/page.tsx` (origem, referência, previsão), `compras/page.tsx` (botão), `lib/labels.ts` (eventos), `lib/replenishment-*.ts`, e um bloco `.sb-pjf-*`/`.sb-imp-*` no fim de `globals.css`.
- Decisões D-760 a D-764 e o índice: numeração escolhida acima da D-729 que estava na worktree do Codex.

Nenhum arquivo não commitado do Codex foi tocado, e nenhuma branch ou worktree dele.

## O que não está pronto

- O vínculo automático usa o código exato e o EAN válido. As planilhas reais não estavam nesta máquina, então o layout foi coberto com uma planilha gerada no teste. Os três arquivos (`CONTROLE DE CHEGADA IMPORTAÇÃO- NOVO1.xlsx`, `MODELO PEDIDO IMPORTAÇÃO.xlsx`, `TABELA CODIGO IMPORTAÇÃO FINAL.xlsx`) precisam ser lidos uma vez pela tela antes do uso real, numa pasta fora do repositório.
- A `TABELA CODIGO` é catálogo, não pedido. Usá-la para sugerir o vínculo por código do fornecedor exige cadastrá-la em `supplier_skus` (D-723), o que é uma fatia própria.
- Recebimento parcial já existia (D-724). Integração com NF-e para baixar o trânsito automaticamente não foi feita.
