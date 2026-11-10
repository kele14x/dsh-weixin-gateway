/**
 * DSH Workspace grouping.
 *
 * The Web sidebar groups Sessions by Workspace, and a Session appears under a
 * Workspace only while that Workspace records it. A Session created in a
 * directory nobody registered therefore renders under "Ungrouped"
 * (`未分组`), which is how every WeChat conversation looked before this binder.
 *
 * The binder registers the channel's session directory once, adopts the
 * Sessions the channel created earlier, and hands the resulting Workspace id to
 * new Session creations. Grouping is a UI convenience: a profile without the
 * `workspaceRegistry` service keeps working, and a registry failure logs a
 * warning instead of stopping the channel.
 *
 * @module dsh-weixin-gateway/bridge/workspace
 */

import { sessionMappings } from '../store/state.mjs'
import { silentLogger } from '../util/log.mjs'

/** @typedef {{workspaceId: string, path: string, title: string}} WorkspaceBinding */

/**
 * How long the first Session creation waits for a registry that is still
 * mounting. The Host usually injects it before the poller starts; this only
 * covers a message that arrives during the same boot, so a first conversation is
 * not silently left ungrouped. A headless profile pays this once.
 */
const REGISTRY_WAIT_MS = 1_500

/** Registers and remembers the Workspace that groups this channel's Sessions. */
export class WorkspaceBinder {
  /**
   * @param {object} options - binder options.
   * @param {string} options.stateDir - channel state root, scanned for earlier Sessions.
   * @param {string} options.dir - directory the channel's Sessions run in.
   * @param {string} options.title - display title used when the Workspace is first created.
   * @param {number} [options.registryWaitMs] - bounded wait for a late registry.
   * @param {object} [options.logger] - logger.
   */
  constructor({ stateDir, dir, title, registryWaitMs = REGISTRY_WAIT_MS, logger = silentLogger }) {
    this.stateDir = stateDir
    this.dir = dir
    this.title = title
    this.registryWaitMs = registryWaitMs
    this.logger = logger
    /** @type {object|undefined} */
    this.registry = undefined
    /** @type {Promise<WorkspaceBinding|undefined>|undefined} */
    this.binding = undefined
    /** @type {boolean} */
    this.waitedForRegistry = false
    /** @type {Promise<void>} resolves when a registry is injected (or never). */
    this.available = new Promise((resolve) => {
      this.resolveAvailable = resolve
    })
  }

  /**
   * Use the Host's Workspace registry.
   *
   * Called from a `workspaceRegistry` injection, so an unavailable registry
   * simply leaves the channel ungrouped instead of failing it.
   *
   * @param {object} registry - `ctx.workspaceRegistry`.
   * @returns {void}
   */
  use(registry) {
    this.registry = registry
    this.resolveAvailable()
  }

  /** Forget the registry and any resolved binding (used on dispose). */
  detach() {
    this.registry = undefined
    this.binding = undefined
  }

  /**
   * Resolve the Workspace, creating it on first use.
   *
   * A failed attempt is not memoized, so a later Session creation retries
   * instead of treating one transient storage error as permanent.
   *
   * @returns {Promise<WorkspaceBinding|undefined>} binding, or undefined when grouping is unavailable.
   */
  async ensure() {
    if (this.registry === undefined && !this.waitedForRegistry) {
      this.waitedForRegistry = true
      let timer
      await Promise.race([
        this.available,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.registryWaitMs)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
    }
    const registry = this.registry
    if (registry === undefined) return undefined
    if (this.binding !== undefined) return this.binding

    this.binding = (async () => {
      const workspace = await registry.create(this.dir, this.title)
      return { workspaceId: workspace.id, path: workspace.path, title: workspace.title }
    })().catch((error) => {
      this.binding = undefined
      this.logger.warn('could not register the WeChat workspace; Sessions stay ungrouped', {
        dir: this.dir,
        reason: error.message,
      })
      return undefined
    })
    return this.binding
  }

  /**
   * Group the conversations recorded by earlier runs.
   *
   * Runs at mount, so an existing WeChat Session joins the group without
   * waiting for the next message or a `/new`. A channel with no recorded
   * Session creates nothing: an empty group is not worth showing.
   *
   * @returns {Promise<void>} resolves once adoption was attempted.
   */
  async adopt() {
    const mappings = await sessionMappings(this.stateDir).catch((error) => {
      this.logger.warn('could not read recorded WeChat Sessions for workspace grouping', {
        reason: error.message,
      })
      return []
    })
    if (mappings.length === 0) return

    const binding = await this.ensure()
    const workspace = binding === undefined ? undefined : this.registry?.get(binding.workspaceId)
    if (workspace === undefined) return

    let adopted = 0
    let skipped = 0
    for (const mapping of mappings) {
      if (workspace.sessionIds?.includes(mapping.sessionId) === true) continue
      try {
        await workspace.attachSession(mapping.sessionId)
        adopted += 1
      } catch (error) {
        // A stale mapping, a Session created in an older directory, or a
        // Session that already belongs elsewhere stays out of this group.
        skipped += 1
        this.logger.debug('recorded WeChat Session was not grouped', {
          sessionId: mapping.sessionId,
          reason: error.message,
        })
      }
    }
    const details = { title: binding.title, path: binding.path, adopted, skipped }
    if (adopted > 0) {
      this.logger.info('grouped WeChat conversations under one workspace', details)
    } else {
      this.logger.debug('no recorded WeChat Session needed grouping', details)
    }
  }
}
