# Kun Extension Examples

These examples exercise the stable `@kun/extension-api` surface without importing
Kun runtime, renderer, Electron, or private HTTP/IPC modules.

| Example | What it demonstrates | Entry shape |
| --- | --- | --- |
| [`hello-sidebar`](./hello-sidebar) | Sandboxed right-sidebar View, theme, locale, and persisted View state | Browser/Webview |
| [`workspace-dashboard`](./workspace-dashboard) | Editor dashboard, namespaced command, workspace reads, storage, and Host messages | Node + Webview |
| [`agent-assistant`](./agent-assistant) | Extension-owned Agent run, replayable events, cancellation, and owned thread history | Node + Webview |
| [`presentation-studio`](./presentation-studio) | Revisioned standalone HTML slides, visual editing, typed Agent operations, and safe projection | Node + Webview |
| [`tool-provider`](./tool-provider) | Namespaced typed tool, progress, cancellation, and workspace access | Node/headless |
| [`streaming-model-provider`](./streaming-model-provider) | API-key and OAuth account bindings, normalized model streaming, usage, cancellation, and no-fallback errors | Node/headless |
| [`direct-dom`](./direct-dom) | High-risk isolated-world content script with bounded, failure-tolerant DOM changes | Node + content script |

Build the public SDK once, then build and validate an example:

```bash
npm run build --workspace @kun/extension-api
npm --prefix examples/extensions/hello-sidebar run typecheck
npm --prefix examples/extensions/hello-sidebar run build
node examples/extensions/validate-manifest.mjs \
  examples/extensions/hello-sidebar/kun-extension.json
```

Once the Kun extension CLI is available, every package also follows the normal
scaffolder workflow:

```bash
npm --prefix examples/extensions/hello-sidebar run validate
npm --prefix examples/extensions/hello-sidebar run pack
```

The Webview examples use Vite to bundle the public API client into
confined relative assets. `check:extension-examples` inspects the generated
HTML and JavaScript so a bare npm import cannot accidentally ship to Chromium.

The examples resolve workspace SDK packages from this repository. In a standalone
copy, run `npm install` inside the selected example first.

## Security notes

- Webviews receive only `window.kunExtension`; they do not use `window.kunGui`.
- The Tool and Provider examples also run under `kun serve` or supported CLI flows
  without Electron.
- The Provider example never receives a credential value. It checks an account
  reference and leaves credential collection to Kun-owned protected UI.
- `direct-dom` is intentionally high risk and unsupported by Extension API SemVer.
  Prefer a stable View contribution whenever possible.
