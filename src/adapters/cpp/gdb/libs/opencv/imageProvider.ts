/**
 * opencv/imageProvider.ts — ImageData extraction from cv::Mat (C++ / cppdbg).
 *
 * Supported types:
 *   cv::Mat, cv::Mat_<T>, cv::UMat  — any depth (CV_8U … CV_64F), 1–4 channels
 *
 * Data-fetch strategy:
 *   1. LLDB / variablesReference available → walk children via getMatInfoFromVariables
 *   2. cppdbg / cppvsdbg fallback → evaluate .rows/.cols/.flags/.data expressions
 *   3. Read raw pixel bytes via DAP readMemory (chunked, auto-sized)
 *
 * References:
 *   - cv::Mat layout: https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html
 *   - cv_debug_mate_cpp matProvider.ts
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../../IDebugAdapter";
import { ImageData, ImageFormat } from "../../../../../viewers/viewerTypes";
import { ILibImageProvider } from "../../../../ILibProviders";
import {
    readMemoryChunked,
} from "../../debugger";
import { getBytesPerElement, cvDepthToDtype } from "./matUtils";
import { bufferToBase64, computeMinMax } from "../utils";
import { getMatInfoFromVariables, getMatInfoFromEvaluate, getGpuMatInfo } from "./matUtils";
import { logger } from "../../../../../log/logger";

export class OpenCvImageProvider implements ILibImageProvider {
    canHandle(typeName: string): boolean {
        // cv::Mat, cv::Mat_<T>, cv::UMat, cv::cuda::GpuMat
        return /cv::(Mat[^x]|Mat$|UMat|cuda::GpuMat)/i.test(typeName) || /cv::Mat_/.test(typeName);
    }

    async fetchImageData(
        session: vscode.DebugSession,
        varName: string,
        info: VariableInfo
    ): Promise<ImageData | null> {
        // ── Step 1: Resolve metadata ───────────────────────────────────────────
        let matInfo = null;
        const isGpuMat = /\bcv::cuda::GpuMat\b/i.test(info.type);

        if (isGpuMat) {
            // GpuMat: GPU memory not accessible via DAP readMemory; download to host.
            // Pass nullGuardExpression so getGpuMatInfo can short-circuit when the
            // wrapping smart/raw pointer is null (otherwise calling .rows/.cols/.type()
            // on a *T at this=0x0 segfaults the inferior).
            matInfo = await getGpuMatInfo(session, varName, info.frameId, info.nullGuardExpression);
        } else {
            // For LLDB (and any debugger with variablesReference), walk children
            if (info.variablesReference && info.variablesReference > 0) {
                matInfo = await getMatInfoFromVariables(session, info.variablesReference);
            }

            // Fallback: evaluate expression-based member access
            if (!matInfo) {
                matInfo = await getMatInfoFromEvaluate(session, varName, info.frameId);
            }
        }

        if (!matInfo) {
            return null;
        }

        const { rows, cols, channels, depth, dataPtr } = matInfo;
        if (rows <= 0 || cols <= 0) {
            return null;
        }

        // ── Step 2: Read pixel bytes via readMemory ───────────────────────────
        const bytesPerElement = getBytesPerElement(depth);
        const totalBytes = rows * cols * channels * bytesPerElement;

        const buffer = await readMemoryChunked(session, dataPtr, totalBytes);
        if (!buffer) {
            logger.warn(`[OpenCvImageProvider] readMemory returned null for varName="${varName}" dataPtr=${dataPtr} totalBytes=${totalBytes}`);
            return null;
        }

        if (isGpuMat) {
            const preview = Array.from(buffer.slice(0, Math.min(16, buffer.length)));
            let nonZero = 0;
            for (let i = 0; i < buffer.length; i++) { if (buffer[i] !== 0) { nonZero++; } }
            logger.info(`[OpenCvImageProvider] GpuMat "${varName}" buffer bytes=${buffer.length} nonZero=${nonZero} firstBytes=[${preview.join(",")}]`);
        }

        const dtype = cvDepthToDtype(depth);
        const { dataMin, dataMax } = computeMinMax(buffer, dtype);

        return {
            b64Bytes: bufferToBase64(buffer),
            width: cols,
            height: rows,
            channels,
            dtype,
            isUint8: depth === 0, // CV_8U
            dataMin,
            dataMax,
            varName,
            // cv::Mat uses BGR channel order by convention
            format: (channels === 1 ? "GRAY" : channels === 4 ? "BGRA" : "BGR") as ImageFormat,
        };
    }
}
