/**
 * eigen/versionInfo.ts — Fetch Eigen version via CodeLLDB (session.type = "lldb").
 *
 * EIGEN_WORLD_VERSION / EIGEN_MAJOR_VERSION / EIGEN_MINOR_VERSION are
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
 * Return the Eigen version string (e.g. "3.4.0") or null if Eigen symbols
 * are not available in the current debug session.
 */
export async function fetchEigenVersion(
    session: vscode.DebugSession,
    frameId: number | undefined
): Promise<string | null> {
    // Short-circuit: probe major first. If it fails, all macros will fail for
    // the same underlying reason (macros not in debug symbols); skip minor/patch.
    const majorRaw = await evaluateExpression(session, "(int)EIGEN_WORLD_VERSION", frameId);
    const major = parseVersionNum(majorRaw);
    if (major === null) { return null; }
    const [minorRaw, patchRaw] = await Promise.all([
        evaluateExpression(session, "(int)EIGEN_MAJOR_VERSION", frameId),
        evaluateExpression(session, "(int)EIGEN_MINOR_VERSION", frameId),
    ]);
    const minor = parseVersionNum(minorRaw) ?? "?";
    const patch = parseVersionNum(patchRaw) ?? "?";
    return `${major}.${minor}.${patch}`;
}
