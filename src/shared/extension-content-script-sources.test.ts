import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_CONTENT_SCRIPT_DEACTIVATION_SOURCE } from './extension-content-script-sources'

describe('extension content-script sources', () => {
  it('reads identity from kunHost and removes only matching managed nodes', () => {
    const dispatchEvent = vi.fn()
    const matching = managedNode('acme.dom/decorate')
    const unrelated = managedNode('other.dom/decorate')

    runInNewContext(EXTENSION_CONTENT_SCRIPT_DEACTIVATION_SOURCE, {
      kunHost: {
        getContext: () => ({
          extensionId: 'acme.dom',
          contributionId: 'decorate',
          marker: 'acme.dom/decorate'
        })
      },
      window: { dispatchEvent },
      CustomEvent: class {
        constructor(public readonly type: string, public readonly init: unknown) {}
      },
      document: { querySelectorAll: () => [matching, unrelated] }
    })

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'kun-extension-deactivate',
      init: { detail: { extensionId: 'acme.dom', contributionId: 'decorate' } }
    }))
    expect(matching.remove).toHaveBeenCalledOnce()
    expect(unrelated.remove).not.toHaveBeenCalled()
  })

  it('fails safely when the isolated-world bridge is unavailable', () => {
    expect(() => runInNewContext(EXTENSION_CONTENT_SCRIPT_DEACTIVATION_SOURCE, {})).not.toThrow()
  })
})

function managedNode(marker: string) {
  return {
    getAttribute: (name: string) => name === 'data-kun-extension-style' ? marker : null,
    remove: vi.fn()
  }
}
