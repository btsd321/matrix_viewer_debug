/**
 * pcl/pointCloudProvider.ts — PointCloudData from pcl::PointCloud (C++ / cppdbg).
 *
 * TODO: Implement using DAP readMemory to read the points vector storage.
 *
 * Supported types (planned):
 *   - pcl::PointCloud<pcl::PointXYZ>     → XYZ only
 *   - pcl::PointCloud<pcl::PointXYZRGB>  → XYZ + RGB (packed uint32)
 *   - pcl::PointCloud<pcl::PointXYZRGBA> → XYZ + RGBA
 *
 * pcl::PointCloud layout:
 *   - points: std::vector<PointT>
 *   - width, height: organised cloud dimensions
 *   - Each pcl::PointXYZ is { float x, y, z, _padding }
 *   - Each pcl::PointXYZRGB is { float x, y, z; uint32 rgba }
 *
 * References:
 *   - https://pointclouds.org/documentation/structpcl_1_1_point_cloud.html
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../IDebugAdapter";
import { PointCloudData } from "../../../../viewers/viewerTypes";
import { ILibPointCloudProvider } from "../../../ILibProviders";

export class PclPointCloudProvider implements ILibPointCloudProvider {
  canHandle(typeName: string): boolean {
    return /pcl::PointCloud/i.test(typeName);
  }

  async fetchPointCloudData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<PointCloudData | null> {
    // TODO: inspect pcl::PointCloud.points (std::vector) children via DAP,
    //       then readMemory for each point's x/y/z fields.
    return null;
  }
}
