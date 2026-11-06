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

This package runs inside the DSH Host; it is not a standalone service. Host
installation, deployment, and process supervision are managed by the operator.

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

Login selects the active account explicitly. `login --force` replaces that
selection while keeping older credentials inactive; `status` identifies the
active account. Logout removes the active account and clears the selection,
so restarting the Host never reactivates an older credential.

When upgrading from a version without explicit account selection, run `login`
once and restart the Host. Existing credentials remain stored but inactive
until a successful login establishes the selection.

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
- A second Host on the same machine refuses to
  poll, then retries every 30 s and adopts the account as soon as the first owner
  exits. Taking over a stale lock is atomic, so two starters cannot both claim it.
- Local lock recovery compares boot identity and process start time on Linux and
  macOS to detect a reused PID. Matching or unverifiable live owners stay
  protected regardless of heartbeat age; older locks without generation metadata
  may still need operator inspection.
- Long-poll or network errors: backoff, cursor kept.
- Send errors: one retry on a plain network failure, reusing the message ID as a
  server-side deduplication hint, then log; never claims success.
- QR login: HTTP requests use the remaining overall login budget, capped by the
  client's shorter request timeout; credentials arriving after the deadline are
  rejected.
- Turn timeout or a missing session: an actionable reply, never a fabricated
  answer.

## Tests

```sh
npm test
```

200 offline tests using fake iLink/Host interfaces and disposable fixtures — no
WeChat account is used.

## Limitations

Text direct messages only. No media, group chats, approvals, streaming, or the
headless `AgentHost` fallback. `maxMessageChars: 1800` is a safety budget, not a
documented server limit.

## Attribution

The iLink wire format and QR states are adapted from Tencent's MIT-licensed
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) protocol
notes. There is no OpenClaw runtime dependency. See `THIRD_PARTY_NOTICES.md`.
