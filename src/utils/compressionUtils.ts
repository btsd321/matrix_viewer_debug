/**
 * compressionUtils.ts — Image compression helpers for remote-transfer acceleration.
 *
 * Exposes:
 *   isRemote()          — true when VS Code is running in a remote environment
 *                         (Remote SSH, WSL, Dev Container, etc.)
 *   shouldCompress()    — reads user config (mode + thresholdMB) and returns
 *                         whether the given number of raw bytes should be compressed
 *   IImageCompressor    — interface for a pluggable compression codec
 *   compressImageData() — compress an ImageData using the algorithm chosen by
 *                         matrixViewer.image.compression.algorithm config
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
 *   matrixViewer.image.compression.mode        — "auto" | "always" | "never"
 *   matrixViewer.image.compression.thresholdMB — number (default 1)
 */
export function shouldCompress(rawByteCount: number): boolean {
    const cfg = vscode.workspace.getConfiguration("matrixViewer");
    const mode = cfg.get<string>("image.compression.mode", "auto");
    const thresholdMB = cfg.get<number>("image.compression.thresholdMB", 1);

    if (mode === "never") { return false; }
    if (mode === "always") { return rawByteCount >= thresholdMB * 1024 * 1024; }
    // "auto": compress only in remote environments
    return isRemote() && rawByteCount >= thresholdMB * 1024 * 1024;
}

// ── Compressor interface & built-in implementations ───────────────────────

/**
 * Contract for a single compression codec.
 *
 * Built-in implementations:
 *   DeflateCompressor    — zlib deflate  → encoding "deflate"
 *   GzipCompressor       — gzip          → encoding "gzip"
 *   DeflateRawCompressor — raw deflate   → encoding "deflate-raw"
 *
 * All three are decompressible in the browser via
 * `new DecompressionStream(encoding)` without any third-party library.
 *
 * When algorithm is "auto", getCompressor() selects from four tiers by data size
 * (boundary = thresholdMB × factor, T = thresholdMB):
 *   Tier 1 [T,  2T) — deflate-raw level 1: minimum latency
 *   Tier 2 [2T, 4T) — deflate-raw level 3: light compression
 *   Tier 3 [4T, 8T) — deflate     level 6: balanced
 *   Tier 4 [8T,  ∞) — deflate     level 9: maximum compression ratio
 */
export interface IImageCompressor {
    /** The value written to ImageData.encoding after compression. */
    readonly encoding: "deflate" | "gzip" | "deflate-raw";
    /** Synchronously compress a raw pixel Buffer. */
    compress(raw: Buffer): Buffer;
}

class DeflateCompressor implements IImageCompressor {
    readonly encoding = "deflate" as const;
    constructor(private readonly level: number = 6) {}
    compress(raw: Buffer): Buffer { return zlib.deflateSync(raw, { level: this.level }); }
}

class GzipCompressor implements IImageCompressor {
    readonly encoding = "gzip" as const;
    constructor(private readonly level: number = 6) {}
    compress(raw: Buffer): Buffer { return zlib.gzipSync(raw, { level: this.level }); }
}

class DeflateRawCompressor implements IImageCompressor {
    readonly encoding = "deflate-raw" as const;
    constructor(private readonly level: number = 6) {}
    compress(raw: Buffer): Buffer { return zlib.deflateRawSync(raw, { level: this.level }); }
}

/** Named compressors for the explicit algorithm setting (level 6 default). */
const COMPRESSORS: Readonly<Record<string, IImageCompressor>> = {
    "deflate":     new DeflateCompressor(),
    "gzip":        new GzipCompressor(),
    "deflate-raw": new DeflateRawCompressor(),
};

/**
 * Four-tier compressor table used by the "auto" strategy.
 * Ordered highest threshold first so the first matching entry wins.
 *
 *   Tier 4 [×8, ∞):  deflate     level 9 — maximum compression ratio
 *   Tier 3 [×4, ×8): deflate     level 6 — balanced
 *   Tier 2 [×2, ×4): deflate-raw level 3 — light compression
 *   Tier 1 [×1, ×2): deflate-raw level 1 — minimum latency  (default / fallback)
 */
const AUTO_TIERS: ReadonlyArray<{ factor: number; compressor: IImageCompressor }> = [
    { factor: 8, compressor: new DeflateCompressor(9)    },
    { factor: 4, compressor: new DeflateCompressor(6)    },
    { factor: 2, compressor: new DeflateRawCompressor(3) },
    { factor: 1, compressor: new DeflateRawCompressor(1) },
];

/**
 * Returns the compressor to use for the given raw byte count.
 *
 * When algorithm is "auto", selects from AUTO_TIERS using thresholdMB as the
 * base unit T.  The first tier whose rawByteCount ≥ T × factor is used.
 *
 * Falls back to DeflateCompressor(6) for unknown algorithm values.
 */
function getCompressor(rawByteCount: number): IImageCompressor {
    const cfg = vscode.workspace.getConfiguration("matrixViewer");
    const algo = cfg.get<string>("image.compression.algorithm", "auto");

    if (algo === "auto") {
        const T = cfg.get<number>("image.compression.thresholdMB", 1) * 1024 * 1024;
        for (const { factor, compressor } of AUTO_TIERS) {
            if (rawByteCount >= T * factor) { return compressor; }
        }
        return AUTO_TIERS[AUTO_TIERS.length - 1].compressor; // tier 1 fallback
    }
    return COMPRESSORS[algo] ?? COMPRESSORS["deflate"];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Attempt to compress the pixel bytes in an ImageData using the algorithm
 * configured via `matrixViewer.image.compression.algorithm`.
 *
 * Returns a new ImageData with encoding set to the selected algorithm's tag.
 *
 * No-ops (returns the original object unchanged) when:
 *   - data.encoding is already "png"        (Layer 1 already compressed)
 *   - data.encoding is a compressed type    (already compressed)
 *   - shouldCompress() returns false        (local env or below threshold)
 *
 * The raw byte count is estimated from b64Bytes.length * 0.75 so no
 * decoding is needed just to decide whether to compress.
 */
export function compressImageData(data: ImageData): ImageData {
    // Already compressed by an earlier layer — nothing to do.
    if (data.encoding === "png"
        || data.encoding === "deflate"
        || data.encoding === "gzip"
        || data.encoding === "deflate-raw") {
        return data;
    }

    // Estimate raw pixel size from the base64 string (3 bytes per 4 chars).
    const estimatedRawBytes = Math.floor(data.b64Bytes.length * 0.75);
    if (!shouldCompress(estimatedRawBytes)) {
        return data;
    }

    const compressor = getCompressor(estimatedRawBytes);
    try {
        const rawBuf = Buffer.from(data.b64Bytes, "base64");
        const compressed = compressor.compress(rawBuf);
        return { ...data, b64Bytes: compressed.toString("base64"), encoding: compressor.encoding };
    } catch {
        // Compression failed (unexpected) — fall back to uncompressed data.
        return data;
    }
}
