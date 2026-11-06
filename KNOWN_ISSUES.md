# Known issues

Updated on 2026-11-06. New findings were reviewed at `1497dc2`. Previous findings were reviewed at `a7d8f49`; the nine offline fixes were committed in `8d77e08`. Original issue numbers are retained.

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect; **P3** denotes a lower-priority correctness or diagnostic defect.

## Open issues

### 19. P2 — PID reuse prevents abandoned-lock recovery

- **Location:** [process probe](src/store/lock.mjs#L45), [local staleness check](src/store/lock.mjs#L87).
- **Finding:** Local lock recovery checks only whether the recorded PID exists, ignoring heartbeat age. After a crash or reboot, an unrelated process with a recycled PID can block startup and logout indefinitely. A disposable lock with heartbeat `1` and an unrelated live PID was refused even with `staleMs: 1`. This simulated PID reuse; actual OS PID recycling was not exercised.
- **Suggested correction:** Verify process-generation identity, such as boot identity and process start time, without allowing an old heartbeat alone to evict a genuinely live owner.

### 20. P3 — HTTP phases bypass the overall QR-login deadline

- **Location:** [QR creation](src/ilink/auth.mjs#L107), [status polling](src/ilink/auth.mjs#L129), [confirmation](src/ilink/auth.mjs#L185).
- **Finding:** HTTP operations do not receive the remaining overall login budget, and confirmation is accepted without rechecking the deadline. A real client with injected, network-free transport returned credentials after 42 ms despite a 10-ms login timeout. This is separate from the fixed verification-input timeout.
- **Suggested correction:** Bound QR creation and status requests by the overall deadline and recheck it before accepting credentials.

### 21. P3 — Docker example healthcheck accepts malformed locks

- **Location:** [healthcheck error handling](examples/docker/healthcheck.mjs#L41).
- **Finding:** The catch block rejects only `ESRCH`, ignoring JSON parsing and other PID-validation errors. A recent malformed lock containing `{broken-json`, with no running gateway, produced `healthy: last poll 0s ago` and exit code `0` in an offline reproduction.
- **Suggested correction:** Reject malformed lock records and invalid PID checks instead of reporting healthy; add a malformed-lock regression test.

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

The following reply and state fixes followed separately and are also covered by offline regression tests.

| Issue | Resolution | Regression coverage |
| --- | --- | --- |
| 14. P2 — Outbound retries generate a new message ID | Generate one `clientId` per chunk and reuse it on the retry as a server-side deduplication hint. | [gateway](test/gateway.test.mjs) |
| 15. P2 — Chunking removes significant indentation | Prefer newline splits over space splits and drop only the whitespace at a split, so a chunk that starts a line keeps its indentation. | [chunk](test/chunk.test.mjs) |
| 16. P2 — Schema-valid zero chunk size disables replies | Require `maxMessageChars` to be at least 1 in the configuration schema. | [plugin](test/plugin.test.mjs) |
| 17. P2 — Logout can reactivate a previously replaced account | Login persists an explicit active-account selection; logout clears it before deleting the active credential. Startup never falls back to older credentials. | [CLI](test/cli.test.mjs), [gateway](test/gateway.test.mjs) |
| 18. P2 — Same-value retries falsely acknowledge persistence | Cursor and context-token setters flush pending writes even when the value is unchanged, including concurrent callers. | [state](test/state.test.mjs) |

The former systemd deployment findings were resolved by removing project-owned
Host setup. The plugin now provides only an optional, operator-configured
[systemd example](examples/systemd/dsh-host.service):

- **11. P1 — Fresh systemd installation can fail before workspace creation:** the
  operator must create the configured workspace before enabling the example.
- **12. P2 — The systemd unit assumes a particular checkout location:** the
  example uses an operator-selected workspace rather than a checkout path.
- **13. P2 — The installer accepts a DSH executable the unit cannot launch:** no
  installer remains; the operator must configure the absolute DSH and Node paths.

## Remaining limitations

- **Delivery durability:** Queues remain in memory and dedupe can persist before execution. Crashes or shutdown can lose queued work; exactly-once execution is not guaranteed.
- **Cancellation retention:** Handles retained after failed timeout cancellation need `/stop` or teardown; later terminal events do not automatically clear them.
- **Shutdown deadline:** Uncancellable session creation/persistence or admission that never settles can block shutdown indefinitely.
- **Coordination scope:** The advisory lock protects one local host/container, not cross-host replicas. Pairing redemption is serialized within one allowlist writer and across reloads, not independent writers sharing a file.
- **Pairing rotation:** Codes consumed before the fix cannot be reconstructed. Rotate the existing code when deploying; replacement requires a distinct value in the configured `bindCodeEnv` variable in the Host environment, normally by restarting Host with the updated environment. Revocation does not reactivate a consumed code.

## Validation and scope

- Working-tree fixes for issues 17 and 18 on 2026-11-06: all **154 offline tests** passed, plus `npm run check`, explicit syntax checks of the changed source modules, and `git diff --check`. Coverage includes forced account replacement, logout without fallback, missing/corrupt selection, failed selection writes, and failed state writes with same-value retries and concurrent callers. No live WeChat account or DSH Host was exercised.
- Review of `1497dc2` on 2026-11-06: all **137 offline tests** passed, along with `npm run check` and `git diff --check`. A production dependency audit through the official npm registry reported zero vulnerabilities; the configured mirror did not support the audit endpoint.
- All eight new findings were independently reproduced using injected transports or cleaned-up disposable fixtures. PID reuse was simulated, not triggered through OS PID recycling. No live WeChat account, live DSH integration, Docker deployment, or Linux systemd execution was exercised; the Docker healthcheck script was run locally.
- Before committing `8d77e08`, all **137 offline tests** passed in three consecutive runs, plus `npm run check` and `git diff --check`.
- Each run included 100 fresh and 100 stale lock trials with five contenders, plus separate-process contention for both cases. This is regression evidence, not proof of every schedule or filesystem behavior.
- Tests used macOS, fake Host/client interfaces, temporary files, loopback HTTP, child processes, and offline readline streams. Only disposable fixture accounts were logged out; no live WeChat account, Docker Host example, or Linux systemd execution was tested.
- The initial npm audit at `0f798c1` reported zero known dependency vulnerabilities; dependency manifests remain unchanged. This is not an exhaustive security assessment.
