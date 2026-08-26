/**
 * sync-controls.js — Shared "Sync ▾ / Unsync" toolbar control for all viewers.
 *
 * One module used by image-viewer.js, plot-viewer.js and pointcloud-viewer.js,
 * so the toolbar UI and the message protocol exist in exactly one place.
 *
 * Message names must stay in lockstep with src/sync/syncProtocol.ts.
 *
 * Usage from a viewer script:
 *
 *   const sync = window.MatrixViewerSync.create({
 *     vscode,                            // acquireVsCodeApi() handle
 *     kind: "image",                     // "image" | "plot" | "pointcloud"
 *     mount: document.getElementById("sync-controls"),
 *     getState: () => ({ kind: "image", zoom, panX, panY }),
 *     applyState: (s) => { zoom = s.zoom; ...; render(); },
 *   });
 *   sync.report();                       // after any local viewport change
 *
 * Note: webviews run in a separate process from the extension host, so the
 * extension's logger is unreachable here. Diagnostics for sync live on the
 * extension side (see SyncCoordinator); this file stays silent by design.
 */

(function () {
    "use strict";

    // ── Protocol (mirror of src/sync/syncProtocol.ts) ────────────────────────

    const IN_READY = "sync/ready";
    const IN_JOIN = "sync/join";
    const IN_LEAVE = "sync/leave";
    const IN_STATE = "sync/state";

    const OUT_PEERS = "sync/peers";
    const OUT_STATUS = "sync/status";
    const OUT_APPLY = "sync/apply";

    /** Placeholder value for the dropdown's own label row. */
    const PICK_NONE = "";

    /**
     * Create a sync controller for one viewer webview.
     *
     * @param {object}   opts
     * @param {object}   opts.vscode      Webview API handle.
     * @param {string}   opts.kind        Viewer family: image | plot | pointcloud.
     * @param {Element}  [opts.mount]     Container for the controls; omit or pass
     *                                    null to run headless (sidebar-only sync).
     * @param {Function} opts.getState    () => ViewportState for this viewer.
     * @param {Function} opts.applyState  (ViewportState) => void, applies a peer's viewport.
     * @returns {{report: Function, isSynced: Function, isApplyingRemote: Function}}
     */
    function create(opts) {
        const vscode = opts.vscode;
        const kind = opts.kind;
        const mount = opts.mount || null;
        const getState = opts.getState;
        const applyState = opts.applyState;

        /** Peers available to sync with, as sent by the extension. */
        let peers = [];

        /** Group members other than this panel. */
        let partners = [];

        /** 0-based group index, or undefined when unsynced. */
        let groupIndex;

        /**
         * True while a peer's viewport is being applied locally.
         *
         * Applying a remote state moves the local viewport, which fires the same
         * change handlers a user gesture would. Reporting those back would bounce
         * the state between panels forever, so reports are suppressed until the
         * viewer settles.
         */
        let applyingRemote = false;
        let applyingTimer = 0;

        /** Pending rAF handle, so a burst of gestures sends one message. */
        let reportFrame = 0;

        // ── DOM ──────────────────────────────────────────────────────────────

        let selectEl = null;
        let unsyncEl = null;
        let statusEl = null;

        if (mount) {
            buildControls();
        }

        function buildControls() {
            mount.classList.add("sync-controls");

            selectEl = document.createElement("select");
            selectEl.id = "sel-sync";
            selectEl.title = "Synchronise this viewport with another panel";
            selectEl.addEventListener("change", onPickPeer);

            unsyncEl = document.createElement("button");
            unsyncEl.id = "btn-unsync";
            unsyncEl.textContent = "Unsync";
            unsyncEl.title = "Stop synchronising this panel";
            unsyncEl.hidden = true;
            unsyncEl.addEventListener("click", function () {
                vscode.postMessage({ type: IN_LEAVE });
            });

            statusEl = document.createElement("span");
            statusEl.id = "sync-status";
            statusEl.className = "sync-status";

            mount.appendChild(selectEl);
            mount.appendChild(unsyncEl);
            mount.appendChild(statusEl);

            renderPeers();
            renderStatus();
        }

        function onPickPeer() {
            const target = selectEl.value;
            // Snap back to the label row: the dropdown is an action, not a state.
            selectEl.value = PICK_NONE;
            if (target) {
                vscode.postMessage({ type: IN_JOIN, target: target });
            }
        }

        function renderPeers() {
            if (!selectEl) {
                return;
            }
            selectEl.textContent = "";

            const label = document.createElement("option");
            label.value = PICK_NONE;
            label.textContent = "Sync ▾";
            selectEl.appendChild(label);

            for (const peer of peers) {
                const opt = document.createElement("option");
                opt.value = peer.varName;
                opt.textContent = peer.isMember
                    ? "✓ " + peer.varName
                    : peer.varName;
                selectEl.appendChild(opt);
            }

            const empty = peers.length === 0;
            selectEl.disabled = empty;
            selectEl.title = empty
                ? "Open another " + kind + " viewer to synchronise with"
                : "Synchronise this viewport with another panel";
            selectEl.value = PICK_NONE;
        }

        function renderStatus() {
            if (!statusEl) {
                return;
            }
            if (partners.length === 0) {
                statusEl.textContent = "";
                statusEl.title = "";
                if (unsyncEl) {
                    unsyncEl.hidden = true;
                }
                return;
            }
            const badge = groupIndex === undefined ? "" : "⇄" + (groupIndex + 1);
            statusEl.textContent = badge + " " + partners.join(", ");
            statusEl.title = "Synced with: " + partners.join(", ");
            if (unsyncEl) {
                unsyncEl.hidden = false;
            }
        }

        // ── Outbound ─────────────────────────────────────────────────────────

        /**
         * Report the current viewport to the rest of the group.
         *
         * Safe to call on every wheel tick or mouse-move: reports are coalesced
         * into one message per animation frame and dropped entirely while a
         * remote viewport is being applied.
         */
        function report() {
            if (applyingRemote || partners.length === 0) {
                return;
            }
            if (reportFrame) {
                return;
            }
            reportFrame = requestAnimationFrame(function () {
                reportFrame = 0;
                if (applyingRemote || partners.length === 0) {
                    return;
                }
                let state;
                try {
                    state = getState();
                } catch (e) {
                    return; // Viewer not ready yet (e.g. no data loaded).
                }
                if (state) {
                    vscode.postMessage({ type: IN_STATE, state: state });
                }
            });
        }

        // ── Inbound ──────────────────────────────────────────────────────────

        window.addEventListener("message", function (event) {
            const msg = event.data;
            if (!msg || typeof msg.type !== "string") {
                return;
            }
            switch (msg.type) {
                case OUT_PEERS:
                    peers = Array.isArray(msg.peers) ? msg.peers : [];
                    renderPeers();
                    break;

                case OUT_STATUS:
                    partners = Array.isArray(msg.partners) ? msg.partners : [];
                    groupIndex = msg.groupIndex;
                    renderStatus();
                    break;

                case OUT_APPLY:
                    if (msg.state && msg.state.kind === kind) {
                        applyRemote(msg.state);
                    }
                    break;
            }
        });

        function applyRemote(state) {
            applyingRemote = true;
            if (applyingTimer) {
                clearTimeout(applyingTimer);
            }
            try {
                applyState(state);
            } catch (e) {
                // Viewer not ready (no data yet, or a mode that cannot follow a
                // remote viewport). Drop the state rather than break the panel.
            } finally {
                // Change events raised by the apply may land asynchronously
                // (OrbitControls, canvas resize), so hold the flag briefly.
                applyingTimer = setTimeout(function () {
                    applyingTimer = 0;
                    applyingRemote = false;
                }, 80);
            }
        }

        // Ask for peers, status, and the group's current viewport.
        vscode.postMessage({ type: IN_READY, kind: kind });

        return {
            report: report,
            isSynced: function () {
                return partners.length > 0;
            },
            isApplyingRemote: function () {
                return applyingRemote;
            },
        };
    }

    window.MatrixViewerSync = { create: create };
})();
