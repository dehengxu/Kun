import type { ExtensionToolDeclarationInput, JsonObject } from '@kun/extension-api'

export const VIDEO_TOOL_IDS = [
  'video-project',
  'video-probe',
  'video-transcribe',
  'video-read-script',
  'video-apply-script',
  'video-update-timeline',
  'video-render',
  'video-render-status',
  'video-render-cancel'
] as const

export type VideoToolId = (typeof VIDEO_TOOL_IDS)[number]

const stableId = {
  type: 'string', minLength: 1, maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'
} satisfies JsonObject
const opaqueHandle = {
  type: 'string', minLength: 16, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$'
} satisfies JsonObject
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } satisfies JsonObject
const boundedOutput = {
  type: 'object',
  properties: { outcome: { type: 'string', minLength: 1, maxLength: 64 } },
  required: ['outcome'],
  additionalProperties: true
} satisfies JsonObject

export const VIDEO_TOOL_DECLARATIONS = [
  {
    id: 'video-project',
    description: 'Resolve the active project, list projects, purely read one project, or explicitly create/select the authoritative workspace project. Read the current revision before any edit.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['active', 'list', 'get', 'create', 'select'] },
        projectId: stableId,
        name: { type: 'string', minLength: 1, maxLength: 160 },
        fps: { type: 'object' },
        canvasPreset: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        expectedRevision: revision
      },
      required: ['action'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'write',
    idempotent: false,
    maxOutputBytes: 262_144
  },
  {
    id: 'video-probe',
    description: 'Import or probe one Host-granted media handle, persist normalized asset metadata, and optionally request thumbnail or waveform jobs. Never accepts paths.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: stableId,
        expectedRevision: revision,
        mediaHandleId: opaqueHandle,
        assetId: stableId,
        addToTimeline: { type: 'boolean' },
        thumbnailOutputHandleId: opaqueHandle,
        waveformOutputHandleId: opaqueHandle
      },
      required: ['projectId', 'expectedRevision'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'write',
    idempotent: false,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-transcribe',
    description: 'Import a bounded timed transcript into an asset, or report local-ASR capability as unavailable without inventing text or uploading media.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: stableId,
        expectedRevision: revision,
        assetId: stableId,
        transcriptId: stableId,
        mode: { type: 'string', enum: ['import', 'local-asr'] },
        format: { type: 'string', enum: ['srt', 'vtt', 'json'] },
        language: { type: 'string', minLength: 1, maxLength: 32 },
        source: { type: 'string', minLength: 1, maxLength: 524_288 },
        segments: { type: 'array', minItems: 1, maxItems: 20_000, items: { type: 'object' } }
      },
      required: ['projectId', 'expectedRevision', 'assetId', 'transcriptId', 'mode'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'write',
    idempotent: false,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-read-script',
    description: 'Read the deterministic revision-bound timeline.md projection for transcript-first review.',
    inputSchema: {
      type: 'object',
      properties: { projectId: stableId, expectedRevision: revision },
      required: ['projectId'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'read',
    idempotent: true,
    maxOutputBytes: 262_144
  },
  {
    id: 'video-apply-script',
    description: 'Apply explicit timed source ranges from an unchanged revision-bound timeline.md projection as one transactional Agent edit.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: stableId,
        expectedRevision: revision,
        timelineMarkdown: { type: 'string', minLength: 1, maxLength: 262_144 },
        ranges: { type: 'array', minItems: 1, maxItems: 2_000, items: { type: 'object' } },
        summary: { type: 'string', minLength: 1, maxLength: 512 }
      },
      required: ['projectId', 'expectedRevision', 'timelineMarkdown', 'ranges'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'destructive',
    idempotent: false,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-update-timeline',
    description: 'Apply bounded typed timeline, caption, transform, track-placement, or canvas operations at an expected revision.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: stableId,
        expectedRevision: revision,
        operations: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object' } },
        summary: { type: 'string', minLength: 1, maxLength: 512 }
      },
      required: ['projectId', 'expectedRevision', 'operations'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'write',
    idempotent: false,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-render',
    description: 'Start a durable brokered proof, preview, audio, or H.264 export job, optionally with burned and SRT/VTT sidecar captions, pinned to a project revision and opaque output grants.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: stableId,
        expectedRevision: revision,
        kind: { type: 'string', enum: ['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'] },
        outputHandleId: opaqueHandle,
        proofFrame: revision,
        captionMode: { type: 'string', enum: ['none', 'burned', 'sidecar', 'both'] },
        subtitleOutputHandleId: opaqueHandle,
        subtitleFormat: { type: 'string', enum: ['srt', 'vtt'] },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 }
      },
      required: ['projectId', 'expectedRevision', 'kind'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'write',
    idempotent: false,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-render-status',
    description: 'Read one owned durable render job without side effects and return only project-matched, technically validated generated artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', minLength: 8, maxLength: 512 },
        projectId: stableId
      },
      required: ['jobId'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'read',
    idempotent: true,
    maxOutputBytes: 131_072
  },
  {
    id: 'video-render-cancel',
    description: 'Cancel one owned, tracked durable video render after verifying its optional project identity.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', minLength: 8, maxLength: 512 },
        projectId: stableId,
        reason: { type: 'string', minLength: 1, maxLength: 512 }
      },
      required: ['jobId'],
      additionalProperties: false
    },
    outputSchema: boundedOutput,
    sideEffects: 'destructive',
    idempotent: false,
    maxOutputBytes: 131_072
  }
] as const satisfies readonly ExtensionToolDeclarationInput[]

export function videoToolDeclaration(id: VideoToolId): ExtensionToolDeclarationInput {
  const declaration = VIDEO_TOOL_DECLARATIONS.find((candidate) => candidate.id === id)
  if (!declaration) throw new Error(`Unknown video tool declaration: ${id}`)
  return declaration
}
