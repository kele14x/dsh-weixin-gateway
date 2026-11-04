# Optional full-Host reference; build context is the repository root.
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.5

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh \
    DSH_WEIXIN_CWD=/workspace \
    DSH_PERMISSION_MODE=workspace-write \
    TZ=Asia/Shanghai

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY bin ./bin
COPY src ./src
COPY third_party ./third_party
COPY cordis.patch.yml LICENSE THIRD_PARTY_NOTICES.md ./
COPY examples/docker/healthcheck.mjs ./examples/docker/healthcheck.mjs

RUN chmod +x bin/dsh-weixin.mjs

USER node
WORKDIR /workspace
CMD ["dsh", "web", "--no-open"]
