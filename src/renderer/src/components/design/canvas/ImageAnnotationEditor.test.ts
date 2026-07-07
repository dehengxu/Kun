import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageAnnotationEditor } from './ImageAnnotationEditor'

function renderEditor(): string {
  return renderToStaticMarkup(
    createElement(ImageAnnotationEditor, {
      imageUrl: '.kun-design/image.png',
      workspaceRoot: '/workspace',
      title: 'image.png',
      onCancel: () => undefined,
      onApply: () => undefined
    })
  )
}

describe('ImageAnnotationEditor layout', () => {
  it('keeps the full-screen editor out of native window drag controls', () => {
    const html = renderEditor()

    expect(html).toContain('ds-no-drag fixed inset-0')
    expect(html).toContain('ds-drag flex shrink-0')
    expect(html).toContain('padding-left:calc(var(--ds-window-controls-safe-inset) + 1.25rem)')
  })

  it('renders the instruction input with visible text on a generated background class', () => {
    const html = renderEditor()

    expect(html).toContain('appearance-none')
    expect(html).toContain('bg-white/10')
    expect(html).toContain('text-white')
    expect(html).toContain('caret-white')
    expect(html).not.toContain('bg-white/12')
  })
})
