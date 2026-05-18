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
    getLoadedModules,
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
    /** Hex address of an inferior-side `cv::Mat*` heap-allocated via `new`
     *  (GpuMat path). Caller must `delete` it after readMemory. */
    allocatedMat?: string;
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

// Per-session cache for module discovery results. Avoids re-scanning all
// loaded modules on every visualization after the first successful call.
// Invalidated automatically when a cached module stops working.
const gpuMatCache = {
    allocModule: null as string | null,
    cudaCopyModule: null as string | null,
};

export async function getGpuMatInfo(
    session: vscode.DebugSession,
    varName: string,
    frameId?: number,
    nullGuardExpression?: string
): Promise<MatInfo | null> {
    logger.info(`[getGpuMatInfo] varName="${varName}" frameId=${frameId}`);

    if (nullGuardExpression) {
        const guardRes = await evaluateExpression(session, nullGuardExpression, frameId);
        if (guardRes !== null && /^\s*(true|1)\b/i.test(guardRes)) {
            logger.warn(`[getGpuMatInfo] null guard triggered; bailing out`);
            return null;
        }
    }

    const [rowsRes, colsRes, flagsRes] = await Promise.all([
        evaluateExpression(session, `${varName}.rows`, frameId),
        evaluateExpression(session, `${varName}.cols`, frameId),
        evaluateExpression(session, `${varName}.flags`, frameId),
    ]);

    const rows = parseInt(rowsRes ?? "0");
    const cols = parseInt(colsRes ?? "0");
    if (isNaN(rows) || isNaN(cols) || rows <= 0 || cols <= 0) {
        logger.warn(`[getGpuMatInfo] invalid dims: rows=${rows} cols=${cols}`);
        return null;
    }

    const flags = parseInt(flagsRes ?? "0");
    const matType = flags & 0xfff;
    const depth = matType & 7;
    const channels = ((matType >> 3) & 63) + 1;
    const dlFrame = frameId ?? undefined;
    const elemSize = getBytesPerElement(depth);
    const totalBytes = rows * cols * channels * elemSize;
    const stepBytes = cols * channels * elemSize;
    logger.info(`[getGpuMatInfo] ${rows}x${cols} ch=${channels} depth=${depth} totalBytes=${totalBytes}`);

    // Error pattern: any EE response matching this is treated as failure.
    const errRe = /(Operator|Cannot evaluate|cannot evaluate|may be inlined|No type information|no symbol|No matching|undefined|error C|side effects|is undefined|no instance|matches the argument|argument list|cannot be invoked|invalid argument|expression must|incomplete type|ambiguous|has no address|no address|optimi[sz]ed away|cannot find|not found)/i;

    // ── Discover modules ──────────────────────────────────────────────────
    const isOpenCvModule = (n: string) => /^opencv_/i.test(n);
    const isCudaCandidate = (n: string) => {
        const l = n.toLowerCase();
        return /cudart|cublas|cusolver|cufft|nvrtc|nvcuda|cudnn/i.test(l)
            || /\.exe$/i.test(l) || isOpenCvModule(l);
    };

    const allModules = await getLoadedModules(session);
    const opencvModules = allModules.filter(isOpenCvModule);
    const cudaModules = allModules.filter(isCudaCandidate);

    // ── Allocate host buffer via cv::fastMalloc ───────────────────────────
    let bufPtr = "";
    let allocModule = "";

    const tryAlloc = async (mod: string): Promise<boolean> => {
        const ctx = mod ? `{,,${mod}}` : "";
        const expr = `(long long)${ctx}cv::fastMalloc(${totalBytes})`;
        try {
            const resp = await session.customRequest("evaluate", {
                expression: expr, frameId: dlFrame, context: "repl",
            });
            if (resp?.result && errRe.test(resp.result)) { return false; }
            if (resp?.memoryReference && isValidMemoryReference(resp.memoryReference)) {
                bufPtr = resp.memoryReference; allocModule = mod; return true;
            }
            const hexM = resp?.result?.match(/0x[0-9a-fA-F]+/);
            if (hexM && isValidMemoryReference(hexM[0])) {
                bufPtr = hexM[0]; allocModule = mod; return true;
            }
            const dec = parseInt(resp?.result ?? "");
            if (!isNaN(dec) && dec > 0) {
                bufPtr = "0x" + dec.toString(16); allocModule = mod; return true;
            }
        } catch { /* continue */ }
        return false;
    };

    if (gpuMatCache.allocModule !== null) {
        if (!await tryAlloc(gpuMatCache.allocModule)) {
            gpuMatCache.allocModule = null;
        }
    }
    if (!bufPtr) {
        for (const mod of ["", ...opencvModules]) {
            if (await tryAlloc(mod)) {
                gpuMatCache.allocModule = mod;
                break;
            }
        }
    }

    if (!bufPtr) {
        logger.warn(`[getGpuMatInfo] cv::fastMalloc unreachable — no OpenCV PDB loaded`);
        return null;
    }
    logger.info(`[getGpuMatInfo] allocated ${totalBytes}B at ${bufPtr} via "${allocModule}"`);

    // ── Read device pointer and step ─────────────────────────────────────
    const [stepRes, dataResForCopy] = await Promise.all([
        evaluateExpression(session, `(long long)${varName}.step`, dlFrame),
        evaluateExpression(session, `(long long)${varName}.data`, dlFrame),
    ]);
    const devStep = parseInt(stepRes ?? "0");
    const devDataDec = parseInt(dataResForCopy ?? "0");
    const devPtr = !isNaN(devDataDec) && devDataDec > 0 ? "0x" + devDataDec.toString(16) : "";

    if (!devPtr) {
        logger.warn(`[getGpuMatInfo] cannot read device pointer`);
        await freeBuffer(session, allocModule, bufPtr, dlFrame, errRe);
        return null;
    }

    const widthBytes = stepBytes;
    const kindD2H = 2;

    // ── Path 1 (preferred): cudaMemcpy2D via function-pointer cast ───────
    // cudart is statically linked into opencv_core4d.dll; the EE finds the
    // symbol but lacks type info. We cast to a typed function pointer.
    const fptr2d = `(int(__cdecl*)(void*,unsigned __int64,const void*,unsigned __int64,unsigned __int64,unsigned __int64,int))`;
    const fptr1d = `(int(__cdecl*)(void*,const void*,unsigned __int64,int))`;

    const buildCudaExprs = (mod: string): string[] => {
        const ctx = mod ? `{,,${mod}}` : "";
        const exprs: string[] = [];
        if (devStep > 0) {
            if (mod) {
                exprs.push(`(${fptr2d}(${ctx}cudaMemcpy2D))((void*)${bufPtr}, (unsigned __int64)${stepBytes}, (const void*)${devPtr}, (unsigned __int64)${devStep}, (unsigned __int64)${widthBytes}, (unsigned __int64)${rows}, ${kindD2H})`);
            }
            exprs.push(`(int)${ctx}cudaMemcpy2D((void*)${bufPtr}, (unsigned __int64)${stepBytes}, (const void*)${devPtr}, (unsigned __int64)${devStep}, (unsigned __int64)${widthBytes}, (unsigned __int64)${rows}, ${kindD2H})`);
        }
        if (mod) {
            exprs.push(`(${fptr1d}(${ctx}cudaMemcpy))((void*)${bufPtr}, (const void*)${devPtr}, (unsigned __int64)${totalBytes}, ${kindD2H})`);
        }
        exprs.push(`(int)${ctx}cudaMemcpy((void*)${bufPtr}, (const void*)${devPtr}, (unsigned __int64)${totalBytes}, ${kindD2H})`);
        return exprs;
    };

    const tryCudaCopy = async (mod: string): Promise<boolean> => {
        for (const expr of buildCudaExprs(mod)) {
            const r = await evaluateExpression(session, expr, dlFrame);
            if (r === null || r === "" || errRe.test(r)) { continue; }
            if (/^\s*0\b/.test(r)) { return true; }
            logger.warn(`[getGpuMatInfo] cudaMemcpy returned non-zero: "${r}"`);
        }
        return false;
    };

    let copyOk = false;
    if (gpuMatCache.cudaCopyModule !== null) {
        copyOk = await tryCudaCopy(gpuMatCache.cudaCopyModule);
        if (!copyOk) { gpuMatCache.cudaCopyModule = null; }
    }
    if (!copyOk) {
        for (const mod of [...cudaModules, ""]) {
            if (await tryCudaCopy(mod)) {
                gpuMatCache.cudaCopyModule = mod;
                copyOk = true;
                break;
            }
        }
    }

    if (copyOk) {
        logger.info(`[getGpuMatInfo] GPU→host copy succeeded for "${varName}"`);
        return { rows, cols, channels, depth, dataPtr: bufPtr, allocatedBuffer: bufPtr };
    }

    // ── Path 2 (fallback): GpuMat::download ──────────────────────────────
    const matExpr = `cv::Mat(${rows}, ${cols}, ${matType}, (void*)${bufPtr}, (unsigned __int64)${stepBytes})`;
    const dlRes = await evaluateExpression(session, `${varName}.download(${matExpr})`, dlFrame);
    if (dlRes !== null && dlRes !== "" && !errRe.test(dlRes)) {
        logger.info(`[getGpuMatInfo] download() succeeded for "${varName}"`);
        return { rows, cols, channels, depth, dataPtr: bufPtr, allocatedBuffer: bufPtr };
    }

    // ── Path 3: readMemory on device pointer (Nsight only) ───────────────
    await freeBuffer(session, allocModule, bufPtr, dlFrame, errRe);
    try {
        const raw = await readMemoryChunked(session, devPtr, totalBytes);
        if (raw) {
            logger.info(`[getGpuMatInfo] readMemory on device pointer succeeded`);
            return { rows, cols, channels, depth, dataPtr: devPtr };
        }
    } catch { /* not available */ }

    logger.warn(`[getGpuMatInfo] all strategies failed for "${varName}"`);
    return null;
}

async function freeBuffer(
    session: vscode.DebugSession, mod: string, ptr: string,
    frameId: number | undefined, _errRe: RegExp
): Promise<void> {
    const ctx = mod ? `{,,${mod}}` : "";
    try {
        await session.customRequest("evaluate", {
            expression: `(void)${ctx}cv::fastFree((void*)${ptr})`,
            frameId, context: "repl",
        });
    } catch { /* best-effort */ }
}
