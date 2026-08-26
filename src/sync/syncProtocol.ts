/**
 * syncProtocol.ts — Message contract between viewer webviews and the extension.
 *
 * Every string constant here has an exact counterpart in
 * `media/sync-controls.js`. Changing one side without the other silently
 * breaks synchronisation, so keep the two in lockstep.
 *
 * Direction of each message is encoded in its name:
 *   SYNC_IN_*   webview  → extension
 *   SYNC_OUT_*  extension → webview
 */

import { PanelDescriptor, SyncKind, ViewportState } from "./ISyncTypes";

// ── Message type tags ─────────────────────────────────────────────────────

/** Webview script finished booting and wants its peer list + group state. */
export const SYNC_IN_READY = "sync/ready";

/** User picked a target panel from the Sync dropdown. */
export const SYNC_IN_JOIN = "sync/join";

/** User clicked Unsync. */
export const SYNC_IN_LEAVE = "sync/leave";

/** Viewport changed locally; forward to the rest of the group. */
export const SYNC_IN_STATE = "sync/state";

/** Peer panels available to sync with (same kind, currently open). */
export const SYNC_OUT_PEERS = "sync/peers";

/** Current membership, used to drive button visibility and the group label. */
export const SYNC_OUT_STATUS = "sync/status";

/** Apply a viewport state produced by another panel in the group. */
export const SYNC_OUT_APPLY = "sync/apply";

// ── Inbound payloads (webview → extension) ────────────────────────────────

export interface SyncReadyMessage {
    type: typeof SYNC_IN_READY;
    kind: SyncKind;
}

export interface SyncJoinMessage {
    type: typeof SYNC_IN_JOIN;
    /** varName of the panel to synchronise with. */
    target: string;
}

export interface SyncLeaveMessage {
    type: typeof SYNC_IN_LEAVE;
}

export interface SyncStateMessage {
    type: typeof SYNC_IN_STATE;
    state: ViewportState;
}

export type SyncInboundMessage =
    | SyncReadyMessage
    | SyncJoinMessage
    | SyncLeaveMessage
    | SyncStateMessage;

// ── Outbound payloads (extension → webview) ───────────────────────────────

export interface SyncPeerEntry extends PanelDescriptor {
    /** True when this peer is already in the recipient's group. */
    isMember: boolean;
}

export interface SyncPeersMessage {
    type: typeof SYNC_OUT_PEERS;
    peers: SyncPeerEntry[];
}

export interface SyncStatusMessage {
    type: typeof SYNC_OUT_STATUS;
    /** undefined when the panel is not synchronised with anything. */
    groupIndex?: number;
    /** Other members of the group (excludes the recipient). */
    partners: string[];
}

export interface SyncApplyMessage {
    type: typeof SYNC_OUT_APPLY;
    state: ViewportState;
}

export type SyncOutboundMessage =
    | SyncPeersMessage
    | SyncStatusMessage
    | SyncApplyMessage;

// ── Type guards ───────────────────────────────────────────────────────────

const INBOUND_TYPES: ReadonlySet<string> = new Set([
    SYNC_IN_READY,
    SYNC_IN_JOIN,
    SYNC_IN_LEAVE,
    SYNC_IN_STATE,
]);

/** True when `msg` is a well-formed sync message from a viewer webview. */
export function isSyncInboundMessage(msg: unknown): msg is SyncInboundMessage {
    if (typeof msg !== "object" || msg === null) {
        return false;
    }
    const type = (msg as { type?: unknown }).type;
    return typeof type === "string" && INBOUND_TYPES.has(type);
}

/** True when `state` carries a recognised viewport discriminator. */
export function isViewportState(state: unknown): state is ViewportState {
    if (typeof state !== "object" || state === null) {
        return false;
    }
    const kind = (state as { kind?: unknown }).kind;
    return kind === "image" || kind === "plot" || kind === "pointcloud";
}

/** Short one-line summary of a viewport state, for DEBUG logs. */
export function describeViewportState(state: ViewportState): string {
    switch (state.kind) {
        case "image":
            return `image zoom=${state.zoom.toFixed(3)} pan=(${Math.round(state.panX)},${Math.round(state.panY)})`;
        case "plot":
            return `plot x=[${state.xMin.toPrecision(4)},${state.xMax.toPrecision(4)}] y=[${state.yMin.toPrecision(4)},${state.yMax.toPrecision(4)}]`;
        case "pointcloud":
            return `pointcloud pos=(${state.cameraPosition.map((v) => v.toFixed(2)).join(",")}) target=(${state.cameraTarget.map((v) => v.toFixed(2)).join(",")})`;
    }
}
