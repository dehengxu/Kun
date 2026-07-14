import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'
import { parseKunExtensionUrl } from './extension-resource-protocol'

export type ExtensionViewSessionRecord = {
  sessionId: string
  runtimeSessionId: string
  extensionId: string
  extensionVersion: string
  contributionId: string
  workspaceRoot?: string
  entryPath: string
  sourceUrl: string
  partition: string
  nonce: string
  parentWebContentsId: number
  guestWebContentsId?: number
  guestMainFrameProcessId?: number
  guestMainFrameRoutingId?: number
  state: 'pending' | 'attaching' | 'active' | 'disposed'
  createdAt: number
}

export class ExtensionViewSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExtensionViewSessionError'
  }
}

/** Main-owned binding between a Kun View Session and Electron WebContents. */
export class ExtensionViewSessionRegistry {
  private readonly records = new Map<string, ExtensionViewSessionRecord>()
  private readonly byGuest = new Map<number, string>()
  private readonly guests = new Map<number, WebContents>()
  private readonly attachingByParent = new Map<number, string[]>()
  private readonly mainFrameNavigationPending = new Set<string>()
  private readonly disposeListeners = new Set<(record: ExtensionViewSessionRecord) => void>()
  private readonly mainFrameChangeListeners = new Set<(record: ExtensionViewSessionRecord) => void>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(input: {
    sessionId: string
    runtimeSessionId?: string
    extensionId: string
    extensionVersion: string
    nonce?: string
    contributionId: string
    workspaceRoot?: string
    entryPath: string
    parentWebContentsId: number
  }): ExtensionViewSessionRecord {
    if (this.records.has(input.sessionId)) {
      throw new ExtensionViewSessionError('EXTENSION_VIEW_SESSION_DUPLICATE', 'View session already exists.')
    }
    const nonce = input.nonce ?? randomBytes(32).toString('base64url')
    const partitionDigest = createHash('sha256')
      .update(`${input.extensionId}\0${input.sessionId}\0${nonce}`)
      .digest('hex')
      .slice(0, 32)
    const sourceUrl = new URL(`kun-extension://${input.extensionId}/${input.entryPath}`)
    sourceUrl.searchParams.set('kunViewSession', input.sessionId)
    const record: ExtensionViewSessionRecord = {
      ...input,
      runtimeSessionId: input.runtimeSessionId ?? input.sessionId,
      sourceUrl: sourceUrl.toString(),
      partition: `temp:kun-extension-${partitionDigest}`,
      nonce,
      state: 'pending',
      createdAt: this.now()
    }
    this.records.set(record.sessionId, record)
    return { ...record }
  }

  prepareAttach(parentWebContentsId: number, rawUrl: string): ExtensionViewSessionRecord {
    const parsed = parseKunExtensionUrl(rawUrl)
    if (!parsed.viewSessionId) {
      throw new ExtensionViewSessionError(
        'EXTENSION_VIEW_SESSION_REQUIRED',
        'Extension Webview URL is not bound to a View Session.'
      )
    }
    const record = this.records.get(parsed.viewSessionId)
    if (!record || record.state !== 'pending') {
      throw new ExtensionViewSessionError('EXTENSION_VIEW_SESSION_INVALID', 'View session is unavailable.')
    }
    if (
      record.parentWebContentsId !== parentWebContentsId ||
      record.extensionId !== parsed.extensionId ||
      record.entryPath !== parsed.relativePath
    ) {
      throw new ExtensionViewSessionError('EXTENSION_VIEW_SESSION_MISMATCH', 'View session binding mismatch.')
    }
    record.state = 'attaching'
    const queue = this.attachingByParent.get(parentWebContentsId) ?? []
    queue.push(record.sessionId)
    this.attachingByParent.set(parentWebContentsId, queue)
    return { ...record }
  }

  bindNextGuest(parentWebContentsId: number, guest: WebContents): ExtensionViewSessionRecord | undefined {
    const queue = this.attachingByParent.get(parentWebContentsId)
    const sessionId = queue?.shift()
    if (queue?.length === 0) this.attachingByParent.delete(parentWebContentsId)
    if (!sessionId) return undefined
    const record = this.records.get(sessionId)
    if (!record || record.state !== 'attaching') return undefined
    record.guestWebContentsId = guest.id
    record.guestMainFrameProcessId = guest.mainFrame?.processId
    record.guestMainFrameRoutingId = guest.mainFrame?.routingId
    record.state = 'active'
    this.byGuest.set(guest.id, sessionId)
    this.guests.set(guest.id, guest)
    guest.once('destroyed', () => this.dispose(sessionId))
    guest.on?.('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const mainFrameNavigation = typeof details.isMainFrame === 'boolean'
        ? details.isMainFrame
        : isMainFrame
      const sameDocument = typeof details.isSameDocument === 'boolean'
        ? details.isSameDocument
        : isInPlace
      if (mainFrameNavigation && !sameDocument) {
        this.mainFrameNavigationPending.add(record.sessionId)
        this.updateGuestMainFrame(record.sessionId, guest, undefined, undefined)
      }
    })
    guest.on?.(
      'did-frame-navigate',
      (_event, _url, _httpResponseCode, _httpStatusText, isMainFrame, processId, routingId) => {
        if (isMainFrame) {
          this.mainFrameNavigationPending.delete(record.sessionId)
          this.updateGuestMainFrame(record.sessionId, guest, processId, routingId)
        }
      }
    )
    guest.on?.('did-finish-load', () => {
      this.mainFrameNavigationPending.delete(record.sessionId)
      const mainFrame = guest.mainFrame
      this.updateGuestMainFrame(
        record.sessionId,
        guest,
        mainFrame?.processId,
        mainFrame?.routingId
      )
    })
    guest.on?.('did-stop-loading', () => {
      this.mainFrameNavigationPending.delete(record.sessionId)
      const mainFrame = guest.mainFrame
      this.updateGuestMainFrame(
        record.sessionId,
        guest,
        mainFrame?.processId,
        mainFrame?.routingId
      )
    })
    return { ...record }
  }

  requireGuest(
    guestWebContentsId: number,
    sessionId: string,
    nonce: string
  ): ExtensionViewSessionRecord {
    const boundSessionId = this.byGuest.get(guestWebContentsId)
    const record = this.records.get(sessionId)
    if (
      !record ||
      record.state !== 'active' ||
      boundSessionId !== sessionId ||
      record.guestWebContentsId !== guestWebContentsId ||
      record.nonce !== nonce
    ) {
      throw new ExtensionViewSessionError('EXTENSION_VIEW_SENDER_INVALID', 'View sender is not authorized.')
    }
    return { ...record }
  }

  /**
   * Authenticates a privileged request against the bound guest's live main
   * frame. `did-attach-webview` may still expose the provisional about:blank
   * frame, so its process/routing IDs are not durable across the first commit.
   */
  requireCurrentGuestMainFrame(
    guestWebContentsId: number,
    sessionId: string,
    nonce: string,
    senderFrame: Pick<WebFrameMain, 'processId' | 'routingId' | 'detached'> | null
  ): ExtensionViewSessionRecord {
    this.requireGuest(guestWebContentsId, sessionId, nonce)
    const record = this.records.get(sessionId)!
    const guest = this.guests.get(guestWebContentsId)
    const mainFrame = guest?.mainFrame
    if (
      !senderFrame ||
      senderFrame.detached === true ||
      !mainFrame ||
      mainFrame.detached === true ||
      this.mainFrameNavigationPending.has(sessionId) ||
      senderFrame.processId !== mainFrame.processId ||
      senderFrame.routingId !== mainFrame.routingId
    ) {
      throw new ExtensionViewSessionError(
        'EXTENSION_VIEW_SENDER_INVALID',
        'View sender is not the current guest main frame.'
      )
    }
    this.updateGuestMainFrame(
      record.sessionId,
      guest,
      mainFrame.processId,
      mainFrame.routingId
    )
    return { ...record }
  }

  get(sessionId: string): ExtensionViewSessionRecord | undefined {
    const record = this.records.get(sessionId)
    return record ? { ...record } : undefined
  }

  findByGuest(guestWebContentsId: number): ExtensionViewSessionRecord | undefined {
    const sessionId = this.byGuest.get(guestWebContentsId)
    return sessionId ? this.get(sessionId) : undefined
  }

  sendToGuest(sessionId: string, method: string, params?: unknown): boolean {
    const record = this.records.get(sessionId)
    if (!record || record.state !== 'active' || record.guestWebContentsId === undefined) return false
    const guest = this.guests.get(record.guestWebContentsId)
    if (!guest || guest.isDestroyed()) return false
    guest.send('extension:view:notification', { sessionId, method, params })
    return true
  }

  broadcastToGuests(method: string, params?: unknown): number {
    let delivered = 0
    for (const sessionId of this.records.keys()) {
      if (this.sendToGuest(sessionId, method, params)) delivered += 1
    }
    return delivered
  }

  onDidDispose(listener: (record: ExtensionViewSessionRecord) => void): () => void {
    this.disposeListeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.disposeListeners.delete(listener)
    }
  }

  onDidChangeMainFrame(listener: (record: ExtensionViewSessionRecord) => void): () => void {
    this.mainFrameChangeListeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.mainFrameChangeListeners.delete(listener)
    }
  }

  dispose(sessionId: string): boolean {
    const record = this.records.get(sessionId)
    if (!record) return false
    record.state = 'disposed'
    this.records.delete(sessionId)
    this.mainFrameNavigationPending.delete(sessionId)
    if (record.guestWebContentsId !== undefined) {
      this.byGuest.delete(record.guestWebContentsId)
      const guest = this.guests.get(record.guestWebContentsId)
      this.guests.delete(record.guestWebContentsId)
      if (guest && !guest.isDestroyed()) guest.close()
    }
    for (const [parentId, queue] of this.attachingByParent) {
      const filtered = queue.filter((candidate) => candidate !== sessionId)
      if (filtered.length === 0) this.attachingByParent.delete(parentId)
      else if (filtered.length !== queue.length) this.attachingByParent.set(parentId, filtered)
    }
    for (const listener of this.disposeListeners) {
      try {
        listener({ ...record })
      } catch {
        // Session cleanup cannot be blocked by one observer.
      }
    }
    return true
  }

  disposeForExtension(extensionId: string): number {
    const sessionIds = [...this.records.values()]
      .filter((record) => record.extensionId === extensionId)
      .map((record) => record.sessionId)
    for (const sessionId of sessionIds) this.dispose(sessionId)
    return sessionIds.length
  }

  disposeForExtensionWorkspace(extensionId: string, workspaceRoot: string): number {
    const canonicalWorkspace = resolve(workspaceRoot)
    const sessionIds = [...this.records.values()]
      .filter((record) =>
        record.extensionId === extensionId &&
        record.workspaceRoot !== undefined &&
        resolve(record.workspaceRoot) === canonicalWorkspace)
      .map((record) => record.sessionId)
    for (const sessionId of sessionIds) this.dispose(sessionId)
    return sessionIds.length
  }

  disposeForParent(parentWebContentsId: number): number {
    const sessionIds = [...this.records.values()]
      .filter((record) => record.parentWebContentsId === parentWebContentsId)
      .map((record) => record.sessionId)
    for (const sessionId of sessionIds) this.dispose(sessionId)
    return sessionIds.length
  }

  private updateGuestMainFrame(
    sessionId: string,
    guest: WebContents,
    processId: number | undefined,
    routingId: number | undefined
  ): void {
    const record = this.records.get(sessionId)
    if (
      !record ||
      record.state !== 'active' ||
      record.guestWebContentsId !== guest.id ||
      this.guests.get(guest.id) !== guest ||
      (
        record.guestMainFrameProcessId === processId &&
        record.guestMainFrameRoutingId === routingId
      )
    ) {
      return
    }
    record.guestMainFrameProcessId = processId
    record.guestMainFrameRoutingId = routingId
    for (const listener of this.mainFrameChangeListeners) {
      try {
        listener({ ...record })
      } catch {
        // Frame invalidation must not be blocked by one observer.
      }
    }
  }
}
