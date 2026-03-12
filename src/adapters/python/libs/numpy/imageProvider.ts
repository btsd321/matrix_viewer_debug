/**
 * numpy/imageProvider.ts — ImageData extraction from numpy.ndarray.
 *
 * Handles: ndarray (H,W) / (H,W,1) / (H,W,3) / (H,W,4)
 * Also covers cv2.Mat, which is a numpy ndarray at runtime.
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../../IDebugAdapter";
import { ImageData } from "../../../../viewers/viewerTypes";
import { ILibImageProvider } from "../../../ILibProviders";
import { fetchArrayData } from "../../pythonDebugger";
import { resolveHWC, computeMinMax, bufferToBase64 } from "../utils";

export class NumpyImageProvider implements ILibImageProvider {
  canHandle(typeName: string): boolean {
    // numpy.ndarray, numpy.ma.MaskedArray, cv2.Mat (which is ndarray)
    return /numpy\.|ndarray|cv2\./i.test(typeName);
  }

  async fetchImageData(
    session: vscode.DebugSession,
    varName: string,
    info: VariableInfo
  ): Promise<ImageData | null> {
    const shape = info.shape;
    const dtype = info.dtype ?? "uint8";
    if (!shape || shape.length < 2) {
      return null;
    }

    const [height, width, channels] = resolveHWC(shape);

    const raw = await fetchArrayData(session, varName, { ...info, shape, dtype });
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
}
