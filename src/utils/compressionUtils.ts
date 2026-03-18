/**
 * compressionUtils.ts — Image compression helpers for remote-transfer acceleration.
 *
 * Exposes three functions:
 *   isRemote()        — true when VS Code is running in a remote environment
 *                       (Remote SSH, WSL, Dev Container, etc.)
 *   shouldCompress()  — reads user config (mode + thresholdMB) and returns
 *                       whether the given number of raw bytes should be compressed
 *   deflateImageData() — zlib-deflate an ImageData whose encoding is "raw",
 *                        returning a new ImageData with encoding:"deflate"
 *
 * Only image data is compressed.  Plot and PointCloud data are never touched.
 */

import * as zlib from "zlib";
import * as vscode from "vscode";
import { ImageData } from "../viewers/viewerTypes";

// ── Environment detection ──────────────────────────────────────────────────

/**
 * Returns true when the extension host is running inside a remote environment
 * (Remote SSH, WSL, Dev Container, GitHub Codespaces, …).
 *
 * Uses `vscode.env.remoteName` which is `undefined` for local sessions and
 * set to e.g. "ssh-remote", "wsl", "dev-container" for remote ones.
 */
export function isRemote(): boolean {
    return vscode.env.remoteName !== undefined;
}

// ── Compression policy ────────────────────────────────────────────────────

/**
 * Decide whether to compress an image whose raw pixel data is `rawByteCount` bytes.
 *
 * Reads two settings:
 *   matrixViewer.compression.mode        — "auto" | "always" | "never"
 *   matrixViewer.compression.thresholdMB — number (default 1)
 */
export function shouldCompress(rawByteCount: number): boolean {
    const cfg = vscode.workspace.getConfiguration("matrixViewer");
    const mode = cfg.get<string>("compression.mode", "auto");
    const thresholdMB = cfg.get<number>("compression.thresholdMB", 1);

    if (mode === "never") { return false; }
    if (mode === "always") { return rawByteCount >= thresholdMB * 1024 * 1024; }
    // "auto": compress only in remote environments
    return isRemote() && rawByteCount >= thresholdMB * 1024 * 1024;
}

// ── Layer 2: Node.js zlib deflate ─────────────────────────────────────────

/**
 * Attempt to zlib-deflate the pixel bytes in an ImageData.
 *
 * Returns a new ImageData with:
 *   encoding: "deflate"
 *   b64Bytes: base64-encoded zlib-compressed pixel bytes
 *
 * No-ops (returns the original object unchanged) when:
 *   - data.encoding is already "png"  (Layer 1 already compressed)
 *   - data.encoding is "deflate"      (already compressed)
 *   - shouldCompress() returns false  (local env or below threshold)
 *
 * The raw byte count is estimated from b64Bytes.length * 0.75 so no
 * decoding is needed just to decide whether to compress.
 */
export function deflateImageData(data: ImageData): ImageData {
    // Already compressed by an earlier layer — nothing to do.
    if (data.encoding === "png" || data.encoding === "deflate") {
        return data;
    }

    // Estimate raw pixel size from the base64 string (3 bytes per 4 chars).
    const estimatedRawBytes = Math.floor(data.b64Bytes.length * 0.75);
    if (!shouldCompress(estimatedRawBytes)) {
        return data;
    }

    try {
        // Decode base64 → raw buffer → deflate → re-encode base64.
        const rawBuf = Buffer.from(data.b64Bytes, "base64");
        const compressed = zlib.deflateSync(rawBuf, { level: 6 });
        const b64Compressed = compressed.toString("base64");

        return { ...data, b64Bytes: b64Compressed, encoding: "deflate" };
    } catch {
        // Compression failed (unexpected) — fall back to uncompressed data.
        return data;
    }
}
