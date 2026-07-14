## Context

The current `origin/develop` baseline exposes Extension API v1.0 with full-page Webviews, commands, workspace read/write, Agent runs, Agent profiles, and extension tools. It does not expose workspace directory creation or atomic rename. PPT Master remains the managed Markdown-to-PPTX path and is intentionally separate from this HTML-first editing experience.

The NQ reference project edits arbitrary HTML inside an unsandboxed iframe and exports a full runtime DOM snapshot. Its generated element IDs do not survive reopen, its change map is not a real operation log, and arbitrary slide scripts would share an unsafe execution surface in an Electron renderer. The new extension therefore uses a constrained presentation model rather than importing that runtime.

## Goals / Non-Goals

**Goals:**

- Make one presentation editable by both a person and an extension-owned Kun Agent without last-writer-wins data loss.
- Keep the canonical artifact directly openable as a standalone HTML presentation.
- Keep slide and element identity stable across sessions and exports.
- Use only public Extension API v1.0 surfaces and minimum required permissions.
- Keep every tool schema, file, message, operation batch, and retained idempotency record bounded.
- Preserve Kun's existing tool approval, sandbox, cancellation, catalog, and single-runtime behavior.

**Non-Goals:**

- Importing arbitrary HTML or executing user/Agent-authored JavaScript in the extension Webview.
- PPTX/PDF import or export, animation timelines, charts, multiplayer CRDT, or pixel-perfect PowerPoint compatibility.
- Replacing or weakening managed PPT Master.
- Cherry-picking the legacy PPTist bridge or the local-only Extension API v1.1/video-editor stack.
- Adding PPT-specific private IPC or relaxing the extension CSP.

## Decisions

### 1. A constrained AST is embedded in the standalone HTML file

A deck is saved as `<name>.kun-ppt.html`. A non-executable `application/json` marker contains a schema-versioned model with document metadata, theme, slides, elements, revision, and a bounded operation receipt log. The rest of the file is a deterministic HTML/CSS projection with persistent `data-kun-slide-id` and `data-kun-element-id` attributes.

Using one root-level file works within the v1.0 Workspace Broker, which cannot create directories. It is also directly previewable outside Kun and avoids a JSON/HTML pair becoming inconsistent. The parser reads only the exact JSON marker and never treats arbitrary surrounding HTML as editor authority.

### 2. Manual and Agent edits share one typed reducer

The shared engine accepts bounded operations for document metadata, slide insert/update/delete/reorder, and element upsert/delete. It validates the resulting model and returns changed IDs, warnings, and inverse operations. The Webview uses those inverse operations for undo/redo; the Agent tool uses the same reducer for batch edits.

Elements are a discriminated union of text, shape, and workspace-relative image blocks. Geometry uses percentages on a fixed 16:9 canvas. Colors, fonts, paths, text lengths, slide counts, element counts, and total serialized bytes are constrained before projection.

### 3. Persistence uses revision checks, receipts, and a per-path queue

Every mutation supplies `expectedRevision`. The host rereads the file, compares revisions, applies the batch, increments once, renders the complete canonical HTML, rechecks the prior content immediately before `context.workspace.writeFile`, then rereads it for verification. Calls for paths that differ only by ASCII case are serialized inside the extension host.

Agent mutations also supply an `operationId`. A digest and resulting revision are retained in a bounded receipt list, making a same-input retry return the prior success while rejecting reuse with different input. Extension API v1.0 offers neither atomic rename nor atomic conditional/create-only writes. Revision checks, immediate pre-write rechecks, per-path serialization, and post-write verification cover normal UI/Agent races inside one Extension Host, while cross-process atomicity is explicitly deferred.

### 4. The Webview is a trusted renderer for untrusted structured data

The full-page Webview builds slide DOM with `createElement`, `textContent`, validated style values, and broker-loaded workspace images. It never injects presentation HTML with `innerHTML`, never creates a nested iframe, and never enables remote network access. The file projection escapes all text and attributes and includes a restrictive standalone CSP.

The editor offers a slide rail, responsive 16:9 canvas, drag/resize, inline text editing, property inspector, slide operations, undo/redo, preview, and debounced save. Before starting or steering the Agent, it flushes pending edits so the Agent reads the current revision. A revision conflict never overwrites; the UI asks for reload.

### 5. A dedicated Agent profile uses five narrow tools

The private `presentation-designer` profile may use only `presentation-create`, `presentation-read`, `presentation-apply`, `presentation-validate`, and `presentation-export-copy`. Its instructions require reading the current revision before edits, using stable IDs, applying bounded batches, refreshing on conflicts, validating before completion, and treating PPTX as a separate PPT Master workflow.

The same tools remain available through Kun's normal extension ToolHost path. Declarations are defined once in TypeScript and regression-tested against the Manifest, so side-effect classification, input/output schemas, and output limits cannot silently drift.

### 6. Completed turns surface presentation artifacts through the existing system opener

Successful workspace-write tool results already carry a resolved `filePath`, but PPT Master names its final path as `output_path` and the chat timeline currently surfaces only file changes with unified diffs. The mapper therefore recognizes bounded output/destination path aliases and unwraps the progressive extension gateway's `result.content` envelope. A pure turn-level collector selects only `.ppt`/`.pptx` outputs plus `.kun-ppt.html` outputs whose provenance was derived from the real Presentation Studio tool identity and whose tool result carries the extension's verified content SHA-256. It rejects traversal and lexically external paths, applies platform-aware path identity, and renders the cards only after the turn finishes.

The primary card action calls the existing `editor:open-path` bridge with `editorId: "system"` and the main-owned `presentation-artifact` open policy. The main process resolves and confines the path to the active workspace, verifies that the canonical target is a regular file ending in `.ppt`, `.pptx`, or `.kun-ppt.html`, and for HTML recomputes the current bytes' SHA-256 against the trusted tool result before using Electron `shell.openPath`. This prevents a presentation-looking symlink or a post-generation HTML overwrite from launching different content while still letting WPS, PowerPoint, or the browser be selected by the operating system. A second action reuses the existing file-manager reveal path and the same fixed type policy. No new IPC channel or application-specific executable discovery is introduced.

## Risks / Trade-offs

- [Risk] A single HTML file can grow large. -> Cap the model and rendered file below the public 1 MiB tool/message budget and reject oversized edits before writing.
- [Risk] Extension API v1.0 writes are not rename-atomic or conditionally atomic. -> Serialize case-folded paths, recheck directly before persistence, verify the post-write document, and document cross-process atomic storage as a future platform improvement.
- [Risk] Workspace images may be missing or too large. -> Validate relative paths, use bounded broker reads, show a non-fatal placeholder, and report validation warnings.
- [Risk] Agent and user edit concurrently. -> Flush UI edits before Agent input and fail closed on revision mismatch rather than automatically merging.
- [Risk] HTML projection could become an XSS surface. -> Project only validated AST fields, escape every text/attribute value, forbid arbitrary CSS/script, and keep the bridge-bearing Webview independent of the exported markup.
- [Risk] A tool may report a presentation-looking path that no longer exists. -> Keep path resolution in the main process, show a bounded open failure in the card, and never attempt a shell-command fallback.
- [Risk] A generic writer or symlink may disguise executable content as a presentation path. -> Require runtime-derived Presentation Studio provenance and a verified write-time digest for standalone HTML, then revalidate the canonical target's regular-file type, suffix, and current content digest in the main process.

## Migration Plan

No persisted Kun data migration is required. Install the example as a development extension, create a new `.kun-ppt.html` deck, and edit it through the contributed full-page View or tools. Future schema versions must add explicit model migration before accepting older files. Removing the extension leaves standalone presentation files intact.

## Open Questions

- A future Extension API revision may add atomic workspace transactions and directory creation; the project service should adopt those without changing the deck operation contract.
- Native PPTX/PDF export can be added later as an explicitly version-pinned, non-destructive background job rather than importing the legacy PPTist bridge.
