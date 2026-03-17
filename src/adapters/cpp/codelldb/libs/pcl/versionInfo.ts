/**
 * pcl/versionInfo.ts — Fetch PCL version via CodeLLDB (session.type = "lldb").
 *
 * PCL_MAJOR_VERSION / PCL_MINOR_VERSION / PCL_REVISION_VERSION are
 * C preprocessor macros. They are NOT stored in debug symbols and cannot
 * be read via LLDB expression evaluation in general.
 *
 * On Linux/macOS with DWARF debug info, LLDB may resolve them as compile-time
 * constants. On Windows with PDB debug info, these macros are always absent.
 */

import * as vscode from "vscode";
import { evaluateExpression } from "../../debugger";
import { parseVersionNum } from "../../../shared/versionUtils";

/**
 * Return the PCL version string (e.g. "1.13.0") or null if PCL symbols
 * are not available in the current debug session.
 */
export async function fetchPclVersion(
    session: vscode.DebugSession,
    frameId: number | undefined
): Promise<string | null> {
    // Short-circuit: probe major first. If it fails, all macros will fail for
    // the same underlying reason (macros not in debug symbols); skip minor/patch.
    const majorRaw = await evaluateExpression(session, "(int)PCL_MAJOR_VERSION", frameId);
    const major = parseVersionNum(majorRaw);
    if (major === null) { return null; }
    const [minorRaw, patchRaw] = await Promise.all([
        evaluateExpression(session, "(int)PCL_MINOR_VERSION", frameId),
        evaluateExpression(session, "(int)PCL_REVISION_VERSION", frameId),
    ]);
    const minor = parseVersionNum(minorRaw) ?? "?";
    const patch = parseVersionNum(patchRaw) ?? "?";
    return `${major}.${minor}.${patch}`;
}
