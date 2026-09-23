#!/bin/sh
# Ignored Build Step da Vercel, chamado por apps/web/vercel.json.
# Logica INVERTIDA da Vercel: saida 0 PULA o build, saida 1 CONSTROI.
#
# O que pula: previa de branch de feature no projeto de PRODUCAO
# (speedbikers-prod). So isso. Continuam construindo:
#
#   - todo deploy do projeto do Dev (speedbikers-gestao-v2-m71j), que e onde
#     a previa de PR e usada para revisar contra o banco do Dev;
#   - no projeto de producao, a main (e a previa DELA que o dono promove para
#     producao, D-348), a v3 e o nome antigo da main, fix/guardas-prod-d348,
#     renomeada para main em 23/09/2026 (fica para commit antigo reconstruido);
#   - qualquer deploy de producao.
#
# Por que: medido em 17/09, o speedbikers-prod fazia ~45 builds por dia, 20
# deles de branch de feature, que ninguem abre -- a api de producao so aceita
# a origem speedbikers-prod.vercel.app, entao a previa nem conversa com ela.
# Cada build ocupa a fila de builds do time e conta minuto de build.
#
# Falha ABERTA: sem as variaveis de sistema da Vercel, constroi -- exatamente
# o comportamento de antes (`exit 1`). Um erro aqui nunca some com o build
# que o dono promove.
#
# Testes: apps/web/scripts/vercel-ignore.test.sh (roda na CI, job `scripts`).

PROJETO_PRODUCAO="prj_P0cBsZLO50eoZ2OIbjFP0vqV9k6p"

if [ "${VERCEL_PROJECT_ID:-}" = "${PROJETO_PRODUCAO}" ] && [ "${VERCEL_ENV:-}" = "preview" ]; then
  case "${VERCEL_GIT_COMMIT_REF:-}" in
    main | v3 | fix/guardas-prod-d348 | "")
      ;;
    *)
      echo "speedbikers-prod: previa de '${VERCEL_GIT_COMMIT_REF}' nao e construida (so main e v3)."
      exit 0
      ;;
  esac
fi

exit 1
