/**
 * pointCloudProvider.ts — 3D point cloud data extraction coordinator.
 *
 * Dispatches to the first registered ILibPointCloudProvider that answers
 * canHandle() for the variable's type name.  To add support for a new
 * library (e.g. open3d.geometry.PointCloud, pcl), create a new provider under
 * src/adapters/python/libs/<libName>/pointCloudProvider.ts, implement
 * ILibPointCloudProvider, and append an instance to LIB_POINTCLOUD_PROVIDERS.
 *
 * Current registry (checked in order):
 *   1. numpy.ndarray      → libs/numpy/pointCloudProvider   (N×3 / N×6)
 *   2. list/tuple of xyz  → libs/builtins/pointCloudProvider (fallback)
 */

import * as vscode from "vscode";
import { VariableInfo } from "../IDebugAdapter";
import { PointCloudData } from "../../viewers/viewerTypes";
import { ILibPointCloudProvider } from "../ILibProviders";
import { NumpyPointCloudProvider } from "./libs/numpy/pointCloudProvider";
import { BuiltinsPointCloudProvider } from "./libs/builtins/pointCloudProvider";

// ── Registry ───────────────────────────────────────────────────────────────

const LIB_POINTCLOUD_PROVIDERS: ILibPointCloudProvider[] = [
  new NumpyPointCloudProvider(),
  new BuiltinsPointCloudProvider(),   // must be last — handles list/tuple
];

// ── Coordinator ────────────────────────────────────────────────────────────

export class PointCloudProvider {
  constructor(private readonly session: vscode.DebugSession) {}

  async fetchPointCloudData(
    varName: string,
    info: VariableInfo
  ): Promise<PointCloudData | null> {
    const typeName = info.typeName ?? "";
    for (const provider of LIB_POINTCLOUD_PROVIDERS) {
      if (provider.canHandle(typeName)) {
        return provider.fetchPointCloudData(this.session, varName, info);
      }
    }
    return null;
  }
}
