/**
 * Exercises Schedule-to-Home recovery using a synthetic private inventory.
 * The fixture owns modes, schedule bytes, clocks, and write outcomes. No cloud,
 * station, or physical alarm is contacted by these tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NvrGuardError, runNvrGuardTrial, type NvrGuardTransport } from "../src/provider/nvr-guard-trial.js";
import { nvrGuardModeCommand } from "../src/stream/nvr-protocol.js";

function fixture(mode: string) {
  let guard = 2, schedule = "schedule-bytes", now = 0, recovering = false, restoreAttempts = 0, closed = 0;
  const writes: number[] = [];
  const caller = new AbortController();
  const transport: NvrGuardTransport = {
    prepare: async () => undefined,
    validate: async recovery => { recovering = recovery; },
    read: async () => {
      if (!writes.length && mode === "wrong-baseline") return { mode: 1, schedule };
      if (!writes.length && mode === "missing-schedule") return { mode: 2, schedule: null };
      if (writes.length > 0 && !recovering && mode === "unknown-target") return { mode: null, schedule };
      if (recovering && mode === "schedule-changed") return { mode: guard, schedule: "changed" };
      return { mode: guard, schedule };
    },
    write: async (value, signal, mark) => {
      signal.throwIfAborted(); mark(); writes.push(value);
      if (recovering) {
        restoreAttempts++;
        if (mode === "retry-restore" && restoreAttempts === 1) return;
      }
      guard = value;
      if (!recovering && mode === "receipt") throw new NvrGuardError("receipt");
      if (!recovering && mode === "cancel") caller.abort();
    },
    effective: async value => {
      if (!recovering && mode === "missing-effective" || recovering && mode === "missing-restore-effective") {
        throw new NvrGuardError("readback");
      }
      assert.equal(value, recovering ? 2 : 1);
    },
    close: async () => { closed++; },
  };
  return { caller, transport, writes, state: () => ({ guard, schedule, closed, restoreAttempts }),
    runtime: { now: () => now, sleep: async (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted(); now += milliseconds;
    } } };
}

for (const mode of ["valid", "receipt", "cancel", "unknown-target", "missing-effective", "retry-restore"]) {
  test(`NVR guard trial restores Schedule: ${mode}`, async () => {
    const value = fixture(mode);
    const result = await runNvrGuardTrial(value.transport, { target: "home" }, value.caller.signal, value.runtime);
    assert.equal(result.restored, true); assert.equal(result.scheduleUnchanged, true);
    assert.equal(result.physicalConfirmationRequired, true); assert.equal(value.state().guard, 2);
    assert.deepEqual(value.writes, [1, 2, ...(mode === "retry-restore" ? [2] : [])]);
    assert.equal(value.state().closed, 1);
  });
}

for (const mode of ["wrong-baseline", "missing-schedule", "schedule-changed", "missing-restore-effective"]) {
  test(`NVR guard trial fails closed: ${mode}`, async () => {
    const value = fixture(mode);
    await assert.rejects(runNvrGuardTrial(value.transport, { target: "home" }, value.caller.signal, value.runtime), error => {
      assert.ok(error instanceof NvrGuardError);
      assert.equal(error.manualRestoreRequired, ["schedule-changed", "missing-restore-effective"].includes(mode));
      return true;
    });
    assert.equal(value.state().closed, 1);
  });
}

test("NVR guard trial rejects every target except Home", async () => {
  const value = fixture("valid");
  await assert.rejects(runNvrGuardTrial(value.transport, { target: "away" } as never,
    value.caller.signal, value.runtime), /admission/);
  assert.deepEqual(value.writes, []);
});

test("closed guard builder emits only the source-confirmed command shape", () => {
  const frame = nvrGuardModeCommand("synthetic-owner", "Synthetic", 7, 1);
  assert.equal(frame.subarray(0, 4).toString(), "XZYH"); assert.equal(frame.readUInt16LE(4), 1350);
  assert.equal(frame.readUInt32LE(6), frame.length - 16); assert.equal(frame[11], 7); assert.equal(frame[12], 255);
  assert.deepEqual(JSON.parse(frame.subarray(16).toString()), { account_id: "synthetic-owner", cmd: 1224, mValue3: 0,
    payload: { mode_type: 1, user_name: "Synthetic" } });
  for (const [segment, value] of [[0, 1], [255, 1], [7, 0], [7, 3]]) {
    assert.throws(() => nvrGuardModeCommand("synthetic-owner", "Synthetic", segment!, value as 1 | 2));
  }
});
