/**
 * pointCloudProvider.ts — 3D point cloud data extraction.
 *
 * Supports:
 *   - numpy.ndarray  shape (N, 3)  → XYZ
 *   - numpy.ndarray  shape (N, 6)  → XYZ + RGB
 *   - Python list of (x, y, z) tuples
 */

import * as vscode from "vscode";
import {
  VariableInfo,
  fetchArrayData,
  fetchListData,
  evaluateExpression,
} from "../utils/debugger";

// ── Public data contract ───────────────────────────────────────────────────

export interface PointCloudData {
  /** Flat XYZ values: [x0,y0,z0, x1,y1,z1, …] */
  xyzValues: number[];
  /** Optional per-point RGB in [0,1]: [r0,g0,b0, r1,g1,b1, …] */
  rgbValues?: number[];
  pointCount: number;
  /** Bounds for axis colouring */
  bounds: {
    xMin: number; xMax: number;
    yMin: number; yMax: number;
    zMin: number; zMax: number;
  };
  varName: string;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class PointCloudProvider {
  constructor(private readonly session: vscode.DebugSession) {}

  async fetchPointCloudData(
    varName: string,
    info: VariableInfo
  ): Promise<PointCloudData | null> {
    const typeName = info.typeName ?? "";
    const shape = info.shape;

    if (/numpy\.ndarray/i.test(typeName) && shape && shape.length === 2) {
      return this.fetchNdarrayPointCloud(varName, info, shape);
    }

    // Fallback: try to extract as a list of tuples
    return this.fetchListPointCloud(varName, info);
  }

  // ── numpy.ndarray path ────────────────────────────────────────────────────

  private async fetchNdarrayPointCloud(
    varName: string,
    info: VariableInfo,
    shape: number[]
  ): Promise<PointCloudData | null> {
    const [n, cols] = shape;
    if (cols !== 3 && cols !== 6) {
      return null;
    }

    const raw = await fetchArrayData(this.session, `${varName}.astype('float32')`, {
      ...info,
      dtype: "float32",
    });
    if (!raw) {
      return null;
    }

    const floats = new Float32Array(
      raw.buffer.buffer,
      raw.buffer.byteOffset,
      n * cols
    );
    const xyzValues: number[] = [];
    const rgbValues: number[] | undefined = cols === 6 ? [] : undefined;

    for (let i = 0; i < n; i++) {
      xyzValues.push(floats[i * cols], floats[i * cols + 1], floats[i * cols + 2]);
      if (rgbValues) {
        rgbValues.push(
          floats[i * cols + 3],
          floats[i * cols + 4],
          floats[i * cols + 5]
        );
      }
    }

    return {
      xyzValues,
      rgbValues,
      pointCount: n,
      bounds: computeBounds(xyzValues),
      varName,
    };
  }

  // ── list/tuple path ───────────────────────────────────────────────────────

  private async fetchListPointCloud(
    varName: string,
    info: VariableInfo
  ): Promise<PointCloudData | null> {
    const expr = `__import__('json').dumps([[float(p[0]),float(p[1]),float(p[2])] for p in ${varName}])`;
    const result = await evaluateExpression(
      this.session,
      expr,
      info.frameId
    );
    if (!result) {
      return null;
    }

    let points: number[][];
    try {
      points = JSON.parse(result.replace(/^'|'$/g, "")) as number[][];
    } catch {
      return null;
    }

    const xyzValues = points.flat();
    return {
      xyzValues,
      pointCount: points.length,
      bounds: computeBounds(xyzValues),
      varName,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function computeBounds(xyz: number[]): PointCloudData["bounds"] {
  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;

  for (let i = 0; i < xyz.length; i += 3) {
    const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
    if (x < xMin) { xMin = x; } if (x > xMax) { xMax = x; }
    if (y < yMin) { yMin = y; } if (y > yMax) { yMax = y; }
    if (z < zMin) { zMin = z; } if (z > zMax) { zMax = z; }
  }
  return {
    xMin: isFinite(xMin) ? xMin : 0, xMax: isFinite(xMax) ? xMax : 1,
    yMin: isFinite(yMin) ? yMin : 0, yMax: isFinite(yMax) ? yMax : 1,
    zMin: isFinite(zMin) ? zMin : 0, zMax: isFinite(zMax) ? zMax : 1,
  };
}
