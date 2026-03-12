/**
 * cppAdapter.ts — IDebugAdapter stub for C++ debug sessions.
 *
 * Handles sessions of type "cppdbg" (Microsoft C/C++ extension),
 * "lldb" (CodeLLDB), and "cppvsdbg" (Visual C++ on Windows).
 *
 * Current state: all fetch methods return null (not yet implemented).
 * Implement the TODO sections to add support for:
 *   - Eigen::Matrix / Eigen::Array → image, plot, pointcloud
 *   - cv::Mat                      → image
 *   - std::vector<T>               → plot
 *   - pcl::PointCloud              → pointcloud
 *
 * See docs/cpp-adapter.md for the planned implementation strategy.
 */

import * as vscode from "vscode";
import { IDebugAdapter, VariableInfo, VisualizableKind } from "../IDebugAdapter";
import { ImageData, PlotData, PointCloudData } from "../../viewers/viewerTypes";
import { basicTypeDetect } from "./cppTypes";

export class CppAdapter implements IDebugAdapter {
  isSupportedSession(session: vscode.DebugSession): boolean {
    return (
      session.type === "cppdbg" ||
      session.type === "lldb" ||
      session.type === "cppvsdbg"
    );
  }

  // ── Variable enumeration ──────────────────────────────────────────────

  async getVariablesInScope(
    _session: vscode.DebugSession
  ): Promise<VariableInfo[]> {
    // TODO: enumerate local variables from the C++ debug frame.
    // Use the same DAP threads/stackTrace/scopes/variables requests as Python,
    // but the `type` strings will be C++ type names instead of Python ones.
    return [];
  }

  async getVariableInfo(
    _session: vscode.DebugSession,
    varName: string,
    frameId?: number
  ): Promise<VariableInfo | null> {
    // TODO: inspect the C++ variable to determine shape and dtype.
    // Strategy options:
    //   A) DAP "evaluate" with a helper expression (if the debugger supports it)
    //   B) Read `rows`, `cols`, `type()` fields from `cv::Mat` via children
    //   C) Read template parameters for Eigen types from the type string
    void varName;
    void frameId;
    return null;
  }

  // ── Type detection ────────────────────────────────────────────────────

  basicTypeDetect(typeStr: string): VisualizableKind {
    return basicTypeDetect(typeStr);
  }

  detectVisualizableType(info: VariableInfo): VisualizableKind {
    // TODO: use shape + dtype once getVariableInfo is implemented.
    // For now, fall back to coarse Layer-1 detection.
    return basicTypeDetect(info.typeName ?? info.type);
  }

  // ── Data fetching ─────────────────────────────────────────────────────

  async fetchImageData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<ImageData | null> {
    // TODO: implement for cv::Mat and Eigen 2D matrices.
    // For cv::Mat: read .data pointer, rows, cols, channels, depth via DAP.
    // For Eigen: read .data(), .rows(), .cols() via evaluate expressions.
    return null;
  }

  async fetchPlotData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<PlotData | null> {
    // TODO: implement for std::vector<double/float> and Eigen vectors.
    return null;
  }

  async fetchPointCloudData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<PointCloudData | null> {
    // TODO: implement for pcl::PointCloud and Eigen::MatrixXf (N×3).
    return null;
  }
}
