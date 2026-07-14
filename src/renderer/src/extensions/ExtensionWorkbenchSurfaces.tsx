import {
  Boxes,
  PanelBottom,
  PanelLeft,
  PanelTop,
  Puzzle,
  SquareStack
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { RegisteredContribution } from './contribution-registry'
import { extensionResourceUrl } from './contribution-registry'
import { isExtensionContributionId } from './contribution-ids'
import { boundedPlainText } from './safe-text'

export type ExtensionWorkbenchViewPoint =
  | 'views.leftSidebar'
  | 'views.rightSidebar'
  | 'views.auxiliaryPanel'
  | 'views.editorTab'
  | 'views.fullPage'

export type ExtensionWorkbenchView = RegisteredContribution<ExtensionWorkbenchViewPoint>

export function isExtensionWorkbenchView(
  contribution: RegisteredContribution | undefined
): contribution is ExtensionWorkbenchView {
  return contribution !== undefined && [
    'views.leftSidebar',
    'views.rightSidebar',
    'views.auxiliaryPanel',
    'views.editorTab',
    'views.fullPage'
  ].includes(contribution.point)
}

export type ExtensionWorkbenchViewGroups = {
  leftSidebar: readonly RegisteredContribution<'views.leftSidebar'>[]
  rightSidebar: readonly RegisteredContribution<'views.rightSidebar'>[]
  auxiliaryPanel: readonly RegisteredContribution<'views.auxiliaryPanel'>[]
  editorTab: readonly RegisteredContribution<'views.editorTab'>[]
  fullPage: readonly RegisteredContribution<'views.fullPage'>[]
}

export type ExtensionRightContainerTarget = {
  container: RegisteredContribution<'views.containers'>
  target: RegisteredContribution<'views.rightSidebar'>
}

export function resolveCommandOpenView(
  commandId: string,
  result: unknown,
  commands: readonly RegisteredContribution<'commands'>[],
  views: readonly ExtensionWorkbenchView[]
): ExtensionWorkbenchView | undefined {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !('action' in result) ||
    result.action !== 'open-view' ||
    !('viewId' in result) ||
    typeof result.viewId !== 'string'
  ) return undefined
  const command = commands.find((candidate) => candidate.id === commandId)
  if (command?.owner.kind !== 'extension') return undefined
  const extensionId = command.owner.extensionId
  return views.find((candidate) =>
    candidate.owner.kind === 'extension' &&
    candidate.owner.extensionId === extensionId &&
    candidate.payload.id === result.viewId
  )
}

export const EXTENSION_SURFACE_LAYOUT_STORAGE_KEY = 'kun.extension.surface-layout.v1'

export function readStoredExtensionSurfaceId(
  storage: Pick<Storage, 'getItem'>
): string | null {
  try {
    const raw = storage.getItem(EXTENSION_SURFACE_LAYOUT_STORAGE_KEY)
    return raw && isExtensionContributionId(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeStoredExtensionSurfaceId(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  contributionId: string | null
): void {
  try {
    if (contributionId && isExtensionContributionId(contributionId)) {
      storage.setItem(EXTENSION_SURFACE_LAYOUT_STORAGE_KEY, contributionId)
    } else {
      storage.removeItem(EXTENSION_SURFACE_LAYOUT_STORAGE_KEY)
    }
  } catch {
    // Layout persistence is best-effort; contribution visibility remains
    // controlled by the live registry and never trusts this value.
  }
}

const SURFACE_GROUPS: ReadonlyArray<{
  key: keyof ExtensionWorkbenchViewGroups
  title: string
}> = [
  { key: 'leftSidebar', title: 'Left sidebar' },
  { key: 'rightSidebar', title: 'Right sidebar' },
  { key: 'auxiliaryPanel', title: 'Auxiliary panel' },
  { key: 'editorTab', title: 'Editor' },
  { key: 'fullPage', title: 'Full page' }
]

function sameExtension(
  container: RegisteredContribution<'views.containers'>,
  view: ExtensionWorkbenchView
): boolean {
  return container.owner.kind === 'extension' &&
    view.owner.kind === 'extension' &&
    container.owner.extensionId === view.owner.extensionId
}

export function viewBelongsToContainer(
  container: RegisteredContribution<'views.containers'>,
  view: ExtensionWorkbenchView
): boolean {
  if (!sameExtension(container, view) || typeof view.payload.container !== 'string') return false
  return view.payload.container === container.payload.id || view.payload.container === container.id
}

export function firstViewForContainer(
  container: RegisteredContribution<'views.containers'>,
  groups: ExtensionWorkbenchViewGroups
): ExtensionWorkbenchView | undefined {
  const candidates = container.payload.location === 'leftSidebar'
    ? groups.leftSidebar
    : container.payload.location === 'rightSidebar'
      ? groups.rightSidebar
      : [
          ...groups.leftSidebar,
          ...groups.rightSidebar,
          ...groups.auxiliaryPanel,
          ...groups.editorTab,
          ...groups.fullPage
        ]
  return candidates.find((view) => viewBelongsToContainer(container, view))
}

function SurfaceIcon({ view }: { view: ExtensionWorkbenchView }): ReactElement {
  if (view.owner.kind === 'extension' && view.payload.icon) {
    return (
      <img
        src={extensionResourceUrl(view.owner.extensionId, view.payload.icon)}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 object-contain"
      />
    )
  }
  if (view.point === 'views.leftSidebar') return <PanelLeft className="h-4 w-4" aria-hidden />
  if (view.point === 'views.auxiliaryPanel') return <PanelBottom className="h-4 w-4" aria-hidden />
  if (view.point === 'views.editorTab') return <SquareStack className="h-4 w-4" aria-hidden />
  if (view.point === 'views.fullPage') return <PanelTop className="h-4 w-4" aria-hidden />
  return <Puzzle className="h-4 w-4" aria-hidden />
}

function ContainerIcon({
  container
}: {
  container: RegisteredContribution<'views.containers'>
}): ReactElement {
  if (container.owner.kind === 'extension' && container.payload.icon) {
    return (
      <img
        src={extensionResourceUrl(container.owner.extensionId, container.payload.icon)}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 object-contain"
      />
    )
  }
  return <Boxes className="h-4 w-4" aria-hidden />
}

export function ExtensionActivityBar({
  containers,
  groups,
  activeId,
  onOpen
}: {
  containers: readonly RegisteredContribution<'views.containers'>[]
  groups: ExtensionWorkbenchViewGroups
  activeId?: string | null
  onOpen: (view: ExtensionWorkbenchView) => void
}): ReactElement | null {
  const [launcherOpen, setLauncherOpen] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const allViews = useMemo<ExtensionWorkbenchView[]>(
    () => [
      ...groups.leftSidebar,
      ...groups.auxiliaryPanel,
      ...groups.editorTab,
      ...groups.fullPage
    ],
    [groups]
  )
  const containerTargets = useMemo(
    () => containers.filter((container) => container.payload.location !== 'rightSidebar').flatMap((container) => {
      const target = firstViewForContainer(container, groups)
      return target ? [{ container, target }] : []
    }),
    [containers, groups]
  )

  useEffect(() => {
    if (!launcherOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setLauncherOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLauncherOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [launcherOpen])

  if (containerTargets.length === 0 && allViews.length === 0) return null

  const open = (view: ExtensionWorkbenchView): void => {
    setLauncherOpen(false)
    onOpen(view)
  }

  return (
    <aside
      ref={rootRef}
      aria-label="Extension activity"
      className="ds-no-drag relative z-30 flex h-full w-12 shrink-0 flex-col items-center gap-1.5 border-r border-ds-border-muted bg-white/80 py-3 backdrop-blur-xl dark:bg-ds-canvas"
    >
      <div aria-hidden className="ds-titlebar-safe-block w-full shrink-0" />
      {containerTargets.map(({ container, target }) => {
        const title = boundedPlainText(container.payload.title, 128)
        return (
          <button
            key={container.id}
            type="button"
            onClick={() => open(target)}
            aria-label={title}
            aria-pressed={activeId === target.id}
            data-tooltip={title}
            data-contribution-id={container.id}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${
              activeId === target.id
                ? 'bg-accent/12 text-accent'
                : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
            }`}
          >
            <ContainerIcon container={container} />
          </button>
        )
      })}

      {containerTargets.length > 0 ? <div className="my-0.5 h-px w-6 bg-ds-border-muted" /> : null}

      <button
        type="button"
        onClick={() => setLauncherOpen((value) => !value)}
        aria-label="Open extension Views"
        aria-expanded={launcherOpen}
        data-tooltip="Extension Views"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${
          launcherOpen ? 'bg-accent/12 text-accent' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
        }`}
      >
        <Puzzle className="h-4 w-4" aria-hidden />
      </button>

      {launcherOpen ? (
        <div
          role="dialog"
          aria-label="Extension Views"
          className="ds-card-strong absolute left-full top-3 z-50 ml-2 max-h-[min(620px,calc(100vh-2rem))] w-72 overflow-y-auto rounded-2xl border border-ds-border p-2 shadow-2xl"
        >
          {SURFACE_GROUPS.map(({ key, title }) => {
            if (key === 'rightSidebar') return null
            const views = groups[key]
            if (views.length === 0) return null
            return (
              <section key={key} className="py-1" aria-label={title}>
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ds-faint">
                  {title}
                </div>
                {views.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    onClick={() => open(view)}
                    aria-pressed={activeId === view.id}
                    data-contribution-id={view.id}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12px] transition ${
                      activeId === view.id
                        ? 'bg-accent/10 text-accent'
                        : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                    }`}
                  >
                    <SurfaceIcon view={view} />
                    <span className="min-w-0 flex-1 truncate">
                      {boundedPlainText(view.payload.title, 128)}
                    </span>
                    {view.owner.kind === 'extension' ? (
                      <span className="max-w-20 truncate text-[9px] text-ds-faint">
                        {view.owner.extensionId}
                      </span>
                    ) : null}
                  </button>
                ))}
              </section>
            )
          })}
        </div>
      ) : null}
    </aside>
  )
}
