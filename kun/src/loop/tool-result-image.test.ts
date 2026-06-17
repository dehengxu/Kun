import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import {
  capToolResultImages,
  extractToolResultImages,
  isModelVisibleImageOutput,
  toolResultTextWithoutImages
} from './tool-result-image.js'

function toolResult(id: string, output: unknown): Extract<TurnItem, { kind: 'tool_result' }> {
  return {
    id,
    turnId: 't1',
    threadId: 'th1',
    role: 'tool',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    toolName: 'computer_use',
    callId: id,
    toolKind: 'command_execution',
    output,
    isError: false
  }
}

const screenshot = (data: string) => ({
  kind: 'computer_screenshot',
  action: 'screenshot',
  screen: { width: 1280, height: 800 },
  images: [{ mime_type: 'image/png', data_base64: data, width: 1280, height: 800 }]
})

describe('extractToolResultImages', () => {
  it('reads the read-tool single-image shape', () => {
    const images = extractToolResultImages({ kind: 'image', mime_type: 'image/png', data_base64: 'AAA', width: 10, height: 20 })
    expect(images).toEqual([{ mimeType: 'image/png', dataBase64: 'AAA', width: 10, height: 20 }])
  })

  it('reads the computer_use images-array shape', () => {
    expect(extractToolResultImages(screenshot('BBB'))).toEqual([
      { mimeType: 'image/png', dataBase64: 'BBB', width: 1280, height: 800 }
    ])
  })

  it('ignores non-image kinds and base64 from other tools', () => {
    expect(extractToolResultImages({ kind: 'generated', data_base64: 'CCC', mime_type: 'image/png' })).toEqual([])
    expect(extractToolResultImages({ note: 'hi' })).toEqual([])
    expect(isModelVisibleImageOutput({ kind: 'image', note: 'omitted' })).toBe(false)
  })
})

describe('toolResultTextWithoutImages', () => {
  it('drops base64/images but keeps metadata', () => {
    const text = toolResultTextWithoutImages(screenshot('HUGE'))
    expect(text).not.toContain('HUGE')
    expect(text).toContain('computer_screenshot')
    expect(text).toContain('1280')
  })
})

describe('capToolResultImages', () => {
  it('keeps only the most recent N image results inline', () => {
    const history: TurnItem[] = [
      toolResult('a', screenshot('IMG_A')),
      toolResult('b', screenshot('IMG_B')),
      toolResult('c', screenshot('IMG_C')),
      toolResult('d', screenshot('IMG_D'))
    ]
    const capped = capToolResultImages(history, 2)
    const kept = capped.filter((item) => item.kind === 'tool_result' && isModelVisibleImageOutput(item.output))
    expect(kept).toHaveLength(2)
    // The two oldest are evicted, the two newest retained.
    expect(isModelVisibleImageOutput((capped[0] as { output: unknown }).output)).toBe(false)
    expect(isModelVisibleImageOutput((capped[1] as { output: unknown }).output)).toBe(false)
    expect(extractToolResultImages((capped[3] as { output: unknown }).output)[0]?.dataBase64).toBe('IMG_D')
  })

  it('is a no-op when within the cap', () => {
    const history: TurnItem[] = [toolResult('a', screenshot('IMG_A'))]
    expect(capToolResultImages(history, 3)).toBe(history)
  })
})
