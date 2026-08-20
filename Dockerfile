# syntax=docker/dockerfile:1
#
# Imagem única para `apps/api` e `apps/worker`.
#
# Um Dockerfile parametrizado em vez de dois quase idênticos: cópias divergem,
# e a divergência aparece justamente quando um dos dois quebra em produção.
#
#   docker build --build-arg APP=api    -t sb-api .
#   docker build --build-arg APP=worker -t sb-worker .
#
# O contexto de build é a RAIZ do repositório, porque o pnpm precisa do
# workspace inteiro para resolver as dependências `workspace:*`.

ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
# `corepack enable` lê `packageManager` do package.json e ativa a versão exata
# do pnpm — a mesma usada localmente e na CI.
RUN corepack enable

# ---------------------------------------------------------------------------
FROM base AS build

ARG APP
RUN test -n "${APP}" || (echo "build-arg APP é obrigatório (api|worker)" >&2 && false)

WORKDIR /repo
COPY . .

RUN pnpm install --frozen-lockfile

# `--filter=@sb/<app>...` constrói o app E suas dependências de workspace.
RUN pnpm turbo run build --filter=@sb/${APP}...

# `pnpm deploy` monta um diretório autossuficiente com o app e apenas as
# dependências de produção, com os packages do workspace já resolvidos.
RUN pnpm --filter=@sb/${APP} deploy --legacy --prod /app

# ---------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /app ./

# Nunca rodar como root. O Cloud Run não exige, mas o custo de acertar é zero.
USER node

# O Cloud Run injeta PORT; o app valida com Zod no boot e morre se estiver
# inválido (docs/DEPLOYMENT.md secao 5).
EXPOSE 8080

CMD ["node", "dist/index.js"]
