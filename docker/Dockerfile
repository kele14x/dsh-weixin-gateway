# Build context is the repository root (see compose.yaml).
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.5

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh \
    DSH_WEIXIN_CWD=/workspace \
    DSH_PERMISSION_MODE=workspace-write \
    TZ=Asia/Shanghai

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY . .

RUN chmod +x bin/dsh-weixin.mjs docker/entrypoint.sh \
 && ln -sf /app/bin/dsh-weixin.mjs /usr/local/bin/dsh-weixin \
 && mkdir -p /workspace \
 && chown -R 1000:1000 /app /workspace

USER 1000:1000
WORKDIR /workspace

# The Web UI is optional for WeChat; if enabled it must bind one concrete
# container address (DSH rejects wildcard binds). Published as loopback only.
EXPOSE 3080

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["dsh", "web", "--no-open"]
