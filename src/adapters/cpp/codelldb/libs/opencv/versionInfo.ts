/**
 * opencv/versionInfo.ts — Fetch OpenCV runtime version via CodeLLDB (session.type = "lldb").
 *
 * cv::getVersionMajor/Minor/Revision are lightweight inline functions available
 * in OpenCV ≥ 3.0. CodeLLDB "watch" context supports calling them.
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
    const [majorRaw, minorRaw, patchRaw] = await Promise.all([
        evaluateExpression(session, "(int)cv::getVersionMajor()", frameId),
        evaluateExpression(session, "(int)cv::getVersionMinor()", frameId),
        evaluateExpression(session, "(int)cv::getVersionRevision()", frameId),
    ]);
    const major = parseVersionNum(majorRaw);
    if (major !== null) {
        const minor = parseVersionNum(minorRaw) ?? "?";
        const patch = parseVersionNum(patchRaw) ?? "?";
        return `${major}.${minor}.${patch}`;
    }
    return null;
}
