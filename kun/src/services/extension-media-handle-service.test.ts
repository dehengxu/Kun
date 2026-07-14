import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleError,
  ExtensionMediaHandleService
} from './extension-media-handle-service.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kun-extension-media-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'clip.mp4'), Buffer.from('video-fixture'))
  const principal: ExtensionPrincipal = {
    extensionId: 'acme.video',
    extensionVersion: '1.0.0',
    permissions: ['media.read', 'media.export', 'workspace.read', 'workspace.write'],
    workspaceRoots: [workspace],
    workspaceTrusted: true
  }
  return { root, workspace, dataDir, principal }
}

describe('ExtensionMediaHandleService', () => {
  it('registers workspace media without projecting an absolute path', async () => {
    const { workspace, dataDir, principal } = await fixture()
    const service = new ExtensionMediaHandleService({ dataDir })
    const handle = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    expect(handle).toMatchObject({
      displayName: 'clip.mp4',
      mode: 'read',
      mimeType: 'video/mp4',
      workspaceRelativePath: 'clip.mp4',
      available: true
    })
    expect(handle).not.toHaveProperty('absolutePath')
    const resolved = await service.resolve(principal, handle.id, 'read')
    expect(resolved.absolutePath).toBe(await realpath(join(workspace, 'clip.mp4')))
  })

  it('revokes handles only for the owning extension workspace', async () => {
    const { root, workspace, dataDir, principal } = await fixture()
    const workspaceB = join(root, 'workspace-b')
    await mkdir(workspaceB)
    await writeFile(join(workspaceB, 'clip.mp4'), Buffer.from('video-fixture-b'))
    const principalB = { ...principal, workspaceRoots: [workspaceB] }
    const foreignPrincipal = { ...principal, extensionId: 'other.video' }
    const service = new ExtensionMediaHandleService({ dataDir })
    const handleA = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    const handleB = await service.register(principalB, {
      workspaceRoot: workspaceB,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    const foreignHandle = await service.register(foreignPrincipal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })

    await expect(service.revokeExtensionWorkspace(
      principal.extensionId,
      extensionWorkspaceKey(workspace),
      workspace
    )).resolves.toBe(1)

    await expect(service.stat(principal, handleA.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.stat(principalB, handleB.id)).resolves.toMatchObject({ available: true })
    await expect(service.stat(foreignPrincipal, foreignHandle.id))
      .resolves.toMatchObject({ available: true })
  })

  it('accepts an external file only through a picker source and keeps its path opaque', async () => {
    const { root, workspace, dataDir, principal } = await fixture()
    const external = join(root, 'external.mov')
    await writeFile(external, Buffer.from('external'))
    const service = new ExtensionMediaHandleService({ dataDir })
    await expect(service.register(principal, {
      workspaceRoot: workspace,
      path: external,
      mode: 'read',
      source: 'workspace'
    })).rejects.toMatchObject({ code: 'path_escape' })
    const selected = await service.register(principal, {
      workspaceRoot: workspace,
      path: external,
      mode: 'read',
      source: 'picker'
    })
    expect(selected.workspaceRelativePath).toBeUndefined()
    expect(JSON.stringify(selected)).not.toContain(external)
  })

  it('rejects missing permissions, foreign versions, and wrong access modes', async () => {
    const { workspace, dataDir, principal } = await fixture()
    const service = new ExtensionMediaHandleService({ dataDir })
    const handle = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    await expect(service.stat({ ...principal, permissions: [] }, handle.id))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.stat({ ...principal, extensionVersion: '2.0.0' }, handle.id))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(service.resolve(principal, handle.id, 'write'))
      .rejects.toMatchObject({ code: 'mode_denied' })
  })

  it('detects replacement and makes release idempotent', async () => {
    const { workspace, dataDir, principal } = await fixture()
    const service = new ExtensionMediaHandleService({ dataDir })
    const handle = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    await writeFile(join(workspace, 'clip.mp4'), Buffer.from('changed-longer'))
    await expect(service.resolve(principal, handle.id, 'read'))
      .rejects.toMatchObject({ code: 'file_changed' })
    expect(await service.release(principal, handle.id)).toBe(true)
    expect(await service.release(principal, handle.id)).toBe(false)
    await expect(service.stat(principal, handle.id))
      .rejects.toBeInstanceOf(ExtensionMediaHandleError)
  })

  it('confines relative output targets to the workspace', async () => {
    const { workspace, dataDir, principal } = await fixture()
    await mkdir(join(workspace, 'exports'))
    const service = new ExtensionMediaHandleService({ dataDir })
    const target = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'exports/final.mp4',
      mode: 'write',
      source: 'workspace'
    })
    expect(target).toMatchObject({ mode: 'write', workspaceRelativePath: 'exports/final.mp4' })
    await expect(service.register(principal, {
      workspaceRoot: workspace,
      path: '../escape.mp4',
      mode: 'write',
      source: 'workspace'
    })).rejects.toMatchObject({ code: 'path_escape' })
  })

  it('reserves each export target once and publishes a separate generated read handle', async () => {
    const { workspace, dataDir, principal } = await fixture()
    await mkdir(join(workspace, 'exports'))
    const service = new ExtensionMediaHandleService({ dataDir })
    const target = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'exports/final.mp4',
      mode: 'write',
      source: 'workspace'
    })
    await service.reserveOutput(principal, target.id, 'job-1')
    await expect(service.reserveOutput(principal, target.id, 'job-2'))
      .rejects.toMatchObject({ code: 'handle_reserved' })
    await writeFile(join(workspace, 'exports', 'final.mp4'), Buffer.from('completed-video'))
    const generated = await service.completeOutput(principal, target.id, 'job-1')
    expect(generated).toMatchObject({
      mode: 'read',
      source: 'generated',
      displayName: 'final.mp4',
      byteSize: 15,
      available: true
    })
    expect(generated.id).not.toBe(target.id)
    await expect(service.stat(principal, target.id)).rejects.toMatchObject({ code: 'not_found' })
    const resolved = await service.resolve(principal, generated.id, 'read')
    expect(resolved.absolutePath).toBe(await realpath(join(workspace, 'exports', 'final.mp4')))
  })

  it('validates a completion batch atomically before consuming any export grant', async () => {
    const { workspace, dataDir, principal } = await fixture()
    await mkdir(join(workspace, 'exports'))
    const service = new ExtensionMediaHandleService({ dataDir })
    const first = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'exports/first.mp4',
      mode: 'write',
      source: 'workspace'
    })
    const second = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'exports/second.mp4',
      mode: 'write',
      source: 'workspace'
    })
    await service.reserveOutput(principal, first.id, 'job-1')
    await service.reserveOutput(principal, second.id, 'job-2')
    await writeFile(join(workspace, 'exports', 'first.mp4'), Buffer.from('first'))
    await writeFile(join(workspace, 'exports', 'second.mp4'), Buffer.from('second'))

    await expect(service.completeOutputs(principal, [
      { handleId: first.id, reservationId: 'job-1' },
      { handleId: second.id, reservationId: 'wrong-job' }
    ])).rejects.toMatchObject({ code: 'handle_reserved' })

    await expect(service.completeOutput(principal, first.id, 'job-1'))
      .resolves.toMatchObject({ mode: 'read', source: 'generated' })
    await expect(service.completeOutput(principal, second.id, 'job-2'))
      .resolves.toMatchObject({ mode: 'read', source: 'generated' })
  })

  it('detects a newly-created file at a previously empty export target', async () => {
    const { workspace, dataDir, principal } = await fixture()
    await mkdir(join(workspace, 'exports'))
    const service = new ExtensionMediaHandleService({ dataDir })
    const target = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'exports/final.mp4',
      mode: 'write',
      source: 'workspace'
    })
    await writeFile(join(workspace, 'exports', 'final.mp4'), Buffer.from('foreign-file'))
    await expect(service.reserveOutput(principal, target.id, 'job-1'))
      .rejects.toMatchObject({ code: 'file_changed' })
  })

  it('rejects workspace symlink escapes and foreign extension owners', async () => {
    const { root, workspace, dataDir, principal } = await fixture()
    const external = join(root, 'external.mp4')
    await writeFile(external, Buffer.from('external-video'))
    await symlink(external, join(workspace, 'linked.mp4'))
    const service = new ExtensionMediaHandleService({ dataDir })
    await expect(service.register(principal, {
      workspaceRoot: workspace,
      path: 'linked.mp4',
      mode: 'read',
      source: 'workspace'
    })).rejects.toMatchObject({ code: 'path_escape' })
    const handle = await service.register(principal, {
      workspaceRoot: workspace,
      path: 'clip.mp4',
      mode: 'read',
      source: 'workspace'
    })
    await expect(service.stat({ ...principal, extensionId: 'foreign.video' }, handle.id))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})
