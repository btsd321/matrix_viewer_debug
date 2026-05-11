/**
 * utils.ts — Shared buffer/type helpers for C++ lib providers.
 *
 * Pure TypeScript functions with no VS Code or debug-session dependencies.
 * Mirrors the role of src/adapters/python/libs/utils.ts for the C++ side.
 */

import { Buffer } from "node:buffer";

// ── Smart pointer helpers─────────────────────────────────────────────────

/**
 * Describes how to dereference a pointer wrapper in a C++ debug expression.
 *
 *   "deref"      → `(*varName)`         — shared_ptr, unique_ptr, raw pointer
 *   "lock_deref" → `(*varName.lock())`  — weak_ptr (must be locked before deref)
 */
export type SmartPtrDerefKind = "deref" | "lock_deref";

/**
 * Identifies which C++ debugger we're talking to. Influences which internal
 * smart-pointer field we can directly access (libstdc++ uses `_M_ptr`, MSVC
 * STL uses `_Ptr`, libc++/LLDB has neither stably exposed via `evaluate`).
 */
export type DebuggerKind = "gdb" | "lldb" | "msvc";

export interface SmartPtrUnwrapResult {
    /** The inner (pointed-to) type, e.g. "cv::Mat" from "shared_ptr<cv::Mat>". */
    innerType: string;
    /** The dereference strategy to use when building debug expressions. */
    kind: SmartPtrDerefKind;
    /**
     * The wrapper category that produced this result. Used by helpers that
     * need to differentiate template-based wrappers from raw pointers (raw
     * pointers do not have an internal "managed pointer" field).
     */
    wrapper: "shared" | "unique" | "weak" | "raw";
}

/**
 * If `typeName` is a pointer wrapper, return the inner type and deref strategy.
 * Returns `null` when the type is not a supported wrapper.
 *
 * Handled wrappers:
 *   std::shared_ptr<T>    std::unique_ptr<T>    std::weak_ptr<T>
 *   boost::shared_ptr<T>
 *   QSharedPointer<T>     QScopedPointer<T>
 *   T*  /  T * const  /  const T*   (raw C pointer, single indirection only)
 *
 * Examples:
 *   "std::shared_ptr<cv::Mat>"           → { innerType: "cv::Mat",          kind: "deref" }
 *   "std::weak_ptr<Eigen::MatrixXd>"     → { innerType: "Eigen::MatrixXd",  kind: "lock_deref" }
 *   "cv::Mat *"                          → { innerType: "cv::Mat",          kind: "deref" }
 *   "const std::vector<double> *"        → { innerType: "std::vector<double>", kind: "deref" }
 *   "cv::Mat"                            → null
 */
export function unwrapSmartPointer(typeName: string): SmartPtrUnwrapResult | null {
    const trimmed = typeName.trim();

    // ── Template-based wrappers (shared_ptr, unique_ptr, weak_ptr, Qt) ───────
    const TEMPLATE_WRAPPERS: { prefix: string; kind: SmartPtrDerefKind; wrapper: "shared" | "unique" | "weak" }[] = [
        { prefix: "std::shared_ptr",         kind: "deref",      wrapper: "shared" },
        { prefix: "std::__1::shared_ptr",    kind: "deref",      wrapper: "shared" },   // libc++ (LLDB/macOS)
        { prefix: "std::unique_ptr",         kind: "deref",      wrapper: "unique" },
        { prefix: "std::__1::unique_ptr",    kind: "deref",      wrapper: "unique" },
        // libc++ internal alias for unique_ptr: std::_MakeUniq<T>::__single_object
        // LLDB reports `auto p = make_unique<T>()` with this type string.
        { prefix: "std::_MakeUniq",          kind: "deref",      wrapper: "unique" },
        { prefix: "std::__1::_MakeUniq",     kind: "deref",      wrapper: "unique" },
        { prefix: "std::weak_ptr",           kind: "lock_deref", wrapper: "weak" },
        { prefix: "std::__1::weak_ptr",      kind: "lock_deref", wrapper: "weak" },
        { prefix: "boost::shared_ptr",       kind: "deref",      wrapper: "shared" },
        { prefix: "QSharedPointer",          kind: "deref",      wrapper: "shared" },
        { prefix: "QScopedPointer",          kind: "deref",      wrapper: "unique" },
    ];

    for (const { prefix, kind, wrapper } of TEMPLATE_WRAPPERS) {
        if (!trimmed.startsWith(prefix)) {
            continue;
        }
        const rest = trimmed.slice(prefix.length).trimStart();
        if (!rest.startsWith("<")) {
            continue;
        }
        // Bracket-count to find the matching closing '>'
        let depth = 0;
        let i = 0;
        for (; i < rest.length; i++) {
            if (rest[i] === "<") { depth++; }
            else if (rest[i] === ">") {
                depth--;
                if (depth === 0) { break; }
            }
        }
        if (depth !== 0) {
            continue; // malformed type string
        }
        const inner = rest.slice(1, i).trim(); // strip outer < >
        if (inner.length > 0) {
            return { innerType: inner, kind, wrapper };
        }
    }

    // ── Raw C pointer: T* / T * / const T * / T * const ─────────────────────
    // Algorithm:
    //   1. Strip trailing "const" (const pointer: T * const)
    //   2. Strip trailing "*"
    //   3. Strip leading "const" (pointer to const: const T *)
    //   4. Verify the result has balanced angle brackets (guards against
    //      false matches on template params like std::vector<int*>)
    //   5. Exclude scalar/special types that cannot be visualized
    let s = trimmed;
    // Step 1: optional trailing " const"
    s = s.replace(/\s+const\s*$/, "").trimEnd();
    // Step 2: must end with * (single indirection only — reject T**)
    if (!s.endsWith("*")) {
        return null;
    }
    if (s.length >= 2 && s[s.length - 2] === "*") {
        return null; // double pointer
    }
    s = s.slice(0, -1).trimEnd();
    // Step 3: optional leading "const "
    s = s.replace(/^const\s+/, "").trim();
    if (s.length === 0) {
        return null;
    }
    // Step 4: balanced angle brackets
    let depth = 0;
    for (const c of s) {
        if (c === "<") { depth++; }
        else if (c === ">") { depth--; }
        if (depth < 0) { return null; }
    }
    if (depth !== 0) {
        return null;
    }
    // Step 5: exclude non-visualizable bare types
    const bare = s.replace(/^(?:const|volatile)\s+/, "").trim();
    if (!bare || /^(?:void|char|wchar_t|char8_t|char16_t|char32_t)$/.test(bare)) {
        return null;
    }
    return { innerType: s, kind: "deref", wrapper: "raw" };
}

/**
 * Build the debug expression that dereferences a smart/raw pointer to its
 * pointed-to object.  Centralises the (debugger × wrapper) lookup table that
 * was previously duplicated across every coordinator.
 *
 * GDB rationale: libstdc++'s `shared_ptr<T>` / `unique_ptr<T>` cannot be
 * dereferenced via `*x` in `evaluate` reliably — GDB does not always inline
 * `operator*` and may return empty results while triggering side-effects on
 * `this=0x0` (segfault).  We instead read the internal raw pointer field
 * `_M_ptr` and dereference *that*, which is a pure memory load.
 *
 * MSVC STL stores the managed pointer in `_Ptr` (member of `_Ptr_base<T>`).
 *
 * LLDB synthetic formatters expose the pointed-to object directly via `*x`,
 * so we keep that for shared/unique. Weak_ptr still needs `.lock()`.
 */
export function buildDerefExpression(
    varName: string,
    unwrap: SmartPtrUnwrapResult,
    debuggerKind: DebuggerKind
): string {
    if (unwrap.wrapper === "raw") {
        return `(*${varName})`;
    }

    if (debuggerKind === "gdb") {
        // libstdc++ internal layout differs by wrapper:
        //   shared_ptr / weak_ptr → __shared_ptr base has `_M_ptr`
        //   unique_ptr            → no clean field path (the tuple member
        //     `_M_head_impl` is ambiguous between the pointer and the
        //     deleter base classes).  Exploit the EBO guarantee instead:
        //     when Deleter is empty (default_delete is), sizeof(unique_ptr<T>)
        //     equals sizeof(T*) and the pointer occupies the object's first
        //     bytes — so `*(T**)&up` reads the raw pointer reliably.
        if (unwrap.wrapper === "unique") {
            return `(**(${unwrap.innerType}**)&${varName})`;
        }
        return `(*${varName}._M_ptr)`;
    }
    if (debuggerKind === "msvc") {
        if (unwrap.wrapper === "weak") {
            return `(*${varName}._Ptr)`;
        }
        return `(*${varName})`;
    }
    // lldb (CodeLLDB)
    if (unwrap.wrapper === "weak") {
        return `(*${varName}.lock())`;
    }
    return `(*${varName})`;
}

/**
 * Build a debug expression that evaluates to a *truthy* value when the smart
 * or raw pointer is null/empty — i.e. when dereferencing it would crash the
 * inferior.  Use as a guard before any expression that calls members on the
 * pointed-to object (e.g. `${derefExpr}.rows`).
 */
export function buildNullGuardExpression(
    varName: string,
    unwrap: SmartPtrUnwrapResult,
    debuggerKind: DebuggerKind
): string {
    if (unwrap.wrapper === "raw") {
        return `${varName} == 0`;
    }

    if (debuggerKind === "gdb") {
        if (unwrap.wrapper === "unique") {
            return `*(${unwrap.innerType}**)&${varName} == 0`;
        }
        return `${varName}._M_ptr == 0`;
    }
    if (debuggerKind === "msvc") {
        return `${varName}._Ptr == 0`;
    }
    // lldb
    if (unwrap.wrapper === "weak") {
        return `${varName}.expired()`;
    }
    return `${varName}.get() == 0`;
}

/** Map a vscode `DebugSession.type` to our debugger taxonomy. */
export function debuggerKindFromSessionType(sessionType: string): DebuggerKind {
    if (sessionType === "lldb") { return "lldb"; }
    if (sessionType === "cppvsdbg") { return "msvc"; }
    return "gdb";
}

// ── C++ type helpers ─────────────────────────────────────────────────────

/**
 * Map a C++ element type string to a dtype string compatible with
 * `viewerTypes.ts` and the front-end renderers.
 * Used by Eigen, STL, and other non-OpenCV providers.
 */
export function cppTypeToDtype(cppType: string): string {
    const t = cppType.toLowerCase().trim();
    if (t === "double" || t.includes("double")) {
        return "float64";
    }
    if (t === "float" || t.includes("float")) {
        return "float32";
    }
    if (t === "int" || t === "int32_t" || t.includes("int32")) {
        return "int32";
    }
    if (t === "short" || t === "int16_t" || t.includes("int16")) {
        return "int16";
    }
    // Check uint16 BEFORE int16 handling above, and uint8 BEFORE int8
    if (t === "unsigned short" || t === "uint16_t" || t.includes("uint16")) {
        return "uint16";
    }
    if (
        t === "unsigned char" ||
        t === "uchar" ||
        t === "uint8_t" ||
        t.includes("uint8")
    ) {
        return "uint8";
    }
    if (
        t === "char" ||
        t === "signed char" ||
        t === "int8_t" ||
        t.includes("int8")
    ) {
        return "int8";
    }
    return "uint8"; // default
}

// ── Buffer helpers ─────────────────────────────────────────────────────────

/** Build a typed ArrayBufferView over a raw Uint8Array given a dtype string. */
export function typedViewOf(
    buffer: Uint8Array,
    dtype: string
): ArrayLike<number> {
    const ab = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
    );
    switch (dtype) {
        case "uint8":
            return new Uint8Array(ab);
        case "int8":
            return new Int8Array(ab);
        case "uint16":
            return new Uint16Array(ab);
        case "int16":
            return new Int16Array(ab);
        case "uint32":
            return new Uint32Array(ab);
        case "int32":
            return new Int32Array(ab);
        case "float32":
            return new Float32Array(ab);
        case "float64":
            return new Float64Array(ab);
        default:
            return new Float32Array(ab);
    }
}

/** Convert a Uint8Array to a flat number[] using the given dtype name. */
export function typedBufferToNumbers(
    buffer: Uint8Array,
    dtype: string
): number[] {
    return Array.from(typedViewOf(buffer, dtype) as ArrayLike<number>);
}

/** Compute min/max over a raw Uint8Array given its dtype. */
export function computeMinMax(
    buffer: Uint8Array,
    dtype: string
): { dataMin: number; dataMax: number } {
    const view = typedViewOf(buffer, dtype);
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (let i = 0; i < view.length; i++) {
        const v = (view as ArrayLike<number>)[i];
        if (v < dataMin) {
            dataMin = v;
        }
        if (v > dataMax) {
            dataMax = v;
        }
    }
    return {
        dataMin: isFinite(dataMin) ? dataMin : 0,
        dataMax: isFinite(dataMax) ? dataMax : 1,
    };
}

/** Encode a Uint8Array to a Base64 string (chunked to avoid stack overflow). */
export function bufferToBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString("base64");
}

// ── Stats helpers ─────────────────────────────────────────────────────────

export interface DataStats {
    min: number;
    max: number;
    mean: number;
    std: number;
}

export function computeStats(values: number[]): DataStats {
    const n = values.length;
    if (n === 0) {
        return { min: 0, max: 0, mean: 0, std: 0 };
    }
    let min = values[0];
    let max = values[0];
    let sum = 0;
    for (const v of values) {
        if (v < min) {
            min = v;
        }
        if (v > max) {
            max = v;
        }
        sum += v;
    }
    const mean = sum / n;
    const std = Math.sqrt(
        values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
    );
    return { min, max, mean, std };
}

// ── Point cloud helpers ───────────────────────────────────────────────────

export interface XYZBounds {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    zMin: number;
    zMax: number;
}

export function computeBounds(xyz: number[]): XYZBounds {
    let xMin = Infinity,
        xMax = -Infinity;
    let yMin = Infinity,
        yMax = -Infinity;
    let zMin = Infinity,
        zMax = -Infinity;
    for (let i = 0; i < xyz.length; i += 3) {
        if (xyz[i] < xMin) {
            xMin = xyz[i];
        }
        if (xyz[i] > xMax) {
            xMax = xyz[i];
        }
        if (xyz[i + 1] < yMin) {
            yMin = xyz[i + 1];
        }
        if (xyz[i + 1] > yMax) {
            yMax = xyz[i + 1];
        }
        if (xyz[i + 2] < zMin) {
            zMin = xyz[i + 2];
        }
        if (xyz[i + 2] > zMax) {
            zMax = xyz[i + 2];
        }
    }
    return {
        xMin: isFinite(xMin) ? xMin : 0,
        xMax: isFinite(xMax) ? xMax : 0,
        yMin: isFinite(yMin) ? yMin : 0,
        yMax: isFinite(yMax) ? yMax : 0,
        zMin: isFinite(zMin) ? zMin : 0,
        zMax: isFinite(zMax) ? zMax : 0,
    };
}
