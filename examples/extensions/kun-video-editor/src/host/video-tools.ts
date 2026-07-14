import { createHash } from 'node:crypto'
import type {
  ExtensionContext,
  ExtensionErrorData,
  GeneratedArtifact,
  JsonObject,
  JsonValue,
  JobSnapshot,
  MediaCapabilities,
  MediaMetadata,
  MediaProbeResult,
  ToolInvocationContext,
  ToolResult
} from '@kun/extension-api'
import {
  ProjectService,
  TimelineOperationSchema,
  VideoEngineError,
  applyTimelineOperations,
  applyTimelineScript,
  generateRenderPlan,
  generateTimelineMarkdown,
  importTranscript,
  microsecondsToFrames,
  parseTimelineScriptHeader,
  projectDurationFrames,
  type AssetTimeRange,
  type FfmpegRenderStep,
  type MediaAsset,
  type RenderKind,
  type RevisionAuthor,
  type TextRenderStep,
  type TimelineItem,
  type TimelineOperation,
  type Transcript,
  type VideoProject
} from '../engine/index.js'
import { VIDEO_TOOL_DECLARATIONS } from './tool-contracts.js'

const MAX_PROJECTS = 100
const MAX_ASSETS = 100
const MAX_TRACKS = 64
const MAX_ITEMS = 500
const MAX_CAPTIONS = 500
const MAX_TRANSCRIPTS = 100
const MAX_TRANSCRIPT_SEGMENTS = 500
const MAX_SCRIPT_BYTES = 240 * 1024
const ACTIVE_PROJECT_KEY = 'active-project'
const RENDER_RECORD_PREFIX = 'render-job:'
const RENDER_TRACKING_CANCELLATION_WAIT_MS = 12_000

type RenderRecord = {
  schemaVersion: 1
  jobId: string
  projectId: string
  pinnedRevision: number
  renderKind: RenderKind
  captionMode: 'none' | 'burned' | 'sidecar' | 'both'
  subtitleFormat: 'srt' | 'vtt'
  canvasPreset: VideoProject['canvas']['preset']
  proofFrame?: number
  expectedArtifacts: Array<{
    mediaKind: 'image' | 'video' | 'audio' | 'subtitle'
    mimeType: string
  }>
  createdAt: string
}

type ToolInput = Readonly<Record<string, unknown>>

// Node Host packages are installed without an extension-local node_modules
// tree. Keep the Host entrypoint runtime-self-contained instead of importing
// the SDK error class at activation time. The broker consumes this public
// structural error shape, while tests may still throw the SDK implementation.
class ExtensionApiError extends Error {
  readonly code: ExtensionErrorData['code']
  readonly operation?: string
  readonly extensionId?: string
  readonly retryable: boolean
  readonly details?: JsonObject
  readonly documentation?: string

  constructor(data: ExtensionErrorData) {
    super(data.message)
    this.name = 'ExtensionApiError'
    this.code = data.code
    this.operation = data.operation
    this.extensionId = data.extensionId
    this.retryable = data.retryable
    this.details = data.details
    this.documentation = data.documentation
  }
}

export class VideoEditorTools {
  private projectService?: ProjectService

  constructor(private readonly context: ExtensionContext) {}

  async register(): Promise<void> {
    for (const declaration of VIDEO_TOOL_DECLARATIONS) {
      this.context.subscriptions.add(
        await this.context.tools.registerTool(declaration, (input, invocation) =>
          this.invoke(declaration.id, input, invocation)
        )
      )
    }
  }

  async invoke(
    toolId: string,
    input: JsonObject,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    try {
      assertNotCancelled(invocation)
      const parsed = asRecord(input, toolId)
      switch (toolId) {
        case 'video-project':
          return await this.videoProject(parsed)
        case 'video-probe':
          return await this.videoProbe(parsed, invocation)
        case 'video-transcribe':
          return await this.videoTranscribe(parsed)
        case 'video-read-script':
          return await this.videoReadScript(parsed)
        case 'video-apply-script':
          return await this.videoApplyScript(parsed)
        case 'video-update-timeline':
          return await this.videoUpdateTimeline(parsed)
        case 'video-render':
          return await this.videoRender(parsed, invocation)
        case 'video-render-status':
          return await this.videoRenderStatus(parsed)
        case 'video-render-cancel':
          return await this.videoRenderCancel(parsed)
        default:
          throw new ToolInputError(`Unknown video tool: ${toolId}`)
      }
    } catch (error) {
      if (error instanceof VideoEngineError) throw publicEngineError(error, toolId)
      throw error
    }
  }

  async editorRequest(value: JsonValue): Promise<JsonValue> {
    try {
      return await this.editorRequestResult(value) as unknown as JsonValue
    } catch (error) {
      if (error instanceof VideoEngineError) throw publicEngineError(error, 'editor-request')
      throw error
    }
  }

  private async editorRequestResult(value: JsonValue): Promise<ToolResult> {
    const request = asRecord(value, 'editor-request')
    exactKeys(request, ['action', 'payload'])
    const action = enumValue(request.action, [
      'project.list',
      'project.active',
      'project.get',
      'project.select',
      'project.create',
      'project.update',
      'project.undo',
      'project.redo',
      'script.read',
      'script.apply',
      'media.import',
      'media.reauthorize',
      'transcript.import',
      'render.list',
      'render.start',
      'render.status',
      'render.cancel'
    ] as const, 'action')
    const payload = request.payload === undefined ? {} : asRecord(request.payload, 'payload')
    const invocation = this.commandInvocation(action)
    let response: ToolResult
    switch (action) {
      case 'project.list':
        response = await this.videoProject({ ...payload, action: 'list' })
        break
      case 'project.active':
        response = await this.videoProject({ ...payload, action: 'active' }, 'manual')
        break
      case 'project.get':
        response = await this.videoProject({ ...payload, action: 'get' }, 'manual')
        break
      case 'project.select':
        response = await this.videoProject({ ...payload, action: 'select' }, 'manual')
        break
      case 'project.create':
        response = await this.videoProject({ ...payload, action: 'create' }, 'manual')
        break
      case 'project.update':
        response = await this.videoUpdateTimeline(payload, 'manual')
        break
      case 'project.undo':
      case 'project.redo':
        response = await this.videoHistory(payload, action === 'project.undo' ? 'undo' : 'redo')
        break
      case 'script.read':
        response = await this.videoReadScript(payload)
        break
      case 'script.apply':
        response = await this.videoApplyScript(payload, 'manual')
        break
      case 'media.import':
        response = await this.videoProbe(payload, invocation, 'manual')
        break
      case 'media.reauthorize':
        response = await this.videoReauthorize(payload, invocation)
        break
      case 'transcript.import':
        response = await this.videoTranscribe(payload, 'manual')
        break
      case 'render.list':
        response = await this.videoRenderList(payload)
        break
      case 'render.start':
        response = await this.videoRender(payload, invocation)
        break
      case 'render.status':
        response = await this.videoRenderStatus(payload)
        break
      case 'render.cancel':
        response = await this.videoRenderCancel(payload)
        break
    }
    return response
  }

  private async videoProject(
    input: ToolInput,
    source: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, ['action', 'projectId', 'name', 'fps', 'canvasPreset', 'expectedRevision'])
    const action = enumValue(
      input.action,
      ['active', 'list', 'get', 'create', 'select'] as const,
      'action'
    )
    const service = this.service()
    if (action === 'active') return this.activeProject(service)
    if (action === 'list') {
      const listed = await service.listProjectsWithDiagnostics()
      const projects = listed.projects
      const bounded = projects.slice(0, MAX_PROJECTS)
      return result({
        outcome: 'listed',
        workspaceId: this.workspaceId(),
        projects: bounded,
        diagnostics: listed.diagnostics.slice(0, MAX_PROJECTS),
        truncated: projects.length > bounded.length
      }, `Listed ${bounded.length} video projects`)
    }

    const projectId = stableId(input.projectId, 'projectId')
    if (action === 'create') {
      const name = boundedString(input.name, 'name', 1, 160)
      const fps = input.fps === undefined ? undefined : rational(input.fps, 'fps')
      const canvasPreset = input.canvasPreset === undefined
        ? undefined
        : enumValue(input.canvasPreset, ['16:9', '9:16', '1:1'] as const, 'canvasPreset')
      const project = await service.createProject({ id: projectId, name, fps, canvasPreset })
      await this.selectActiveProject(project, 'created', source)
      await this.publishProjectChange(project, 'project-created', ['project'])
      return result({
        outcome: 'created',
        workspaceId: this.workspaceId(),
        project: projectProjection(project),
        truncated: projectProjectionIsTruncated(project)
      }, `Created video project ${project.id}`)
    }

    const project = await service.loadProject(projectId)
    if (input.expectedRevision !== undefined) {
      assertExpectedRevision(project, nonNegativeInteger(input.expectedRevision, 'expectedRevision'))
    }
    if (action === 'select') {
      await this.selectActiveProject(project, 'selected', source)
    }
    return result({
      outcome: action === 'select' ? 'selected' : 'loaded',
      workspaceId: this.workspaceId(),
      project: projectProjection(project),
      truncated: projectProjectionIsTruncated(project)
    }, `${action === 'select' ? 'Selected' : 'Loaded'} video project ${project.id} revision ${project.currentRevision}`)
  }

  private async activeProject(service: ProjectService): Promise<ToolResult> {
    const value = await this.context.storage.workspace.get<JsonValue>(ACTIVE_PROJECT_KEY)
    if (value === undefined) {
      return result({
        outcome: 'no-active-project',
        workspaceId: this.workspaceId()
      }, 'No video project is active in this workspace')
    }

    const stored = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as ToolInput
      : undefined
    let projectId: string | undefined
    try {
      if (stored?.schemaVersion === 1) projectId = stableId(stored.projectId, 'active projectId')
    } catch {
      projectId = undefined
    }
    if (!projectId) {
      await this.context.storage.workspace.delete(ACTIVE_PROJECT_KEY)
      return result({
        outcome: 'stale-active-project',
        workspaceId: this.workspaceId()
      }, 'The stored active video project was invalid and has been cleared')
    }

    let project: VideoProject
    try {
      project = await service.loadProject(projectId)
    } catch (error) {
      await this.context.storage.workspace.delete(ACTIVE_PROJECT_KEY)
      return result({
        outcome: 'stale-active-project',
        workspaceId: this.workspaceId(),
        projectId,
        diagnosticCode: error instanceof VideoEngineError ? error.code : 'invalid_project'
      }, `The active video project ${projectId} is unavailable and was cleared`)
    }

    return result({
      outcome: 'active',
      workspaceId: this.workspaceId(),
      project: projectProjection(project),
      truncated: projectProjectionIsTruncated(project)
    }, `Resolved active video project ${project.id} revision ${project.currentRevision}`)
  }

  private async selectActiveProject(
    project: VideoProject,
    transition: 'created' | 'selected',
    source: RevisionAuthor
  ): Promise<void> {
    const previousProjectId = await this.storedActiveProjectId()
    await this.context.storage.workspace.set(ACTIVE_PROJECT_KEY, {
      schemaVersion: 1,
      projectId: project.id
    })
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.project-changed',
      payload: {
        schemaVersion: 1,
        projectId: project.id,
        activeProjectId: project.id,
        previousProjectId: previousProjectId ?? null,
        revision: project.currentRevision,
        reason: 'active-project-changed',
        transition,
        source,
        changedIds: ['active-project']
      }
    })
  }

  private async storedActiveProjectId(): Promise<string | undefined> {
    const value = await this.context.storage.workspace.get<JsonValue>(ACTIVE_PROJECT_KEY)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const stored = value as ToolInput
    if (stored.schemaVersion !== 1) return undefined
    try {
      return stableId(stored.projectId, 'active projectId')
    } catch {
      return undefined
    }
  }

  private async videoReadScript(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const project = await this.service().loadProject(stableId(input.projectId, 'projectId'))
    if (input.expectedRevision !== undefined) {
      assertExpectedRevision(project, nonNegativeInteger(input.expectedRevision, 'expectedRevision'))
    }
    const markdown = generateTimelineMarkdown(project)
    const header = parseTimelineScriptHeader(markdown)
    const bytes = Buffer.byteLength(markdown, 'utf8')
    const bounded = bytes <= MAX_SCRIPT_BYTES
      ? markdown
      : `${Buffer.from(markdown, 'utf8').subarray(0, MAX_SCRIPT_BYTES).toString('utf8')}\n\n[projection truncated]\n`
    return result({
      outcome: 'script',
      projectId: project.id,
      currentRevision: project.currentRevision,
      digest: header.digest,
      timelineMarkdown: bounded,
      truncated: bytes > MAX_SCRIPT_BYTES,
      totalBytes: bytes
    }, `Read timeline.md for revision ${project.currentRevision}`)
  }

  private async videoProbe(
    input: ToolInput,
    invocation: ToolInvocationContext,
    author: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, [
      'projectId',
      'expectedRevision',
      'mediaHandleId',
      'assetId',
      'addToTimeline',
      'thumbnailOutputHandleId',
      'waveformOutputHandleId'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun could not inspect local ffprobe availability. Install or configure the local media tools and retry; no project data was changed.'
      }, 'Media capability inspection unavailable')
    }
    if (!capabilities.ffprobe.available) {
      return result({
        outcome: 'unavailable',
        code: 'FFPROBE_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun cannot import this media because ffprobe is unavailable. Install or configure ffprobe and retry; no project data was changed.'
      }, 'ffprobe is unavailable for media import')
    }
    if (
      !capabilities.ffmpeg.available &&
      (input.thumbnailOutputHandleId !== undefined || input.waveformOutputHandleId !== undefined)
    ) {
      return result({
        outcome: 'unavailable',
        code: 'FFMPEG_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun cannot generate the requested thumbnail or waveform because FFmpeg is unavailable. Retry without derived outputs, or install or configure FFmpeg; no project data was changed.'
      }, 'FFmpeg is unavailable for derived media')
    }
    let metadata: MediaMetadata
    if (input.mediaHandleId === undefined) {
      let selection
      try {
        selection = await this.context.media.pickFiles({
          multiple: false,
          maxFiles: 1,
          filters: [{
            name: 'Video and audio',
            extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4a', 'mp3', 'wav'],
            mimeTypes: ['video/*', 'audio/*']
          }]
        })
      } catch (error) {
        const interaction = interactionRequired(error, 'Select media in the Kun desktop editor, then retry with the granted mediaHandleId.')
        if (interaction) return result(interaction, 'Media import requires protected interaction')
        throw error
      }
      if (selection.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Media selection was cancelled.' }, 'Media selection cancelled')
      }
      metadata = selection.files[0]!
    } else {
      const handleId = opaqueHandle(input.mediaHandleId, 'mediaHandleId')
      metadata = await this.context.media.stat({ handleId })
    }

    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing Host-granted media', fraction: 0.2 })
    const probe = await this.context.media.probe({ handleId: metadata.handleId })
    const assetId = input.assetId === undefined
      ? `asset-${createHash('sha256').update(metadata.handleId).digest('hex').slice(0, 16)}`
      : stableId(input.assetId, 'assetId')
    const asset = assetFromProbe(assetId, metadata, probe)
    if (current.assets.some(({ id }) => id === asset.id)) {
      throw new ToolInputError(`Asset ${asset.id} already exists; use its existing stable identity.`)
    }

    const candidate = structuredClone(current)
    candidate.assets.push(asset)
    const changedIds = [asset.id]
    if (input.addToTimeline !== false) {
      const item = initialItem(candidate, asset)
      candidate.items.push(item)
      changedIds.push(item.id)
    }
    const saved = await this.service().saveProject(candidate, expectedRevision, {
      author,
      sourceOperation: 'video-probe',
      summary: `Imported and probed ${asset.name}`
    })
    await this.publishProjectChange(saved, 'asset-imported', changedIds)
    await invocation.reportProgress({ message: 'Persisted probed asset metadata', fraction: 0.65 })

    const jobs: JsonObject[] = []
    if (input.thumbnailOutputHandleId !== undefined) {
      const outputHandle = opaqueHandle(input.thumbnailOutputHandleId, 'thumbnailOutputHandleId')
      const started = await this.context.media.startFfmpegJob({
        arguments: [
          '-nostdin', '-i', '{{input:source}}', '-frames:v', '1', '-vf', 'scale=640:-2',
          '-f', 'image2', '{{output:thumbnail}}'
        ],
        inputs: { source: metadata.handleId },
        outputs: { thumbnail: outputHandle },
        idempotencyKey: `${invocation.invocation.invocationId}:thumbnail`,
        metadata: { projectId, revision: saved.currentRevision, assetId, derivedKind: 'thumbnail' }
      })
      jobs.push(jobReferenceProjection(started.job, 'thumbnail'))
    }
    if (input.waveformOutputHandleId !== undefined) {
      const outputHandle = opaqueHandle(input.waveformOutputHandleId, 'waveformOutputHandleId')
      const started = await this.context.media.startFfmpegJob({
        arguments: [
          '-nostdin', '-i', '{{input:source}}', '-filter_complex',
          'showwavespic=s=1200x240:colors=white', '-frames:v', '1', '-f', 'image2',
          '{{output:waveform}}'
        ],
        inputs: { source: metadata.handleId },
        outputs: { waveform: outputHandle },
        idempotencyKey: `${invocation.invocation.invocationId}:waveform`,
        metadata: { projectId, revision: saved.currentRevision, assetId, derivedKind: 'waveform' }
      })
      jobs.push(jobReferenceProjection(started.job, 'waveform'))
    }
    await invocation.reportProgress({ message: 'Media import complete', fraction: 1 })
    return result({
      outcome: 'imported',
      projectId,
      currentRevision: saved.currentRevision,
      asset: assetProjection(asset),
      metadata: probeProjection(probe),
      jobs
    }, `Imported ${asset.name} at revision ${saved.currentRevision}`)
  }

  private async videoReauthorize(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'assetId', 'mediaHandleId'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const assetId = stableId(input.assetId, 'assetId')
    const mediaHandleId = opaqueHandle(input.mediaHandleId, 'mediaHandleId')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    const assetIndex = current.assets.findIndex(({ id }) => id === assetId)
    if (assetIndex < 0) throw new ToolInputError(`Asset ${assetId} does not exist.`)
    const previous = current.assets[assetIndex]!
    const metadata = await this.context.media.stat({ handleId: mediaHandleId })
    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing replacement media grant', fraction: 0.25 })
    const probe = await this.context.media.probe({ handleId: mediaHandleId })
    const replacement = {
      ...assetFromProbe(assetId, metadata, probe),
      name: previous.name,
      transcriptIds: [...previous.transcriptIds]
    }
    if (replacement.kind !== previous.kind) {
      throw new ToolInputError(
        `Replacement media kind ${replacement.kind} does not match ${previous.kind} asset ${assetId}.`
      )
    }
    const candidate = structuredClone(current)
    candidate.assets[assetIndex] = replacement
    const saved = await this.service().saveProject(candidate, expectedRevision, {
      author: 'manual',
      sourceOperation: 'media.reauthorize',
      summary: `Reauthorized ${previous.name}`
    })
    await this.publishProjectChange(saved, 'asset-reauthorized', [assetId])
    if (previous.mediaHandleId && previous.mediaHandleId !== mediaHandleId) {
      await this.context.media.release({
        resource: 'handle',
        handleId: previous.mediaHandleId
      }).catch(() => undefined)
    }
    await invocation.reportProgress({ message: 'Replacement media grant saved', fraction: 1 })
    return result({
      outcome: 'reauthorized',
      projectId,
      currentRevision: saved.currentRevision,
      asset: assetProjection(replacement)
    }, `Reauthorized ${previous.name} at revision ${saved.currentRevision}`)
  }

  private async videoTranscribe(
    input: ToolInput,
    author: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'assetId', 'transcriptId', 'mode', 'format',
      'language', 'source', 'segments'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const assetId = stableId(input.assetId, 'assetId')
    const transcriptId = stableId(input.transcriptId, 'transcriptId')
    const mode = enumValue(input.mode, ['import', 'local-asr'] as const, 'mode')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const asset = project.assets.find(({ id }) => id === assetId)
    if (!asset) throw new ToolInputError(`Asset ${assetId} does not exist in project ${projectId}.`)

    if (mode === 'local-asr') {
      return result({
        outcome: 'unavailable',
        projectId,
        previousRevision: expectedRevision,
        currentRevision: expectedRevision,
        changedIds: [],
        summary: 'Local ASR execution is unavailable through Extension API v1.1. Import a timed SRT, VTT, or JSON transcript; no media was uploaded and no text was invented.',
        details: { code: 'transcriber_unavailable', networkUsed: false }
      }, 'Local transcriber unavailable')
    }

    if ((input.source === undefined) === (input.segments === undefined)) {
      throw new ToolInputError('Transcript import requires exactly one of source or segments.')
    }
    const language = input.language === undefined
      ? undefined
      : boundedString(input.language, 'language', 1, 32)
    const format = input.segments === undefined
      ? enumValue(input.format, ['srt', 'vtt', 'json'] as const, 'format')
      : 'json'
    const source = input.segments === undefined
      ? boundedString(input.source, 'source', 1, 524_288)
      : JSON.stringify({
          segments: boundedArray(input.segments, 'segments', 1, 20_000).map(transcriptSegmentInput)
        })
    const transcript = importTranscript(source, { format, transcriptId, asset, language })
    const candidate = structuredClone(project)
    const existingIndex = candidate.transcripts.findIndex(({ id }) => id === transcript.id)
    if (existingIndex >= 0) candidate.transcripts[existingIndex] = transcript
    else candidate.transcripts.push(transcript)
    const candidateAsset = candidate.assets.find(({ id }) => id === assetId)!
    candidateAsset.transcriptIds = [...new Set([...candidateAsset.transcriptIds, transcript.id])].sort()
    const saved = await this.service().saveProject(candidate, expectedRevision, {
      author,
      sourceOperation: 'video-transcribe',
      summary: `Imported ${transcript.provenance.toUpperCase()} transcript ${transcript.id}`
    })
    const changedIds = [assetId, transcript.id]
    await this.publishProjectChange(saved, 'transcript-imported', changedIds)
    return result({
      outcome: 'transcribed',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds,
      summary: `Imported ${transcript.segments.length} timed transcript segments without network access.`,
      details: transcriptProjection(transcript, MAX_TRANSCRIPT_SEGMENTS)
    }, `Imported transcript at revision ${saved.currentRevision}`)
  }

  private async videoApplyScript(
    input: ToolInput,
    author: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'timelineMarkdown', 'ranges', 'summary'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const markdown = boundedString(input.timelineMarkdown, 'timelineMarkdown', 1, 262_144)
    const ranges = boundedArray(input.ranges, 'ranges', 1, 2_000).map(assetRange)
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const applied = applyTimelineScript(project, markdown, ranges)
    const summary = input.summary === undefined
      ? `Applied ${applied.removed.length} transcript-timed cuts`
      : boundedString(input.summary, 'summary', 1, 512)
    const saved = await this.service().saveProject(applied.project, expectedRevision, {
      author,
      sourceOperation: 'video-apply-script',
      summary
    })
    await this.publishProjectChange(saved, 'script-applied', applied.changedIds)
    return result({
      outcome: 'applied',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds: applied.changedIds,
      summary,
      details: { removedRanges: applied.removed }
    }, `Applied timeline script at revision ${saved.currentRevision}`)
  }

  private async videoUpdateTimeline(
    input: ToolInput,
    author: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'operations', 'summary'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const operations = boundedArray(input.operations, 'operations', 1, 200)
      .map(strictTimelineOperation)
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    const preview = applyTimelineOperations(current, operations)
    const summary = input.summary === undefined
      ? `Applied ${operations.length} structured timeline operations`
      : boundedString(input.summary, 'summary', 1, 512)
    const saved = await this.service().applyOperations(projectId, expectedRevision, operations, {
      author,
      sourceOperation: 'video-update-timeline',
      summary
    })
    await this.publishProjectChange(saved, 'timeline-updated', preview.changedIds)
    return result({
      outcome: 'updated',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds: preview.changedIds,
      summary,
      details: { operationCount: operations.length }
    }, `Updated timeline at revision ${saved.currentRevision}`)
  }

  private async videoHistory(input: ToolInput, action: 'undo' | 'redo'): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = action === 'undo'
      ? await this.service().undo(projectId, expectedRevision, 'manual')
      : await this.service().redo(projectId, expectedRevision, 'manual')
    await this.publishProjectChange(project, `project-${action}`, ['history'])
    return result({
      outcome: action === 'undo' ? 'undone' : 'redone',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: project.currentRevision,
      changedIds: ['history'],
      summary: `${action === 'undo' ? 'Undid' : 'Redid'} the previous project revision.`,
      details: { project: projectProjection(project) }
    }, `${action === 'undo' ? 'Undid' : 'Redid'} project at revision ${project.currentRevision}`)
  }

  private async videoRender(input: ToolInput, invocation: ToolInvocationContext): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'kind', 'outputHandleId', 'proofFrame',
      'captionMode', 'subtitleOutputHandleId', 'subtitleFormat', 'idempotencyKey'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const kind = enumValue(
      input.kind,
      ['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'] as const,
      'kind'
    )
    const subtitleFormat = input.subtitleFormat === undefined
      ? 'srt'
      : enumValue(input.subtitleFormat, ['srt', 'vtt'] as const, 'subtitleFormat')
    const captionMode = input.captionMode === undefined
      ? 'none'
      : enumValue(input.captionMode, ['none', 'burned', 'sidecar', 'both'] as const, 'captionMode')
    if (kind === 'subtitles' && captionMode !== 'none') {
      throw new ToolInputError('Standalone subtitle export does not accept a media caption mode.')
    }
    if ((captionMode === 'sidecar' || captionMode === 'both') && kind !== 'h264-mp4') {
      throw new ToolInputError('Caption sidecars are supported only for the final H.264 video export.')
    }
    if (captionMode === 'burned' && kind === 'audio-aac') {
      throw new ToolInputError('Burned captions require a proof, preview, or final video render.')
    }
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const capabilityFailure = await this.renderCapabilityFailure(project, kind, captionMode)
    if (capabilityFailure) return capabilityFailure

    let outputHandleId: string
    let ownsOutputHandle = false
    if (input.outputHandleId === undefined) {
      let selection
      try {
        selection = await this.context.media.pickSaveTarget({
          suggestedName: renderFileName(project, kind, subtitleFormat),
          filters: [renderFilter(kind, subtitleFormat)]
        })
      } catch (error) {
        const interaction = interactionRequired(error, 'Choose an export target in the Kun desktop editor, then retry with its outputHandleId.')
        if (interaction) return result(interaction, 'Render requires protected interaction')
        throw error
      }
      if (selection.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Export target selection was cancelled.' }, 'Export selection cancelled')
      }
      outputHandleId = selection.target.handleId
      ownsOutputHandle = true
    } else {
      outputHandleId = opaqueHandle(input.outputHandleId, 'outputHandleId')
    }

    let subtitleOutputHandleId: string | undefined
    let ownsSubtitleOutputHandle = false
    let renderStarted = false
    try {
    if (captionMode === 'sidecar' || captionMode === 'both') {
      if (input.subtitleOutputHandleId === undefined) {
        let selection
        try {
          selection = await this.context.media.pickSaveTarget({
            suggestedName: `${project.id}-revision-${project.currentRevision}.${subtitleFormat}`,
            filters: [{
              name: subtitleFormat === 'srt' ? 'SubRip captions' : 'WebVTT captions',
              extensions: [subtitleFormat],
              mimeTypes: [subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt']
            }]
          })
        } catch (error) {
          const interaction = interactionRequired(error, 'Choose a protected subtitle export target, then retry with its subtitleOutputHandleId.')
          if (interaction) return result(interaction, 'Caption sidecar export requires protected interaction')
          throw error
        }
        if (selection.outcome === 'cancelled') {
          return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Subtitle export target selection was cancelled.' }, 'Subtitle export selection cancelled')
        }
        subtitleOutputHandleId = selection.target.handleId
        ownsSubtitleOutputHandle = true
      } else {
        subtitleOutputHandleId = opaqueHandle(input.subtitleOutputHandleId, 'subtitleOutputHandleId')
      }
    } else if (
      input.subtitleOutputHandleId !== undefined ||
      (kind !== 'subtitles' && input.subtitleFormat !== undefined)
    ) {
      throw new ToolInputError('Subtitle output fields require captionMode sidecar or both.')
    }
    if (kind !== 'proof-frame' && input.proofFrame !== undefined) {
      throw new ToolInputError('proofFrame is supported only for proof-frame renders.')
    }
    const proofFrame = kind === 'proof-frame'
      ? input.proofFrame === undefined
        ? 0
        : nonNegativeInteger(input.proofFrame, 'proofFrame')
      : undefined
    const plan = generateRenderPlan(project, {
      kind,
      expectedRevision,
      outputHandleId,
      proofFrame,
      captionMode,
      subtitleFormat,
      ...(subtitleOutputHandleId ? { subtitleOutputHandleId } : {})
    })
    const textSteps = plan.steps.filter(
      (renderStep): renderStep is TextRenderStep => renderStep.kind === 'write-text'
    )
    const ffmpegSteps = plan.steps.filter(
      (step): step is FfmpegRenderStep => step.kind === 'ffmpeg'
    )
    const standaloneSubtitles = kind === 'subtitles'
    if (
      textSteps.length > 1 ||
      (standaloneSubtitles
        ? textSteps.length !== 1 || ffmpegSteps.length !== 0
        : ffmpegSteps.length !== 1)
    ) {
      throw new ToolInputError(
        'This render plan exceeds the supported single-media/single-sidecar export transaction.'
      )
    }
    if (textSteps[0] && new TextEncoder().encode(textSteps[0].content).byteLength > 192 * 1024) {
      throw new ToolInputError(
        'The generated subtitle sidecar exceeds the 192 KiB durable-job limit; shorten or split the caption export.'
      )
    }
    const inputs: Record<string, string> = {}
    const step = ffmpegSteps[0]
    if (step) {
      for (const [name, reference] of Object.entries(step.inputs)) {
        if (reference.kind !== 'media-handle') {
          throw new ToolInputError(`Render input ${name} is not backed by a durable media handle.`)
        }
        inputs[name] = opaqueHandle(reference.reference, `render input ${name}`)
      }
    }
    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Submitting durable media job', fraction: 0.5 })
    const started = await this.context.media.startFfmpegJob({
      arguments: step?.args ?? [],
      inputs,
      outputs: step?.outputs ?? {},
      ...(textSteps.length === 1 ? {
        textOutputs: {
          [textSteps[0]!.id]: {
            handleId: opaqueHandle(textSteps[0]!.output, 'subtitle output'),
            mimeType: textSteps[0]!.mime,
            content: textSteps[0]!.content
          }
        }
      } : {}),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: boundedString(input.idempotencyKey, 'idempotencyKey', 1, 256) }),
      metadata: {
        projectId,
        pinnedRevision: expectedRevision,
        renderKind: kind,
        captionMode,
        subtitleFormat,
        canvasPreset: project.canvas.preset,
        proofFrame: proofFrame ?? null
      }
    })
    renderStarted = true
    const record: RenderRecord = {
      schemaVersion: 1,
      jobId: started.job.jobId,
      projectId,
      pinnedRevision: expectedRevision,
      renderKind: kind,
      captionMode,
      subtitleFormat,
      canvasPreset: project.canvas.preset,
      ...(proofFrame !== undefined ? { proofFrame } : {}),
      expectedArtifacts: plan.artifacts.map((artifact) => ({
        mediaKind: artifact.kind,
        mimeType: artifact.mime
      })),
      createdAt: new Date().toISOString()
    }
    try {
      await this.context.storage.workspace.set(renderKey(started.job.jobId), record)
    } catch {
      const confirmed = await this.loadRenderRecord(started.job.jobId)
      if (!confirmed || !sameRenderTrackingRecord(confirmed, record)) {
        const cancellation = await this.cancelAfterRenderTrackingFailure(started.job.jobId)
        throw new ExtensionApiError({
          code: 'INTERNAL_ERROR',
          message: `Durable render tracking could not be persisted after job ${started.job.jobId} started. ` +
            `Cancellation was attempted and the durable job is ${cancellation.state}; ` +
            'use video-render-status with this jobId before retrying.',
          operation: 'video-render',
          retryable: false,
          details: {
            jobId: started.job.jobId,
            state: cancellation.state,
            cancellationAttempted: true,
            cancellationAccepted: cancellation.accepted,
            trackingPersisted: false
          }
        })
      }
    }
    await invocation.reportProgress({ message: 'Durable media job queued', fraction: 1 })
    return result({
      outcome: 'queued',
      jobId: started.job.jobId,
      state: started.job.state,
      projectId,
      pinnedRevision: expectedRevision,
      renderKind: kind,
      proofStale: false,
      technicallyValidated: false,
      artifacts: []
    }, `Queued ${kind} render for revision ${expectedRevision}`)
    } finally {
      if (!renderStarted) {
        const ownedHandles = [
          ...(ownsOutputHandle ? [outputHandleId] : []),
          ...(ownsSubtitleOutputHandle && subtitleOutputHandleId ? [subtitleOutputHandleId] : [])
        ]
        await Promise.all(ownedHandles.map((handleId) =>
          this.context.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
      }
    }
  }

  private async renderCapabilityFailure(
    project: VideoProject,
    kind: RenderKind,
    captionMode: RenderRecord['captionMode']
  ): Promise<ToolResult | undefined> {
    // Standalone subtitle exports are durable bounded text writes. They do not
    // execute or validate media and must remain available without FFmpeg.
    if (kind === 'subtitles') return undefined

    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId: project.id,
        currentRevision: project.currentRevision,
        changedIds: [],
        retryable: true,
        renderKind: kind,
        captionMode,
        missingCapabilities: ['capability-inspection'],
        message: `Kun could not inspect local FFmpeg and ffprobe capabilities for the ${kind} render. ` +
          'Install or configure both media executables and retry. No output target was selected and no render job was started.'
      }, 'Media capability inspection unavailable; no render was started')
    }

    const missing: Array<{
      code: string
      id: string
      label: string
      guidance: string
    }> = []
    if (!capabilities.ffprobe.available) {
      missing.push({
        code: 'FFPROBE_UNAVAILABLE',
        id: 'ffprobe',
        label: 'ffprobe executable',
        guidance: 'Install or configure ffprobe so Kun can validate generated media.'
      })
    }
    if (!capabilities.ffmpeg.available) {
      missing.push({
        code: 'FFMPEG_UNAVAILABLE',
        id: 'ffmpeg',
        label: 'FFmpeg executable',
        guidance: 'Install or configure FFmpeg for media rendering.'
      })
    }

    const features = new Set(capabilities.ffmpeg.features)
    if (
      capabilities.ffmpeg.available &&
      (kind === 'preview' || kind === 'h264-mp4') &&
      !features.has('libx264-encoder')
    ) {
      missing.push({
        code: 'LIBX264_ENCODER_UNAVAILABLE',
        id: 'libx264-encoder',
        label: 'libx264 encoder',
        guidance: 'Use an FFmpeg build that includes the libx264 encoder.'
      })
    }
    const timelineHasAudio = project.items.some((item) =>
      project.assets.some((asset) => asset.id === item.assetId && asset.audio !== undefined)
    )
    if (
      capabilities.ffmpeg.available &&
      (kind === 'audio-aac' ||
        ((kind === 'preview' || kind === 'h264-mp4') && timelineHasAudio)) &&
      !features.has('aac-encoder')
    ) {
      missing.push({
        code: 'AAC_ENCODER_UNAVAILABLE',
        id: 'aac-encoder',
        label: 'AAC encoder',
        guidance: 'Use an FFmpeg build that includes the AAC encoder.'
      })
    }
    if (
      capabilities.ffmpeg.available &&
      (captionMode === 'burned' || captionMode === 'both') &&
      !features.has('drawtext-filter')
    ) {
      missing.push({
        code: 'DRAWTEXT_FILTER_UNAVAILABLE',
        id: 'drawtext-filter',
        label: 'drawtext filter',
        guidance: "Retry with captionMode 'none' or 'sidecar', or use an FFmpeg build that includes drawtext."
      })
    }

    if (missing.length > 0) {
      const labels = missing.map(({ label }) => label)
      const guidance = missing.map(({ guidance: item }) => item)
      return result({
        outcome: 'unavailable',
        code: missing[0]!.code,
        projectId: project.id,
        currentRevision: project.currentRevision,
        changedIds: [],
        retryable: true,
        renderKind: kind,
        captionMode,
        missingCapabilities: missing.map(({ id }) => id),
        message: `Cannot start the ${kind} render; missing media capability: ${labels.join(', ')}. ` +
          `${guidance.join(' ')} No output target was selected and no render job was started.`
      }, `Render unavailable: missing ${labels.join(', ')}`)
    }
    return undefined
  }

  private async cancelAfterRenderTrackingFailure(
    jobId: string
  ): Promise<{ state: JobSnapshot['state'] | 'unknown'; accepted: boolean }> {
    try {
      const cancellation = await this.context.jobs.cancel({
        jobId,
        reason: 'Render tracking persistence failed after durable job admission'
      })
      const terminal = await this.waitForTerminalJob(cancellation.snapshot)
      return { state: terminal.state, accepted: cancellation.accepted }
    } catch {
      try {
        return { state: (await this.context.jobs.get(jobId)).state, accepted: false }
      } catch {
        return { state: 'unknown', accepted: false }
      }
    }
  }

  private async waitForTerminalJob(initial: JobSnapshot): Promise<JobSnapshot> {
    if (isTerminalJobState(initial.state)) return initial
    let subscription: Awaited<ReturnType<ExtensionContext['jobs']['subscribe']>> | undefined
    try {
      subscription = await this.context.jobs.subscribe({
        jobId: initial.id,
        afterCursor: initial.latestCursor
      })
      const activeSubscription = subscription
      if (isTerminalJobState(activeSubscription.snapshot.state)) return activeSubscription.snapshot
      return await new Promise<JobSnapshot>((resolve) => {
        let settled = false
        const finish = (snapshot: JobSnapshot): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(snapshot)
        }
        const timeout = setTimeout(() => {
          void this.context.jobs.get(initial.id).then(finish, () => finish(activeSubscription.snapshot))
        }, RENDER_TRACKING_CANCELLATION_WAIT_MS)
        activeSubscription.onEvent(() => {
          if (isTerminalJobState(activeSubscription.snapshot.state)) finish(activeSubscription.snapshot)
        })
        if (isTerminalJobState(activeSubscription.snapshot.state)) finish(activeSubscription.snapshot)
      })
    } catch {
      try {
        return await this.context.jobs.get(initial.id)
      } catch {
        return initial
      }
    } finally {
      try {
        await subscription?.dispose()
      } catch {
        // The durable snapshot remains queryable by jobId even if unsubscribe loses the Host connection.
      }
    }
  }

  private async videoRenderStatus(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['jobId', 'projectId'])
    const jobId = boundedString(input.jobId, 'jobId', 8, 512)
    const projectId = input.projectId === undefined
      ? undefined
      : stableId(input.projectId, 'projectId')
    const snapshot = await this.context.jobs.get(jobId)
    const record = await this.scopedRenderRecord(snapshot, projectId)
    return await this.renderStatusResult(snapshot, record)
  }

  private async videoRenderList(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [])
    const page = await this.context.jobs.list({
      filter: { kinds: ['media.ffmpeg'], workspaceId: this.workspaceId() },
      limit: 200
    })
    const records: JsonObject[] = []
    let untrackedCount = 0
    for (const snapshot of page.items) {
      try {
        this.assertOwnedRenderSnapshot(snapshot)
        const record = await this.loadOrRecoverRenderRecord(snapshot)
        if (!record) {
          untrackedCount += 1
          continue
        }
        records.push({
          jobId: record.jobId,
          projectId: record.projectId,
          pinnedRevision: record.pinnedRevision,
          renderKind: record.renderKind,
          createdAt: record.createdAt
        })
      } catch {
        untrackedCount += 1
      }
    }
    return result({
      outcome: 'listed',
      records,
      truncated: page.page.hasMore,
      untrackedCount
    }, `Listed ${records.length} tracked video renders`)
  }

  private async videoRenderCancel(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['jobId', 'projectId', 'reason'])
    const jobId = boundedString(input.jobId, 'jobId', 8, 512)
    const projectId = input.projectId === undefined
      ? undefined
      : stableId(input.projectId, 'projectId')
    const snapshot = await this.context.jobs.get(jobId)
    const record = await this.scopedRenderRecord(snapshot, projectId)
    if (!record) {
      throw new ToolInputError(
        'The durable job has no verified video-render tracking record and cannot be cancelled by this tool.'
      )
    }
    const cancellation = await this.context.jobs.cancel({
      jobId,
      ...(input.reason === undefined
        ? {}
        : { reason: boundedString(input.reason, 'reason', 1, 512) })
    })
    return await this.renderStatusResult(cancellation.snapshot, record)
  }

  private async renderStatusResult(
    snapshot: JobSnapshot,
    record: RenderRecord | undefined
  ): Promise<ToolResult> {
    const currentRevision = record
      ? await this.currentRevision(record.projectId)
      : undefined
    const proofStale = record !== undefined && currentRevision !== undefined
      ? currentRevision !== record.pinnedRevision
      : false
    const validation = await this.validateArtifacts(snapshot, record)
    const outcome = snapshot.state === 'completed' && !validation.valid
      ? 'invalid-output'
      : snapshot.state
    const content: JsonObject = {
      outcome,
      jobId: snapshot.id,
      state: snapshot.state,
      tracked: record !== undefined,
      ...(record ? {
        projectId: record.projectId,
        pinnedRevision: record.pinnedRevision,
        renderKind: record.renderKind,
        captionMode: record.captionMode,
        subtitleFormat: record.subtitleFormat,
        canvasPreset: record.canvasPreset,
        proofFrame: record.proofFrame ?? null,
        currentRevision: currentRevision ?? null,
        projectAvailable: currentRevision !== undefined
      } : {}),
      proofStale,
      technicallyValidated: validation.valid,
      ...(snapshot.progress ? { progress: snapshot.progress as unknown as JsonObject } : {}),
      ...(snapshot.error ? { error: snapshot.error as unknown as JsonObject } : {}),
      artifacts: validation.artifacts,
      ...(validation.reason ? { message: validation.reason } : {})
    }
    return {
      content,
      summary: renderStatusSummary(snapshot, validation.valid, proofStale),
      metadata: {
        machineValidatedOnly: validation.valid,
        visuallyInspected: false,
        proofStale
      },
      ...(validation.valid && validation.artifacts.length > 0
        ? { generatedArtifacts: validation.artifacts }
        : {})
    }
  }

  private async scopedRenderRecord(
    snapshot: JobSnapshot,
    expectedProjectId: string | undefined
  ): Promise<RenderRecord | undefined> {
    this.assertOwnedRenderSnapshot(snapshot)
    const record = await this.loadOrRecoverRenderRecord(snapshot)
    if (expectedProjectId !== undefined && record?.projectId !== expectedProjectId) {
      throw new ToolInputError(
        'The durable job could not be verified as a render for the requested project.'
      )
    }
    return record
  }

  private assertOwnedRenderSnapshot(snapshot: JobSnapshot): void {
    if (
      snapshot.ownerExtensionId !== this.context.extension.id ||
      snapshot.ownerExtensionVersion !== this.context.extension.version ||
      snapshot.workspaceId !== this.workspaceId() ||
      snapshot.kind !== 'media.ffmpeg' ||
      snapshot.initiatingOperation !== 'media.startFfmpegJob'
    ) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The durable job is not an owned video render in this workspace.',
        operation: 'video-render-status',
        retryable: false
      })
    }
  }

  private service(): ProjectService {
    const workspace = this.context.workspaceContext
    if (!workspace?.active || !workspace.trusted) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The video editor requires an active trusted workspace.',
        operation: 'video-project',
        retryable: true
      })
    }
    this.projectService ??= new ProjectService(workspace.root)
    return this.projectService
  }

  private commandInvocation(action: string): ToolInvocationContext {
    const invocationId = `editor-request-${Date.now().toString(36)}`
    return {
      invocation: {
        invocationId,
        toolId: `editor-request:${action}`,
        input: {},
        workspaceId: this.context.workspaceContext?.id
      },
      cancellation: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} })
      },
      reportProgress: async (progress) => {
        await this.context.ui.postMessage({
          channel: 'kun-video-editor.command-progress',
          payload: {
            schemaVersion: 1,
            action,
            invocationId,
            message: progress.message ?? null,
            fraction: progress.fraction ?? null,
            data: progress.data ?? null
          }
        })
      }
    }
  }

  private workspaceId(): string {
    const workspace = this.context.workspaceContext
    if (!workspace?.active || !workspace.trusted) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The video editor requires an active trusted workspace.',
        operation: 'video-project',
        retryable: true
      })
    }
    return workspace.id
  }

  private async publishProjectChange(
    project: VideoProject,
    reason: string,
    changedIds: readonly string[]
  ): Promise<void> {
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.project-changed',
      payload: {
        schemaVersion: 1,
        projectId: project.id,
        revision: project.currentRevision,
        reason,
        changedIds: [...changedIds].slice(0, 2_000)
      }
    })
  }

  private async loadRenderRecord(jobId: string): Promise<RenderRecord | undefined> {
    let value: JsonValue | undefined
    try {
      value = await this.context.storage.workspace.get<JsonValue>(renderKey(jobId))
    } catch {
      return undefined
    }
    return storedRenderRecord(value, jobId)
  }

  private async loadOrRecoverRenderRecord(snapshot: JobSnapshot): Promise<RenderRecord | undefined> {
    const stored = await this.loadRenderRecord(snapshot.id)
    const recovered = recoverRenderRecord(snapshot)
    if (stored && (!recovered || sameRenderTrackingRecord(stored, recovered))) return stored
    if (!recovered) return stored
    try {
      await this.context.storage.workspace.set(renderKey(snapshot.id), recovered)
    } catch {
      // Core-owned result provenance remains the source of truth when extension storage is unavailable.
    }
    return recovered
  }

  private async currentRevision(projectId: string): Promise<number | undefined> {
    try {
      return (await this.service().loadProject(projectId)).currentRevision
    } catch {
      return undefined
    }
  }

  private async validateArtifacts(
    snapshot: JobSnapshot,
    record: RenderRecord | undefined
  ): Promise<{ valid: boolean; artifacts: GeneratedArtifact[]; reason?: string }> {
    if (snapshot.state !== 'completed') return { valid: false, artifacts: [] }
    const artifacts = snapshot.result?.generatedArtifacts ?? []
    if (!record || artifacts.length === 0 || artifacts.length !== record.expectedArtifacts.length) {
      return {
        valid: false,
        artifacts: [],
        reason: 'The completed job did not publish a verified artifact for its pinned render request.'
      }
    }
    try {
      const unmatchedExpected = [...record.expectedArtifacts]
      for (const artifact of artifacts) {
        if (
          artifact.ownerExtensionId !== this.context.extension.id ||
          artifact.ownerExtensionVersion !== this.context.extension.version ||
          artifact.workspaceId !== this.workspaceId() ||
          artifact.availability !== 'available' ||
          artifact.provenance.jobId !== snapshot.id ||
          artifact.byteSize <= 0
        ) {
          throw new Error('artifact identity does not match the pinned render')
        }
        const provenance = artifact.provenance.metadata
        if (
          !provenance ||
          provenance.projectId !== record.projectId ||
          provenance.pinnedRevision !== record.pinnedRevision ||
          provenance.renderKind !== record.renderKind ||
          provenance.captionMode !== record.captionMode ||
          provenance.subtitleFormat !== record.subtitleFormat ||
          provenance.canvasPreset !== record.canvasPreset ||
          (record.proofFrame !== undefined && provenance.proofFrame !== record.proofFrame)
        ) {
          throw new Error('artifact provenance does not match the pinned render settings')
        }
        const expectedIndex = unmatchedExpected.findIndex((expected) =>
          expected.mediaKind === artifact.mediaKind && expected.mimeType === artifact.mimeType
        )
        if (expectedIndex < 0) throw new Error('artifact media type was not requested by the pinned render')
        unmatchedExpected.splice(expectedIndex, 1)
        const stat = await this.context.media.stat({ handleId: artifact.mediaHandleId })
        if (
          stat.revoked ||
          stat.byteSize === undefined ||
          stat.byteSize <= 0 ||
          (stat.completionIdentity !== undefined && stat.completionIdentity !== artifact.completionIdentity)
        ) {
          throw new Error('artifact media is unavailable or replaced')
        }
        if (artifact.mediaKind === 'video') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          if (
            !probe.streams.some(({ kind }) => kind === 'video') ||
            (probe.container.durationMicros ?? 0) <= 0
          ) {
            throw new Error('rendered video is missing a positive-duration video stream')
          }
        }
        if (artifact.mediaKind === 'audio') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          if (
            !probe.streams.some(({ kind }) => kind === 'audio') ||
            (probe.container.durationMicros ?? 0) <= 0
          ) {
            throw new Error('rendered audio is missing a positive-duration audio stream')
          }
        }
        if (artifact.mediaKind === 'subtitle') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          if (!probe.streams.some(({ kind }) => kind === 'subtitle')) {
            throw new Error('subtitle artifact is missing a subtitle stream')
          }
        }
      }
      if (unmatchedExpected.length > 0) throw new Error('one or more requested artifacts are missing')
      return { valid: true, artifacts }
    } catch {
      return {
        valid: false,
        artifacts: [],
        reason: 'The job reached completed state, but the output failed bounded artifact or post-probe validation.'
      }
    }
  }
}

function result(content: JsonObject, summary: string, metadata?: JsonObject): ToolResult {
  return { content, summary, ...(metadata ? { metadata } : {}) }
}

function projectProjection(project: VideoProject): JsonObject {
  const transcripts: JsonObject[] = []
  let remainingSegments = MAX_TRANSCRIPT_SEGMENTS
  for (const transcript of project.transcripts.slice(0, MAX_TRANSCRIPTS)) {
    const limit = Math.max(0, remainingSegments)
    const projection = transcriptProjection(transcript, limit)
    remainingSegments -= Math.min(transcript.segments.length, limit)
    transcripts.push(projection)
  }
  return {
    schemaVersion: project.schemaVersion,
    id: project.id,
    name: project.name,
    fps: project.fps,
    canvas: project.canvas,
    currentRevision: project.currentRevision,
    canUndo: project.undoStack.length > 0,
    canRedo: project.redoStack.length > 0,
    updatedAt: project.updatedAt,
    durationFrames: projectDurationFrames(project),
    counts: {
      assets: project.assets.length,
      tracks: project.tracks.length,
      items: project.items.length,
      captions: project.captions.length,
      transcripts: project.transcripts.length,
      revisions: project.revisions.length
    },
    assets: project.assets.slice(0, MAX_ASSETS).map(assetProjection),
    tracks: project.tracks.slice(0, MAX_TRACKS),
    items: project.items.slice(0, MAX_ITEMS),
    captions: project.captions.slice(0, MAX_CAPTIONS),
    transcripts,
    revisions: project.revisions.slice(-50).map((entry) => ({
      revision: entry.revision,
      parentRevision: entry.parentRevision,
      author: entry.author,
      sourceOperation: entry.sourceOperation,
      timestamp: entry.timestamp,
      summary: entry.summary,
      restoredFromRevision: entry.restoredFromRevision ?? null
    }))
  }
}

function projectProjectionIsTruncated(project: VideoProject): boolean {
  return project.assets.length > MAX_ASSETS ||
    project.tracks.length > MAX_TRACKS ||
    project.items.length > MAX_ITEMS ||
    project.captions.length > MAX_CAPTIONS ||
    project.transcripts.length > MAX_TRANSCRIPTS ||
    project.transcripts.reduce((total, transcript) => total + transcript.segments.length, 0) > MAX_TRANSCRIPT_SEGMENTS
}

function assetProjection(asset: MediaAsset): JsonObject {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mediaHandleId: asset.mediaHandleId ?? null,
    durationUs: asset.durationUs,
    container: asset.container,
    video: asset.video ?? null,
    audio: asset.audio ?? null,
    transcriptIds: asset.transcriptIds
  }
}

function transcriptProjection(transcript: Transcript, limit: number): JsonObject {
  const segments = transcript.segments.slice(0, limit)
  return {
    id: transcript.id,
    assetId: transcript.assetId,
    language: transcript.language,
    provenance: transcript.provenance,
    segmentCount: transcript.segments.length,
    segments,
    truncated: transcript.segments.length > segments.length
  }
}

function probeProjection(probe: MediaProbeResult): JsonObject {
  return {
    schemaVersion: probe.schemaVersion,
    handleId: probe.handleId,
    container: probe.container,
    streams: probe.streams.slice(0, 32),
    truncated: probe.streams.length > 32
  }
}

function assetFromProbe(
  assetId: string,
  metadata: MediaMetadata,
  probe: MediaProbeResult
): MediaAsset {
  const video = probe.streams.find(({ kind }) => kind === 'video')
  const audio = probe.streams.find(({ kind }) => kind === 'audio')
  if (!video && !audio) throw new ToolInputError('The selected media has no supported audio or video stream.')
  const durationUs = probe.container.durationMicros ?? Math.max(
    0,
    ...probe.streams.map(({ durationMicros }) => durationMicros ?? 0)
  )
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new ToolInputError('The selected media has no positive bounded duration.')
  }
  if (video && (!video.codecName || !video.width || !video.height || !video.frameRate)) {
    throw new ToolInputError('The video probe did not provide codec, dimensions, and rational frame rate.')
  }
  if (audio && (!audio.codecName || !audio.sampleRate || !audio.channelCount)) {
    throw new ToolInputError('The audio probe did not provide codec, sample rate, and channel count.')
  }
  const rotation = video?.rotationDegrees === undefined
    ? undefined
    : normalizeRotation(video.rotationDegrees)
  return {
    id: assetId,
    name: metadata.displayName,
    kind: video ? 'video' : 'audio',
    mediaHandleId: metadata.handleId,
    durationUs,
    container: probe.container.formatNames.join(',').slice(0, 64) || 'unknown',
    ...(video ? {
      video: {
        codec: video.codecName!,
        width: video.width!,
        height: video.height!,
        frameRate: video.frameRate!,
        ...(rotation === undefined ? {} : { rotation })
      }
    } : {}),
    ...(audio ? {
      audio: {
        codec: audio.codecName!,
        sampleRate: audio.sampleRate!,
        channels: audio.channelCount!
      }
    } : {}),
    transcriptIds: []
  }
}

function initialItem(project: VideoProject, asset: MediaAsset): TimelineItem {
  const trackId = asset.video ? 'video-1' : 'audio-1'
  const end = project.items
    .filter((item) => item.trackId === trackId)
    .reduce((maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames), 0)
  return {
    id: `item-${asset.id}`,
    assetId: asset.id,
    trackId,
    timelineStartFrame: end,
    durationFrames: Math.max(1, microsecondsToFrames(asset.durationUs, project.fps)),
    sourceStartUs: 0,
    sourceEndUs: asset.durationUs,
    speed: { numerator: 1, denominator: 1 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0
  }
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((value % 360) + 360) % 360
  const candidates = [0, 90, 180, 270] as const
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(closest - normalized) ? candidate : closest
  )
}

function renderFileName(
  project: VideoProject,
  kind: RenderKind,
  subtitleFormat: 'srt' | 'vtt' = 'srt'
): string {
  const suffix = kind === 'proof-frame'
    ? 'proof.png'
    : kind === 'audio-aac'
      ? 'audio.m4a'
      : kind === 'subtitles'
        ? `captions.${subtitleFormat}`
        : 'video.mp4'
  return `${project.id}-revision-${project.currentRevision}-${suffix}`
}

function renderFilter(
  kind: RenderKind,
  subtitleFormat: 'srt' | 'vtt' = 'srt'
): { name: string; extensions: string[]; mimeTypes: string[] } {
  if (kind === 'proof-frame') return { name: 'PNG image', extensions: ['png'], mimeTypes: ['image/png'] }
  if (kind === 'audio-aac') return { name: 'AAC audio', extensions: ['m4a'], mimeTypes: ['audio/mp4'] }
  if (kind === 'subtitles') return subtitleFormat === 'srt'
    ? { name: 'SubRip captions', extensions: ['srt'], mimeTypes: ['application/x-subrip'] }
    : { name: 'WebVTT captions', extensions: ['vtt'], mimeTypes: ['text/vtt'] }
  return { name: 'H.264 video', extensions: ['mp4'], mimeTypes: ['video/mp4'] }
}

function jobReferenceProjection(
  job: { jobId: string; kind: string; state: string; cursor: string },
  purpose: string
): JsonObject {
  return { purpose, jobId: job.jobId, kind: job.kind, state: job.state, cursor: job.cursor }
}

function renderKey(jobId: string): string {
  return `${RENDER_RECORD_PREFIX}${jobId}`
}

function storedRenderRecord(value: JsonValue | undefined, jobId: string): RenderRecord | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as ToolInput
  if (
    record.schemaVersion !== 1 ||
    record.jobId !== jobId ||
    typeof record.projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(record.projectId) ||
    record.projectId === '.' ||
    record.projectId === '..' ||
    !Number.isSafeInteger(record.pinnedRevision) ||
    Number(record.pinnedRevision) < 0 ||
    !['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'].includes(String(record.renderKind)) ||
    !['none', 'burned', 'sidecar', 'both'].includes(String(record.captionMode)) ||
    (record.subtitleFormat !== 'srt' && record.subtitleFormat !== 'vtt') ||
    !['16:9', '9:16', '1:1'].includes(String(record.canvasPreset)) ||
    (record.proofFrame !== undefined &&
      (!Number.isSafeInteger(record.proofFrame) || Number(record.proofFrame) < 0)) ||
    (record.renderKind === 'proof-frame') !== (record.proofFrame !== undefined) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.expectedArtifacts) ||
    record.expectedArtifacts.length < 1 ||
    record.expectedArtifacts.length > 2
  ) {
    return undefined
  }
  const candidate = record as RenderRecord
  const expected = expectedArtifactsFromRenderRecordFields(candidate)
  if (
    !expected ||
    expected.length !== candidate.expectedArtifacts.length ||
    !expected.every((artifact, index) => {
      const actual = candidate.expectedArtifacts[index]
      return actual?.mediaKind === artifact.mediaKind && actual.mimeType === artifact.mimeType
    })
  ) {
    return undefined
  }
  return candidate
}

function recoverRenderRecord(snapshot: JobSnapshot): RenderRecord | undefined {
  if (snapshot.kind !== 'media.ffmpeg' || snapshot.initiatingOperation !== 'media.startFfmpegJob') {
    return undefined
  }
  const artifacts = snapshot.result?.generatedArtifacts ?? []
  if (artifacts.length === 0) return undefined
  const fields = renderRecordFieldsFromArtifact(artifacts[0]!, snapshot)
  if (!fields) return undefined
  for (const artifact of artifacts.slice(1)) {
    const candidate = renderRecordFieldsFromArtifact(artifact, snapshot)
    if (!candidate || !sameRenderRecordFields(fields, candidate)) return undefined
  }
  const expectedArtifacts = expectedArtifactsFromRenderRecordFields(fields)
  if (!expectedArtifacts) return undefined
  return {
    schemaVersion: 1,
    jobId: snapshot.id,
    ...fields,
    expectedArtifacts,
    createdAt: snapshot.createdAt
  }
}

function renderRecordFieldsFromArtifact(
  artifact: GeneratedArtifact,
  snapshot: JobSnapshot
): Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'> | undefined {
  if (
    artifact.ownerExtensionId !== snapshot.ownerExtensionId ||
    artifact.ownerExtensionVersion !== snapshot.ownerExtensionVersion ||
    artifact.workspaceId !== snapshot.workspaceId ||
    artifact.provenance.jobId !== snapshot.id ||
    artifact.provenance.operation !== snapshot.initiatingOperation ||
    !['image', 'video', 'audio', 'subtitle'].includes(artifact.mediaKind)
  ) return undefined
  const metadata = artifact.provenance.metadata
  if (!metadata) return undefined
  const projectId = metadata.projectId
  const pinnedRevision = metadata.pinnedRevision
  const renderKind = metadata.renderKind
  const captionMode = metadata.captionMode
  const subtitleFormat = metadata.subtitleFormat
  const canvasPreset = metadata.canvasPreset
  const proofFrame = metadata.proofFrame === null ? undefined : metadata.proofFrame
  if (
    typeof projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(projectId) ||
    !Number.isSafeInteger(pinnedRevision) || Number(pinnedRevision) < 0 ||
    !['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'].includes(String(renderKind)) ||
    !['none', 'burned', 'sidecar', 'both'].includes(String(captionMode)) ||
    (subtitleFormat !== 'srt' && subtitleFormat !== 'vtt') ||
    !['16:9', '9:16', '1:1'].includes(String(canvasPreset)) ||
    (proofFrame !== undefined && (!Number.isSafeInteger(proofFrame) || Number(proofFrame) < 0)) ||
    (renderKind === 'proof-frame') !== (proofFrame !== undefined)
  ) return undefined
  return {
    projectId,
    pinnedRevision: Number(pinnedRevision),
    renderKind: renderKind as RenderKind,
    captionMode: captionMode as RenderRecord['captionMode'],
    subtitleFormat,
    canvasPreset: canvasPreset as VideoProject['canvas']['preset'],
    ...(proofFrame !== undefined ? { proofFrame: Number(proofFrame) } : {})
  }
}

function sameRenderRecordFields(
  left: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>,
  right: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>
): boolean {
  return left.projectId === right.projectId &&
    left.pinnedRevision === right.pinnedRevision &&
    left.renderKind === right.renderKind &&
    left.captionMode === right.captionMode &&
    left.subtitleFormat === right.subtitleFormat &&
    left.canvasPreset === right.canvasPreset &&
    left.proofFrame === right.proofFrame
}

function expectedArtifactsFromRenderRecordFields(
  fields: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>
): RenderRecord['expectedArtifacts'] | undefined {
  if (fields.renderKind === 'proof-frame') {
    if (fields.captionMode !== 'none' && fields.captionMode !== 'burned') return undefined
    return [{ mediaKind: 'image', mimeType: 'image/png' }]
  }
  if (fields.renderKind === 'preview') {
    if (fields.captionMode !== 'none' && fields.captionMode !== 'burned') return undefined
    return [{ mediaKind: 'video', mimeType: 'video/mp4' }]
  }
  if (fields.renderKind === 'audio-aac') {
    if (fields.captionMode !== 'none') return undefined
    return [{ mediaKind: 'audio', mimeType: 'audio/mp4' }]
  }
  if (fields.renderKind === 'subtitles') {
    if (fields.captionMode !== 'none') return undefined
    return [{
      mediaKind: 'subtitle',
      mimeType: fields.subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
    }]
  }
  const expected: RenderRecord['expectedArtifacts'] = []
  if (fields.captionMode === 'sidecar' || fields.captionMode === 'both') {
    expected.push({
      mediaKind: 'subtitle',
      mimeType: fields.subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
    })
  }
  expected.push({ mediaKind: 'video', mimeType: 'video/mp4' })
  return expected
}

function sameRenderTrackingRecord(left: RenderRecord, right: RenderRecord): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.createdAt === right.createdAt &&
    sameRenderRecordFields(left, right) &&
    left.expectedArtifacts.length === right.expectedArtifacts.length &&
    left.expectedArtifacts.every((expected, index) => {
      const candidate = right.expectedArtifacts[index]
      return candidate?.mediaKind === expected.mediaKind && candidate.mimeType === expected.mimeType
    })
}

function isTerminalJobState(state: JobSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
}

function renderStatusSummary(snapshot: JobSnapshot, validated: boolean, stale: boolean): string {
  if (snapshot.state !== 'completed') return `Render job ${snapshot.id} is ${snapshot.state}.`
  if (!validated) return `Render job ${snapshot.id} completed but its output failed artifact validation.`
  return `Render job ${snapshot.id} completed with technical validation${stale ? '; its proof is stale for the current revision' : ''}. No visual inspection is implied.`
}

function interactionRequired(error: unknown, continuation: string): JsonObject | undefined {
  const code = extensionApiErrorCode(error)
  if (code === undefined) return undefined
  if (!['INTERACTION_REQUIRED', 'HOST_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'].includes(code)) {
    return undefined
  }
  return {
    outcome: 'interaction-required',
    code: 'MEDIA_INTERACTION_REQUIRED',
    message: 'This operation requires a protected Kun desktop picker.',
    continuation
  }
}

function extensionApiErrorCode(error: unknown): string | undefined {
  if (error instanceof ExtensionApiError) return error.code
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function assertExpectedRevision(project: VideoProject, expectedRevision: number): void {
  if (project.currentRevision !== expectedRevision) {
    throw new VideoEngineError('revision_conflict', 'Project revision has changed', {
      expectedRevision,
      currentRevision: project.currentRevision
    })
  }
}

function assertNotCancelled(invocation: ToolInvocationContext): void {
  if (invocation.cancellation.isCancellationRequested) {
    throw new ExtensionApiError({
      code: 'CANCELLED',
      message: 'The video tool invocation was cancelled.',
      operation: invocation.invocation.toolId,
      retryable: false
    })
  }
}

function asRecord(value: unknown, label: string): ToolInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError(`${label} input must be an object.`)
  }
  return value as ToolInput
}

function exactKeys(input: ToolInput, keys: readonly string[]): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(input).find((key) => !allowed.has(key))
  if (unexpected) throw new ToolInputError(`Unexpected input field: ${unexpected}`)
}

function stableId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new ToolInputError(`${label} must be a bounded stable identifier.`)
  }
  return value
}

function opaqueHandle(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new ToolInputError(`${label} must be an opaque Host-granted media handle.`)
  }
  return value
}

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new ToolInputError(`${label} must contain ${minimum}-${maximum} characters.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ToolInputError(`${label} must be a non-negative safe integer.`)
  }
  return Number(value)
}

function rational(value: unknown, label: string): { numerator: number; denominator: number } {
  const object = asRecord(value, label)
  exactKeys(object, ['numerator', 'denominator'])
  const numerator = nonNegativeInteger(object.numerator, `${label}.numerator`)
  const denominator = nonNegativeInteger(object.denominator, `${label}.denominator`)
  if (numerator === 0 || denominator === 0) throw new ToolInputError(`${label} values must be positive.`)
  return { numerator, denominator }
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ToolInputError(`${label} contains an unsupported value.`)
  }
  return value as T[number]
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ToolInputError(`${label} must contain ${minimum}-${maximum} entries.`)
  }
  return value
}

function assetRange(value: unknown): AssetTimeRange {
  const range = asRecord(value, 'range')
  exactKeys(range, ['assetId', 'startUs', 'endUs', 'reason'])
  const startUs = nonNegativeInteger(range.startUs, 'range.startUs')
  const endUs = nonNegativeInteger(range.endUs, 'range.endUs')
  if (endUs <= startUs) throw new ToolInputError('A transcript edit range must have positive duration.')
  return {
    assetId: stableId(range.assetId, 'range.assetId'),
    startUs,
    endUs,
    ...(range.reason === undefined
      ? {}
      : { reason: enumValue(range.reason, ['filler', 'silence', 'selection'] as const, 'range.reason') })
  }
}

function transcriptSegmentInput(value: unknown): JsonObject {
  const segment = asRecord(value, 'segment')
  exactKeys(segment, ['id', 'startUs', 'endUs', 'text', 'words'])
  const startUs = nonNegativeInteger(segment.startUs, 'segment.startUs')
  const endUs = nonNegativeInteger(segment.endUs, 'segment.endUs')
  if (endUs <= startUs) throw new ToolInputError('Transcript segments must have positive duration.')
  const words = segment.words === undefined
    ? undefined
    : boundedArray(segment.words, 'segment.words', 0, 20_000).map((value): JsonObject => {
        const word = asRecord(value, 'word')
        exactKeys(word, ['id', 'startUs', 'endUs', 'text', 'confidence'])
        const wordStart = nonNegativeInteger(word.startUs, 'word.startUs')
        const wordEnd = nonNegativeInteger(word.endUs, 'word.endUs')
        if (wordEnd <= wordStart) throw new ToolInputError('Transcript words must have positive duration.')
        return {
          id: stableId(word.id, 'word.id'),
          startUs: wordStart,
          endUs: wordEnd,
          text: boundedString(word.text, 'word.text', 1, 1024),
          ...(word.confidence === undefined
            ? {}
            : { confidence: boundedNumber(word.confidence, 'word.confidence', 0, 1) })
        }
      })
  return {
    id: stableId(segment.id, 'segment.id'),
    startUs,
    endUs,
    text: boundedString(segment.text, 'segment.text', 1, 16_384),
    ...(words === undefined ? {} : { words })
  }
}

function strictTimelineOperation(value: unknown): TimelineOperation {
  const operation = asRecord(value, 'operation')
  const type = boundedString(operation.type, 'operation.type', 1, 64)
  const keys: Record<string, readonly string[]> = {
    'add-item': ['type', 'item'],
    'split-item': ['type', 'itemId', 'atFrame'],
    'trim-item': ['type', 'itemId', 'startFrame', 'endFrame'],
    'delete-item': ['type', 'itemId'],
    'move-item': ['type', 'itemId', 'trackId', 'timelineStartFrame'],
    'reorder-item': ['type', 'itemId', 'beforeItemId'],
    'update-transform': ['type', 'itemId', 'transform', 'opacity'],
    'add-caption': ['type', 'caption'],
    'update-caption': ['type', 'captionId', 'patch'],
    'delete-caption': ['type', 'captionId'],
    'set-canvas': ['type', 'preset', 'fit']
  }
  const allowed = keys[type]
  if (!allowed) throw new ToolInputError(`Unsupported timeline operation: ${type}`)
  exactKeys(operation, allowed)
  if (type === 'add-item') strictTimelineItem(operation.item)
  if (type === 'add-caption') strictCaption(operation.caption, 'operation.caption')
  if (type === 'update-caption') strictCaptionPatch(operation.patch)
  if (type === 'update-transform') strictTransformPatch(operation.transform)
  return TimelineOperationSchema.parse(operation)
}

function strictTimelineItem(value: unknown): void {
  const item = asRecord(value, 'operation.item')
  exactKeys(item, [
    'id', 'assetId', 'trackId', 'timelineStartFrame', 'durationFrames', 'sourceStartUs',
    'sourceEndUs', 'speed', 'transform', 'opacity', 'fadeInFrames', 'fadeOutFrames'
  ])
  rational(item.speed, 'operation.item.speed')
  strictTransform(item.transform, 'operation.item.transform')
}

function strictTransform(value: unknown, label: string): void {
  const transform = asRecord(value, label)
  exactKeys(transform, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
}

function strictTransformPatch(value: unknown): void {
  const transform = asRecord(value, 'operation.transform')
  exactKeys(transform, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
}

function strictCaption(value: unknown, label: string): void {
  const caption = asRecord(value, label)
  exactKeys(caption, ['id', 'trackId', 'startFrame', 'endFrame', 'text', 'placement', 'style'])
  if (caption.style !== undefined) {
    exactKeys(asRecord(caption.style, `${label}.style`), ['fontSize', 'color', 'background'])
  }
}

function strictCaptionPatch(value: unknown): void {
  const patch = asRecord(value, 'operation.patch')
  exactKeys(patch, ['trackId', 'startFrame', 'endFrame', 'text', 'placement', 'style'])
  if (patch.style !== undefined) {
    exactKeys(asRecord(patch.style, 'operation.patch.style'), ['fontSize', 'color', 'background'])
  }
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return value
}

function publicEngineError(error: VideoEngineError, operation: string): ExtensionApiError {
  const conflict = error.code === 'revision_conflict' || error.code === 'script_stale'
  const safeDetails: JsonObject = { engineCode: error.code }
  for (const key of ['expectedRevision', 'currentRevision', 'scriptRevision'] as const) {
    const value = error.details[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) safeDetails[key] = value
  }
  return new ExtensionApiError({
    code: conflict ? 'CONFLICT' : error.code === 'project_not_found' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
    message: error.message,
    operation,
    retryable: conflict,
    details: safeDetails
  })
}

export class ToolInputError extends ExtensionApiError {

  constructor(message: string) {
    super({ code: 'INVALID_ARGUMENT', message, retryable: false })
    this.name = 'ToolInputError'
  }
}
