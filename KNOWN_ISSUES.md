# Known issues

Updated on 2026-11-04. Findings were reviewed at `a7d8f49`; the nine offline fixes were committed in `8d77e08`. Original issue numbers are retained.

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect.

## Open issues

### 4. P1 — A fresh Docker home volume is not writable by the service user

- **Location:** [docker/Dockerfile:23–28](docker/Dockerfile#L23), [docker/compose.yaml:14–24](docker/compose.yaml#L14), [docker/entrypoint.sh:10–16](docker/entrypoint.sh#L10).
- **Trigger:** Start the documented deployment with a new `dsh-home` named volume. The image does not initialize `/data/dsh` ownership before switching to UID 1000.
- **Impact:** The root-owned volume prevents profile registration and credential/state writes.
- **Evidence:** Static review of the image, mount, and entrypoint. A fresh Docker deployment was not executed during this review.
- **Fix direction:** Initialize the persistent home with ownership appropriate for the service user before running registration or login.

### 11. P1 — Fresh systemd installation can fail before workspace creation

- **Location:** [deploy/systemd/dsh-weixin-gateway.service:38](deploy/systemd/dsh-weixin-gateway.service#L38), [deploy/systemd/install.sh:36–39](deploy/systemd/install.sh#L36), [src/index.mjs:79–83](src/index.mjs#L79).
- **Trigger:** Install the service before an interactive plugin run has created the untracked `workspace/` directory.
- **Impact:** Systemd must enter the directory before launching DSH, but directory creation happens inside the plugin. Startup therefore fails with `CHDIR` and repeatedly restarts.
- **Evidence:** Static review; no systemd service was installed or executed on the macOS review host.
- **Fix direction:** Create and validate the intended workspace before enabling the service.

### 12. P2 — The systemd unit assumes a particular checkout location

- **Location:** [deploy/systemd/dsh-weixin-gateway.service:38](deploy/systemd/dsh-weixin-gateway.service#L38), [deploy/systemd/install.sh:36–39](deploy/systemd/install.sh#L36).
- **Trigger:** Run the installer from a checkout outside `$HOME/Workspaces/dsh-weixin-gateway`.
- **Impact:** The unchanged unit starts in a nonexistent directory or in another checkout's workspace, rather than the installed checkout's workspace.
- **Evidence:** Static review of the hardcoded path and the installer's unchanged copy operation.
- **Fix direction:** Resolve the checkout's actual workspace during installation or require and validate an explicit working-directory setting.

### 13. P2 — The installer accepts a DSH executable the unit cannot launch

- **Location:** [deploy/systemd/install.sh:33–35](deploy/systemd/install.sh#L33), [deploy/systemd/dsh-weixin-gateway.service:52](deploy/systemd/dsh-weixin-gateway.service#L52).
- **Trigger:** `dsh` is available on `PATH`, for example under `/usr/local/bin`, Linuxbrew, or an npm prefix, but `$HOME/.local/bin/dsh` is absent.
- **Impact:** The installer accepts the executable discovery result, while `ExecStart` uses a different hardcoded path and fails with `EXEC`.
- **Evidence:** Static review; executable discovery and the unit's launch path are not coordinated.
- **Fix direction:** Resolve and validate the executable actually used by the unit, including its Node runtime environment, before enabling the service.

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

## Remaining limitations

- **Delivery durability:** Queues remain in memory and dedupe can persist before execution. Crashes or shutdown can lose queued work; exactly-once execution is not guaranteed.
- **Cancellation retention:** Handles retained after failed timeout cancellation need `/stop` or teardown; later terminal events do not automatically clear them.
- **Shutdown deadline:** Uncancellable session creation/persistence or admission that never settles can block shutdown indefinitely.
- **Coordination scope:** The advisory lock protects one local host/container, not cross-host replicas. Pairing redemption is serialized within one allowlist writer and across reloads, not independent writers sharing a file.
- **Pairing rotation:** Codes consumed before the fix cannot be reconstructed. Rotate the existing code when deploying; replacement requires a distinct value in the configured `bindCodeEnv` variable in the Host environment, normally by restarting Host with the updated environment. Revocation does not reactivate a consumed code.

## Validation and scope

- Before committing `8d77e08`, all **137 offline tests** passed in three consecutive runs, plus `npm run check` and `git diff --check`.
- Each run included 100 fresh and 100 stale lock trials with five contenders, plus separate-process contention for both cases. This is regression evidence, not proof of every schedule or filesystem behavior.
- Tests used macOS, fake Host/client interfaces, temporary files, loopback HTTP, child processes, and offline readline streams. Only disposable fixture accounts were logged out; no live WeChat account, fresh Docker deployment, or Linux systemd execution was tested.
- The initial npm audit at `0f798c1` reported zero known dependency vulnerabilities; dependency manifests remain unchanged. This is not an exhaustive security assessment.
