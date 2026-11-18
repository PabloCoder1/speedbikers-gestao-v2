# Fontes da aplicação

Inter e DM Mono, subconjunto Latin (inclui os caracteres do português),
obtidas da API oficial Google Fonts em 2026-11-18. A Inter v20 devolveu o
mesmo WOFF2 variável para 400, 500, 600 e 700; ele é versionado uma só vez.
DM Mono conserva os arquivos de 400 e 500. Não houve troca de família.

Consulta de origem:
<https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap>
(User-Agent Chrome 120, resposta WOFF2).

Licenças SIL Open Font License 1.1: `Inter-OFL.txt` e `DM-Mono-OFL.txt`,
obtidas de `google/fonts`, diretórios `ofl/inter` e `ofl/dmmono`.

Os arquivos locais eliminam a dependência do build na resposta do Google,
incluindo o erro de parsing de URLs documentado em
<https://github.com/vercel/next.js/issues/99114>.
