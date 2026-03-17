import * as vscode from "vscode";
import { evaluateExpression } from "../../debugger";

/**
 * Return the Qt version string (e.g. "5.15.2") or null if Qt symbols are not
 * available in the current debug session.
 *
 * qVersion() returns a compile-time const char* like "5.15.2".
 * On Windows with PDB debug info, LLDB may fail to call C functions;
 * in that case both attempts return null and we return null silently.
 */
export async function fetchQtVersion(
    session: vscode.DebugSession,
    frameId: number | undefined
): Promise<string | null> {
    // Try the plain call; on some LLDB configurations (int) cast is unnecessary
    // for const char* return types and may actually cause a Syntax error.
    const raw = await evaluateExpression(session, "qVersion()", frameId);
    if (!raw) { return null; }
    // CodeLLDB returns the char* content directly (e.g. "5.15.2")
    const clean = raw.replace(/^['"]+|['"]+$/g, "").trim();
    // Validate it starts with a digit — basic sanity guard
    if (/^\d+\.\d+/.test(clean)) { return clean; }
    return null;
}
