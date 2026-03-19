/**
 * opencv/imageProvider.ts — ImageData extraction for OpenCV Python types.
 *
 * Handles:
 *   cv2.UMat              — CPU transparent API matrix; convert via .get()
 *   cv2.cuda.GpuMat       — GPU matrix; convert via .download()
 *   cv2.Mat               — legacy alias (already numpy.ndarray at runtime,
 *                           but retained here for explicit canHandle coverage)
 *
 * Note: regular cv2.imread() / cv2.VideoCapture.read() results are plain
 * numpy.ndarray and are handled by NumpyImageProvider.  This provider covers
 * the cases where the debugger reports a non-ndarray cv2 type string.
 *
 * Channel order: cv2 uses BGR.  The frontend image-viewer exposes a
 * "Swap R/B" toggle so the user can flip to RGB without any server-side cost.
 *
 * Transfer strategy:
 *   Compress (remote env / above threshold):
 *     Python-side: encode ndarray to PNG (float→uint8 normalised first),
 *     send PNG bytes via TCP socket.  Returns encoding:"png".
 *   No-compress (local env / below threshold):
 *     Existing path: fetchArrayData (small→JSON, large→TCP raw bytes).
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../../IDebugAdapter";
import { ImageData, ImageFormat } from "../../../../../viewers/viewerTypes";
import { ILibImageProvider } from "../../../../ILibProviders";
import { evaluateExpression, fetchArrayData } from "../../debugger";
import { resolveHWC, computeMinMax, bufferToBase64 } from "../utils";
import { logger } from "../../../../../log/logger";
import { receiveBytesViaTcp } from "../../../../../utils/tcpTransfer";
import { shouldCompress } from "../../../../../utils/compressionUtils";

// ── canHandle patterns ─────────────────────────────────────────────────────

const CV2_IMAGE_RE = /cv2\.(UMat|cuda\.GpuMat|Mat\b)/i;

export class OpenCvImageProvider implements ILibImageProvider {
    canHandle(typeName: string): boolean {
        return CV2_IMAGE_RE.test(typeName);
    }

    async fetchImageData(
        session: vscode.DebugSession,
        varName: string,
        info: VariableInfo
    ): Promise<ImageData | null> {
        const typeName = info.typeName ?? "";

        // ── Normalise to ndarray in the debug session ─────────────────────────
        // For UMat / GpuMat we create a temporary expression that yields an ndarray.
        let ndarrayExpr: string;
        if (/cuda\.GpuMat/i.test(typeName)) {
            ndarrayExpr = `(${varName}).download()`;
        } else if (/UMat/i.test(typeName)) {
            ndarrayExpr = `(${varName}).get()`;
        } else {
            // cv2.Mat at runtime is already ndarray
            ndarrayExpr = varName;
        }

        // ── Fetch shape / dtype of the normalised array ───────────────────────
        let shape: number[];
        let dtype: string;

        if (ndarrayExpr === varName && info.shape && info.dtype) {
            // Already have metadata from Layer-2 detection
            shape = info.shape;
            dtype = info.dtype;
        } else {
            // UMat/GpuMat: evaluate the conversion expression to get metadata
            const metaJson = await evaluateExpression(
                session,
                `__import__('json').dumps({'shape': list((${ndarrayExpr}).shape), 'dtype': str((${ndarrayExpr}).dtype)})`,
                info.frameId
            );
            if (!metaJson) {
                return null;
            }
            try {
                const jsonStr = metaJson.startsWith("'") ? metaJson.slice(1, -1) : metaJson;
                const meta = JSON.parse(jsonStr) as { shape: number[]; dtype: string };
                shape = meta.shape;
                dtype = meta.dtype;
            } catch (e) {
                logger.debug(`[OpenCV/Image] JSON parse failed for "${varName}": ${e}`);
                return null;
            }
        }

        if (!shape || shape.length < 2) {
            return null;
        }

        const [height, width, channels] = resolveHWC(shape);
        // cv2 always stores in BGR order
        const format: ImageFormat = channels === 1 ? "GRAY" : channels === 4 ? "BGRA" : "BGR";

        // ── Bytes per element for raw-size estimate ───────────────────────────
        const bytesPerElem = dtype.includes("64") ? 8 : dtype.includes("32") ? 4 : dtype.includes("16") ? 2 : 1;
        const rawByteCount = height * width * channels * bytesPerElem;

        // ── PNG path (remote / above threshold) ───────────────────────────────
        if (shouldCompress(rawByteCount)) {
            // For float dtypes, normalise to uint8 first so cv2.imencode can
            // produce a valid PNG.  uint8 data is encoded directly.
            const encodeExpr = dtype === "uint8"
                ? `__import__('cv2').imencode('.png', ${ndarrayExpr})[1]`
                : `__import__('cv2').imencode('.png',` +
                  ` __import__('cv2').normalize(${ndarrayExpr}, None, 0, 255,` +
                  ` __import__('cv2').NORM_MINMAX, __import__('cv2').CV_8U))[1]`;

            // Compute original dataMin/dataMax before quantising float data so
            // the info label can still show the real value range.
            let dataMin = 0;
            let dataMax = 255;
            if (dtype !== "uint8") {
                const statsJson = await evaluateExpression(
                    session,
                    `__import__('json').dumps({'mn': float((${ndarrayExpr}).min()), 'mx': float((${ndarrayExpr}).max())})`,
                    info.frameId
                );
                if (statsJson) {
                    try {
                        const js = statsJson.startsWith("'") ? statsJson.slice(1, -1) : statsJson;
                        const s = JSON.parse(js) as { mn: number; mx: number };
                        dataMin = s.mn;
                        dataMax = s.mx;
                    } catch { /* ignore, keep defaults */ }
                }
            }

            const pngBuffer = await receiveBytesViaTcp(async (port) => {
                const sendExpr =
                    `(lambda __port:` +
                    ` (lambda __png:` +
                    ` (lambda __s: (__s.connect(('127.0.0.1', __port)),` +
                    ` __s.sendall(__png.tobytes()),` +
                    ` __s.close()))` +
                    `(__import__('socket').socket()))` +
                    `(${encodeExpr}))` +
                    `(${port})`;
                return evaluateExpression(session, sendExpr, info.frameId);
            });

            if (pngBuffer) {
                return {
                    b64Bytes: bufferToBase64(pngBuffer),
                    width,
                    height,
                    channels,
                    dtype: "uint8",
                    isUint8: true,
                    dataMin,
                    dataMax,
                    varName,
                    format,
                    encoding: "png",
                };
            }
            // Fall through to raw path if TCP transfer failed.
        }

        // ── Raw bytes path (local / small image / TCP fallback) ───────────────
        // Pass ndarrayExpr as varName so fetchArrayData's buildToBytesExpr wraps
        // the conversion expression (e.g. `(v).get()`) with ascontiguousarray().
        const infoForFetch: VariableInfo = {
            ...info,
            shape,
            dtype,
            typeName: "numpy.ndarray", // treat as plain ndarray for the fetch path
        };
        const raw = await fetchArrayData(session, ndarrayExpr, infoForFetch);
        if (!raw) {
            return null;
        }

        const { dataMin: rawMin, dataMax: rawMax } = computeMinMax(raw.buffer, dtype);

        return {
            b64Bytes: bufferToBase64(raw.buffer),
            width,
            height,
            channels,
            dtype,
            isUint8: dtype === "uint8",
            dataMin: rawMin,
            dataMax: rawMax,
            varName,
            format,
        };
    }
}

