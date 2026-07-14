import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  presentationAgentProfile,
  presentationCommandContributions,
  presentationToolDeclarations,
  presentationViewContribution
} from './tool-contracts.js'
import { operationsFrom } from './extension.js'

test('runtime declarations exactly match the Manifest', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../kun-extension.json', import.meta.url), 'utf8')
  ) as {
    main: string
    permissions: string[]
    activationEvents: string[]
    contributes: {
      commands: unknown[]
      'views.fullPage': unknown[]
      agentProfiles: unknown[]
      tools: unknown[]
    }
  }
  assert.deepEqual(manifest.contributes.commands, presentationCommandContributions)
  assert.deepEqual(manifest.contributes['views.fullPage'], [presentationViewContribution])
  assert.deepEqual(manifest.contributes.agentProfiles, [presentationAgentProfile])
  assert.deepEqual(manifest.contributes.tools, presentationToolDeclarations)
  assert.equal(manifest.main, 'dist/host/extension.js')
  assert.deepEqual(manifest.permissions, [
    'commands.register',
    'ui.views',
    'webview',
    'agent.run',
    'tools.register',
    'workspace.read',
    'workspace.write'
  ])
  assert.equal(presentationAgentProfile.visibility, 'private')
  assert.deepEqual(
    presentationAgentProfile.allowedTools,
    presentationToolDeclarations.map(({ id }) => id)
  )
})

test('all tool schemas are strict, bounded, and side-effect classified', () => {
  assert.deepEqual(
    presentationToolDeclarations.map(({ id }) => id),
    [
      'presentation-create',
      'presentation-read',
      'presentation-apply',
      'presentation-validate',
      'presentation-export-copy'
    ]
  )
  for (const declaration of presentationToolDeclarations) {
    assert.equal(declaration.inputSchema.additionalProperties, false)
    assert.ok(declaration.maxOutputBytes >= 1024 && declaration.maxOutputBytes <= 1024 * 1024)
    assert.notEqual(declaration.sideEffects, 'none')
  }
})

test('every contributed command and tool schema passes the runtime compiler', async () => {
  const validatorUrl = new URL(
    '../../../../../../kun/dist/extensions/json-schema-validator.js',
    import.meta.url
  )
  const runtime = await import(validatorUrl.href) as {
    compileExtensionJsonSchema(
      schema: Record<string, unknown>,
      subject: string
    ): { assert(value: unknown, subject: string): void }
  }
  for (const command of presentationCommandContributions) {
    assert.doesNotThrow(() => runtime.compileExtensionJsonSchema(
      command.inputSchema as Record<string, unknown>,
      `commands.${command.id}.inputSchema`
    ))
  }
  for (const tool of presentationToolDeclarations) {
    assert.doesNotThrow(() => runtime.compileExtensionJsonSchema(
      tool.inputSchema as Record<string, unknown>,
      `tools.${tool.id}.inputSchema`
    ))
    assert.doesNotThrow(() => runtime.compileExtensionJsonSchema(
      tool.outputSchema as Record<string, unknown>,
      `tools.${tool.id}.outputSchema`
    ))
  }
})

test('deep operation parsing reports a public validation failure', () => {
  assert.throws(() => operationsFrom({
    operations: [{
      kind: 'element.upsert',
      slideId: 'slide-1',
      element: {
        id: 'image-1',
        type: 'image',
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        rotation: 0,
        opacity: 1,
        src: '../secret.PNG',
        alt: 'unsafe',
        fit: 'cover'
      }
    }]
  }), (error: unknown) =>
    error instanceof Error &&
    'code' in error && error.code === 'VALIDATION_FAILED')
})
