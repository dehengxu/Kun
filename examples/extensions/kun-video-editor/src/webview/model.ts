import type {
  AgentRun,
  AgentRunEvent,
  GeneratedArtifact,
  JobEvent,
  JobSnapshot,
  Locale,
  MediaCapabilities,
  MediaMetadata,
  MediaResourceLease,
  ResultPreviewOpenPayload,
  Theme
} from '@kun/extension-api'
import type { MessageKey } from './i18n.js'

export const VIEW_LIMITS = Object.freeze({
  projects: 100,
  assets: 100,
  tracks: 64,
  items: 500,
  captions: 500,
  transcripts: 100,
  transcriptSegments: 500,
  revisions: 50,
  jobs: 40,
  agentEvents: 256,
  notices: 8,
  mediaLeases: 16,
  virtualWindow: 80
})

export type Rational = { numerator: number; denominator: number }
export type CanvasPreset = '16:9' | '9:16' | '1:1'
export type CanvasFit = 'fit' | 'crop' | 'pad'

export type ProjectSummary = {
  id: string
  name: string
  currentRevision: number
  updatedAt: string
  durationFrames: number
}

export type AssetProjection = {
  id: string
  name: string
  kind: 'video' | 'audio'
  mediaHandleId?: string
  durationUs: number
  container: string
  video?: { codec: string; width: number; height: number; frameRate: Rational; rotation?: number }
  audio?: { codec: string; sampleRate: number; channels: number }
  transcriptIds: string[]
}

export type TrackProjection = {
  id: string
  name: string
  kind: 'video' | 'audio' | 'caption'
  order: number
  overlap: 'reject' | 'mix'
  muted?: boolean
  locked?: boolean
}

export type ItemProjection = {
  id: string
  assetId: string
  trackId: string
  timelineStartFrame: number
  durationFrames: number
  sourceStartUs: number
  sourceEndUs: number
  speed: Rational
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }
  opacity: number
  fadeInFrames: number
  fadeOutFrames: number
}

export type CaptionProjection = {
  id: string
  trackId: string
  startFrame: number
  endFrame: number
  text: string
  placement: 'top' | 'center' | 'bottom'
  style?: { fontSize?: number; color?: string; background?: string }
}

export type TranscriptSegmentProjection = {
  id: string
  startUs: number
  endUs: number
  text: string
  tags?: Array<'filler' | 'silence'>
}

export type TranscriptProjection = {
  id: string
  assetId: string
  language: string
  provenance: 'srt' | 'vtt' | 'json' | 'local-asr'
  segmentCount: number
  segments: TranscriptSegmentProjection[]
  truncated: boolean
}

export type RevisionProjection = {
  revision: number
  parentRevision: number | null
  author: 'manual' | 'agent' | 'system'
  sourceOperation: string
  timestamp: string
  summary: string
  restoredFromRevision?: number | null
}

export type ProjectProjection = {
  schemaVersion: 1
  id: string
  name: string
  fps: Rational
  canvas: {
    preset: CanvasPreset
    width: number
    height: number
    fit: CanvasFit
    background: string
  }
  currentRevision: number
  updatedAt: string
  durationFrames: number
  assets: AssetProjection[]
  tracks: TrackProjection[]
  items: ItemProjection[]
  captions: CaptionProjection[]
  transcripts: TranscriptProjection[]
  revisions: RevisionProjection[]
  canUndo?: boolean
  canRedo?: boolean
  truncated?: boolean
}

export type TimelineOperation =
  | { type: 'split-item'; itemId: string; atFrame: number }
  | { type: 'trim-item'; itemId: string; startFrame: number; endFrame: number }
  | { type: 'delete-item'; itemId: string }
  | { type: 'move-item'; itemId: string; trackId: string; timelineStartFrame: number }
  | { type: 'reorder-item'; itemId: string; beforeItemId?: string }
  | { type: 'update-transform'; itemId: string; transform: Partial<ItemProjection['transform']>; opacity?: number }
  | { type: 'add-caption'; caption: CaptionProjection }
  | { type: 'update-caption'; captionId: string; patch: Partial<Omit<CaptionProjection, 'id'>> }
  | { type: 'delete-caption'; captionId: string }
  | { type: 'set-canvas'; preset: CanvasPreset; fit: CanvasFit }

export type ProjectChange = {
  schemaVersion: 1
  projectId: string
  revision: number
  reason: string
  changedIds: string[]
}

export type RenderTicket = {
  jobId: string
  projectId: string
  pinnedRevision: number
  renderKind: 'proof-frame' | 'preview' | 'h264-mp4' | 'audio-aac' | 'subtitles'
  createdAt: string
}

export type EditorNotice = {
  id: string
  severity: 'info' | 'warning' | 'error'
  message: string
  messageKey?: MessageKey
  messageValues?: Readonly<Record<string, string | number>>
  interactionRequired?: boolean
  retryable?: boolean
}

export type PersistedEditorState = {
  schemaVersion: 1
  projectId?: string
  selectedItemId?: string
  playheadFrame: number
  activeRunId?: string
  renderTickets: RenderTicket[]
  transcriptWindowStart: number
}

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline'

export type EditorState = {
  initialized: boolean
  busy: boolean
  connection: ConnectionState
  reconnectToken: number
  theme?: Theme
  locale?: Locale
  mediaCapabilities?: MediaCapabilities
  resultPreview?: ResultPreviewOpenPayload
  projects: ProjectSummary[]
  project?: ProjectProjection
  selectedItemId?: string
  selectedCaptionId?: string
  selectedAssetId?: string
  playheadFrame: number
  playing: boolean
  media: Record<string, MediaMetadata>
  leases: Record<string, MediaResourceLease>
  activeMediaHandleId?: string
  activeMediaUrl?: string
  revokedHandles: string[]
  script?: { revision: number; digest: string; markdown: string; dirty: boolean }
  agentRun?: AgentRun
  agentEvents: AgentRunEvent[]
  jobs: JobSnapshot[]
  jobEvents: Record<string, JobEvent[]>
  renderTickets: RenderTicket[]
  notices: EditorNotice[]
  lastProjectChange?: ProjectChange
  conflict?: { expectedRevision: number; currentRevision?: number }
  transcriptWindowStart: number
  timelineWindowStart: number
}

export const INITIAL_EDITOR_STATE: EditorState = {
  initialized: false,
  busy: false,
  connection: 'connecting',
  reconnectToken: 0,
  projects: [],
  playheadFrame: 0,
  playing: false,
  media: {},
  leases: {},
  revokedHandles: [],
  agentEvents: [],
  jobs: [],
  jobEvents: {},
  renderTickets: [],
  notices: [],
  transcriptWindowStart: 0,
  timelineWindowStart: 0
}

export type EditorAction =
  | { type: 'initialized'; persisted?: PersistedEditorState }
  | { type: 'busy'; value: boolean }
  | { type: 'connection'; value: ConnectionState }
  | { type: 'reconnect' }
  | { type: 'theme'; value: Theme }
  | { type: 'locale'; value: Locale }
  | { type: 'media-capabilities'; value: MediaCapabilities }
  | { type: 'result-preview'; value: ResultPreviewOpenPayload }
  | { type: 'projects'; value: ProjectSummary[] }
  | { type: 'project'; value: ProjectProjection }
  | { type: 'clear-project' }
  | { type: 'selection'; itemId?: string; captionId?: string; assetId?: string }
  | { type: 'seek'; frame: number }
  | { type: 'playing'; value: boolean }
  | { type: 'media'; value: MediaMetadata[] }
  | { type: 'lease'; value: MediaResourceLease }
  | { type: 'lease-release'; handleId: string }
  | { type: 'active-media'; handleId?: string; url?: string }
  | { type: 'media-revoked'; handleId: string }
  | { type: 'script'; revision: number; digest: string; markdown: string }
  | { type: 'script-edit'; markdown: string }
  | { type: 'agent-run'; value?: AgentRun }
  | { type: 'agent-event'; value: AgentRunEvent }
  | { type: 'jobs'; value: JobSnapshot[] }
  | { type: 'job-event'; value: JobEvent }
  | { type: 'render-ticket'; value: RenderTicket }
  | { type: 'notice'; value: EditorNotice }
  | { type: 'project-change'; value: ProjectChange }
  | { type: 'dismiss-notice'; id: string }
  | { type: 'conflict'; expectedRevision: number; currentRevision?: number }
  | { type: 'clear-conflict' }
  | { type: 'transcript-window'; start: number }
  | { type: 'timeline-window'; start: number }

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'initialized': {
      const restored = action.persisted
      return {
        ...state,
        initialized: true,
        connection: 'online',
        ...(restored?.selectedItemId ? { selectedItemId: restored.selectedItemId } : {}),
        playheadFrame: restored?.playheadFrame ?? state.playheadFrame,
        renderTickets: restored?.renderTickets.slice(-VIEW_LIMITS.jobs) ?? state.renderTickets,
        transcriptWindowStart: restored?.transcriptWindowStart ?? state.transcriptWindowStart
      }
    }
    case 'busy': return { ...state, busy: action.value }
    case 'connection': return { ...state, connection: action.value }
    case 'reconnect': return { ...state, connection: 'reconnecting', reconnectToken: state.reconnectToken + 1 }
    case 'theme': return { ...state, theme: action.value }
    case 'locale': return { ...state, locale: action.value }
    case 'media-capabilities': return { ...state, mediaCapabilities: action.value }
    case 'result-preview': return { ...state, resultPreview: action.value }
    case 'projects': return { ...state, projects: dedupeById(action.value).slice(0, VIEW_LIMITS.projects) }
    case 'project': {
      const project = boundProject(action.value)
      const switchingProject = state.project !== undefined && state.project.id !== project.id
      const selectedItemId = !switchingProject && state.selectedItemId && project.items.some(({ id }) => id === state.selectedItemId)
        ? state.selectedItemId
        : undefined
      const projectTicketIds = new Set(
        state.renderTickets.filter(({ projectId }) => projectId === project.id).map(({ jobId }) => jobId)
      )
      return {
        ...state,
        project,
        selectedItemId,
        selectedCaptionId: !switchingProject && state.selectedCaptionId && project.captions.some(({ id }) => id === state.selectedCaptionId)
          ? state.selectedCaptionId
          : undefined,
        selectedAssetId: !switchingProject && state.selectedAssetId && project.assets.some(({ id }) => id === state.selectedAssetId)
          ? state.selectedAssetId
          : project.assets[0]?.id,
        playheadFrame: switchingProject
          ? 0
          : Math.min(state.playheadFrame, Math.max(0, project.durationFrames)),
        ...(switchingProject ? {
          playing: false,
          media: {},
          leases: {},
          activeMediaHandleId: undefined,
          activeMediaUrl: undefined,
          revokedHandles: [],
          script: undefined,
          agentRun: undefined,
          agentEvents: [],
          jobs: state.jobs.filter(({ id }) => projectTicketIds.has(id)),
          jobEvents: Object.fromEntries(
            Object.entries(state.jobEvents).filter(([jobId]) => projectTicketIds.has(jobId))
          ),
          timelineWindowStart: 0,
          transcriptWindowStart: 0
        } : {}),
        conflict: undefined
      }
    }
    case 'clear-project': return {
      ...state,
      project: undefined,
      selectedItemId: undefined,
      selectedCaptionId: undefined,
      selectedAssetId: undefined,
      playing: false,
      media: {},
      leases: {},
      activeMediaHandleId: undefined,
      activeMediaUrl: undefined,
      revokedHandles: [],
      script: undefined,
      playheadFrame: 0,
      agentRun: undefined,
      agentEvents: [],
      jobs: [],
      jobEvents: {},
      timelineWindowStart: 0,
      transcriptWindowStart: 0,
      conflict: undefined
    }
    case 'selection': return {
      ...state,
      ...(Object.prototype.hasOwnProperty.call(action, 'itemId') ? { selectedItemId: action.itemId } : {}),
      ...(Object.prototype.hasOwnProperty.call(action, 'captionId') ? { selectedCaptionId: action.captionId } : {}),
      ...(Object.prototype.hasOwnProperty.call(action, 'assetId') ? { selectedAssetId: action.assetId } : {})
    }
    case 'seek': return {
      ...state,
      playheadFrame: Math.max(0, Math.min(Math.round(action.frame), state.project?.durationFrames ?? Number.MAX_SAFE_INTEGER))
    }
    case 'playing': return { ...state, playing: action.value }
    case 'media': {
      const media = { ...state.media }
      for (const item of action.value.slice(0, VIEW_LIMITS.assets)) media[item.handleId] = item
      return { ...state, media: boundRecord(media, VIEW_LIMITS.assets) }
    }
    case 'lease': return {
      ...state,
      leases: boundRecord({ ...state.leases, [action.value.handleId]: action.value }, VIEW_LIMITS.mediaLeases),
      revokedHandles: state.revokedHandles.filter((id) => id !== action.value.handleId)
    }
    case 'lease-release': return {
      ...state,
      leases: omitKey(state.leases, action.handleId),
      ...(state.activeMediaHandleId === action.handleId
        ? { activeMediaHandleId: undefined, activeMediaUrl: undefined, playing: false }
        : {})
    }
    case 'active-media': return { ...state, activeMediaHandleId: action.handleId, activeMediaUrl: action.url }
    case 'media-revoked': return {
      ...state,
      revokedHandles: [...new Set([...state.revokedHandles, action.handleId])].slice(-VIEW_LIMITS.assets),
      leases: omitKey(state.leases, action.handleId),
      ...(state.activeMediaHandleId === action.handleId
        ? { activeMediaHandleId: undefined, activeMediaUrl: undefined, playing: false }
        : {})
    }
    case 'script': return {
      ...state,
      script: { revision: action.revision, digest: action.digest, markdown: action.markdown, dirty: false }
    }
    case 'script-edit': return state.script
      ? { ...state, script: { ...state.script, markdown: action.markdown.slice(0, 262_144), dirty: true } }
      : state
    case 'agent-run': return { ...state, agentRun: action.value }
    case 'agent-event': return {
      ...state,
      agentEvents: mergeSequenced(state.agentEvents, action.value, VIEW_LIMITS.agentEvents)
    }
    case 'jobs': return { ...state, jobs: mergeJobSnapshots(state.jobs, action.value) }
    case 'job-event': {
      const jobEvents = {
        ...state.jobEvents,
        [action.value.jobId]: mergeSequenced(
          state.jobEvents[action.value.jobId] ?? [],
          action.value,
          VIEW_LIMITS.agentEvents
        )
      }
      const current = state.jobs.find(({ id }) => id === action.value.jobId)
      const jobs = current
        ? state.jobs.map((job) => job.id === action.value.jobId ? snapshotFromEvent(job, action.value) : job)
        : state.jobs
      return { ...state, jobs: boundJobs(jobs), jobEvents: boundRecord(jobEvents, VIEW_LIMITS.jobs) }
    }
    case 'render-ticket': return {
      ...state,
      renderTickets: dedupeByKey([...state.renderTickets, action.value], 'jobId').slice(-VIEW_LIMITS.jobs)
    }
    case 'notice': return {
      ...state,
      notices: dedupeByKey([...state.notices, action.value], 'id').slice(-VIEW_LIMITS.notices)
    }
    case 'project-change': return { ...state, lastProjectChange: action.value }
    case 'dismiss-notice': return { ...state, notices: state.notices.filter(({ id }) => id !== action.id) }
    case 'conflict': return {
      ...state,
      conflict: { expectedRevision: action.expectedRevision, currentRevision: action.currentRevision }
    }
    case 'clear-conflict': return { ...state, conflict: undefined }
    case 'transcript-window': return { ...state, transcriptWindowStart: Math.max(0, action.start) }
    case 'timeline-window': return { ...state, timelineWindowStart: Math.max(0, action.start) }
  }
}

export function toPersistedState(state: EditorState): PersistedEditorState {
  return {
    schemaVersion: 1,
    ...(state.selectedItemId ? { selectedItemId: state.selectedItemId } : {}),
    playheadFrame: state.playheadFrame,
    ...(state.agentRun ? { activeRunId: state.agentRun.id } : {}),
    renderTickets: state.renderTickets.slice(-VIEW_LIMITS.jobs),
    transcriptWindowStart: state.transcriptWindowStart
  }
}

export function proofIsStale(ticket: RenderTicket, project?: ProjectProjection): boolean {
  return Boolean(project && ticket.projectId === project.id && ticket.pinnedRevision !== project.currentRevision)
}

export function transcriptFrame(
  project: Pick<ProjectProjection, 'fps'>,
  segment: Pick<TranscriptSegmentProjection, 'startUs'>
): number {
  return Math.max(0, Math.round(
    segment.startUs * project.fps.numerator / project.fps.denominator / 1_000_000
  ))
}

export function frameToSeconds(project: Pick<ProjectProjection, 'fps'>, frame: number): number {
  return frame * project.fps.denominator / project.fps.numerator
}

export function activeTranscriptSegment(
  project: ProjectProjection,
  assetId: string | undefined,
  frame: number
): TranscriptSegmentProjection | undefined {
  if (!assetId) return undefined
  const item = project.items.find((candidate) =>
    candidate.assetId === assetId &&
    candidate.timelineStartFrame <= frame &&
    frame < candidate.timelineStartFrame + candidate.durationFrames
  )
  if (!item) return undefined
  const timelineDeltaFrames = frame - item.timelineStartFrame
  const sourceUs = item.sourceStartUs + Math.round(
    timelineDeltaFrames * 1_000_000 * project.fps.denominator * item.speed.numerator /
    (project.fps.numerator * item.speed.denominator)
  )
  return project.transcripts
    .find((transcript) => transcript.assetId === assetId)
    ?.segments.find((segment) => segment.startUs <= sourceUs && sourceUs < segment.endUs)
}

export type TimelineSource = {
  item: ItemProjection
  asset: AssetProjection
  sourceTimeUs: number
  playbackRate: number
}

export function timelineSourceAtFrame(
  project: ProjectProjection,
  frame: number
): TimelineSource | undefined {
  const trackOrder = new Map(project.tracks.map((track) => [track.id, track.order]))
  const item = project.items
    .filter((candidate) =>
      candidate.timelineStartFrame <= frame &&
      frame < candidate.timelineStartFrame + candidate.durationFrames
    )
    .sort((left, right) =>
      (trackOrder.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
        (trackOrder.get(right.trackId) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    )
    .find((candidate) => project.assets.some(({ id, kind }) => id === candidate.assetId && kind === 'video')) ??
    project.items
      .filter((candidate) =>
        candidate.timelineStartFrame <= frame &&
        frame < candidate.timelineStartFrame + candidate.durationFrames
      )
      .sort((left, right) =>
        (trackOrder.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
          (trackOrder.get(right.trackId) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      )[0]
  if (!item) return undefined
  const asset = project.assets.find(({ id }) => id === item.assetId)
  if (!asset) return undefined
  const timelineDeltaFrames = frame - item.timelineStartFrame
  const sourceTimeUs = Math.min(item.sourceEndUs, Math.max(item.sourceStartUs,
    item.sourceStartUs + Math.round(
      timelineDeltaFrames * 1_000_000 * project.fps.denominator * item.speed.numerator /
      (project.fps.numerator * item.speed.denominator)
    )
  ))
  return {
    item,
    asset,
    sourceTimeUs,
    playbackRate: item.speed.numerator / item.speed.denominator
  }
}

export function projectFrameFromSourceTime(
  project: Pick<ProjectProjection, 'fps'>,
  source: Pick<TimelineSource, 'item'>,
  sourceSeconds: number
): number {
  const sourceDeltaUs = Math.max(0, sourceSeconds * 1_000_000 - source.item.sourceStartUs)
  const timelineFrames = sourceDeltaUs * project.fps.numerator * source.item.speed.denominator /
    (1_000_000 * project.fps.denominator * source.item.speed.numerator)
  return source.item.timelineStartFrame + Math.round(timelineFrames)
}

export function activeCaptionAtFrame(
  project: ProjectProjection,
  frame: number
): CaptionProjection | undefined {
  return project.captions.find(({ startFrame, endFrame }) => startFrame <= frame && frame < endFrame)
}

function boundProject(project: ProjectProjection): ProjectProjection {
  let segments = VIEW_LIMITS.transcriptSegments
  return {
    ...project,
    assets: dedupeById(project.assets).slice(0, VIEW_LIMITS.assets),
    tracks: dedupeById(project.tracks).slice(0, VIEW_LIMITS.tracks),
    items: dedupeById(project.items).slice(0, VIEW_LIMITS.items),
    captions: dedupeById(project.captions).slice(0, VIEW_LIMITS.captions),
    transcripts: dedupeById(project.transcripts).slice(0, VIEW_LIMITS.transcripts).map((transcript) => {
      const allowed = Math.max(0, segments)
      const items = transcript.segments.slice(0, allowed)
      segments -= items.length
      return { ...transcript, segments: items, truncated: transcript.truncated || transcript.segments.length > items.length }
    }),
    revisions: project.revisions.slice(-VIEW_LIMITS.revisions)
  }
}

function boundJobs(jobs: JobSnapshot[]): JobSnapshot[] {
  return dedupeById(jobs)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, VIEW_LIMITS.jobs)
}

function mergeJobSnapshots(current: readonly JobSnapshot[], incoming: JobSnapshot[]): JobSnapshot[] {
  const currentById = new Map(current.map((snapshot) => [snapshot.id, snapshot]))
  return boundJobs(incoming.map((snapshot) => {
    const previous = currentById.get(snapshot.id)
    if (!previous) return snapshot
    const previousTerminal = isTerminalJobState(previous.state)
    const incomingTerminal = isTerminalJobState(snapshot.state)
    if (previousTerminal !== incomingTerminal) return previousTerminal ? previous : snapshot
    return snapshot.updatedAt >= previous.updatedAt ? snapshot : previous
  }))
}

function isTerminalJobState(state: JobSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
}

function snapshotFromEvent(snapshot: JobSnapshot, event: JobEvent): JobSnapshot {
  return {
    ...snapshot,
    state: event.state,
    updatedAt: event.timestamp,
    executionAttempt: event.executionAttempt,
    latestCursor: event.cursor,
    ...(event.progress ? { progress: event.progress } : {}),
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {}),
    ...(['completed', 'failed', 'cancelled', 'interrupted'].includes(event.state)
      ? { terminalAt: event.timestamp }
      : {})
  }
}

function mergeSequenced<T extends { sequence: number }>(current: T[], next: T, limit: number): T[] {
  const bySequence = new Map(current.map((value) => [value.sequence, value]))
  bySequence.set(next.sequence, next)
  return [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit)
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  return dedupeByKey(items, 'id')
}

function dedupeByKey<T, K extends keyof T>(items: readonly T[], key: K): T[] {
  const values = new Map<T[K], T>()
  for (const item of items) values.set(item[key], item)
  return [...values.values()]
}

function boundRecord<T>(record: Record<string, T>, limit: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-limit))
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}

export function generatedArtifacts(snapshot: JobSnapshot): GeneratedArtifact[] {
  return snapshot.result?.generatedArtifacts.slice(0, 64) ?? []
}
