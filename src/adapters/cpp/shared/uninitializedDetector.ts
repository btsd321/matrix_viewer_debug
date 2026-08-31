/**
 * uninitializedDetector.ts — Detect C++ variables that are uninitialized or
 * contain invalid/corrupt data, so the extension can warn the user instead of
 * attempting to read garbage memory.
 *
 * This is a pure helper module with no VS Code or debug-session dependencies,
 * making it unit-testable without an extension host.
 *
 * Detection covers three signal categories (see UNINITIALIZED_DETECTION.md in
 * the reference project):
 *
 * 1. Debugger sentinel strings emitted by the DAP `variables` response `value`:
 *      LLDB:  <uninitialized>  <invalid>  <unavailable>
 *      GDB:   <optimized out>   <value optimized out>  <not available>
 *
 * 2. MSVC debug-heap fill patterns that appear as pointer-like values:
 *      0xCCCCCCCC  — uninitialized stack memory
 *      0xCDCDCDCD  — uninitialized heap memory
 *      0xFEEEFEEE  — freed heap memory
 *      0xBAADF00D  — Windows kernel uninitialized memory
 *      0xDEADBEEF  — common debug sentinel
 *
 * 3. Repeated-fill patterns: a pointer whose every byte is the same value
 *    (e.g. 0xDDDDDDDD, 0xEEEEEEEE) is very likely an MSVC debug fill.
 */

/** A value is considered uninitialized when any detector below fires. */
export function isUninitializedOrInvalid(value: string | undefined | null): boolean {
    if (value == null) {
        return false;
    }
    const v = value.trim();
    if (!v) {
        return false;
    }

    return (
        _isDebuggerSentinel(v) ||
        _isMsvcDebugPattern(v) ||
        _isRepeatedFill(v)
    );
}

// ── Detectors ───────────────────────────────────────────────────────────────

/**
 * Debugger sentinel strings.  These appear in the DAP `value` field of a
 * `variables` response when the debugger knows the variable is not usable.
 */
const DEBUGGER_SENTINELS: readonly string[] = [
    "<uninitialized>",
    "<invalid>",
    "<unavailable>",
    "<optimized out>",
    "<value optimized out>",
    "<not available>",
    "<no value>",
];

function _isDebuggerSentinel(value: string): boolean {
    return DEBUGGER_SENTINELS.some((s) => value.includes(s));
}

/**
 * Well-known MSVC / Windows debug fill patterns, checked as hex pointers.
 * Match both 32-bit (`0xCCCCCCCC`) and 64-bit (`0xCCCCCCCCcccccccc`) forms.
 */
const MSVC_PATTERNS: readonly bigint[] = [
    0xCCCCCCCCn,
    0xCDCDCDCDn,
    0xFEEEFEEEn,
    0xBAADF00Dn,
    0xDEADBEEFn,
];

function _isMsvcDebugPattern(value: string): boolean {
    // Extract the first hex literal from the value string.
    // DAP values for pointers look like "0xCCCCCCCC" or "0x00000000cccccccc".
    const m = value.match(/0x([0-9a-fA-F]+)/);
    if (!m) {
        return false;
    }
    const num = BigInt("0x" + m[1]);
    if (num === 0n) {
        return false;
    }
    // Match 32-bit patterns regardless of sign/zero-extension to 64 bits.
    const low32 = num & 0xFFFFFFFFn;
    return MSVC_PATTERNS.some(
        (p) => low32 === p || low32 === (p & 0xFFFFFFFFn)
    );
}

/**
 * Catch-all for repeated-byte fill patterns like 0xDDDDDDDD, 0xEEEEEEEE,
 * 0xABABABAB that some MSVC runtimes and sanitizers use but are not in the
 * explicit list above.
 */
function _isRepeatedFill(value: string): boolean {
    const m = value.match(/0x([0-9a-fA-F]{8,})/);
    if (!m) {
        return false;
    }
    const hex = m[1];
    if (hex.length < 8) {
        return false;
    }
    const fillChar = hex[hex.length - 1].toLowerCase();
    // Every nibble must be the same (ignore leading zeros from sign extension).
    const significant = hex.replace(/^0+/, "");
    if (significant.length < 8) {
        return false;
    }
    return [...significant].every((c) => c.toLowerCase() === fillChar);
}
