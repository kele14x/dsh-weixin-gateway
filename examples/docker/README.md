# Docker Host example

This directory is an optional reference for running an entire DSH Web Host with
this plugin. It is not a plugin installer, supported image, or required runtime.
The operator owns the DSH version, profile, storage, networking, upgrades, and
Host lifecycle.

The WeChat transport itself is outbound-only and needs no published port. This
example publishes the optional DSH Web UI on host loopback.

## Prepare

Run these commands from the repository root. The bind-mounted directories avoid
Docker-managed volume ownership and keep all example state under the ignored
`examples/docker/.state/` directory.

```sh
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export DSH_WEIXIN_BIND_CODE='replace-with-a-fresh-code'
mkdir -p examples/docker/.state/dsh-home
mkdir -p examples/docker/.state/workspace
docker compose -f examples/docker/compose.yaml build
```

`HOST_UID` and `HOST_GID` make the container write bind-mounted files as the
invoking user. Do not run the example with `sudo` or commit `.state/`; it contains
credentials, session state, and conversation history.

## Configure the Host

Profile registration is an explicit Host administration step. The container does
not mutate the profile at startup:

```sh
docker compose -f examples/docker/compose.yaml run --rm dsh \
  dsh plugin --profile web add -w link:/app
```

The registration persists under `.state/dsh-home`. Repeat it only when changing
or recreating that profile.

## Log in and start

```sh
docker compose -f examples/docker/compose.yaml run --rm -it dsh \
  node /app/bin/dsh-weixin.mjs login
docker compose -f examples/docker/compose.yaml up -d
docker compose -f examples/docker/compose.yaml logs -f dsh
```

Send `/bind <code>` in a direct message after startup. Rotate the exported code
before reusing this example after it has been redeemed.

`status` and `logout` use the same one-shot pattern:

```sh
docker compose -f examples/docker/compose.yaml run --rm dsh \
  node /app/bin/dsh-weixin.mjs status
```

Stop the running Host before `logout` or other account-changing operations.

## Web UI and healthcheck

DSH rejects wildcard binds. The example pins the container to `172.28.0.2`, binds
the UI there, and publishes it only as `127.0.0.1:3080`. Remove `ports`,
`--trusted-host`, and `--public-url` if the UI is unnecessary.

The healthcheck reports healthy when a poller owns the local lock and its
heartbeat is less than two minutes old. It does not probe a listening gateway
socket because WeChat traffic is outbound HTTPS.

## Operate and remove

Run exactly one replica per bot token. The plugin lock coordinates processes
sharing one local state directory, not containers on different hosts.

```sh
docker compose -f examples/docker/compose.yaml stop
docker compose -f examples/docker/compose.yaml down
```

Removing `examples/docker/.state/` permanently deletes this example's DSH
profile, credentials, session mappings, histories, and workspace. Back up any
state you need before removing it.
