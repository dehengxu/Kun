import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { terminateSpawnTree } from '../adapters/tool/builtin-tool-utils.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleService,
  type ResolvedMediaHandle
} from './extension-media-handle-service.js'

export type MediaExecutableName = 'ffprobe' | 'ffmpeg'

/**
 * Keep native media readers on local, non-delegating inputs. The format list
 * intentionally excludes playlist/manifest and virtual-input demuxers such as
 * concat, HLS, DASH, lavfi, and capture devices. It is injected by core code,
 * never accepted from an extension argument list.
 */
export const EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST = 'file'
export const EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST = [
  'aac',
  'ac3',
  'aiff',
  'alaw',
  'amr',
  'ape',
  'apng',
  'asf',
  'au',
  'av1',
  'avi',
  'avif',
  'caf',
  'dirac',
  'dts',
  'dv',
  'eac3',
  'flac',
  'flv',
  'gif',
  'h261',
  'h263',
  'h264',
  'hevc',
  'image2',
  'jpeg_pipe',
  'matroska',
  'mjpeg',
  'mjpeg_2000',
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'mp3',
  'mpeg',
  'mpegvideo',
  'mpegts',
  'ogg',
  'opus',
  'png_pipe',
  'rawvideo',
  's16be',
  's16le',
  's24be',
  's24le',
  's32be',
  's32le',
  's8',
  'srt',
  'u16be',
  'u16le',
  'u24be',
  'u24le',
  'u32be',
  'u32le',
  'u8',
  'wav',
  'webm',
  'webvtt',
  'webp_pipe',
  'yuv4mpegpipe'
].join(',')

export type MediaCapability = {
  name: MediaExecutableName
  available: boolean
  source?: 'configured' | 'path'
  version?: string
  features?: Array<
    | 'libx264-encoder'
    | 'aac-encoder'
    | 'drawtext-filter'
    | 'subtitles-filter'
  >
}

export type MediaCapabilities = {
  probedAt: string
  ffprobe: MediaCapability
  ffmpeg: MediaCapability
}

export type MediaProbeMetadata = {
  schemaVersion: 1
  handleId: string
  container: {
    formatNames: string[]
    formatLongName?: string
    durationMicros?: number
    startTimeMicros?: number
    bitRate?: number
  }
  streams: Array<{
    index: number
    kind: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown'
    codecName?: string
    codecLongName?: string
    timeBase?: { numerator: number; denominator: number }
    frameRate?: { numerator: number; denominator: number }
    durationMicros?: number
    width?: number
    height?: number
    rotationDegrees?: number
    channelCount?: number
    sampleRate?: number
    channelLayout?: string
    language?: string
    disposition: { default: boolean; forced: boolean; attachedPicture: boolean }
  }>
}

export class ExtensionMediaProcessError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'executable_unavailable'
      | 'process_failed'
      | 'process_timeout'
      | 'process_cancelled'
      | 'output_limit'
      | 'invalid_probe_output',
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

type RunResult = { stdout: Buffer; stderr: Buffer; exitCode: number }

type MediaProcessOptions = {
  handleService: ExtensionMediaHandleService
  ffprobePath?: string
  ffmpegPath?: string
  pathEnv?: string
  discoveryDirectories?: string[]
  now?: () => Date
  probeTimeoutMs?: number
  discoveryTimeoutMs?: number
  maxProbeOutputBytes?: number
  maxDiagnosticBytes?: number
  ffmpegTimeoutMs?: number
  maxFfmpegProgressBytes?: number
  maxFfmpegLogBytes?: number
}

/**
 * Host-owned native media process boundary. It never accepts an extension path
 * and exposes only normalized, bounded metadata.
 */
export class ExtensionMediaProcessService {
  private readonly now: () => Date
  private readonly probeTimeoutMs: number
  private readonly discoveryTimeoutMs: number
  private readonly maxProbeOutputBytes: number
  private readonly maxDiagnosticBytes: number
  private readonly ffmpegTimeoutMs: number
  private readonly maxFfmpegProgressBytes: number
  private readonly maxFfmpegLogBytes: number
  private readonly configuredPaths: Partial<Record<MediaExecutableName, string>>
  private readonly pathEnv: string
  private readonly discoveryDirectories: string[]

  constructor(private readonly options: MediaProcessOptions) {
    this.now = options.now ?? (() => new Date())
    this.probeTimeoutMs = boundedInteger(options.probeTimeoutMs, 30_000, 250, 300_000)
    this.discoveryTimeoutMs = boundedInteger(options.discoveryTimeoutMs, 5_000, 100, 30_000)
    this.maxProbeOutputBytes = boundedInteger(options.maxProbeOutputBytes, 2 * 1024 * 1024, 1024, 8 * 1024 * 1024)
    this.maxDiagnosticBytes = boundedInteger(options.maxDiagnosticBytes, 64 * 1024, 1024, 1024 * 1024)
    this.ffmpegTimeoutMs = boundedInteger(options.ffmpegTimeoutMs, 6 * 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000)
    this.maxFfmpegProgressBytes = boundedInteger(options.maxFfmpegProgressBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024)
    this.maxFfmpegLogBytes = boundedInteger(options.maxFfmpegLogBytes, 4 * 1024 * 1024, 1024, 32 * 1024 * 1024)
    this.configuredPaths = {
      ...(options.ffprobePath ? { ffprobe: options.ffprobePath } : {}),
      ...(options.ffmpegPath ? { ffmpeg: options.ffmpegPath } : {})
    }
    this.pathEnv = options.pathEnv ?? process.env.PATH ?? ''
    this.discoveryDirectories = options.discoveryDirectories ?? defaultMediaDiscoveryDirectories()
  }

  async capabilities(principal: ExtensionPrincipal): Promise<MediaCapabilities> {
    requireProcessPermission(principal)
    const [ffprobe, ffmpeg] = await Promise.all([
      this.inspectExecutable('ffprobe'),
      this.inspectExecutable('ffmpeg')
    ])
    return { probedAt: this.now().toISOString(), ffprobe, ffmpeg }
  }

  async probe(
    principal: ExtensionPrincipal,
    handleId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<MediaProbeMetadata> {
    // Check media.process before handle resolution or executable discovery so
    // unauthorized callers cannot use the API as a capability oracle.
    requireProcessPermission(principal)
    const input = await this.options.handleService.resolve(principal, handleId, 'read')
    if (input.absolutePath.includes('%')) {
      throw new ExtensionMediaProcessError(
        'invalid_probe_output',
        'Media input name uses unsupported pattern syntax'
      )
    }
    const executable = await this.requireExecutable('ffprobe')
    const result = await runBoundedProcess(executable.path, [
      '-v', 'error',
      '-hide_banner',
      '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
      '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      input.absolutePath
    ], {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.probeTimeoutMs,
      maxStdoutBytes: this.maxProbeOutputBytes,
      maxStderrBytes: this.maxDiagnosticBytes,
      signal: options.signal
    })
    if (result.exitCode !== 0) {
      throw new ExtensionMediaProcessError('process_failed', 'Media probe failed')
    }
    return normalizeProbeJson(result.stdout, input)
  }

  /** Core-only execution primitive. Extension arguments must first pass the
   * handle-placeholder validator in ExtensionMediaFfmpegService. */
  async runFfmpegForCore(
    principal: ExtensionPrincipal,
    args: string[],
    options: { signal?: AbortSignal; onProgressChunk?: (chunk: Buffer) => void } = {}
  ): Promise<{ exitCode: number }> {
    requireProcessPermission(principal)
    const executable = await this.requireExecutable('ffmpeg')
    const result = await runBoundedProcess(executable.path, args, {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.ffmpegTimeoutMs,
      maxStdoutBytes: this.maxFfmpegProgressBytes,
      maxStderrBytes: this.maxFfmpegLogBytes,
      signal: options.signal,
      onStdoutChunk: options.onProgressChunk
    })
    return { exitCode: result.exitCode }
  }

  private async inspectExecutable(name: MediaExecutableName): Promise<MediaCapability> {
    const executable = await discoverExecutable(
      name,
      this.configuredPaths[name],
      this.pathEnv,
      this.discoveryDirectories
    )
    if (!executable) return { name, available: false }
    try {
      const result = await runBoundedProcess(executable.path, ['-version'], {
        env: scrubbedEnvironment(this.pathEnv),
        timeoutMs: this.discoveryTimeoutMs,
        maxStdoutBytes: this.maxDiagnosticBytes,
        maxStderrBytes: this.maxDiagnosticBytes
      })
      if (result.exitCode !== 0) return { name, available: false }
      const firstLine = result.stdout.toString('utf8').split(/\r?\n/u, 1)[0]?.trim() ?? ''
      const version = boundedVersion(firstLine, name)
      const features = name === 'ffmpeg'
        ? await inspectFfmpegFeatures(
            executable.path,
            scrubbedEnvironment(this.pathEnv),
            this.discoveryTimeoutMs,
            this.maxDiagnosticBytes
          )
        : []
      return {
        name,
        available: true,
        source: executable.source,
        ...(version ? { version } : {}),
        ...(features.length > 0 ? { features } : {})
      }
    } catch {
      return { name, available: false }
    }
  }

  private async requireExecutable(name: MediaExecutableName): Promise<DiscoveredExecutable> {
    const executable = await discoverExecutable(
      name,
      this.configuredPaths[name],
      this.pathEnv,
      this.discoveryDirectories
    )
    if (!executable) {
      throw new ExtensionMediaProcessError(
        'executable_unavailable',
        `${name} is not available on this host`,
        true
      )
    }
    return executable
  }
}

async function inspectFfmpegFeatures(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number
): Promise<NonNullable<MediaCapability['features']>> {
  try {
    const [encoders, filters] = await Promise.all([
      runBoundedProcess(executable, ['-hide_banner', '-encoders'], {
        env,
        timeoutMs,
        maxStdoutBytes: maxBytes,
        maxStderrBytes: maxBytes
      }),
      runBoundedProcess(executable, ['-hide_banner', '-filters'], {
        env,
        timeoutMs,
        maxStdoutBytes: maxBytes,
        maxStderrBytes: maxBytes
      })
    ])
    if (encoders.exitCode !== 0 || filters.exitCode !== 0) return []
    const encoderText = encoders.stdout.toString('utf8')
    const filterText = filters.stdout.toString('utf8')
    const features: NonNullable<MediaCapability['features']> = []
    if (/^\s*[A-Z.]{6}\s+libx264\s/mu.test(encoderText)) features.push('libx264-encoder')
    if (/^\s*[A-Z.]{6}\s+aac\s/mu.test(encoderText)) features.push('aac-encoder')
    if (/^\s*[A-Z.]{3}\s+drawtext\s/mu.test(filterText)) features.push('drawtext-filter')
    if (/^\s*[A-Z.]{3}\s+subtitles\s/mu.test(filterText)) features.push('subtitles-filter')
    return features
  } catch {
    return []
  }
}

type DiscoveredExecutable = { path: string; source: 'configured' | 'path' }

async function discoverExecutable(
  name: MediaExecutableName,
  configuredPath: string | undefined,
  pathEnv: string,
  discoveryDirectories: readonly string[]
): Promise<DiscoveredExecutable | undefined> {
  if (configuredPath) {
    if (!isAbsolute(configuredPath)) return undefined
    const path = await executableRealpath(configuredPath)
    return path ? { path, source: 'configured' } : undefined
  }
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  const directories = [...new Set([
    ...discoveryDirectories.slice(0, 32),
    ...pathEnv.split(delimiter).filter(Boolean).slice(0, 128)
  ])]
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue
    for (const candidate of names) {
      const path = await executableRealpath(join(directory, candidate))
      if (path) return { path, source: 'path' }
    }
  }
  return undefined
}

/**
 * Desktop launches do not necessarily inherit an interactive shell PATH.
 * Search only fixed, reviewed installation prefixes in addition to PATH; the
 * resolved executable is still canonicalized and checked before use.
 */
export function defaultMediaDiscoveryDirectories(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/opt/ffmpeg-full/bin',
      '/usr/local/opt/ffmpeg-full/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin'
    ]
  }
  if (platform === 'linux') return ['/usr/local/bin', '/usr/bin', '/snap/bin']
  return []
}

async function executableRealpath(candidate: string): Promise<string | undefined> {
  try {
    const path = await realpath(candidate)
    const info = await stat(path)
    if (!info.isFile()) return undefined
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return path
  } catch {
    return undefined
  }
}

function scrubbedEnvironment(pathEnv: string): NodeJS.ProcessEnv {
  return {
    PATH: pathEnv,
    LANG: 'C',
    LC_ALL: 'C',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {})
  }
}

async function runBoundedProcess(
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxStdoutBytes: number
    maxStderrBytes: number
    signal?: AbortSignal
    onStdoutChunk?: (chunk: Buffer) => void
  }
): Promise<RunResult> {
  if (options.signal?.aborted) {
    throw new ExtensionMediaProcessError('process_cancelled', 'Media process was cancelled')
  }
  return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env
      })
    } catch {
      rejectPromise(new ExtensionMediaProcessError('executable_unavailable', 'Media executable could not be started', true))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminationReason: 'timeout' | 'cancelled' | 'limit' | undefined
    let forceTimer: NodeJS.Timeout | undefined

    const stop = (reason: typeof terminationReason) => {
      if (terminationReason) return
      terminationReason = reason
      terminateSpawnTree(child)
      forceTimer = setTimeout(() => terminateSpawnTree(child, { signal: 'SIGKILL' }), 500)
      forceTimer.unref?.()
    }
    const deadline = setTimeout(() => stop('timeout'), options.timeoutMs)
    deadline.unref?.()
    const abort = () => stop('cancelled')
    options.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      stdoutBytes += chunk.length
      if (stdoutBytes > options.maxStdoutBytes) {
        stop('limit')
        return
      }
      stdout.push(chunk)
      options.onStdoutChunk?.(chunk)
    })
    child.stderr.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      stderrBytes += chunk.length
      if (stderrBytes > options.maxStderrBytes) {
        stop('limit')
        return
      }
      stderr.push(chunk)
    })
    child.once('error', () => {
      cleanup()
      if (settled) return
      settled = true
      rejectPromise(new ExtensionMediaProcessError('executable_unavailable', 'Media executable could not be started', true))
    })
    child.once('close', (code) => {
      cleanup()
      if (settled) return
      settled = true
      if (terminationReason === 'timeout') {
        rejectPromise(new ExtensionMediaProcessError('process_timeout', 'Media process timed out', true))
        return
      }
      if (terminationReason === 'cancelled') {
        rejectPromise(new ExtensionMediaProcessError('process_cancelled', 'Media process was cancelled'))
        return
      }
      if (terminationReason === 'limit') {
        rejectPromise(new ExtensionMediaProcessError('output_limit', 'Media process output exceeded its limit'))
        return
      }
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1 })
    })

    function cleanup() {
      clearTimeout(deadline)
      if (forceTimer) clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', abort)
      child.stdout.destroy()
      child.stderr.destroy()
    }
  })
}

function normalizeProbeJson(stdout: Buffer, input: ResolvedMediaHandle): MediaProbeMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.toString('utf8'))
  } catch {
    throw new ExtensionMediaProcessError('invalid_probe_output', 'Media probe returned invalid metadata')
  }
  if (!isRecord(parsed)) {
    throw new ExtensionMediaProcessError('invalid_probe_output', 'Media probe returned invalid metadata')
  }
  const rawFormat = isRecord(parsed.format) ? parsed.format : {}
  const formatNames = (boundedText(rawFormat.format_name, 4096) ?? '')
    .split(',')
    .map((value) => boundedText(value, 128))
    .filter((value): value is string => Boolean(value))
    .slice(0, 32)
  const formatLongName = boundedText(rawFormat.format_long_name, 256)
  const durationMicros = secondsToMicros(rawFormat.duration)
  const startTimeMicros = signedSecondsToMicros(rawFormat.start_time)
  const bitRate = positiveInteger(rawFormat.bit_rate, Number.MAX_SAFE_INTEGER)
  const rawStreams = Array.isArray(parsed.streams) ? parsed.streams.slice(0, 64) : []
  const streams = rawStreams.flatMap((value, fallbackIndex) => {
    if (!isRecord(value)) return []
    const index = nonnegativeInteger(value.index, fallbackIndex, 65_535)
    const kind = normalizedStreamKind(value.codec_type)
    const tags = isRecord(value.tags) ? value.tags : {}
    const disposition = isRecord(value.disposition) ? value.disposition : {}
    const frameRate = rational(value.avg_frame_rate) ?? rational(value.r_frame_rate)
    const stream: MediaProbeMetadata['streams'][number] = {
      index,
      kind,
      ...(boundedText(value.codec_name, 64) ? { codecName: boundedText(value.codec_name, 64) } : {}),
      ...(boundedText(value.codec_long_name, 256) ? { codecLongName: boundedText(value.codec_long_name, 256) } : {}),
      ...(rational(value.time_base) ? { timeBase: rational(value.time_base) } : {}),
      ...(frameRate ? { frameRate } : {}),
      ...(secondsToMicros(value.duration) !== undefined ? { durationMicros: secondsToMicros(value.duration) } : {}),
      ...(positiveInteger(value.width, 131_072) !== undefined ? { width: positiveInteger(value.width, 131_072) } : {}),
      ...(positiveInteger(value.height, 131_072) !== undefined ? { height: positiveInteger(value.height, 131_072) } : {}),
      ...(rotation(value, tags) !== undefined ? { rotationDegrees: rotation(value, tags) } : {}),
      ...(positiveInteger(value.channels, 1024) !== undefined ? { channelCount: positiveInteger(value.channels, 1024) } : {}),
      ...(positiveInteger(value.sample_rate, 10_000_000) !== undefined ? { sampleRate: positiveInteger(value.sample_rate, 10_000_000) } : {}),
      ...(boundedText(value.channel_layout, 128) ? { channelLayout: boundedText(value.channel_layout, 128) } : {}),
      ...(boundedText(tags.language, 32) ? { language: boundedText(tags.language, 32) } : {}),
      disposition: {
        default: booleanFlag(disposition.default) ?? false,
        forced: booleanFlag(disposition.forced) ?? false,
        attachedPicture: booleanFlag(disposition.attached_pic) ?? false
      }
    }
    return [stream]
  })
  return {
    schemaVersion: 1,
    handleId: input.id,
    container: {
      formatNames,
      ...(formatLongName ? { formatLongName } : {}),
      ...(durationMicros !== undefined ? { durationMicros } : {}),
      ...(startTimeMicros !== undefined ? { startTimeMicros } : {}),
      ...(bitRate !== undefined ? { bitRate } : {})
    },
    streams
  }
}

function normalizedStreamKind(value: unknown): MediaProbeMetadata['streams'][number]['kind'] {
  return value === 'video' || value === 'audio' || value === 'subtitle' ||
    value === 'data' || value === 'attachment' ? value : 'unknown'
}

function rational(value: unknown): { numerator: number; denominator: number } | undefined {
  const text = rationalText(value)
  if (!text) return undefined
  const [left, right] = text.split('/')
  const numerator = Number(left)
  const denominator = Number(right)
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
    numerator < 0 || denominator <= 0) return undefined
  return { numerator, denominator }
}

function rationalText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,10}\/\d{1,10}$/u.test(value)) return undefined
  return value
}

function secondsToMicros(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number < 0) return undefined
  const micros = Math.round(number * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : undefined
}

function signedSecondsToMicros(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return undefined
  const micros = Math.round(number * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : undefined
}

function rotation(stream: Record<string, unknown>, tags: Record<string, unknown>): number | undefined {
  const direct = typeof tags.rotate === 'string' || typeof tags.rotate === 'number' ? Number(tags.rotate) : Number.NaN
  if (Number.isInteger(direct) && direct >= -359 && direct <= 359) return direct
  if (!Array.isArray(stream.side_data_list)) return undefined
  for (const value of stream.side_data_list.slice(0, 16)) {
    if (!isRecord(value)) continue
    const candidate = typeof value.rotation === 'number' ? value.rotation : Number(value.rotation)
    if (Number.isInteger(candidate) && candidate >= -359 && candidate <= 359) return candidate
  }
  return undefined
}

function positiveInteger(value: unknown, max: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : undefined
}

function nonnegativeInteger(value: unknown, fallback: number, max: number): number {
  return positiveInteger(value, max) ?? fallback
}

function booleanFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return undefined
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = [...value.trim()].filter((character) => {
    const code = character.charCodeAt(0)
    return code > 31 && code !== 127
  }).join('')
  return text ? text.slice(0, max) : undefined
}

function boundedVersion(line: string, name: MediaExecutableName): string | undefined {
  const match = line.match(new RegExp(`^${name} version ([^\\s]+)`, 'u'))
  return match?.[1]?.slice(0, 64)
}

function requireProcessPermission(principal: ExtensionPrincipal): void {
  if (!principal.permissions.includes('media.process')) {
    throw new ExtensionMediaProcessError('permission_denied', 'Missing permission: media.process')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value!)))
}
