/**
 * uninitializedDetector.test.ts — Unit tests for the C++ uninitialized-variable
 * detector.
 *
 * No VS Code dependencies; the module under test is a pure function.
 */

import * as assert from "assert";
import { isUninitializedOrInvalid } from "../adapters/cpp/shared/uninitializedDetector";

suite("isUninitializedOrInvalid", () => {
    // ── Normal values → false ──────────────────────────────────────────────

    test("normal pointer value → false", () => {
        assert.strictEqual(isUninitializedOrInvalid("0x7ffeefbff5e0"), false);
    });

    test("normal integer value → false", () => {
        assert.strictEqual(isUninitializedOrInvalid("42"), false);
    });

    test("normal float value → false", () => {
        assert.strictEqual(isUninitializedOrInvalid("3.140000"), false);
    });

    test("empty string → false", () => {
        assert.strictEqual(isUninitializedOrInvalid(""), false);
    });

    test("null / undefined → false", () => {
        assert.strictEqual(isUninitializedOrInvalid(null), false);
        assert.strictEqual(isUninitializedOrInvalid(undefined), false);
    });

    test("zero pointer → false (null is handled elsewhere, not 'uninitialized')", () => {
        assert.strictEqual(isUninitializedOrInvalid("0x0"), false);
    });

    // ── Debugger sentinel strings → true ──────────────────────────────────

    test("LLDB <uninitialized> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<uninitialized>"), true);
    });

    test("LLDB <invalid> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<invalid>"), true);
    });

    test("LLDB <unavailable> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<unavailable>"), true);
    });

    test("GDB <optimized out> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<optimized out>"), true);
    });

    test("GDB <value optimized out> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<value optimized out>"), true);
    });

    test("GDB <not available> → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("<not available>"), true);
    });

    test("sentinel embedded in longer value → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("ptr = <optimized out>"), true);
    });

    // ── MSVC debug-heap patterns → true ─────────────────────────────────────

    test("0xCCCCCCCC (uninit stack) → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xCCCCCCCC"), true);
    });

    test("0xCDCDCDCD (uninit heap) → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xCDCDCDCD"), true);
    });

    test("0xFEEEFEEE (freed heap) → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xFEEEFEEE"), true);
    });

    test("0xBAADF00D (kernel uninit) → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xBAADF00D"), true);
    });

    test("0xDEADBEEF (debug sentinel) → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xDEADBEEF"), true);
    });

    test("MSVC pattern zero-extended to 64-bit → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0x00000000cccccccc"), true);
    });

    test("MSVC pattern sign-extended to 64-bit → true", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xcccccccccccccccc"), true);
    });

    // ── Repeated fill patterns → true ──────────────────────────────────────

    test("0xDDDDDDDD → true (repeated fill)", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xDDDDDDDD"), true);
    });

    test("0xEEEEEEEE → true (repeated fill)", () => {
        assert.strictEqual(isUninitializedOrInvalid("0xEEEEEEEE"), true);
    });

    // ── Whitespace trimming ────────────────────────────────────────────────

    test("leading/trailing whitespace is trimmed", () => {
        assert.strictEqual(isUninitializedOrInvalid("  <optimized out>  "), true);
    });
});
