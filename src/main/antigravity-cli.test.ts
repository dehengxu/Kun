import { describe, expect, it } from 'vitest'
import {
  antigravityCliAsset,
  antigravityCliBinaryName,
  parseAntigravityGeminiModels
} from './antigravity-cli'

describe('Antigravity CLI integration', () => {
  it('maps supported release assets with pinned checksums', () => {
    expect(antigravityCliAsset('darwin', 'arm64')).toMatchObject({
      name: 'agy_cli_mac_arm64.tar.gz',
      archiveKind: 'tar.gz',
      binaryName: 'antigravity'
    })
    expect(antigravityCliAsset('win32', 'x64')?.sha256).toHaveLength(64)
    expect(antigravityCliAsset('aix', 'ppc64')).toBeUndefined()
    expect(antigravityCliBinaryName('win32')).toBe('agy.exe')
  })

  it('collapses effort variants to the user-facing Gemini model id', () => {
    expect(parseAntigravityGeminiModels([
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.5-flash-high',
      'gemini-3.5-flash-low',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
      ''
    ].join('\n'))).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro'
    ])
  })

  it('ignores diagnostic text and malformed model ids', () => {
    expect(parseAntigravityGeminiModels(
      'Loading models...\n gemini-3.6-flash-medium \nnot/a-model\n'
    )).toEqual(['gemini-3.6-flash'])
  })
})
