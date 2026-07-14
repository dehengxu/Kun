import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { canImportMedia, syncDocumentPresentation, themeStyle, VideoEditorWorkbench } from '../src/webview/app.js'
import type { EditorController } from '../src/webview/controller.js'
import { INITIAL_EDITOR_STATE, editorReducer, type EditorState } from '../src/webview/model.js'
import { makeArtifact, makeJob, makeSubtitleArtifact, makeViewProject } from './webview-fixtures.js'

describe('video editor docked workbench', () => {
  it('disables both media import entry points when ffprobe is explicitly unavailable', () => {
    const project = makeViewProject()
    const state: EditorState = {
      ...editorReducer(
        editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
        { type: 'project', value: project }
      ),
      mediaCapabilities: {
        probedAt: '2026-01-01T00:00:00.000Z',
        ffmpeg: { name: 'ffmpeg', available: true, features: ['libx264-encoder', 'aac-encoder'] },
        ffprobe: { name: 'ffprobe', available: false, features: [] }
      }
    }

    expect(canImportMedia(state)).toBe(false)
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    expect(html.match(/<button[^>]*disabled=""[^>]*>Import media<\/button>/gu)).toHaveLength(2)
  })

  it('renders every editing region with accessible landmarks and supported boundaries', () => {
    const project = makeViewProject()
    const job = {
      ...makeJob('completed'),
      result: {
        schemaVersion: 1 as const,
        generatedArtifacts: [makeArtifact('job_12345678'), makeSubtitleArtifact('job_12345678')]
      }
    }
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController({
      ...state,
      jobs: [job],
      renderTickets: [{
        jobId: job.id,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'proof-frame',
        createdAt: job.createdAt
      }]
    })} />)
    for (const label of ['Media library', 'Player', 'Transcript', 'Timeline', 'Inspector', 'Captions', 'Revisions', 'Preview and proof', 'Agent sync', 'Export jobs']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('href="#video-editor-main"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-label="Ordered timeline tracks"')
    for (const manualControl of ['Split at playhead', 'Apply trim', 'Move to track', 'Reorder', 'Add caption', 'Canvas and fit']) {
      expect(html).toContain(manualControl)
    }
    expect(html).toContain('does not perform arbitrary visual-scene understanding')
    expect(html).toContain('Technically validated by FFmpeg/ffprobe; not visually reviewed.')
    expect(html).toContain('Preview')
    expect(html).toContain('Open with system app')
    expect(html).toContain('Show in folder')
    expect(html).toContain('local path stays hidden from the extension View')
    expect(html).toContain('Edit with the main Kun Agent')
    expect(html).toContain('video-project · active')
    expect(html).not.toContain('Creative brief and review checkpoint')
  })

  it('renders explicit empty, interaction-required, reconnect and legacy-run states', () => {
    let state: EditorState = editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' })
    state = {
      ...state,
      connection: 'reconnecting',
      notices: [{ id: 'picker', severity: 'warning', message: 'Select a file', interactionRequired: true }]
    }
    const emptyHtml = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    expect(emptyHtml).toContain('Create or open a project')
    expect(emptyHtml).toContain('A protected Kun desktop interaction is required.')

    const project = makeViewProject()
    const waitingState: EditorState = {
      ...editorReducer(state, { type: 'project', value: project }),
      jobs: [makeJob('running')],
      renderTickets: [{
        jobId: 'job_12345678',
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'preview',
        createdAt: '2026-01-01T00:00:00.000Z'
      }],
      agentRun: {
        id: 'run-1',
        threadId: 'thread-1',
        ownerExtensionId: 'kun-examples.kun-video-editor',
        ownerExtensionVersion: '0.1.0',
        extensionVisibility: 'private',
        extensionBudget: {},
        toolCatalogEpoch: 'epoch-1',
        state: 'waiting-approval',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z'
      }
    }
    const waitingHtml = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(waitingState)} />)
    expect(waitingHtml).toContain('Existing private run')
    expect(waitingHtml).toContain('Waiting for approval')
    expect(waitingHtml).toContain('Ready for main-Agent edits')
    expect(waitingHtml).toContain('Cancel job')
  })

  it('renders the workbench in Simplified Chinese and follows the Kun theme', () => {
    const project = makeViewProject()
    project.revisions[0] = {
      ...project.revisions[0]!,
      sourceOperation: 'project.create',
      summary: 'Created project'
    }
    project.transcripts[0]!.segments[1]!.tags = ['filler']
    project.transcripts[0]!.segments[2]!.tags = ['silence']
    const initialized = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const job = makeJob('running')
    const state: EditorState = {
      ...initialized,
      theme: { kind: 'light', tokens: {}, zoomFactor: 1, reducedMotion: false },
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} },
      jobs: [job],
      renderTickets: [{
        jobId: job.id,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'preview',
        createdAt: job.createdAt
      }],
      lastProjectChange: {
        schemaVersion: 1,
        projectId: project.id,
        revision: project.currentRevision,
        reason: 'active-project-changed',
        changedIds: []
      },
      notices: [{
        id: 'initialization-failed',
        severity: 'error',
        message: 'The editor could not initialize.',
        messageKey: 'editorInitializeFailed'
      }]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    expect(html).toContain('data-theme="light"')
    expect(html).toContain('lang="zh-CN"')
    for (const label of ['Kun 视频剪辑', '媒体库', '播放器', '逐字稿', '时间线', '检查器', '字幕', '版本', '预览与校样', 'Agent 协作', '导出任务']) {
      expect(html).toContain(label)
    }
    for (const persistedProjectLabel of ['视频 1', '视频 2', '音频 1', '已创建项目']) {
      expect(html).toContain(persistedProjectLabel)
    }
    for (const control of ['在播放头处拆分', '应用裁剪', '移动到轨道', '重新排序', '添加字幕', '画布与适配']) {
      expect(html).toContain(control)
    }
    for (const localizedStatus of ['video-project · 当前项目', '已切换当前项目', '填充词', '静音', '正在编码媒体…']) {
      expect(html).toContain(localizedStatus)
    }
    expect(html).not.toContain('Transcript-first workbench')
    expect(html).not.toContain('Select a project')
    expect(html).not.toContain('video-project · active')
    expect(html).not.toContain('active-project-changed')
    expect(html).not.toContain('Encoding')
    expect(html).not.toContain('>filler<')
    expect(html).not.toContain('>Video 1<')
    expect(html).not.toContain('>Audio 1<')
    expect(html).not.toContain('>Created project<')
    expect(html).toContain('视频编辑器初始化失败。')
    expect(html).not.toContain('The editor could not initialize.')
  })

  it('propagates presentation state to the document root and keeps light colors theme-driven', () => {
    const setProperty = vi.fn()
    const removeProperty = vi.fn()
    const documentRoot = {
      dataset: {},
      dir: '',
      lang: '',
      style: { setProperty, removeProperty }
    } as unknown as Pick<HTMLElement, 'dataset' | 'dir' | 'lang' | 'style'>
    const theme = {
      kind: 'light' as const,
      tokens: {
        background: '#fafbff',
        surface: '#ffffff',
        foreground: '#233659',
        accent: '#3b82d8'
      },
      zoomFactor: 1.25,
      reducedMotion: true
    }
    syncDocumentPresentation(
      documentRoot,
      theme,
      { language: 'zh-CN', direction: 'ltr', messages: {} }
    )

    expect(documentRoot.dataset.theme).toBe('light')
    expect(documentRoot.dataset.reducedMotion).toBe('true')
    expect(documentRoot.dataset.zoomFactor).toBe('1.25')
    expect(documentRoot.lang).toBe('zh-CN')
    expect(documentRoot.dir).toBe('ltr')
    expect(setProperty).toHaveBeenCalledWith('--bg', '#fafbff')
    expect(setProperty).toHaveBeenCalledWith('--surface', '#ffffff')
    expect(setProperty).toHaveBeenCalledWith('--text', '#233659')
    expect(setProperty).toHaveBeenCalledWith('--accent', '#3b82d8')
    expect(setProperty).toHaveBeenCalledWith('font-size', '20px')
    expect(setProperty).toHaveBeenCalledWith('color-scheme', 'light')
    expect(themeStyle(theme)).toMatchObject({
      '--bg': '#fafbff',
      '--surface': '#ffffff',
      '--text': '#233659',
      '--accent': '#3b82d8',
      colorScheme: 'light'
    })

    const css = readFileSync(new URL('../src/webview/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/:root\[data-theme="light"\],\s*\.editor-app\[data-theme="light"\]/u)
    expect(css).toMatch(/\.editor-app\s*\{[^}]*color: var\(--text\);[^}]*var\(--app-glow\)/su)
    expect(css).toContain('body { min-height: 100vh; overflow-x: hidden; background: var(--bg); color: var(--text); }')
    expect(css).not.toContain('#222b3c 0')
    expect(css).not.toContain('background: #0b0f16')
  })

  it('opens timeline media only once while the first lease request is still pending', async () => {
    const project = makeViewProject()
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const openAsset = vi.fn(() => new Promise<void>(() => undefined))
    const documentElement = {
      dataset: {},
      dir: '',
      lang: '',
      style: { setProperty: vi.fn(), removeProperty: vi.fn() }
    }
    vi.stubGlobal('document', { documentElement, title: '' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => false)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={{ ...stubController(state), openAsset }} />)
        await Promise.resolve()
      })
      expect(openAsset).toHaveBeenCalledTimes(1)
      expect(openAsset).toHaveBeenCalledWith(project.assets[0]!.id)

      await act(async () => {
        renderer?.update(
          <VideoEditorWorkbench controller={{
            ...stubController({ ...state, busy: true }),
            openAsset
          }} />
        )
        await Promise.resolve()
      })
      expect(openAsset).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })
})

function stubController(state: EditorState): EditorController {
  const asynchronous = vi.fn(async () => undefined)
  const synchronous = vi.fn()
  return {
    state,
    refreshAll: asynchronous,
    createProject: asynchronous,
    openProject: asynchronous,
    importMedia: asynchronous,
    importTranscript: asynchronous,
    checkLocalTranscriber: asynchronous,
    generateCaptions: asynchronous,
    openAsset: asynchronous,
    refreshActiveLease: asynchronous,
    recoverMedia: asynchronous,
    applyOperations: asynchronous,
    undo: asynchronous,
    redo: asynchronous,
    readScript: asynchronous,
    editScript: synchronous,
    applyScript: asynchronous,
    seek: synchronous,
    togglePlaying: synchronous,
    selectItem: synchronous,
    selectCaption: synchronous,
    setTranscriptWindow: synchronous,
    setTimelineWindow: synchronous,
    startAgent: asynchronous,
    steerAgent: asynchronous,
    cancelAgent: asynchronous,
    startRender: asynchronous,
    cancelJob: asynchronous,
    openArtifact: asynchronous,
    revealArtifact: asynchronous,
    dismissNotice: synchronous
  }
}
