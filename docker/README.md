# Docker deployment

The WeChat transport is outbound-only, so the container needs **no published
port** for WeChat. The Web UI is optional and loopback-only here.

## Build and start

```sh
mkdir -p workspace
export DSH_WEIXIN_BIND_CODE='change-me'
docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml up -d
```

`DSH_HOME` is a named volume (`dsh-home`). Keep it: it holds the profile,
credentials, poll cursor, session mappings, and session histories. Replacing it
forces a new QR login.

## One-shot QR login

Login runs in a throwaway container that shares the same volume:

```sh
docker compose -f docker/compose.yaml run --rm -it dsh \
  node /app/bin/dsh-weixin.mjs login
```

- `-it` matters: the terminal QR and the verification-code prompt need a TTY.
- The gateway may be running while you log in; restart it afterwards so it picks
  up the new credential: `docker compose -f docker/compose.yaml restart dsh`.
- `status` and `logout` follow the same pattern:
  `run --rm dsh node /app/bin/dsh-weixin.mjs status`.

## Why the Web UI binds a fixed address

DSH rejects wildcard binds (`--host 0.0.0.0` is an error), and publishing
`127.0.0.1:3080:3080` maps to the container's interface address, not its
loopback. The compose file therefore pins the container to `172.28.0.2` on a
private network and passes:

- `--host 172.28.0.2` — the concrete bind address;
- `--trusted-host 127.0.0.1:3080` — the authority the browser actually uses;
- `--public-url http://127.0.0.1:3080` — the URL printed by DSH.

If you do not need the Web UI, drop the `ports`, `--trusted-host`, and
`--public-url` entries; the WeChat gateway itself is unaffected.

## Healthcheck

`docker/healthcheck.mjs` treats the channel as healthy when a poller holds the
lock and its heartbeat is under two minutes old. It does not probe a socket,
because there is none.

## Outbound egress

Allow HTTPS to:

- `ilinkai.weixin.qq.com` (and any redirect host returned during QR login);
- the media CDN (`novac2c.cdn.weixin.qq.com`) when phase 2 lands;
- your model provider endpoints.

## Scaling

Never run two replicas with the same bot token. DSH's iLink session is per
account: two pollers make both hit `-14`, and the lock only guards one host.
