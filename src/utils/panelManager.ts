/**
 * panelManager.ts — Webview panel lifecycle management.
 *
 * - Ensures at most one panel per variable name (deduplication).
 * - Provides typed open methods for each viewer type.
 * - Forwards refresh requests to all open panels.
 * - Implements ISyncPanelHost so the sync module can observe panel messages
 *   and post to panels without knowing how they are created or stored.
 *
 * This class knows nothing about sync semantics: it only relays messages.
 */

import * as vscode from "vscode";
import { ImageData, PlotData, PointCloudData } from "../viewers/viewerTypes";
import { buildImageWebviewHtml } from "../matImage/matWebview";
import { buildPlotWebviewHtml } from "../plot/plotWebview";
import { buildPointCloudWebviewHtml } from "../pointCloud/pointCloudWebview";
import { getAdapter } from "../adapters/adapterRegistry";
import { logger } from "../log/logger";
import { compressImageData } from "./compressionUtils";
import { ISyncPanelHost, PanelDescriptor, SyncKind } from "../sync/ISyncTypes";

type PanelKind = SyncKind;

interface PanelEntry {
    panel: vscode.WebviewPanel;
    kind: PanelKind;
    varName: string;
}

export class PanelManager implements ISyncPanelHost {
    private panels = new Map<string, PanelEntry>();

    /** Message observers, notified for every message from every panel. */
    private messageObservers = new Set<(varName: string, message: unknown) => void>();

    private readonly disposeEmitter = new vscode.EventEmitter<string>();

    constructor(private readonly context: vscode.ExtensionContext) { }

    // ── Query ────────────────────────────────────────────────────────────────

    hasPanel(varName: string): boolean {
        return this.panels.has(varName);
    }

    focusPanel(varName: string): void {
        this.panels.get(varName)?.panel.reveal();
    }

    getPanel(varName: string): vscode.WebviewPanel | undefined {
        return this.panels.get(varName)?.panel;
    }

    // ── Open Panels ──────────────────────────────────────────────────────────

    openImagePanel(
        varName: string,
        data: ImageData,
        context: vscode.ExtensionContext
    ): void {
        const compressed = compressImageData(data);
        this.openPanel("image", varName, context, (webview) => {
            webview.html = buildImageWebviewHtml(varName, compressed, webview, context);
        });
    }

    openPlotPanel(
        varName: string,
        data: PlotData,
        context: vscode.ExtensionContext
    ): void {
        this.openPanel("plot", varName, context, (webview) => {
            webview.html = buildPlotWebviewHtml(varName, data, webview, context);
        });
    }

    openPointCloudPanel(
        varName: string,
        data: PointCloudData,
        context: vscode.ExtensionContext
    ): void {
        this.openPanel("pointcloud", varName, context, (webview) => {
            webview.html = buildPointCloudWebviewHtml(
                varName,
                data,
                webview,
                context
            );
        });
    }

    // ── ISyncPanelHost ───────────────────────────────────────────────────────

    listPanels(): PanelDescriptor[] {
        return [...this.panels.values()].map((e) => ({
            varName: e.varName,
            kind: e.kind,
        }));
    }

    getPanelKind(varName: string): SyncKind | undefined {
        return this.panels.get(varName)?.kind;
    }

    /** Returns false when the panel is gone, so callers can prune state. */
    post(varName: string, message: unknown): boolean {
        const entry = this.panels.get(varName);
        if (!entry) {
            logger.debug(`[PanelManager] post skipped, no panel for "${varName}"`);
            return false;
        }
        try {
            void entry.panel.webview.postMessage(message);
            return true;
        } catch (e) {
            // Accessing .webview throws once the panel is disposed, which can
            // happen before onDidDispose has been delivered.
            logger.debug(`[PanelManager] post failed for "${varName}": ${e}`);
            return false;
        }
    }

    registerMessageObserver(
        observer: (varName: string, message: unknown) => void
    ): vscode.Disposable {
        this.messageObservers.add(observer);
        logger.debug(
            `[PanelManager] message observer registered (${this.messageObservers.size} total)`
        );
        return new vscode.Disposable(() => {
            this.messageObservers.delete(observer);
        });
    }

    onDidDisposePanel(listener: (varName: string) => void): vscode.Disposable {
        return this.disposeEmitter.event(listener);
    }

    // ── Refresh ──────────────────────────────────────────────────────────────

    /**
     * Re-fetch data for every open panel from the current debug session
     * and post an update message to each webview.
     */
    async refreshAll(session: vscode.DebugSession): Promise<void> {
        const entries = [...this.panels.values()];
        await Promise.all(entries.map((e) => this.refreshEntry(e, session)));
    }

    private async refreshEntry(
        entry: PanelEntry,
        session: vscode.DebugSession
    ): Promise<void> {
        try {
            const adapter = getAdapter(session);
            if (!adapter) {
                return;
            }

            const info = await adapter.getVariableInfo(session, entry.varName);
            if (!info) {
                return;
            }

            switch (entry.kind) {
                case "image": {
                    const data = await adapter.fetchImageData(session, entry.varName, info);
                    if (data) {
                        entry.panel.webview.postMessage({ type: "update", data: compressImageData(data) });
                    }
                    break;
                }
                case "plot": {
                    const data = await adapter.fetchPlotData(session, entry.varName, info);
                    if (data) {
                        entry.panel.webview.postMessage({ type: "update", data });
                    }
                    break;
                }
                case "pointcloud": {
                    const data = await adapter.fetchPointCloudData(session, entry.varName, info);
                    if (data) {
                        entry.panel.webview.postMessage({ type: "update", data });
                    }
                    break;
                }
            }
        } catch (e) {
            // Variable may no longer be in scope after a step
            logger.debug(`[PanelManager] refreshEntry skipped "${entry.varName}": ${e}`);
        }
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    dispose(): void {
        for (const entry of this.panels.values()) {
            entry.panel.dispose();
        }
        this.panels.clear();
        this.messageObservers.clear();
        this.disposeEmitter.dispose();
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    private openPanel(
        kind: PanelKind,
        varName: string,
        context: vscode.ExtensionContext,
        populate: (webview: vscode.Webview) => void
    ): void {
        const existing = this.panels.get(varName);
        if (existing) {
            existing.panel.reveal();
            return;
        }

        const title = `${varName} [${kind}]`;
        const panel = vscode.window.createWebviewPanel(
            `matrixViewer.${kind}`,
            title,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, "media"),
                ],
            }
        );

        populate(panel.webview);

        const entry: PanelEntry = { panel, kind, varName };
        this.panels.set(varName, entry);

        // Registered exactly once per panel, at creation. Reopening an existing
        // panel short-circuits above, so listeners never stack up.
        panel.webview.onDidReceiveMessage((msg) => {
            for (const observer of this.messageObservers) {
                try {
                    observer(varName, msg);
                } catch (e) {
                    logger.error(`[PanelManager] message observer threw for "${varName}": ${e}`);
                }
            }
        });

        panel.onDidDispose(() => {
            this.panels.delete(varName);
            logger.debug(`[PanelManager] panel disposed: "${varName}"`);
            this.disposeEmitter.fire(varName);
        });

        logger.info(`[PanelManager] opened ${kind} panel for "${varName}"`);
    }
}
