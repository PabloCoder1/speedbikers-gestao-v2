# Trechos tirados do HANDOFF em 2026-10-14

> Movidos de `docs/HANDOFF.md` para abrir espaço no budget de 25 KB do `docs:check`
> (D-177). Eram estado de setembro, já entregue; ficam aqui como história, sem edição.

`/precos` está pronta para integração na branch de produção `main`: o histórico mantém a RPC paginada, os filtros e a exportação existentes, com toolbar de busca e período, recorte explícito, estados de erro/vazio recuperáveis e tabela adaptada para mobile. Não houve alteração de banco ou backend. Verificação local: `pnpm run check`, `pnpm run build` e `pnpm docs:check`.

Diagnóstico do anúncio e do SKU: D-389 e D-390, migrations `20260921121405`, `20260921130000` e
`20260921144813` — **as três aplicadas no Dev** (conferido em 23/09; a linha anterior dizia que a
de hash aguardava publicação, e não aguardava mais).

