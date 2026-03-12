/**
 * numpy/plotProvider.ts — PlotData extraction from numpy.ndarray.
 *
 * Handles: ndarray shape (N,), (1,N), (N,1) — flattened via .ravel()
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../IDebugAdapter";
import { PlotData } from "../../../../viewers/viewerTypes";
import { ILibPlotProvider } from "../../../ILibProviders";
import { fetchArrayData } from "../../pythonDebugger";
import { typedBufferToNumbers, computeStats } from "../utils";

export class NumpyPlotProvider implements ILibPlotProvider {
  canHandle(typeName: string): boolean {
    return /numpy\.|ndarray/i.test(typeName);
  }

  async fetchPlotData(
    session: vscode.DebugSession,
    varName: string,
    info: VariableInfo
  ): Promise<PlotData | null> {
    const totalLen = info.shape?.reduce((a, b) => a * b, 1) ?? 0;
    if (totalLen === 0) {
      return null;
    }

    const flatInfo: VariableInfo = { ...info, shape: [totalLen] };
    const raw = await fetchArrayData(session, `${varName}.ravel()`, flatInfo);
    if (!raw) {
      return null;
    }

    const values = typedBufferToNumbers(raw.buffer, raw.dtype);
    if (values.length === 0) {
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
}
