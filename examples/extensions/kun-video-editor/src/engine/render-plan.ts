import { engineError } from './errors.js'
import type { MediaAsset, TimelineItem, VideoProject } from './schema.js'
import { generateSubtitles, type SubtitleFormat } from './subtitles.js'
import {
  frameToSecondsArgument,
  framesToMicroseconds,
  microsecondsToSecondsArgument
} from './time.js'
import { assertValidTimeline, projectDurationFrames } from './timeline.js'

export type RenderKind = 'proof-frame' | 'preview' | 'h264-mp4' | 'audio-aac' | 'subtitles'
export type CaptionMode = 'none' | 'burned' | 'sidecar' | 'both'

export type RenderRequest = {
  kind: RenderKind
  expectedRevision: number
  outputHandleId: string
  proofFrame?: number
  captionMode?: CaptionMode
  subtitleFormat?: SubtitleFormat
  subtitleOutputHandleId?: string
}

export type RenderInputReference = {
  kind: 'media-handle' | 'workspace-file' | 'generated-text'
  reference: string
}

export type FfmpegRenderStep = {
  kind: 'ffmpeg'
  id: string
  inputs: Record<string, RenderInputReference>
  outputs: Record<string, string>
  args: string[]
}

export type TextRenderStep = {
  kind: 'write-text'
  id: string
  output: string
  mime: 'application/x-subrip' | 'text/vtt'
  content: string
}

export type RenderStep = FfmpegRenderStep | TextRenderStep

export type PlannedArtifact = {
  output: string
  name: string
  mime: string
  kind: 'image' | 'video' | 'audio' | 'subtitle'
}

export type RenderPlan = {
  schemaVersion: 1
  projectId: string
  revision: number
  renderKind: RenderKind
  canvas: VideoProject['canvas']
  fps: VideoProject['fps']
  durationFrames: number
  steps: RenderStep[]
  artifacts: PlannedArtifact[]
}

export function generateRenderPlan(project: VideoProject, request: RenderRequest): RenderPlan {
  assertValidTimeline(project)
  if (request.expectedRevision !== project.currentRevision) {
    throw engineError('revision_conflict', 'Render request is based on a stale project revision', {
      expectedRevision: request.expectedRevision,
      currentRevision: project.currentRevision
    })
  }
  validateOpaqueReference(request.outputHandleId, 'outputHandleId')
  const durationFrames = projectDurationFrames(project)
  const plan: RenderPlan = {
    schemaVersion: 1,
    projectId: project.id,
    revision: project.currentRevision,
    renderKind: request.kind,
    canvas: structuredClone(project.canvas),
    fps: structuredClone(project.fps),
    durationFrames,
    steps: [],
    artifacts: []
  }

  if (request.kind === 'subtitles') {
    const format = request.subtitleFormat ?? 'srt'
    plan.steps.push(subtitleStep(project, request.outputHandleId, format, 'subtitles'))
    plan.artifacts.push(subtitleArtifact(request.outputHandleId, format))
    return plan
  }

  if (durationFrames <= 0) {
    throw engineError('render_unsupported', 'A media render requires at least one timeline item')
  }
  const captionMode = request.captionMode ?? 'none'
  const sidecarRequested = captionMode === 'sidecar' || captionMode === 'both'
  const burnedRequested = captionMode === 'burned' || captionMode === 'both'
  const subtitleFormat = request.subtitleFormat ?? 'srt'
  if (sidecarRequested && request.kind !== 'h264-mp4') {
    throw engineError('render_unsupported', 'Sidecar captions are supported only for the final H.264 export')
  }
  if (burnedRequested && request.kind === 'audio-aac') {
    throw engineError('render_unsupported', 'Burned captions require a video render')
  }
  if (burnedRequested) {
    if (project.captions.length === 0) {
      throw engineError('render_unsupported', 'Burned captions were requested but the project has no captions')
    }
  }
  if (sidecarRequested) {
    if (project.captions.length === 0) {
      throw engineError('render_unsupported', 'Sidecar captions were requested but the project has no captions')
    }
    if (!request.subtitleOutputHandleId) {
      throw engineError('render_unsupported', 'Sidecar captions require an output handle')
    }
    validateOpaqueReference(request.subtitleOutputHandleId, 'subtitleOutputHandleId')
    plan.steps.push(subtitleStep(project, request.subtitleOutputHandleId, subtitleFormat, 'sidecar-captions'))
    plan.artifacts.push(subtitleArtifact(request.subtitleOutputHandleId, subtitleFormat))
  }

  if (request.kind === 'proof-frame') {
    plan.steps.push(proofFrameStep(project, request, burnedRequested))
    plan.artifacts.push({
      output: request.outputHandleId,
      name: `${project.id}-revision-${project.currentRevision}-proof.png`,
      mime: 'image/png',
      kind: 'image'
    })
    return plan
  }

  if (request.kind === 'audio-aac') {
    plan.steps.push(audioStep(project, request.outputHandleId))
    plan.artifacts.push({
      output: request.outputHandleId,
      name: `${project.id}-revision-${project.currentRevision}.m4a`,
      mime: 'audio/mp4',
      kind: 'audio'
    })
    return plan
  }

  plan.steps.push(videoStep(project, request.outputHandleId, request.kind, burnedRequested))
  plan.artifacts.push({
    output: request.outputHandleId,
    name: request.kind === 'preview'
      ? `${project.id}-revision-${project.currentRevision}-preview.mp4`
      : `${project.id}-revision-${project.currentRevision}.mp4`,
    mime: 'video/mp4',
    kind: 'video'
  })
  return plan
}

function proofFrameStep(
  project: VideoProject,
  request: RenderRequest,
  burnedCaptions: boolean
): FfmpegRenderStep {
  const frame = request.proofFrame ?? 0
  const duration = projectDurationFrames(project)
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= duration) {
    throw engineError('render_unsupported', 'Proof frame must be inside the composed timeline')
  }
  const prepared = prepareCompositionInputs(project, false)
  if (prepared.items.length === 0) {
    throw engineError('render_unsupported', 'Proof output requires a probed video stream')
  }
  const composition = compositionGraph(project, prepared.items, burnedCaptions, false)
  const proofOutput = 'proof-frame-output'
  const graph = `${composition.graph};${composition.videoOutput}` +
    `trim=start_frame=${frame}:end_frame=${frame + 1},setpts=PTS-STARTPTS[${proofOutput}]`
  assertBoundedFilterGraph(graph)
  return {
    kind: 'ffmpeg',
    id: 'proof-frame',
    inputs: prepared.inputs,
    outputs: { proof: request.outputHandleId },
    args: [
      ...prepared.args,
      '-filter_complex', graph,
      '-map', `[${proofOutput}]`,
      '-frames:v', '1',
      '-f', 'image2',
      placeholder('output', 'proof')
    ]
  }
}

function videoStep(
  project: VideoProject,
  outputHandleId: string,
  kind: 'preview' | 'h264-mp4',
  burnedCaptions: boolean
): FfmpegRenderStep {
  const prepared = prepareCompositionInputs(project, true)
  if (!prepared.items.some(({ asset }) => asset.video !== undefined)) {
    throw engineError('render_unsupported', 'Video output requires a probed video stream')
  }
  const { graph, videoOutput, audioOutput } = compositionGraph(
    project,
    prepared.items,
    burnedCaptions,
    true
  )
  prepared.args.push('-filter_complex', graph, '-map', videoOutput)
  if (audioOutput) prepared.args.push('-map', audioOutput)
  else prepared.args.push('-an')
  prepared.args.push(
    '-c:v', 'libx264',
    '-preset', kind === 'preview' ? 'veryfast' : 'medium',
    '-crf', kind === 'preview' ? '28' : '20',
    '-pix_fmt', 'yuv420p'
  )
  if (audioOutput) prepared.args.push('-c:a', 'aac', '-b:a', kind === 'preview' ? '128k' : '192k')
  prepared.args.push('-movflags', '+faststart', '-f', 'mp4', placeholder('output', 'video'))
  return {
    kind: 'ffmpeg',
    id: kind,
    inputs: prepared.inputs,
    outputs: { video: outputHandleId },
    args: prepared.args
  }
}

function prepareCompositionInputs(
  project: VideoProject,
  includeAudioOnlyItems: boolean
): {
    inputs: Record<string, RenderInputReference>
    args: string[]
    items: Array<{ item: TimelineItem; asset: MediaAsset; inputIndex: number }>
  } {
  const inputs: Record<string, RenderInputReference> = {}
  const args = ['-nostdin']
  const items: Array<{ item: TimelineItem; asset: MediaAsset; inputIndex: number }> = []
  for (const item of [...project.items].sort(compositionItemComparator(project))) {
    const asset = assetForItem(project, item)
    if (!includeAudioOnlyItems && !asset.video) continue
    // Media placeholders are part of the public broker request and therefore
    // have their own bounded identifier budget. Timeline ids grow after
    // repeated transcript cuts (`-part-N`), so never derive a binding key from
    // the user/project-controlled id.
    const inputName = `clip-${items.length}`
    inputs[inputName] = assetReference(asset)
    args.push(
      '-ss', microsecondsToSecondsArgument(item.sourceStartUs),
      '-t', microsecondsToSecondsArgument(item.sourceEndUs - item.sourceStartUs),
      '-i', placeholder('input', inputName)
    )
    items.push({ item, asset, inputIndex: items.length })
  }
  return { inputs, args, items }
}

function audioStep(project: VideoProject, outputHandleId: string): FfmpegRenderStep {
  const inputs: Record<string, RenderInputReference> = {}
  const args = ['-nostdin']
  const audioFilters: string[] = []
  let inputIndex = 0
  for (const item of [...project.items].sort(compositionItemComparator(project))) {
    const asset = assetForItem(project, item)
    if (!asset.audio) continue
    const name = `clip-${inputIndex}`
    inputs[name] = assetReference(asset)
    args.push(
      '-ss', microsecondsToSecondsArgument(item.sourceStartUs),
      '-t', microsecondsToSecondsArgument(item.sourceEndUs - item.sourceStartUs),
      '-i', placeholder('input', name)
    )
    const delay = Math.floor(framesToMicroseconds(item.timelineStartFrame, project.fps) / 1000)
    audioFilters.push(
      `[${inputIndex}:a]asetpts=PTS-STARTPTS,adelay=${delay}:all=1,volume=${item.opacity.toFixed(4)}[a${inputIndex}]`
    )
    inputIndex += 1
  }
  if (audioFilters.length === 0) {
    throw engineError('render_unsupported', 'Audio output requires a probed audio stream')
  }
  const labels = audioFilters.map((_filter, index) => `[a${index}]`).join('')
  const graph = `${audioFilters.join(';')};${labels}amix=inputs=${audioFilters.length}:normalize=0[aout]`
  args.push(
    '-filter_complex', graph,
    '-map', '[aout]',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-f', 'mp4',
    placeholder('output', 'audio')
  )
  return {
    kind: 'ffmpeg',
    id: 'audio-aac',
    inputs,
    outputs: { audio: outputHandleId },
    args
  }
}

function compositionGraph(
  project: VideoProject,
  items: Array<{ item: TimelineItem; asset: MediaAsset; inputIndex: number }>,
  burnedCaptions: boolean,
  includeAudio: boolean
): { graph: string; videoOutput: string; audioOutput?: string } {
  if (canUseSequentialConcat(items, burnedCaptions, includeAudio)) {
    return sequentialCompositionGraph(project, items, includeAudio)
  }

  // The color source duration option accepts a decimal duration, but FFmpeg 8
  // no longer accepts the rational frame expression used by timeline filters.
  const duration = microsecondsToSecondsArgument(
    framesToMicroseconds(projectDurationFrames(project), project.fps)
  )
  const filters = [
    `color=c=${project.canvas.background}:s=${project.canvas.width}x${project.canvas.height}:r=${project.fps.numerator}/${project.fps.denominator}:d=${duration}[base]`
  ]
  let videoLabel = 'base'
  const audioLabels: string[] = []
  for (const { item, asset, inputIndex } of items) {
    const start = frameToSecondsArgument(item.timelineStartFrame, project.fps)
    const end = frameToSecondsArgument(item.timelineStartFrame + item.durationFrames, project.fps)
    if (asset.video) {
      const prepared = `vprep${inputIndex}`
      const next = `vcomp${inputIndex}`
      filters.push(
        `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${item.speed.numerator}*${item.speed.denominator},${geometryFilter(project, item)},format=rgba,colorchannelmixer=aa=${item.opacity.toFixed(4)},setpts=PTS+${start}/TB[${prepared}]`
      )
      const x = `(W-w)/2+${item.transform.x.toFixed(3)}`
      const y = `(H-h)/2+${item.transform.y.toFixed(3)}`
      filters.push(
        `[${videoLabel}][${prepared}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${start},${end})'[${next}]`
      )
      videoLabel = next
    }
    if (includeAudio && asset.audio) {
      const delay = Math.floor(framesToMicroseconds(item.timelineStartFrame, project.fps) / 1000)
      const audioLabel = `a${inputIndex}`
      filters.push(
        `[${inputIndex}:a]asetpts=(PTS-STARTPTS)/${item.speed.numerator}*${item.speed.denominator},adelay=${delay}:all=1,volume=${item.opacity.toFixed(4)}[${audioLabel}]`
      )
      audioLabels.push(audioLabel)
    }
  }
  if (burnedCaptions) {
    for (const [index, caption] of [...project.captions]
      .sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
      .entries()) {
      const next = `captioned${index}`
      const fontSize = caption.style?.fontSize === undefined
        ? Math.max(18, Math.min(96, Math.round(project.canvas.height / 24)))
        : Math.round(caption.style.fontSize)
      const fontColor = safeCaptionColor(caption.style?.color, 'FFFFFF')
      const boxColor = safeCaptionColor(caption.style?.background, '000000')
      const y = caption.placement === 'top'
        ? 'h/12'
        : caption.placement === 'center'
          ? '(h-text_h)/2'
          : 'h-text_h-h/12'
      const start = frameToSecondsArgument(caption.startFrame, project.fps)
      const end = frameToSecondsArgument(caption.endFrame, project.fps)
      filters.push(
        `[${videoLabel}]drawtext=text=${escapeDrawtextText(caption.text)}` +
        `:expansion=none:fontcolor=0x${fontColor}:fontsize=${fontSize}` +
        `:box=1:boxcolor=0x${boxColor}@0.65:boxborderw=12` +
        `:x=(w-text_w)/2:y=${y}:enable='between(t,${start},${end})'[${next}]`
      )
      videoLabel = next
    }
  }
  let audioOutput: string | undefined
  if (audioLabels.length > 0) {
    filters.push(`${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0[aout]`)
    audioOutput = '[aout]'
  }
  const graph = filters.join(';')
  assertBoundedFilterGraph(graph)
  return { graph, videoOutput: `[${videoLabel}]`, audioOutput }
}

/**
 * Ordinary transcript edits produce many adjacent cuts on one track. Building
 * those as overlays repeats the base canvas and timing expression for every
 * clip and crosses the public 8 KiB per-argument limit at roughly 25 cuts.
 * A concat graph is both semantically simpler and substantially smaller.
 */
function sequentialCompositionGraph(
  project: VideoProject,
  items: Array<{ item: TimelineItem; asset: MediaAsset; inputIndex: number }>,
  includeAudio: boolean
): { graph: string; videoOutput: string; audioOutput?: string } {
  const hasAudio = includeAudio && items.every(({ asset }) => asset.audio !== undefined)
  const filters: string[] = []
  const concatInputs: string[] = []

  for (const { item, inputIndex } of items) {
    const videoLabel = `v${inputIndex}`
    filters.push(
      `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${item.speed.numerator}*${item.speed.denominator},` +
      `${sequentialGeometryFilter(project)},settb=AVTB[${videoLabel}]`
    )
    concatInputs.push(`[${videoLabel}]`)
    if (hasAudio) {
      const audioLabel = `a${inputIndex}`
      filters.push(
        `[${inputIndex}:a]asetpts=(PTS-STARTPTS)/${item.speed.numerator}*${item.speed.denominator},` +
        `aresample=async=1:first_pts=0[${audioLabel}]`
      )
      concatInputs.push(`[${audioLabel}]`)
    }
  }

  filters.push(
    `${concatInputs.join('')}concat=n=${items.length}:v=1:a=${hasAudio ? 1 : 0}` +
    (hasAudio ? '[vout][aout]' : '[vout]')
  )
  const graph = filters.join(';')
  assertBoundedFilterGraph(graph)
  return {
    graph,
    videoOutput: '[vout]',
    ...(hasAudio ? { audioOutput: '[aout]' } : {})
  }
}

function canUseSequentialConcat(
  items: Array<{ item: TimelineItem; asset: MediaAsset; inputIndex: number }>,
  burnedCaptions: boolean,
  includeAudio: boolean
): boolean {
  if (burnedCaptions || items.length === 0) return false
  const firstTrackId = items[0]!.item.trackId
  const audioPresence = items[0]!.asset.audio !== undefined
  let cursor = 0
  for (const { item, asset } of items) {
    if (
      !asset.video ||
      item.trackId !== firstTrackId ||
      item.timelineStartFrame !== cursor ||
      item.transform.x !== 0 ||
      item.transform.y !== 0 ||
      item.transform.scaleX !== 1 ||
      item.transform.scaleY !== 1 ||
      item.transform.rotation !== 0 ||
      item.opacity !== 1 ||
      item.fadeInFrames !== 0 ||
      item.fadeOutFrames !== 0 ||
      (includeAudio && (asset.audio !== undefined) !== audioPresence)
    ) {
      return false
    }
    cursor += item.durationFrames
  }
  return true
}

function assertBoundedFilterGraph(graph: string): void {
  if (graph.length <= 8_000) return
  throw engineError(
    'render_unsupported',
    'The composed filter graph exceeds the bounded FFmpeg request size; shorten captions or timeline complexity'
  )
}

export function escapeDrawtextText(value: string): string {
  const normalized = value
    .replace(/\r\n?/gu, '\n')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || (code >= 32 && code !== 127)
    })
    .join('')
    .replace(/\n/gu, ' ')
    .trim()
  if (!normalized) throw engineError('render_unsupported', 'A burned caption cannot be empty')
  // FFmpeg applies one escaping layer to the drawtext option and a second to
  // the enclosing filtergraph. This is an argv element, so there is no shell
  // escaping layer. Keep expansion=none so percent sequences stay literal.
  const optionEscaped = normalized.replace(/[\\':]/gu, '\\$&')
  return optionEscaped.replace(/[\\'[\],;]/gu, '\\$&')
}

function safeCaptionColor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const match = /^#?([0-9A-Fa-f]{6})$/u.exec(value)
  if (!match) {
    throw engineError('render_unsupported', 'Burned caption colors must use six-digit hexadecimal values')
  }
  return match[1]!.toUpperCase()
}

function geometryFilter(project: VideoProject, item: TimelineItem): string {
  const baseGeometry = project.canvas.fit === 'crop'
    ? `scale=${project.canvas.width}:${project.canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${project.canvas.width}:${project.canvas.height},setsar=1`
    : project.canvas.fit === 'pad'
      ? sequentialGeometryFilter(project)
      : `scale=${project.canvas.width}:${project.canvas.height}:force_original_aspect_ratio=decrease,setsar=1`
  // Apply item transforms only after the source has been fitted to the canvas.
  // Scaling the target first made crop mode request (for example) a 640x360
  // crop from a 320x180 image whenever the item scale was 0.5.
  const transformed = item.transform.scaleX === 1 && item.transform.scaleY === 1
    ? baseGeometry
    : `${baseGeometry},scale=iw*${item.transform.scaleX.toFixed(6)}:` +
      `ih*${item.transform.scaleY.toFixed(6)}`
  const rotation = item.transform.rotation === 0
    ? ''
    : `,rotate=${(item.transform.rotation * Math.PI / 180).toFixed(8)}:c=none`
  return `${transformed}${rotation}`
}

function sequentialGeometryFilter(project: VideoProject): string {
  if (project.canvas.fit === 'crop') {
    return `scale=${project.canvas.width}:${project.canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${project.canvas.width}:${project.canvas.height},setsar=1`
  }
  return `scale=${project.canvas.width}:${project.canvas.height}:force_original_aspect_ratio=decrease,` +
    `pad=${project.canvas.width}:${project.canvas.height}:(ow-iw)/2:(oh-ih)/2:${project.canvas.background},` +
    'setsar=1'
}

function subtitleStep(
  project: VideoProject,
  output: string,
  format: SubtitleFormat,
  id: string
): TextRenderStep {
  return {
    kind: 'write-text',
    id,
    output,
    mime: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    content: generateSubtitles(project.captions, project.fps, format)
  }
}

function subtitleArtifact(output: string, format: SubtitleFormat): PlannedArtifact {
  return {
    output,
    name: `captions.${format}`,
    mime: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    kind: 'subtitle'
  }
}

function assetForItem(project: VideoProject, item: TimelineItem): MediaAsset {
  const asset = project.assets.find(({ id }) => id === item.assetId)
  if (!asset) throw engineError('invalid_project', `Missing asset ${item.assetId}`)
  return asset
}

function assetReference(asset: MediaAsset): RenderInputReference {
  if (asset.mediaHandleId) return { kind: 'media-handle', reference: asset.mediaHandleId }
  if (asset.workspaceRelativePath) return { kind: 'workspace-file', reference: asset.workspaceRelativePath }
  throw engineError('render_unsupported', `Asset ${asset.id} has no durable media reference`)
}

function placeholder(kind: 'input' | 'output', name: string): string {
  return `{{${kind}:${name}}}`
}

function compositionItemComparator(project: VideoProject): (left: TimelineItem, right: TimelineItem) => number {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]))
  return (left, right) => {
    const leftTrack = tracks.get(left.trackId)
    const rightTrack = tracks.get(right.trackId)
    return (leftTrack?.order ?? 0) - (rightTrack?.order ?? 0) ||
      left.trackId.localeCompare(right.trackId) ||
      left.timelineStartFrame - right.timelineStartFrame ||
      left.id.localeCompare(right.id)
  }
}

function validateOpaqueReference(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw engineError('render_unsupported', `${label} must be a bounded opaque reference`)
  }
}
