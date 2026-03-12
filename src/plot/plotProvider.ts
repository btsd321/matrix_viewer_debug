/**
 * plotProvider.ts — 1D data extraction for the Plot Viewer.
 *
 * Supports:
 *   - numpy.ndarray  shape (N,), (1,N), (N,1)
 *   - Python list / tuple of numbers
 *   - torch.Tensor   shape (N,)
 *   - array.array
 *   - range
 */

import * as vscode from "vscode";
import {
  VariableInfo,
  fetchArrayData,
  fetchListData,
  evaluateExpression,
} from "../utils/debugger";

// ── Public data contract ───────────────────────────────────────────────────

export interface PlotData {
  /** Y values as a flat array of numbers */
  yValues: number[];
  /** Optional X values (provided when user specifies a custom X axis) */
  xValues?: number[];
  dtype: string;
  length: number;
  /** Descriptive stats */
  stats: {
    min: number;
    max: number;
    mean: number;
    std: number;
  };
  varName: string;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class PlotProvider {
  constructor(private readonly session: vscode.DebugSession) {}

  async fetchPlotData(
    varName: string,
    info: VariableInfo
  ): Promise<PlotData | null> {
    const typeName = info.typeName ?? "";
    let values: number[] | null = null;

    if (/numpy\.ndarray/i.test(typeName)) {
      values = await this.fetchNdarrayValues(varName, info);
    } else if (/torch\.Tensor/i.test(typeName)) {
      values = await this.fetchTensorValues(varName, info);
    } else {
      // list, tuple, array.array, range
      values = await fetchListData(this.session, varName, info.frameId);
    }

    if (!values || values.length === 0) {
      return null;
    }

    return {
      yValues: values,
      dtype: info.dtype ?? "float64",
      length: values.length,
      stats: computeStats(values),
      varName,
    };
  }

  private async fetchNdarrayValues(
    varName: string,
    info: VariableInfo
  ): Promise<number[] | null> {
    // Flatten to 1D before reading
    const flatInfo: VariableInfo = {
      ...info,
      shape: [info.shape?.reduce((a, b) => a * b, 1) ?? 0],
    };
    const raw = await fetchArrayData(this.session, `${varName}.ravel()`, flatInfo);
    if (!raw) {
      return null;
    }
    return typedBufferToNumbers(raw.buffer, raw.dtype);
  }

  private async fetchTensorValues(
    varName: string,
    info: VariableInfo
  ): Promise<number[] | null> {
    const expr = `__import__('json').dumps(${varName}.detach().cpu().flatten().tolist())`;
    const result = await evaluateExpression(
      this.session,
      expr,
      info.frameId
    );
    if (!result) {
      return null;
    }
    try {
      return JSON.parse(result.replace(/^'|'$/g, "")) as number[];
    } catch {
      return null;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function typedBufferToNumbers(buffer: Uint8Array, dtype: string): number[] {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  let view: ArrayLike<number>;
  switch (dtype) {
    case "uint8":   view = new Uint8Array(ab); break;
    case "int8":    view = new Int8Array(ab); break;
    case "uint16":  view = new Uint16Array(ab); break;
    case "int16":   view = new Int16Array(ab); break;
    case "uint32":  view = new Uint32Array(ab); break;
    case "int32":   view = new Int32Array(ab); break;
    case "float32": view = new Float32Array(ab); break;
    default:        view = new Float64Array(ab); break;
  }
  return Array.from(view as unknown as number[]);
}

function computeStats(values: number[]): PlotData["stats"] {
  const n = values.length;
  if (n === 0) {
    return { min: 0, max: 0, mean: 0, std: 0 };
  }
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) { min = v; }
    if (v > max) { max = v; }
    sum += v;
  }
  const mean = sum / n;
  const std = Math.sqrt(
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  );
  return { min, max, mean, std };
}
