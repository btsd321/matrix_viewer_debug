/**
 * syncCoordinator.ts — VS Code side orchestration for view synchronisation.
 *
 * Sits between the viewer webviews (reached through `ISyncPanelHost`) and the
 * pure membership state machine (`ISyncGroupStore`):
 *
 *   webview ──sync/ready|join|leave|state──▶ SyncCoordinator ──▶ SyncGroupStore
 *   webview ◀──sync/peers|status|apply───── SyncCoordinator
 *
 * It owns every policy decision the store cannot make on its own: which panels
 * are eligible peers, whether a join crosses viewer kinds, and what each panel
 * is told after a membership change. The command layer drives it through
 * `syncWith()` / `unsync()`, and the TreeView listens to `onDidChangeSyncState`.
 */

import * as vscode from "vscode";
import { logger } from "../log/logger";
import {
    ISyncGroupStore,
    ISyncPanelHost,
    ISyncStateReader,
    PanelDescriptor,
    SyncKind,
    ViewportState,
} from "./ISyncTypes";
import {
    SYNC_IN_JOIN,
    SYNC_IN_LEAVE,
    SYNC_IN_READY,
    SYNC_IN_STATE,
    SYNC_OUT_APPLY,
    SYNC_OUT_PEERS,
    SYNC_OUT_STATUS,
    SyncApplyMessage,
    SyncInboundMessage,
    SyncPeerEntry,
    SyncPeersMessage,
    SyncStatusMessage,
    describeViewportState,
    isSyncInboundMessage,
    isViewportState,
} from "./syncProtocol";

/** Outcome of a join attempt, shaped for the command layer to report to users. */
export type SyncWithOutcome =
    | { ok: true; groupIndex: number; members: string[] }
    | { ok: false; reason: "same-panel" | "kind-mismatch" | "panel-not-open" };

export class SyncCoordinator implements ISyncStateReader, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();

    /** Fires whenever group membership changes, so views can re-render. */
    readonly onDidChangeSyncState = this.changeEmitter.event;

    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly host: ISyncPanelHost,
        private readonly store: ISyncGroupStore
    ) {
        this.disposables.push(
            this.host.registerMessageObserver((varName, message) =>
                this.handleMessage(varName, message)
            ),
            this.host.onDidDisposePanel((varName) => this.handlePanelDisposed(varName))
        );
    }

    // ── Public API (command layer / TreeView) ─────────────────────────────

    /** Sync `varName` with `targetVarName`, merging groups when both are synced. */
    syncWith(varName: string, targetVarName: string): SyncWithOutcome {
        const kind = this.host.getPanelKind(varName);
        const targetKind = this.host.getPanelKind(targetVarName);

        if (!kind || !targetKind) {
            const missing = !kind ? varName : targetVarName;
            logger.warn(`[Sync] cannot sync: no open panel for "${missing}"`);
            return { ok: false, reason: "panel-not-open" };
        }

        const result = this.store.join(
            { varName, kind },
            { varName: targetVarName, kind: targetKind }
        );

        if (!result.ok) {
            logger.warn(
                `[Sync] join refused (${result.reason}): "${varName}" ↔ "${targetVarName}"`
            );
            return { ok: false, reason: result.reason };
        }

        logger.info(
            `[Sync] "${varName}" joined group ${result.group.groupIndex} ` +
            `(members: ${result.group.members.join(", ")})`
        );

        // Bring the newcomer in line with the group before anything else, so it
        // never renders a viewport the rest of the group has moved past.
        if (result.group.state) {
            this.applyTo(varName, result.group.state);
        }
        this.notifyGroup(result.group.members);
        this.pushPeersForKind(result.group.kind);
        this.changeEmitter.fire();

        return {
            ok: true,
            groupIndex: result.group.groupIndex,
            members: result.group.members,
        };
    }

    /** Remove `varName` from its group. Returns the partners it left behind. */
    unsync(varName: string): string[] {
        const kind = this.host.getPanelKind(varName);
        const snapshot = this.store.leave(varName);
        if (!snapshot) {
            logger.info(`[Sync] "${varName}" was not synchronised; nothing to do`);
            return [];
        }

        const remaining = snapshot.members.filter((m) => m !== varName);
        logger.info(
            remaining.length > 0
                ? `[Sync] "${varName}" left group ${snapshot.groupIndex} (remaining: ${remaining.join(", ")})`
                : `[Sync] group ${snapshot.groupIndex} dissolved after "${varName}" left`
        );

        this.notifyGroup([varName, ...snapshot.members]);
        this.pushPeersForKind(kind ?? snapshot.kind);
        this.changeEmitter.fire();
        return remaining;
    }

    /** Stable display index of the group `varName` belongs to, if any. */
    getGroupIndex(varName: string): number | undefined {
        return this.store.getGroupIndex(varName);
    }

    /** Group members other than `varName`. Empty when it is not synchronised. */
    getPartners(varName: string): string[] {
        return this.store.getMembers(varName).filter((m) => m !== varName);
    }

    /** True when a viewer panel is currently open for `varName`. */
    hasPanel(varName: string): boolean {
        return this.host.getPanelKind(varName) !== undefined;
    }

    /** Open panels of the same kind that `varName` could sync with. */
    getSyncCandidates(varName: string): SyncPeerEntry[] {
        const kind = this.host.getPanelKind(varName);
        if (!kind) {
            return [];
        }
        const members = new Set(this.store.getMembers(varName));
        return this.host
            .listPanels()
            .filter((p) => p.kind === kind && p.varName !== varName)
            .map((p) => ({ ...p, isMember: members.has(p.varName) }));
    }

    /** Drop all sync state, e.g. when the debug session ends. */
    clear(): void {
        const affected = this.store.listGroups().flatMap((g) => g.members);
        this.store.clear();
        if (affected.length > 0) {
            logger.info(`[Sync] cleared all groups (${affected.length} panel(s) released)`);
            this.notifyGroup(affected);
            this.changeEmitter.fire();
        }
        for (const kind of ["image", "plot", "pointcloud"] as SyncKind[]) {
            this.pushPeersForKind(kind);
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this.changeEmitter.dispose();
    }

    // ── Inbound message handling ──────────────────────────────────────────

    private handleMessage(varName: string, message: unknown): void {
        if (!isSyncInboundMessage(message)) {
            return; // Not ours — viewer-local messages pass through untouched.
        }
        const msg: SyncInboundMessage = message;

        switch (msg.type) {
            case SYNC_IN_READY:
                logger.debug(`[Sync] ← sync/ready from "${varName}" (kind=${msg.kind})`);
                this.handleReady(varName);
                break;

            case SYNC_IN_JOIN:
                logger.debug(`[Sync] ← sync/join from "${varName}" → "${msg.target}"`);
                this.handleJoinRequest(varName, msg.target);
                break;

            case SYNC_IN_LEAVE:
                logger.debug(`[Sync] ← sync/leave from "${varName}"`);
                this.unsync(varName);
                break;

            case SYNC_IN_STATE:
                this.handleStateReport(varName, msg.state);
                break;
        }
    }

    /** A viewer finished booting: hand it peers, status, and the group viewport. */
    private handleReady(varName: string): void {
        const group = this.store.getGroup(varName);
        if (group?.state) {
            this.applyTo(varName, group.state);
        }
        this.pushStatus(varName);
        // A newly ready panel is a new peer for every other panel of its kind.
        const kind = this.host.getPanelKind(varName);
        if (kind) {
            this.pushPeersForKind(kind);
        } else {
            this.pushPeers(varName);
        }
    }

    private handleJoinRequest(varName: string, target: string): void {
        const outcome = this.syncWith(varName, target);
        if (outcome.ok) {
            return;
        }
        // The dropdown is built from live peers, so a failure here means the
        // target closed between rendering and clicking — refresh the panel's view.
        this.pushPeers(varName);
        this.pushStatus(varName);
    }

    private handleStateReport(varName: string, state: unknown): void {
        if (!isViewportState(state)) {
            logger.warn(`[Sync] ignoring malformed viewport state from "${varName}"`);
            return;
        }

        const kind = this.host.getPanelKind(varName);
        if (kind && state.kind !== kind) {
            logger.warn(
                `[Sync] ignoring ${state.kind} state from "${varName}" (panel is ${kind})`
            );
            return;
        }

        const plan = this.store.recordState(varName, state);
        if (plan.swallowedReason) {
            logger.debug(
                `[Sync] ← sync/state from "${varName}" dropped (${plan.swallowedReason})`
            );
            return;
        }

        logger.debug(
            `[Sync] ← sync/state from "${varName}" ${describeViewportState(state)} ` +
            `→ ${plan.targets.join(", ")}`
        );
        for (const target of plan.targets) {
            this.applyTo(target, state);
        }
    }

    /** A panel closed: it can no longer participate in a group. */
    private handlePanelDisposed(varName: string): void {
        const kind = this.host.getPanelKind(varName);
        const snapshot = this.store.leave(varName);
        if (snapshot) {
            logger.info(
                `[Sync] "${varName}" removed from group ${snapshot.groupIndex} (panel closed)`
            );
            this.notifyGroup(snapshot.members);
            this.changeEmitter.fire();
        }
        this.pushPeersForKind(kind ?? snapshot?.kind);
    }

    // ── Outbound messages ─────────────────────────────────────────────────

    private applyTo(varName: string, state: ViewportState): void {
        const msg: SyncApplyMessage = { type: SYNC_OUT_APPLY, state };
        if (this.host.post(varName, msg)) {
            this.store.markApplied(varName);
        } else {
            logger.warn(`[Sync] could not apply viewport, panel "${varName}" is gone`);
        }
    }

    private pushStatus(varName: string): void {
        const msg: SyncStatusMessage = {
            type: SYNC_OUT_STATUS,
            groupIndex: this.store.getGroupIndex(varName),
            partners: this.getPartners(varName),
        };
        this.host.post(varName, msg);
    }

    private pushPeers(varName: string): void {
        const msg: SyncPeersMessage = {
            type: SYNC_OUT_PEERS,
            peers: this.getSyncCandidates(varName),
        };
        this.host.post(varName, msg);
    }

    /** Refresh the dropdown of every open panel of one kind. */
    private pushPeersForKind(kind: SyncKind | undefined): void {
        const panels: PanelDescriptor[] = this.host.listPanels();
        for (const panel of panels) {
            if (!kind || panel.kind === kind) {
                this.pushPeers(panel.varName);
            }
        }
    }

    /** Re-send status to a set of panels after their membership changed. */
    private notifyGroup(varNames: Iterable<string>): void {
        for (const varName of new Set(varNames)) {
            this.pushStatus(varName);
        }
    }
}
