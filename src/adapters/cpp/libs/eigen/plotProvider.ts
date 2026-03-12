/**
 * eigen/plotProvider.ts — PlotData extraction from Eigen matrices (C++ / cppdbg).
 *
 * TODO: Implement using DAP variable child inspection or readMemory to read
 *       Eigen::Matrix / Eigen::Array internal storage.
 *
 * Supported types (planned):
 *   - Eigen::VectorXd / VectorXf → 1D column vector → PlotData
 *   - Eigen::RowVectorXd / RowVectorXf → 1D row vector → PlotData
 *   - Eigen::MatrixXd / MatrixXf (any shape) → flattened → PlotData
 *
 * References:
 *   - Eigen storage: column-major by default, row-major via RowMajor flag
 *   - https://eigen.tuxfamily.org/dox/group__TopicStorageOrders.html
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../IDebugAdapter";
import { PlotData } from "../../../../viewers/viewerTypes";
import { ILibPlotProvider } from "../../../ILibProviders";

export class EigenPlotProvider implements ILibPlotProvider {
  canHandle(typeName: string): boolean {
    return /Eigen::(Matrix|Array|Vector|RowVector)/i.test(typeName);
  }

  async fetchPlotData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<PlotData | null> {
    // TODO: read Eigen::Matrix.m_storage.m_data via DAP readMemory
    return null;
  }
}
