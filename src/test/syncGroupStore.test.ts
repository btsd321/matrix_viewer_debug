/**
 * syncGroupStore.test.ts — Unit tests for the sync group state machine.
 *
 * SyncGroupStore has no `vscode` dependency, so these tests exercise it
 * directly with no debug session and no extension host state.
 */

import * as assert from "assert";
import { SyncGroupStore } from "../sync/syncGroupStore";
import { ImageViewportState, SyncMember } from "../sync/ISyncTypes";

// ── Fixtures ──────────────────────────────────────────────────────────────

const img = (name: string): SyncMember => ({ varName: name, kind: "image" });
const plot = (name: string): SyncMember => ({ varName: name, kind: "plot" });

const viewport = (zoom: number): ImageViewportState => ({
    kind: "image",
    zoom,
    panX: 0,
    panY: 0,
});

/** Members sorted, so assertions do not depend on Set insertion order. */
function members(store: SyncGroupStore, varName: string): string[] {
    return store.getMembers(varName).slice().sort();
}

// ── join ──────────────────────────────────────────────────────────────────

suite("SyncGroupStore.join", () => {
    test("two unpaired panels form a new group", () => {
        const store = new SyncGroupStore();
        const result = store.join(img("a"), img("b"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0);
        assert.strictEqual(result.group.kind, "image");
        assert.deepStrictEqual(result.group.members.slice().sort(), ["a", "b"]);
        assert.strictEqual(result.group.state, null);
    });

    test("joining a panel already in a group extends that group", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        const result = store.join(img("a"), img("c"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0, "group index must not change");
        assert.deepStrictEqual(members(store, "c"), ["a", "b", "c"]);
    });

    test("joining into an existing group from the outside also extends it", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        // "c" is the caller this time, "b" is the established member.
        const result = store.join(img("c"), img("b"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0);
        assert.deepStrictEqual(members(store, "c"), ["a", "b", "c"]);
    });

    test("merging two groups keeps the older group and its viewport", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));   // group 0
        store.join(img("c"), img("d"));   // group 1
        store.recordState("a", viewport(4));
        store.recordState("c", viewport(9));

        const result = store.join(img("b"), img("d"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0, "older group survives");
        assert.deepStrictEqual(result.group.members.slice().sort(), ["a", "b", "c", "d"]);
        assert.strictEqual((result.group.state as ImageViewportState).zoom, 4);
        assert.strictEqual(store.listGroups().length, 1);
    });

    test("merge picks the older group regardless of argument order", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));   // group 0
        store.join(img("c"), img("d"));   // group 1

        // Caller is in the newer group; the older one must still win.
        const result = store.join(img("d"), img("a"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0);
    });

    test("joining a panel to its own group is a no-op, not a duplicate", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        const result = store.join(img("a"), img("b"));

        assert.ok(result.ok);
        assert.strictEqual(store.listGroups().length, 1);
        assert.deepStrictEqual(members(store, "a"), ["a", "b"]);
    });

    test("a panel cannot sync with itself", () => {
        const store = new SyncGroupStore();
        const result = store.join(img("a"), img("a"));

        assert.ok(!result.ok);
        assert.strictEqual(result.reason, "same-panel");
        assert.strictEqual(store.listGroups().length, 0);
    });

    test("cross-kind joins are refused", () => {
        const store = new SyncGroupStore();
        const result = store.join(img("a"), plot("b"));

        assert.ok(!result.ok);
        assert.strictEqual(result.reason, "kind-mismatch");
        assert.strictEqual(store.getGroupIndex("a"), undefined);
        assert.strictEqual(store.getGroupIndex("b"), undefined);
    });

    test("group indices keep counting up and are never reused", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));   // 0
        store.leave("a");                 // dissolves group 0
        const result = store.join(img("c"), img("d"));

        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 1);
    });
});

// ── leave ─────────────────────────────────────────────────────────────────

suite("SyncGroupStore.leave", () => {
    test("leaving a two-member group dissolves it", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.leave("a");

        assert.strictEqual(store.getGroupIndex("a"), undefined);
        assert.strictEqual(store.getGroupIndex("b"), undefined, "lone survivor is released too");
        assert.strictEqual(store.listGroups().length, 0);
    });

    test("leaving a three-member group keeps the remaining two synced", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.join(img("a"), img("c"));
        const snapshot = store.leave("b");

        assert.ok(snapshot);
        assert.deepStrictEqual(snapshot.members.slice().sort(), ["a", "c"]);
        assert.strictEqual(store.getGroupIndex("b"), undefined);
        assert.strictEqual(store.getGroupIndex("a"), 0);
    });

    test("leaving when unsynced returns null", () => {
        const store = new SyncGroupStore();
        assert.strictEqual(store.leave("nobody"), null);
    });

    test("a dissolved group's viewport does not leak into the next group", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.recordState("a", viewport(7));
        store.leave("a");

        const result = store.join(img("a"), img("b"));
        assert.ok(result.ok);
        assert.strictEqual(result.group.state, null);
    });
});

// ── recordState ───────────────────────────────────────────────────────────

suite("SyncGroupStore.recordState", () => {
    test("reports from an unsynced panel go nowhere", () => {
        const store = new SyncGroupStore();
        const plan = store.recordState("lonely", viewport(2));

        assert.deepStrictEqual(plan.targets, []);
        assert.strictEqual(plan.swallowedReason, "not-in-group");
    });

    test("the first report defines the group viewport and reaches the others", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        const plan = store.recordState("a", viewport(3));

        assert.deepStrictEqual(plan.targets, ["b"]);
        assert.strictEqual(plan.swallowedReason, undefined);
        assert.strictEqual((store.getGroup("a")!.state as ImageViewportState).zoom, 3);
    });

    test("the source panel is never a broadcast target", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.join(img("a"), img("c"));
        const plan = store.recordState("b", viewport(3));

        assert.ok(!plan.targets.includes("b"));
        assert.deepStrictEqual(plan.targets.slice().sort(), ["a", "c"]);
    });

    test("a newly joined panel's first report is swallowed, its second is not", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.recordState("a", viewport(5));   // group viewport established

        store.join(img("a"), img("c"));        // "c" has not applied it yet

        const first = store.recordState("c", viewport(1));
        assert.deepStrictEqual(first.targets, [], "default viewport must not win");
        assert.strictEqual(first.swallowedReason, "first-report-after-join");
        assert.strictEqual(
            (store.getGroup("a")!.state as ImageViewportState).zoom,
            5,
            "group viewport survives the swallowed report"
        );

        const second = store.recordState("c", viewport(2));
        assert.deepStrictEqual(second.targets.slice().sort(), ["a", "b"]);
        assert.strictEqual((store.getGroup("a")!.state as ImageViewportState).zoom, 2);
    });

    test("markApplied lets a joined panel report immediately", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.recordState("a", viewport(5));
        store.join(img("a"), img("c"));

        store.markApplied("c");
        const plan = store.recordState("c", viewport(2));

        assert.deepStrictEqual(plan.targets.slice().sort(), ["a", "b"]);
    });

    test("markApplied on an unsynced panel is harmless", () => {
        const store = new SyncGroupStore();
        store.markApplied("ghost");
        assert.strictEqual(store.recordState("ghost", viewport(1)).swallowedReason, "not-in-group");
    });

    test("no swallowing when the group has no viewport yet", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.join(img("a"), img("c"));

        const plan = store.recordState("c", viewport(1));
        assert.deepStrictEqual(plan.targets.slice().sort(), ["a", "b"]);
    });
});

// ── clear ─────────────────────────────────────────────────────────────────

suite("SyncGroupStore.clear", () => {
    test("clear drops all groups and resets indices", () => {
        const store = new SyncGroupStore();
        store.join(img("a"), img("b"));
        store.join(img("c"), img("d"));
        store.recordState("a", viewport(3));

        store.clear();

        assert.strictEqual(store.listGroups().length, 0);
        assert.strictEqual(store.getGroupIndex("a"), undefined);

        const result = store.join(img("x"), img("y"));
        assert.ok(result.ok);
        assert.strictEqual(result.group.groupIndex, 0, "indices restart after clear");
    });
});

// ── logging ───────────────────────────────────────────────────────────────

suite("SyncGroupStore logging", () => {
    test("state transitions are reported through the injected LogFn", () => {
        const lines: string[] = [];
        const store = new SyncGroupStore((level, msg) => lines.push(`${level} ${msg}`));

        store.join(img("a"), img("b"));
        store.join(img("a"), plot("z"));
        store.leave("a");

        assert.ok(lines.length >= 3, `expected several log lines, got ${lines.length}`);
        assert.ok(lines.some((l) => l.includes("kind mismatch")));
        assert.ok(lines.some((l) => l.includes("dissolved")));
    });

    test("the default LogFn makes logging optional", () => {
        const store = new SyncGroupStore();
        assert.doesNotThrow(() => store.join(img("a"), img("b")));
    });
});
