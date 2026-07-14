# Presentation Studio

Presentation Studio is a runnable Kun Extension API v1 example for repeatedly
editing one standalone HTML slide deck with a person and a Kun Agent. Each deck
is stored as a root-level `*.kun-ppt.html` workspace file. A bounded,
schema-versioned model embedded in that file is authoritative; the visible HTML
is a deterministic projection that remains useful in a regular browser.

The extension contributes a full-page editor, four View commands, five narrow
workspace tools, and a private `presentation-designer` Agent profile. Both
visual and Agent changes use the same typed operation reducer. Host persistence
requires an expected revision, serializes writes per path, records bounded
idempotency receipts, and verifies every write by reading it back through the
public workspace broker. Extension API v1 does not expose an atomic
create-only or conditional write: the service rechecks immediately before
persistence and protects races inside one Extension Host, but cross-process
atomicity remains a platform limitation.

## Safety and format boundaries

- Only a single root-level filename ending in `.kun-ppt.html` is accepted.
- The Host uses `context.workspace`; it does not access workspace files with
  Node filesystem APIs or private Kun imports.
- Presentation text is structured data. It is never executed or injected as
  arbitrary HTML, CSS, JavaScript, event handlers, or remote resources in the
  bridge-bearing Webview.
- A revision conflict fails closed. Reload the latest project and deliberately
  reapply the intended operations.
- Export creates another `.kun-ppt.html` copy only after checking that its
  destination is absent or already identical. The API v1 cross-process race
  limitation above still applies. Native PPTX/PDF conversion remains a
  separate, future workflow; Kun's managed PPT Master flow is unchanged.

## Commands and Host messages

The Webview invokes these local command IDs through `ExtensionHostClient`:

- `presentation-create`: `{ path, title? }`
- `presentation-load`: `{ path }`
- `presentation-save`: `{ path, expectedRevision, operations, operationId? }`
- `presentation-export-copy`: `{ path, destinationPath, expectedRevision }`

After a successful create, save, or export-copy, the Host attempts a fail-soft
message on channel `presentation.changed` with this payload:

```json
{
  "path": "roadmap.kun-ppt.html",
  "revision": 2,
  "source": "command",
  "changedIds": ["slide-agenda", "element-title"]
}
```

The source is either `command` or `tool`. A closed View does not turn a durable
workspace write into a failed tool invocation.

## Chat handoff

When an Agent turn finishes after a successful presentation write, Kun shows a
deduplicated presentation file card below the final reply. The primary action
uses the operating system's default file association: `.kun-ppt.html` normally
opens in the default browser, while native `.ppt`/`.pptx` output from PPT Master
opens in WPS, PowerPoint, LibreOffice, or whichever compatible application the
user configured. The card can also reveal the exact workspace file in the
platform file manager. Before opening a standalone HTML deck, Kun verifies its
current SHA-256 against the digest returned by the successful Studio write, so
a file changed afterward must be saved again in Presentation Studio. Kun never
launches a presentation automatically and does not probe or execute
application-specific commands.

## Development

From the repository root:

```bash
npm --prefix examples/extensions/presentation-studio run typecheck
npm --prefix examples/extensions/presentation-studio run test
npm --prefix examples/extensions/presentation-studio run build
node examples/extensions/validate-manifest.mjs \
  examples/extensions/presentation-studio/kun-extension.json
```

`npm run check:extension-examples` additionally validates and packs every
example with the repository's Kun CLI.

## Clean-room reference note

The interaction vocabulary was informed by the separately inspected
NQ-PPT-HTML-Editor project: a 16:9 canvas, slide rail, direct manipulation,
property inspector, preview, and iterative Agent editing. No source code,
runtime DOM snapshot format, temporary-ID scheme, iframe bridge, styling, or
assets were copied. Presentation Studio was implemented against Kun's public
Extension API v1 and this repository's OpenSpec artifacts.
