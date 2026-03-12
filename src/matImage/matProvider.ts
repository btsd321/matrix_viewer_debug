/**
 * matProvider.ts — Image data extraction for the 2D Image Viewer.
 *
 * Supports:
 *   - numpy.ndarray  (H,W) / (H,W,1) / (H,W,3) / (H,W,4)
 *   - PIL.Image
 *   - torch.Tensor   (H,W) / (C,H,W) / (H,W,C)
 *
 * Output: ImageData, a plain-object with all info the webview needs.
 */

import * as vscode from "vscode";
import {
  VariableInfo,
  fetchArrayData,
  evaluateExpression,
} from "../utils/debugger";

// ── Public data contract ───────────────────────────────────────────────────

export interface ImageData {
  /** Flat pixel bytes, C-order, as Base64 string */
  b64Bytes: string;
  width: number;
  height: number;
  channels: number;
  dtype: string;
  /** Whether pixel values are already in [0,255] uint8 */
  isUint8: boolean;
  /** Min/max for normalisation UI */
  dataMin: number;
  dataMax: number;
  varName: string;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class ImageProvider {
  constructor(private readonly session: vscode.DebugSession) {}

  async fetchImageData(
    varName: string,
    info: VariableInfo
  ): Promise<ImageData | null> {
    const typeName = info.typeName ?? "";

    if (/PIL\./i.test(typeName)) {
      return this.fetchPilImage(varName, info);
    }
    if (/torch\.Tensor/i.test(typeName)) {
      return this.fetchTorchTensor(varName, info);
    }
    // Default: numpy ndarray (also covers cv2.Mat which is ndarray)
    return this.fetchNdarray(varName, info);
  }

  // ── numpy.ndarray (and cv2 Mat) ──────────────────────────────────────────

  private async fetchNdarray(
    varName: string,
    info: VariableInfo
  ): Promise<ImageData | null> {
    const shape = info.shape;
    const dtype = info.dtype ?? "uint8";
    if (!shape || shape.length < 2) {
      return null;
    }

    const [height, width, channels] = resolveHWC(shape);

    const raw = await fetchArrayData(this.session, varName, {
      ...info,
      shape,
      dtype,
    });
    if (!raw) {
      return null;
    }

    const { dataMin, dataMax } = computeMinMax(raw.buffer, dtype);

    return {
      b64Bytes: bufferToBase64(raw.buffer),
      width,
      height,
      channels,
      dtype,
      isUint8: dtype === "uint8",
      dataMin,
      dataMax,
      varName,
    };
  }

  // ── PIL.Image ─────────────────────────────────────────────────────────────

  private async fetchPilImage(
    varName: string,
    info: VariableInfo
  ): Promise<ImageData | null> {
    // Convert PIL image to numpy array via evaluate, then treat as ndarray
    const convertExpr =
      `__import__('json').dumps({` +
      `'mode': ${varName}.mode,` +
      `'width': ${varName}.width,` +
      `'height': ${varName}.height` +
      `})`;

    const metaRaw = await evaluateExpression(
      this.session,
      convertExpr,
      info.frameId
    );
    if (!metaRaw) {
      return null;
    }

    const meta = JSON.parse(metaRaw.replace(/^'|'$/g, "")) as {
      mode: string;
      width: number;
      height: number;
    };

    const channels = pilModeToChannels(meta.mode);
    const dtype = "uint8";

    const b64Expr =
      `__import__('base64').b64encode(` +
      `__import__('numpy').array(${varName}).tobytes()` +
      `).decode('ascii')`;

    const b64Raw = await evaluateExpression(
      this.session,
      b64Expr,
      info.frameId
    );
    if (!b64Raw) {
      return null;
    }

    return {
      b64Bytes: b64Raw.replace(/^'|'$/g, ""),
      width: meta.width,
      height: meta.height,
      channels,
      dtype,
      isUint8: true,
      dataMin: 0,
      dataMax: 255,
      varName,
    };
  }

  // ── torch.Tensor ──────────────────────────────────────────────────────────

  private async fetchTorchTensor(
    varName: string,
    info: VariableInfo
  ): Promise<ImageData | null> {
    const shape = info.shape;
    if (!shape) {
      return null;
    }

    // Normalise to (H, W, C) via evaluate
    const normaliseExpr =
      `(lambda t: t.permute(1,2,0) if t.ndim == 3 and t.shape[0] in (1,3,4) else t)(` +
      `${varName}.detach().cpu().float())`;

    // Delegate to ndarray path after normalisation
    const syntheticInfo: VariableInfo = {
      ...info,
      typeName: "numpy.ndarray",
      shape: normaliseTensorShape(shape),
      dtype: "float32",
    };

    const raw = await fetchArrayData(
      this.session,
      `__import__('numpy').array(${normaliseExpr})`,
      syntheticInfo
    );
    if (!raw) {
      return null;
    }

    const [height, width, channels] = resolveHWC(syntheticInfo.shape!);
    const { dataMin, dataMax } = computeMinMax(raw.buffer, "float32");

    return {
      b64Bytes: bufferToBase64(raw.buffer),
      width,
      height,
      channels,
      dtype: "float32",
      isUint8: false,
      dataMin,
      dataMax,
      varName,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveHWC(shape: number[]): [number, number, number] {
  if (shape.length === 2) {
    return [shape[0], shape[1], 1];
  }
  return [shape[0], shape[1], shape[2]];
}

function pilModeToChannels(mode: string): number {
  if (mode === "L" || mode === "P") {
    return 1;
  }
  if (mode === "RGB") {
    return 3;
  }
  if (mode === "RGBA" || mode === "CMYK") {
    return 4;
  }
  return 3;
}

function normaliseTensorShape(shape: number[]): number[] {
  if (shape.length === 3 && [1, 3, 4].includes(shape[0])) {
    // (C, H, W) → (H, W, C)
    return [shape[1], shape[2], shape[0]];
  }
  return shape;
}

function computeMinMax(
  buffer: Uint8Array,
  dtype: string
): { dataMin: number; dataMax: number } {
  const view = typedViewOf(buffer, dtype);
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (let i = 0; i < view.length; i++) {
    const v = view[i] as number;
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

function typedViewOf(
  buffer: Uint8Array,
  dtype: string
): ArrayLike<number> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  switch (dtype) {
    case "uint8":  return new Uint8Array(ab);
    case "int8":   return new Int8Array(ab);
    case "uint16": return new Uint16Array(ab);
    case "int16":  return new Int16Array(ab);
    case "uint32": return new Uint32Array(ab);
    case "int32":  return new Int32Array(ab);
    case "float32": return new Float32Array(ab);
    case "float64": return new Float64Array(ab);
    default:       return new Float32Array(ab);
  }
}

function bufferToBase64(buffer: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}
