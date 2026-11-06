# Known issues

Updated on 2026-11-06. New findings were reviewed at `1497dc2`. Previous findings were reviewed at `a7d8f49`; the nine offline fixes were committed in `8d77e08`. Original issue numbers are retained.

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect; **P3** denotes a lower-priority correctness or diagnostic defect.

## Open issues

No open findings from the recorded reviews remain. The remaining limitations below still apply.

## Fixed issues

All nine fixes below are included in `8d77e08` and covered by offline regression tests.

| Issue | Resolution | Regression coverage |
| --- | --- | --- |
| 1. P1 — Concurrent poller ownership | Publish initialized locks atomically, serialize stale takeover, and stop polling on ownership loss. | [lock](test/lock.test.mjs) |
| 2. P1 — Failed command skips batch messages | Isolate message failures and checkpoint only after handling the batch. | [gateway](test/gateway.test.mjs) |
| 3. P1 — Reusable pairing code | Atomically persist authorization and a consumed code fingerprint; failed writes grant no access. | [allowlist](test/allowed.test.mjs), [commands](test/commands.test.mjs) |
| 5. P2 — Missing CLI values target the wrong account | Reject missing/blank/option-like values; logout refuses a live poller and releases its own lock. | [CLI](test/cli.test.mjs) |
| 6. P2 — Timeout loses cancellation handle | Request cancellation on timeout and retain failed-cancellation handles for `/stop`; typing shares the turn deadline. | [gateway](test/gateway.test.mjs) |
| 7. P2 — Stop still admits a prompt | Track per-turn cancellation and wait for pending admission before allowing newer prompts. | [gateway](test/gateway.test.mjs) |
| 8. P2 — Initial creation overwrites `/new` | Serialize creation and reset per sender, including failure recovery. | [session router](test/session-router.test.mjs) |
| 9. P2 — Verification ignores timeout/abort | Bound input by the remaining login deadline and abort signal, including readline cancellation. | [auth](test/auth.test.mjs), [CLI](test/cli.test.mjs) |
| 10. P2 — Retry restarts after shutdown | Track startup/shutdown/drains and tear down the old generation before restarting. | [gateway](test/gateway.test.mjs) |

The following fixes followed separately and are also covered by offline regression tests.

| Issue | Resolution | Regression coverage |
| --- | --- | --- |
| 14. P2 — Outbound retries generate a new message ID | Generate one `clientId` per chunk and reuse it on the retry as a server-side deduplication hint. | [gateway](test/gateway.test.mjs) |
| 15. P2 — Chunking removes significant indentation | Prefer newline splits over space splits and drop only the whitespace at a split, so a chunk that starts a line keeps its indentation. | [chunk](test/chunk.test.mjs) |
| 16. P2 — Schema-valid zero chunk size disables replies | Require `maxMessageChars` to be at least 1 in the configuration schema. | [plugin](test/plugin.test.mjs) |
| 17. P2 — Logout can reactivate a previously replaced account | Login persists an explicit active-account selection; logout clears it before deleting the active credential. Startup never falls back to older credentials. | [CLI](test/cli.test.mjs), [gateway](test/gateway.test.mjs) |
| 18. P2 — Same-value retries falsely acknowledge persistence | Cursor and context-token setters flush pending writes even when the value is unchanged, including concurrent callers. | [state](test/state.test.mjs) |
| 19. P2 — PID reuse prevents abandoned-lock recovery | Persist boot identity and process start time; recover a local lock when the recorded generation differs. Matching or unverifiable live owners remain protected regardless of heartbeat age. | [lock](test/lock.test.mjs) |
| 20. P3 — HTTP phases bypass the overall QR-login deadline | Cap QR HTTP requests at the remaining overall budget and the shorter client timeout; reject late responses and credentials. | [auth](test/auth.test.mjs), [client](test/client.test.mjs) |

Former Host-deployment findings **11–13 and 21** are retired: Host setup examples
and their example-only healthcheck tests have been removed. This repository
provides a DSH plugin, not Host deployment or process supervision.

## Remaining limitations

- **Delivery durability:** Queues remain in memory and dedupe can persist before execution. Crashes or shutdown can lose queued work; exactly-once execution is not guaranteed.
- **Cancellation retention:** Handles retained after failed timeout cancellation need `/stop` or teardown; later terminal events do not automatically clear them.
- **Shutdown deadline:** Uncancellable session creation/persistence or admission that never settles can block shutdown indefinitely.
- **Process identity:** Generation probes use Linux `/proc` boot IDs and start ticks, or macOS boot-session UUIDs and locale/timezone-normalized `ps` start timestamps. macOS timestamps have one-second resolution, so same-second PID reuse may remain indistinguishable. Missing metadata, unavailable probes, and unsupported platforms conservatively retain a live PID's lock; older abandoned locks may still require operator inspection.
- **Coordination scope:** The advisory lock protects one local host/container, not cross-host replicas. Pairing redemption is serialized within one allowlist writer and across reloads, not independent writers sharing a file.
- **Pairing rotation:** Codes consumed before the fix cannot be reconstructed. Rotate the existing code when deploying; replacement requires a distinct value in the configured `bindCodeEnv` variable in the Host environment, normally by restarting Host with the updated environment. Revocation does not reactivate a consumed code.

## Validation and scope

- After removing Host setup examples and their 32 example-only tests on 2026-11-06: all **200 remaining offline plugin tests** passed, plus `npm run check` and `git diff --check`. Plugin runtime code is unchanged; no live WeChat account or DSH Host was exercised.
- Fixes for issues 19–21 in `9d6331d` on 2026-11-06: all **232 offline tests** passed, including 32 checks for the now-removed Host healthcheck example, plus `npm run check`, explicit syntax checks of the changed modules, and `git diff --check`. Native macOS identity probes were checked across processes with differing locale/timezone settings. Linux `/proc` parsing used injected fixtures; PID reuse and boot changes were simulated. Plugin coverage also includes five-contender generation takeovers, deadline-bound QR fetch/acknowledgement cancellation, and late confirmation. No native Linux kernel, live WeChat account, or DSH Host was exercised.
- Fixes for issues 17 and 18 in `def3f4e` on 2026-11-06: all **154 offline tests** passed, plus `npm run check`, explicit syntax checks of the changed source modules, and `git diff --check`. Coverage includes forced account replacement, logout without fallback, missing/corrupt selection, failed selection writes, and failed state writes with same-value retries and concurrent callers. No live WeChat account or DSH Host was exercised.
- Review of `1497dc2` on 2026-11-06: all **137 offline tests** passed, along with `npm run check` and `git diff --check`. A production dependency audit through the official npm registry reported zero vulnerabilities; the configured mirror did not support the audit endpoint.
- All eight new findings were independently reproduced using injected transports or cleaned-up disposable fixtures. PID reuse was simulated, not triggered through OS PID recycling. No live WeChat account or live DSH integration was exercised; the former Host healthcheck script was run locally.
- Before committing `8d77e08`, all **137 offline tests** passed in three consecutive runs, plus `npm run check` and `git diff --check`.
- Each run included 100 fresh and 100 stale lock trials with five contenders, plus separate-process contention for both cases. This is regression evidence, not proof of every schedule or filesystem behavior.
- Tests used macOS, fake Host/client interfaces, temporary files, loopback HTTP, child processes, and offline readline streams. Only disposable fixture accounts were logged out; no live WeChat account or Host deployment was tested.
- The initial npm audit at `0f798c1` reported zero known dependency vulnerabilities; dependency manifests remain unchanged. This is not an exhaustive security assessment.
