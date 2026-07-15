import { describe, expect, it } from 'vitest'
import {
  captureResizePointer,
  fitWorkbenchWidths,
  WORKBENCH_RESIZE_CLASS,
  workbenchWidthConstraintsForRightPanel
} from './workbench-layout'
import { BUILTIN_RIGHT_PANEL_IDS } from '../extensions/contribution-ids'

describe('fitWorkbenchWidths', () => {
  it('keeps ordinary right panels within the inspector width cap', () => {
    const next = fitWorkbenchWidths(
      1800,
      304,
      1400,
      { leftPanelVisible: true, rightPanelVisible: true },
      workbenchWidthConstraintsForRightPanel('chat', BUILTIN_RIGHT_PANEL_IDS.browser)
    )

    expect(next.left).toBe(304)
    expect(next.right).toBe(760)
  })

  it('lets the code canvas grow into the available workspace', () => {
    const next = fitWorkbenchWidths(
      1800,
      304,
      1400,
      { leftPanelVisible: true, rightPanelVisible: true },
      workbenchWidthConstraintsForRightPanel('chat', BUILTIN_RIGHT_PANEL_IDS.canvas)
    )

    expect(next.left).toBe(304)
    expect(next.right).toBeGreaterThan(760)
    expect(next.right).toBe(1126)
  })
})

describe('captureResizePointer', () => {
  it('keeps a divider drag in the Host while the pointer crosses an embedded Webview', () => {
    let capturedPointer: number | null = null
    const target = {
      setPointerCapture(pointerId: number) {
        capturedPointer = pointerId
      },
      hasPointerCapture(pointerId: number) {
        return capturedPointer === pointerId
      },
      releasePointerCapture(pointerId: number) {
        if (capturedPointer === pointerId) capturedPointer = null
      }
    }

    const release = captureResizePointer(target, 17)
    expect(capturedPointer).toBe(17)

    release()
    expect(capturedPointer).toBeNull()
    expect(WORKBENCH_RESIZE_CLASS).toBe('ds-workbench-resizing')
  })
})
