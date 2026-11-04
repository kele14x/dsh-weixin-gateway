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

## Example: systemd user service

Host process management is outside this plugin's responsibilities. On Linux
with systemd, [`examples/systemd/dsh-host.service`](examples/systemd/dsh-host.service)
is an optional example for supervising the **entire DSH Host**, including any
other plugins loaded in its `web` profile. It is not a standalone gateway service
or a ready-to-install unit; configure and manage it yourself.

### Prepare the Host and customize the unit

Complete **Install** and **Log in and pair** first, using the same user and
`DSH_HOME` as the service. If you already supervise this Host, configure that
service instead of starting another. If `dsh-host.service` already exists, choose
a different unit name and adjust the commands below rather than overwriting it.
Run the following from this checkout as your normal user, not with `sudo`:

```sh
command -v dsh
command -v node
mkdir -p "$HOME/dsh-workspace"
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -m 0644 examples/systemd/dsh-host.service \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-host.service"
```

Edit the installed unit before starting it:

- Replace `/absolute/path/to/dsh` in `ExecStart` with the absolute executable path
  reported above. Resolve any shell alias or function to an actual executable.
- Replace `/absolute/path/to/node-bin` in `PATH` with the directory containing
  `node`. Add directories needed by DSH and agent tools; systemd does not load
  your shell configuration, including nvm or other version-manager setup.
- `DSH_HOME=%h/.dsh` must match the home containing your registered `web` profile
  and WeChat credentials. `%h` means this user's home directory.
- `WorkingDirectory` and `DSH_WEIXIN_CWD` both use `%h/dsh-workspace` so the Host's
  sandbox root matches new WeChat sessions. To use another workspace, change
  both values and create that directory before starting the service.

If pairing is still needed, create or reuse `~/.config/dsh-weixin-gateway.env`
with mode `0600` and set a fresh code there rather than storing it in the unit:

```sh
mkdir -p "$HOME/.config"
(umask 077; touch "$HOME/.config/dsh-weixin-gateway.env")
chmod 0600 "$HOME/.config/dsh-weixin-gateway.env"
```

Edit that file to set the following, preserving any other existing overrides:

```ini
DSH_WEIXIN_BIND_CODE=replace-with-a-fresh-code
```

### Start and inspect

Stop any manually started Host using this account before enabling the service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-host.service
systemctl --user status dsh-host.service --no-pager
journalctl --user -u dsh-host.service -f
```

The example uses `--no-open` to avoid launching a browser; the Host prints its UI
address to the journal. It retries after 10 seconds even after repeated startup
failures and allows 45 seconds for shutdown. If startup fails, check the journal
for missing workspace, executable, Node runtime, or profile configuration.

To run after reboot without logging in, enable lingering if permitted by your
system's policy:

```sh
loginctl enable-linger "$USER"
```

After editing the unit, run `systemctl --user daemon-reload` and
`systemctl --user restart dsh-host.service`. Environment-file changes need only
the restart; send `/bind <code>` to redeem a fresh pairing code.

### Stop or remove

Stopping this service stops the whole Host, not just the WeChat plugin. Stop it
before running the same Host manually. The local lock prevents two processes
on this machine from polling the same account, but does not coordinate replicas
on different machines.

```sh
systemctl --user stop dsh-host.service
```

To remove only this example's service registration, leaving DSH, the plugin,
credentials, and workspace intact:

```sh
systemctl --user disable --now dsh-host.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-host.service"
systemctl --user daemon-reload
```

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
