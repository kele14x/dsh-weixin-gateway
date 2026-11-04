# Known issues

Updated on 2026-11-04. Findings were reviewed at `a7d8f49`; the nine offline fixes were committed in `8d77e08`. Original issue numbers are retained.

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect.

## Open issues

None currently.

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

- Before committing `8d77e08`, all **137 offline tests** passed in three consecutive runs, plus `npm run check` and `git diff --check`.
- Each run included 100 fresh and 100 stale lock trials with five contenders, plus separate-process contention for both cases. This is regression evidence, not proof of every schedule or filesystem behavior.
- Tests used macOS, fake Host/client interfaces, temporary files, loopback HTTP, child processes, and offline readline streams. Only disposable fixture accounts were logged out; no live WeChat account, Docker Host example, or Linux systemd execution was tested.
- The initial npm audit at `0f798c1` reported zero known dependency vulnerabilities; dependency manifests remain unchanged. This is not an exhaustive security assessment.
