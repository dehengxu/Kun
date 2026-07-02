import type { CanvasDocument, CanvasShape, Point } from './canvas-types'
import { ROOT_SHAPE_ID } from './canvas-types'

const DESIGN_DIR = '.kun-design'

export function canvasDocPath(artifactId: string, baseDir: string = DESIGN_DIR): string {
  return `${baseDir}/${artifactId}/canvas.json`
}

export function serializeCanvasDocument(doc: CanvasDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function parseShape(raw: unknown, id: string): CanvasShape | null {
  if (!isObj(raw)) return null
  const type = raw.type
  if (
    type !== 'rect' &&
    type !== 'ellipse' &&
    type !== 'text' &&
    type !== 'image' &&
    type !== 'frame' &&
    type !== 'group' &&
    type !== 'arrow' &&
    type !== 'line' &&
    type !== 'draw'
  )
    return null

  return {
    id,
    type: type as CanvasShape['type'],
    name: typeof raw.name === 'string' ? raw.name : id,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    frameId: typeof raw.frameId === 'string' ? raw.frameId : null,
    x: typeof raw.x === 'number' ? raw.x : 0,
    y: typeof raw.y === 'number' ? raw.y : 0,
    width: typeof raw.width === 'number' ? raw.width : 100,
    height: typeof raw.height === 'number' ? raw.height : 100,
    rotation: typeof raw.rotation === 'number' ? raw.rotation : 0,
    opacity: typeof raw.opacity === 'number' ? raw.opacity : 1,
    visible: typeof raw.visible === 'boolean' ? raw.visible : true,
    locked: typeof raw.locked === 'boolean' ? raw.locked : false,
    fills: Array.isArray(raw.fills) ? raw.fills : [],
    strokes: Array.isArray(raw.strokes) ? raw.strokes : [],
    cornerRadius:
      typeof raw.cornerRadius === 'number'
        ? raw.cornerRadius
        : Array.isArray(raw.cornerRadius) && raw.cornerRadius.length === 4
          ? (raw.cornerRadius as [number, number, number, number])
          : 0,
    children: Array.isArray(raw.children) ? raw.children.filter((c): c is string => typeof c === 'string') : [],
    ...(typeof raw.textContent === 'string' && { textContent: raw.textContent }),
    ...(typeof raw.fontSize === 'number' && { fontSize: raw.fontSize }),
    ...(typeof raw.fontFamily === 'string' && { fontFamily: raw.fontFamily }),
    ...(typeof raw.fontWeight === 'number' && { fontWeight: raw.fontWeight }),
    ...(typeof raw.textAlign === 'string' && { textAlign: raw.textAlign as CanvasShape['textAlign'] }),
    ...(typeof raw.lineHeight === 'number' && { lineHeight: raw.lineHeight }),
    ...(typeof raw.fontColor === 'string' && { fontColor: raw.fontColor }),
    ...(typeof raw.imageUrl === 'string' && { imageUrl: raw.imageUrl }),
    ...(typeof raw.aiImageHolder === 'boolean' && { aiImageHolder: raw.aiImageHolder }),
    ...(typeof raw.clipContent === 'boolean' && { clipContent: raw.clipContent }),
    ...(typeof raw.htmlArtifactId === 'string' && { htmlArtifactId: raw.htmlArtifactId }),
    ...((raw.devicePreset === 'mobile' ||
      raw.devicePreset === 'tablet' ||
      raw.devicePreset === 'desktop') && {
      devicePreset: raw.devicePreset as CanvasShape['devicePreset']
    }),
    ...(typeof raw.arrowheadStart === 'string' && {
      arrowheadStart: raw.arrowheadStart as CanvasShape['arrowheadStart']
    }),
    ...(typeof raw.arrowheadEnd === 'string' && {
      arrowheadEnd: raw.arrowheadEnd as CanvasShape['arrowheadEnd']
    }),
    ...(Array.isArray(raw.points) && {
      points: (raw.points as unknown[]).filter(
        (p): p is Point => isObj(p) && typeof p.x === 'number' && typeof p.y === 'number'
      )
    }),
    // Effects / layout / constraints are passed through structurally — the
    // executor's Zod schema is the source of truth on write, so loading trusts
    // the on-disk shape and only guards the container kind to avoid crashes.
    ...(Array.isArray(raw.shadows) && { shadows: raw.shadows as CanvasShape['shadows'] }),
    ...(typeof raw.blendMode === 'string' && { blendMode: raw.blendMode as CanvasShape['blendMode'] }),
    ...(isObj(raw.layout) && { layout: raw.layout as unknown as CanvasShape['layout'] }),
    ...(isObj(raw.constraints) && { constraints: raw.constraints as unknown as CanvasShape['constraints'] })
  }
}

/**
 * v1 → v2 migration: v1 stored a frame/group child's x/y RELATIVE to its parent
 * (the old renderer nested children inside the parent's transform). v2 stores
 * absolute coords. Rewrite each non-root shape's x/y to its absolute position
 * (own coord + accumulated ancestor offsets) so visual positions are preserved.
 */
function flattenCoordinatesToAbsolute(
  objects: Record<string, CanvasShape>,
  rootId: string
): void {
  const walk = (id: string, offsetX: number, offsetY: number): void => {
    const shape = objects[id]
    if (!shape) return
    const isRoot = id === rootId
    const absX = isRoot ? shape.x : shape.x + offsetX
    const absY = isRoot ? shape.y : shape.y + offsetY
    if (!isRoot) {
      shape.x = absX
      shape.y = absY
    }
    for (const childId of shape.children) walk(childId, absX, absY)
  }
  walk(rootId, 0, 0)
}

export function parseCanvasDocument(raw: string): CanvasDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  if (parsed.version !== 1 && parsed.version !== 2) return null
  const rootId = typeof parsed.rootId === 'string' ? parsed.rootId : ROOT_SHAPE_ID
  if (!isObj(parsed.objects)) return null

  const objects: Record<string, CanvasShape> = {}
  for (const [id, rawShape] of Object.entries(parsed.objects as Record<string, unknown>)) {
    const shape = parseShape(rawShape, id)
    if (shape) objects[id] = shape
  }

  if (!objects[rootId]) return null
  if (parsed.version === 1) flattenCoordinatesToAbsolute(objects, rootId)
  return { version: 2, rootId, objects }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null

export function persistCanvasDocument(
  workspaceRoot: string,
  artifactId: string,
  doc: CanvasDocument,
  baseDir?: string
): void {
  if (!workspaceRoot || typeof window.kunGui?.writeWorkspaceFile !== 'function') return

  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    void window.kunGui
      .writeWorkspaceFile({
        path: canvasDocPath(artifactId, baseDir),
        workspaceRoot,
        content: serializeCanvasDocument(doc)
      })
      .catch(() => undefined)
  }, 600)
}

export async function loadCanvasDocument(
  workspaceRoot: string,
  artifactId: string,
  baseDir?: string
): Promise<CanvasDocument | null> {
  if (!workspaceRoot || typeof window.kunGui?.readWorkspaceFile !== 'function') return null
  try {
    const result = await window.kunGui.readWorkspaceFile({
      path: canvasDocPath(artifactId, baseDir),
      workspaceRoot
    })
    if (!result || !result.ok) return null
    return parseCanvasDocument(result.content)
  } catch {
    return null
  }
}
