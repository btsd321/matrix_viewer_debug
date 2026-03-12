/**
 * viewerTypes.ts — Language-agnostic display data contracts.
 *
 * These interfaces define the data shapes that webview viewers consume.
 * Any language adapter (Python, C++, etc.) must produce these exact types
 * when fetching visualizable data from a debug session.
 *
 * The webview HTML builders (matWebview.ts, plotWebview.ts, etc.) and
 * panelManager.ts depend only on these types — never on language-specific code.
 */

// ── Image Viewer ──────────────────────────────────────────────────────────

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

// ── Plot Viewer ───────────────────────────────────────────────────────────

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

// ── Point Cloud Viewer ────────────────────────────────────────────────────

export interface PointCloudData {
  /** Flat XYZ values: [x0,y0,z0, x1,y1,z1, …] */
  xyzValues: number[];
  /** Optional per-point RGB in [0,1]: [r0,g0,b0, r1,g1,b1, …] */
  rgbValues?: number[];
  pointCount: number;
  /** Bounds for axis colouring */
  bounds: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    zMin: number;
    zMax: number;
  };
  varName: string;
}
