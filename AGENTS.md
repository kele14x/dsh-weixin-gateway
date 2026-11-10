# AGENTS.md

Implementation notes for `dsh-weixin-gateway`. The README is for people who use
the plugin; this file is for people who work on it. It collects the runtime
behaviour, failure policy, and security internals that were moved out of the
README.

## Architecture

```
WeChat / ClawBot  →  Tencent iLink Bot API  →  this plugin (inside the DSH Host)
                                                      ↓
                                        Session Controller → agent, tools, workspace
```

All WeChat traffic is outbound HTTPS: QR login, one long poll for inbound
messages, outbound sends, and inbound media downloads from the WeChat CDN. There
is no webhook, no callback, and no inbound port. The plugin runs inside the DSH
Host and depends only on the `sessionController` service (the `web` profile
composes it); it opens no socket of its own. `workspaceRegistry` is optional and
used only for sidebar grouping.

## Sidebar grouping

The Web sidebar lists a Session under a Workspace only while that Workspace
records it, so Sessions created in an unregistered directory render as
“未分组”. `WorkspaceBinder` (`src/bridge/workspace.mjs`) prevents that:

- It registers the channel's session directory through the optional
  `workspaceRegistry` service (`ctx.inject(['workspaceRegistry'], …)` inside the
  `sessionController` injection) and caches the resulting id. `workspaceTitle`
  (default `WeChat`) is used only when the Workspace is first created, so a manual
  rename survives restarts, and an empty title disables grouping entirely.
- New Sessions are created as `sessionController.create({ workspaceId })`, which
  attaches them in the same call. A `workspace/not-found` response falls back to
  an ungrouped Session in `defaultCwd`, so deleting the group never blocks a turn.
- At mount it adopts the Sessions recorded in `<stateDir>/state/*.json` (all
  accounts), so conversations that already existed join the group without a new
  message. Unreadable state files, stale ids, and Sessions created in another
  directory are skipped with a debug log.
- No Workspace is created until a recorded Session exists or the first new one is
  created, so an unused channel shows no empty group. Deleting the group makes
  Sessions ungrouped until the next start, which recreates it; `workspaceTitle: ''`
  keeps them ungrouped permanently.
- A profile without the registry (headless hosts) runs unchanged; a registry
  failure logs a warning and never stops the channel.

## Media support

Phase 1 covers inbound images only:

- `normalizeInbound` keeps image items as `images` descriptors and counts other
  non-text items in `unsupportedItemCount`.
- Images are downloaded only after the sender passes the allowlist, inside the
  turn so `/stop` cancels an in-flight download. `MediaDownloader` applies the
  CDN host allowlist, the byte cap, and the total timeout.
- A downloaded image is decrypted with AES-128-ECB/PKCS#7 when a key is present,
  classified from its magic bytes, and sent to the Session Controller as an
  encoded `image` content part. DSH normalizes it and checks the model's
  `inputModalities`; a text-only model is reported to the user.
- Files, voice, video, and outbound media remain unimplemented. Their item types
  are counted as unsupported and answered with a notice instead of silence.

## Failure handling

- `-14` (session paused): one poller per bot token. The gateway pauses for the
  documented hour (`sessionPauseMs`) and logs a concrete diagnostic. The pause
  outlives the lock's stale window, so it sleeps in slices and keeps the lock
  heartbeat warm; otherwise a second Host would take the lock over and both would
  poll on resume.
- Lock conflict: a second Host on the same machine refuses to poll, then retries
  every 30 s (`lockRetryMs`) and adopts the account as soon as the first owner
  exits. Taking over a stale lock is atomic, so two starters cannot both claim it.
- Local lock recovery compares boot identity and process start time on Linux and
  macOS to detect a reused PID. Matching or unverifiable live owners stay
  protected regardless of heartbeat age; when the platform probe is unavailable
  (for example a sandbox that denies setuid `/bin/ps`), the lock keeps that
  conservative fallback. Older locks without generation metadata may still need
  operator inspection.
- Long-poll or network errors: exponential backoff (1 s → 60 s), cursor kept.
- Send errors: one retry on a plain network failure, reusing the per-chunk
  `clientId` as a server-side deduplication hint, then log; never claims success.
- QR login: HTTP requests use the remaining overall login budget, capped by the
  client's shorter request timeout; credentials arriving after the deadline are
  rejected.
- Inbound media: one download timeout and byte cap per image; a failed download,
  decryption, or format check produces an actionable reply and never reaches the
  agent. A download cancelled by `/stop` is silent.
- Turn timeout or a missing session: an actionable reply, never a fabricated
  answer.

## Security internals

- Default-deny allowlist: a sender must redeem a one-time `/bind` code before
  any message reaches the agent. Redemption is atomic and records a consumed-code
  fingerprint, so a code cannot be replayed and a failed write grants no access.
- Codes come from `dsh-weixin pair` or the `bindCodeEnv` variable. `pair` writes
  `<stateDir>/pairing.json` holding only the code's SHA-256 (the same value as
  the consumed fingerprint) and a 15-minute expiry; `/bind` rereads it on every
  attempt, so issuing or rotating a code needs no restart. Generated codes are
  8 lowercase characters without look-alikes and compare case-insensitively.
  An unreadable `pairing.json` is logged and treated as absent; `logout` removes it.
- `/bind` failures are rate limited (5 per hour per sender) and the code is
  compared with `timingSafeEqual`, so it cannot be brute-forced from WeChat.
- Tokens, context tokens, QR URLs, media AES keys, CDN query parameters, and
  message text are redacted from logs. Raw message text appears only when
  `debugLogContent` is on.
- Media downloads are bounded by bytes and time, accept only HTTPS WeChat CDN
  hosts (including the configured CDN origin), and never receive the bot
  `Authorization` header.
- Credential and state files are written `0600`, directories `0700`.

## Configuration

Set on the plugin row. `stateDir` is required and must be absolute; the bundle
patch supplies it as `dshHomePath('integrations/dsh-weixin')`. `defaultCwd` is
optional: empty (the default) uses the plugin's own `workspace/` directory, and
`DSH_WEIXIN_CWD` overrides it.

| Key | Default | Purpose |
|---|---|---|
| `stateDir` | — | credentials, cursor, allowlist, pairing code, lock |
| `defaultCwd` | `<plugin>/workspace` | workspace for new sessions |
| `workspaceTitle` | `WeChat` | sidebar group title; empty leaves sessions ungrouped |
| `agentPreset` | — | preset for new sessions |
| `baseUrl` | iLink default | API origin; a QR redirect may override it per account |
| `mediaEnabled` | `true` | download inbound images and pass them to the agent |
| `cdnBaseUrl` | iLink CDN default | CDN origin used when a message has no `full_url` |
| `maxImageBytes` | `20971520` | maximum downloaded bytes for one inbound image |
| `maxImagesPerMessage` | `9` | maximum images accepted in one inbound message |
| `mediaTimeoutMs` | `60000` | total deadline for one inbound media download |
| `maxMessageChars` | `1800` | outbound chunk size (code points) |
| `chunkDelayMs` | `400` | delay between outbound chunks |
| `pollTimeoutMs` | iLink default | long-poll budget; the server value wins when present |
| `queueLimit` | `8` | max queued inbound messages per sender |
| `turnTimeoutMs` | `600000` | how long to wait for one DSH turn |
| `typingKeepaliveMs` | `5000` | re-send the WeChat typing banner while a turn runs; `0` disables the refresh |
| `bindCodeEnv` | `DSH_WEIXIN_BIND_CODE` | optional fixed pairing-code variable; empty disables it (`pair` codes still work) |
| `replyMode` | `all` | send `all` steps or only the `last` |
| `sessionPauseMs` | iLink default | pause after a `-14` response |
| `logLevel` | `info` | log threshold |
| `debugLogContent` | `false` | allow raw text in debug logs |
| `botAgent` | derived | observability-only bot_agent token; not authentication |

The authoritative schema is `src/config.mjs`. Queue size, timeouts, and backoff
defaults live there and in `src/ilink/constants.mjs`.

## Tests

```sh
npm test        # offline tests
npm run check   # syntax check of the entry points
```

Tests use fake iLink/Host interfaces and disposable fixtures — no WeChat account
is used. See `KNOWN_ISSUES.md` for the recorded review findings, their fixes, and
the remaining limitations.
