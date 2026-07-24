import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'
import { workspaceRootIdentityKey } from '../../lib/workspace-path'
import type { SidebarDropPosition } from './sidebar-order'

export const SIDEBAR_FOLDERS_STORAGE_KEY = 'kun.sidebarFolders.v1'

export type SidebarVirtualFolder = {
  id: string
  name: string
  threadIds: string[]
}

export type SidebarFolderRegistry = {
  version: 1
  foldersByScope: Record<string, SidebarVirtualFolder[]>
}

export function emptySidebarFolderRegistry(): SidebarFolderRegistry {
  return {
    version: 1,
    foldersByScope: {}
  }
}

function compactStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function normalizeFolderName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeWorkspaceFolders(value: unknown): SidebarVirtualFolder[] {
  if (!Array.isArray(value)) return []
  const folderIds = new Set<string>()
  const assignedThreadIds = new Set<string>()
  const result: SidebarVirtualFolder[] = []

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<SidebarVirtualFolder>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const name = normalizeFolderName(raw.name)
    if (!id || !name || folderIds.has(id)) continue
    folderIds.add(id)
    const threadIds = compactStrings(Array.isArray(raw.threadIds) ? raw.threadIds : [])
      .filter((threadId) => {
        if (assignedThreadIds.has(threadId)) return false
        assignedThreadIds.add(threadId)
        return true
      })
    result.push({ id, name, threadIds })
  }

  return result
}

export function sidebarFolderScope(workspacePath: string): string {
  return workspaceRootIdentityKey(workspacePath)
}

export function normalizeSidebarFolderRegistry(value: unknown): SidebarFolderRegistry {
  if (!value || typeof value !== 'object') return emptySidebarFolderRegistry()
  const raw = value as Partial<SidebarFolderRegistry>
  if (raw.version !== 1) return emptySidebarFolderRegistry()
  const foldersByScope: Record<string, SidebarVirtualFolder[]> = {}
  if (raw.foldersByScope && typeof raw.foldersByScope === 'object') {
    for (const [scope, folders] of Object.entries(raw.foldersByScope)) {
      const normalizedScope = scope.trim()
      if (!normalizedScope) continue
      const normalizedFolders = normalizeWorkspaceFolders(folders)
      if (normalizedFolders.length > 0) foldersByScope[normalizedScope] = normalizedFolders
    }
  }
  return {
    version: 1,
    foldersByScope
  }
}

export function readSidebarFolderRegistry(): SidebarFolderRegistry {
  try {
    const raw = readBrowserStorageItem(SIDEBAR_FOLDERS_STORAGE_KEY)
    if (!raw) return emptySidebarFolderRegistry()
    return normalizeSidebarFolderRegistry(JSON.parse(raw))
  } catch {
    return emptySidebarFolderRegistry()
  }
}

export function saveSidebarFolderRegistry(registry: SidebarFolderRegistry): void {
  writeBrowserStorageItem(
    SIDEBAR_FOLDERS_STORAGE_KEY,
    JSON.stringify(normalizeSidebarFolderRegistry(registry))
  )
}

export function sidebarFoldersForWorkspace(
  registry: SidebarFolderRegistry,
  workspacePath: string
): SidebarVirtualFolder[] {
  const scope = sidebarFolderScope(workspacePath)
  if (!scope) return []
  return normalizeSidebarFolderRegistry(registry).foldersByScope[scope] ?? []
}

function updateWorkspaceFolders(
  registry: SidebarFolderRegistry,
  workspacePath: string,
  update: (folders: SidebarVirtualFolder[]) => SidebarVirtualFolder[]
): SidebarFolderRegistry {
  const normalized = normalizeSidebarFolderRegistry(registry)
  const scope = sidebarFolderScope(workspacePath)
  if (!scope) return normalized
  const foldersByScope = { ...normalized.foldersByScope }
  const nextFolders = normalizeWorkspaceFolders(update(foldersByScope[scope] ?? []))
  if (nextFolders.length > 0) foldersByScope[scope] = nextFolders
  else delete foldersByScope[scope]
  return {
    version: 1,
    foldersByScope
  }
}

export function createSidebarFolder(
  registry: SidebarFolderRegistry,
  workspacePath: string,
  folder: Pick<SidebarVirtualFolder, 'id' | 'name'>
): SidebarFolderRegistry {
  const id = folder.id.trim()
  const name = folder.name.trim()
  if (!id || !name) return normalizeSidebarFolderRegistry(registry)
  return updateWorkspaceFolders(registry, workspacePath, (folders) => {
    if (
      folders.some((item) =>
        item.id === id || item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
      )
    ) {
      return folders
    }
    return [...folders, { id, name, threadIds: [] }]
  })
}

export function renameSidebarFolder(
  registry: SidebarFolderRegistry,
  workspacePath: string,
  folderId: string,
  name: string
): SidebarFolderRegistry {
  const normalizedId = folderId.trim()
  const normalizedName = name.trim()
  if (!normalizedId || !normalizedName) return normalizeSidebarFolderRegistry(registry)
  return updateWorkspaceFolders(registry, workspacePath, (folders) => {
    if (
      folders.some((item) =>
        item.id !== normalizedId
        && item.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0
      )
    ) {
      return folders
    }
    return folders.map((folder) =>
      folder.id === normalizedId ? { ...folder, name: normalizedName } : folder
    )
  })
}

export function deleteSidebarFolder(
  registry: SidebarFolderRegistry,
  workspacePath: string,
  folderId: string
): SidebarFolderRegistry {
  const normalizedId = folderId.trim()
  if (!normalizedId) return normalizeSidebarFolderRegistry(registry)
  return updateWorkspaceFolders(
    registry,
    workspacePath,
    (folders) => folders.filter((folder) => folder.id !== normalizedId)
  )
}

export function sidebarFolderIdForThread(
  folders: readonly SidebarVirtualFolder[],
  threadId: string
): string | null {
  const normalizedId = threadId.trim()
  if (!normalizedId) return null
  return folders.find((folder) => folder.threadIds.includes(normalizedId))?.id ?? null
}

export function moveThreadToSidebarFolder(
  registry: SidebarFolderRegistry,
  workspacePath: string,
  threadId: string,
  folderId: string | null,
  targetThreadId?: string,
  position: SidebarDropPosition = 'after'
): SidebarFolderRegistry {
  const normalizedThreadId = threadId.trim()
  const normalizedFolderId = folderId?.trim() || null
  const normalizedTargetId = targetThreadId?.trim() || ''
  if (!normalizedThreadId) return normalizeSidebarFolderRegistry(registry)

  return updateWorkspaceFolders(registry, workspacePath, (folders) => {
    const withoutThread = folders.map((folder) => ({
      ...folder,
      threadIds: folder.threadIds.filter((id) => id !== normalizedThreadId)
    }))
    if (!normalizedFolderId) return withoutThread
    return withoutThread.map((folder) => {
      if (folder.id !== normalizedFolderId) return folder
      const targetIndex = normalizedTargetId
        ? folder.threadIds.findIndex((id) => id === normalizedTargetId)
        : -1
      const insertionIndex = targetIndex < 0
        ? folder.threadIds.length
        : targetIndex + (position === 'after' ? 1 : 0)
      const threadIds = [...folder.threadIds]
      threadIds.splice(insertionIndex, 0, normalizedThreadId)
      return { ...folder, threadIds }
    })
  })
}

export function removeSidebarThreadAssignments(
  registry: SidebarFolderRegistry,
  threadIds: readonly string[]
): SidebarFolderRegistry {
  const removing = new Set(compactStrings(threadIds))
  if (removing.size === 0) return normalizeSidebarFolderRegistry(registry)
  const normalized = normalizeSidebarFolderRegistry(registry)
  return normalizeSidebarFolderRegistry({
    ...normalized,
    foldersByScope: Object.fromEntries(
      Object.entries(normalized.foldersByScope).map(([scope, folders]) => [
        scope,
        folders.map((folder) => ({
          ...folder,
          threadIds: folder.threadIds.filter((id) => !removing.has(id))
        }))
      ])
    )
  })
}

export function sidebarFolderNameExists(
  folders: readonly SidebarVirtualFolder[],
  name: string,
  excludingFolderId?: string
): boolean {
  const normalizedName = name.trim()
  if (!normalizedName) return false
  return folders.some((folder) =>
    folder.id !== excludingFolderId
    && folder.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0
  )
}
