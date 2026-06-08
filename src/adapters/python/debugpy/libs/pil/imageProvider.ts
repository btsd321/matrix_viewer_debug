/**
 * pil/imageProvider.ts — ImageData extraction from PIL.Image.
 *
 * Handles: PIL.Image.Image (any mode: L, RGB, RGBA, P, CMYK, …)
 *
 * Transfer strategy:
 *   Large image (raw bytes > DAP 32K char limit):
 *     Python-side: save image to BytesIO as PNG, send bytes via TCP socket.
 *     Returns ImageData with encoding:"png" — bypasses the DAP 32K string
 *     limit that silently truncates large base64 strings.
 *   Small image (local env / below threshold):
 *     Evaluate base64(np.array(img).tobytes()) via DAP.
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../../IDebugAdapter";
import { ImageData, ImageFormat } from "../../../../../viewers/viewerTypes";
import { ILibImageProvider } from "../../../../ILibProviders";
import { evaluateExpression } from "../../debugger";
import { receiveBytesViaTcp } from "../../../../../utils/tcpTransfer";
import { bufferToBase64 } from "../utils";
import { shouldCompress } from "../../../../../utils/compressionUtils";
import { logger } from "../../../../../log/logger";

// debugpy truncates evaluate() results at roughly 32K characters.
// base64 encoding inflates raw bytes by ~4/3×, so 24KB raw → ~32KB base64.
// Images larger than this MUST use the TCP path to avoid silent truncation.
const DAP_SAFE_RAW_BYTES = 24 * 1024; // 24 KB

export class PilImageProvider implements ILibImageProvider {
    canHandle(typeName: string): boolean {
        return /PIL\.|pillow/i.test(typeName);
    }

    async fetchImageData(
        session: vscode.DebugSession,
        varName: string,
        info: VariableInfo
    ): Promise<ImageData | null> {
        // ── Step 1: Resolve metadata ───────────────────────────────────────────
        const metaExpr =
            `__import__('json').dumps({` +
            `'mode': ${varName}.mode,` +
            `'width': ${varName}.width,` +
            `'height': ${varName}.height` +
            `})`;

        const metaRaw = await evaluateExpression(session, metaExpr, info.frameId);
        if (!metaRaw) {
            logger.warn(`[PIL] "${varName}" metadata eval returned null`);
            return null;
        }

        let meta: { mode: string; width: number; height: number };
        try {
            meta = JSON.parse(metaRaw.replace(/^'|'$/g, "")) as {
                mode: string;
                width: number;
                height: number;
            };
        } catch {
            logger.warn(`[PIL] "${varName}" failed to parse metadata: ${metaRaw}`);
            return null;
        }

        const channels = pilModeToChannels(meta.mode);
        const rawByteCount = meta.width * meta.height * channels;
        const exceedsDapLimit = rawByteCount > DAP_SAFE_RAW_BYTES;
        logger.info(
            `[PIL] "${varName}" mode=${meta.mode} ${meta.width}×${meta.height} ` +
            `channels=${channels} rawBytes=${rawByteCount} ` +
            `exceedsDapLimit=${exceedsDapLimit} shouldCompress=${shouldCompress(rawByteCount)}`
        );

        // ── PNG/TCP path (large image / remote / above compression threshold) ──
        // Large images MUST use TCP because DAP evaluate truncates strings at
        // ~32K chars, which would silently corrupt base64-encoded pixel data.
        if (exceedsDapLimit || shouldCompress(rawByteCount)) {
            logger.info(`[PIL] "${varName}" → PNG/TCP path`);
            const pngBuffer = await receiveBytesViaTcp(async (port) => {
                const sendExpr =
                    `(lambda __port:` +
                    ` (lambda __buf: [` +
                    `${varName}.save(__buf, format='PNG'),` +
                    ` (lambda __s: (` +
                    `__s.connect(('127.0.0.1', __port)),` +
                    ` __s.sendall(__buf.getvalue()),` +
                    ` __s.close()))` +
                    `(__import__('socket').socket())])` +
                    `(__import__('io').BytesIO()))` +
                    `(${port})`;
                return evaluateExpression(session, sendExpr, info.frameId);
            });

            if (pngBuffer) {
                logger.info(`[PIL] "${varName}" PNG/TCP received ${pngBuffer.length} bytes`);
                return {
                    b64Bytes: bufferToBase64(pngBuffer),
                    width: meta.width,
                    height: meta.height,
                    channels,
                    dtype: "uint8",
                    isUint8: true,
                    dataMin: 0,
                    dataMax: 255,
                    varName,
                    format: pilModeToFormat(meta.mode),
                    encoding: "png",
                };
            }
            logger.warn(`[PIL] "${varName}" PNG/TCP failed, falling back to DAP path`);
            // Fall through only if image is small enough for DAP.
            if (exceedsDapLimit) {
                logger.warn(`[PIL] "${varName}" image too large for DAP fallback, giving up`);
                return null;
            }
        }

        // ── Base64/DAP path (small image / local env) ──────────────────────────
        logger.info(`[PIL] "${varName}" → base64/DAP path`);
        const b64Expr =
            `__import__('base64').b64encode(` +
            `__import__('numpy').array(${varName}).tobytes()` +
            `).decode('ascii')`;

        const b64Raw = await evaluateExpression(session, b64Expr, info.frameId);
        if (!b64Raw) {
            logger.warn(`[PIL] "${varName}" base64 eval returned null`);
            return null;
        }

        const b64 = b64Raw.replace(/^'|'$/g, "");
        logger.info(`[PIL] "${varName}" base64/DAP received ${b64.length} chars (raw=${rawByteCount})`);
        if (b64.length < rawByteCount * 1.3) {
            logger.warn(
                `[PIL] "${varName}" base64 string appears truncated: ` +
                `${b64.length} chars < expected ~${Math.floor(rawByteCount * 1.33)} chars`
            );
        }

        return {
            b64Bytes: b64,
            width: meta.width,
            height: meta.height,
            channels,
            dtype: "uint8",
            isUint8: true,
            dataMin: 0,
            dataMax: 255,
            varName,
            format: pilModeToFormat(meta.mode),
        };
    }
}

function pilModeToChannels(mode: string): number {
    if (mode === "L" || mode === "P") { return 1; }
    if (mode === "RGB") { return 3; }
    if (mode === "RGBA" || mode === "CMYK") { return 4; }
    return 3;
}

function pilModeToFormat(mode: string): ImageFormat {
    if (mode === "L" || mode === "P") { return "GRAY"; }
    if (mode === "RGBA") { return "RGBA"; }
    return "RGB";
}
