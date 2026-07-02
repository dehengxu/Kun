/**
 * The structured shape-operation interface. The AI Rail emits these as JSON,
 * the inspector commits them, the executor wraps the whole batch in one
 * `withUndoGroup` so a single Cmd+Z reverts the entire batch.
 *
 * Errors are returned as `{ code, message, suggestion? }` so the AI can
 * self-correct in one turn instead of throwing.
 */
import { z } from 'zod'
import type { AutoLayout, CanvasShape, Point, Rect, ShapeType } from './canvas-types'
import { createDefaultShape, createHtmlFrameShape, type DevicePreset } from './canvas-types'
import { useCanvasShapeStore, withDescendants } from './canvas-shape-store'
import { useCanvasUndoStore } from './canvas-undo-store'
import {
  alignShapes,
  collectiveBounds,
  distributeShapes,
  type AlignAxis,
  type DistributeAxis
} from './canvas-align'
import { computeAutoLayout, defaultAutoLayout } from './canvas-auto-layout'
import { constrainedBox } from './canvas-constraints'

import { getScreenArtifactFactory, setScreenBrief } from './screen-artifact-bridge'

const ShapeTypeSchema = z.enum([
  'rect',
  'ellipse',
  'text',
  'image',
  'frame',
  'group',
  'arrow',
  'line',
  'draw'
])

const PointSchema = z.object({ x: z.number(), y: z.number() })

const SolidFillSchema = z.object({
  type: z.literal('solid'),
  color: z.string(),
  opacity: z.number().min(0).max(1)
})

const GradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: z.string(),
  opacity: z.number().min(0).max(1).optional()
})

const GradientFillSchema = z.object({
  type: z.enum(['linear', 'radial']),
  stops: z.array(GradientStopSchema).min(2),
  angle: z.number().optional(),
  opacity: z.number().min(0).max(1)
})

const FillSchema = z.union([SolidFillSchema, GradientFillSchema])

const ShadowSchema = z.object({
  type: z.enum(['drop', 'inner']).optional(),
  x: z.number(),
  y: z.number(),
  blur: z.number().min(0),
  spread: z.number().optional(),
  color: z.string(),
  opacity: z.number().min(0).max(1)
})

const BlendModeSchema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity'
])

const AutoLayoutSchema = z.object({
  direction: z.enum(['horizontal', 'vertical']),
  gap: z.number().min(0),
  paddingTop: z.number().min(0),
  paddingRight: z.number().min(0),
  paddingBottom: z.number().min(0),
  paddingLeft: z.number().min(0),
  primaryAlign: z.enum(['start', 'center', 'end', 'space-between']).optional(),
  counterAlign: z.enum(['start', 'center', 'end']).optional()
})

/** Loose layout spec accepted by the `auto-layout` op — merged over defaults. */
const PartialAutoLayoutSchema = z.object({
  direction: z.enum(['horizontal', 'vertical']).optional(),
  gap: z.number().min(0).optional(),
  padding: z.number().min(0).optional(),
  paddingTop: z.number().min(0).optional(),
  paddingRight: z.number().min(0).optional(),
  paddingBottom: z.number().min(0).optional(),
  paddingLeft: z.number().min(0).optional(),
  primaryAlign: z.enum(['start', 'center', 'end', 'space-between']).optional(),
  counterAlign: z.enum(['start', 'center', 'end']).optional()
})

const ConstraintsSchema = z.object({
  h: z.enum(['left', 'right', 'left-right', 'center', 'scale']),
  v: z.enum(['top', 'bottom', 'top-bottom', 'center', 'scale'])
})

const StrokeSchema = z.object({
  color: z.string(),
  width: z.number().min(0),
  opacity: z.number().min(0).max(1),
  position: z.enum(['center', 'inside', 'outside']),
  dash: z.enum(['solid', 'dashed', 'dotted']).optional()
})

const ArrowheadSchema = z.enum(['none', 'arrow', 'triangle', 'circle', 'bar', 'diamond'])

const PartialShapeSchema = z
  .object({
    type: ShapeTypeSchema,
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    fills: z.array(FillSchema).optional(),
    strokes: z.array(StrokeSchema).optional(),
    cornerRadius: z.number().min(0).optional(),
    textContent: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    fontColor: z.string().optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().positive().optional(),
    imageUrl: z.string().optional(),
    aiImageHolder: z.boolean().optional(),
    clipContent: z.boolean().optional(),
    points: z.array(PointSchema).optional(),
    arrowheadStart: ArrowheadSchema.optional(),
    arrowheadEnd: ArrowheadSchema.optional(),
    shadows: z.array(ShadowSchema).optional(),
    blendMode: BlendModeSchema.optional(),
    layout: AutoLayoutSchema.optional(),
    constraints: ConstraintsSchema.optional()
  })
  .strict()

const PatchSchema = z
  .object({
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    fills: z.array(FillSchema).optional(),
    strokes: z.array(StrokeSchema).optional(),
    cornerRadius: z.number().min(0).optional(),
    textContent: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    fontColor: z.string().optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().positive().optional(),
    imageUrl: z.string().optional(),
    aiImageHolder: z.boolean().optional(),
    clipContent: z.boolean().optional(),
    points: z.array(PointSchema).optional(),
    arrowheadStart: ArrowheadSchema.optional(),
    arrowheadEnd: ArrowheadSchema.optional(),
    shadows: z.array(ShadowSchema).optional(),
    blendMode: BlendModeSchema.optional(),
    layout: AutoLayoutSchema.optional(),
    constraints: ConstraintsSchema.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional()
  })
  .strict()

/** Style-only fields for the batch `set-style` op (no geometry/structure). */
const StyleSchema = z
  .object({
    fills: z.array(FillSchema).optional(),
    strokes: z.array(StrokeSchema).optional(),
    cornerRadius: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    shadows: z.array(ShadowSchema).optional(),
    blendMode: BlendModeSchema.optional(),
    fontColor: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().positive().optional()
  })
  .strict()

const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive()
})

export const ShapeOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), shape: PartialShapeSchema, parentId: z.string().optional() }),
  z.object({ op: z.literal('update'), id: z.string(), patch: PatchSchema }),
  z.object({ op: z.literal('delete'), id: z.string() }),
  z.object({
    op: z.literal('reparent'),
    id: z.string(),
    newParentId: z.string(),
    index: z.number().int().nonnegative().optional()
  }),
  z.object({ op: z.literal('move'), ids: z.array(z.string()).min(1), dx: z.number(), dy: z.number() }),
  z.object({ op: z.literal('resize'), id: z.string(), bounds: BoundsSchema }),
  z.object({
    op: z.literal('align'),
    ids: z.array(z.string()).min(2),
    axis: z.enum(['left', 'h-center', 'right', 'top', 'v-center', 'bottom'])
  }),
  z.object({
    op: z.literal('distribute'),
    ids: z.array(z.string()).min(3),
    axis: z.enum(['horizontal', 'vertical'])
  }),
  z.object({
    op: z.literal('add-screen'),
    name: z.string(),
    brief: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    devicePreset: z.enum(['mobile', 'tablet', 'desktop']).optional()
  }),
  z.object({
    op: z.literal('duplicate'),
    id: z.string(),
    count: z.number().int().positive().max(20).optional(),
    offset: z.object({ dx: z.number(), dy: z.number() }).optional()
  }),
  z.object({
    op: z.literal('reorder'),
    id: z.string(),
    action: z.enum(['front', 'back', 'forward', 'backward'])
  }),
  z.object({
    op: z.literal('group'),
    ids: z.array(z.string()).min(1),
    name: z.string().optional(),
    /** Wrap into a `frame` (clips, can carry a fill/layout) instead of a bare `group`. */
    asFrame: z.boolean().optional()
  }),
  z.object({ op: z.literal('ungroup'), id: z.string() }),
  z.object({
    op: z.literal('set-style'),
    ids: z.array(z.string()).min(1),
    style: StyleSchema
  }),
  z.object({
    op: z.literal('auto-layout'),
    id: z.string(),
    layout: PartialAutoLayoutSchema.optional(),
    /** Remove the layout instead of (re)applying one. */
    clear: z.boolean().optional()
  })
])

export type ShapeOp = z.infer<typeof ShapeOpSchema>

export type OpError = {
  code:
    | 'INVALID_OP'
    | 'SHAPE_NOT_FOUND'
    | 'PARENT_NOT_FOUND'
    | 'WOULD_CYCLE'
    | 'UNSUPPORTED_TYPE'
  message: string
  suggestion?: string
}

export type ExecuteResult = {
  ok: boolean
  affectedIds: string[]
  errors: OpError[]
}

function findShape(id: string): CanvasShape | null {
  return useCanvasShapeStore.getState().document.objects[id] ?? null
}

function listShapeIds(): string[] {
  const { objects, rootId } = useCanvasShapeStore.getState().document
  return Object.keys(objects).filter((id) => id !== rootId)
}

function suggestionForMissingId(missing: string): string {
  const ids = listShapeIds()
  const doc = useCanvasShapeStore.getState().document
  const names = ids.map((id) => `"${doc.objects[id].name}" (${id})`).slice(0, 10)
  return `Available shapes: ${names.join(', ')}`
}

const LINEAR_TYPES = new Set<ShapeType>(['arrow', 'line', 'draw'])

/**
 * Ops supply linear `points` in ABSOLUTE canvas coords (natural for the AI).
 * Convert them to the stored form: bounding box in x/y/width/height + points
 * relative to that box (matching how the drawing tools persist).
 */
function bboxRelative(pts: Point[]): {
  x: number
  y: number
  width: number
  height: number
  points: Point[]
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    points: pts.map((p) => ({ x: p.x - minX, y: p.y - minY }))
  }
}

/**
 * Re-run auto-layout for a frame/group and write the children's new positions.
 * No-op when the shape has no layout. Called after structural edits (add /
 * reparent / delete / resize) so a laid-out container stays tidy automatically.
 */
function reflowFrame(frameId: string, affectedIds: Set<string>): void {
  const store = useCanvasShapeStore.getState()
  const objects = store.document.objects
  const frame = objects[frameId]
  if (!frame?.layout) return
  const positions = computeAutoLayout(objects, frameId)
  for (const pos of positions) {
    const child = store.document.objects[pos.id]
    if (!child) continue
    if (child.x !== pos.x || child.y !== pos.y) {
      // Children may themselves carry descendants (absolute coords) — shift the
      // whole subtree by the delta so nested content tracks the laid-out child.
      const dx = pos.x - child.x
      const dy = pos.y - child.y
      const objs = store.document.objects
      for (const id of withDescendants(objs, [pos.id])) {
        const s = objs[id]
        if (s) store.updateShape(id, { x: s.x + dx, y: s.y + dy })
      }
      affectedIds.add(pos.id)
    }
  }
}

/** Whether a shape exists and carries an auto-layout. */
function objectHasLayout(id: string): boolean {
  return Boolean(useCanvasShapeStore.getState().document.objects[id]?.layout)
}

/**
 * Reposition/resize the direct children of a just-resized frame per their
 * `constraints`. Children that have no constraints stick to top-left (the engine
 * default). A child's descendants are shifted by the same positional delta so
 * nested content tracks its constrained parent.
 */
function applyConstraintsOnResize(
  frameId: string,
  oldBounds: Rect,
  newBounds: Rect,
  affectedIds: Set<string>
): void {
  const store = useCanvasShapeStore.getState()
  const frame = store.document.objects[frameId]
  if (!frame) return
  for (const childId of [...frame.children]) {
    const child = store.document.objects[childId]
    if (!child) continue
    // Only act on children that opted into constraints — leave plain children put.
    if (!child.constraints) continue
    const box = constrainedBox(child, oldBounds, newBounds)
    const dx = box.x - child.x
    const dy = box.y - child.y
    store.updateShape(childId, { x: box.x, y: box.y, width: box.width, height: box.height })
    affectedIds.add(childId)
    if (dx !== 0 || dy !== 0) {
      const objs = store.document.objects
      for (const descId of withDescendants(objs, [childId])) {
        if (descId === childId) continue
        const d = objs[descId]
        if (d) store.updateShape(descId, { x: d.x + dx, y: d.y + dy })
      }
    }
  }
}

type PartialAutoLayout = z.infer<typeof PartialAutoLayoutSchema>

/**
 * Merge a loose layout spec over the frame's existing layout (or defaults).
 * The `padding` shorthand sets all four sides; explicit per-side values win.
 */
function mergeAutoLayout(existing: AutoLayout | undefined, partial?: PartialAutoLayout): AutoLayout {
  const base = existing ?? defaultAutoLayout()
  const pad = partial?.padding
  return {
    direction: partial?.direction ?? base.direction,
    gap: partial?.gap ?? base.gap,
    paddingTop: partial?.paddingTop ?? pad ?? base.paddingTop,
    paddingRight: partial?.paddingRight ?? pad ?? base.paddingRight,
    paddingBottom: partial?.paddingBottom ?? pad ?? base.paddingBottom,
    paddingLeft: partial?.paddingLeft ?? pad ?? base.paddingLeft,
    primaryAlign: partial?.primaryAlign ?? base.primaryAlign,
    counterAlign: partial?.counterAlign ?? base.counterAlign
  }
}

function executeOne(op: ShapeOp, affectedIds: Set<string>, errors: OpError[]): void {
  const store = useCanvasShapeStore.getState()
  switch (op.op) {
    case 'add': {
      // Validate an explicit parent up front: addShape silently no-ops when the
      // parent is missing, so without this the op would report phantom success
      // (a bogus affected id) and the agent would never learn its frame id was wrong.
      if (op.parentId && !findShape(op.parentId)) {
        errors.push({
          code: 'PARENT_NOT_FOUND',
          message: `Cannot add shape: parent "${op.parentId}" does not exist`,
          suggestion: suggestionForMissingId(op.parentId)
        })
        return
      }
      const { type } = op.shape
      const x = op.shape.x ?? 0
      const y = op.shape.y ?? 0
      const base = createDefaultShape(type as ShapeType, x, y)
      // Apply optional overrides from the op (excluding type/x/y already baked in).
      const overrides: Partial<CanvasShape> = { ...op.shape }
      delete (overrides as Record<string, unknown>).type
      delete (overrides as Record<string, unknown>).x
      delete (overrides as Record<string, unknown>).y
      Object.assign(base, overrides)
      if (LINEAR_TYPES.has(base.type) && base.points && base.points.length > 0) {
        Object.assign(base, bboxRelative(base.points))
      }
      store.addShape(base, op.parentId)
      affectedIds.add(base.id)
      if (op.parentId) reflowFrame(op.parentId, affectedIds)
      break
    }
    case 'update': {
      const existing = findShape(op.id)
      if (!existing) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      {
        const patch: Partial<CanvasShape> = { ...op.patch }
        if (LINEAR_TYPES.has(existing.type) && patch.points && patch.points.length > 0) {
          Object.assign(patch, bboxRelative(patch.points))
        }
        store.updateShape(op.id, patch)
      }
      affectedIds.add(op.id)
      break
    }
    case 'delete': {
      const target = findShape(op.id)
      if (!target) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      const parentId = target.parentId
      store.deleteShape(op.id)
      affectedIds.add(op.id)
      // Closing the gap a deleted child left in a laid-out container.
      if (parentId && objectHasLayout(parentId)) reflowFrame(parentId, affectedIds)
      break
    }
    case 'reparent': {
      if (!findShape(op.id)) {
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${op.id}"` })
        return
      }
      if (!findShape(op.newParentId)) {
        errors.push({ code: 'PARENT_NOT_FOUND', message: `No parent "${op.newParentId}"` })
        return
      }
      store.reparentShape(op.id, op.newParentId, op.index)
      affectedIds.add(op.id)
      if (objectHasLayout(op.newParentId)) reflowFrame(op.newParentId, affectedIds)
      break
    }
    case 'move': {
      // Validate the explicitly-named ids, then move them AND their descendants
      // by the same delta — children store absolute coords, so a frame's move
      // must carry them along (deduped so an id named twice moves once).
      const present = op.ids.filter((id) => {
        if (findShape(id)) return true
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${id}"` })
        return false
      })
      const objects = useCanvasShapeStore.getState().document.objects
      for (const id of withDescendants(objects, present)) {
        const s = findShape(id)
        if (!s) continue
        store.updateShape(id, { x: s.x + op.dx, y: s.y + op.dy })
        affectedIds.add(id)
      }
      break
    }
    case 'resize': {
      const target = findShape(op.id)
      if (!target) {
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${op.id}"` })
        return
      }
      const oldBounds = { x: target.x, y: target.y, width: target.width, height: target.height }
      const newBounds = {
        x: op.bounds.x,
        y: op.bounds.y,
        width: op.bounds.width,
        height: op.bounds.height
      }
      store.updateShape(op.id, newBounds)
      affectedIds.add(op.id)
      if (target.layout) {
        // Auto-layout owns child positions — re-flow to the new box.
        reflowFrame(op.id, affectedIds)
      } else if (target.type === 'frame' || target.type === 'group') {
        // Otherwise honor each child's resize constraints.
        applyConstraintsOnResize(op.id, oldBounds, newBounds, affectedIds)
      }
      break
    }
    case 'align': {
      const doc = useCanvasShapeStore.getState().document
      const shapes = op.ids
        .map((id) => doc.objects[id])
        .filter((s): s is CanvasShape => Boolean(s))
        .map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      if (shapes.length < 2) {
        errors.push({ code: 'INVALID_OP', message: 'align requires ≥2 valid shapes' })
        return
      }
      const out = alignShapes(shapes, op.axis as AlignAxis)
      for (const [id, patch] of out) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'distribute': {
      const doc = useCanvasShapeStore.getState().document
      const shapes = op.ids
        .map((id) => doc.objects[id])
        .filter((s): s is CanvasShape => Boolean(s))
        .map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      if (shapes.length < 3) {
        errors.push({ code: 'INVALID_OP', message: 'distribute requires ≥3 valid shapes' })
        return
      }
      const out = distributeShapes(shapes, op.axis as DistributeAxis)
      for (const [id, patch] of out) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'duplicate': {
      if (!findShape(op.id)) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      const count = Math.max(1, Math.min(op.count ?? 1, 20))
      const dx = op.offset?.dx ?? 24
      const dy = op.offset?.dy ?? 24
      for (let i = 0; i < count; i += 1) {
        const newId = store.duplicateShape(op.id)
        if (!newId) {
          errors.push({ code: 'INVALID_OP', message: `Cannot duplicate "${op.id}" (root or detached shapes can't be duplicated)` })
          break
        }
        // Stagger each copy so duplicates don't stack exactly on the original.
        // Children store ABSOLUTE coords, so the whole clone subtree shifts together.
        if (dx !== 0 || dy !== 0) {
          const objects = useCanvasShapeStore.getState().document.objects
          const step = i + 1
          for (const cloneId of withDescendants(objects, [newId])) {
            const cs = objects[cloneId]
            if (cs) store.updateShape(cloneId, { x: cs.x + dx * step, y: cs.y + dy * step })
          }
        }
        affectedIds.add(newId)
      }
      break
    }
    case 'reorder': {
      const shape = findShape(op.id)
      if (!shape) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      const parent = shape.parentId ? findShape(shape.parentId) : null
      const siblings = parent?.children ?? []
      const current = siblings.indexOf(op.id)
      if (!parent || current < 0) {
        errors.push({ code: 'INVALID_OP', message: `Shape "${op.id}" has no parent layer order to change` })
        return
      }
      const last = siblings.length - 1
      const target =
        op.action === 'front'
          ? last
          : op.action === 'back'
            ? 0
            : op.action === 'forward'
              ? Math.min(last, current + 1)
              : Math.max(0, current - 1)
      if (target !== current) store.reorderShape(op.id, target)
      affectedIds.add(op.id)
      break
    }
    case 'add-screen': {
      const factory = getScreenArtifactFactory()
      const artifactId = factory?.(op.name) ?? null
      if (!artifactId) {
        errors.push({ code: 'INVALID_OP', message: 'Cannot create screen artifact — no handler registered' })
        return
      }
      const preset = (op.devicePreset ?? 'desktop') as DevicePreset
      const shape = createHtmlFrameShape(op.name, op.x ?? 0, op.y ?? 0, artifactId, preset)
      if (op.width) shape.width = op.width
      if (op.height) shape.height = op.height
      store.addShape(shape)
      // Keep the agent's expanded brief so the follow-up HTML-generation turn
      // designs from it instead of the raw user prompt (see the turn-complete hook).
      if (op.brief) setScreenBrief(shape.id, op.brief)
      affectedIds.add(shape.id)
      break
    }
    case 'group': {
      const doc0 = useCanvasShapeStore.getState().document
      const members = op.ids
        .map((id) => doc0.objects[id])
        .filter((s): s is CanvasShape => Boolean(s) && s.id !== doc0.rootId)
      if (members.length === 0) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `group: none of [${op.ids.join(', ')}] exist`,
          suggestion: suggestionForMissingId(op.ids[0])
        })
        return
      }
      // The group lands under the first member's parent so it sits where the
      // content already is; bounds wrap the whole selection.
      const parentId = members[0].parentId ?? doc0.rootId
      const bounds = collectiveBounds(
        members.map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      )
      const container = createDefaultShape(op.asFrame ? 'frame' : 'group', bounds.x, bounds.y)
      container.name = op.name ?? (op.asFrame ? 'Frame' : 'Group')
      container.width = bounds.width
      container.height = bounds.height
      if (op.asFrame) {
        container.clipContent = false
      } else {
        container.fills = []
      }
      store.addShape(container, parentId)
      // Reparent members into the container, preserving their on-canvas order.
      for (const m of members) {
        store.reparentShape(m.id, container.id)
        affectedIds.add(m.id)
      }
      affectedIds.add(container.id)
      break
    }
    case 'ungroup': {
      const group = findShape(op.id)
      if (!group) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      const grandparentId = group.parentId
      if (!grandparentId) {
        errors.push({ code: 'INVALID_OP', message: `Cannot ungroup "${op.id}" — it has no parent to lift children into` })
        return
      }
      // Snapshot children first: reparenting mutates group.children as we go.
      const childIds = [...group.children]
      for (const childId of childIds) {
        store.reparentShape(childId, grandparentId)
        affectedIds.add(childId)
      }
      store.deleteShape(op.id)
      affectedIds.add(op.id)
      if (objectHasLayout(grandparentId)) reflowFrame(grandparentId, affectedIds)
      break
    }
    case 'set-style': {
      const present = op.ids.filter((id) => {
        if (findShape(id)) return true
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${id}"`, suggestion: suggestionForMissingId(id) })
        return false
      })
      if (present.length === 0) return
      const patch = op.style as Partial<CanvasShape>
      for (const id of present) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'auto-layout': {
      const frame = findShape(op.id)
      if (!frame) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return
      }
      if (frame.type !== 'frame' && frame.type !== 'group') {
        errors.push({
          code: 'UNSUPPORTED_TYPE',
          message: `auto-layout needs a frame or group, got "${frame.type}"`,
          suggestion: 'Group the shapes first (op "group"), then auto-layout the group.'
        })
        return
      }
      if (op.clear) {
        store.updateShape(op.id, { layout: undefined })
        affectedIds.add(op.id)
        break
      }
      const merged = mergeAutoLayout(frame.layout, op.layout)
      store.updateShape(op.id, { layout: merged })
      affectedIds.add(op.id)
      reflowFrame(op.id, affectedIds)
      break
    }
    default: {
      const exhaustive: never = op
      errors.push({ code: 'INVALID_OP', message: `Unknown op: ${JSON.stringify(exhaustive)}` })
    }
  }
}

/** Execute a batch of operations atomically. Returns affected ids + structured errors. */
export function executeOps(rawOps: unknown[], label = 'shape-ops'): ExecuteResult {
  const affectedIds = new Set<string>()
  const errors: OpError[] = []

  // Validate every op first; collect errors but don't abort — let the user see all problems.
  const validatedOps: ShapeOp[] = []
  for (let i = 0; i < rawOps.length; i++) {
    const parsed = ShapeOpSchema.safeParse(rawOps[i])
    if (!parsed.success) {
      errors.push({
        code: 'INVALID_OP',
        message: `Op #${i}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
      })
      continue
    }
    validatedOps.push(parsed.data)
  }

  if (validatedOps.length === 0) {
    return { ok: errors.length === 0, affectedIds: [], errors }
  }

  useCanvasUndoStore.getState().withGroup(label, () => {
    for (const op of validatedOps) {
      executeOne(op, affectedIds, errors)
    }
  })

  return {
    ok: errors.length === 0,
    affectedIds: Array.from(affectedIds),
    errors
  }
}
