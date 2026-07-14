import {
  MediaStartFfmpegJobRequestSchema,
  type GeneratedArtifact,
  type JobReference,
  type MediaStartFfmpegJobRequest,
  type MediaProbeResult
} from '@kun/extension-api'
import type { JsonValue } from '../extensions/types.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionArtifactService,
  type CreateGeneratedArtifactInput
} from './extension-artifact-service.js'
import { ExtensionJobService, type ExtensionJobCoreExecutor } from './extension-job-service.js'
import type { ExtensionJobSnapshot } from './extension-job-types.js'
import {
  ExtensionMediaFfmpegService,
  type ExtensionFfmpegOutputTransaction,
  type ExtensionFfmpegProgress
} from './extension-media-ffmpeg-service.js'
import { ExtensionMediaProcessService } from './extension-media-process-service.js'

const MEDIA_FFMPEG_JOB_KIND = 'media.ffmpeg'
const REQUIRED_PERMISSIONS = [
  'jobs.manage',
  'media.read',
  'media.process',
  'media.export',
  'workspace.read',
  'workspace.write'
] as const

export class ExtensionMediaJobError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'workspace_denied'
      | 'invalid_checkpoint'
      | 'invalid_output',
    message: string
  ) {
    super(message)
  }
}

/** Bridges handle-confined FFmpeg execution into the durable core job state machine. */
export class ExtensionMediaJobService {
  private readonly unregisterExecutor: () => void
  private readonly pendingOutputs = new Map<string, ExtensionFfmpegOutputTransaction>()

  constructor(private readonly options: {
    jobs: ExtensionJobService
    ffmpeg: ExtensionMediaFfmpegService
    media: ExtensionMediaProcessService
    artifacts: ExtensionArtifactService
  }) {
    const executor: ExtensionJobCoreExecutor = {
      kind: MEDIA_FFMPEG_JOB_KIND,
      execute: async (snapshot, context) => {
        const request = parseCheckpoint(context.checkpoint?.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        let transaction: ExtensionFfmpegOutputTransaction | undefined
        let generatedArtifacts: GeneratedArtifact[] = []
        try {
          transaction = await this.options.ffmpeg.executeTransaction(principal, request, {
            operationId: snapshot.id,
            signal: context.signal,
            onProgress: (progress) => {
              void context.reportProgress(jobProgress(progress)).catch(() => undefined)
            }
          })
          const provenanceMetadata = safeProvenanceMetadata(request.metadata)
          const artifactInputs: CreateGeneratedArtifactInput[] = []
          for (const generated of transaction.generatedMedia) {
            // A successful ffmpeg exit is insufficient: require bounded metadata
            // while the prior user target and handle state remain reversible.
            const probe = await this.options.media.probe(principal, generated.id, { signal: context.signal })
            const validated = validateGeneratedOutput(generated, probe)
            artifactInputs.push({
              workspaceId: snapshot.workspaceId,
              mediaHandleId: generated.id,
              ...(validated.width !== undefined ? { width: validated.width } : {}),
              ...(validated.height !== undefined ? { height: validated.height } : {}),
              ...(validated.durationMicros !== undefined
                ? { durationMicros: validated.durationMicros }
                : {}),
              provenance: {
                jobId: snapshot.id,
                operation: snapshot.initiatingOperation,
                ...(provenanceMetadata ? { metadata: provenanceMetadata } : {})
              }
            })
          }
          context.signal.throwIfAborted()
          generatedArtifacts = await this.options.artifacts.createMany(principal, artifactInputs)
          if (this.pendingOutputs.has(snapshot.id)) {
            throw new ExtensionMediaJobError(
              'invalid_output',
              'Media output transaction is already pending for this job'
            )
          }
          this.pendingOutputs.set(snapshot.id, transaction)
          return {
            schemaVersion: 1,
            data: {
              outputs: transaction.generatedMedia.map((media) => ({
                mediaHandleId: media.id,
                displayName: media.displayName,
                mimeType: media.mimeType
              }))
            } as JsonValue,
            generatedArtifacts
          }
        } catch (error) {
          const cleanupErrors: unknown[] = []
          if (generatedArtifacts.length > 0) {
            try {
              await this.options.artifacts.discardUncommittedJobArtifacts(
                principal,
                snapshot.id,
                generatedArtifacts
              )
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          }
          if (transaction !== undefined) {
            try {
              await transaction.rollback()
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          }
          if (cleanupErrors.length > 0) {
            throw new ExtensionMediaJobError(
              'invalid_output',
              'Media output validation failed and cleanup did not finish safely'
            )
          }
          throw error
        }
      },
      commitResult: async (snapshot) => {
        const transaction = this.pendingOutputs.get(snapshot.id)
        if (transaction === undefined) return
        await transaction.commit()
        this.pendingOutputs.delete(snapshot.id)
      },
      discardResult: async (snapshot, result, context) => {
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        const transaction = this.pendingOutputs.get(snapshot.id)
        const cleanupErrors: unknown[] = []
        try {
          await this.options.artifacts.discardUncommittedJobArtifacts(
            principal,
            snapshot.id,
            result.generatedArtifacts
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (transaction !== undefined) {
          try {
            await transaction.rollback()
          } catch (error) {
            cleanupErrors.push(error)
          } finally {
            this.pendingOutputs.delete(snapshot.id)
          }
        }
        if (cleanupErrors.length > 0) {
          throw new ExtensionMediaJobError(
            'invalid_output',
            'Media output transaction could not be discarded safely'
          )
        }
      },
      cancel: async (snapshot, context) => {
        // Active attempts are aborted and awaited by ExtensionJobService. A
        // checkpoint here means the process belonged to a previous runtime, so
        // this hook must reconcile its deterministic output transaction.
        if (context.checkpoint === undefined) return
        const request = parseCheckpoint(context.checkpoint.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        await this.options.ffmpeg.rollbackInterruptedTransaction(
          principal,
          request,
          snapshot.id
        )
      },
      recover: async (snapshot, checkpoint, context) => {
        const request = parseCheckpoint(checkpoint?.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        await this.options.ffmpeg.rollbackInterruptedTransaction(
          principal,
          request,
          snapshot.id
        )
        return 'interrupt' as const
      },
      recoverTerminal: async (snapshot, checkpoint, context) => {
        const request = parseCheckpoint(checkpoint?.data)
        const principal = executionPrincipal(snapshot, context.workspaceRoot)
        if (snapshot.state === 'completed') {
          await this.options.ffmpeg.commitRecoveredTransaction(
            principal,
            request,
            snapshot.id
          )
          return
        }
        const cleanupErrors: unknown[] = []
        try {
          await this.options.ffmpeg.rollbackInterruptedTransaction(
            principal,
            request,
            snapshot.id
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        try {
          await this.options.artifacts.discardUncommittedJobArtifactsByJob(
            principal,
            snapshot.id
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (cleanupErrors.length > 0) {
          throw new ExtensionMediaJobError(
            'invalid_output',
            'Recovered terminal media cleanup did not finish safely'
          )
        }
      }
    }
    this.unregisterExecutor = options.jobs.registerCoreExecutor(executor)
  }

  async start(
    principal: ExtensionPrincipal,
    request: MediaStartFfmpegJobRequest
  ): Promise<JobReference> {
    assertAuthorized(principal)
    const input = MediaStartFfmpegJobRequestSchema.parse(request)
    if (principal.workspaceRoots.length !== 1) {
      throw new ExtensionMediaJobError(
        'workspace_denied',
        'Media jobs require exactly one active workspace scope'
      )
    }
    const workspaceRoot = principal.workspaceRoots[0]!
    const created = await this.options.jobs.createAndDispatch({
      owner: {
        extensionId: principal.extensionId,
        extensionVersion: principal.extensionVersion,
        workspaceId: extensionWorkspaceKey(workspaceRoot)
      },
      workspaceRoot,
      kind: MEDIA_FFMPEG_JOB_KIND,
      kindSchemaVersion: 1,
      initiatingOperation: 'media.startFfmpegJob',
      permissionsSnapshot: [...principal.permissions],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      checkpoint: { schemaVersion: 1, data: input as JsonValue }
    })
    return reference(created.snapshot)
  }

  dispose(): void {
    this.unregisterExecutor()
    for (const transaction of this.pendingOutputs.values()) {
      void transaction.rollback().catch(() => undefined)
    }
    this.pendingOutputs.clear()
  }
}

function parseCheckpoint(value: JsonValue | undefined): MediaStartFfmpegJobRequest {
  const parsed = MediaStartFfmpegJobRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ExtensionMediaJobError('invalid_checkpoint', 'Media job checkpoint is invalid')
  }
  return parsed.data
}

function validateGeneratedOutput(
  generated: {
    id: string
    mimeType: string
    byteSize?: number
    completionIdentity?: string
  },
  probe: MediaProbeResult
): { width?: number; height?: number; durationMicros?: number } {
  if (probe.handleId !== generated.id || !Number.isSafeInteger(generated.byteSize) ||
    Number(generated.byteSize) <= 0 || !generated.completionIdentity) {
    throw invalidOutput('Generated media identity is incomplete')
  }
  const durationMicros = positiveDurationMicros(probe)
  if (generated.mimeType.startsWith('video/')) {
    const video = probe.streams.find((stream) => stream.kind === 'video')
    if (!video || durationMicros === undefined) {
      throw invalidOutput('Generated video is missing a video stream or positive duration')
    }
    return {
      ...(video.width !== undefined ? { width: video.width } : {}),
      ...(video.height !== undefined ? { height: video.height } : {}),
      durationMicros
    }
  }
  if (generated.mimeType.startsWith('audio/')) {
    if (!probe.streams.some((stream) => stream.kind === 'audio') || durationMicros === undefined) {
      throw invalidOutput('Generated audio is missing an audio stream or positive duration')
    }
    return { durationMicros }
  }
  if (generated.mimeType.startsWith('image/')) {
    const image = probe.streams.find((stream) =>
      stream.kind === 'video' && stream.width !== undefined && stream.height !== undefined)
    if (!image) throw invalidOutput('Generated image is missing a bounded image stream')
    return { width: image.width, height: image.height }
  }
  if (generated.mimeType === 'application/x-subrip' || generated.mimeType === 'text/vtt') {
    const expectedFormat = generated.mimeType === 'application/x-subrip' ? 'srt' : 'webvtt'
    if (!probe.container.formatNames.includes(expectedFormat) ||
      !probe.streams.some((stream) => stream.kind === 'subtitle')) {
      throw invalidOutput('Generated subtitle is missing its expected subtitle stream')
    }
    // ffprobe commonly omits duration for standalone SRT/WebVTT. The Host has
    // already enforced a non-empty, bounded file and an actual subtitle stream.
    return durationMicros === undefined ? {} : { durationMicros }
  }
  throw invalidOutput('Generated output MIME type is not supported for artifact publication')
}

function positiveDurationMicros(probe: MediaProbeResult): number | undefined {
  const values = [
    probe.container.durationMicros,
    ...probe.streams.map((stream) => stream.durationMicros)
  ].filter((value): value is number => value !== undefined && value > 0)
  return values.length === 0 ? undefined : Math.max(...values)
}

function safeProvenanceMetadata(
  value: MediaStartFfmpegJobRequest['metadata']
): GeneratedArtifact['provenance']['metadata'] | undefined {
  if (!value) return undefined
  const metadata: Record<string, string | number> = {}
  if (typeof value.projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.projectId)) {
    metadata.projectId = value.projectId
  }
  if (Number.isSafeInteger(value.pinnedRevision) && Number(value.pinnedRevision) >= 0) {
    metadata.pinnedRevision = Number(value.pinnedRevision)
  }
  if (value.renderKind === 'proof-frame' || value.renderKind === 'preview' ||
    value.renderKind === 'h264-mp4' || value.renderKind === 'audio-aac' ||
    value.renderKind === 'subtitles') {
    metadata.renderKind = value.renderKind
  }
  if (value.canvasPreset === '16:9' || value.canvasPreset === '9:16' ||
    value.canvasPreset === '1:1') {
    metadata.canvasPreset = value.canvasPreset
  }
  if (Number.isSafeInteger(value.proofFrame) && Number(value.proofFrame) >= 0) {
    metadata.proofFrame = Number(value.proofFrame)
  }
  if (value.captionMode === 'none' || value.captionMode === 'burned' ||
    value.captionMode === 'sidecar' || value.captionMode === 'both') {
    metadata.captionMode = value.captionMode
  }
  if (value.subtitleFormat === 'srt' || value.subtitleFormat === 'vtt') {
    metadata.subtitleFormat = value.subtitleFormat
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function invalidOutput(message: string): ExtensionMediaJobError {
  return new ExtensionMediaJobError('invalid_output', message)
}

function executionPrincipal(
  snapshot: ExtensionJobSnapshot,
  workspaceRoot: string
): ExtensionPrincipal {
  return {
    extensionId: snapshot.ownerExtensionId,
    extensionVersion: snapshot.ownerExtensionVersion,
    permissions: [...REQUIRED_PERMISSIONS],
    workspaceRoots: [workspaceRoot],
    workspaceTrusted: true
  }
}

function assertAuthorized(principal: ExtensionPrincipal): void {
  if (!principal.workspaceTrusted) {
    throw new ExtensionMediaJobError('workspace_denied', 'Workspace is not trusted')
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!principal.permissions.includes(permission)) {
      throw new ExtensionMediaJobError('permission_denied', `Missing permission: ${permission}`)
    }
  }
}

function jobProgress(progress: ExtensionFfmpegProgress) {
  return {
    phase: progress.terminal ? 'finalizing' : 'encoding',
    ...(progress.outputBytes !== undefined ? {
      completed: progress.outputBytes,
      unit: 'bytes'
    } : {}),
    message: progress.terminal ? 'Validating generated media' : 'Encoding media'
  }
}

function reference(snapshot: ExtensionJobSnapshot): JobReference {
  return {
    jobId: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    cursor: snapshot.latestCursor
  }
}
