/**
 * opencv/versionInfo.ts — Fetch OpenCV runtime version via CodeLLDB (session.type = "lldb").
 *
 * cv::getVersionMajor/Minor/Revision are lightweight inline functions available
 * in OpenCV ≥ 3.0. CodeLLDB "watch" context supports calling them.
 *
 * On Windows with PDB debug info, LLDB cannot execute C-style casts like (int)expr.
 * Try the bare function call first, then fall back to the cast form.
 */

import * as vscode from "vscode";
import { evaluateExpression } from "../../debugger";
import { parseVersionNum } from "../../../shared/versionUtils";

/**
 * Return the OpenCV version string (e.g. "4.8.0") or null if OpenCV symbols
 * are not available in the current debug session.
 */
export async function fetchOpenCvVersion(
    session: vscode.DebugSession,
    frameId: number | undefined
): Promise<string | null> {
    // Try bare function calls first (works on Windows/PDB where (int) cast fails).
    // Fall back to cast form for debuggers that need an explicit int conversion.
    const tryInt = async (fn: string): Promise<string | null> => {
        return (
            await evaluateExpression(session, fn, frameId) ??
            await evaluateExpression(session, `(int)${fn}`, frameId)
        );
    };
    // Short-circuit: probe major version first. If it fails, all three functions
    // will fail for the same underlying reason (e.g. LLDB on Windows cannot call
    // C++ functions); skip minor/patch to avoid two more failure delays.
    const majorRaw = await tryInt("cv::getVersionMajor()");
    const major = parseVersionNum(majorRaw);
    if (major === null) { return null; }
    const [minorRaw, patchRaw] = await Promise.all([
        tryInt("cv::getVersionMinor()"),
        tryInt("cv::getVersionRevision()"),
    ]);
    const minor = parseVersionNum(minorRaw) ?? "?";
    const patch = parseVersionNum(patchRaw) ?? "?";
    return `${major}.${minor}.${patch}`;
}
