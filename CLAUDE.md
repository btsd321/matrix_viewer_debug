# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # Install dependencies
npm run compile          # Type-check + lint + bundle → dist/extension.js
npm run watch            # Incremental watch mode (esbuild + tsc)
npm run check-types      # Type-check only (no emit)
npm run lint             # ESLint on src/
npm test                 # Run extension tests (requires compile first)
```

Press F5 in VS Code to launch an Extension Development Host with the extension loaded.

## Architecture

This is a VS Code extension that visualizes 1D/2D/3D data structures during debugging. It communicates with debuggers exclusively through the **Debug Adapter Protocol (DAP)** via `vscode.DebugSession.customRequest()` — no separate processes, no custom debug adapters.

### Three-layer provider hierarchy

```
IDebugAdapter (one per language)
  └─ Per-debugger layer (gdb/ | codelldb/ | cppvsdbg/)
       └─ Coordinator (*Provider.ts) — iterates a provider list
            └─ ILib*Provider (libs/<libName>/) — one file per library
```

**Critical design rule**: GDB, CodeLLDB, and vsdbg each have their own complete copy of library providers under `src/adapters/cpp/{gdb,codelldb,cppvsdbg}/libs/`. These are intentionally duplicated, not shared — each debugger has different expression syntax (`(long long)` casts vs bare pointers, `"repl"` vs `"watch"` evaluate context). When adding a C++ library feature, you must implement it in **all three** debugger directories.

### Two-layer type detection

1. **Layer 1** (`cppTypes.ts` / `pythonTypes.ts`): Fast string match on DAP type names. Runs in the TreeView without debugger round-trips. Pure functions, no async, no VS Code API.
2. **Layer 2** (`detectVisualizableType()` in each adapter): Shape-aware classification using actual dimensions/dtype from `evaluate`. Refines Layer-1 decisions (e.g., Eigen matrix → image vs plot based on rows/cols).

### Data flow

```
User clicks variable → extension.ts
  → adapterRegistry.getAdapter(session)
  → adapter.getVariableInfo()         # DAP evaluate/variables
  → adapter.detectVisualizableType()  # Layer 1 + 2
  → adapter.fetchImageData()          # Coordinator → lib provider
      → lib provider: DAP evaluate for metadata
      → lib provider: DAP readMemory for pixel bytes (C++)
      → lib provider: TCP loopback for large arrays (Python)
  → panelManager.openXxxPanel()       # Webview with injected data
```

### Key DAP requests used everywhere

- `"scopes"` → get variablesReference for local scope
- `"variables"` → get children of a scope/variable reference
- `"evaluate"` → evaluate expression in debuggee (context: `"repl"` for GDB/vsdbg, `"watch"` for CodeLLDB)
- `"readMemory"` → read raw bytes from debuggee address space

### Smart pointer unwrapping

Before type detection or data fetching, all C++ pointer wrappers are unwrapped: `std::shared_ptr`, `std::unique_ptr`, `std::weak_ptr`, `boost::shared_ptr`, `QSharedPointer`, `QScopedPointer`, raw `T*`. The unwrap logic in `shared/utils.ts` returns the inner type and dereference strategy. This is transparent to library providers — they only see the inner type.

### cv::Mat detection fallback

When GDB doesn't report `cv::Mat` as the type name, `detectCvMatFromChildren()` in `debuggerBase.ts` checks for the presence of child fields `flags`, `dims`, `rows`, `cols`, `data` — if 4+ match, it classifies as `cv::Mat`.

## Logging

Use the singleton `logger` from `src/log/logger.ts`. Never use `console.log`. Import only what's needed:

```typescript
import { logger } from "../../log/logger";
logger.debug(`fetched ${count} points`);
logger.warn(`unsupported type: ${typeName}`);
```

Levels: `DEBUG` (internal state), `INFO` (key operations), `WARN` (recoverable issues), `ERROR` (unexpected failures).

## File placement rules (C++ adapter)

- `shared/utils.ts` — helpers used by ≥2 library folders (buffer conversion, stats, dtype mapping). No DAP communication, no single-library logic.
- `shared/debuggerBase.ts` — shared DAP utilities, no debugger-type branching.
- `{debugger}/libs/utils.ts` — thin re-export of `shared/utils.ts`.
- `libs/<libName>/` — code exclusive to one library. Each file implements one `ILib*Provider` interface.

If a function is used by only one library folder, it stays in that folder. Move to `shared/` only when a second library needs it.

## Detailed reference

See `.github/copilot-instructions.md` for the full architecture diagram, coding conventions, module responsibility rules, and step-by-step guides for adding new libraries/languages/types.
