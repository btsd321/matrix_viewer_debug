/**
 * gdb/pointCloudProvider.ts — Point cloud coordinator for GDB (session.type = "cppdbg").
 */

import * as vscode from "vscode";
import { VariableInfo } from "../../IDebugAdapter";
import { PointCloudData } from "../../../viewers/viewerTypes";
import { ILibPointCloudProvider } from "../../ILibProviders";
import { PclPointCloudProvider } from "./libs/pcl/pointCloudProvider";
import { StdPointCloudProvider } from "./libs/std/pointCloudProvider";
import { QtPointCloudProvider } from "./libs/qt/pointCloudProvider";
import { Ros2PointCloudProvider } from "./libs/ros2/pointCloudProvider";
import { unwrapSmartPointer, buildDerefExpression, buildNullGuardExpression } from "../shared/utils";

const PROVIDERS: ILibPointCloudProvider[] = [
    new PclPointCloudProvider(),
    new StdPointCloudProvider(),
    new QtPointCloudProvider(),
    new Ros2PointCloudProvider(),
];

export async function fetchGdbPointCloudData(
    session: vscode.DebugSession,
    varName: string,
    info: VariableInfo
): Promise<PointCloudData | null> {
    let resolvedName = varName;
    let typeName = info.typeName ?? info.type;
    let resolvedInfo = info;

    const unwrapped = unwrapSmartPointer(typeName);
    if (unwrapped !== null) {
        resolvedName = buildDerefExpression(varName, unwrapped, "gdb");
        typeName = unwrapped.innerType;
        resolvedInfo = {
            ...info,
            typeName: unwrapped.innerType,
            type: unwrapped.innerType,
            variablesReference: 0,
            nullGuardExpression: buildNullGuardExpression(varName, unwrapped, "gdb"),
        };
    }

    for (const provider of PROVIDERS) {
        if (provider.canHandle(typeName)) {
            return provider.fetchPointCloudData(session, resolvedName, resolvedInfo);
        }
    }
    return null;
}
