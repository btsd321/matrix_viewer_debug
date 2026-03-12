/**
 * pythonDebugger.ts — DAP communication layer for Python / debugpy sessions.
 *
 * All interactions with the Python debugpy debug session (and Jupyter) go
 * through here.  Provides:
 *   - Session type checks (debugpy, Jupyter)
 *   - Variable enumeration in the current scope
 *   - Python expression evaluation with timeout
 *   - Array data extraction (small: JSON, large: Base64 binary)
 *   - Common metadata fetch (shape, dtype, length)
 *
 * This module is internal to the Python adapter.
 * External code should use PythonAdapter (pythonAdapter.ts) instead.
 */

import * as vscode from "vscode";
import { VariableInfo } from "../IDebugAdapter";

// Re-export VariableInfo so legacy imports via utils/debugger still work.
export { VariableInfo } from "../IDebugAdapter";

// ── Python-specific internal types ────────────────────────────────────────

export interface RawArrayData {
  /** Flat byte array (from Base64 tobytes decode) */
  buffer: Uint8Array;
  dtype: string;
  shape: number[];
}

// ── Session Type Detection ─────────────────────────────────────────────────

export function isPythonSession(session: vscode.DebugSession): boolean {
  return session.type === "python" || session.type === "debugpy";
}

export function isJupyterSession(session: vscode.DebugSession): boolean {
  return session.type === "jupyter";
}

export function isSupportedSession(session: vscode.DebugSession): boolean {
  return isPythonSession(session) || isJupyterSession(session);
}

// ── Frame & Scope Utilities ────────────────────────────────────────────────

export async function getCurrentFrameId(
  session: vscode.DebugSession
): Promise<number | undefined> {
  try {
    const threadsResp = await session.customRequest("threads", {});
    const threadId: number = threadsResp?.threads?.[0]?.id;
    if (threadId == null) {
      return undefined;
    }
    const stackResp = await session.customRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 1,
    });
    return stackResp?.stackFrames?.[0]?.id;
  } catch {
    return undefined;
  }
}

/** Return all variables visible in the top frame of the first thread. */
export async function getVariablesInScope(
  session: vscode.DebugSession
): Promise<VariableInfo[]> {
  try {
    const frameId = await getCurrentFrameId(session);
    if (frameId == null) {
      return [];
    }

    const scopesResp = await session.customRequest("scopes", { frameId });
    const localScopeRef: number | undefined =
      scopesResp?.scopes?.[0]?.variablesReference;
    if (localScopeRef == null) {
      return [];
    }

    const varsResp = await session.customRequest("variables", {
      variablesReference: localScopeRef,
    });
    return (varsResp?.variables ?? []).map(
      (v: { name: string; type: string; variablesReference: number }) => ({
        name: v.name,
        type: v.type ?? "",
        variablesReference: v.variablesReference,
        frameId,
      })
    );
  } catch {
    return [];
  }
}

// ── Expression Evaluation ─────────────────────────────────────────────────

const EVALUATE_TIMEOUT_MS = 10_000;

/**
 * Evaluate a Python expression in the context of the given frame.
 * Returns the `result` string from DAP, or null on failure.
 */
export async function evaluateExpression(
  session: vscode.DebugSession,
  expression: string,
  frameId?: number
): Promise<string | null> {
  const resolvedFrame = frameId ?? (await getCurrentFrameId(session));
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), EVALUATE_TIMEOUT_MS)
  );
  const evalPromise = Promise.resolve(
    session.customRequest("evaluate", {
      expression,
      frameId: resolvedFrame,
      context: "repl",
    })
  )
    .then((r) => r?.result ?? null)
    .catch(() => null);

  return Promise.race([evalPromise, timeoutPromise]);
}

// ── Variable Metadata ─────────────────────────────────────────────────────

/**
 * Enrich a basic VariableInfo with shape, dtype, and typeName
 * by running a single compound evaluate in the debug session.
 */
export async function getVariableInfo(
  session: vscode.DebugSession,
  varName: string,
  frameId?: number
): Promise<VariableInfo | null> {
  const expr =
    `__import__('json').dumps({` +
    `'typeName': type(${varName}).__module__ + '.' + type(${varName}).__name__,` +
    `'shape': list(${varName}.shape) if hasattr(${varName}, 'shape') else None,` +
    `'dtype': str(${varName}.dtype) if hasattr(${varName}, 'dtype') else None,` +
    `'length': len(${varName}) if hasattr(${varName}, '__len__') else None` +
    `})`;

  const raw = await evaluateExpression(session, expr, frameId);
  if (!raw) {
    return null;
  }

  try {
    // debugpy wraps the result in quotes; strip them if present
    const jsonStr = raw.startsWith("'") ? raw.slice(1, -1) : raw;
    const parsed = JSON.parse(jsonStr);
    return {
      name: varName,
      type: parsed.typeName ?? "",
      typeName: parsed.typeName ?? "",
      shape: parsed.shape ?? null,
      dtype: parsed.dtype ?? null,
      length: parsed.length ?? null,
      frameId,
    };
  } catch {
    return null;
  }
}

// ── Array Data Extraction ─────────────────────────────────────────────────

const LARGE_DATA_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB default

/**
 * Fetch the numeric data of a Python array variable.
 *
 * Strategy:
 *   Small (< threshold): evaluate `tolist()` → JSON decode
 *   Large (>= threshold): evaluate `tobytes()` → Base64 → Uint8Array
 */
export async function fetchArrayData(
  session: vscode.DebugSession,
  varName: string,
  info: VariableInfo,
  thresholdBytes = LARGE_DATA_THRESHOLD_BYTES
): Promise<RawArrayData | null> {
  if (!info.shape || !info.dtype) {
    return null;
  }

  const { shape, dtype } = info;
  const totalElements = shape.reduce((a, b) => a * b, 1);
  const elBytes = bytesPerElementFromDtype(dtype);
  const totalBytes = totalElements * (elBytes ?? 4);

  if (totalBytes < thresholdBytes) {
    return fetchArraySmall(session, varName, info);
  } else {
    return fetchArrayLarge(session, varName, info);
  }
}

/** Small arrays: JSON path via tolist() */
async function fetchArraySmall(
  session: vscode.DebugSession,
  varName: string,
  info: VariableInfo
): Promise<RawArrayData | null> {
  const expr = buildToListExpr(varName, info);
  const result = await evaluateExpression(session, expr, info.frameId);
  if (!result) {
    return null;
  }
  try {
    const jsonStr = result.startsWith("'") ? result.slice(1, -1) : result;
    const parsed = JSON.parse(jsonStr);
    const flat = flattenNestedArray(parsed);
    const dtype = info.dtype!;
    const buffer = numbersToBytesForDtype(flat, dtype);
    return { buffer, dtype, shape: info.shape! };
  } catch {
    return null;
  }
}

/** Large arrays: Base64 binary path via tobytes() */
async function fetchArrayLarge(
  session: vscode.DebugSession,
  varName: string,
  info: VariableInfo
): Promise<RawArrayData | null> {
  // Ensure C-contiguous layout before tobytes
  const expr =
    `__import__('base64').b64encode(` +
    `(__import__('numpy').ascontiguousarray(${varName}) if hasattr(${varName}, 'flags') ` +
    `else ${varName}).tobytes()` +
    `).decode('ascii')`;

  const result = await evaluateExpression(session, expr, info.frameId);
  if (!result) {
    return null;
  }

  try {
    const b64 = result.replace(/^'|'$/g, "");
    const binaryStr = atob(b64);
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return { buffer, dtype: info.dtype!, shape: info.shape! };
  } catch {
    return null;
  }
}

// ── Pure list/tuple fetch ─────────────────────────────────────────────────

/** Fetch a Python list/tuple as a flat number array. */
export async function fetchListData(
  session: vscode.DebugSession,
  varName: string,
  frameId?: number
): Promise<number[] | null> {
  const expr = `__import__('json').dumps(list(${varName}))`;
  const result = await evaluateExpression(session, expr, frameId);
  if (!result) {
    return null;
  }
  try {
    const jsonStr = result.startsWith("'") ? result.slice(1, -1) : result;
    return JSON.parse(jsonStr) as number[];
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildToListExpr(varName: string, info: VariableInfo): string {
  if (info.typeName?.startsWith("numpy")) {
    return `__import__('json').dumps(${varName}.tolist())`;
  }
  if (info.typeName?.startsWith("torch")) {
    return `__import__('json').dumps(${varName}.detach().cpu().tolist())`;
  }
  return `__import__('json').dumps(list(${varName}))`;
}

function flattenNestedArray(arr: unknown): number[] {
  if (!Array.isArray(arr)) {
    return [arr as number];
  }
  return arr.flatMap((x) => flattenNestedArray(x));
}

function numbersToBytesForDtype(numbers: number[], dtype: string): Uint8Array {
  const n = numbers.length;
  switch (dtype) {
    case "uint8":
      return new Uint8Array(numbers);
    case "int8":
      return new Uint8Array(new Int8Array(numbers).buffer);
    case "uint16":
      return new Uint8Array(new Uint16Array(numbers).buffer);
    case "int16":
      return new Uint8Array(new Int16Array(numbers).buffer);
    case "uint32":
      return new Uint8Array(new Uint32Array(numbers).buffer);
    case "int32":
      return new Uint8Array(new Int32Array(numbers).buffer);
    case "float32":
      return new Uint8Array(new Float32Array(numbers).buffer);
    case "float64":
      return new Uint8Array(new Float64Array(numbers).buffer);
    default:
      return new Uint8Array(new Float64Array(numbers).buffer);
  }
  void n; // suppress unused warning
}

function bytesPerElementFromDtype(dtype: string): number | null {
  const map: Record<string, number> = {
    uint8: 1,
    int8: 1,
    uint16: 2,
    int16: 2,
    float16: 2,
    uint32: 4,
    int32: 4,
    float32: 4,
    uint64: 8,
    int64: 8,
    float64: 8,
  };
  return map[dtype] ?? null;
}
