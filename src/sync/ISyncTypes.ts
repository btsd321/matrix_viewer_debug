/**
 * ISyncTypes.ts — View-sync contracts.
 *
 * Interface / type declarations only: no logic, no state, no DAP calls.
 *
 * Two consumers depend on this file:
 *   - src/sync/syncGroupStore.ts     — the pure membership state machine
 *   - src/sync/syncCoordinator.ts    — the VS Code side orchestration
 *
 * `ISyncPanelHost` is the abstraction the coordinator uses to reach webview
 * panels. `PanelManager` implements it, which keeps the dependency direction
 * one-way: sync → panels, never panels → sync.
 */

import * as vscode from "vscode";

// ── Panel identity ────────────────────────────────────────────────────────

/**
 * Viewer families that can be synchronised. Only panels of the same kind may
 * join the same sync group — an image viewport is meaningless to a 3D camera.
 */
export type SyncKind = "image" | "plot" | "pointcloud";

/** A single open viewer panel, as seen by the sync layer. */
export interface PanelDescriptor {
    varName: string;
    kind: SyncKind;
}

/**
 * A panel participating in a join request. Structurally identical to
 * `PanelDescriptor`; the alias exists to keep join signatures self-documenting.
 */
export type SyncMember = PanelDescriptor;

// ── Viewport state ────────────────────────────────────────────────────────

/** Image viewer viewport: canvas zoom factor plus pan offset in pixels. */
export interface ImageViewportState {
    kind: "image";
    zoom: number;
    panX: number;
    panY: number;
}

/** Plot viewer viewport: the visible data range on both axes. */
export interface PlotViewportState {
    kind: "plot";
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

/** Point cloud viewer viewport: orbit camera position and look-at target. */
export interface PointCloudViewportState {
    kind: "pointcloud";
    cameraPosition: [number, number, number];
    cameraTarget: [number, number, number];
}

/**
 * Viewport state reported by a viewer webview. The `kind` discriminator lets
 * the coordinator reject cross-kind states without knowing viewer internals.
 */
export type ViewportState =
    | ImageViewportState
    | PlotViewportState
    | PointCloudViewportState;

// ── Group snapshots ───────────────────────────────────────────────────────

/**
 * Immutable view of one sync group. Produced by the store, consumed by the
 * coordinator (to broadcast) and the TreeView (to render the ⇄N badge).
 */
export interface SyncGroupSnapshot {
    /** Stable, monotonically assigned display index (0-based). */
    groupIndex: number;
    kind: SyncKind;
    /** All member variable names, including the one that was queried. */
    members: string[];
    /** Last viewport state agreed by the group, or null before the first report. */
    state: ViewportState | null;
}

/** Why a join request was refused. */
export type SyncJoinRejection = "same-panel" | "kind-mismatch";

/** Outcome of `ISyncGroupStore.join()`. */
export type SyncJoinResult =
    | { ok: true; group: SyncGroupSnapshot }
    | { ok: false; reason: SyncJoinRejection };

/**
 * Outcome of `ISyncGroupStore.recordState()`.
 *
 * `targets` is empty when the reporter is not in a group, or when the report
 * was swallowed — a freshly opened panel must not overwrite an established
 * group state with its own default viewport.
 */
export interface SyncBroadcastPlan {
    targets: string[];
    /** Set when the report was intentionally dropped; used for DEBUG logging. */
    swallowedReason?: "not-in-group" | "first-report-after-join";
}

// ── Store contract ────────────────────────────────────────────────────────

/**
 * Pure membership state machine. Deliberately free of any `vscode` import so
 * it can be unit-tested without an extension host; logging is injected.
 */
export interface ISyncGroupStore {
    join(a: SyncMember, b: SyncMember): SyncJoinResult;
    leave(varName: string): SyncGroupSnapshot | null;
    getGroup(varName: string): SyncGroupSnapshot | null;
    getGroupIndex(varName: string): number | undefined;
    getMembers(varName: string): string[];
    listGroups(): SyncGroupSnapshot[];
    recordState(varName: string, state: ViewportState): SyncBroadcastPlan;
    markApplied(varName: string): void;
    clear(): void;
}

// ── Read-only view for UI consumers ───────────────────────────────────────

/**
 * The slice of the coordinator the TreeView needs. Read-only on purpose: a
 * view renders sync state, it never mutates it.
 */
export interface ISyncStateReader {
    /** Stable display index of the group `varName` belongs to, if any. */
    getGroupIndex(varName: string): number | undefined;

    /** Group members other than `varName`; empty when it is not synchronised. */
    getPartners(varName: string): string[];
}

// ── Panel host contract ───────────────────────────────────────────────────

/**
 * The slice of `PanelManager` the sync layer needs. Keeping this narrow means
 * `panelManager.ts` carries no sync-specific code — it only grows generic
 * "list panels / post a message / observe messages" capabilities.
 */
export interface ISyncPanelHost {
    /** Every currently open panel that belongs to a syncable viewer family. */
    listPanels(): PanelDescriptor[];

    /** Kind of an open panel, or undefined when no such panel exists. */
    getPanelKind(varName: string): SyncKind | undefined;

    /** Post a message to one panel. Returns false when the panel is gone. */
    post(varName: string, message: unknown): boolean;

    /** Subscribe to every message sent by every viewer webview. */
    registerMessageObserver(
        observer: (varName: string, message: unknown) => void
    ): vscode.Disposable;

    /** Subscribe to panel closure. */
    onDidDisposePanel(listener: (varName: string) => void): vscode.Disposable;
}
