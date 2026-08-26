/**
 * syncGroupStore.ts — Sync group membership state machine.
 *
 * Pure state: no `vscode` import, no DAP, no webview access. Logging is
 * injected as a `LogFn` so the whole class stays unit-testable outside an
 * extension host (see src/test/syncGroupStore.test.ts).
 *
 * Model — a sync *group* holds 1..N panels of the same kind:
 *
 *   join(a, b)   a alone + b alone   → new group {a, b}
 *                a in G   + b alone   → G ∪ {b}          (G's state wins)
 *                a alone  + b in G    → G ∪ {a}          (G's state wins)
 *                a in G1  + b in G2   → merge into the older group
 *   leave(x)     x removed; group dissolves once ≤ 1 member remains
 *
 * Group indices are assigned on creation and never reused, so the ⇄N badge in
 * the TreeView stays stable while a debug session runs.
 */

import { LogFn } from "../log/logger";
import {
    ISyncGroupStore,
    SyncBroadcastPlan,
    SyncGroupSnapshot,
    SyncJoinResult,
    SyncKind,
    SyncMember,
    ViewportState,
} from "./ISyncTypes";

interface SyncGroup {
    id: string;
    index: number;
    kind: SyncKind;
    members: Set<string>;
    state: ViewportState | null;
}

export class SyncGroupStore implements ISyncGroupStore {
    /** groupId → group record */
    private groups = new Map<string, SyncGroup>();

    /** varName → groupId */
    private memberToGroup = new Map<string, string>();

    /**
     * Members that have received (or authored) the group's current state.
     *
     * A panel that just joined a group with an established viewport has not
     * yet applied it. Its first spontaneous report still carries its own
     * default viewport, and accepting it would yank every other panel back to
     * 100% zoom — so the first report after joining is swallowed.
     */
    private appliedMembers = new Set<string>();

    private nextGroupIndex = 0;
    private nextGroupSerial = 0;

    constructor(private readonly log: LogFn = () => { }) { }

    // ── Membership ────────────────────────────────────────────────────────

    join(a: SyncMember, b: SyncMember): SyncJoinResult {
        if (a.varName === b.varName) {
            this.log("DEBUG", `[SyncGroupStore] join rejected: "${a.varName}" is the same panel`);
            return { ok: false, reason: "same-panel" };
        }
        if (a.kind !== b.kind) {
            this.log(
                "DEBUG",
                `[SyncGroupStore] join rejected: kind mismatch "${a.varName}"=${a.kind} vs "${b.varName}"=${b.kind}`
            );
            return { ok: false, reason: "kind-mismatch" };
        }

        const groupA = this.groupOf(a.varName);
        const groupB = this.groupOf(b.varName);

        let target: SyncGroup;
        if (groupA && groupB) {
            // Merge the newer group into the older one so the longer-established
            // viewport survives.
            const [keep, drop] = groupA.index <= groupB.index ? [groupA, groupB] : [groupB, groupA];
            if (keep.id === drop.id) {
                target = keep;
                this.log("DEBUG", `[SyncGroupStore] join no-op: both already in group ${keep.index}`);
            } else {
                this.mergeGroups(drop, keep);
                target = keep;
            }
        } else if (groupA) {
            this.addMember(groupA, b.varName);
            target = groupA;
        } else if (groupB) {
            this.addMember(groupB, a.varName);
            target = groupB;
        } else {
            target = this.createGroup(a.kind);
            this.addMember(target, a.varName);
            this.addMember(target, b.varName);
        }

        this.log(
            "DEBUG",
            `[SyncGroupStore] group ${target.index} (${target.kind}) members: ${[...target.members].join(", ")}`
        );
        return { ok: true, group: this.snapshot(target) };
    }

    leave(varName: string): SyncGroupSnapshot | null {
        const group = this.groupOf(varName);
        if (!group) {
            this.log("DEBUG", `[SyncGroupStore] leave no-op: "${varName}" is not in a group`);
            return null;
        }

        group.members.delete(varName);
        this.memberToGroup.delete(varName);
        this.appliedMembers.delete(varName);

        if (group.members.size <= 1) {
            // A one-member group is not a sync group; dissolve it entirely.
            for (const remaining of group.members) {
                this.memberToGroup.delete(remaining);
                this.appliedMembers.delete(remaining);
            }
            const dissolved = this.snapshot(group);
            this.groups.delete(group.id);
            this.log(
                "DEBUG",
                `[SyncGroupStore] group ${group.index} dissolved after "${varName}" left`
            );
            return dissolved;
        }

        this.log(
            "DEBUG",
            `[SyncGroupStore] "${varName}" left group ${group.index}; remaining: ${[...group.members].join(", ")}`
        );
        return this.snapshot(group);
    }

    // ── Queries ───────────────────────────────────────────────────────────

    getGroup(varName: string): SyncGroupSnapshot | null {
        const group = this.groupOf(varName);
        return group ? this.snapshot(group) : null;
    }

    getGroupIndex(varName: string): number | undefined {
        return this.groupOf(varName)?.index;
    }

    getMembers(varName: string): string[] {
        const group = this.groupOf(varName);
        return group ? [...group.members] : [];
    }

    listGroups(): SyncGroupSnapshot[] {
        return [...this.groups.values()]
            .sort((x, y) => x.index - y.index)
            .map((g) => this.snapshot(g));
    }

    // ── Viewport state ────────────────────────────────────────────────────

    recordState(varName: string, state: ViewportState): SyncBroadcastPlan {
        const group = this.groupOf(varName);
        if (!group) {
            return { targets: [], swallowedReason: "not-in-group" };
        }

        if (group.state && !this.appliedMembers.has(varName)) {
            // Freshly joined panel reporting its own default viewport — ignore
            // it once, but mark it applied so its next (user-driven) report
            // does propagate.
            this.appliedMembers.add(varName);
            this.log(
                "DEBUG",
                `[SyncGroupStore] swallowed first report from "${varName}" in group ${group.index}`
            );
            return { targets: [], swallowedReason: "first-report-after-join" };
        }

        group.state = state;
        this.appliedMembers.add(varName);
        const targets = [...group.members].filter((m) => m !== varName);
        for (const t of targets) {
            this.appliedMembers.add(t);
        }
        return { targets };
    }

    markApplied(varName: string): void {
        if (this.memberToGroup.has(varName)) {
            this.appliedMembers.add(varName);
        }
    }

    clear(): void {
        const groupCount = this.groups.size;
        this.groups.clear();
        this.memberToGroup.clear();
        this.appliedMembers.clear();
        this.nextGroupIndex = 0;
        this.nextGroupSerial = 0;
        if (groupCount > 0) {
            this.log("DEBUG", `[SyncGroupStore] cleared ${groupCount} group(s)`);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────

    private groupOf(varName: string): SyncGroup | undefined {
        const id = this.memberToGroup.get(varName);
        return id ? this.groups.get(id) : undefined;
    }

    private createGroup(kind: SyncKind): SyncGroup {
        const group: SyncGroup = {
            id: `sync-${this.nextGroupSerial++}`,
            index: this.nextGroupIndex++,
            kind,
            members: new Set<string>(),
            state: null,
        };
        this.groups.set(group.id, group);
        return group;
    }

    private addMember(group: SyncGroup, varName: string): void {
        group.members.add(varName);
        this.memberToGroup.set(varName, group.id);
        if (!group.state) {
            // No established viewport yet — whoever reports first defines it.
            this.appliedMembers.add(varName);
        } else {
            this.appliedMembers.delete(varName);
        }
    }

    private mergeGroups(source: SyncGroup, target: SyncGroup): void {
        const moved = [...source.members];
        for (const varName of moved) {
            this.addMember(target, varName);
        }
        this.groups.delete(source.id);
        this.log(
            "DEBUG",
            `[SyncGroupStore] merged group ${source.index} into ${target.index} (moved: ${moved.join(", ")})`
        );
    }

    private snapshot(group: SyncGroup): SyncGroupSnapshot {
        return {
            groupIndex: group.index,
            kind: group.kind,
            members: [...group.members],
            state: group.state,
        };
    }
}
