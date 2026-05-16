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
    readMemoryChunked,
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
    /** Hex address of an inferior-side host buffer the provider malloc'd
     *  (GpuMat path). Caller must `free()` it after readMemory. */
    allocatedBuffer?: string;
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
    logger.info(`[getGpuMatInfo] >>> varName="${varName}" frameId=${frameId}`);

    // Read GpuMat metadata via member fields (NOT method calls).  vsdbg cannot
    // call methods that lack debug info (inlined / cross-module); member access
    // via the debug-info-provided layout is reliable.
    const [rowsRes, colsRes, flagsRes, dataRes, stepRes] = await Promise.all([
        evaluateExpression(session, `${varName}.rows`, frameId),
        evaluateExpression(session, `${varName}.cols`, frameId),
        evaluateExpression(session, `${varName}.flags`, frameId),
        evaluateExpression(session, `${varName}.data`, frameId),
        evaluateExpression(session, `${varName}.step`, frameId),
    ]);
    logger.info(`[getGpuMatInfo] raw evals rows="${rowsRes}" cols="${colsRes}" flags="${flagsRes}" data="${dataRes}" step="${stepRes}"`);

    const rows = parseInt(rowsRes ?? "0");
    const cols = parseInt(colsRes ?? "0");

    if (isNaN(rows) || isNaN(cols) || rows <= 0 || cols <= 0) {
        logger.warn(`[getGpuMatInfo] invalid dims: rows=${rows} cols=${cols}`);
        return null;
    }

    // GpuMat::type() is `flags & 0xFFF` — same encoding as cv::Mat.
    const flags = parseInt(flagsRes ?? "0");
    const matType = flags & 0xfff;
    const depth = matType & 7;
    const channels = ((matType >> 3) & 63) + 1;
    logger.info(`[getGpuMatInfo] decoded rows=${rows} cols=${cols} flags=${flags} matType=${matType} depth=${depth} channels=${channels}`);

    // Resolve device pointer and step from member values.
    const dataDec = parseInt(dataRes ?? "0");
    const stepDec = parseInt(stepRes ?? "0");
    if (isNaN(dataDec) || dataDec <= 0 || isNaN(stepDec) || stepDec <= 0) {
        logger.warn(`[getGpuMatInfo] invalid device ptr or step: data=${dataDec} step=${stepDec}`);
        return null;
    }
    const devPtr = "0x" + dataDec.toString(16);
    logger.info(`[getGpuMatInfo] devPtr="${devPtr}" step=${stepDec}`);

    // Download GPU → host without calling functions from system DLLs.
    //
    // vsdbg cannot resolve type signatures for functions in modules that lack
    // debug info (ucrtbase.dll, kernel32.dll, cudart, etc.).  Even function-
    // pointer casts don't help — the EE must resolve the symbol before the
    // cast applies.  `new`/`delete` are also unsupported per MS docs.
    //
    // Strategies we try, in order:
    //   A) Use the GpuMat's own stack address as a scratch buffer.  The space
    //      well below the variable on the stack is unused while execution is
    //      paused; we compute `&varName - totalBytes - 4096` and download
    //      directly into that region.  No allocation call needed.
    //   B) Try allocation through OpenCV's own exported allocators
    //      (cv::fastMalloc / cvAlloc).  These live in the OpenCV DLL, which
    //      vcpkg debug builds may ship with PDB symbols.
    const dlFrame = frameId ?? undefined;
    const elemSize = getBytesPerElement(depth);
    const totalBytes = rows * cols * channels * elemSize;

    // ── Strategy A: stack scratch via &varName ────────────────────────────
    let bufPtr = "";
    try {
        const addrRes = await session.customRequest("evaluate", {
            expression: `(long long)&${varName}`,
            frameId: dlFrame,
            context: "repl",
        });
        logger.info(`[getGpuMatInfo] &"${varName}" result="${addrRes?.result}"`);
        const varAddr = parseInt(addrRes?.result ?? "");
        if (!isNaN(varAddr) && varAddr > 0x1000) {
            // Place the scratch buffer 4096 bytes below the variable.
            // This avoids other locals while staying within the stack.
            const bufAddr = varAddr - totalBytes - 4096;
            if (bufAddr > 0x1000) {
                bufPtr = "0x" + bufAddr.toString(16);
                logger.info(`[getGpuMatInfo] strategy A stack buf: varAddr=0x${varAddr.toString(16)} bufPtr="${bufPtr}"`);
            }
        }
    } catch (e) {
        logger.warn(`[getGpuMatInfo] &"${varName}" threw: ${e}`);
    }

    // ── Strategy B: OpenCV allocators ─────────────────────────────────────
    if (!bufPtr) {
        const ocvAllocExprs = [
            `(long long)cv::fastMalloc(${totalBytes})`,
            `(long long)cvAlloc(${totalBytes})`,
            `(void*)cv::fastMalloc(${totalBytes})`,
            `(void*)cvAlloc(${totalBytes})`,
        ];
        for (const expr of ocvAllocExprs) {
            try {
                const mr = await session.customRequest("evaluate", {
                    expression: expr,
                    frameId: dlFrame,
                    context: "repl",
                });
                logger.info(`[getGpuMatInfo] ocvAlloc expr="${expr}" result="${mr?.result}" memRef="${mr?.memoryReference}"`);
                if (mr?.memoryReference && isValidMemoryReference(mr.memoryReference)) {
                    bufPtr = mr.memoryReference;
                    logger.info(`[getGpuMatInfo] ocvAlloc success via memoryReference: "${bufPtr}"`);
                    break;
                }
                const hexMatch = (mr?.result ?? "").match(/0x[0-9a-fA-F]+/);
                if (hexMatch && isValidMemoryReference(hexMatch[0])) {
                    bufPtr = hexMatch[0];
                    logger.info(`[getGpuMatInfo] ocvAlloc success via hex: "${bufPtr}"`);
                    break;
                }
                const dec = parseInt(mr?.result ?? "");
                if (!isNaN(dec) && dec > 0) {
                    const hex = "0x" + dec.toString(16);
                    if (isValidMemoryReference(hex)) {
                        bufPtr = hex;
                        logger.info(`[getGpuMatInfo] ocvAlloc success via decimal: "${bufPtr}"`);
                        break;
                    }
                }
            } catch (e) {
                logger.warn(`[getGpuMatInfo] ocvAlloc threw for "${expr}": ${e}`);
            }
        }
    }

    // ── Strategy C: CRT allocators (may work if user linked debug CRT) ────
    if (!bufPtr) {
        const crtAllocExprs = [
            `(long long)malloc(${totalBytes})`,
            `(long long){,,ucrtbased.dll}malloc(${totalBytes})`,
            `(void*)malloc(${totalBytes})`,
        ];
        for (const expr of crtAllocExprs) {
            try {
                const mr = await session.customRequest("evaluate", {
                    expression: expr,
                    frameId: dlFrame,
                    context: "repl",
                });
                logger.info(`[getGpuMatInfo] CRT alloc expr="${expr}" result="${mr?.result}" memRef="${mr?.memoryReference}"`);
                if (mr?.memoryReference && isValidMemoryReference(mr.memoryReference)) {
                    bufPtr = mr.memoryReference;
                    break;
                }
                const hexMatch = (mr?.result ?? "").match(/0x[0-9a-fA-F]+/);
                if (hexMatch && isValidMemoryReference(hexMatch[0])) {
                    bufPtr = hexMatch[0];
                    break;
                }
                const dec = parseInt(mr?.result ?? "");
                if (!isNaN(dec) && dec > 0) {
                    const hex = "0x" + dec.toString(16);
                    if (isValidMemoryReference(hex)) { bufPtr = hex; }
                    break;
                }
            } catch { /* continue */ }
        }
        if (bufPtr) {
            logger.info(`[getGpuMatInfo] CRT alloc success: "${bufPtr}"`);
        }
    }

    if (!bufPtr) {
        logger.warn(`[getGpuMatInfo] all allocation strategies failed for "${varName}" (totalBytes=${totalBytes})`);
        return null;
    }

    // ── Download: copy GPU → host buffer ──────────────────────────────────
    //
    // The EE cannot call C++ constructors nor find symbols from static libs
    // that lack public visibility (e.g. cudart_static).  We probe what's
    // callable and try every available path.
    const hostPitch = cols * channels * elemSize;
    const widthBytes = cols * channels * elemSize;
    const kindD2H = 2; // cudaMemcpyDeviceToHost
    const errRe = /(Cannot evaluate|No type information|error:|syntax error|no instance|no symbol|undefined)/i;

    // ── Diagnostic: probe what CUDA symbols are reachable ────────────────
    const diagExprs = [
        `(int)cudaGetLastError()`,
        `(long long)&cudaMemcpy2D`,
        `(long long)&cudaMemcpy`,
        `(int)cuInit(0)`,
        `(long long)&cuMemcpyDtoH_v2`,
    ];
    for (const expr of diagExprs) {
        const r = await evaluateExpression(session, expr, dlFrame);
        logger.info(`[getGpuMatInfo] diag "${expr}" -> "${r}"`);
    }

    // ── Strategy A: cudaMemcpy2D spellings ──────────────────────────────
    const cudaExprs = [
        `(int)cudaMemcpy2D((void*)${bufPtr}, ${hostPitch}, (void*)${devPtr}, ${stepDec}, ${widthBytes}, ${rows}, ${kindD2H})`,
        `(int){,,demo.exe}cudaMemcpy2D((void*)${bufPtr}, ${hostPitch}, (void*)${devPtr}, ${stepDec}, ${widthBytes}, ${rows}, ${kindD2H})`,
        `(int)cudaMemcpy((void*)${bufPtr}, (void*)${devPtr}, ${totalBytes}, ${kindD2H})`,
        `(int)cuMemcpyDtoH_v2(${parseInt(bufPtr)}, ${dataDec}, ${totalBytes})`,
    ];
    for (const expr of cudaExprs) {
        const r = await evaluateExpression(session, expr, dlFrame);
        logger.info(`[getGpuMatInfo] copy expr="${expr}" -> "${r}"`);
        if (r !== null && /^\s*0\b/.test(r) && !errRe.test(r)) {
            logger.info(`[getGpuMatInfo] copy succeeded via "${expr}"`);
            return { rows, cols, channels, depth, dataPtr: bufPtr, allocatedBuffer: bufPtr };
        }
    }

    // ── Strategy B: GpuMat::download with cv::Mat wrapper (fallback) ────
    const dlExpr = `${varName}.download(cv::Mat(${rows}, ${cols}, ${matType}, (void*)${bufPtr}))`;
    logger.info(`[getGpuMatInfo] strategy B download expr="${dlExpr}"`);
    const dlRes = await evaluateExpression(session, dlExpr, dlFrame);
    logger.info(`[getGpuMatInfo] strategy B download result="${dlRes}"`);
    if (dlRes !== null && !errRe.test(dlRes)) {
        return { rows, cols, channels, depth, dataPtr: bufPtr, allocatedBuffer: bufPtr };
    }

    // ── Strategy C: try readMemory directly on device pointer ───────────
    // This only works if a CUDA-aware debugger (e.g. Nsight) is active, but
    // costs almost nothing to attempt.
    try {
        const raw = await readMemoryChunked(session, devPtr, totalBytes);
        if (raw) {
            logger.info(`[getGpuMatInfo] readMemory on device pointer succeeded!`);
            return { rows, cols, channels, depth, dataPtr: devPtr };
        }
    } catch (e) {
        logger.info(`[getGpuMatInfo] readMemory on device pointer failed: ${e}`);
    }

    logger.warn(`[getGpuMatInfo] all download strategies failed for "${varName}"`);
    return null;
}
