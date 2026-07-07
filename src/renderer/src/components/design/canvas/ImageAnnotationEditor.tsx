import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowUpRight, Check, Loader2, Pencil, Square, Trash2, Type, Undo2, X } from 'lucide-react'
import { loadWorkspaceImageDataUrl } from '../../../design/canvas/canvas-image-source'

/**
 * Full-screen image annotation editor. The user draws markup (freehand, arrows,
 * boxes, text) directly over a canvas picture; on 应用 the picture + markup are
 * flattened into one PNG and handed back, so the design agent can re-edit the
 * image with the marks as instructions (image-to-image). Annotations are kept as
 * lightweight vector ops (cheap undo, re-rendered each frame) and rasterised only
 * at apply time — never the live `<canvas>` pixels, which keeps undo exact.
 */

type AnnotationTool = 'pen' | 'arrow' | 'rect' | 'text'

type Point = { x: number; y: number }

type AnnotationOp =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'arrow'; color: string; width: number; from: Point; to: Point }
  | { kind: 'rect'; color: string; width: number; from: Point; to: Point }
  | { kind: 'text'; color: string; x: number; y: number; text: string; fontSize: number }

export type ImageAnnotationResult = {
  /** Base64 PNG bytes of the flattened picture + markup (no `data:` prefix). */
  dataBase64: string
  mimeType: 'image/png'
  /** Verbatim text labels the user typed onto the image. */
  textNotes: string[]
  /** Free-form instruction typed in the editor's field. */
  instruction: string
}

type Props = {
  imageUrl: string
  workspaceRoot: string
  title?: string
  busy?: boolean
  onCancel: () => void
  onApply: (result: ImageAnnotationResult) => void
}

const SWATCHES: { name: string; value: string }[] = [
  { name: '红', value: '#ef4444' },
  { name: '橙', value: '#f59e0b' },
  { name: '绿', value: '#22c55e' },
  { name: '蓝', value: '#3b82f6' },
  { name: '黑', value: '#111827' },
  { name: '白', value: '#ffffff' }
]

const MAX_FLATTEN_DIM = 1280

const TOOLS: { tool: AnnotationTool; label: string; Icon: typeof Pencil }[] = [
  { tool: 'pen', label: '画笔', Icon: Pencil },
  { tool: 'arrow', label: '箭头', Icon: ArrowUpRight },
  { tool: 'rect', label: '方框', Icon: Square },
  { tool: 'text', label: '文字', Icon: Type }
]

export const IMAGE_ANNOTATION_ROOT_CLASS =
  'ds-no-drag fixed inset-0 z-[200] flex flex-col bg-black/75 backdrop-blur-sm'

export const IMAGE_ANNOTATION_TOP_BAR_CLASS =
  'ds-drag flex shrink-0 items-center justify-between gap-3 py-3 pr-5 text-white'

export const IMAGE_ANNOTATION_INSTRUCTION_INPUT_CLASS =
  'ds-no-drag relative z-10 w-[min(560px,calc(100vw-3rem))] appearance-none rounded-full border border-white/25 bg-white/10 px-4 py-2.5 text-[13px] text-white caret-white outline-none transition placeholder:text-white/55 focus:border-white/55 focus:bg-white/15 disabled:cursor-wait disabled:opacity-60'

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  width: number
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const head = Math.max(10, width * 4)
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
  ctx.stroke()
}

function paintOp(ctx: CanvasRenderingContext2D, op: AnnotationOp): void {
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (op.kind === 'pen') {
    if (op.points.length < 2) {
      if (op.points.length === 1) {
        ctx.beginPath()
        ctx.arc(op.points[0].x, op.points[0].y, op.width / 2, 0, Math.PI * 2)
        ctx.fill()
      }
      return
    }
    ctx.lineWidth = op.width
    ctx.beginPath()
    ctx.moveTo(op.points[0].x, op.points[0].y)
    for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y)
    ctx.stroke()
    return
  }
  if (op.kind === 'arrow') {
    ctx.lineWidth = op.width
    ctx.beginPath()
    ctx.moveTo(op.from.x, op.from.y)
    ctx.lineTo(op.to.x, op.to.y)
    ctx.stroke()
    drawArrowhead(ctx, op.from, op.to, op.width)
    return
  }
  if (op.kind === 'rect') {
    ctx.lineWidth = op.width
    ctx.strokeRect(
      Math.min(op.from.x, op.to.x),
      Math.min(op.from.y, op.to.y),
      Math.abs(op.to.x - op.from.x),
      Math.abs(op.to.y - op.from.y)
    )
    return
  }
  // text
  ctx.font = `600 ${op.fontSize}px Inter, system-ui, sans-serif`
  ctx.textBaseline = 'top'
  // Halo for legibility on busy images.
  ctx.lineWidth = Math.max(2, op.fontSize / 8)
  ctx.strokeStyle = op.color === '#ffffff' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)'
  ctx.strokeText(op.text, op.x, op.y)
  ctx.fillStyle = op.color
  ctx.fillText(op.text, op.x, op.y)
}

export function ImageAnnotationEditor({
  imageUrl,
  workspaceRoot,
  title,
  busy = false,
  onCancel,
  onApply
}: Props): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<AnnotationTool>('arrow')
  const [color, setColor] = useState(SWATCHES[0].value)
  const [ops, setOps] = useState<AnnotationOp[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  /** Longest natural edge of the loaded picture; drives stroke/font scaling. */
  const [naturalLongest, setNaturalLongest] = useState(0)
  const [instruction, setInstruction] = useState('')
  const [textDraft, setTextDraft] = useState<{ cssX: number; cssY: number; x: number; y: number } | null>(
    null
  )
  const [textValue, setTextValue] = useState('')

  // Live drag state for the in-progress shape (rubber-band preview).
  const dragRef = useRef<{ op: AnnotationOp } | null>(null)
  const [, forceTick] = useState(0)
  const rerender = useCallback(() => forceTick((n) => n + 1), [])

  const strokeWidth = useMemo(() => {
    const longest = naturalLongest || 800
    return Math.max(3, Math.round(longest / 200))
  }, [naturalLongest])
  const fontSize = useMemo(() => {
    const longest = naturalLongest || 800
    return Math.max(16, Math.round(longest / 22))
  }, [naturalLongest])

  // Resolve + load the picture into an offscreen Image, size the canvas to it.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setLoadError('')
    void loadWorkspaceImageDataUrl(workspaceRoot, imageUrl).then((src) => {
      if (cancelled) return
      if (!src) {
        setLoadError('无法加载这张图片')
        return
      }
      const img = new Image()
      img.onload = () => {
        if (cancelled) return
        imageRef.current = img
        const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1
        const canvas = canvasRef.current
        if (canvas) {
          const scale = longest > MAX_FLATTEN_DIM ? MAX_FLATTEN_DIM / longest : 1
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        }
        setNaturalLongest(longest)
        setLoaded(true)
      }
      img.onerror = () => {
        if (!cancelled) setLoadError('无法加载这张图片')
      }
      img.src = src
    })
    return () => {
      cancelled = true
    }
  }, [imageUrl, workspaceRoot])

  // Repaint the canvas from the op list (+ any in-progress drag op) every render.
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img || !loaded) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const op of ops) paintOp(ctx, op)
    if (dragRef.current) paintOp(ctx, dragRef.current.op)
  })

  const toCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!loaded || busy) return
      const p = toCanvasPoint(e)
      if (tool === 'text') {
        const rect = e.currentTarget.getBoundingClientRect()
        setTextValue('')
        setTextDraft({ cssX: e.clientX - rect.left, cssY: e.clientY - rect.top, x: p.x, y: p.y })
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      if (tool === 'pen') {
        dragRef.current = { op: { kind: 'pen', color, width: strokeWidth, points: [p] } }
      } else if (tool === 'arrow') {
        dragRef.current = { op: { kind: 'arrow', color, width: strokeWidth, from: p, to: p } }
      } else {
        dragRef.current = { op: { kind: 'rect', color, width: strokeWidth, from: p, to: p } }
      }
      rerender()
    },
    [busy, color, loaded, rerender, strokeWidth, tool, toCanvasPoint]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const p = toCanvasPoint(e)
      if (drag.op.kind === 'pen') drag.op.points.push(p)
      else if (drag.op.kind === 'arrow' || drag.op.kind === 'rect') drag.op.to = p
      rerender()
    },
    [rerender, toCanvasPoint]
  )

  const commitDrag = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    const op = drag.op
    // Drop a click-without-drag arrow/box (no real extent).
    if (op.kind === 'arrow' || op.kind === 'rect') {
      if (Math.hypot(op.to.x - op.from.x, op.to.y - op.from.y) < 4) {
        rerender()
        return
      }
    }
    setOps((prev) => [...prev, op])
  }, [rerender])

  const commitText = useCallback(() => {
    const draft = textDraft
    const value = textValue.trim()
    setTextDraft(null)
    setTextValue('')
    if (!draft || !value) return
    setOps((prev) => [...prev, { kind: 'text', color, x: draft.x, y: draft.y, text: value, fontSize }])
  }, [color, fontSize, textDraft, textValue])

  const undo = useCallback(() => setOps((prev) => prev.slice(0, -1)), [])
  const clearAll = useCallback(() => setOps([]), [])

  const textNotes = useMemo(
    () => ops.filter((op): op is Extract<AnnotationOp, { kind: 'text' }> => op.kind === 'text').map((op) => op.text),
    [ops]
  )

  const apply = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !loaded || busy) return
    // Repaint once without any in-progress drag so the export is committed-only.
    const ctx = canvas.getContext('2d')
    const img = imageRef.current
    if (ctx && img) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      for (const op of ops) paintOp(ctx, op)
    }
    const dataUrl = canvas.toDataURL('image/png')
    const dataBase64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    onApply({ dataBase64, mimeType: 'image/png', textNotes, instruction: instruction.trim() })
  }, [busy, instruction, loaded, onApply, ops, textNotes])

  // Esc cancels (unless typing a text annotation, where Esc cancels the draft).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (textDraft) {
          setTextDraft(null)
          setTextValue('')
        } else if (!busy) {
          onCancel()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel, textDraft])

  // Apply needs *some* instruction — drawn markup, or at least a typed note.
  const canApply = ops.length > 0 || Boolean(dragRef.current) || instruction.trim().length > 0

  return (
    <div className={IMAGE_ANNOTATION_ROOT_CLASS}>
      {/* Top bar */}
      <div
        className={IMAGE_ANNOTATION_TOP_BAR_CLASS}
        style={{ paddingLeft: 'calc(var(--ds-window-controls-safe-inset) + 1.25rem)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Pencil className="h-4 w-4 shrink-0 text-white/80" strokeWidth={1.9} />
          <span className="min-w-0 truncate text-[13px] font-semibold">
            {title ? `标注修改 · ${title}` : '标注修改'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => !busy && onCancel()}
          className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white"
          title="关闭"
          aria-label="关闭"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>

      {/* Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-6 pb-2">
        {loadError ? (
          <div className="rounded-2xl bg-white/10 px-5 py-4 text-[13px] text-white/85">{loadError}</div>
        ) : !loaded ? (
          <div className="flex items-center gap-2 text-[13px] text-white/75">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> 正在加载图片…
          </div>
        ) : null}

        <div className="relative" style={{ display: loaded && !loadError ? 'block' : 'none' }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={commitDrag}
            onPointerCancel={commitDrag}
            className="max-h-[calc(100vh-220px)] max-w-[min(1100px,calc(100vw-180px))] rounded-lg shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
            style={{ touchAction: 'none', cursor: tool === 'text' ? 'text' : 'crosshair' }}
          />
          {textDraft ? (
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitText()
                }
              }}
              placeholder="输入文字后回车"
              className="absolute z-10 min-w-[120px] rounded-md border border-white/70 bg-black/60 px-2 py-1 text-[13px] text-white outline-none placeholder:text-white/45"
              style={{ left: textDraft.cssX, top: textDraft.cssY }}
            />
          ) : null}
        </div>

        {/* Right tool rail */}
        <div className="absolute right-6 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2 rounded-2xl border border-white/15 bg-white/10 p-2 backdrop-blur-xl">
          {TOOLS.map(({ tool: t, label, Icon }) => (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              title={label}
              aria-label={label}
              aria-pressed={tool === t}
              className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
                tool === t ? 'bg-white text-black' : 'text-white/85 hover:bg-white/15'
              }`}
            >
              <Icon className="h-4 w-4" strokeWidth={1.9} />
            </button>
          ))}
          <div className="my-1 h-px w-6 bg-white/20" />
          {SWATCHES.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              onClick={() => setColor(swatch.value)}
              title={swatch.name}
              aria-label={swatch.name}
              aria-pressed={color === swatch.value}
              className={`h-6 w-6 rounded-full border transition ${
                color === swatch.value ? 'scale-110 border-white ring-2 ring-white/60' : 'border-white/40'
              }`}
              style={{ background: swatch.value }}
            />
          ))}
          <div className="my-1 h-px w-6 bg-white/20" />
          <button
            type="button"
            onClick={undo}
            disabled={ops.length === 0}
            title="撤销"
            aria-label="撤销"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={ops.length === 0}
            title="清空"
            aria-label="清空"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="relative z-10 flex shrink-0 flex-col items-center gap-2.5 px-6 pb-5 pt-1">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="补充说明（可选）：例如 把音符改成闪电"
          disabled={busy}
          className={IMAGE_ANNOTATION_INSTRUCTION_INPUT_CLASS}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => !busy && onCancel()}
            disabled={busy}
            className="rounded-full border border-white/25 px-5 py-2 text-[13px] font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !loaded || !canApply}
            title={!canApply ? '先在图片上画出要修改的地方，或填写补充说明' : '应用修改'}
            className="flex items-center gap-2 rounded-full bg-white px-5 py-2 text-[13px] font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} /> : <Check className="h-4 w-4" strokeWidth={2.4} />}
            应用
          </button>
        </div>
      </div>
    </div>
  )
}
