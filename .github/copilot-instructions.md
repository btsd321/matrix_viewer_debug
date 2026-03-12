# CV DebugMate Python — GitHub Copilot Instructions

## Project Overview

**CV DebugMate Python** is a Visual Studio Code extension (TypeScript) that visualizes 1D/2D/3D Python data structures during a debugpy (Python) debug session.

Inspired by [cv_debug_mate_cpp](https://github.com/dull-bird/cv_debug_mate_cpp).

### What it does

| Feature | Description |
|---------|-------------|
| **Variables Panel** | TreeView in the Debug sidebar that auto-detects visualizable variables (numpy arrays, PIL images, lists, etc.) in the current scope |
| **Image Viewer** | Renders 2D arrays / PIL images on a canvas; supports zoom, pan, colormap, normalize, hover pixel info, save PNG |
| **Plot Viewer** | 1D line/scatter/histogram chart using uPlot; supports zoom/pan, custom X axis, stats, save PNG/CSV |
| **Point Cloud Viewer** | 3D point cloud with Three.js + OrbitControls; colour-by-axis, adjustable point size, save PLY |
| **View Sync** | Pair two open panels so their viewport (zoom/pan/rotation) stays in sync |
| **Auto Refresh** | All open panels refresh automatically when the debugger steps to a new line |

---

## Architecture

```
src/
├── extension.ts              # Entry point: command registration, debug events, visualization dispatch
├── cvVariablesProvider.ts    # TreeDataProvider for the Debug sidebar panel
├── utils/
│   ├── debugger.ts           # DAP communication (evaluate expressions, fetch array data)
│   ├── pythonTypes.ts        # Pure type-detection functions (no side effects)
│   ├── panelManager.ts       # Webview panel lifecycle and refresh
│   └── syncManager.ts        # View sync pair state machine
├── matImage/
│   ├── matProvider.ts        # Fetch image data from debugpy (ndarray / PIL / Tensor)
│   └── matWebview.ts         # Build HTML for the image viewer webview
├── plot/
│   ├── plotProvider.ts       # Fetch 1D data
│   └── plotWebview.ts        # Build HTML for the plot viewer webview
└── pointCloud/
    ├── pointCloudProvider.ts # Fetch point cloud data
    └── pointCloudWebview.ts  # Build HTML for the point cloud viewer webview

media/                        # Static front-end assets (served by webviews)
├── image-viewer.js / .css    # Canvas-based image rendering, zoom/pan logic
├── plot-viewer.js / .css     # uPlot wrapper
├── pointcloud-viewer.js/.css # Three.js point cloud scene
├── colormaps.js              # Colormap LUTs (gray, jet, viridis, hot, plasma)
├── uplot.iife.min.js         # uPlot chart library (vendored)
├── three.min.js              # Three.js (vendored)
└── OrbitControls.js          # Three.js OrbitControls (vendored)
```

### Key design patterns

- **Two-layer type detection** — `basicTypeDetect()` (fast string match) in the TreeView, `detectVisualizableType()` (shape + dtype) for visualization.
- **DAP evaluate for everything** — All Python data is fetched via `debugSession.customRequest("evaluate", …)`. No memory reads. Small arrays → JSON (`tolist()`), large arrays → Base64 (`tobytes()`).
- **Webview CSP** — Every webview sets a strict Content-Security-Policy with a per-load nonce.
- **One panel per variable** — `PanelManager` deduplicates: clicking a variable that already has an open panel just focuses it.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension host | TypeScript 5, VS Code Extension API |
| Build | esbuild (bundle), tsc (type-check) |
| Webview UI | Vanilla JS + Canvas API (image), uPlot (plot), Three.js (point cloud) |
| Debug protocol | DAP via `vscode.DebugSession.customRequest` |
| Target debugger | debugpy (`session.type === "python"` or `"debugpy"`) |

---

## Coding Conventions

### TypeScript (src/)

- **Strict mode** always on (`"strict": true` in tsconfig).
- Prefer `const` / `let`; never `var`.
- Functions that can fail return `T | null` instead of throwing (let callers decide).
- Use `async/await`; avoid raw `.then()` chains.
- Name booleans with `is` / `has` / `can` prefix: `isUint8`, `hasPanel`.
- Export only what is needed by other modules — keep internals un-exported.
- `// ── Section ──` comments to separate logical blocks inside large files.
- No barrel re-exports (`index.ts`). Import directly from the source file.

### Module responsibilities (do not mix)

- `pythonTypes.ts` → **pure functions only**, no VS Code API, no `async`.
- `debugger.ts` → all DAP communication; no UI, no panel management.
- `*Provider.ts` → data fetching only; produces a plain data object.
- `*Webview.ts` → HTML string generation only; no data fetching.
- `panelManager.ts` → panel lifecycle + refresh; no type detection.

### Front-end JS (media/)

- Vanilla JS, no TypeScript, no bundler — files are served directly.
- Each file is an IIFE `(function() { … })()`.
- Communicate with the extension host only via `vscode.postMessage()` and `window.addEventListener("message", …)`.
- Incoming messages from the extension: `{ type: "update", data }` and `{ type: "syncViewport", … }`.
- Outgoing messages to the extension: `{ type: "syncViewport", … }`.

### Security

- All webviews must set a `Content-Security-Policy` meta tag with a random nonce.
- Never inject unsanitised variable names or data into HTML template strings directly. Use `JSON.stringify` for data blobs.
- Debug evaluations run Python code inside the user's debug session (expected). Never evaluate expressions from untrusted sources.

---

## Common Tasks for Copilot

### Add support for a new Python type

1. **`src/utils/pythonTypes.ts`** — add a pattern to `IMAGE_TYPE_PATTERNS`, `PLOT_TYPE_PATTERNS`, or `POINTCLOUD_TYPE_PATTERNS`, and update `detectVisualizableType()` if shape-based logic is needed.
2. **`src/matImage/matProvider.ts`** (or plot/pointCloud equivalent) — add a new `fetch*` branch in the provider's `fetch*Data` method.
3. **`src/cvVariablesProvider.ts`** — `buildInspectExpr` should already cover new types via `hasattr`; update only if special metadata is needed.
4. **Tests** — add a unit test in `src/test/` covering the new type's detection and (mocked) data extraction.

### Add a new webview control (e.g. a slider)

1. Add the HTML element to the `/* html */` template string in `*Webview.ts`.
2. Add the event listener in the corresponding `media/*.js` IIFE.
3. If the control affects data (not just rendering), post a message to the extension host and handle it in `panelManager.ts`.

### Add a new command

1. Declare it in `package.json` under `contributes.commands`.
2. Add it to the appropriate `contributes.menus` entry.
3. Register it with `vscode.commands.registerCommand` in `extension.ts`.

---

## Testing

- Unit tests live in `src/test/` and use the `@vscode/test-electron` runner.
- Type-detection functions (`pythonTypes.ts`) are pure and should have high coverage.
- DAP interactions are tested with a mocked `vscode.DebugSession`.
- Run: `npm test`

---

## Build & Run

```bash
npm install          # install dependencies
npm run compile      # type-check + bundle (dist/extension.js)
npm run watch        # incremental watch mode (for development)
# Press F5 in VS Code to launch a new Extension Development Host
```

Vendored libraries (`three.min.js`, `uplot.iife.min.js`, `OrbitControls.js`) must be downloaded and placed in `media/` before the extension can run. See `docs/setup.md` for details.
