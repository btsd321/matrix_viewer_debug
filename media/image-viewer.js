/**
 * image-viewer.js — Front-end logic for the 2D Image Viewer webview.
 *
 * Picks up bootstrap data from window.__matrixViewer.initData and renders
 * the image on a <canvas> element. Handles zoom/pan, normalisation,
 * colormap, channel reorder, hover info, and save actions.
 *
 * Listens for postMessage "update" from the extension. Viewport
 * synchronisation is delegated to media/sync-controls.js.
 *
 * @typedef {import('../src/matImage/matProvider').ImageData} ImageData
 */

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {ImageData} */
  const initData = window.__matrixViewer.initData;

  // ── State ─────────────────────────────────────────────────────────────────

  let currentData = initData;
  let zoom = 1.0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let normalize = !initData.isUint8;
  let colormap = window.__matrixViewer.defaultColormap ?? "gray";
  // Derive initial BGR-swap state from the image format reported by the extension.
  // BGR and BGRA images need R/B channels swapped before display.
  let swapBGR = (initData.format === "BGR" || initData.format === "BGRA");

  /**
   * Cached decoded pixel bytes for "raw"/"deflate" encoding.
   * Cleared when currentData changes; populated lazily on first ensureRawBytes().
   * @type {Uint8Array|null}
   */
  let currentRawBytes = null;

  /**
   * Cached ImageBitmap for "png" encoding.
   * Cleared when currentData changes; populated lazily on first ensureBitmap().
   * @type {ImageBitmap|null}
   */
  let currentBitmap = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("main-canvas"));
  const ctx = canvas.getContext("2d");
  const hoverInfo = document.getElementById("hover-info");
  const infoLabel = document.getElementById("info-label");
  const chkNormalize = /** @type {HTMLInputElement} */ (document.getElementById("chk-normalize"));
  const selColormap = /** @type {HTMLSelectElement} */ (document.getElementById("sel-colormap"));
  const chkBGR = /** @type {HTMLInputElement} */ (document.getElementById("chk-bgr2rgb"));
  const btnReset = document.getElementById("btn-reset");
  const btnSave = document.getElementById("btn-save");
  const selExport = document.getElementById("sel-export");
  const syncMount = document.getElementById("sync-controls");

  // ── View sync ─────────────────────────────────────────────────────────────

  /**
   * Viewport synchronisation controller (media/sync-controls.js).
   * Reports {zoom, panX, panY} to the extension and applies peer viewports.
   */
  const sync = window.MatrixViewerSync.create({
    vscode,
    kind: "image",
    mount: window.__matrixViewer.showSyncControls === false ? null : syncMount,
    getState: () => ({ kind: "image", zoom, panX, panY }),
    applyState: (s) => {
      zoom = s.zoom;
      panX = s.panX;
      panY = s.panY;
      renderImage(currentData).catch(console.error);
    },
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    chkNormalize.checked = normalize;
    selColormap.value = colormap;
    chkBGR.checked = swapBGR;
    fitToWindow(currentData);
    renderImage(currentData).catch(console.error);
    const fmtStr = currentData.format ? `  ${currentData.format}` : "";
    infoLabel.textContent = `${currentData.height}×${currentData.width}  ch:${currentData.channels}  ${currentData.dtype}${fmtStr}`;

    chkNormalize.addEventListener("change", () => {
      normalize = chkNormalize.checked;
      renderImage(currentData).catch(console.error);
    });
    selColormap.addEventListener("change", () => {
      colormap = selColormap.value;
      renderImage(currentData).catch(console.error);
    });
    chkBGR.addEventListener("change", () => {
      swapBGR = chkBGR.checked;
      renderImage(currentData).catch(console.error);
    });
    btnReset.addEventListener("click", resetView);
    btnSave.addEventListener("click", saveImage);

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", () => { isDragging = false; });
    canvas.addEventListener("mouseleave", () => {
      isDragging = false;
      hoverInfo.style.display = "none";
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Render the current image onto the canvas.
   *
   * Three paths depending on data.encoding:
   *   "png"                        — decompress via ImageBitmap (Python-side PNG encode)
   *   "deflate"/"gzip"/"deflate-raw" — decompress via DecompressionStream, then RGBA path
   *   "raw" / undefined            — existing direct typed-array path
   *
   * Decoded results are cached in currentRawBytes / currentBitmap so
   * repeated zoom/pan renders do not re-decompress.
   *
   * @param {Object} data — ImageData object from the extension
   * @returns {Promise<void>}
   */
  async function renderImage(data) {
    const { width, height, channels, dtype, dataMin, dataMax } = data;
    const encoding = data.encoding;

    // Size the canvas to the container so zoom/pan work in the full viewport
    const container = canvas.parentElement;
    const cw = container.clientWidth  || width;
    const ch = container.clientHeight || height;
    canvas.width  = cw;
    canvas.height = ch;

    const maxMegapixels = window.__matrixViewer.maxDisplaySize ?? 50;

    if (encoding === "png") {
      // ── PNG path ──────────────────────────────────────────────────────────
      // Pixel bytes were PNG-encoded on the Python side. Decode into an
      // ImageBitmap (hardware-accelerated) and draw directly.
      const bmp = await ensureBitmap(data);
      if (!bmp) { return; }

      let displaySrc = bmp;
      if (width * height > maxMegapixels * 1e6) {
        const scale = Math.sqrt(maxMegapixels * 1e6 / (width * height));
        const dw = Math.max(1, Math.round(width * scale));
        const dh = Math.max(1, Math.round(height * scale));
        const sampled = new OffscreenCanvas(dw, dh);
        sampled.getContext("2d").drawImage(bmp, 0, 0, dw, dh);
        displaySrc = sampled;
      }

      ctx.save();
      ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
      ctx.drawImage(displaySrc, 0, 0, width, height);
      ctx.restore();

    } else {
      // ── raw / deflate path ────────────────────────────────────────────────
      // Ensure raw pixel bytes are available (decompress if necessary),
      // then run the full typed-array → RGBA → canvas pipeline.
      const rawBytes = await ensureRawBytes(data);
      if (!rawBytes) { return; }

      const pixels = decodeToRGBA(rawBytes, width, height, channels, dtype, dataMin, dataMax);
      const imageData = new ImageData(pixels, width, height);

      const off = new OffscreenCanvas(width, height);
      off.getContext("2d").putImageData(imageData, 0, 0);

      let displaySrc = off;
      if (width * height > maxMegapixels * 1e6) {
        const scale = Math.sqrt(maxMegapixels * 1e6 / (width * height));
        const dw = Math.max(1, Math.round(width * scale));
        const dh = Math.max(1, Math.round(height * scale));
        const sampled = new OffscreenCanvas(dw, dh);
        sampled.getContext("2d").drawImage(off, 0, 0, dw, dh);
        displaySrc = sampled;
      }

      ctx.save();
      ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
      ctx.drawImage(displaySrc, 0, 0, width, height);
      ctx.restore();
    }
  }

  /**
   * Convert raw typed-array bytes to a flat RGBA Uint8ClampedArray.
   * @returns {Uint8ClampedArray}
   */
  function decodeToRGBA(rawBytes, width, height, channels, dtype, dataMin, dataMax) {
    const n = width * height;
    const out = new Uint8ClampedArray(n * 4);
    const typed = viewAsTyped(rawBytes, dtype);
    const scale = normalize ? 255 / (dataMax - dataMin || 1) : 1;

    for (let i = 0; i < n; i++) {
      let r, g, b, a = 255;
      if (channels === 1) {
        const val = (typed[i] - (normalize ? dataMin : 0)) * scale;
        if (colormap === "gray" || !colormap) {
          r = g = b = val;
        } else {
          [r, g, b] = applyColormap(val / 255, colormap);
        }
      } else {
        const base = i * channels;
        const ch0 = (typed[base + 0] - (normalize ? dataMin : 0)) * scale;
        const ch1 = (typed[base + 1] - (normalize ? dataMin : 0)) * scale;
        const ch2 = (typed[base + 2] - (normalize ? dataMin : 0)) * scale;
        // OpenCV default: BGR
        if (swapBGR && channels >= 3) {
          r = ch2; g = ch1; b = ch0;
        } else {
          r = ch0; g = ch1; b = ch2;
        }
        // Preserve alpha channel when present (RGBA / BGRA)
        if (channels === 4) {
          a = (typed[base + 3] - (normalize ? dataMin : 0)) * scale;
        }
      }
      out[i * 4 + 0] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = a;
    }
    return out;
  }

  // ── Decode helpers ────────────────────────────────────────────────────────

  /**
   * Decode a base64 string to a Uint8Array (synchronous).
   * @param {string} b64
   * @returns {Uint8Array}
   */
  function b64ToUint8Array(b64) {
    const binaryStr = atob(b64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Decompress a base64-encoded byte stream using the browser-native
   * DecompressionStream API (no third-party library required).
   *
   * @param {string} b64       — base64-encoded compressed bytes
   * @param {string} algorithm — DecompressionStream algorithm tag:
   *                             "deflate" | "gzip" | "deflate-raw"
   * @returns {Promise<Uint8Array>}
   */
  async function decompress(b64, algorithm) {
    const compressed = b64ToUint8Array(b64);
    const ds = new DecompressionStream(algorithm);
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  /** Compressed encoding tags that map directly to DecompressionStream algorithm names. */
  const COMPRESSED_ENCODINGS = new Set(["deflate", "gzip", "deflate-raw"]);

  /**
   * Ensure currentRawBytes is populated for "raw"/"deflate"/"gzip"/"deflate-raw" encoding.
   * Uses the cached value when available (no re-decompression on zoom/pan).
   * Returns null when encoding is "png" (bitmap path used instead).
   * @param {Object} data
   * @returns {Promise<Uint8Array|null>}
   */
  async function ensureRawBytes(data) {
    if (currentRawBytes) { return currentRawBytes; }
    if (data.encoding === "png") { return null; }
    if (COMPRESSED_ENCODINGS.has(data.encoding)) {
      currentRawBytes = await decompress(data.b64Bytes, data.encoding);
    } else {
      // "raw" or undefined
      currentRawBytes = b64ToUint8Array(data.b64Bytes);
    }
    return currentRawBytes;
  }

  /**
   * Ensure currentBitmap is populated for "png" encoding.
   * Uses the cached value when available (no re-decode on zoom/pan).
   * Returns null for "raw"/"deflate" encoding.
   * @param {Object} data
   * @returns {Promise<ImageBitmap|null>}
   */
  async function ensureBitmap(data) {
    if (currentBitmap) { return currentBitmap; }
    if (data.encoding !== "png") { return null; }
    const bytes = b64ToUint8Array(data.b64Bytes);
    const blob = new Blob([bytes], { type: "image/png" });
    currentBitmap = await createImageBitmap(blob);
    return currentBitmap;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(100, Math.max(0.1, zoom * factor));
    // Zoom towards cursor
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    panX = cx - (cx - panX) * (newZoom / zoom);
    panY = cy - (cy - panY) * (newZoom / zoom);
    zoom = newZoom;
    renderImage(currentData).catch(console.error);
    sync.report();
  }

  function onMouseDown(e) {
    isDragging = true;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
  }

  function onMouseMove(e) {
    if (isDragging) {
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
      renderImage(currentData).catch(console.error);
      sync.report();
    }

    // Hover pixel info
    const rect = canvas.getBoundingClientRect();
    const imgX = Math.floor((e.clientX - rect.left - panX) / zoom);
    const imgY = Math.floor((e.clientY - rect.top - panY) / zoom);
    if (imgX >= 0 && imgX < currentData.width && imgY >= 0 && imgY < currentData.height) {
      const pixelValues = getPixelValues(imgX, imgY);
      hoverInfo.textContent = `(${imgX}, ${imgY})  ${pixelValues}`;
      hoverInfo.style.display = "block";
      hoverInfo.style.left = (e.clientX - rect.left + 12) + "px";
      hoverInfo.style.top = (e.clientY - rect.top + 12) + "px";
    }
  }

  /** Fit the image to the container and centre it. */
  function fitToWindow(data) {
    const container = canvas.parentElement;
    const cw = container.clientWidth  || data.width;
    const ch = container.clientHeight || data.height;
    zoom = Math.min(cw / data.width, ch / data.height);
    panX = (cw - data.width  * zoom) / 2;
    panY = (ch - data.height * zoom) / 2;
  }

  function resetView() {
    fitToWindow(currentData);
    renderImage(currentData).catch(console.error);
    // Reset is a deliberate gesture, so the group follows it.
    sync.report();
  }

  // ── Pixel Inspection ──────────────────────────────────────────────────────

  function getPixelValues(x, y) {
    if (currentData.encoding === "png") {
      // PNG path: sample one pixel from the cached bitmap via a 1×1 OffscreenCanvas.
      if (!currentBitmap) { return ""; }
      const tmp = new OffscreenCanvas(1, 1);
      const tc = tmp.getContext("2d");
      // drawImage with source-rect crops exactly one pixel from the bitmap.
      tc.drawImage(currentBitmap, x, y, 1, 1, 0, 0, 1, 1);
      const px = tc.getImageData(0, 0, 1, 1).data; // RGBA, each 0-255
      const ch = currentData.channels;
      if (ch === 1) { return `[${px[0]}]`; }
      if (ch === 4) { return `[${px[0]}, ${px[1]}, ${px[2]}, ${px[3]}]`; }
      return `[${px[0]}, ${px[1]}, ${px[2]}]`;
    }

    // raw / deflate path: read from the cached decoded bytes.
    if (!currentRawBytes) { return ""; }
    const typed = viewAsTyped(currentRawBytes, currentData.dtype);
    const base = (y * currentData.width + x) * currentData.channels;
    const vals = [];
    for (let c = 0; c < currentData.channels; c++) {
      vals.push(typed[base + c].toFixed(currentData.dtype.includes("float") ? 4 : 0));
    }
    return `[${vals.join(", ")}]`;
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  /**
   * Dispatch export based on the format dropdown.
   * PNG:  canvas.toBlob — 8-bit, normalised (lossy for float data).
   * TIFF: raw pixel bytes encoded directly — preserves original dtype/precision.
   *       For "png" encoding (Python-side PNG, no raw bytes), falls back to
   *       an 8-bit RGBA TIFF from the canvas.
   */
  function saveImage() {
    const fmt = selExport.value;
    if (fmt === "tiff") {
      saveTiff();
    } else {
      savePng();
    }
  }

  function savePng() {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentData.varName}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Save a TIFF file preserving the original pixel dtype and precision.
   *
   * Two paths:
   *   raw/deflate encoding — use currentRawBytes (original typed array).
   *   png encoding         — no raw bytes available; fall back to 8-bit RGBA
   *                          read from the canvas (getImageData).
   */
  async function saveTiff() {
    const { width, height, channels, dtype } = currentData;

    // Try to get the original raw bytes (decompresses if needed).
    let rawBytes = await ensureRawBytes(currentData);

    if (rawBytes) {
      // Original-dtype TIFF — lossless.
      const tiffData = createTiff(width, height, channels, dtype, rawBytes);
      _downloadBlob(new Blob([tiffData], { type: "image/tiff" }), "tiff");
    } else {
      // PNG-encoding path: no raw bytes.  Read RGBA from the canvas and
      // write an 8-bit RGBA TIFF.
      const off = new OffscreenCanvas(width, height);
      const octx = off.getContext("2d");
      // Re-render at 1:1 scale so canvas pixels map to image pixels.
      octx.drawImage(canvas, 0, 0, width, height);
      // If zoomed/panned, the main canvas may not cover the full image.
      // Use the cached bitmap or re-render directly instead.
      const bmp = await ensureBitmap(currentData);
      if (bmp) {
        octx.clearRect(0, 0, width, height);
        octx.drawImage(bmp, 0, 0, width, height);
      }
      const imgData = octx.getImageData(0, 0, width, height);
      // imgData.data is RGBA Uint8ClampedArray — channels = 4.
      const tiffData = createTiff(width, height, 4, "uint8", imgData.data);
      _downloadBlob(new Blob([tiffData], { type: "image/tiff" }), "tiff");
    }
  }

  function _downloadBlob(blob, ext) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentData.varName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Encode raw pixel data as a little-endian TIFF (baseline, uncompressed).
   *
   * Supports all dtypes used by the extension:
   *   uint8   → 8-bit unsigned   (SampleFormat = 1)
   *   int8    → 8-bit signed      (SampleFormat = 2)
   *   uint16  → 16-bit unsigned   (SampleFormat = 1)
   *   int16   → 16-bit signed     (SampleFormat = 2)
   *   uint32  → 32-bit unsigned   (SampleFormat = 1)
   *   int32   → 32-bit signed     (SampleFormat = 2)
   *   float32 → 32-bit IEEE float (SampleFormat = 3)
   *   float64 → 64-bit IEEE float (SampleFormat = 3)
   *
   * Channel handling:
   *   1 channel → grayscale (PhotometricInterpretation = 1)
   *   3 channels → RGB       (PhotometricInterpretation = 2)
   *   4 channels → RGBA      (PhotometricInterpretation = 2, ExtraSamples = 2 = unassociated alpha)
   *
   * @param {number} width
   * @param {number} height
   * @param {number} channels   1, 3, or 4
   * @param {string} dtype      "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64"
   * @param {Uint8Array} rawBytes  flat pixel bytes in row-major order
   * @returns {Uint8Array}  complete TIFF file bytes
   */
  function createTiff(width, height, channels, dtype, rawBytes) {
    // Map dtype → bitsPerSample / sampleFormat / bytesPerSample
    const dtypeSpec = {
      "uint8":   { bits: 8,  format: 1, bytes: 1 },
      "int8":    { bits: 8,  format: 2, bytes: 1 },
      "uint16":  { bits: 16, format: 1, bytes: 2 },
      "int16":   { bits: 16, format: 2, bytes: 2 },
      "uint32":  { bits: 32, format: 1, bytes: 4 },
      "int32":   { bits: 32, format: 2, bytes: 4 },
      "float32": { bits: 32, format: 3, bytes: 4 },
      "float64": { bits: 64, format: 3, bytes: 8 },
    };
    const spec = dtypeSpec[dtype] || dtypeSpec["uint8"];
    const { bits: bitsPerSample, format: sampleFormat, bytes: bytesPerSample } = spec;

    const samplesPerPixel = channels === 1 ? 1 : (channels === 4 ? 4 : 3);
    const photometric = channels === 1 ? 1 : 2; // 1=grayscale, 2=RGB
    const rowsPerStrip = height;
    const stripByteCount = width * height * samplesPerPixel * bytesPerSample;

    // IFD structure
    // 4 channels needs an ExtraSamples entry → 13 entries, else 12.
    const numEntries = channels === 4 ? 13 : 12;
    const headerSize = 8;                        // TIFF header
    const ifdOffset = headerSize;
    const ifdSize = 2 + numEntries * 12 + 4;     // count + entries + next-IFD ptr
    // Extra data area after IFD: BitsPerSample array (if RGB/RGBA), XRes, YRes,
    // and optionally ExtraSamples array.
    let extraOffset = ifdOffset + ifdSize;
    const bitsPerSampleOffset = samplesPerPixel > 1 ? extraOffset : 0;
    if (samplesPerPixel > 1) { extraOffset += samplesPerPixel * 2; }
    const xResOffset = extraOffset; extraOffset += 8;
    const yResOffset = extraOffset; extraOffset += 8;
    const extraSamplesOffset = channels === 4 ? extraOffset : 0;
    if (channels === 4) { extraOffset += 2; } // one SHORT for ExtraSamples

    const stripOffset = extraOffset;
    const totalSize = stripOffset + stripByteCount;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    let offset = 0;

    // TIFF header (little endian)
    view.setUint16(offset, 0x4949, true); offset += 2; // "II" = little endian
    view.setUint16(offset, 42, true); offset += 2;    // TIFF magic
    view.setUint32(offset, ifdOffset, true); offset += 4;

    // IFD
    view.setUint16(offset, numEntries, true); offset += 2;

    function writeEntry(tag, type, count, value) {
      view.setUint16(offset, tag, true); offset += 2;
      view.setUint16(offset, type, true); offset += 2;
      view.setUint32(offset, count, true); offset += 4;
      if (type === 3 && count === 1) { // SHORT
        view.setUint16(offset, value, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
      } else if (type === 4 && count === 1) { // LONG
        view.setUint32(offset, value, true); offset += 4;
      } else {
        // Value is an offset to the actual data
        view.setUint32(offset, value, true); offset += 4;
      }
    }

    writeEntry(256, 3, 1, width);              // ImageWidth
    writeEntry(257, 3, 1, height);             // ImageLength
    // BitsPerSample: for 1 sample, value fits inline; for multi, it's an offset
    writeEntry(258, 3, samplesPerPixel,
      samplesPerPixel === 1 ? bitsPerSample : bitsPerSampleOffset);
    writeEntry(259, 3, 1, 1);                  // Compression = none
    writeEntry(262, 3, 1, photometric);         // PhotometricInterpretation
    writeEntry(273, 4, 1, stripOffset);         // StripOffsets
    writeEntry(277, 3, 1, samplesPerPixel);     // SamplesPerPixel
    writeEntry(278, 4, 1, rowsPerStrip);        // RowsPerStrip
    writeEntry(279, 4, 1, stripByteCount);      // StripByteCounts
    writeEntry(282, 5, 1, xResOffset);          // XResolution
    writeEntry(283, 5, 1, yResOffset);          // YResolution
    writeEntry(339, 3, 1, sampleFormat);        // SampleFormat
    if (channels === 4) {
      writeEntry(338, 3, 1, 2);                 // ExtraSamples = 2 (unassociated alpha)
    }

    view.setUint32(offset, 0, true); offset += 4; // Next IFD offset = 0

    // Extra data: BitsPerSample array (multi-sample only)
    if (samplesPerPixel > 1) {
      for (let i = 0; i < samplesPerPixel; i++) {
        view.setUint16(bitsPerSampleOffset + i * 2, bitsPerSample, true);
      }
    }

    // Extra data: XResolution (72/1 as RATIONAL)
    view.setUint32(xResOffset, 72, true);
    view.setUint32(xResOffset + 4, 1, true);
    // Extra data: YResolution (72/1 as RATIONAL)
    view.setUint32(yResOffset, 72, true);
    view.setUint32(yResOffset + 4, 1, true);

    // Image data — copy raw bytes directly (already in the correct byte order
    // for little-endian TIFF, since JS typed arrays are platform-endian and
    // we only run on little-endian platforms in practice).
    const pixelData = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    bytes.set(pixelData, stripOffset);

    return bytes;
  }

  // ── VS Code message listener ──────────────────────────────────────────────
  // Sync messages ("sync/*") are handled inside sync-controls.js.

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "update" && msg.data) {
      currentData = msg.data;
      // Invalidate decode caches so the new data is decoded fresh.
      currentRawBytes = null;
      currentBitmap = null;
      normalize = !currentData.isUint8;
      chkNormalize.checked = normalize;
      swapBGR = (currentData.format === "BGR" || currentData.format === "BGRA");
      chkBGR.checked = swapBGR;
      const fmtStr = currentData.format ? `  ${currentData.format}` : "";
      infoLabel.textContent = `${currentData.height}×${currentData.width}  ch:${currentData.channels}  ${currentData.dtype}${fmtStr}`;
      // A refresh re-fits the image, which changes the viewport. When synced,
      // keep the group's viewport instead of imposing this panel's fit.
      if (!sync.isSynced()) {
        fitToWindow(currentData);
      }
      renderImage(currentData).catch(console.error);
    }
  });

  // ── Typed-buffer helper ────────────────────────────────────────────────────

  function viewAsTyped(rawBytes, dtype) {
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);
    switch (dtype) {
      case "uint8":   return new Uint8Array(ab);
      case "int8":    return new Int8Array(ab);
      case "uint16":  return new Uint16Array(ab);
      case "int16":   return new Int16Array(ab);
      case "uint32":  return new Uint32Array(ab);
      case "int32":   return new Int32Array(ab);
      case "float32": return new Float32Array(ab);
      case "float64": return new Float64Array(ab);
      default:        return new Float32Array(ab);
    }
  }

  // Colormap tables are provided by colormaps.js (window.COLORMAPS)
  function applyColormap(t, name) {
    if (window.COLORMAPS && window.COLORMAPS[name]) {
      return window.COLORMAPS[name](t);
    }
    const v = t * 255;
    return [v, v, v];
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  init();
})();
