## 1. Presentation Model And Projection

- [x] 1.1 Define the bounded schema-versioned presentation model, stable IDs, theme, text/shape/image elements, and canonical parser/serializer.
- [x] 1.2 Implement the typed operation reducer with changed IDs, inverse operations, validation warnings, revision-independent deterministic behavior, and unit tests.
- [x] 1.3 Implement safe standalone HTML projection and embedded-model extraction tests covering escaping, script markers, deterministic output, and invalid files.

## 2. Extension Host And Agent Tools

- [x] 2.1 Implement the revision-aware project service with per-path serialization, size limits, idempotency receipts, post-write verification, and conflict errors.
- [x] 2.2 Register create/read/apply/validate/export-copy tools and View commands through public Extension API v1, with progress, cancellation, bounded outputs, and change notifications.
- [x] 2.3 Add the private presentation Agent profile and test exact Manifest/runtime declaration parity.

## 3. Visual Presentation Studio

- [x] 3.1 Build the full-page Webview shell with deck path controls, slide rail, 16:9 canvas, inspector, status, and responsive/themed styling.
- [x] 3.2 Implement slide and element creation, selection, ordering, drag/resize, inline text editing, property controls, undo/redo, preview, image resolution, and debounced revision-aware save.
- [x] 3.3 Implement extension-owned Agent run create/steer/cancel/replay, flush-before-run behavior, and automatic refresh after tool mutations.

## 4. Packaging And Documentation

- [x] 4.1 Add the Manifest, package scripts, TypeScript/Vite configuration, README, license, and clean-room reference notes.
- [x] 4.2 Add Presentation Studio to the extension examples index and validation enumeration.

## 5. Verification

- [x] 5.1 Run the extension's typecheck, build, unit tests, Manifest validation, and package validation.
- [x] 5.2 Run the repository extension example gate plus relevant root typecheck/build checks and diff hygiene.
- [x] 5.3 Exercise the built Webview in a browser harness and visually verify canvas, inspector, drag/resize, preview, and Agent panel layout.

## 6. Presentation Artifact Handoff

- [x] 6.1 Surface PPT Master and extension presentation output paths as bounded successful presentation artifacts, including mapper coverage for output/destination path aliases.
- [x] 6.2 Render deduplicated post-turn presentation cards with system-default open, file-manager reveal, loading, and bounded failure states.
- [x] 6.3 Add focused artifact-derivation, mapper, PPT Master, and system-opener tests and run the relevant renderer/Kun/typecheck/build checks.
