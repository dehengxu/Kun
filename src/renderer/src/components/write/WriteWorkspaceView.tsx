import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import {
  BookOpen,
  Columns2,
  CornerDownLeft,
  Eye,
  FileCode2,
  FilePlus2,
  FilePenLine,
  FolderOpen,
  ListTodo,
  MessageSquareQuote,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Sparkles
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat-store'
import {
  useWriteWorkspaceStore,
  type WritePreviewMode,
  type WriteSaveStatus,
  writeBasenameFromPath,
  writeJoinPath,
  writeRelativeToWorkspace
} from '../../write/write-workspace-store'
import { WriteMarkdownEditor } from './WriteMarkdownEditor'
import { WriteMarkdownPreview } from './WriteMarkdownPreview'

type Props = {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  input: string
  setInput: (value: string) => void
  onSubmitPrompt?: (value: string) => void
}

const WRITE_AUTOSAVE_MS = 900
const INLINE_AGENT_MIN_WIDTH = 280
const INLINE_AGENT_MAX_WIDTH = 440
const INLINE_AGENT_FALLBACK_HEIGHT = 56

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath)
}

function formatSaveLabel(status: WriteSaveStatus, t: (key: string) => string): string {
  if (status === 'saving') return t('writeSaving')
  if (status === 'dirty') return t('writeUnsaved')
  if (status === 'error') return t('writeSaveError')
  return t('writeSaved')
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function inlineAgentPosition(selection: ReturnType<typeof useWriteWorkspaceStore.getState>['selection']): {
  left: number
  top: number
  width: number
  origin: 'top-center' | 'bottom-center'
} | null {
  const rect = selection.anchorRect
  if (!rect) return null
  const width = clamp(Math.round(window.innerWidth * 0.24), INLINE_AGENT_MIN_WIDTH, INLINE_AGENT_MAX_WIDTH)
  const height = INLINE_AGENT_FALLBACK_HEIGHT
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const left = clamp(rect.left + rect.width / 2 - width / 2, 16, viewportWidth - width - 16)
  const bottomTop = rect.bottom + 8
  const topTop = rect.top - height - 8
  const useTop = bottomTop + height > viewportHeight - 16 && topTop >= 16
  const top = clamp(useTop ? topTop : bottomTop, 16, viewportHeight - height - 16)
  return {
    left,
    top,
    width,
    origin: useTop ? 'bottom-center' : 'top-center'
  }
}

function modeButtonClass(active: boolean): string {
  return `inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-[13px] transition ${
    active
      ? 'bg-white text-ds-ink shadow-sm ring-1 ring-ds-border-muted dark:bg-white/10 dark:ring-white/10'
      : 'text-ds-faint hover:bg-white/70 hover:text-ds-ink dark:hover:bg-white/8'
  }`
}

function toolbarIconButtonClass(active = false): string {
  return `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition ${
    active
      ? 'bg-accent/10 text-accent'
      : 'hover:bg-white/70 hover:text-ds-ink dark:hover:bg-white/8'
  }`
}

export function WriteWorkspaceView({
  leftSidebarCollapsed,
  onToggleLeftSidebar,
  input,
  setInput,
  onSubmitPrompt
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const ensureWriteThreadForWorkspace = useChatStore((s) => s.ensureWriteThreadForWorkspace)
  const {
    workspaceRoot,
    activeFilePath,
    rootDirectory,
    inlineCompletion,
    inlineCompletionApiReady,
    fileContent,
    fileError,
    fileLoading,
    saveStatus,
    previewMode,
    assistantOpen,
    selection,
    loadWriteSettings,
    addWriteWorkspace,
    setFileContent,
    syncActiveFileFromDisk,
    flushSave,
    createFile,
    refreshWorkspace,
    setPreviewMode,
    setAssistantOpen,
    setSelection,
    quoteCurrentSelection
  } = useWriteWorkspaceStore()
  const saveTimerRef = useRef<number | null>(null)
  const inlineAgentTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [inlineAgentValue, setInlineAgentValue] = useState('')
  const [inlineAgentOpen, setInlineAgentOpen] = useState(false)
  const workspaceReady = workspaceRoot.trim().length > 0
  const isMarkdown = activeFilePath ? isMarkdownFile(activeFilePath) : true
  const saveLabel = formatSaveLabel(saveStatus, t)
  const selectionAction = selection.charCount > 0 ? inlineAgentPosition(selection) : null
  const selectionActionActive = Boolean(selectionAction)
  const selectionActionLeft = selectionAction?.left
  const selectionActionTop = selectionAction?.top
  const activeFileLabel = activeFilePath
    ? writeRelativeToWorkspace(workspaceRoot, activeFilePath)
    : t('writeNoFileOpen')
  const activeFileName = activeFilePath ? writeBasenameFromPath(activeFilePath) : t('writeStudio')

  const createDraftFile = async (): Promise<void> => {
    if (!workspaceReady) {
      await pickWriteWorkspace()
      return
    }
    const root = rootDirectory || workspaceRoot
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = writeJoinPath(root, `draft-${stamp}.md`)
    await createFile(workspaceRoot, path, `# ${t('writeUntitledDraft')}\n\n`)
  }

  const setAssistantPrompt = (prompt: string): void => {
    setAssistantOpen(true)
    setInput(input.trim() ? `${input.trim()}\n\n${prompt}` : prompt)
  }

  const submitInlineAgent = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (!trimmed || !workspaceReady || !activeFilePath) return
    quoteCurrentSelection(workspaceRoot)
    setAssistantOpen(true)
    setInlineAgentValue('')
    setInlineAgentOpen(false)
    if (onSubmitPrompt) {
      onSubmitPrompt(trimmed)
      return
    }
    setInput(input.trim() ? `${input.trim()}\n\n${trimmed}` : trimmed)
  }

  const handleInlineAgentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setInlineAgentOpen(false)
      setInlineAgentValue('')
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submitInlineAgent(inlineAgentValue)
  }

  const pickWriteWorkspace = async (): Promise<void> => {
    if (typeof window.dsGui?.pickWorkspaceDirectory !== 'function') return
    const picked = await window.dsGui.pickWorkspaceDirectory(workspaceRoot || undefined)
    if (!picked.canceled && picked.path) {
      await addWriteWorkspace(picked.path)
      void ensureWriteThreadForWorkspace(picked.path)
    }
  }

  useEffect(() => {
    void loadWriteSettings()
  }, [loadWriteSettings])

  useEffect(() => {
    if (!selectionActionActive || !inlineAgentOpen) return
    window.requestAnimationFrame(() => inlineAgentTextareaRef.current?.focus())
  }, [inlineAgentOpen, selectionActionActive, selectionActionLeft, selectionActionTop])

  useEffect(() => {
    setInlineAgentOpen(false)
    setInlineAgentValue('')
  }, [selection.charCount, selection.text])

  useEffect(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (saveStatus !== 'dirty' || !workspaceReady) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave(workspaceRoot)
    }, WRITE_AUTOSAVE_MS)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [flushSave, saveStatus, workspaceReady, workspaceRoot, fileContent])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    void useWriteWorkspaceStore.getState().flushSave(workspaceRoot)
  }, [workspaceRoot])

  useEffect(() => {
    if (!activeFilePath || !workspaceRoot.trim()) return
    if (
      typeof window.dsGui?.watchWorkspaceFile !== 'function' ||
      typeof window.dsGui?.unwatchWorkspaceFile !== 'function' ||
      typeof window.dsGui?.onWorkspaceFileChanged !== 'function'
    ) {
      return
    }

    let cancelled = false
    let watchId = ''
    const offChanged = window.dsGui.onWorkspaceFileChanged((payload) => {
      if (!watchId || payload.watchId !== watchId) return
      if (payload.ok) {
        void syncActiveFileFromDisk(workspaceRoot, {
          path: payload.path,
          content: payload.content,
          animate: true
        })
        return
      }
      void syncActiveFileFromDisk(workspaceRoot, {
        path: payload.path,
        message: payload.message,
        animate: false
      })
    })

    void window.dsGui.watchWorkspaceFile({ path: activeFilePath, workspaceRoot }).then((result) => {
      if (cancelled) {
        if (result.ok) void window.dsGui.unwatchWorkspaceFile(result.watchId)
        return
      }
      if (result.ok) {
        watchId = result.watchId
      }
    })

    return () => {
      cancelled = true
      offChanged()
      if (watchId) void window.dsGui.unwatchWorkspaceFile(watchId)
    }
  }, [activeFilePath, workspaceRoot, syncActiveFileFromDisk])

  const emptyState = (
    <div className="flex h-full min-h-0 items-center justify-center">
      <div className="max-w-md rounded-[28px] border border-ds-border bg-ds-card/90 px-8 py-8 text-center shadow-[0_22px_56px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">
          <FolderOpen className="h-6 w-6" strokeWidth={1.9} />
        </div>
        <h2 className="mt-5 text-[24px] font-semibold tracking-[-0.04em] text-ds-ink">
          {t('writeEmptyTitle')}
        </h2>
        <p className="mt-3 text-[14.5px] leading-7 text-ds-muted">
          {t('writeEmptySub')}
        </p>
        <button
          type="button"
          onClick={() => void pickWriteWorkspace()}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(0,136,255,0.22)] transition hover:brightness-110"
        >
          <FolderOpen className="h-4 w-4" strokeWidth={1.9} />
          {t('selectWorkspace')}
        </button>
      </div>
    </div>
  )

  if (!workspaceReady) return emptyState

  const editorVisible = previewMode !== 'preview'
  const previewVisible = previewMode === 'split' || previewMode === 'preview'
  const editorWidth = previewMode === 'split'
    ? 'min-w-0 flex-1 basis-1/2 border-r border-ds-border-muted'
    : 'min-w-0 flex-1'
  const previewWidth = previewMode === 'split'
    ? 'min-w-0 flex-1 basis-1/2'
    : 'min-w-0 flex-1'
  const editorAppearance = previewMode === 'source' ? 'source' : 'live'

  const renderModeButton = (
    nextMode: WritePreviewMode,
    label: string,
    icon: ReactElement
  ): ReactElement => (
    <button
      type="button"
      onClick={() => setPreviewMode(nextMode)}
      className={modeButtonClass(previewMode === nextMode)}
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  )

  return (
    <div className="ds-no-drag flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 sm:px-4 md:px-6 lg:px-8">
      <header className="ds-topbar-surface relative z-10 mt-3 flex min-h-[56px] w-full shrink-0 items-stretch overflow-visible rounded-[18px]">
        <div className="grid w-full min-w-0 grid-cols-1 items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={onToggleLeftSidebar}
              className="ds-sidebar-toggle-button shrink-0"
              aria-label={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
            >
              {leftSidebarCollapsed ? (
                <PanelLeftOpen className="h-4 w-4" strokeWidth={1.85} />
              ) : (
                <PanelLeftClose className="h-4 w-4" strokeWidth={1.85} />
              )}
            </button>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <FilePenLine className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1 leading-none">
              <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ds-ink">
                {activeFileName}
              </div>
              <div className="mt-1.5 truncate text-[12px] text-ds-faint">
                {activeFileLabel}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 items-center justify-start gap-1 rounded-xl border border-ds-border-muted bg-white/42 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:bg-white/[0.035] dark:shadow-none sm:justify-end lg:justify-center">
            <button
              type="button"
              onClick={() => setPreviewMode('live')}
              className={`${modeButtonClass(previewMode === 'live')} gap-1.5`}
              title={t('writeModeLive')}
              aria-label={t('writeModeLive')}
            >
              <BookOpen className="h-4 w-4" strokeWidth={1.85} />
              <span className="hidden text-[12.5px] font-semibold sm:inline">{t('writeModeLiveShort')}</span>
            </button>
            {renderModeButton('source', t('writeModeSource'), <FileCode2 className="h-4 w-4" strokeWidth={1.85} />)}
            {renderModeButton('split', t('writeModeSplit'), <Columns2 className="h-4 w-4" strokeWidth={1.85} />)}
            <button
              type="button"
              onClick={() => setPreviewMode('preview')}
              className={modeButtonClass(previewMode === 'preview')}
              title={t('writeModePreview')}
              aria-label={t('writeModePreview')}
            >
              <Eye className="h-4 w-4" strokeWidth={1.85} />
            </button>
          </div>

          <div className="flex min-w-0 items-center justify-start gap-1.5 sm:col-span-2 sm:justify-end lg:col-span-1">
            <button
              type="button"
              onClick={() => void pickWriteWorkspace()}
              className={toolbarIconButtonClass()}
              title={t('changeWorkspace')}
            >
              <FolderOpen className="h-4 w-4" strokeWidth={1.85} />
            </button>
            <button
              type="button"
              onClick={() => setAssistantOpen(!assistantOpen)}
              className={toolbarIconButtonClass(assistantOpen)}
              title={t('writeToggleAssistant')}
              aria-label={t('writeToggleAssistant')}
            >
              <Sparkles className="h-4 w-4" strokeWidth={1.85} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
                void flushSave(workspaceRoot)
              }}
              disabled={!activeFilePath}
              className={`${toolbarIconButtonClass()} disabled:cursor-not-allowed disabled:opacity-40`}
              title={t('writeSaveFile')}
              aria-label={t('writeSaveFile')}
            >
              <Save className="h-4 w-4" strokeWidth={1.85} />
            </button>
            <span className={`ml-1 inline-flex min-w-[64px] justify-center rounded-lg px-2.5 py-1 text-[11.5px] font-semibold ${
              saveStatus === 'error'
                ? 'bg-red-500/12 text-red-600 dark:text-red-300'
                : saveStatus === 'dirty'
                  ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                  : saveStatus === 'saving'
                    ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300'
                    : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
            }`}>
              {saveLabel}
            </span>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden pb-3 pt-3">
        <div className="min-w-0 flex-1 overflow-hidden rounded-[28px] border border-ds-border bg-ds-card/88 shadow-[0_20px_56px_rgba(15,23,42,0.06)] backdrop-blur-xl">
          {!activeFilePath ? (
            <div className="relative flex h-full min-h-[420px] overflow-hidden rounded-[28px] bg-[radial-gradient(circle_at_18%_18%,rgba(0,136,255,0.12),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.74),rgba(255,255,255,0.36))] px-6 py-6 dark:bg-[radial-gradient(circle_at_18%_18%,rgba(56,189,248,0.14),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.07),rgba(255,255,255,0.025))]">
              <div className="pointer-events-none absolute -bottom-28 -right-20 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
              <div className="relative z-10 flex w-full flex-col justify-between">
                <div className="max-w-2xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.16em] text-accent">
                    <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
                    {t('writeStudio')}
                  </div>
                  <h2 className="mt-5 max-w-xl text-[36px] font-semibold leading-[1.04] tracking-[-0.055em] text-ds-ink">
                    {t('writeStartTitle')}
                  </h2>
                  <p className="mt-4 max-w-xl text-[15px] leading-7 text-ds-muted">
                    {t('writeStartSub')}
                  </p>
                </div>

                <div className="mt-8 grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => void createDraftFile()}
                    className="group rounded-[24px] border border-accent/15 bg-white/70 p-4 text-left shadow-[0_18px_42px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:border-accent/35 hover:bg-white/90 dark:bg-white/[0.06] dark:hover:bg-white/[0.09]"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-white shadow-[0_12px_24px_rgba(0,136,255,0.22)]">
                      <FilePlus2 className="h-5 w-5" strokeWidth={1.9} />
                    </span>
                    <span className="mt-4 block text-[15px] font-semibold text-ds-ink">
                      {t('writeStartNewDraft')}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-5 text-ds-faint">
                      {t('writeStartNewDraftSub')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void refreshWorkspace(workspaceRoot)}
                    className="group rounded-[24px] border border-ds-border-muted bg-white/56 p-4 text-left shadow-[0_18px_42px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:bg-white/78 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
                      <RefreshCw className="h-5 w-5" strokeWidth={1.9} />
                    </span>
                    <span className="mt-4 block text-[15px] font-semibold text-ds-ink">
                      {t('writeStartRefresh')}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-5 text-ds-faint">
                      {t('writeStartRefreshSub')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssistantPrompt(t('writeAssistantOutlinePrompt', { file: activeFileLabel }))}
                    className="group rounded-[24px] border border-ds-border-muted bg-white/56 p-4 text-left shadow-[0_18px_42px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:bg-white/78 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                      <ListTodo className="h-5 w-5" strokeWidth={1.9} />
                    </span>
                    <span className="mt-4 block text-[15px] font-semibold text-ds-ink">
                      {t('writeStartAskAi')}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-5 text-ds-faint">
                      {t('writeStartAskAiSub')}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          ) : fileLoading ? (
            <div className="flex h-full min-h-[320px] items-center justify-center text-[14px] text-ds-muted">
              {t('filePreviewLoading')}
            </div>
          ) : (
            <div className="flex h-full min-h-0 min-w-0">
              {editorVisible ? (
                <div className={`${editorWidth} min-h-0 overflow-hidden`}>
                  <WriteMarkdownEditor
                    value={fileContent}
                    workspaceRoot={workspaceRoot}
                    filePath={activeFilePath}
                    appearance={editorAppearance}
                    completionModel={inlineCompletion.model}
                    completionEnabled={inlineCompletion.enabled && inlineCompletionApiReady}
                    completionDebounceMs={inlineCompletion.debounceMs}
                    completionMinAcceptScore={inlineCompletion.minAcceptScore}
                    onChange={setFileContent}
                    onSelectionChange={setSelection}
                    onSaveShortcut={() => {
                      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
                      void flushSave(workspaceRoot)
                    }}
                  />
                </div>
              ) : null}

              {previewVisible ? (
                <div className={`${previewWidth} min-h-0 overflow-y-auto overflow-x-hidden`}>
                  <WriteMarkdownPreview
                    content={fileContent}
                    isMarkdown={isMarkdown}
                    filePath={activeFilePath}
                    previewErrorMessage={t('writePreviewErrorFallback')}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>

      </div>

      {selectionAction && activeFilePath ? (
        <div
          className="write-inline-agent fixed z-50"
          data-origin={selectionAction.origin}
          data-selection-ignore="true"
          style={{ left: selectionAction.left, top: selectionAction.top, width: selectionAction.width }}
        >
          {inlineAgentOpen ? (
            <form
              className="write-inline-agent-form"
              onSubmit={(event) => {
                event.preventDefault()
                submitInlineAgent(inlineAgentValue)
              }}
            >
              <textarea
                ref={inlineAgentTextareaRef}
                rows={1}
                value={inlineAgentValue}
                placeholder={t('writeInlineAgentPlaceholder')}
                aria-label={t('writeInlineAgentPlaceholder')}
                spellCheck={false}
                className="write-inline-agent-input"
                onChange={(event) => setInlineAgentValue(event.target.value)}
                onKeyDown={handleInlineAgentKeyDown}
              />
              <button
                type="submit"
                className="write-inline-agent-submit"
                aria-label={t('writeInlineAgentSend')}
                title={t('writeInlineAgentSend')}
                disabled={!inlineAgentValue.trim()}
              >
                <CornerDownLeft className="h-4 w-4" strokeWidth={2} />
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="write-inline-agent-trigger"
              aria-label={t('writeInlineAgentAskAi')}
              title={t('writeInlineAgentAskAi')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setInlineAgentOpen(true)}
            >
              <MessageSquareQuote className="h-3.5 w-3.5" strokeWidth={1.9} />
              <span>{t('writeInlineAgentAskAi')}</span>
            </button>
          )}
        </div>
      ) : null}

      {fileError ? (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full border border-red-200/70 bg-red-50/92 px-4 py-2 text-[13px] text-red-700 shadow-[0_14px_32px_rgba(15,23,42,0.12)] dark:border-red-900/60 dark:bg-red-950/84 dark:text-red-200">
          {fileError}
        </div>
      ) : null}
    </div>
  )
}
