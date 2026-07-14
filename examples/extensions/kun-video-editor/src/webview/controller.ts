import {
  ExtensionApiError,
  ResultPreviewOpenPayloadSchema,
  type AgentRunEvent,
  type ExtensionHostClient,
  type GeneratedArtifact,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaMetadata
} from '@kun/extension-api'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  INITIAL_EDITOR_STATE,
  VIEW_LIMITS,
  editorReducer,
  generatedArtifacts,
  toPersistedState,
  type CanvasFit,
  type CanvasPreset,
  type EditorNotice,
  type EditorState,
  type PersistedEditorState,
  type ProjectChange,
  type ProjectProjection,
  type ProjectSummary,
  type RenderTicket,
  type TimelineOperation
} from './model.js'
import { formatMessage, messagesFor, type MessageKey } from './i18n.js'

const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'cancelled', 'budget-exhausted'])
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const JOB_STATUS_RECONCILE_INTERVAL_MS = 1_000
const EDITOR_COMMAND = 'editor-request'
const COMMAND_PROGRESS_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  'Probing Host-granted media': 'commandProgressProbingMedia',
  'Persisted probed asset metadata': 'commandProgressMediaMetadataSaved',
  'Media import complete': 'commandProgressImportComplete',
  'Probing replacement media grant': 'commandProgressProbingReplacement',
  'Replacement media grant saved': 'commandProgressReplacementSaved',
  'Submitting durable media job': 'commandProgressSubmittingJob',
  'Durable media job queued': 'commandProgressJobQueued'
}

export type EditorController = {
  state: EditorState
  refreshAll(): Promise<void>
  createProject(
    name: string,
    preset: CanvasPreset,
    fps?: { numerator: number; denominator: number }
  ): Promise<void>
  openProject(projectId: string): Promise<void>
  importMedia(): Promise<void>
  importTranscript(): Promise<void>
  checkLocalTranscriber(): Promise<void>
  generateCaptions(): Promise<void>
  openAsset(assetId: string): Promise<void>
  refreshActiveLease(): Promise<void>
  recoverMedia(assetId?: string): Promise<void>
  applyOperations(operations: TimelineOperation[], summary: string): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  readScript(): Promise<void>
  editScript(markdown: string): void
  applyScript(ranges: Array<{ assetId: string; startUs: number; endUs: number; reason?: 'filler' | 'silence' | 'selection' }>): Promise<void>
  seek(frame: number): void
  togglePlaying(): void
  selectItem(itemId?: string): void
  selectCaption(captionId?: string): void
  setTranscriptWindow(start: number): void
  setTimelineWindow(start: number): void
  startAgent(prompt: string): Promise<void>
  steerAgent(prompt: string): Promise<void>
  cancelAgent(): Promise<void>
  startRender(
    kind: RenderTicket['renderKind'],
    captionMode: 'none' | 'burned' | 'sidecar' | 'both',
    subtitleFormat?: 'srt' | 'vtt'
  ): Promise<void>
  cancelJob(jobId: string): Promise<void>
  openArtifact(artifact: GeneratedArtifact): Promise<void>
  revealArtifact(artifact: GeneratedArtifact): Promise<void>
  dismissNotice(id: string): void
}

export function useEditorController(client: ExtensionHostClient): EditorController {
  const [state, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE)
  const stateRef = useRef(state)
  const localeRef = useRef(state.locale)
  const ownedLeaseIds = useRef(new Set<string>())
  const projectLoadGeneration = useRef(0)
  const activeProjectResolutionGeneration = useRef(0)
  const openMediaHandleRef = useRef<((handleId: string) => Promise<void>) | undefined>(undefined)
  stateRef.current = state

  const copy = useCallback((key: MessageKey, values?: Readonly<Record<string, string | number>>): string => {
    return formatMessage(messagesFor(localeRef.current)[key], values)
  }, [])

  const pushNotice = useCallback((notice: Omit<EditorNotice, 'id'> & { id?: string }) => {
    dispatch({
      type: 'notice',
      value: { ...notice, id: notice.id ?? `notice-${Date.now().toString(36)}` }
    })
  }, [])

  const execute = useCallback(async (action: string, payload: JsonObject = {}): Promise<Record<string, unknown>> => {
    const result = await client.commands.executeCommand<JsonValue>(EDITOR_COMMAND, { action, payload })
    const outer = asRecord(result, copy('invalidHostResponse'))
    return isRecord(outer.content) ? outer.content : outer
  }, [client, copy])

  const releaseAllLeases = useCallback(async (): Promise<void> => {
    const leaseIds = [...ownedLeaseIds.current]
    ownedLeaseIds.current.clear()
    await Promise.all(leaseIds.map((leaseId) =>
      client.media.release({ resource: 'lease', leaseId }).catch(() => undefined)
    ))
    dispatch({ type: 'active-media', handleId: undefined, url: undefined })
  }, [client])

  const loadProject = useCallback(async (projectId: string): Promise<ProjectProjection> => {
    const generation = ++projectLoadGeneration.current
    const content = await execute('project.get', { projectId })
    const project = projectFrom(content, copy('invalidProjectProjection'))
    if (generation !== projectLoadGeneration.current) return project
    if (stateRef.current.project && stateRef.current.project.id !== project.id) {
      await releaseAllLeases()
      if (generation !== projectLoadGeneration.current) return project
    }
    dispatch({ type: 'project', value: project })
    return project
  }, [copy, execute, releaseAllLeases])

  const loadProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const content = await execute('project.list')
    const projects = Array.isArray(content.projects)
      ? content.projects.filter(isProjectSummary).slice(0, VIEW_LIMITS.projects)
      : []
    const invalidProjectIds = Array.isArray(content.diagnostics)
      ? content.diagnostics
        .filter((value): value is Record<string, unknown> => isRecord(value) && typeof value.id === 'string')
        .map(({ id }) => String(id))
        .slice(0, VIEW_LIMITS.projects)
      : []
    if (invalidProjectIds.length > 0) {
      const values = {
        count: invalidProjectIds.length,
        projects: invalidProjectIds.join(', ')
      }
      pushNotice({
        id: 'invalid-projects-skipped',
        severity: 'warning',
        message: formatMessage(copy('invalidProjectsSkipped'), values),
        messageKey: 'invalidProjectsSkipped',
        messageValues: values
      })
    }
    dispatch({ type: 'projects', value: projects })
    return projects
  }, [copy, execute, pushNotice])

  const loadActiveProject = useCallback(async (): Promise<ProjectProjection | null | undefined> => {
    const generation = ++activeProjectResolutionGeneration.current
    const active = await execute('project.active')
    if (generation !== activeProjectResolutionGeneration.current) return undefined
    if (!isRecord(active.project)) return null
    return await loadProject(projectFrom(active, copy('invalidProjectProjection')).id)
  }, [copy, execute, loadProject])

  const refreshJobs = useCallback(async (): Promise<JobSnapshot[]> => {
    const [page, tracked] = await Promise.all([
      client.jobs.list({ limit: VIEW_LIMITS.jobs }),
      execute('render.list')
    ])
    if (Array.isArray(tracked.records)) {
      for (const record of tracked.records) {
        if (isRenderTicket(record)) dispatch({ type: 'render-ticket', value: record })
      }
    }
    dispatch({ type: 'jobs', value: page.items })
    return page.items
  }, [client, execute])

  const restoreRun = useCallback(async (runId: string | undefined): Promise<void> => {
    if (!runId) return
    try {
      dispatch({ type: 'agent-run', value: await client.agent.getRun(runId) })
    } catch {
      pushNotice({
        id: 'run-unavailable',
        severity: 'warning',
        message: copy('previousAgentUnavailable'),
        messageKey: 'previousAgentUnavailable'
      })
    }
  }, [client, copy, pushNotice])

  const refreshAll = useCallback(async (): Promise<void> => {
    dispatch({ type: 'reconnect' })
    try {
      await Promise.all([
        loadProjects(),
        refreshJobs(),
        loadActiveProject().then(async (project) => {
          if (project === null) {
            await releaseAllLeases()
            dispatch({ type: 'clear-project' })
          }
        })
      ])
      if (stateRef.current.agentRun) await restoreRun(stateRef.current.agentRun.id)
      dispatch({ type: 'connection', value: 'online' })
    } catch (error) {
      dispatch({ type: 'connection', value: 'offline' })
      pushNotice(classifyError(
        error,
        copy('reconnectFailed'),
        copy('completeProtectedInteraction'),
        true,
        'reconnectFailed'
      ))
    }
  }, [copy, loadActiveProject, loadProjects, pushNotice, refreshJobs, releaseAllLeases, restoreRun])

  useEffect(() => {
    let disposed = false
    let themeChanged = false
    let localeChanged = false
    const themeSubscription = client.ui.onDidChangeTheme((value) => {
      themeChanged = true
      dispatch({ type: 'theme', value })
    })
    const localeSubscription = client.ui.onDidChangeLocale((value) => {
      localeChanged = true
      localeRef.current = value
      dispatch({ type: 'locale', value })
    })
    void client.ui.getTheme().then((value) => {
      if (!disposed && !themeChanged) dispatch({ type: 'theme', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('hostClientError'),
        copy('completeProtectedInteraction'),
        true,
        'hostClientError'
      ))
    })
    void client.ui.getLocale().then((value) => {
      if (disposed || localeChanged) return
      localeRef.current = value
      dispatch({ type: 'locale', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('hostClientError'),
        copy('completeProtectedInteraction'),
        true,
        'hostClientError'
      ))
    })
    return () => {
      disposed = true
      void themeSubscription.dispose()
      void localeSubscription.dispose()
    }
  }, [client, copy, pushNotice])

  useEffect(() => {
    let disposed = false
    void client.media.getCapabilities().then((value) => {
      if (!disposed) dispatch({ type: 'media-capabilities', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('mediaCapabilitiesUnavailable'),
        copy('completeProtectedInteraction'),
        true,
        'mediaCapabilitiesUnavailable'
      ))
    })
    return () => { disposed = true }
  }, [client, copy, pushNotice])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const [restored] = await Promise.all([
          client.ui.getViewState<JsonValue>(),
          loadProjects()
        ])
        if (disposed) return
        const persisted = persistedState(restored)
        dispatch({ type: 'initialized', ...(persisted ? { persisted } : {}) })
        await refreshJobs()
        await loadActiveProject()
        await restoreRun(persisted?.activeRunId)
      } catch (error) {
        if (disposed) return
        dispatch({ type: 'initialized' })
        dispatch({ type: 'connection', value: 'offline' })
        pushNotice(classifyError(
          error,
          copy('editorInitializeFailed'),
          copy('completeProtectedInteraction'),
          true,
          'editorInitializeFailed'
        ))
      }
    })()
    return () => { disposed = true }
  }, [client, copy, loadActiveProject, loadProjects, pushNotice, refreshJobs, restoreRun])

  useEffect(() => {
    const errorSubscription = client.onDidError((error) => pushNotice(classifyError(
      error,
      copy('hostClientError'),
      copy('completeProtectedInteraction'),
      true,
      'hostClientError'
    )))
    const messageSubscription = client.ui.onDidReceiveMessage((message) => {
      if (message.channel === 'kun.extension.view.overflow') {
        void refreshAll()
        return
      }
      if (message.channel === 'kun-video-editor.project-changed') {
        const change = projectChange(message.payload, copy('projectChanged'))
        if (change) dispatch({ type: 'project-change', value: change })
        if (
          change &&
          (change.projectId === stateRef.current.project?.id || change.reason === 'active-project-changed')
        ) {
          if (change.reason === 'active-project-changed') activeProjectResolutionGeneration.current += 1
          void loadProject(change.projectId)
        }
        return
      }
      if (message.channel === 'kun-video-editor.active-project-changed') {
        const change = projectChange(message.payload, copy('projectChanged'))
        if (change) {
          activeProjectResolutionGeneration.current += 1
          dispatch({ type: 'project-change', value: change })
          void loadProject(change.projectId)
        }
        return
      }
      if (message.channel === 'kun.resultPreview.open') {
        const preview = ResultPreviewOpenPayloadSchema.safeParse(message.payload)
        if (preview.success) {
          dispatch({ type: 'result-preview', value: preview.data })
          if (preview.data.result.mediaHandleId) {
            void openMediaHandleRef.current?.(preview.data.result.mediaHandleId)
          }
        }
        return
      }
      if (message.channel === 'kun-video-editor.command-progress') {
        const progress = isRecord(message.payload) ? message.payload : {}
        if (typeof progress.message === 'string') {
          const key = COMMAND_PROGRESS_MESSAGE_KEYS[progress.message] ?? 'commandProgressGeneric'
          pushNotice({
            id: 'command-progress',
            severity: 'info',
            message: copy(key),
            messageKey: key
          })
        }
      }
    })
    return () => {
      void errorSubscription.dispose()
      void messageSubscription.dispose()
    }
  }, [client, copy, loadProject, pushNotice, refreshAll])

  useEffect(() => {
    if (!state.initialized) return
    const timeout = setTimeout(() => {
      void client.ui.setViewState(toPersistedState(stateRef.current)).catch((error) => {
        pushNotice(classifyError(
          error,
          copy('viewStateSaveFailed'),
          copy('completeProtectedInteraction'),
          true,
          'viewStateSaveFailed'
        ))
      })
    }, 180)
    return () => clearTimeout(timeout)
  }, [client, copy, pushNotice, state.agentRun?.id, state.initialized, state.playheadFrame, state.project?.id, state.renderTickets, state.selectedItemId, state.transcriptWindowStart])

  useEffect(() => {
    const run = state.agentRun
    if (!run || TERMINAL_AGENT_STATES.has(run.state)) return
    let disposed = false
    let subscription: Awaited<ReturnType<typeof client.agent.subscribe>> | undefined
    let eventSubscription: { dispose(): void | Promise<void> } | undefined
    void client.agent.subscribe({
      runId: run.id,
      afterSequence: stateRef.current.agentEvents.at(-1)?.sequence ?? 0
    }).then((created) => {
      if (disposed) return void created.dispose()
      subscription = created
      eventSubscription = created.onEvent((event) => {
        dispatch({ type: 'agent-event', value: event })
        if (event.type === 'state' || event.type === 'terminal') {
          void client.agent.getRun(run.id).then((value) => dispatch({ type: 'agent-run', value }))
        }
        if (agentEventChangesProject(event) && stateRef.current.project) {
          void loadProject(stateRef.current.project.id)
        }
      })
    }).catch((error) => pushNotice(classifyError(
      error,
      copy('agentStreamDisconnected'),
      copy('completeProtectedInteraction'),
      true,
      'agentStreamDisconnected'
    )))
    return () => {
      disposed = true
      void eventSubscription?.dispose()
      void subscription?.dispose()
    }
  }, [client, copy, loadProject, pushNotice, state.agentRun?.id, state.reconnectToken])

  const activeJobsKey = useMemo(() => state.jobs
    .filter(({ state: jobState }) => !TERMINAL_JOB_STATES.has(jobState))
    .map(({ id, state: jobState }) => `${id}:${jobState}`)
    .sort()
    .join('|'), [state.jobs])

  useEffect(() => {
    const active = state.jobs.filter(({ state: jobState }) => !TERMINAL_JOB_STATES.has(jobState))
    const disposables: Array<{ dispose(): void | Promise<void> }> = []
    let disposed = false
    let reconcileInFlight = false
    for (const job of active) {
      void client.jobs.subscribe({ jobId: job.id, afterCursor: job.latestCursor }).then((subscription) => {
        if (disposed) return void subscription.dispose()
        disposables.push(subscription)
        // Register first: the SDK delivers buffered/replayed events synchronously
        // from onEvent() and folds them into the subscription snapshot.
        disposables.push(subscription.onEvent((event) => dispatch({ type: 'job-event', value: event })))
        dispatch({
          type: 'jobs',
          value: [
            ...stateRef.current.jobs.filter(({ id }) => id !== subscription.snapshot.id),
            subscription.snapshot
          ]
        })
        if (subscription.replayGap) {
          pushNotice({
            id: `job-gap-${job.id}`,
            severity: 'warning',
            message: copy('jobProgressExpired'),
            messageKey: 'jobProgressExpired'
          })
        }
      }).catch((error) => {
        const values = { id: job.id }
        pushNotice(classifyError(
          error,
          formatMessage(copy('jobDisconnected'), values),
          copy('completeProtectedInteraction'),
          true,
          'jobDisconnected',
          values
        ))
      })
    }
    const reconcileTimer = active.length > 0
      ? setInterval(() => {
        if (disposed || reconcileInFlight) return
        const tracked = stateRef.current.jobs.filter(({ state: jobState }) =>
          !TERMINAL_JOB_STATES.has(jobState)
        )
        if (tracked.length === 0) return
        reconcileInFlight = true
        void Promise.all(tracked.map(async (job) => {
          try {
            return await client.jobs.get(job.id)
          } catch {
            // The live subscription remains the primary path. A transient status
            // read must not disconnect it or spam the user with duplicate errors.
            return job
          }
        })).then((snapshots) => {
          if (disposed) return
          const refreshed = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
          dispatch({
            type: 'jobs',
            value: stateRef.current.jobs.map((job) => refreshed.get(job.id) ?? job)
          })
        }).finally(() => { reconcileInFlight = false })
      }, JOB_STATUS_RECONCILE_INTERVAL_MS)
      : undefined
    return () => {
      disposed = true
      if (reconcileTimer !== undefined) clearInterval(reconcileTimer)
      for (const disposable of disposables) void disposable.dispose()
    }
  }, [activeJobsKey, client, copy, pushNotice, state.reconnectToken])

  useEffect(() => () => {
    for (const leaseId of ownedLeaseIds.current) {
      void client.media.release({ resource: 'lease', leaseId }).catch(() => undefined)
    }
  }, [client])

  const withBusy = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    dispatch({ type: 'busy', value: true })
    try {
      await operation()
    } catch (error) {
      const currentRevision = revisionFromError(error)
      if (isRevisionConflict(error) && stateRef.current.project) {
        dispatch({
          type: 'conflict',
          expectedRevision: stateRef.current.project.currentRevision,
          ...(currentRevision === undefined ? {} : { currentRevision })
        })
        await loadProject(stateRef.current.project.id).catch(() => undefined)
      }
      pushNotice(classifyError(
        error,
        copy('editorOperationFailed'),
        copy('completeProtectedInteraction'),
        isOpaqueHostError(error) || error instanceof ExtensionApiError,
        'editorOperationFailed'
      ))
    } finally {
      dispatch({ type: 'busy', value: false })
    }
  }, [copy, loadProject, pushNotice])

  const createProject = useCallback(async (
    name: string,
    preset: CanvasPreset,
    fps: { numerator: number; denominator: number } = { numerator: 30, denominator: 1 }
  ): Promise<void> => {
    await withBusy(async () => {
      const normalized = name.trim().slice(0, 160)
      if (!normalized) throw new Error(copy('projectNameRequired'))
      const idBase = normalized.toLowerCase().replace(/[^a-z0-9._~-]+/gu, '-').replace(/^-|-$/gu, '') || 'video'
      const projectId = `${idBase.slice(0, 96)}-${Date.now().toString(36)}`
      const content = await execute('project.create', {
        projectId,
        name: normalized,
        canvasPreset: preset,
        fps
      })
      const created = projectFrom(content, copy('invalidProjectProjection'))
      await loadProject(created.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const openProject = useCallback(async (projectId: string): Promise<void> => {
    await withBusy(async () => {
      await execute('project.select', { projectId })
      await loadProject(projectId)
    })
  }, [execute, loadProject, withBusy])

  const importMedia = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (stateRef.current.mediaCapabilities?.ffprobe.available === false) {
        pushNotice({
          id: 'ffprobe-unavailable',
          severity: 'warning',
          message: copy('ffprobeUnavailable'),
          messageKey: 'ffprobeUnavailable'
        })
        return
      }
      const selection = await client.media.pickFiles({
        multiple: true,
        maxFiles: 8,
        filters: [{
          name: copy('chooseMedia'),
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4a', 'mp3', 'wav'],
          mimeTypes: ['video/*', 'audio/*']
        }]
      })
      if (selection.outcome === 'cancelled') return
      let revision = project.currentRevision
      let attemptedIndex = -1
      let importedCount = 0
      try {
        for (const [index, file] of selection.files.entries()) {
          attemptedIndex = index
          const content = await execute('media.import', {
            projectId: project.id,
            expectedRevision: revision,
            mediaHandleId: file.handleId,
            addToTimeline: true
          })
          if (content.outcome === 'unavailable') {
            const messageKey: MessageKey = content.code === 'FFPROBE_UNAVAILABLE'
              ? 'ffprobeUnavailable'
              : 'mediaCapabilitiesUnavailable'
            pushNotice({
              id: 'media-import-unavailable',
              severity: 'warning',
              message: copy(messageKey),
              messageKey
            })
            await Promise.all(selection.files.slice(index).map(({ handleId }) =>
              client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
            ))
            await loadProject(project.id)
            await loadProjects()
            return
          }
          if (content.outcome !== 'imported') throw new Error(copy('invalidHostResponse'))
          const currentRevision = safeInteger(content.currentRevision)
          if (currentRevision === undefined || currentRevision <= revision) {
            throw new Error(copy('invalidHostResponse'))
          }
          revision = currentRevision
          importedCount += 1
          dispatch({ type: 'media', value: [file] })
        }
      } catch (error) {
        const authoritative = await loadProject(project.id).catch(() => undefined)
        const retainedHandles = new Set(authoritative?.assets
          .map(({ mediaHandleId }) => mediaHandleId)
          .filter((handleId): handleId is string => typeof handleId === 'string'))
        const unattemptedStart = Math.max(0, attemptedIndex + 1)
        const releasable = selection.files.filter(({ handleId }, index) =>
          index >= unattemptedStart || (authoritative !== undefined && !retainedHandles.has(handleId))
        )
        await Promise.all(releasable.map(({ handleId }) =>
          client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
        if (importedCount > 0) {
          const values = { count: importedCount }
          pushNotice({
            id: 'media-import-partial',
            severity: 'warning',
            message: formatMessage(copy('mediaImportPartial'), values),
            messageKey: 'mediaImportPartial',
            messageValues: values
          })
          await loadProjects().catch(() => undefined)
        }
        throw error
      }
      await loadProject(project.id)
      await loadProjects()
    })
  }, [client, copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const importTranscript = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = stateRef.current.selectedAssetId
      if (!assetId || !project.assets.some(({ id }) => id === assetId)) {
        throw new Error(copy('selectAssetForTranscript'))
      }
      const selection = await client.media.pickFiles({
        multiple: false,
        maxFiles: 1,
        filters: [{
          name: copy('chooseTranscript'),
          extensions: ['srt', 'vtt', 'json'],
          mimeTypes: ['application/x-subrip', 'text/vtt', 'application/json', 'text/plain']
        }]
      })
      if (selection.outcome === 'cancelled') return
      const file = selection.files[0]!
      try {
        const text = await client.media.readText({ handleId: file.handleId, maxBytes: 512 * 1024 })
        const format = transcriptFormat(
          text.displayName,
          text.mimeType,
          copy('unsupportedTranscriptFormat')
        )
        const content = await execute('transcript.import', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          assetId,
          transcriptId: `transcript-${Date.now().toString(36)}`,
          mode: 'import',
          format,
          source: text.content
        })
        const values = { count: transcriptSegmentCount(content) }
        pushNotice({
          id: 'transcript-imported',
          severity: 'info',
          message: formatMessage(copy('transcriptImported'), values),
          messageKey: 'transcriptImported',
          messageValues: values
        })
        await loadProject(project.id)
        await loadProjects()
      } finally {
        await client.media.release({ resource: 'handle', handleId: file.handleId }).catch(() => undefined)
      }
    })
  }, [client, copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const checkLocalTranscriber = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = stateRef.current.selectedAssetId
      if (!assetId) throw new Error(copy('selectAssetForTranscript'))
      const content = await execute('transcript.import', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId,
        transcriptId: `transcript-check-${Date.now().toString(36)}`,
        mode: 'local-asr'
      })
      pushNotice({
        id: 'local-transcriber-status',
        severity: content.outcome === 'unavailable' ? 'warning' : 'info',
        message: content.outcome === 'unavailable'
          ? copy('localTranscriberUnavailable')
          : copy('localTranscriberAvailable'),
        messageKey: content.outcome === 'unavailable'
          ? 'localTranscriberUnavailable'
          : 'localTranscriberAvailable'
      })
    })
  }, [copy, execute, pushNotice, withBusy])

  const generateCaptions = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const selectedAssetId = stateRef.current.selectedAssetId
      const transcripts = selectedAssetId
        ? project.transcripts.filter(({ assetId }) => assetId === selectedAssetId)
        : project.transcripts
      const captionTrack = project.tracks.find(({ kind }) => kind === 'caption')
      if (!captionTrack || transcripts.length === 0) throw new Error(copy('transcriptRequiredForCaptions'))
      const prefix = `caption-auto-${Date.now().toString(36)}`
      const operations: TimelineOperation[] = []
      for (const transcript of transcripts) {
        const items = project.items.filter(({ assetId }) => assetId === transcript.assetId)
        for (const segment of transcript.segments) {
          for (const item of items) {
            const startUs = Math.max(segment.startUs, item.sourceStartUs)
            const endUs = Math.min(segment.endUs, item.sourceEndUs)
            if (endUs <= startUs) continue
            const startFrame = sourceUsToProjectFrame(project, item, startUs)
            const endFrame = Math.max(startFrame + 1, sourceUsToProjectFrame(project, item, endUs))
            operations.push({
              type: 'add-caption',
              caption: {
                id: `${prefix}-${operations.length}`.slice(0, 128),
                trackId: captionTrack.id,
                startFrame,
                endFrame,
                text: segment.text,
                placement: 'bottom'
              }
            })
          }
        }
      }
      if (operations.length === 0) throw new Error(copy('transcriptRequiredForCaptions'))
      let revision = project.currentRevision
      for (let offset = 0; offset < operations.length; offset += 200) {
        const chunk = operations.slice(offset, offset + 200)
        const content = await execute('project.update', {
          projectId: project.id,
          expectedRevision: revision,
          operations: chunk as unknown as JsonValue,
          summary: formatMessage(copy('generatedCaptionsSummary'), { count: chunk.length })
        })
        revision = safeInteger(content.currentRevision) ?? revision + 1
      }
      const values = { count: operations.length }
      pushNotice({
        id: 'captions-generated',
        severity: 'info',
        message: formatMessage(copy('generatedCaptions'), values),
        messageKey: 'generatedCaptions',
        messageValues: values
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const openMediaHandle = useCallback(async (handleId: string): Promise<void> => {
    const existing = stateRef.current.leases[handleId]
    if (existing && Date.parse(existing.expiresAt) - Date.now() > 30_000) {
      dispatch({ type: 'active-media', handleId, url: existing.url })
      return
    }
    try {
      const previous = stateRef.current.activeMediaHandleId
      if (previous && previous !== handleId) {
        const lease = stateRef.current.leases[previous]
        if (lease) {
          ownedLeaseIds.current.delete(lease.leaseId)
          await client.media.release({ resource: 'lease', leaseId: lease.leaseId }).catch(() => undefined)
        }
      }
      const lease = await client.media.openViewResource({ handleId })
      ownedLeaseIds.current.add(lease.leaseId)
      dispatch({ type: 'lease', value: lease })
      dispatch({ type: 'active-media', handleId, url: lease.url })
    } catch (error) {
      if (isRevokedMediaError(error)) dispatch({ type: 'media-revoked', handleId })
      throw error
    }
  }, [client])
  openMediaHandleRef.current = openMediaHandle

  const openAsset = useCallback(async (assetId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const asset = project.assets.find(({ id }) => id === assetId)
    if (!asset?.mediaHandleId) {
      pushNotice({
        id: 'asset-unavailable',
        severity: 'warning',
        message: copy('assetUnavailable'),
        messageKey: 'assetUnavailable'
      })
      return
    }
    dispatch({ type: 'selection', assetId })
    await withBusy(() => openMediaHandle(asset.mediaHandleId!))
  }, [copy, openMediaHandle, pushNotice, withBusy])

  const refreshActiveLease = useCallback(async (): Promise<void> => {
    const handleId = stateRef.current.activeMediaHandleId
    if (!handleId) return
    const lease = stateRef.current.leases[handleId]
    if (lease) {
      ownedLeaseIds.current.delete(lease.leaseId)
      await client.media.release({ resource: 'lease', leaseId: lease.leaseId }).catch(() => undefined)
    }
    dispatch({ type: 'lease-release', handleId })
    await withBusy(() => openMediaHandle(handleId))
  }, [client, openMediaHandle, withBusy])

  const recoverMedia = useCallback(async (requestedAssetId?: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = requestedAssetId ?? stateRef.current.selectedAssetId
      const asset = project.assets.find(({ id }) => id === assetId)
      if (!asset) throw new Error(copy('assetUnavailable'))
      const selection = await client.media.pickFiles({
        multiple: false,
        maxFiles: 1,
        filters: [{
          name: copy('chooseReplacementMedia'),
          extensions: asset.kind === 'video'
            ? ['mp4', 'mov', 'mkv', 'webm']
            : ['m4a', 'mp3', 'wav'],
          mimeTypes: [`${asset.kind}/*`]
        }]
      })
      if (selection.outcome === 'cancelled') return
      const replacement = selection.files[0]!
      dispatch({ type: 'media', value: [replacement] })
      try {
        await releaseAllLeases()
        await execute('media.reauthorize', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          assetId: asset.id,
          mediaHandleId: replacement.handleId
        })
      } catch (error) {
        await client.media.release({
          resource: 'handle',
          handleId: replacement.handleId
        }).catch(() => undefined)
        throw error
      }
      const values = { name: asset.name }
      pushNotice({
        id: `asset-reauthorized-${asset.id}`,
        severity: 'info',
        message: formatMessage(copy('mediaReauthorized'), values),
        messageKey: 'mediaReauthorized',
        messageValues: values
      })
      await loadProject(project.id)
    })
  }, [client, copy, execute, loadProject, pushNotice, releaseAllLeases, withBusy])

  const applyOperations = useCallback(async (operations: TimelineOperation[], summary: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('project.update', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        operations: operations as unknown as JsonValue,
        summary: summary.slice(0, 512)
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const history = useCallback(async (action: 'project.undo' | 'project.redo'): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute(action, { projectId: project.id, expectedRevision: project.currentRevision })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const undo = useCallback(() => history('project.undo'), [history])
  const redo = useCallback(() => history('project.redo'), [history])

  const readScript = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('script.read', { projectId: project.id, expectedRevision: project.currentRevision })
      const markdown = typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : ''
      const digest = typeof content.digest === 'string' ? content.digest : ''
      dispatch({ type: 'script', revision: safeInteger(content.currentRevision) ?? project.currentRevision, digest, markdown })
    })
  }, [copy, execute, withBusy])

  const editScript = useCallback((markdown: string) => dispatch({ type: 'script-edit', markdown }), [])

  const applyScript = useCallback(async (
    ranges: Array<{ assetId: string; startUs: number; endUs: number; reason?: 'filler' | 'silence' | 'selection' }>
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      let script = stateRef.current.script
      if (!script) {
        const content = await execute('script.read', {
          projectId: project.id,
          expectedRevision: project.currentRevision
        })
        script = {
          revision: safeInteger(content.currentRevision) ?? project.currentRevision,
          digest: typeof content.digest === 'string' ? content.digest : '',
          markdown: typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : '',
          dirty: false
        }
        dispatch({
          type: 'script',
          revision: script.revision,
          digest: script.digest,
          markdown: script.markdown
        })
      }
      if (ranges.length === 0 || ranges.length > 2_000) throw new Error(copy('rangesRequired'))
      await execute('script.apply', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        timelineMarkdown: script.markdown,
        ranges: ranges as unknown as JsonValue,
        summary: copy('scriptApplySummary')
      })
      const updated = await loadProject(project.id)
      const content = await execute('script.read', {
        projectId: updated.id,
        expectedRevision: updated.currentRevision
      })
      dispatch({
        type: 'script',
        revision: safeInteger(content.currentRevision) ?? updated.currentRevision,
        digest: typeof content.digest === 'string' ? content.digest : '',
        markdown: typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : ''
      })
    })
  }, [copy, execute, loadProject, withBusy])

  const startAgent = useCallback(async (prompt: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const input = prompt.trim()
      if (!input) throw new Error(copy('agentGoalRequired'))
      const created = await client.agent.createRun({
        input,
        profileId: 'video-editor',
        visibility: 'private',
        metadata: { projectId: project.id, expectedRevision: project.currentRevision },
        budget: { maxTokens: 32_768, maxElapsedMs: 1_800_000, maxModelRequests: 48, maxToolInvocations: 96, maxEvents: 4_000 }
      })
      dispatch({ type: 'agent-run', value: created.run })
    })
  }, [client, copy, withBusy])

  const steerAgent = useCallback(async (prompt: string): Promise<void> => {
    await withBusy(async () => {
      const run = stateRef.current.agentRun
      if (!run) throw new Error(copy('noAgentRun'))
      const input = prompt.trim()
      if (!input) throw new Error(copy('guidanceEmpty'))
      const result = await client.agent.steer({ runId: run.id, input })
      dispatch({ type: 'agent-run', value: result.run })
    })
  }, [client, copy, withBusy])

  const cancelAgent = useCallback(async (): Promise<void> => {
    const run = stateRef.current.agentRun
    if (!run) return
    await withBusy(async () => {
      const result = await client.agent.cancel({ runId: run.id, reason: copy('agentCanceledByUser') })
      dispatch({ type: 'agent-run', value: result.run })
    })
  }, [client, copy, withBusy])

  const startRender = useCallback(async (
    kind: RenderTicket['renderKind'],
    captionMode: 'none' | 'burned' | 'sidecar' | 'both',
    subtitleFormat: 'srt' | 'vtt' = 'srt'
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      assertRenderCapabilities(stateRef.current, kind, captionMode, copy)
      const extension = kind === 'proof-frame'
        ? 'png'
        : kind === 'audio-aac'
          ? 'm4a'
          : kind === 'subtitles'
            ? subtitleFormat
            : 'mp4'
      const mimeType = kind === 'proof-frame'
        ? 'image/png'
        : kind === 'audio-aac'
          ? 'audio/mp4'
          : kind === 'subtitles'
            ? subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
            : 'video/mp4'
      const picked = await client.media.pickSaveTarget({
        suggestedName: `${project.id}-revision-${project.currentRevision}.${extension}`,
        filters: [{ name: copy('chooseRenderedMedia'), extensions: [extension], mimeTypes: [mimeType] }]
      })
      if (picked.outcome === 'cancelled') return
      const selectedTargets = [picked.target]
      const releaseSelectedTargets = async (): Promise<void> => {
        await Promise.all(selectedTargets.map(({ handleId }) =>
          client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
      }
      let subtitleTarget: typeof picked.target | undefined
      if (captionMode === 'sidecar' || captionMode === 'both') {
        let subtitle
        try {
          subtitle = await client.media.pickSaveTarget({
            suggestedName: `${project.id}-revision-${project.currentRevision}.${subtitleFormat}`,
            filters: [{
              name: subtitleFormat === 'srt' ? copy('chooseSubRipCaptions') : copy('chooseWebVttCaptions'),
              extensions: [subtitleFormat],
              mimeTypes: [subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt']
            }]
          })
        } catch (error) {
          await releaseSelectedTargets()
          throw error
        }
        if (subtitle.outcome === 'cancelled') {
          await releaseSelectedTargets()
          return
        }
        subtitleTarget = subtitle.target
        selectedTargets.push(subtitle.target)
      }
      let content: Record<string, unknown>
      try {
        content = await execute('render.start', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          kind,
          outputHandleId: picked.target.handleId,
          ...(kind === 'proof-frame' ? { proofFrame: stateRef.current.playheadFrame } : {}),
          captionMode,
          ...(kind === 'subtitles' ? { subtitleFormat } : {}),
          ...(subtitleTarget ? {
            subtitleOutputHandleId: subtitleTarget.handleId,
            subtitleFormat
          } : {}),
          idempotencyKey: `${project.id}-${project.currentRevision}-${kind}-${Date.now().toString(36)}`
        })
      } catch (error) {
        // An opaque transport failure may have happened after the durable job
        // accepted these handles. Keep them alive so recovery/status can work.
        if (!isOpaqueHostError(error)) await releaseSelectedTargets()
        throw error
      }
      if (content.outcome === 'unavailable') {
        await releaseSelectedTargets()
        const messageKey = renderCapabilityMessageKey(content.code)
        pushNotice({
          id: 'render-capability-unavailable',
          severity: 'warning',
          message: copy(messageKey),
          messageKey
        })
        return
      }
      if (content.outcome === 'cancelled') {
        await releaseSelectedTargets()
        return
      }
      if (content.outcome !== 'queued' || typeof content.jobId !== 'string') {
        await releaseSelectedTargets()
        throw new Error(copy('renderJobMissing'))
      }
      dispatch({ type: 'media', value: selectedTargets })
      const ticket: RenderTicket = {
        jobId: content.jobId,
        projectId: project.id,
        pinnedRevision: safeInteger(content.pinnedRevision) ?? project.currentRevision,
        renderKind: isRenderKind(content.renderKind) ? content.renderKind : kind,
        createdAt: new Date().toISOString()
      }
      dispatch({ type: 'render-ticket', value: ticket })
      const snapshot = await client.jobs.get(ticket.jobId)
      dispatch({ type: 'jobs', value: [...stateRef.current.jobs, snapshot] })
    })
  }, [client, copy, execute, pushNotice, withBusy])

  const cancelJob = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('render.cancel', {
        jobId,
        projectId: project.id,
        reason: copy('renderCanceledByUser')
      })
      const snapshot = await client.jobs.get(jobId)
      dispatch({
        type: 'jobs',
        value: stateRef.current.jobs.map((job) => job.id === jobId ? snapshot : job)
      })
    })
  }, [client, copy, execute, withBusy])

  const openArtifact = useCallback(async (artifact: GeneratedArtifact): Promise<void> => {
    if (artifact.availability !== 'available') {
      pushNotice({
        id: `artifact-${artifact.artifactId}`,
        severity: 'warning',
        message: copy('artifactUnavailable'),
        messageKey: 'artifactUnavailable'
      })
      return
    }
    if (artifactUsesPlayer(artifact)) {
      await withBusy(() => openMediaHandle(artifact.mediaHandleId))
      return
    }
    await withBusy(async () => {
      await client.media.performArtifactAction({ artifactId: artifact.artifactId, action: 'open' })
    })
  }, [client, copy, openMediaHandle, pushNotice, withBusy])

  const revealArtifact = useCallback(async (artifact: GeneratedArtifact): Promise<void> => {
    if (artifact.availability !== 'available') {
      pushNotice({
        id: `artifact-${artifact.artifactId}`,
        severity: 'warning',
        message: copy('artifactUnavailable'),
        messageKey: 'artifactUnavailable'
      })
      return
    }
    await withBusy(async () => {
      await client.media.performArtifactAction({ artifactId: artifact.artifactId, action: 'reveal' })
    })
  }, [client, copy, pushNotice, withBusy])

  return {
    state,
    refreshAll,
    createProject,
    openProject,
    importMedia,
    importTranscript,
    checkLocalTranscriber,
    generateCaptions,
    openAsset,
    refreshActiveLease,
    recoverMedia,
    applyOperations,
    undo,
    redo,
    readScript,
    editScript,
    applyScript,
    seek: (frame) => dispatch({ type: 'seek', frame }),
    togglePlaying: () => dispatch({ type: 'playing', value: !stateRef.current.playing }),
    selectItem: (itemId) => dispatch({ type: 'selection', itemId, captionId: undefined }),
    selectCaption: (captionId) => dispatch({ type: 'selection', captionId, itemId: undefined }),
    setTranscriptWindow: (start) => dispatch({ type: 'transcript-window', start }),
    setTimelineWindow: (start) => dispatch({ type: 'timeline-window', start }),
    startAgent,
    steerAgent,
    cancelAgent,
    startRender,
    cancelJob,
    openArtifact,
    revealArtifact,
    dismissNotice: (id) => dispatch({ type: 'dismiss-notice', id })
  }
}

export function artifactUsesPlayer(artifact: GeneratedArtifact): boolean {
  if (artifact.mimeType === 'application/x-subrip' || artifact.mimeType === 'text/vtt') return false
  return artifact.mediaKind === 'video' || artifact.mediaKind === 'audio' || artifact.mediaKind === 'image'
}

export function classifyError(
  error: unknown,
  fallback: string,
  interactionGuidance = 'Complete the protected desktop interaction and retry.',
  preferFallback = false,
  fallbackKey?: MessageKey,
  fallbackValues?: Readonly<Record<string, string | number>>
): Omit<EditorNotice, 'id'> {
  const api = error instanceof ExtensionApiError ? error : undefined
  const code = api?.code ?? (isRecord(error) && typeof error.code === 'string' ? error.code : '')
  const rawMessage = error instanceof Error && error.message ? error.message.slice(0, 1_000) : ''
  const usesFallback = preferFallback || !rawMessage
  const message = usesFallback ? fallback : rawMessage
  const interactionRequired = /INTERACTION_REQUIRED|interaction.required/iu.test(code) || /interaction required/iu.test(rawMessage)
  return {
    severity: interactionRequired ? 'warning' : 'error',
    message: interactionRequired ? `${message} ${interactionGuidance}` : message,
    ...(usesFallback && fallbackKey ? {
      messageKey: fallbackKey,
      ...(fallbackValues ? { messageValues: fallbackValues } : {})
    } : {}),
    interactionRequired,
    retryable: api?.retryable ?? true
  }
}

function projectFrom(content: Record<string, unknown>, invalidMessage: string): ProjectProjection {
  const value = isRecord(content.project) ? content.project : content
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.fps) ||
    !isRecord(value.canvas) ||
    !Number.isSafeInteger(value.currentRevision)
  ) throw new Error(invalidMessage)
  return value as unknown as ProjectProjection
}

function persistedState(value: JsonValue | undefined): PersistedEditorState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  return {
    schemaVersion: 1,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.selectedItemId === 'string' ? { selectedItemId: value.selectedItemId } : {}),
    playheadFrame: safeInteger(value.playheadFrame) ?? 0,
    ...(typeof value.activeRunId === 'string' ? { activeRunId: value.activeRunId } : {}),
    renderTickets: Array.isArray(value.renderTickets)
      ? value.renderTickets.filter(isRenderTicket).slice(-VIEW_LIMITS.jobs)
      : [],
    transcriptWindowStart: safeInteger(value.transcriptWindowStart) ?? 0
  }
}

function projectChange(value: JsonValue, fallbackReason: string): ProjectChange | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.projectId !== 'string') return undefined
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    revision: safeInteger(value.revision) ?? 0,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : fallbackReason,
    changedIds: Array.isArray(value.changedIds)
      ? value.changedIds.filter((item): item is string => typeof item === 'string').slice(0, 2_000)
      : []
  }
}

function requiredProject(state: EditorState, missingMessage: string): ProjectProjection {
  if (!state.project) throw new Error(missingMessage)
  return state.project
}

function asRecord(value: unknown, invalidMessage: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(invalidMessage)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    Number.isSafeInteger(value.currentRevision) && typeof value.updatedAt === 'string' &&
    Number.isSafeInteger(value.durationFrames)
}

function isRenderKind(value: unknown): value is RenderTicket['renderKind'] {
  return ['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'].includes(String(value))
}

function isRenderTicket(value: unknown): value is RenderTicket {
  return isRecord(value) && typeof value.jobId === 'string' && typeof value.projectId === 'string' &&
    Number.isSafeInteger(value.pinnedRevision) && isRenderKind(value.renderKind) && typeof value.createdAt === 'string'
}

function isRevisionConflict(error: unknown): boolean {
  const code = error instanceof ExtensionApiError ? error.code : isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ''
  const engineCode = error instanceof ExtensionApiError ? error.details?.engineCode : undefined
  return (
    code === 'CONFLICT' && (engineCode === 'revision_conflict' || engineCode === 'script_stale')
  ) || /REVISION_CONFLICT|revision.conflict/iu.test(String(code)) || /revision (?:conflict|has changed)/iu.test(message)
}

function revisionFromError(error: unknown): number | undefined {
  if (!(error instanceof ExtensionApiError) || !error.details) return undefined
  return safeInteger(error.details.currentRevision)
}

function isRevokedMediaError(error: unknown): boolean {
  const code = error instanceof ExtensionApiError ? error.code : isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ''
  return /MEDIA_(?:HANDLE_)?REVOKED|MEDIA_NOT_FOUND/iu.test(String(code)) || /media (?:handle )?(?:was )?(?:revoked|replaced|not found)/iu.test(message)
}

function isOpaqueHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /error invoking remote method|extension operation failed/iu.test(message)
}

function agentEventChangesProject(event: AgentRunEvent): boolean {
  if (event.type !== 'message' && event.type !== 'progress') return false
  return JSON.stringify(event).includes('currentRevision') || JSON.stringify(event).includes('project-changed')
}

function transcriptFormat(
  displayName: string,
  mimeType: string,
  unsupportedMessage: string
): 'srt' | 'vtt' | 'json' {
  const normalized = displayName.toLowerCase()
  if (normalized.endsWith('.srt') || mimeType === 'application/x-subrip') return 'srt'
  if (normalized.endsWith('.vtt') || mimeType === 'text/vtt') return 'vtt'
  if (normalized.endsWith('.json') || mimeType === 'application/json') return 'json'
  throw new Error(unsupportedMessage)
}

function transcriptSegmentCount(content: Record<string, unknown>): number {
  const details = isRecord(content.details) ? content.details : undefined
  return details && Number.isSafeInteger(details.segmentCount)
    ? Number(details.segmentCount)
    : Array.isArray(details?.segments)
      ? details.segments.length
      : 0
}

function sourceUsToProjectFrame(
  project: ProjectProjection,
  item: ProjectProjection['items'][number],
  sourceUs: number
): number {
  const sourceDeltaUs = Math.max(0, sourceUs - item.sourceStartUs)
  const frameDelta = sourceDeltaUs * project.fps.numerator * item.speed.denominator /
    (1_000_000 * project.fps.denominator * item.speed.numerator)
  return item.timelineStartFrame + Math.round(frameDelta)
}

function assertRenderCapabilities(
  state: EditorState,
  kind: RenderTicket['renderKind'],
  captionMode: 'none' | 'burned' | 'sidecar' | 'both',
  copy: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
): void {
  const capabilities = state.mediaCapabilities
  if ((kind === 'subtitles' || captionMode !== 'none') && !state.project?.captions.length) {
    throw new Error(copy('captionsRequiredForExport'))
  }
  if (!capabilities?.ffprobe.available) throw new Error(copy('ffprobeUnavailable'))
  if (kind !== 'subtitles' && !capabilities.ffmpeg.available) throw new Error(copy('ffmpegUnavailable'))
  const features = new Set(capabilities.ffmpeg.features)
  if ((kind === 'preview' || kind === 'h264-mp4') && !features.has('libx264-encoder')) {
    throw new Error(copy('h264EncoderUnavailable'))
  }
  if ((kind === 'audio-aac' || kind === 'h264-mp4') && !features.has('aac-encoder')) {
    throw new Error(copy('aacEncoderUnavailable'))
  }
  if ((captionMode === 'burned' || captionMode === 'both') && !features.has('drawtext-filter')) {
    throw new Error(copy('burnedCaptionsUnavailable'))
  }
}

function renderCapabilityMessageKey(code: unknown): MessageKey {
  switch (code) {
    case 'FFPROBE_UNAVAILABLE': return 'ffprobeUnavailable'
    case 'FFMPEG_UNAVAILABLE': return 'ffmpegUnavailable'
    case 'LIBX264_ENCODER_UNAVAILABLE': return 'h264EncoderUnavailable'
    case 'AAC_ENCODER_UNAVAILABLE': return 'aacEncoderUnavailable'
    case 'DRAWTEXT_FILTER_UNAVAILABLE': return 'burnedCaptionsUnavailable'
    default: return 'mediaCapabilitiesUnavailable'
  }
}

export function artifactsForJobs(jobs: readonly JobSnapshot[]): GeneratedArtifact[] {
  const byId = new Map<string, GeneratedArtifact>()
  for (const job of jobs) for (const artifact of generatedArtifacts(job)) byId.set(artifact.artifactId, artifact)
  return [...byId.values()].slice(-64)
}
