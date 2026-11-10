# dsh-weixin-gateway

A native **DeepSeek Harness (DSH) / Cordis** plugin that lets you chat with your
DSH agent directly from WeChat. Message the bot from your phone and it talks to
the same agent, tools, and workspace you use on the desktop.

This package runs inside the DSH Host; it is not a standalone service. Host
installation, deployment, and process supervision are managed by the operator.

## What it does

- Scan a QR code once to connect your WeChat account.
- Each WeChat chat gets its own conversation with the agent, and it resumes where
  you left off after a restart. Send `/new` to start over; the old history is kept.
- Only chats you approve can reach the agent. Pair a chat once with a code.
- Long replies arrive as several readable messages instead of being cut off.
- A typing indicator shows while the agent is working on your message.
- Send a photo or screenshot and the agent receives it as an image.
- Permission requests arrive in chat; explicitly allow an action once or deny it.

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
dsh web
node bin/dsh-weixin.mjs pair           # prints a one-time code, e.g. k7m3pq9x
```

Then send the bot a direct message and reply `/bind k7m3pq9x`. The code works
once and expires after 15 minutes; run `pair` again for each chat you want to
pair. The running Host picks it up immediately, so no restart is needed.

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
| `/allow <id>` | allow the specified pending permission request once |
| `/deny <id>` | reject the specified pending permission request |

Anything else is sent to the agent as a prompt.

When an action requires permission, the bot sends the tool name, an explanation
when supplied, and commands containing a short request number, for example
`/allow 7` or `/deny 7`. Each chat starts at 1 and keeps increasing across `/new`
and Host restarts. The counter is saved in the gateway's per-account state,
separately from agent session history; deleting that state loses this protection.
Copy the numbered command from the prompt. Only the paired chat that owns the
running turn can answer; plain "yes" or "no" messages do not grant or deny permission.
There is no "always allow" option, and the Host's permission policy still applies.

Approval requires successful delivery of the complete prompt. Failed delivery
grants nothing. Requests expire when withdrawn, when the turn ends or times out,
or on `/stop`, `/new`, or gateway shutdown. Restarting never replays an approval.
Use `/status` to see pending request IDs. The existing `turnTimeoutMs` budget
(default 10 minutes) includes time spent waiting for your decision.

## Configuration

Most people need no configuration: the install supplies `stateDir`, and sessions
default to the plugin's own `workspace/` directory. Set `DSH_WEIXIN_CWD` to run
sessions from a different directory.

You can also set a fixed pairing code in the `DSH_WEIXIN_BIND_CODE` environment
variable before starting the Host (rename it with `bindCodeEnv`); it is also
single use. The full list of settings — reply chunking,
queue size, timeouts, image download limits, logging — is documented in
`AGENTS.md`; the authoritative schema is `src/config.mjs`.

Inbound images are downloaded from the WeChat CDN, decrypted, and passed to the
agent. `maxImageBytes` (default 20 MB) and `mediaTimeoutMs` (default 60 s) bound
each download; `mediaEnabled: false` keeps the channel text-only. Images require
a model that accepts image input — `deepseek-flash` does, while `deepseek-v4-pro`
currently declares text-only input.

## Security

- Only chats you pair with `/bind` can reach the agent; everyone else is refused,
  and repeated wrong codes are rate limited.
- Message text never appears in logs unless you explicitly turn on
  `debugLogContent`.
- Keep the DSH sandbox at `workspace-write`.

Implementation details — credential file permissions, log redaction, the
single-poller lock, retry/backoff, and `-14` handling — are in `AGENTS.md`.

## Tests

```sh
npm test
```

472 offline tests using fake iLink/Host interfaces and disposable fixtures — no
WeChat account is used.

## Limitations

Text and image direct messages. Files, voice, video, group chats,
streaming, and the headless `AgentHost` fallback are not implemented. Inbound
images are supported; sending media from the agent is not.
`maxMessageChars: 1800` is a safety budget, not a documented server limit.

Accepted agent prompts and their replies share one owner-only, per-account
interruption journal. It stores IDs, status, reply context, and outbound chunk
counts, never message text or images; DSH manages the conversation transcript.
Reply text and network retries stay in memory. After a crash or Host restart,
the gateway notifies paired chats about unfinished work or possibly incomplete
replies, leaving already-sent chunks untouched. It never replays prompts or
resends replies automatically. Resend queued messages, and check DSH session
history before rerunning work that may already have started.

A reply is cleared after every chunk is acknowledged. A crash before saving an
acknowledgement can still produce a warning for a reply that actually arrived.
Failed notices are retained for the next startup or message from that chat.
Command replies and permission prompts are not tracked for restart delivery.

## Attribution

The iLink wire format, QR states, and inbound CDN media rules are adapted from
Tencent's MIT-licensed [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)
protocol notes and client behaviour. There is no OpenClaw runtime dependency.
See `THIRD_PARTY_NOTICES.md`.
