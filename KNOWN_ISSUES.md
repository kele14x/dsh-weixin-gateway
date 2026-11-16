# Known issues

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect; **P3** denotes a lower-priority correctness or diagnostic defect.

Findings are numbered once and keep their number forever, so gaps are expected. Reviews: `a7d8f49` (1–10), `1497dc2` (14–22), `7d1bf8c` (23–34).

## Open issues

### P2

- **25 — Inbound images have no aggregate bound**
  Each download is capped by `maxImageBytes` and `mediaTimeoutMs`, but the message total is not. At the defaults (9 images × 20 MB) the runtime holds ~180 MB of buffers and then base64-encodes them into one prompt payload (~240 MB of strings). The time is unbounded too: downloads run sequentially before `collector.begin()`, so `turnTimeoutMs` never covers them.

### P3

- **27 — The poll budget has no margin over the server's hold time**
  The client adopts `longpolling_timeout_ms` as its own abort deadline, so a clean server response and a client timeout race on every poll. Harmless today because the cursor is preserved, but it makes `timedOut` the normal outcome and masks genuine timeouts. Add a few seconds of slack.
- **28 — The lock heartbeat is coupled to poll success, not to a timer**
  `touch()` runs only after a successful `getUpdates` and during a `-14` pause, so through a network-backoff stretch the heartbeat goes unrefreshed against the 120 s stale window. Single-host ownership is unaffected (that path uses PID plus boot identity, never the heartbeat), which means the cross-host staleness rule is only half-guaranteed.
- **29 — `ChannelState` re-implements bot-id sanitization**
  It inlines the character substitution instead of calling `safeBotId`, so it misses the empty/`.`/`..` guard and the 120-character cap. Both paths also map `a/b` and `a_b` onto the same filename, so two distinct bot ids can collide onto one state file, lock, and journal.
- **30 — `logout` deletes the shared allowlist**
  It removes `allowed.json` and any pending pairing code for the whole `stateDir`, revoking every other account's pairings, not just the one being logged out.
- **31 — `login` takes no poller lock, and `status` misreports lock state**
  `login` can replace the active-account selection while a gateway polls a different bot id; a following `logout` then locks the *new* id and deletes state underneath a live *old* poller. Separately, `status` prints `lock: held` from bare file existence, which is simply wrong after a crash.
- **32 — `WorkspaceBinder.detach()` latches the registry wait**
  `detach()` clears the binding but leaves `waitedForRegistry` and `available` set. If the `sessionController` effect re-runs after the registry effect disposed, `ensure()` skips its bounded wait and sidebar grouping is silently lost for the rest of the process lifetime.
- **33 — One undownloadable image discards the whole message**
  `#loadImages` throws before the journal reaches `submitting`, so the accompanying text prompt is never submitted and the user only sees the image error. Their text is gone with no hint that it was dropped.
- **34 — Minor cleanups**
  `scrub()`'s cycle guard shares one `seen` set down the whole tree and never pops, so a legitimately repeated (non-circular) object renders as `[circular]`. Dead code: an unused `LockError` import in `runtime.mjs`, and unreferenced exports `extractText` and `rawMessageId` in `ilink/messages.mjs`, plus `PACKAGE_NAME`, `MESSAGE_TYPE_USER`, `ITEM_TYPE_VOICE/FILE/VIDEO`, and `PATHS.uploadUrl` in `ilink/constants.mjs`.
- **35 — `Gateway.summary()` has no caller**
  It is documented as the non-secret runtime summary "for `/status` and diagnostics", but `/status` builds its own text in `statusText()` and nothing else reads it, so the plugin exposes no machine-readable channel state to the Host. That is why finding 24 left a log line as the only signal — and it still does once the 60 s restart budget is exhausted, because no Host-side readout reports that the channel is down. Found while fixing 24.

## Fixed issues

Findings 1–10 landed in `8d77e08`; 14–22 and 23 followed separately. All are covered by offline regression tests. Findings 4 and 11–13 and 21 do not appear: 11–13 and 21 were Host-deployment findings, retired when the Host setup examples and their example-only healthcheck tests were removed — this repository provides a DSH plugin, not Host deployment or process supervision.

### P1

- **1 — Concurrent poller ownership.** Publish initialized locks atomically, serialize stale takeover, and stop polling on ownership loss. [lock](test/lock.test.mjs)
- **2 — A failed command skipped the rest of its batch.** Isolate per-message failures and checkpoint the cursor only after the whole batch is handled. [gateway](test/gateway.test.mjs)
- **3 — Reusable pairing code.** Persist authorization and a consumed-code fingerprint atomically; a failed write grants no access. [allowlist](test/allowed.test.mjs), [commands](test/commands.test.mjs)
- **23 — An out-of-range server poll budget wedged polling permanently.** `longpolling_timeout_ms` was adopted verbatim; Node's `AbortSignal.timeout` throws above 2^32-1 ms and silently truncates to 1 ms above 2^31-1 ms, so every later request failed before reaching the network and only a successful poll could reset it. Clamp every request timer to `MAX_TIMEOUT_MS` and cap both the adopted server value and the configured `pollTimeoutMs` at `MAX_POLL_TIMEOUT_MS`, which also keeps one silent poll under the lock's stale window. [client](test/client.test.mjs), [gateway](test/gateway.test.mjs), [plugin](test/plugin.test.mjs)

### P2

- **5 — Missing CLI values targeted the wrong account.** Reject missing, blank, and option-like values; `logout` refuses a live poller and releases its own lock. [CLI](test/cli.test.mjs)
- **6 — A timeout lost its cancellation handle.** Request cancellation on timeout, retain failed-cancellation handles for `/stop`, and let typing share the turn deadline. [gateway](test/gateway.test.mjs)
- **7 — `/stop` still admitted a prompt.** Track per-turn cancellation and wait for a pending admission before admitting a newer prompt. [gateway](test/gateway.test.mjs)
- **8 — Initial session creation overwrote `/new`.** Serialize creation and reset per sender, including failure recovery. [session router](test/session-router.test.mjs)
- **9 — Verification ignored the timeout and abort signal.** Bound interactive input by the remaining login deadline and the abort signal, including readline cancellation. [auth](test/auth.test.mjs), [CLI](test/cli.test.mjs)
- **10 — A retry restarted after shutdown.** Track startup/shutdown/drains and tear down the old generation before restarting. [gateway](test/gateway.test.mjs)
- **14 — Outbound retries generated a new message id.** Mint one `clientId` per chunk and reuse it on the retry as a server-side deduplication hint. [gateway](test/gateway.test.mjs)
- **15 — Chunking removed significant indentation.** Prefer newline splits over space splits and drop only the whitespace at the split itself. [chunk](test/chunk.test.mjs)
- **16 — A schema-valid zero chunk size disabled replies.** Require `maxMessageChars` to be at least 1 in the configuration schema. [plugin](test/plugin.test.mjs)
- **17 — `logout` could reactivate a previously replaced account.** Persist an explicit active-account selection and clear it before deleting the credential; startup never falls back to older credentials. [CLI](test/cli.test.mjs), [gateway](test/gateway.test.mjs)
- **18 — Same-value retries falsely acknowledged persistence.** Cursor and context-token setters flush pending writes even when the value is unchanged, including for concurrent callers. [state](test/state.test.mjs)
- **19 — PID reuse prevented abandoned-lock recovery.** Persist boot identity and process start time and recover a local lock when the recorded generation differs; matching or unverifiable live owners stay protected regardless of heartbeat age. [lock](test/lock.test.mjs)
- **24 — Nothing restarted a channel that reached `status = 'error'`.** Lock loss, a failed `-14` pause heartbeat, an inbound-journal write failure, and any startup failure stopped polling, and `Gateway.start()` already knew how to recover from `error` but had no caller: the plugin started once at mount and the retry timer only fired while `status === 'locked'`, so one transient `ENOSPC` disabled the channel until a Host restart. All four transitions now route through one `#enterError` that reports to the owner via `onFatal`, and the plugin restarts the channel with a doubling delay from 1 s inside a 60 s window, then gives up with one actionable log line; a start that ends anywhere but `error` closes the episode so a later failure gets a fresh window. Lock conflicts keep their unbudgeted 30 s retry, and a clean shutdown never reports a fatal error. [gateway](test/gateway.test.mjs), [plugin](test/plugin.test.mjs)
- **26 — The API origin accepted any scheme, including a server-supplied one.** `normalizeBaseUrl` passed `http:` and `ftp:` through and kept URL userinfo, and QR login adopted the server's `redirect_host` and `baseurl` verbatim, so a cleartext origin could receive `Authorization: Bearer <botToken>` and be persisted for every later call. Origins are now parsed and must carry no credentials, query, or fragment; an operator-supplied origin requires https except on a loopback host, a server-supplied one requires https with no exception and fails login with `insecure-origin` instead of yielding credentials, and the config schema rejects a cleartext `baseUrl` before the channel mounts, and the CLI reports a rejected `--base-url` as a login failure rather than a stack trace. [client](test/client.test.mjs), [auth](test/auth.test.mjs), [CLI](test/cli.test.mjs), [plugin](test/plugin.test.mjs)

### P3

- **20 — HTTP phases bypassed the overall QR-login deadline.** Cap QR requests at the remaining overall budget and the shorter client timeout; reject late responses and credentials. [auth](test/auth.test.mjs), [client](test/client.test.mjs)
- **22 — Pairing required a manually exported environment variable.** `dsh-weixin pair` issues a single-use code with a 15-minute expiry and stores only its hash; `/bind` rereads it on every attempt, so pairing needs no environment edit or Host restart. `status` reports pending/expired/redeemed and `logout` clears it. The `bindCodeEnv` code remains an optional fallback. [commands](test/commands.test.mjs), [CLI](test/cli.test.mjs), [gateway](test/gateway.test.mjs)

## Remaining limitations

These are design boundaries, not defects.

- **Media scope:** Only inbound images are implemented. Files, voice, video, and outbound media are still unsupported; mixed messages keep their images and text and report the skipped items. The CDN media rules are derived from Tencent's client behaviour, not a stable public contract, and have not been exercised against a live WeChat account.
- **Delivery durability:** Prompt and reply payloads remain in memory; DSH owns the conversation transcript. Accepted prompts are journaled as metadata before dedupe persistence and dispatch. The same journal tracks terminal replies before sending and records acknowledged chunk counts; after a crash or shutdown, startup warns about unfinished work and potentially incomplete replies without replaying either. A crash between server acceptance and local acknowledgement persistence can produce a conservative warning even if the reply arrived. Fully acknowledged records are cleared without warnings. Command replies, permission prompts, and pre-result error notices remain best-effort. Failed recovery notices remain pending until a later startup or inbound message. Automatic queue recovery, durable outgoing reply content, and exactly-once execution are not implemented. Atomic renames protect against process crashes, not filesystem or power loss; messages lost before journal acceptance also remain outside this guarantee.
- **Cancellation retention:** Handles retained after failed timeout cancellation need `/stop` or teardown; later terminal events do not automatically clear them.
- **Shutdown deadline:** Uncancellable session creation/persistence or admission that never settles can block shutdown indefinitely.
- **Process identity:** Generation probes use Linux `/proc` boot IDs and start ticks, or macOS boot-session UUIDs and locale/timezone-normalized `ps` start timestamps. macOS timestamps have one-second resolution, so same-second PID reuse may remain indistinguishable. Missing metadata, unavailable probes, and unsupported platforms conservatively retain a live PID's lock; older abandoned locks may still require operator inspection.
- **Coordination scope:** The advisory lock protects one local host/container, not cross-host replicas. Pairing redemption is serialized within one allowlist writer and across reloads, not independent writers sharing a file.
- **Pairing rotation:** Codes consumed before the fix cannot be reconstructed. Rotate the existing code when deploying. `dsh-weixin pair` issues a fresh code without a restart; a code in the `bindCodeEnv` variable still needs a distinct value and, normally, a Host restart. Revocation does not reactivate a consumed code. Issued codes live in one file per `stateDir`, so only the latest `pair` code is valid.
- **Sidebar grouping:** DSH groups Sessions by Workspace, and a Session belongs to exactly one, so every WeChat conversation shares one group (`workspaceTitle`); per-sender sub-groups are not expressible. A profile without `workspaceRegistry` stays ungrouped, and a `sessionController` that rejects `workspaceId` (older than the required DSH version) would fail creation. Adoption relies on the mappings recorded in `<stateDir>/state/*.json`, so a Session whose mapping was lost stays ungrouped. Removing the group while the Host runs leaves new Sessions ungrouped until the next Host start re-registers it; deleting the group again recreates it on every start unless `workspaceTitle` is emptied.

## Validation scope

The per-change test counts that used to accumulate here are in the git history, and the README carries the current total. What follows are the durable caveats, which apply to every fix recorded above.

- Everything is offline: fake iLink and Host interfaces, temporary fixtures, loopback HTTP, child processes, and offline readline streams. The current suite is 522 tests.
- **No live WeChat account, CDN, or DSH Host has ever been exercised.** The iLink wire format, QR states, and CDN media rules are reverse-engineered from Tencent's client behaviour, so every protocol assumption in this repository is unverified against production. This is the single largest source of residual risk and no offline test can close it.
- Process-identity evidence is partly simulated: PID reuse and boot changes were injected rather than triggered through real OS PID recycling, Linux `/proc` parsing used fixtures, and native macOS probes were checked across differing locale/timezone settings. The identity test tolerates a sandbox that cannot execute setuid `/bin/ps` and asserts the documented heartbeat fallback there.
- Lock contention was measured with 100 fresh and 100 stale trials at five contenders each, plus separate-process contention for both cases. That is regression evidence, not proof of every schedule or filesystem behaviour.
- The production dependency audit reported zero known vulnerabilities at `0f798c1`; the manifests are unchanged. That is not an exhaustive security assessment.
- Fixes are verified by reverting each layer independently and confirming it fails only its own new test, then reproducing the original defect scenario before and after. Finding 23 was validated that way.
