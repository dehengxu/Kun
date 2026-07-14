# Kun Video Editor

Kun Video Editor is a local-first, transcript-oriented editor for talking-head,
interview, and podcast projects. It is also the reference Extension API v1.1
example for a self-registering right-sidebar View, main-Agent tool coordination,
protected media handles, durable jobs, and generated artifacts. Kun
desktop ships the exact same deterministic `.kunx` as its default local
extension; there is no private built-in implementation behind the example.

The editor preserves an editable, revisioned project. It never rewrites source
media during ordinary edits. Its project engine is independent from Electron,
Kun renderer internals, and the Extension Host, so the same project and tool
logic can run in the desktop View or headlessly when all required grants already
exist.

## MVP status

The first release supports:

- protected local video/audio import and `ffprobe` metadata;
- manual split, trim, delete, reorder, track, caption, and canvas edits;
- timed SRT, WebVTT, and JSON transcript import;
- transcript-range cuts through a revision-bound `timeline.md` review file;
- deterministic `16:9`, `9:16`, and `1:1` composition presets;
- proof-frame, preview, H.264 MP4, AAC audio, SRT, and WebVTT render plans;
- durable render status, cancellation, and technically validated artifacts; and
- one private `video-editor` Agent profile with nine stable video tools.

This is intentionally not a Premiere or Resolve replacement. See
[Limitations](#limitations) before planning a workflow.

## Local requirements

- Node.js 22 and npm (the versions used by this repository).
- For repository commands, a built Kun Extension API and Kun CLI from this
  checkout. For a standalone project, the CLI must come from the matching Kun
  installation and the required `@kun` packages must exist in its npm registry.
- `ffprobe` and `ffmpeg` on a Host-approved executable path for probing,
  thumbnails, proofs, previews, and exports. H.264 export requires `libx264`;
  burned captions additionally require the `drawtext` filter. Verify both with
  `ffmpeg -hide_banner -encoders` and `ffmpeg -hide_banner -filters`.
- No cloud ASR account. The v1.1 example imports timed transcripts locally. If a
  supported local transcription broker is unavailable, `video-transcribe` with
  `mode: "local-asr"` returns `transcriber_unavailable` and uploads nothing.

FFmpeg is not embedded in the `.kunx` package. Install it using the normal
package manager for the current operating system, or configure a Host-approved
path. Availability must be checked independently on each target platform; one
machine is not evidence for another.

On macOS, use `brew install ffmpeg-full`: the smaller Homebrew `ffmpeg` formula
does not provide the caption filter required by this example. Kun also searches
the keg-only `/opt/homebrew/opt/ffmpeg-full/bin` and
`/usr/local/opt/ffmpeg-full/bin` prefixes so a Finder launch does not depend on
an interactive shell PATH.

## Install the release package

Fresh Kun desktop profiles install and globally enable the product-bundled
archive through the standard `.kunx` validator, immutable package store,
registry, migration, and activation lifecycle. Workspace trust, protected media
selection, and export targets are not auto-granted. Disabling is preserved,
uninstalling is honored permanently, and a selected development or rolled-back
version is not overwritten by the bundled updater.

The product resource archive and downloadable release archive are built from
this directory by the same deterministic packer and have the same SHA-256 for a
given commit and manifest version. This keeps every capability demonstrated here
available to third-party authors through documented Extension API surfaces.

Each stable and daily Kun GitHub Release publishes the platform-independent
`kun-video-editor-0.3.0.kunx` asset beside the desktop installers and the three
native evidence JSON files. Download the `.kunx` from the same release as the
Kun build you are running; do not copy an archive from an untrusted mirror.

Validate and install the downloaded package with the Kun Extension CLI:

```bash
kun extension validate ./kun-video-editor-0.3.0.kunx
kun extension install ./kun-video-editor-0.3.0.kunx
```

Review and accept the declared permissions, enable the extension in a trusted
workspace, then click the **Kun Video Editor** icon in the right rail. Installation validates the archive's
integrity manifest; it does not install FFmpeg, enable cloud ASR, or grant media
paths. Media import and export still require protected Host pickers.

Repository maintainers can reproduce the release archive at the fixed output
path and verify an already downloaded copy with:

```bash
npm run pack:kun-video-editor
npm run verify:kun-video-editor-package -- --input dist
```

The pack command builds and validates the extension twice and refuses to publish
unless both `.kunx` archives have the same byte length and SHA-256 digest.

## Quick start for contributors

From the repository root:

```bash
npm ci
npm run build:extensions
npm run build:kun
npm --prefix examples/extensions/kun-video-editor run typecheck
npm --prefix examples/extensions/kun-video-editor run test
npm --prefix examples/extensions/kun-video-editor run build
npm --prefix examples/extensions/kun-video-editor run validate
npm --prefix examples/extensions/kun-video-editor run pack
```

The repository-wide example gate runs typecheck, tests, build, manifest
validation, Kun validation, and packing for every example into a temporary
directory:

```bash
npm run check:extension-examples
```

The repository `validate` and `pack` commands resolve the checked-out
`kun/dist/cli/serve-entry.js` through a helper anchored to its own file
location. They therefore work through `npm --prefix` from any caller directory,
but are intentionally repository-only.

For a standalone extension, first verify the v1.1 packages used by this example:

```bash
kun extension --help
npm view @kun/extension-api@1.1.0 version
npm view @kun/extension-test@1.1.0 version
```

Only continue with a published scaffold and `npm install` when those checks
return versions. An `E404` means the configured registry does not yet provide
the standalone SDK artifacts; use this repository checkout instead. Do not use
repository `file:` aliases in a portable project, and do not install the
unrelated unscoped npm package named `kun` as the Kun Agent CLI.

Generate the deterministic local audio/transcript fixture into a disposable
directory when exercising a manual flow:

```bash
npm --prefix examples/extensions/kun-video-editor run fixture:generate -- \
  --output /tmp/kun-video-editor-fixture
```

The generator uses only Node.js. It does not download media, contact ASR, or
invoke a generative service.

## Desktop workflow

1. Use the default installed extension, or build and install the `.kunx` with the
   Kun Extension CLI. Grant it in a trusted workspace, then click its video icon
   in Kun's right rail. The editor opens beside the main conversation.
2. Create a project. Select the target frame rate and one of the supported canvas
   presets.
3. Use the protected import action. Kun owns the native picker and returns an
   opaque handle; the View never receives an absolute path.
4. Probe the source before adding it to the project. Unsupported or malformed
   media is rejected without changing the source.
5. Import the deterministic fixture SRT/VTT/JSON or another timed transcript.
   Untimed prose is not enough for automatic destructive cuts.
6. Edit manually, or ask the main Kun Agent to resolve `video-project` with
   `action: "active"`, read that project with the pure `get` action, then read
   `video-read-script` and apply structured changes at the current revision. To
   move the shared panel context to another project, use the explicit `select`
   action. The open panel refreshes through the extension's bounded project-change
   event.
7. Review the updated timeline and generate a proof frame or preview. A stale
   proof is not evidence for a newer revision.
8. Select a protected save target and start an export. The durable job continues
   independently of the initiating request and can be queried or cancelled.
9. Treat successful FFmpeg/ffprobe validation as technical validation. Inspect
   the current proof or exported media before claiming visual quality.

## Headless workflow

The project engine and all nine Agent tools can run under `kun serve` without a
Webview. Headless import, playback URL minting, or save-target selection does not
open a dialog. A headless run must already have valid workspace-scoped media and
output handles; otherwise the tool returns `interaction-required`.

A safe headless sequence is:

1. call `video-project` to create or read a project;
2. call `video-probe` with an existing `mediaHandleId`;
3. import a timed transcript with `video-transcribe`;
4. call `video-read-script` and retain its revision and digest;
5. apply explicit timed edits with `video-apply-script` or
   `video-update-timeline` using that expected revision;
6. call `video-render` with a pre-authorized media output handle and, for
   `sidecar` or `both`, a separate SRT/VTT output handle; and
7. poll without approval with read-only `video-render-status`; and
8. cancel explicitly with destructive `video-render-cancel` when requested.

Headless execution uses the same permission, revision, path, job, and artifact
checks as desktop execution. It never fabricates picker consent.

## Supported MVP workflows

- Remove explicitly timed filler words, silences, or repeated takes while
  retaining reversible source ranges.
- Reorder transcript-backed interview or podcast sections.
- Trim a talking-head recording and add editable captions.
- Produce horizontal, portrait, or square output with deterministic fit, crop,
  or pad geometry.
- Generate a proof frame or low-resolution review preview before export.
- Export H.264 MP4, AAC audio, or sidecar subtitles through a cancellable local
  job.

## Project format

Workspace data is stored below `.kun-video/`:

```text
.kun-video/
  projects/<project-id>/project.json
  projects/<project-id>/timeline.md
  projects/<project-id>/revisions/<revision>.json
  cache/<project-id>/thumbnails/
  cache/<project-id>/waveforms/
  exports/
```

`project.json` is the authoritative schema-versioned state. It contains stable
assets, ordered video/audio/caption tracks, items, captions, transcript
references, rational frame rate, canvas settings, the current revision, and
bounded revision metadata. Timeline positions and durations are non-negative
integer frames. Source and transcript interchange may use integer microseconds.

`timeline.md` is a deterministic, reviewable projection tied to one project
revision and digest. Editing it does not mutate the project. It must be validated
and applied with `video-apply-script`; stale or externally changed projections
fail closed.

Revision writes use optimistic concurrency and atomic replacement. Undo and redo
create new provenance-linked revisions. Cache files are disposable; project
state, source grants, and exports are not cache.

## Agent prompts

Good prompts make creative intent and the review boundary explicit:

```text
Open project interview-01. Read its current revision and timeline script first.
Propose cuts for the explicitly timed filler ranges only. Keep the source order,
16:9 canvas, and captions unchanged. Stop for review; do not export.
```

```text
For project podcast-short, refresh the current revision, make a 9:16 review cut
under 45 seconds from the timed transcript, use pad rather than subject-aware
reframing, and generate one proof frame. Do not claim visual inspection.
```

```text
Read project launch-demo and its current timeline.md. Apply only the approved
range removals, then export H.264 with burned captions and an SRT sidecar to the
two existing output grants. Report durable job progress and distinguish
technical validation from visual review.
```

The profile asks for the goal, audience, duration, aspect ratio, caption choice,
and review/export checkpoint. It reads before writing, refreshes after revision
conflicts, edits structure before decoration, and does not add music or B-roll
unless a later capability explicitly supports it.

## Privacy and trust model

- Media, transcripts, projects, proofs, and exports remain local by default.
- The example has no network permission and does not call remote ASR or
  generative services.
- Protected pickers return opaque, owner/workspace-bound handles. View playback
  uses short-lived, sender-bound `kun-media://` leases rather than file paths.
- FFmpeg and ffprobe are Host-discovered, invoked without a shell, and receive
  only authorized handle substitutions.
- Logs, job projections, tool history, and errors must not contain absolute
  paths, reusable media URLs, consent tokens, or unbounded process output.
- The Node entry is trusted extension code. Brokered APIs reduce ambient
  authority for compliant code; they are not an operating-system sandbox for an
  arbitrary Node extension. Review the package and requested permissions before
  installation.

## Recovery guide

| Symptom | Safe recovery |
| --- | --- |
| `interaction-required` | Open the desktop editor and complete the protected picker, or reuse a still-valid existing handle. Do not pass a path. |
| `transcriber_unavailable` | Import timed SRT, VTT, or JSON. No fallback text is generated and no media is uploaded. |
| FFmpeg/ffprobe unavailable or missing `drawtext`/`libx264` | Install a build with the required capabilities (on macOS, `ffmpeg-full`), verify it locally, and restart Kun. Project editing remains available. |
| Revision conflict | Call `video-project` and `video-read-script` again, review the newer revision, then resubmit structured edits with the new expected revision. |
| Stale `timeline.md` or proof | Regenerate it from the current project revision. Never reinterpret old timecodes or present an old proof as current. |
| Media handle or playback lease revoked | Reopen the project and request a fresh authorized handle/lease. Do not search by filename or reuse a copied URL. |
| Render cancelled or interrupted | Inspect the durable terminal state, remove/quarantine incomplete staging output, then explicitly start a new job. Do not assume the prior output completed. |
| Artifact unavailable | Confirm the bound export still exists and has not been replaced. Mint a fresh View lease only after current ownership and file identity checks pass. |
| Invalid project or unsupported schema | Preserve the project directory, inspect the structured validation error, restore a retained revision or migrate with a supported version. Do not hand-edit unknown schema fields in place. |
| Damaged derived cache | Close the View, delete only the affected `.kun-video/cache/<project-id>/` subtree, reopen, and regenerate thumbnails/waveforms. Never delete project state or source media as cache cleanup. |

## Limitations

The MVP does not provide arbitrary visual-scene understanding, multi-camera
conform, advanced color grading, general VFX/motion graphics, stock search,
generative B-roll, AI image/video generation, voice cloning, face tracking, or
subject-aware automatic reframing. It must not infer unseen actions from a
transcript or treat an exit code as visual review.

Transcript-based destructive edits require usable timing. FFmpeg filters and
render presets are intentionally bounded. Export and local transcription depend
on capabilities available on the current host. Supported behavior on macOS does
not establish Windows or Linux support; release evidence must be recorded on
each native packaged target.
