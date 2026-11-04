# Known issues

Updated on 2026-11-04. The original findings were reviewed at revision `a7d8f49`, after pulling the lock and systemd changes. Fixes are in the uncommitted working tree on top of that revision.

**Fixed offline:** 1, 2, 3, 5, 6, 7, 8, 9, 10. **Open deployment issues:** 4, 11, 12, 13. Trigger, impact, evidence, and numbered location ranges below describe the original reviewed revision; resolution bullets describe the current implementation.

Priority: **P1** denotes a high-priority reliability or access-control defect; **P2** denotes a correctness or deployment defect. Reproduction counts describe this local review run, not guaranteed failure rates on other machines.

## 1. P1 — Concurrent starters can still acquire the same poller lock — fixed offline

- **Resolution:** Fully initialized records are published with an exclusive hard link; abandoned-lock removal uses a recoverable serialized claim and rechecks ownership. Live local PIDs cannot be evicted merely because a heartbeat is old. Heartbeats replace JSON atomically; ownership loss stops polling. Logout now acquires the same account lock and refuses a live poller.
- **Regression coverage:** [test/lock.test.mjs](test/lock.test.mjs) verifies one owner in 100 fresh and 100 stale trials with five contenders each, five separate processes for each case, abandoned claims, malformed records, atomic heartbeat reads, and ownership-loss detection.

- **Location:** [src/store/lock.mjs:94–155](src/store/lock.mjs#L94).
- **Trigger:** Multiple starters contend for a fresh or stale lock. Creation exposes an empty file before its record is written, and stale takeover temporarily removes the canonical lock path.
- **Impact:** More than one acquisition can succeed, violating the single-poller invariant and exposing channel state to concurrent writers.
- **Evidence:** With five simultaneous contenders, multiple owners appeared in 93/100 fresh-lock trials and 100/100 stale-lock trials, with up to three successful owners. Separate two-contender trials passed for both cases, as did the new regression test; that coverage does not establish safety under higher contention.
- **Fix direction:** Publish a fully initialized ownership record atomically and serialize stale takeover without allowing a live owner to be displaced. Add repeated fresh/stale tests with more than two contenders.

## 2. P1 — A failed command drops later messages in its batch — fixed offline

- **Resolution:** Each message has its own failure boundary and error reply. The cursor is checkpointed after handling the batch; shutdown does not checkpoint a partially handled batch.
- **Regression coverage:** [test/gateway.test.mjs](test/gateway.test.mjs) checks a failed command followed by a successful prompt, pending-command checkpoint ordering, and shutdown during a batch.
- **Remaining limitation:** There is no durable inbox/outbox. Accepted prompts remain queued in memory, and dedupe entries can persist before execution. Crashes or shutdown can still lose queued work; this fix does not provide crash-safe delivery or exactly-once execution.

- **Location:** [src/runtime.mjs:391–400](src/runtime.mjs#L391).
- **Trigger:** The poll cursor is saved before processing a batch, then a command such as `/new` throws.
- **Impact:** Processing exits the batch loop; the next poll uses the advanced cursor, permanently skipping unrelated later messages.
- **Evidence:** A batch containing `/new` followed by `hello`, with session creation failing, produced no replies or prompts. The next poll used the cursor after the entire batch.
- **Fix direction:** Isolate per-message failures and advance the cursor only after every message has been handled or explicitly dispositioned. Crash-safe delivery additionally requires durable handling of pending messages; moving the checkpoint alone does not make in-memory queues durable.

## 3. P1 — The advertised one-time pairing code remains reusable — fixed offline

- **Resolution:** Redemption serializes mutations and atomically persists authorization plus a consumed SHA256 code fingerprint. Failed writes grant no access and consume no code; revocation does not reactivate a code. Replacement requires a distinct value in the configured `bindCodeEnv` variable in the Host environment, normally by restarting Host with the updated environment. The reply explains rotation.
- **Regression coverage:** [test/allowed.test.mjs](test/allowed.test.mjs) and [test/commands.test.mjs](test/commands.test.mjs) cover concurrent redemption, restart, revocation, rotation, failed writes, and mode 0600. Serialization is within one allowlist instance, not between independent processes sharing a file.

- **Location:** [src/bridge/commands.mjs:133–157](src/bridge/commands.mjs#L133).
- **Trigger:** Another sender presents a code already redeemed by the intended sender. The environment secret is reread but never consumed.
- **Impact:** Knowledge of a previously used code grants another sender durable access to the agent, including after restart.
- **Evidence:** Two distinct senders were successfully authorized using the same code.
- **Fix direction:** Persistently and atomically consume each pairing code, with an explicit mechanism for issuing a replacement.

## 4. P1 — A fresh Docker home volume is not writable by the service user

- **Location:** [docker/Dockerfile:23–28](docker/Dockerfile#L23), [docker/compose.yaml:14–24](docker/compose.yaml#L14), [docker/entrypoint.sh:10–16](docker/entrypoint.sh#L10).
- **Trigger:** Start the documented deployment with a new `dsh-home` named volume. The image does not initialize `/data/dsh` ownership before switching to UID 1000.
- **Impact:** The root-owned volume prevents profile registration and credential/state writes.
- **Evidence:** Static review of the image, mount, and entrypoint. A fresh Docker deployment was not executed during this review.
- **Fix direction:** Initialize the persistent home with ownership appropriate for the service user before running registration or login.

## 5. P2 — Missing CLI option values can target the wrong account — fixed offline

- **Resolution:** `--state-dir` and `--base-url` reject missing, blank, and option-like values before directory resolution or command execution. Status/logout use the runtime's sanitized account lock path; logout refuses live ownership and releases its own lock even if deletion fails.
- **Regression coverage:** [test/cli.test.mjs](test/cli.test.mjs) checks malformed options against unchanged temporary default-directory fixtures, valid options, locked and idle logout, and deletion-failure cleanup. Only disposable test credentials were deleted.

- **Location:** [bin/dsh-weixin.mjs:50–55](bin/dsh-weixin.mjs#L50), [bin/dsh-weixin.mjs:83–88](bin/dsh-weixin.mjs#L83), [bin/dsh-weixin.mjs:262–267](bin/dsh-weixin.mjs#L262).
- **Trigger:** Invoke `logout --yes --state-dir` without a directory value.
- **Impact:** Parsing accepts `undefined`, resolution silently selects the default state directory, and logout deletes that directory's stored account, state, pairings, and applicable lock without confirmation.
- **Evidence:** Parsing and default-directory fallback were reproduced without executing destructive logout operations.
- **Fix direction:** Reject missing values, including a following option token, before resolving directories or executing commands. Apply the same validation to `--base-url`.

## 6. P2 — Timed-out turns lose their cancellation handle — fixed offline

- **Resolution:** Timeout requests Host cancellation and reports that it was requested, not that execution has ended. Failed cancellation retains the handle and blocks newer prompts until successful `/stop`. Preparation timeout cancels locally and states that no prompt was submitted; typing requests remain under the collector deadline.
- **Regression coverage:** [test/gateway.test.mjs](test/gateway.test.mjs) covers timeout cancellation, failed-cancellation retry, blocked queues, and unresolved typing configuration/send requests.
- **Remaining limitation:** A handle retained after failed timeout cancellation is not automatically cleared by later terminal events because the collector has already timed out. `/stop` or gateway teardown must clear it.

- **Location:** [src/runtime.mjs:581–586](src/runtime.mjs#L581), [src/runtime.mjs:327–340](src/runtime.mjs#L327), [src/runtime.mjs:652–656](src/runtime.mjs#L652).
- **Trigger:** The turn collector times out while Host execution remains active.
- **Impact:** Cleanup removes the active entry without requesting Host cancellation. The reply recommends `/stop`, but `/stop` subsequently reports that nothing is running.
- **Evidence:** A nonresponding fake Host produced the timeout notice; subsequent `/stop` returned `Nothing is running.` with zero cancellation calls.
- **Fix direction:** Request cancellation on timeout or retain explicit execution state until termination, and make the timeout notice accurately describe what happened.

## 7. P2 — An acknowledged stop can still admit a prompt — fixed offline

- **Resolution:** Per-turn cancellation is checked after session creation and typing, without cancelling unrelated Host execution before admission. Unresolved admissions remain tracked and block newer gateway prompts until settlement, preventing late session-wide cancellation from targeting a newer prompt. Failed late cancellation retains a usable handle.
- **Regression coverage:** [test/gateway.test.mjs](test/gateway.test.mjs) covers stop during creation/configuration/typing, delayed admission, failed late cancellation, and completed output arriving before admission settlement.

- **Location:** [src/runtime.mjs:569–578](src/runtime.mjs#L569), [src/runtime.mjs:327–340](src/runtime.mjs#L327).
- **Trigger:** `/stop` arrives after the active entry is created but while the typing request is pending, before prompt admission.
- **Impact:** Cancellation is acknowledged, but the code subsequently submits the prompt anyway.
- **Evidence:** Delaying `getConfig`, requesting stop, and then releasing the delay resulted in a prompt being admitted after the stop acknowledgement.
- **Fix direction:** Record cancellation against the specific pending turn and check it before prompt admission. Keep pre-admission cancellation distinct from cancellation of an already-running turn.

## 8. P2 — An earlier session creation can undo `/new` — fixed offline

- **Resolution:** Ordinary creation and reset share per-sender serialization. Resets register synchronously; waiting prompts follow the latest queued reset. Failed operations do not block later resets, and different senders remain independent.
- **Regression coverage:** [test/session-router.test.mjs](test/session-router.test.mjs) covers initial/reset ordering, concurrent resets, existing mappings, durable acknowledged mappings, failure recovery, and independent senders.

- **Location:** [src/bridge/session-router.mjs:46–50](src/bridge/session-router.mjs#L46), [src/bridge/session-router.mjs:60–82](src/bridge/session-router.mjs#L60).
- **Trigger:** Initial session creation is still pending when `/new` starts another creation. The reset completes first, followed by the original creation.
- **Impact:** `/new` acknowledges the fresh session, but the original creation overwrites the mapping, routing later messages back to the earlier session.
- **Evidence:** Deferred creation promises yielded an acknowledged `new-session` followed by a final mapping to `original-session`.
- **Fix direction:** Coordinate ordinary creation and reset through the same per-sender serialization or generation mechanism.

## 9. P2 — Verification input ignores login timeout and cancellation — fixed offline

- **Resolution:** Verification waiting uses the remaining login budget and abort signal. The CLI passes cancellation into readline so the pending question itself terminates; timers/listeners are cleaned up on settlement.
- **Regression coverage:** [test/auth.test.mjs](test/auth.test.mjs) and [test/cli.test.mjs](test/cli.test.mjs) cover unresolved input timeout/abort, successful verification, prompt failure, listener cleanup, and real readline question cancellation with offline streams.

- **Location:** [src/ilink/auth.mjs:132–143](src/ilink/auth.mjs#L132).
- **Trigger:** Login reaches `need_verifycode` and operator input never resolves.
- **Impact:** Login remains pending beyond its configured deadline and after its abort signal fires.
- **Evidence:** A verification prompt that never resolves remained pending after both a short timeout and an explicit abort.
- **Fix direction:** Bound input waiting by the remaining deadline and abort signal, and close the input interface when the operation terminates.

## 10. P2 — An in-flight lock retry can restart polling after shutdown — fixed offline

- **Resolution:** Startup, shutdown, and sender drains are tracked. The lifetime abort controller exists before account lookup; shutdown cancels lookup waiting and awaits resource-producing work before releasing ownership. Restart after error tears down the old generation before replacing its signal or collector; drains retain their original lifetime and require running/paused status.
- **Regression coverage:** [test/gateway.test.mjs](test/gateway.test.mjs) covers pending retry lookup, immediate startup/shutdown, shutdown during execution/persistence, ownership loss during polling/pause, and restart with reacquisition or lock refusal. Old queues and observers are cleared.
- **Remaining limitation:** Shutdown waits for uncancellable session creation/persistence and unresolved admission. A Host that never settles those operations, even after cancellation, can block shutdown indefinitely; no hard shutdown deadline is provided.

- **Location:** [src/runtime.mjs:225–247](src/runtime.mjs#L225), [src/runtime.mjs:258–266](src/runtime.mjs#L258).
- **Trigger:** A scheduled retry enters `start()` and waits for credentials; `stop()` completes before that wait resolves.
- **Impact:** The untracked startup resumes after shutdown, acquires the lock, and starts polling. Plugin disposal can therefore leave a gateway running outside its intended lifecycle.
- **Evidence:** Holding the retry's account lookup pending produced `starting` → `stopped` → `running`, with ownership of the lock after stop had returned.
- **Fix direction:** Track and cancel or await retry startup, and prevent a startup generation from publishing resources after its lifetime has ended.

## 11. P1 — Fresh systemd installation can fail before workspace creation

- **Location:** [deploy/systemd/dsh-weixin-gateway.service:38](deploy/systemd/dsh-weixin-gateway.service#L38), [deploy/systemd/install.sh:36–39](deploy/systemd/install.sh#L36), [src/index.mjs:79–83](src/index.mjs#L79).
- **Trigger:** Install the service before an interactive plugin run has created the untracked `workspace/` directory.
- **Impact:** Systemd must enter the directory before launching DSH, but directory creation happens inside the plugin. Startup therefore fails with `CHDIR` and repeatedly restarts.
- **Evidence:** Static review; no systemd service was installed or executed on the macOS review host.
- **Fix direction:** Create and validate the intended workspace before enabling the service.

## 12. P2 — The systemd unit assumes a particular checkout location

- **Location:** [deploy/systemd/dsh-weixin-gateway.service:38](deploy/systemd/dsh-weixin-gateway.service#L38), [deploy/systemd/install.sh:36–39](deploy/systemd/install.sh#L36).
- **Trigger:** Run the installer from a checkout outside `$HOME/Workspaces/dsh-weixin-gateway`.
- **Impact:** The unchanged unit starts in a nonexistent directory or in another checkout's workspace, rather than the installed checkout's workspace.
- **Evidence:** Static review of the hardcoded path and the installer's unchanged copy operation.
- **Fix direction:** Resolve the checkout's actual workspace during installation or require and validate an explicit working-directory setting.

## 13. P2 — The installer accepts a DSH executable the unit cannot launch

- **Location:** [deploy/systemd/install.sh:33–35](deploy/systemd/install.sh#L33), [deploy/systemd/dsh-weixin-gateway.service:52](deploy/systemd/dsh-weixin-gateway.service#L52).
- **Trigger:** `dsh` is available on `PATH`, for example under `/usr/local/bin`, Linuxbrew, or an npm prefix, but `$HOME/.local/bin/dsh` is absent.
- **Impact:** The installer accepts the executable discovery result, while `ExecStart` uses a different hardcoded path and fails with `EXEC`.
- **Evidence:** Static review; executable discovery and the unit's launch path are not coordinated.
- **Fix direction:** Resolve and validate the executable actually used by the unit, including its Node runtime environment, before enabling the service.

## Validation and scope

- The original `a7d8f49` baseline passed 76 offline tests. The fixed working tree passes all **137 offline tests**, with zero failures in three consecutive complete runs, plus `npm run check` and `git diff --check`.
- Each complete run includes 100 fresh and 100 stale five-contender lock trials, plus separate-process contention for both cases. These provide regression evidence, not proof of every possible schedule or filesystem behavior.
- Dependency auditing against the npm registry reported zero known vulnerabilities during the initial review at `0f798c1`; dependency manifests remain unchanged. This is not proof that application code is vulnerability-free.
- Tests run on macOS with fake Host/client interfaces, temporary files, loopback HTTP, child processes, and offline readline streams. Only disposable fixture accounts were logged out. No real account, live WeChat service, fresh Docker deployment, or Linux systemd execution was exercised; no commit or push was made.
- The gateway remains an in-process DSH/Cordis plugin. Its advisory lock protects one local host/container, not replicas on different hosts. Pairing redemption is serialized within one allowlist writer and across reloads, not independent processes sharing the file. Codes consumed before installing this fix cannot be reconstructed; rotate the existing pairing code when deploying it.
- Docker/systemd findings remain open and unchanged. Crash-durable queues, independent allowlist writers, and indefinitely stalled Host operations remain limitations as described above. This is not an exhaustive security assessment.
