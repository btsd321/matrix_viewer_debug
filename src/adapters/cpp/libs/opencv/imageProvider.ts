/**
 * opencv/imageProvider.ts — ImageData extraction from cv::Mat (C++ / cppdbg).
 *
 * TODO: Implement using DAP readMemory + variable child inspection to read
 *       cv::Mat internal fields: rows, cols, type(), data pointer.
 *
 * Supported types (planned):
 *   - CV_8UC1  → (H,W,1) uint8 grayscale
 *   - CV_8UC3  → (H,W,3) uint8 BGR
 *   - CV_8UC4  → (H,W,4) uint8 BGRA
 *   - CV_32FC1 → (H,W,1) float32
 *   - CV_32FC3 → (H,W,3) float32
 *
 * References:
 *   - cv::Mat layout: https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../IDebugAdapter";
import { ImageData } from "../../../../viewers/viewerTypes";
import { ILibImageProvider } from "../../../ILibProviders";

export class OpenCvImageProvider implements ILibImageProvider {
  canHandle(typeName: string): boolean {
    return /cv::(Mat|UMat|cuda::GpuMat)/i.test(typeName);
  }

  async fetchImageData(
    _session: vscode.DebugSession,
    _varName: string,
    _info: VariableInfo
  ): Promise<ImageData | null> {
    // TODO: read cv::Mat.rows, cols, type(), data via DAP readMemory
    return null;
  }
}
