/**
 * syncCommands.ts — Command layer for view synchronisation.
 *
 * Owns the user-facing entry points (`matrixViewer.syncPair`,
 * `matrixViewer.syncUnpair`) so `extension.ts` only has to wire the module up.
 * All state lives in `SyncCoordinator`; this file is pure UI plumbing:
 * resolve a variable name, ask the user which panel to pair with, report back.
 */

import * as vscode from "vscode";
import { logger } from "../log/logger";
import { SyncCoordinator } from "./syncCoordinator";
import { SyncKind } from "./ISyncTypes";

/** Human-readable viewer family names, used in QuickPick titles. */
const KIND_LABELS: Record<SyncKind, string> = {
    image: "image",
    plot: "plot",
    pointcloud: "point cloud",
};

/**
 * Anything the sync commands can be invoked with. TreeView items expose
 * `variableName`; the debug Variables context menu passes a `variable` payload.
 */
type SyncCommandArg =
    | string
    | { variableName?: string; name?: string; variable?: { name?: string; evaluateName?: string } }
    | undefined;

/** Extract the target variable name from whatever the command was given. */
function resolveVarName(arg: SyncCommandArg): string {
    if (typeof arg === "string") {
        return arg;
    }
    if (!arg) {
        return "";
    }
    return (
        arg.variableName ??
        arg.variable?.evaluateName ??
        arg.variable?.name ??
        arg.name ??
        ""
    );
}

/**
 * Register the sync commands.
 *
 * @param onChange Called after membership changes so callers can refresh views.
 */
export function registerSyncCommands(
    context: vscode.ExtensionContext,
    coordinator: SyncCoordinator,
    onChange: () => void
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "matrixViewer.syncPair",
            async (arg: SyncCommandArg) => {
                await runSyncPair(coordinator, arg, onChange);
            }
        ),
        vscode.commands.registerCommand(
            "matrixViewer.syncUnpair",
            (arg: SyncCommandArg) => {
                runSyncUnpair(coordinator, arg, onChange);
            }
        )
    );
}

// ── matrixViewer.syncPair ─────────────────────────────────────────────────

async function runSyncPair(
    coordinator: SyncCoordinator,
    arg: SyncCommandArg,
    onChange: () => void
): Promise<void> {
    const varName = resolveVarName(arg);
    if (!varName) {
        logger.warn("[Sync] syncPair invoked without a resolvable variable name");
        vscode.window.showWarningMessage(
            "MatrixViewer: could not resolve variable name from context."
        );
        return;
    }

    if (!coordinator.hasPanel(varName)) {
        logger.info(`[Sync] syncPair: no open panel for "${varName}"`);
        vscode.window.showInformationMessage(
            `MatrixViewer: open a viewer for "${varName}" before syncing it.`
        );
        return;
    }

    const candidates = coordinator.getSyncCandidates(varName);
    if (candidates.length === 0) {
        logger.info(`[Sync] no sync candidates for "${varName}"`);
        vscode.window.showInformationMessage(
            `MatrixViewer: no other viewer of the same type is open to sync "${varName}" with. ` +
            "Open a second viewer of the same type first."
        );
        return;
    }

    interface PeerPick extends vscode.QuickPickItem {
        target: string;
    }

    const items: PeerPick[] = candidates.map((peer) => ({
        label: peer.isMember ? `$(check) ${peer.varName}` : peer.varName,
        description: KIND_LABELS[peer.kind],
        detail: peer.isMember ? "Already synced with this panel" : undefined,
        target: peer.varName,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Sync "${varName}" with…`,
        placeHolder: "Select a panel whose viewport should follow this one",
        matchOnDescription: true,
    });
    if (!picked) {
        logger.debug(`[Sync] syncPair cancelled for "${varName}"`);
        return;
    }

    const outcome = coordinator.syncWith(varName, picked.target);
    if (outcome.ok) {
        onChange();
        const partners = outcome.members.filter((m) => m !== varName);
        vscode.window.showInformationMessage(
            `MatrixViewer: "${varName}" is now synced with ${partners
                .map((p) => `"${p}"`)
                .join(", ")}.`
        );
        return;
    }

    vscode.window.showWarningMessage(
        `MatrixViewer: ${explainRejection(varName, picked.target, outcome.reason)}`
    );
}

function explainRejection(
    varName: string,
    target: string,
    reason: "same-panel" | "kind-mismatch" | "panel-not-open"
): string {
    switch (reason) {
        case "same-panel":
            return `"${varName}" cannot be synced with itself.`;
        case "kind-mismatch":
            return `"${varName}" and "${target}" are different viewer types; only panels of the same type can be synced.`;
        case "panel-not-open":
            return `a viewer panel for "${varName}" and "${target}" must be open to sync them.`;
    }
}

// ── matrixViewer.syncUnpair ───────────────────────────────────────────────

function runSyncUnpair(
    coordinator: SyncCoordinator,
    arg: SyncCommandArg,
    onChange: () => void
): void {
    const varName = resolveVarName(arg);
    if (!varName) {
        logger.warn("[Sync] syncUnpair invoked without a resolvable variable name");
        vscode.window.showWarningMessage(
            "MatrixViewer: could not resolve variable name from context."
        );
        return;
    }

    const partners = coordinator.unsync(varName);
    onChange();

    if (partners.length === 0) {
        vscode.window.showInformationMessage(
            `MatrixViewer: "${varName}" is no longer synced.`
        );
        return;
    }
    vscode.window.showInformationMessage(
        `MatrixViewer: "${varName}" left the sync group (${partners
            .map((p) => `"${p}"`)
            .join(", ")} remain synced).`
    );
}
