/**
 * matUtils.ts — cv::Mat metadata helpers for the C++ OpenCV lib provider.
 *
 * Contains all DAP-level operations specific to reading cv::Mat / cv::Mat_<T>
 * internal state (rows, cols, channels, depth, data pointer).
 *
 * cv::Mat flags encoding (OpenCV 4.x):
 *   matType  = flags & 0xFFF
 *   depth    = matType & 7          (0=CV_8U … 6=CV_64F)
 *   channels = ((matType >> 3) & 63) + 1
 */

import * as vscode from "vscode";
import {
    evaluateExpression,
    isValidMemoryReference,
    tryGetDataPointer,
    buildDataPointerExpressions,
} from "../../debugger";
import { logger } from "../../../../../log/logger";

// ── OpenCV depth constants ────────────────────────────────────────────────

/**
 * OpenCV depth → bytes-per-element mapping.
 *   CV_8U=0, CV_8S=1, CV_16U=2, CV_16S=3, CV_32S=4, CV_32F=5, CV_64F=6
 */
export const CV_DEPTH_BYTES: Record<number, number> = {
    0: 1, // CV_8U
    1: 1, // CV_8S
    2: 2, // CV_16U
    3: 2, // CV_16S
    4: 4, // CV_32S
    5: 4, // CV_32F
    6: 8, // CV_64F
};

/** Return the byte size of one element for an OpenCV depth constant. */
export function getBytesPerElement(cvDepth: number): number {
    return CV_DEPTH_BYTES[cvDepth] ?? 1;
}

/**
 * Map an OpenCV depth constant to a dtype string compatible with
 * `viewerTypes.ts` and the front-end canvas renderer.
 */
export function cvDepthToDtype(depth: number): string {
    switch (depth) {
        case 0: return "uint8";
        case 1: return "int8";
        case 2: return "uint16";
        case 3: return "int16";
        case 4: return "int32";
        case 5: return "float32";
        case 6: return "float64";
        default: return "uint8";
    }
}

/**
 * Infer an OpenCV depth constant from a C++ element type string.
 * Used when parsing cv::Mat_<T> template parameters.
 */
export function cppTypeToCvDepth(cppType: string): number {
    const t = cppType.toLowerCase().trim();
    if (t === "double" || t.includes("double")) { return 6; }
    if (t === "float" || t.includes("float")) { return 5; }
    if (t === "int" || t === "int32_t" || t.includes("int32")) { return 4; }
    if (t === "short" || t === "int16_t" || t.includes("int16")) { return 3; }
    if (t === "unsigned short" || t === "uint16_t" || t.includes("uint16")) { return 2; }
    // Check uint8 BEFORE int8 (uint8_t contains "int8")
    if (t === "unsigned char" || t === "uchar" || t === "uint8_t" || t.includes("uint8")) { return 0; }
    if (t === "char" || t === "signed char" || t === "int8_t" || t.includes("int8")) { return 1; }
    return 0;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface MatInfo {
    rows: number;
    cols: number;
    channels: number;
    /**
     * OpenCV depth constant:
     *   CV_8U=0, CV_8S=1, CV_16U=2, CV_16S=3, CV_32S=4, CV_32F=5, CV_64F=6
     */
    depth: number;
    /** Hex address string suitable for `readMemory` requests. */
    dataPtr: string;
}

// ── Variables-tree approach ───────────────────────────────────────────────

/**
 * Extract cv::Mat metadata by walking the DAP variables tree.
 *
 * Works for:
 *   - Plain `cv::Mat`        (rows / cols / flags / data child members)
 *   - `cv::Mat_<T>`          (has an internal `cv::Mat` base-class member)
 *
 * Depth and channel count are decoded from the `flags` field:
 *   type     = flags & 0xFFF
 *   depth    = type & 7
 *   channels = ((type >> 3) & 63) + 1
 *
 * Returns null when the Mat appears empty, uninitialised, or unreadable.
 */
export async function getMatInfoFromVariables(
    session: vscode.DebugSession,
    variablesReference: number
): Promise<MatInfo | null> {
    try {
        const varsResp = await session.customRequest("variables", {
            variablesReference,
        });

        const vars: {
            name: string;
            value: string;
            memoryReference?: string;
            variablesReference?: number;
        }[] = varsResp?.variables ?? [];

        // Smart pointer wrapping (CodeLLDB synthetic formatter):
        //   weak_ptr<T> / shared_ptr<T> / unique_ptr<T> exposes a "pointer" child.
        //   Expanding "pointer" gives either:
        //   (a) the pointed-to struct's fields directly (e.g. cv::Mat → flags/rows/cols/data)
        //   (b) a container's formatted elements ([0],[1],...) for e.g. shared_ptr<vector<Mat>>
        //   Strategy: recurse into ptrChild.variablesReference directly first (covers case a),
        //   then look for [0] as a fallback (covers case b).
        const ptrChild = vars.find(
            (v) => v.name === "pointer" && (v.variablesReference ?? 0) > 0
        );
        if (ptrChild) {
            // Case (a): ptrChildren are the inner object's struct fields
            const innerFromPtr = await getMatInfoFromVariables(session, ptrChild.variablesReference!);
            if (innerFromPtr && innerFromPtr.rows > 0 && innerFromPtr.cols > 0 && innerFromPtr.dataPtr) {
                return innerFromPtr;
            }
            // Case (b): ptrChildren are formatted container elements; [0] IS the object
            const ptrResp = await session.customRequest("variables", {
                variablesReference: ptrChild.variablesReference!,
            });
            const ptrChildren: {
                name: string;
                value: string;
                memoryReference?: string;
                variablesReference?: number;
            }[] = ptrResp?.variables ?? [];
            const elem0 = ptrChildren.find(
                (c) => c.name === "[0]" && (c.variablesReference ?? 0) > 0
            );
            if (elem0) {
                const inner = await getMatInfoFromVariables(session, elem0.variablesReference!);
                if (inner && inner.rows > 0 && inner.cols > 0 && inner.dataPtr) {
                    return inner;
                }
            }
        }

        // cv::Mat_<T> embeds the pixel data inside a base cv::Mat member.
        // Recurse into it when found.
        for (const v of vars) {
            if (
                v.name === "cv::Mat" ||
                (v.name === "Mat" && (v.value ?? "").includes("rows"))
            ) {
                if (v.variablesReference && v.variablesReference > 0) {
                    const inner = await getMatInfoFromVariables(
                        session,
                        v.variablesReference
                    );
                    if (inner && inner.rows > 0 && inner.cols > 0 && inner.dataPtr) {
                        return inner;
                    }
                }
            }
        }

        let rows = 0,
            cols = 0,
            channels = 1,
            depth = 0;
        let dataPtr = "";

        for (const v of vars) {
            if (v.name === "rows") {
                rows = parseInt(v.value) || 0;
            } else if (v.name === "cols") {
                cols = parseInt(v.value) || 0;
            } else if (v.name === "flags") {
                const flags = parseInt(v.value) || 0;
                const matType = flags & 0xfff;
                depth = matType & 7;
                channels = ((matType >> 3) & 63) + 1;
            } else if (v.name === "data") {
                // Prefer the DAP memoryReference field (most reliable)
                if (v.memoryReference && isValidMemoryReference(v.memoryReference)) {
                    dataPtr = v.memoryReference;
                } else {
                    const ptrMatch = v.value?.match(/0x[0-9a-fA-F]+/);
                    if (ptrMatch && isValidMemoryReference(ptrMatch[0])) {
                        dataPtr = ptrMatch[0];
                    }
                }

                // Last resort: expand the `data` node to find the raw pointer child
                if (!dataPtr && v.variablesReference && v.variablesReference > 0) {
                    try {
                        const dataVars = await session.customRequest("variables", {
                            variablesReference: v.variablesReference,
                        });
                        for (const dv of dataVars?.variables ?? []) {
                            if (
                                dv.memoryReference &&
                                isValidMemoryReference(dv.memoryReference)
                            ) {
                                dataPtr = dv.memoryReference;
                                break;
                            }
                            const ptr2 = dv.value?.match(/0x[0-9a-fA-F]+/);
                            if (ptr2 && isValidMemoryReference(ptr2[0])) {
                                dataPtr = ptr2[0];
                                break;
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                }
            }
        }

        if (rows <= 0 || cols <= 0 || !dataPtr) {
            return null;
        }
        return { rows, cols, channels, depth, dataPtr };
    } catch {
        return null;
    }
}

// ── Evaluate-expression fallback ──────────────────────────────────────────

/**
 * Fallback for debuggers where `evaluate` expression access works well
 * (cppdbg / cppvsdbg). Reads `.rows`, `.cols`, and `.flags` concurrently,
 * then resolves the `.data` pointer via debugger-specific cast expressions.
 */
export async function getMatInfoFromEvaluate(
    session: vscode.DebugSession,
    varName: string,
    frameId?: number
): Promise<MatInfo | null> {
    const [rowsRes, colsRes, flagsRes] = await Promise.all([
        evaluateExpression(session, `${varName}.rows`, frameId),
        evaluateExpression(session, `${varName}.cols`, frameId),
        evaluateExpression(session, `${varName}.flags`, frameId),
    ]);

    const rows = parseInt(rowsRes ?? "0");
    const cols = parseInt(colsRes ?? "0");

    if (isNaN(rows) || isNaN(cols) || rows <= 0 || cols <= 0) {
        return null;
    }

    const flags = parseInt(flagsRes ?? "0");
    const matType = flags & 0xfff;
    const depth = matType & 7;
    const channels = ((matType >> 3) & 63) + 1;

    const dataExpressions = buildDataPointerExpressions(
        varName,
        ".data"
    );
    const dataPtr = await tryGetDataPointer(session, dataExpressions, frameId);
    if (!dataPtr) {
        return null;
    }

    return { rows, cols, channels, depth, dataPtr };
}

// ── GpuMat helpers ─────────────────────────────────────────────────────────

/**
 * Extract cv::cuda::GpuMat metadata and download data to host memory.
 *
 * GPU memory is not accessible via DAP readMemory, so this function evaluates
 * a C++ expression that creates a host cv::Mat, calls GpuMat::download(), and
 * returns the host data pointer. The host Mat is heap-allocated and persists
 * for the remainder of the debug session.
 *
 * GpuMat uses the same type encoding as cv::Mat::type():
 *   depth    = type & 7
 *   channels = ((type >> 3) & 63) + 1
 */
export async function getGpuMatInfo(
    session: vscode.DebugSession,
    varName: string,
    frameId?: number
): Promise<MatInfo | null> {
    // For `(*xxx.lock())` (weak_ptr lock_deref), the simple evaluator can't
    // invoke `.lock()`. CodeLLDB's weak_ptr synthetic formatter exposes a
    // `pointer` child of type `T*` — `wp.pointer->field` works directly.
    // Internal raw-pointer fields (`_M_ptr`/`__ptr_`/`_Ptr`) are NOT visible
    // through the simple evaluator (the formatter hides them).
    const lockDeref = varName.match(/^\(\*(.+)\.lock\(\)\)$/);
    const fieldExpr = (field: string): string => {
        if (lockDeref) {
            return `${lockDeref[1]}.pointer->${field}`;
        }
        return `${varName}.${field}`;
    };

    const tryFieldInt = async (field: string): Promise<{ raw: string | null; value: number }> => {
        const raw = await evaluateExpression(session, fieldExpr(field), frameId);
        if (raw == null) {
            return { raw: null, value: NaN };
        }
        const v = parseInt(raw.match(/=\s*(-?\d+)/)?.[1] ?? raw);
        return { raw, value: v };
    };

    const [rowsR, colsR, flagsR] = await Promise.all([
        tryFieldInt("rows"),
        tryFieldInt("cols"),
        tryFieldInt("flags"),
    ]);

    const rows = rowsR.value;
    const cols = colsR.value;

    if (isNaN(rows) || isNaN(cols) || rows <= 0 || cols <= 0) {
        logger.warn(`[getGpuMatInfo] invalid dims for "${varName}": rows="${rowsR.raw}" cols="${colsR.raw}" flags="${flagsR.raw}"`);
        return null;
    }

    const flags = flagsR.value;
    const matType = flags & 0xfff;
    const depth = matType & 7;
    const channels = ((matType >> 3) & 63) + 1;

    // CodeLLDB DAP context "watch" + "/nat " prefix invokes the native
    // (Clang-based) evaluator which supports malloc()/cudaMemcpy2D() etc.
    // Source: codelldb/src/expressions/mod.rs get_expression_type().
    const dlFrame = frameId ?? undefined;
    const elemSize = getBytesPerElement(depth);
    const totalBytes = rows * cols * channels * elemSize;

    const evalNative = async (expr: string): Promise<{ result?: string; memoryReference?: string } | null> => {
        try {
            return await session.customRequest("evaluate", {
                expression: `/nat ${expr}`,
                frameId: dlFrame,
                context: "watch",
            }) ?? null;
        } catch {
            return null;
        }
    };

    const parsePtr = (result?: string | null, memRef?: string): string => {
        if (memRef && isValidMemoryReference(memRef)) {
            return memRef;
        }
        if (!result) {
            return "";
        }
        const hexMatch = result.match(/0x[0-9a-fA-F]+/);
        if (hexMatch && isValidMemoryReference(hexMatch[0])) {
            return hexMatch[0];
        }
        const decMatch = result.match(/=\s*(-?\d+)/) ?? result.match(/^\s*(-?\d+)/);
        const dec = decMatch ? parseInt(decMatch[1]) : NaN;
        if (!isNaN(dec) && dec > 0) {
            return "0x" + dec.toString(16);
        }
        return "";
    };

    const mallocResp = await evalNative(`(long long)malloc(${totalBytes})`);
    const bufPtr = parsePtr(mallocResp?.result, mallocResp?.memoryReference);
    if (!bufPtr || !isValidMemoryReference(bufPtr)) {
        logger.warn(`[getGpuMatInfo] malloc failed for "${varName}" (totalBytes=${totalBytes})`);
        return null;
    }

    // Preferred: cudaMemcpy2D direct device→host copy.
    // GpuMat.download() fails because LLDB's Clang can't disambiguate
    // cv::Mat(int,int,int,void*) against the (int,int,int,Scalar&) overload.
    //
    // Pointer reads must NOT use /nat through shared_ptr — the native evaluator
    // can't invoke shared_ptr::operator*() and returns wrapper-internal bytes.
    // The simple evaluator's synthetic formatter resolves `(*sp_gpu).data`
    // correctly but pretty-prints `unsigned char *` as a string (the `result`
    // field becomes "" when the GPU memory isn't readable as text). The DAP
    // `memoryReference` field on the same response carries the raw address.
    const evalSimple = async (expr: string) => {
        try {
            return await session.customRequest("evaluate", {
                expression: expr,
                frameId: dlFrame,
                context: "watch",
            }) ?? null;
        } catch {
            return null;
        }
    };

    const tryFieldResp = async (field: string) => evalSimple(fieldExpr(field));

    const [srcResp, stepResp] = await Promise.all([
        tryFieldResp("data"),
        tryFieldResp("step"),
    ]);
    const srcPtr = parsePtr(srcResp?.result, srcResp?.memoryReference);
    const stepDec = parseInt(stepResp?.result?.match(/=\s*(-?\d+)/)?.[1] ?? stepResp?.result ?? "0");

    if (srcPtr && isValidMemoryReference(srcPtr) && stepDec > 0) {
        const widthBytes = cols * channels * elemSize;
        const kindD2H = 2; // cudaMemcpyDeviceToHost
        const cpyResp = await evalNative(
            `(int)cudaMemcpy2D((void*)${bufPtr}, ${widthBytes}, (void*)${srcPtr}, ${stepDec}, ${widthBytes}, ${rows}, ${kindD2H})`
        );
        const retVal = parseInt(cpyResp?.result?.match(/=\s*(-?\d+)/)?.[1] ?? cpyResp?.result ?? "-1");
        if (retVal === 0) {
            return { rows, cols, channels, depth, dataPtr: bufPtr };
        }
        logger.warn(
            `[getGpuMatInfo] cudaMemcpy2D failed for "${varName}" (ret=${retVal}) ` +
            `srcPtr=${srcPtr} step=${stepDec} widthBytes=${widthBytes} rows=${rows}`
        );
    } else {
        logger.warn(
            `[getGpuMatInfo] could not resolve GPU pointer/step for "${varName}": ` +
            `srcPtr="${srcPtr}" step=${stepDec} ` +
            `srcResp=${JSON.stringify(srcResp)} stepResp=${JSON.stringify(stepResp)}`
        );
    }

    return null;
}
