## ADDED Requirements

### Requirement: Presentation files are stable standalone HTML artifacts
The extension SHALL store each presentation as a standalone `.kun-ppt.html` file containing a schema-versioned structured model, stable document/slide/element IDs, a positive revision, and a deterministic visible HTML projection.

#### Scenario: Reopen a saved presentation
- **WHEN** the extension opens a presentation that it previously saved
- **THEN** every slide and element retains its ID, geometry, content, order, theme, and revision

#### Scenario: Open the file outside Kun
- **WHEN** a user opens the saved file in a regular browser
- **THEN** the file presents the slides in 16:9 playback and print layouts without depending on Kun private APIs

### Requirement: Human and Agent edits use the same operation semantics
The extension MUST route both Webview edits and Agent tool edits through the same validated typed-operation reducer and MUST produce inverse operations for reversible UI edits.

#### Scenario: Edit text visually
- **WHEN** the user changes a text element in the canvas or inspector
- **THEN** the change is represented as an element operation, saved with a new revision, and is visible to the next Agent read

#### Scenario: Apply an Agent batch
- **WHEN** the Agent applies multiple valid operations against the current revision
- **THEN** all operations commit as one revision and the open View refreshes to the same resulting model

### Requirement: Concurrent edits fail closed
Every persisted mutation SHALL require an expected revision, SHALL serialize calls for the same case-folded workspace path inside one Extension Host, and SHALL reject a stale revision observed before persistence without overwriting the newer presentation. Cross-process atomic conditional writes are outside this requirement because Extension API v1 does not expose them.

#### Scenario: Agent uses a stale revision
- **WHEN** the user saves revision 7 after the Agent read revision 6 and the Agent submits an edit for revision 6
- **THEN** the edit fails with a revision-conflict result and revision 7 remains unchanged

#### Scenario: Retry a completed Agent operation
- **WHEN** the same operation ID and payload are retried after their response was lost
- **THEN** the extension returns the recorded resulting revision without applying the batch twice

### Requirement: The editor provides a complete bounded visual workflow
The full-page View SHALL support creating and loading a deck, slide navigation and ordering, text/shape/image elements, selection, drag, resize, inline text changes, property editing, undo/redo, preview, debounced save, and presentation-specific Agent runs.

#### Scenario: Create and revise a deck
- **WHEN** a user creates a deck, adds slides and elements, moves and styles them, undoes one edit, and previews the result
- **THEN** the canvas, slide rail, inspector, preview, and saved standalone file show the same revision

#### Scenario: Ask the presentation Agent to revise the open deck
- **WHEN** the user submits a revision request from the View
- **THEN** pending visual edits are saved first, a private extension-owned run uses the presentation profile/tools, and accepted file changes refresh the editor

### Requirement: Presentation content cannot control the extension Webview
The extension MUST render validated structured fields with safe DOM APIs and MUST NOT execute or inject arbitrary presentation HTML, CSS, JavaScript, remote resources, or event handlers into the bridge-bearing Webview.

#### Scenario: Text contains HTML and script syntax
- **WHEN** a text element contains tags, event-handler strings, or a closing script marker
- **THEN** the editor and standalone projection display it as text and the embedded model remains parseable

#### Scenario: Invalid image path
- **WHEN** an image element uses an absolute path, traversal, unsupported type, or unavailable file
- **THEN** validation rejects it or renders a bounded placeholder without exposing files outside the workspace

### Requirement: Completed presentation artifacts are directly openable
After an Agent turn completes, the GUI SHALL surface every successful, workspace-confined `.ppt`, `.pptx`, or trusted Presentation Studio `.kun-ppt.html` output as a deduplicated presentation file card. Native PowerPoint files SHALL open through the operating system's default application association, while `.kun-ppt.html` SHALL open through the same association as a standalone browser presentation. The card SHALL also allow revealing the file in the platform file manager. Before either action, the main process SHALL verify that the canonical target is a regular file inside the owning workspace and still has an allowed presentation suffix. Before system-opening `.kun-ppt.html`, it SHALL additionally recompute and match the trusted write-time SHA-256 digest.

#### Scenario: PPT Master exports a deck
- **WHEN** PPT Master successfully exports `presentations/brief.pptx` and the Agent turn completes
- **THEN** the final reply shows one presentation card whose primary action asks the operating system to open that file with its configured default application such as WPS or PowerPoint

#### Scenario: Presentation Studio writes an HTML deck
- **WHEN** a successful presentation write tool reports `brief.kun-ppt.html`
- **THEN** the final reply shows one presentation card that can open the standalone HTML projection with the system default application

#### Scenario: Generic tool reports presentation-looking HTML
- **WHEN** a tool without trusted Presentation Studio provenance reports `evil.kun-ppt.html`
- **THEN** the GUI does not surface it as an executable standalone presentation card

#### Scenario: A trusted HTML deck changes before it is opened
- **WHEN** Presentation Studio reports a verified HTML deck but its bytes no longer match the write-time digest when the user clicks Open
- **THEN** the main process refuses to launch the browser and the card shows a bounded failure state

#### Scenario: Presentation tool runs through the progressive gateway
- **WHEN** a Presentation Studio write is wrapped by `extension_tool_call` as `result.content`
- **THEN** the GUI preserves its canonical tool provenance and workspace-write semantics and surfaces the completed deck normally

#### Scenario: Presentation path disguises another target type
- **WHEN** a reported `.pptx` path resolves to a directory or to a symlink target with a different suffix
- **THEN** the main process rejects the open or reveal action without launching an application

#### Scenario: Opening fails or the file moved
- **WHEN** the operating system cannot open a surfaced presentation path
- **THEN** the card remains visible, shows a bounded failure state, logs diagnostic detail, and does not fall back to an arbitrary command

#### Scenario: Repeated tools report the same deck
- **WHEN** multiple successful tool results in one turn refer to the same presentation path
- **THEN** the final reply shows that presentation only once

#### Scenario: Distinct case-sensitive paths are reported
- **WHEN** a case-sensitive workspace contains both `Deck.pptx` and `deck.pptx`
- **THEN** the final reply keeps both presentation cards rather than case-folding them into one

### Requirement: Extension declarations remain public and verifiable
The implementation SHALL use only public Extension API v1 surfaces, minimum Manifest permissions, bounded strict tool schemas, and declarations that exactly match runtime registration.

#### Scenario: Validate and pack the extension
- **WHEN** repository extension checks build, validate, and pack all examples
- **THEN** Presentation Studio passes without unresolved browser imports, undeclared resources, private Kun imports, or tool declaration drift
