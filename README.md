# dsh-weixin-gateway

A native **DeepSeek Harness (DSH) / Cordis** plugin that connects a DSH agent to
WeChat direct messages — without OpenClaw, without a public IP, and without an
inbound port.

```
WeChat / ClawBot  →  Tencent iLink Bot API  →  this plugin (inside the DSH Host)
                                                     ↓
                                       Session Controller → agent, tools, workspace
```

All WeChat traffic is outbound HTTPS: QR login, one long poll for messages, and
outbound sends. There is no webhook, no callback, and nothing to expose.

## What it does

- QR login; credentials live under `$DSH_HOME/integrations/dsh-weixin/`.
- One DSH session per WeChat sender, persisted across restarts. `/new` starts a
  fresh session and keeps the old history.
- Default-deny sender allowlist; pair a chat with a one-time `/bind` code.
- Replies are chunked Unicode-safe under `maxMessageChars`.
- Exactly one poller per bot token, enforced by a local lock. A second Host on
  the same machine waits and takes over when the first exits.

## Requirements

| | |
|---|---|
| DSH | `0.2.1-rc.5` |
| Node.js | `>= 22.13.0` |
| Profile | `web` (provides `sessionController`) |
| WeChat | ClawBot enabled: Me → Settings → Plugins → ClawBot |

## Install

```sh
npm install --omit=dev
dsh plugin --profile web add -w link:"$PWD"
dsh web
```

The package declares `dsh.bundle.patch`, so the install registers it as a profile
layer automatically.

Sessions default to `<plugin>/workspace`. Start `dsh web` from that directory so
DSH's sandbox root matches it, or set `DSH_WEIXIN_CWD` to the directory you
launch from.

## Log in and pair

```sh
node bin/dsh-weixin.mjs login          # scan the QR with WeChat
export DSH_WEIXIN_BIND_CODE='choose-a-code'
dsh web
```

Then send the bot a direct message and reply `/bind choose-a-code`.

`node bin/dsh-weixin.mjs status` and `node bin/dsh-weixin.mjs logout` are also
available; `login` never starts a poller, so restart the Host afterwards.

## Run as a user service

The channel lives inside the Host, so the supervised process is `dsh web`, not a
separate daemon. The unit in `deploy/systemd/` keeps it running after the
terminal closes and across reboots:

```sh
deploy/systemd/install.sh                 # install, enable, start
journalctl --user -u dsh-weixin-gateway -f
```

It starts in `workspace/` and passes `--no-open`, so no browser is launched at
boot; the UI is still served on `127.0.0.1:3080` and its URL is printed to the
journal. It retries every 10 s without ever latching into `failed`, and allows
45 s to shut down. Optional overrides go in
`~/.config/dsh-weixin-gateway.env`, mode `0600`:

```sh
DSH_WEIXIN_BIND_CODE=choose-a-code
```

Restart the unit after editing that file: `/bind` reads the variable from the
process environment. `loginctl enable-linger "$USER"` is what lets the Host
start at boot without a login; the installer warns when lingering is off. Stop
the unit before running `dsh web` by hand — a second poller trips iLink's `-14`
guard.

## Commands

| Command | Behaviour |
|---|---|
| `/help` | command list |
| `/new` | new DSH session, old history kept |
| `/stop` | cancel the running turn, clear the queue |
| `/status` | account, session, turn, cwd, queue |
| `/version` | plugin version |
| `/bind <code>` | pair this chat |

Anything else is sent to the agent as a prompt.

## Configuration

Set on the plugin row. `stateDir` is required and must be absolute.
`defaultCwd` is optional: empty (the default) uses the plugin's own `workspace/`
directory, and `DSH_WEIXIN_CWD` overrides it.

| Key | Default | Purpose |
|---|---|---|
| `stateDir` | — | credentials, cursor, allowlist, lock |
| `defaultCwd` | `<plugin>/workspace` | workspace for new sessions |
| `agentPreset` | — | preset for new sessions |
| `maxMessageChars` | `1800` | outbound chunk size |
| `bindCodeEnv` | `DSH_WEIXIN_BIND_CODE` | pairing-code variable |
| `replyMode` | `all` | send `all` steps or only the `last` |
| `logLevel` | `info` | log threshold |
| `debugLogContent` | `false` | allow raw text in debug logs |

Queue size, timeouts, and backoff are in `src/config.mjs`.

## Security

- Unknown senders are denied until `/bind`; failed attempts are rate limited.
- Tokens, context tokens, QR URLs, and message text are redacted from logs.
- Credential and state files are `0600`, directories `0700`.
- Keep the DSH sandbox at `workspace-write`.

## Failure handling

- `-14`: one poller per bot token. The gateway pauses for the documented hour and
  logs a concrete diagnostic; the lock heartbeat keeps running through the pause.
- A second Host on the same machine (a manual `dsh web`, another unit) refuses to
  poll, then retries every 30 s and adopts the account as soon as the first owner
  exits. Taking over a stale lock is atomic, so two starters cannot both claim it.
- Long-poll or network errors: backoff, cursor kept.
- Send errors: one retry on a plain network failure, then log; never claims
  success.
- Turn timeout or a missing session: an actionable reply, never a fabricated
  answer.

## Tests

```sh
npm test
```

76 offline tests against a fake iLink client and fake Host — no WeChat account is
used.

## Docker

See [`docker/README.md`](docker/README.md). One replica per bot token; the WeChat
side needs no published port.

## Limitations

Text direct messages only. No media, group chats, approvals, streaming, or the
headless `AgentHost` fallback. `maxMessageChars: 1800` is a safety budget, not a
documented server limit.

## Attribution

The iLink wire format and QR states are adapted from Tencent's MIT-licensed
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) protocol
notes. There is no OpenClaw runtime dependency. See `THIRD_PARTY_NOTICES.md`.
