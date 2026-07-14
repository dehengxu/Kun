import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { VideoEngineError, engineError, type VideoEngineErrorCode } from './errors.js'
import {
  MAX_PROJECT_HISTORY,
  PROJECT_SCHEMA_VERSION,
  migrateProject,
  type Rational,
  type Revision,
  type RevisionAuthor,
  type TimelineOperation,
  type VideoProject
} from './schema.js'
import { generateTimelineMarkdown } from './script.js'
import { applyTimelineOperations, assertValidTimeline, canvasForPreset } from './timeline.js'

export type CreateProjectInput = {
  id: string
  name: string
  fps?: Rational
  canvasPreset?: VideoProject['canvas']['preset']
}

export type CommitMetadata = {
  author: RevisionAuthor
  sourceOperation: string
  summary: string
  operations?: TimelineOperation[]
  inverseOperations?: TimelineOperation[]
  restoredFromRevision?: number
}

export type ProjectSummary = {
  id: string
  name: string
  currentRevision: number
  updatedAt: string
  durationFrames: number
}

export type ProjectDiagnostic = {
  id: string
  code: VideoEngineErrorCode
}

export type ProjectListResult = {
  projects: ProjectSummary[]
  diagnostics: ProjectDiagnostic[]
}

export type ProjectServiceOptions = {
  historyLimit?: number
  now?: () => Date
  commitPhaseHook?: (phase: 'pending' | 'snapshot' | 'project' | 'timeline') => void | Promise<void>
}

type PendingProjectCommit = {
  schemaVersion: 1
  projectId: string
  previousRevision: number
  project: VideoProject
}

export class ProjectService {
  readonly workspaceRoot: string
  readonly dataRoot: string
  private readonly historyLimit: number
  private readonly now: () => Date
  private readonly commitPhaseHook?: ProjectServiceOptions['commitPhaseHook']
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(workspaceRoot: string, options: ProjectServiceOptions = {}) {
    if (!isAbsolute(workspaceRoot)) {
      throw engineError('path_escape', 'ProjectService requires an absolute workspace root')
    }
    this.workspaceRoot = resolve(workspaceRoot)
    this.dataRoot = join(this.workspaceRoot, '.kun-video')
    this.historyLimit = Math.max(2, Math.min(MAX_PROJECT_HISTORY, options.historyLimit ?? MAX_PROJECT_HISTORY))
    this.now = options.now ?? (() => new Date())
    this.commitPhaseHook = options.commitPhaseHook
  }

  async createProject(input: CreateProjectInput): Promise<VideoProject> {
    validateProjectId(input.id)
    return await this.serialize(input.id, async () => {
      await this.ensureDataRoot()
      const projectDirectory = this.projectDirectory(input.id)
      const stagingDirectory = join(this.projectsRoot(), `.${input.id}.${randomUUID()}.tmp`)
      try {
        await lstat(projectDirectory)
        throw engineError('project_exists', `Project already exists: ${input.id}`)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      await mkdir(join(stagingDirectory, 'revisions'), { recursive: true, mode: 0o700 })
      const timestamp = this.now().toISOString()
      const initialRevision: Revision = {
        revision: 0,
        parentRevision: null,
        author: 'system',
        sourceOperation: 'project.create',
        timestamp,
        summary: 'Created project',
        operations: [],
        inverseOperations: []
      }
      const project: VideoProject = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: input.id,
        name: input.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        fps: input.fps ?? { numerator: 30, denominator: 1 },
        canvas: canvasForPreset(input.canvasPreset ?? '16:9'),
        assets: [],
        tracks: [
          { id: 'video-1', name: 'Video 1', kind: 'video', order: 0, overlap: 'reject' },
          { id: 'audio-1', name: 'Audio 1', kind: 'audio', order: 1, overlap: 'mix' },
          { id: 'captions-1', name: 'Captions', kind: 'caption', order: 2, overlap: 'reject' }
        ],
        items: [],
        captions: [],
        transcripts: [],
        currentRevision: 0,
        revisions: [initialRevision],
        undoStack: [],
        redoStack: []
      }
      assertValidTimeline(project)
      try {
        await writeSnapshotAt(stagingDirectory, project)
        await atomicWriteJson(join(stagingDirectory, 'project.json'), project)
        await atomicWriteText(join(stagingDirectory, 'timeline.md'), generateTimelineMarkdown(project))
        await rename(stagingDirectory, projectDirectory)
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true })
        if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
          throw engineError('project_exists', `Project already exists: ${input.id}`)
        }
        throw error
      }
      return structuredClone(project)
    })
  }

  async loadProject(projectId: string): Promise<VideoProject> {
    validateProjectId(projectId)
    await this.ensureDataRoot()
    await this.assertProjectDirectory(projectId)
    await this.recoverPendingCommit(projectId)
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), this.projectPath(projectId))
      const raw: unknown = JSON.parse(await readFile(this.projectPath(projectId), 'utf8'))
      const project = migrateProject(raw)
      if (project.id !== projectId) {
        throw engineError('invalid_project', 'Project identity does not match its directory')
      }
      assertValidTimeline(project)
      return project
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('project_not_found', `Project does not exist: ${projectId}`)
      }
      throw error
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.listProjectsWithDiagnostics()).projects
  }

  async listProjectsWithDiagnostics(): Promise<ProjectListResult> {
    await this.ensureDataRoot()
    const projectsRoot = this.projectsRoot()
    const entries = await readdir(projectsRoot, { withFileTypes: true })
    const summaries: ProjectSummary[] = []
    const diagnostics: ProjectDiagnostic[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isProjectId(entry.name)) continue
      let project: VideoProject
      try {
        project = await this.loadProject(entry.name)
      } catch (error) {
        diagnostics.push({
          id: entry.name,
          code: error instanceof VideoEngineError ? error.code : 'invalid_project'
        })
        continue
      }
      summaries.push({
        id: project.id,
        name: project.name,
        currentRevision: project.currentRevision,
        updatedAt: project.updatedAt,
        durationFrames: project.items.reduce(
          (maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames),
          0
        )
      })
    }
    return {
      projects: summaries.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      ),
      diagnostics
    }
  }

  async saveProject(
    candidate: VideoProject,
    expectedRevision: number,
    metadata: CommitMetadata
  ): Promise<VideoProject> {
    validateProjectId(candidate.id)
    return await this.serialize(candidate.id, async () => {
      const current = await this.loadProject(candidate.id)
      assertExpectedRevision(current, expectedRevision)
      return await this.commit(current, candidate, metadata, {
        undoStack: [...current.undoStack, current.currentRevision],
        redoStack: []
      })
    })
  }

  async applyOperations(
    projectId: string,
    expectedRevision: number,
    operations: readonly TimelineOperation[],
    metadata: Omit<CommitMetadata, 'operations' | 'inverseOperations'>
  ): Promise<VideoProject> {
    validateProjectId(projectId)
    return await this.serialize(projectId, async () => {
      const current = await this.loadProject(projectId)
      assertExpectedRevision(current, expectedRevision)
      const result = applyTimelineOperations(current, operations)
      return await this.commit(current, result.project, {
        ...metadata,
        operations: [...operations],
        inverseOperations: result.inverseOperations
      }, {
        undoStack: [...current.undoStack, current.currentRevision],
        redoStack: []
      })
    })
  }

  async undo(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<VideoProject> {
    return await this.serialize(projectId, async () => {
      const current = await this.loadProject(projectId)
      assertExpectedRevision(current, expectedRevision)
      const targetRevision = current.undoStack.at(-1)
      if (targetRevision === undefined) {
        throw engineError('history_unavailable', 'No retained project revision is available to undo')
      }
      const target = await this.loadSnapshot(projectId, targetRevision)
      return await this.commit(current, target, {
        author,
        sourceOperation: 'history.undo',
        summary: `Restored revision ${targetRevision}`,
        operations: [],
        inverseOperations: [],
        restoredFromRevision: targetRevision
      }, {
        undoStack: current.undoStack.slice(0, -1),
        redoStack: [...current.redoStack, current.currentRevision]
      })
    })
  }

  async redo(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<VideoProject> {
    return await this.serialize(projectId, async () => {
      const current = await this.loadProject(projectId)
      assertExpectedRevision(current, expectedRevision)
      const targetRevision = current.redoStack.at(-1)
      if (targetRevision === undefined) {
        throw engineError('history_unavailable', 'No retained project revision is available to redo')
      }
      const target = await this.loadSnapshot(projectId, targetRevision)
      return await this.commit(current, target, {
        author,
        sourceOperation: 'history.redo',
        summary: `Restored revision ${targetRevision}`,
        operations: [],
        inverseOperations: [],
        restoredFromRevision: targetRevision
      }, {
        undoStack: [...current.undoStack, current.currentRevision],
        redoStack: current.redoStack.slice(0, -1)
      })
    })
  }

  async loadRevision(projectId: string, revision: number): Promise<VideoProject> {
    validateProjectId(projectId)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw engineError('history_unavailable', 'Revision must be a non-negative integer')
    }
    await this.ensureDataRoot()
    await this.assertProjectDirectory(projectId)
    return await this.loadSnapshot(projectId, revision)
  }

  private async commit(
    current: VideoProject,
    candidate: VideoProject,
    metadata: CommitMetadata,
    stacks: { undoStack: number[]; redoStack: number[] }
  ): Promise<VideoProject> {
    if (candidate.id !== current.id || candidate.createdAt !== current.createdAt) {
      throw engineError('invalid_project', 'A project commit cannot change stable identity fields')
    }
    const revisionNumber = current.currentRevision + 1
    const timestamp = this.now().toISOString()
    const revision: Revision = {
      revision: revisionNumber,
      parentRevision: current.currentRevision,
      author: metadata.author,
      sourceOperation: metadata.sourceOperation,
      timestamp,
      summary: metadata.summary,
      operations: structuredClone(metadata.operations ?? []),
      inverseOperations: structuredClone(metadata.inverseOperations ?? []),
      ...(metadata.restoredFromRevision === undefined
        ? {}
        : { restoredFromRevision: metadata.restoredFromRevision })
    }
    const retainedRevisions = [...current.revisions, revision].slice(-this.historyLimit)
    const retainedNumbers = new Set(retainedRevisions.map(({ revision: number }) => number))
    const next: VideoProject = {
      ...structuredClone(candidate),
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      currentRevision: revisionNumber,
      revisions: retainedRevisions,
      undoStack: stacks.undoStack.filter((number) => retainedNumbers.has(number)).slice(-this.historyLimit),
      redoStack: stacks.redoStack.filter((number) => retainedNumbers.has(number)).slice(-this.historyLimit)
    }
    assertValidTimeline(next)
    const pending: PendingProjectCommit = {
      schemaVersion: 1,
      projectId: next.id,
      previousRevision: current.currentRevision,
      project: structuredClone(next)
    }
    await atomicWriteJson(this.pendingCommitPath(next.id), pending)
    await this.commitPhaseHook?.('pending')
    let snapshotWritten = false
    let projectCommitted = false
    try {
      await this.writeSnapshot(next)
      snapshotWritten = true
      await this.commitPhaseHook?.('snapshot')
      await atomicWriteJson(this.projectPath(next.id), next)
      projectCommitted = true
      await this.commitPhaseHook?.('project')
      await atomicWriteText(this.timelinePath(next.id), generateTimelineMarkdown(next))
      await this.commitPhaseHook?.('timeline')
      await rm(this.pendingCommitPath(next.id), { force: true })
    } catch (error) {
      if (!projectCommitted) {
        if (snapshotWritten) await rm(this.snapshotPath(next.id, revisionNumber), { force: true })
        await rm(this.pendingCommitPath(next.id), { force: true })
        throw error
      }
      // project.json is the transaction commit point. Once it has moved into
      // place, finish the journal rather than reporting a false rollback to a
      // caller that could retry the same revision.
      await this.recoverPendingCommit(next.id)
    }
    await this.pruneSnapshots(next.id, retainedNumbers)
    return structuredClone(next)
  }

  private async recoverPendingCommit(projectId: string): Promise<void> {
    const pendingPath = this.pendingCommitPath(projectId)
    let raw: unknown
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), pendingPath)
      raw = JSON.parse(await readFile(pendingPath, 'utf8'))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const pending = parsePendingProjectCommit(raw, projectId)
    let current: VideoProject
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), this.projectPath(projectId))
      current = migrateProject(JSON.parse(await readFile(this.projectPath(projectId), 'utf8')))
      assertValidTimeline(current)
    } catch (error) {
      throw engineError('invalid_project', 'Pending project commit cannot read its commit point', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    if (current.currentRevision === pending.previousRevision) {
      await rm(this.snapshotPath(projectId, pending.project.currentRevision), { force: true })
      await rm(pendingPath, { force: true })
      return
    }
    if (current.currentRevision > pending.project.currentRevision) {
      await rm(pendingPath, { force: true })
      return
    }
    if (
      current.currentRevision !== pending.project.currentRevision ||
      JSON.stringify(current) !== JSON.stringify(pending.project)
    ) {
      throw engineError('invalid_project', 'Pending project commit disagrees with project.json')
    }

    await atomicWriteJson(this.snapshotPath(projectId, current.currentRevision), current)
    await atomicWriteText(this.timelinePath(projectId), generateTimelineMarkdown(current))
    await rm(pendingPath, { force: true })
  }

  private async loadSnapshot(projectId: string, revision: number): Promise<VideoProject> {
    try {
      await assertConfinedRegularFile(
        this.projectDirectory(projectId),
        this.snapshotPath(projectId, revision)
      )
      const raw: unknown = JSON.parse(await readFile(this.snapshotPath(projectId, revision), 'utf8'))
      const project = migrateProject(raw)
      assertValidTimeline(project)
      return project
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('history_unavailable', `Revision ${revision} is no longer retained`)
      }
      throw error
    }
  }

  private async writeSnapshot(project: VideoProject): Promise<void> {
    await writeSnapshotAt(this.projectDirectory(project.id), project)
  }

  private async pruneSnapshots(projectId: string, retained: ReadonlySet<number>): Promise<void> {
    const directory = this.revisionDirectory(projectId)
    const entries = await readdir(directory)
    await Promise.all(entries.flatMap((entry) => {
      const match = /^revision-(\d+)\.json$/u.exec(entry)
      if (!match || retained.has(Number(match[1]))) return []
      return [rm(join(directory, entry), { force: true })]
    }))
  }

  private async ensureDataRoot(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 })
    const workspaceCanonical = await realpath(this.workspaceRoot)
    await rejectSymbolicPath(this.workspaceRoot, this.dataRoot)
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
    const dataCanonical = await realpath(this.dataRoot)
    assertInside(workspaceCanonical, dataCanonical)
    await rejectSymbolicPath(this.dataRoot, this.projectsRoot())
    await mkdir(this.projectsRoot(), { recursive: true, mode: 0o700 })
    const projectsCanonical = await realpath(this.projectsRoot())
    assertInside(dataCanonical, projectsCanonical)
  }

  private async assertProjectDirectory(projectId: string): Promise<void> {
    const projectDirectory = this.projectDirectory(projectId)
    try {
      const stats = await lstat(projectDirectory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw engineError('path_escape', 'Project directory must be a real confined directory')
      }
      const canonicalProjects = await realpath(this.projectsRoot())
      const canonicalProject = await realpath(projectDirectory)
      assertInside(canonicalProjects, canonicalProject)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('project_not_found', `Project does not exist: ${projectId}`)
      }
      throw error
    }
  }

  private projectsRoot(): string {
    return join(this.dataRoot, 'projects')
  }

  private projectDirectory(projectId: string): string {
    validateProjectId(projectId)
    return join(this.projectsRoot(), projectId)
  }

  private projectPath(projectId: string): string {
    return join(this.projectDirectory(projectId), 'project.json')
  }

  private timelinePath(projectId: string): string {
    return join(this.projectDirectory(projectId), 'timeline.md')
  }

  private revisionDirectory(projectId: string): string {
    return join(this.projectDirectory(projectId), 'revisions')
  }

  private snapshotPath(projectId: string, revision: number): string {
    return join(this.revisionDirectory(projectId), `revision-${String(revision).padStart(8, '0')}.json`)
  }

  private pendingCommitPath(projectId: string): string {
    return join(this.projectDirectory(projectId), '.pending-commit.json')
  }

  private async serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(projectId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.operations.set(projectId, current)
    try {
      return await current
    } finally {
      if (this.operations.get(projectId) === current) this.operations.delete(projectId)
    }
  }
}

function parsePendingProjectCommit(value: unknown, projectId: string): PendingProjectCommit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw engineError('invalid_project', 'Pending project commit is invalid')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (
    JSON.stringify(keys) !==
      JSON.stringify(['previousRevision', 'project', 'projectId', 'schemaVersion']) ||
    candidate.schemaVersion !== 1 ||
    candidate.projectId !== projectId ||
    !Number.isSafeInteger(candidate.previousRevision) ||
    Number(candidate.previousRevision) < 0
  ) {
    throw engineError('invalid_project', 'Pending project commit metadata is invalid')
  }
  const project = migrateProject(candidate.project)
  assertValidTimeline(project)
  if (
    project.id !== projectId ||
    project.currentRevision !== Number(candidate.previousRevision) + 1
  ) {
    throw engineError('invalid_project', 'Pending project commit revision is invalid')
  }
  return {
    schemaVersion: 1,
    projectId,
    previousRevision: Number(candidate.previousRevision),
    project
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeSnapshotAt(projectDirectory: string, project: VideoProject): Promise<void> {
  const path = join(
    projectDirectory,
    'revisions',
    `revision-${String(project.currentRevision).padStart(8, '0')}.json`
  )
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function rejectSymbolicPath(root: string, target: string): Promise<void> {
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw engineError('path_escape', 'Project path escapes the workspace')
  }
  let cursor = root
  for (const part of fromRoot.split(sep)) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw engineError('path_escape', 'Symbolic links are not accepted in project storage')
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
  }
}

async function assertConfinedRegularFile(root: string, path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw engineError('path_escape', 'Project state must be a real confined regular file')
  }
  assertInside(await realpath(root), await realpath(path))
}

function assertInside(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw engineError('path_escape', 'Project path escapes the workspace')
  }
}

function assertExpectedRevision(project: VideoProject, expectedRevision: number): void {
  if (project.currentRevision !== expectedRevision) {
    throw engineError('revision_conflict', 'Project revision has changed', {
      expectedRevision,
      currentRevision: project.currentRevision
    })
  }
}

function validateProjectId(value: string): void {
  if (!isProjectId(value)) {
    throw engineError('path_escape', 'Project ID is not a confined stable identifier')
  }
}

function isProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) && value !== '.' && value !== '..'
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
