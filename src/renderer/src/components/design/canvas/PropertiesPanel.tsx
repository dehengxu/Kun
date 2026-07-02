import { memo, useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Monitor, PenLine, Pin, PinOff, Play, Smartphone, Sparkles, Tablet, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCanvasSelectionStore } from '../../../design/canvas/canvas-selection-store'
import { useCanvasShapeStore } from '../../../design/canvas/canvas-shape-store'
import { useCanvasUndoStore } from '../../../design/canvas/canvas-undo-store'
import {
  DEFAULT_FILL,
  fillColor as resolveFillColor,
  isHtmlFrame,
  isImplicitImageSlot,
  type Arrowhead,
  type CanvasShape,
  type DevicePreset,
  type Fill,
  type Stroke,
  type StrokeDash
} from '../../../design/canvas/canvas-types'
import { useDesignWorkspaceStore } from '../../../design/design-workspace-store'
import type { DesignArtifact } from '../../../design/design-types'

const MIXED = '__mixed__'

// Deliberate 5-color palette, excalidraw style. No rainbow.
const SWATCHES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00']

function reduceField<T>(shapes: CanvasShape[], getter: (s: CanvasShape) => T): T | typeof MIXED | undefined {
  if (shapes.length === 0) return undefined
  const first = getter(shapes[0])
  for (let i = 1; i < shapes.length; i++) {
    if (getter(shapes[i]) !== first) return MIXED
  }
  return first
}

function commitUpdate(label: string, ids: string[], patch: Partial<CanvasShape>): void {
  if (ids.length === 0) return
  useCanvasUndoStore.getState().withGroup(label, () => {
    const store = useCanvasShapeStore.getState()
    for (const id of ids) {
      store.updateShape(id, patch)
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Atoms
// ────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <section className="space-y-2">
      {title || action ? (
        <div className="flex h-4 items-center justify-between">
          {title ? (
            <h3 className="select-none text-[10px] font-medium uppercase tracking-[0.08em] text-ds-faint">
              {title}
            </h3>
          ) : (
            <span />
          )}
          {action ?? null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

function NumberBox({
  icon,
  value,
  onCommit,
  step = 1,
  min
}: {
  icon: string
  value: number | typeof MIXED | undefined
  onCommit: (n: number) => void
  step?: number
  min?: number
}): ReactElement {
  const display =
    value === MIXED ? '' : value === undefined ? '' : String(Math.round((value as number) * 100) / 100)
  return (
    <label className="group flex h-7 min-w-0 items-center gap-1 rounded-[8px] bg-transparent px-1.5 transition hover:bg-ds-hover/60 focus-within:bg-ds-hover/70">
      <span className="w-3 shrink-0 text-center text-[10px] font-medium text-ds-faint group-focus-within:text-ds-muted">
        {icon}
      </span>
      <input
        type="number"
        step={step}
        {...(min !== undefined ? { min } : {})}
        value={display}
        placeholder={value === MIXED ? '—' : '0'}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          if (!Number.isFinite(n)) return
          onCommit(n)
        }}
        className="min-w-0 flex-1 bg-transparent text-[11.5px] tabular-nums text-ds-ink outline-none placeholder:text-ds-faint"
      />
    </label>
  )
}

function Seg<T extends string | number>({
  value,
  options,
  onPick
}: {
  value: T | typeof MIXED | undefined
  options: { value: T; render: ReactNode; label: string }[]
  onPick: (v: T) => void
}): ReactElement {
  return (
    <div className="flex items-center gap-0.5 rounded-[10px] bg-ds-hover/35 p-0.5 dark:bg-white/5">
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onPick(o.value)}
            title={o.label}
            aria-label={o.label}
            className={`flex h-7 flex-1 items-center justify-center rounded-[8px] transition ${
              active
                ? 'bg-white text-ds-ink shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-white/12 dark:text-ds-ink'
                : 'text-ds-muted hover:text-ds-ink'
            }`}
          >
            {o.render}
          </button>
        )
      })}
    </div>
  )
}

function Swatches({
  value,
  onPick,
  showClear,
  onClear
}: {
  value: string | typeof MIXED | undefined
  onPick: (c: string) => void
  showClear?: boolean
  onClear?: () => void
}): ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      {SWATCHES.map((c) => {
        const active = value === c
        return (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            title={c}
            aria-label={c}
            className={`relative h-5 w-5 shrink-0 rounded-[6px] transition ${
              active
                ? 'shadow-[0_0_0_2px_white,0_0_0_3px_var(--accent,#5b6dd1)] dark:shadow-[0_0_0_2px_var(--ds-canvas,#0f1116),0_0_0_3px_var(--accent,#7c8bf5)]'
                : 'shadow-[inset_0_0_0_1px_rgba(15,23,42,0.14)] hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.28)]'
            }`}
            style={{ background: c }}
          />
        )
      })}
      {showClear && onClear ? (
        <button
          type="button"
          onClick={onClear}
          title="无"
          aria-label="无"
          className="relative h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.14)] hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.28)] dark:bg-ds-card"
        >
          <svg viewBox="0 0 20 20" className="absolute inset-0">
            <line x1="3.5" y1="16.5" x2="16.5" y2="3.5" stroke="#e03131" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

function HexInput({
  value,
  onCommit
}: {
  value: string | typeof MIXED | undefined
  onCommit: (c: string) => void
}): ReactElement {
  const [local, setLocal] = useState<string | null>(null)
  const display = local ?? (value === MIXED ? '' : (value as string) ?? '')
  const placeholder = value === MIXED ? '—' : '#000000'
  return (
    <input
      type="text"
      value={display}
      spellCheck={false}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={(e) => {
        setLocal(null)
        const v = e.target.value.trim()
        if (v && /^#?[0-9a-fA-F]{3,8}$/.test(v)) {
          onCommit(v.startsWith('#') ? v : `#${v}`)
        }
      }}
      placeholder={placeholder}
      className="h-7 w-full rounded-[8px] bg-transparent px-2 text-[11px] font-mono lowercase text-ds-muted outline-none transition hover:bg-ds-hover/60 focus:bg-ds-hover/70 placeholder:text-ds-faint"
    />
  )
}

function OpacitySlider({
  value,
  onChange
}: {
  value: number | typeof MIXED | undefined
  onChange: (n: number) => void
}): ReactElement {
  const mixed = value === MIXED
  const num = mixed || value === undefined ? 100 : Math.round((value as number) * 100)
  return (
    <div className="space-y-0.5">
      <input
        type="range"
        min={0}
        max={100}
        value={num}
        onChange={(e) => onChange(Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
        className="canvas-inspector-range w-full"
      />
      <div className="flex items-center justify-between text-[10px] tabular-nums text-ds-faint">
        <span>0</span>
        <span className={mixed ? '' : 'text-ds-muted'}>{mixed ? '—' : `${num}`}</span>
        <span>100</span>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// SVG icon sets
// ────────────────────────────────────────────────────────────────────────────

function Line({
  strokeWidth,
  dash
}: {
  strokeWidth: number
  dash?: string
}): ReactElement {
  return (
    <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
      <line
        x1="3"
        y1="5"
        x2="21"
        y2="5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        {...(dash ? { strokeDasharray: dash } : {})}
      />
    </svg>
  )
}

const WIDTH_OPTIONS: { value: number; label: string; render: ReactNode }[] = [
  { value: 1, label: 'Thin', render: <Line strokeWidth={1.25} /> },
  { value: 2, label: 'Medium', render: <Line strokeWidth={2.25} /> },
  { value: 4, label: 'Bold', render: <Line strokeWidth={3.5} /> }
]

const DASH_OPTIONS: { value: StrokeDash; label: string; render: ReactNode }[] = [
  { value: 'solid', label: 'Solid', render: <Line strokeWidth={1.75} /> },
  { value: 'dashed', label: 'Dashed', render: <Line strokeWidth={1.75} dash="3.5 3" /> },
  { value: 'dotted', label: 'Dotted', render: <Line strokeWidth={1.75} dash="0.5 3" /> }
]

function arrowheadIcon(style: Arrowhead, flip: boolean): ReactElement {
  // 24x10 viewBox. Stem horizontal y=5; decoration at one end. `flip` swaps the
  // decoration side so the start picker mirrors the end picker visually.
  const tipX = flip ? 3 : 21
  const stemFrom = flip ? 6 : 3
  const stemTo = flip ? 21 : 18
  const inward = flip ? 1 : -1
  const stem = (
    <line
      x1={stemFrom}
      y1="5"
      x2={stemTo}
      y2="5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  )
  switch (style) {
    case 'none':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          <line x1="3" y1="5" x2="21" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'arrow':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          {stem}
          <path
            d={`M ${tipX + inward * 4} 1.8 L ${tipX} 5 L ${tipX + inward * 4} 8.2`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'triangle':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          {stem}
          <path
            d={`M ${tipX} 5 L ${tipX + inward * 5} 1.5 L ${tipX + inward * 5} 8.5 Z`}
            fill="currentColor"
          />
        </svg>
      )
    case 'circle':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          {stem}
          <circle cx={tipX} cy="5" r="2.4" fill="currentColor" />
        </svg>
      )
    case 'bar':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          {stem}
          <line x1={tipX} y1="1.5" x2={tipX} y2="8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    case 'diamond':
      return (
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
          {stem}
          <path
            d={`M ${tipX} 5 L ${tipX + inward * 3} 2.2 L ${tipX + inward * 6} 5 L ${tipX + inward * 3} 7.8 Z`}
            fill="currentColor"
          />
        </svg>
      )
  }
}

function arrowheadOptions(flip: boolean): { value: Arrowhead; label: string; render: ReactNode }[] {
  const styles: Arrowhead[] = ['none', 'arrow', 'triangle', 'circle', 'bar', 'diamond']
  return styles.map((s) => ({ value: s, label: s, render: arrowheadIcon(s, flip) }))
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

type Props = {
  onImplementDesign?: (artifact: DesignArtifact) => void
}

function PropertiesPanelInner({ onImplementDesign }: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds)
  const document = useCanvasShapeStore((s) => s.document)
  const pinned = useDesignWorkspaceStore((s) => s.canvasInspectorPinned)
  const setPinned = useDesignWorkspaceStore((s) => s.setCanvasInspectorPinned)
  const setDesignIntentMode = useDesignWorkspaceStore((s) => s.setDesignIntentMode)
  const setCanvasAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen)

  const ids = useMemo(() => Array.from(selectedIds), [selectedIds])
  const shapes = useMemo(
    () => ids.map((id) => document.objects[id]).filter((s): s is CanvasShape => Boolean(s)),
    [ids, document]
  )

  const updateAll = useCallback(
    (label: string, patch: Partial<CanvasShape>) => commitUpdate(label, ids, patch),
    [ids]
  )

  if (shapes.length === 0) return null

  const renderShell = (children: ReactNode): ReactElement => (
    <aside className="ds-no-drag absolute bottom-[104px] right-[76px] top-[72px] z-40 flex w-[252px] flex-col overflow-hidden rounded-[18px] border border-ds-border-muted bg-white/82 text-[12px] text-ds-ink shadow-[0_18px_48px_rgba(20,47,95,0.12)] backdrop-blur-2xl dark:bg-ds-canvas/88 max-lg:bottom-[116px] max-lg:top-[76px]">
      <div className="flex h-9 shrink-0 items-center justify-between px-4">
        <span className="select-none text-[11px] font-medium uppercase tracking-[0.1em] text-ds-faint">
          {t('canvasInspectorTitle', 'Properties')}
          {shapes.length > 1 ? (
            <span className="ml-1 normal-case tracking-normal text-ds-faint">· {shapes.length}</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => setPinned(!pinned)}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] transition ${
            pinned ? 'text-accent' : 'text-ds-faint hover:bg-ds-hover hover:text-ds-ink'
          }`}
          title={pinned ? t('canvasInspectorUnpin') : t('canvasInspectorPin')}
          aria-label={pinned ? t('canvasInspectorUnpin') : t('canvasInspectorPin')}
        >
          {pinned ? <PinOff className="h-3.5 w-3.5" strokeWidth={1.8} /> : <Pin className="h-3.5 w-3.5" strokeWidth={1.8} />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
    </aside>
  )

  const x = reduceField(shapes, (s) => s.x)
  const y = reduceField(shapes, (s) => s.y)
  const w = reduceField(shapes, (s) => s.width)
  const h = reduceField(shapes, (s) => s.height)
  const rot = reduceField(shapes, (s) => s.rotation || 0)
  const opacity = reduceField(shapes, (s) => s.opacity)
  const cornerR = reduceField(shapes, (s) =>
    typeof s.cornerRadius === 'number' ? s.cornerRadius : s.cornerRadius[0]
  )

  const firstFill: Fill | undefined = shapes[0]?.fills[0]
  const fillColor = reduceField(shapes, (s) => resolveFillColor(s.fills[0]) ?? undefined)

  const firstStroke: Stroke | undefined = shapes[0]?.strokes[0]
  const strokeColor = reduceField(shapes, (s) => s.strokes[0]?.color)
  const strokeWidth = reduceField(shapes, (s) => s.strokes[0]?.width ?? 0)
  const strokeDash = reduceField(shapes, (s) => s.strokes[0]?.dash ?? 'solid')

  const isLinear = shapes.length > 0 && shapes.every((s) => s.type === 'arrow' || s.type === 'line')
  const arrowheadStart = isLinear ? reduceField(shapes, (s) => s.arrowheadStart ?? 'none') : undefined
  const arrowheadEnd = isLinear
    ? reduceField(shapes, (s) => s.arrowheadEnd ?? (s.type === 'arrow' ? 'arrow' : 'none'))
    : undefined

  const allText = shapes.every((s) => s.type === 'text')
  const fontSize = allText ? reduceField(shapes, (s) => s.fontSize ?? 16) : undefined
  const fontFamily = allText ? reduceField(shapes, (s) => s.fontFamily ?? '') : undefined
  const fontWeight = allText ? reduceField(shapes, (s) => s.fontWeight ?? 400) : undefined
  const fontColor = allText ? reduceField(shapes, (s) => s.fontColor ?? '#000000') : undefined

  const singleHtmlFrame = shapes.length === 1 && isHtmlFrame(shapes[0]) ? shapes[0] : null
  const linkedArtifact = singleHtmlFrame
    ? useDesignWorkspaceStore.getState().artifacts.find((a) => a.id === singleHtmlFrame.htmlArtifactId)
    : null

  const requestScreenModify = (): void => {
    setDesignIntentMode('modify')
    setCanvasAssistantOpen(true)
    requestAnimationFrame(() => {
      globalThis.document
        .querySelector<HTMLTextAreaElement>('[data-design-rail-composer] textarea')
        ?.focus()
    })
  }

  // AI image holder: only fillable boxes (image/frame/rect) can be a slot the
  // agent fills. The marking flows into the AI snapshot so "fill this" resolves.
  const canBeHolder =
    !singleHtmlFrame &&
    shapes.every((s) => s.type === 'image' || s.type === 'frame' || s.type === 'rect')
  const aiHolder = reduceField(shapes, (s) => Boolean(s.aiImageHolder))
  // Empty boxes are implicit slots: the agent fills a selected empty box on
  // request automatically, so no manual marking is needed for the common case.
  const allEmptySlots = canBeHolder && shapes.every(isImplicitImageSlot)

  const DEVICE_PRESETS: { id: DevicePreset; icon: typeof Monitor; w: number; h: number }[] = [
    { id: 'mobile', icon: Smartphone, w: 390, h: 844 },
    { id: 'tablet', icon: Tablet, w: 768, h: 1024 },
    { id: 'desktop', icon: Monitor, w: 1280, h: 800 }
  ]

  return renderShell(
    <div className="space-y-4 pt-1">
      {/* Position & size */}
      <Section title={t('canvasInspectorPosition', 'Position & size')}>
        <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
          <NumberBox icon="X" value={x} onCommit={(n) => updateAll('set-x', { x: n })} />
          <NumberBox icon="Y" value={y} onCommit={(n) => updateAll('set-y', { y: n })} />
          <NumberBox
            icon="W"
            value={w}
            min={1}
            onCommit={(n) => updateAll('set-w', { width: Math.max(1, n) })}
          />
          <NumberBox
            icon="H"
            value={h}
            min={1}
            onCommit={(n) => updateAll('set-h', { height: Math.max(1, n) })}
          />
        </div>
        <NumberBox
          icon="↻"
          value={rot}
          onCommit={(n) => updateAll('set-rotation', { rotation: ((n % 360) + 360) % 360 })}
        />
      </Section>

      {singleHtmlFrame && (
        <Section title={t('canvasInspectorScreen', 'Screen')}>
          <div className="flex items-center gap-1 rounded-[10px] bg-ds-hover/35 p-0.5 dark:bg-white/5">
            {DEVICE_PRESETS.map(({ id, icon: Icon, w: dw, h: dh }) => {
              const active = singleHtmlFrame.devicePreset === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    updateAll('set-device-preset', { devicePreset: id, width: dw, height: dh })
                  }
                  title={id}
                  className={`flex h-7 flex-1 items-center justify-center rounded-[8px] transition ${
                    active
                      ? 'bg-white text-ds-ink shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-white/12'
                      : 'text-ds-muted hover:text-ds-ink'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )
            })}
          </div>
          {linkedArtifact && (
            <div className="rounded-[8px] bg-ds-hover/40 px-2 py-1.5 text-[11px] text-ds-muted">
              <div className="truncate font-medium text-ds-ink">{linkedArtifact.title}</div>
              <div className="mt-0.5 truncate text-ds-faint">{linkedArtifact.relativePath}</div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={requestScreenModify}
              className="flex h-8 items-center justify-center gap-1.5 rounded-[8px] bg-ds-hover/35 text-[11.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <PenLine className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t('designProjectModify')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (linkedArtifact) onImplementDesign?.(linkedArtifact)
              }}
              disabled={!linkedArtifact || !onImplementDesign}
              className="flex h-8 items-center justify-center gap-1.5 rounded-[8px] bg-ds-hover/35 text-[11.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t('designImplement')}
            </button>
          </div>
        </Section>
      )}

      {/* AI image slot — an empty selected box is auto-filled on request; a
          filled box can still be marked manually as a regenerate target. */}
      {canBeHolder && (
        <Section title={t('canvasInspectorAiHolder', 'AI image')}>
          {allEmptySlots ? (
            <div className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] bg-accent-soft text-[11.5px] font-medium text-accent shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
              {t('canvasInspectorAiHolderAuto', 'Empty box · auto image slot')}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => updateAll('toggle-ai-holder', { aiImageHolder: aiHolder !== true })}
              className={`flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] text-[11.5px] font-medium transition ${
                aiHolder === true
                  ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]'
                  : 'bg-ds-hover/30 text-ds-faint hover:bg-ds-hover/60 hover:text-ds-ink'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
              {aiHolder === true
                ? t('canvasInspectorAiHolderOn', 'AI image slot · on')
                : t('canvasInspectorAiHolderMark', 'Mark as AI image slot')}
            </button>
          )}
          <p className="mt-1 text-[10.5px] leading-4 text-ds-faint">
            {allEmptySlots
              ? t(
                  'canvasInspectorAiHolderAutoHint',
                  'Just ask the assistant to generate — it fills this box automatically. No marking needed.'
                )
              : t(
                  'canvasInspectorAiHolderHint',
                  'Keep it selected and ask the assistant to generate — it fills this slot.'
                )}
          </p>
        </Section>
      )}

      {/* Fill — non-frame, non-linear shapes */}
      {shapes.some((s) => s.type !== 'group') && !singleHtmlFrame && !isLinear && (
        <Section title={t('canvasInspectorFill', 'Fill')}>
          {firstFill ? (
            <div className="space-y-1.5">
              <Swatches
                value={fillColor}
                onPick={(c) =>
                  updateAll('set-fill-color', {
                    fills: [{ type: 'solid', color: c, opacity: firstFill.opacity }]
                  })
                }
                showClear
                onClear={() => updateAll('clear-fill', { fills: [] })}
              />
              <HexInput
                value={fillColor}
                onCommit={(c) =>
                  updateAll('set-fill-color', {
                    fills: [{ type: 'solid', color: c, opacity: firstFill.opacity }]
                  })
                }
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => updateAll('add-fill', { fills: [{ ...DEFAULT_FILL }] })}
              className="h-7 w-full rounded-[8px] bg-ds-hover/30 text-[11px] text-ds-faint transition hover:bg-ds-hover/60 hover:text-ds-ink"
            >
              + {t('canvasInspectorAddFill', 'Add fill')}
            </button>
          )}
        </Section>
      )}

      {/* Stroke */}
      {!singleHtmlFrame && (
        <Section
          title={t('canvasInspectorStroke', 'Stroke')}
          action={
            firstStroke ? (
              <button
                type="button"
                onClick={() => updateAll('clear-stroke', { strokes: [] })}
                className="text-ds-faint transition hover:text-ds-ink"
                title={t('canvasInspectorRemoveStroke', 'Remove stroke')}
              >
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            ) : null
          }
        >
          {firstStroke ? (
            <div className="space-y-2">
              <Swatches
                value={strokeColor}
                onPick={(c) =>
                  updateAll('set-stroke-color', { strokes: [{ ...firstStroke, color: c }] })
                }
              />
              <HexInput
                value={strokeColor}
                onCommit={(c) =>
                  updateAll('set-stroke-color', { strokes: [{ ...firstStroke, color: c }] })
                }
              />
              <Seg
                value={strokeWidth as number | typeof MIXED | undefined}
                options={WIDTH_OPTIONS}
                onPick={(wv) =>
                  updateAll('set-stroke-width', { strokes: [{ ...firstStroke, width: wv }] })
                }
              />
              <Seg
                value={strokeDash as StrokeDash | typeof MIXED | undefined}
                options={DASH_OPTIONS}
                onPick={(v) => updateAll('set-stroke-dash', { strokes: [{ ...firstStroke, dash: v }] })}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() =>
                updateAll('add-stroke', {
                  strokes: [{ color: '#1e1e1e', width: 2, opacity: 1, position: 'center', dash: 'solid' }]
                })
              }
              className="h-7 w-full rounded-[8px] bg-ds-hover/30 text-[11px] text-ds-faint transition hover:bg-ds-hover/60 hover:text-ds-ink"
            >
              + {t('canvasInspectorAddStroke', 'Add stroke')}
            </button>
          )}
        </Section>
      )}

      {/* Linear: arrowheads */}
      {isLinear && (
        <Section title={t('canvasInspectorLine', 'Line')}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[10px] uppercase tracking-[0.05em] text-ds-faint">
                {t('canvasInspectorArrowStart', 'Start')}
              </span>
              <div className="min-w-0 flex-1">
                <Seg
                  value={arrowheadStart as Arrowhead | typeof MIXED | undefined}
                  options={arrowheadOptions(true)}
                  onPick={(a) => updateAll('set-arrowhead-start', { arrowheadStart: a })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[10px] uppercase tracking-[0.05em] text-ds-faint">
                {t('canvasInspectorArrowEnd', 'End')}
              </span>
              <div className="min-w-0 flex-1">
                <Seg
                  value={arrowheadEnd as Arrowhead | typeof MIXED | undefined}
                  options={arrowheadOptions(false)}
                  onPick={(a) => updateAll('set-arrowhead-end', { arrowheadEnd: a })}
                />
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* Corner radius — boxy shapes only */}
      {!singleHtmlFrame && !isLinear && (
        <Section title={t('canvasInspectorCorner', 'Corner radius')}>
          <NumberBox
            icon="R"
            value={cornerR}
            min={0}
            onCommit={(n) => updateAll('set-corner-radius', { cornerRadius: Math.max(0, n) })}
          />
        </Section>
      )}

      {/* Opacity */}
      <Section title={t('canvasInspectorOpacity', 'Opacity')}>
        <OpacitySlider
          value={opacity}
          onChange={(v) => updateAll('set-opacity', { opacity: v })}
        />
      </Section>

      {/* Text */}
      {allText && (
        <Section title={t('canvasInspectorText', 'Text')}>
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
              <NumberBox
                icon="A"
                value={fontSize}
                min={1}
                onCommit={(n) => updateAll('set-font-size', { fontSize: Math.max(1, n) })}
              />
              <NumberBox
                icon="W"
                value={fontWeight}
                step={100}
                onCommit={(n) =>
                  updateAll('set-font-weight', { fontWeight: Math.max(100, Math.min(900, n)) })
                }
              />
            </div>
            <input
              type="text"
              value={fontFamily === MIXED ? '' : ((fontFamily as string) ?? '')}
              placeholder={fontFamily === MIXED ? '—' : 'font-family'}
              onChange={(e) => updateAll('set-font-family', { fontFamily: e.target.value })}
              className="h-7 w-full rounded-[8px] bg-transparent px-2 text-[11.5px] text-ds-ink outline-none transition hover:bg-ds-hover/60 focus:bg-ds-hover/70 placeholder:text-ds-faint"
            />
            <Swatches
              value={fontColor}
              onPick={(c) => updateAll('set-font-color', { fontColor: c })}
            />
          </div>
        </Section>
      )}
    </div>
  )
}

export const PropertiesPanel = memo(PropertiesPanelInner)
