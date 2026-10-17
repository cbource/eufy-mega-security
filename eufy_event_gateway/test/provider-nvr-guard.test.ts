/**
 * Verifies exact T8N00 guard-trial admission, fresh inventory confirmation, and
 * station lease ownership with synthetic cloud rows. No socket or alarm mode is
 * accessed by these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrGuardError } from "../src/provider/nvr-guard-trial.js";

for (const mode of ["valid", "controls-disabled", "wrong-model", "wrong-baseline", "schedule-changed"]) {
  test(`NVR guard provider: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "nvr-guard-provider-"));
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => id === "synthetic-owner");
    const child = { device_sn: "synthetic-camera", device_model: "T8E00", device_type: 301, device_channel: 3,
      parent_sn: "synthetic-station", category: "eufy_security", member: { admin_user_id: "synthetic-owner" } };
    let guard = mode === "wrong-baseline" ? 1 : 2, writes = 0;
    const parent = () => ({ device_sn: "synthetic-station", device_model: mode === "wrong-model" ? "T9000" : "T8N00",
      device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner", nick_name: "Synthetic" },
      params: [{ param_type: 1224, param_value: guard },
        { param_type: 1254, param_value: mode === "schedule-changed" && writes > 0 ? "changed" : "schedule-bytes" }] });
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [parent(), child] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-ie.eufylife.com",
      region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const prepare = context.mock.method(NvrRtcSession.prototype, "prepareGuardTrial", async () => undefined);
    const validate = context.mock.method(NvrRtcSession.prototype, "validateGuardTrial", async () => undefined);
    const effective = context.mock.method(NvrRtcSession.prototype, "confirmGuardEffectiveTrial", async () => undefined);
    context.mock.method(NvrRtcSession.prototype, "writeGuardTrial", async (value: 1 | 2, signal: AbortSignal,
      mark: () => void) => { signal.throwIfAborted(); mark(); writes++; guard = value; });
    const close = context.mock.method(NvrRtcSession.prototype, "close", async () => undefined);
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
      persistentDirectory: directory, maxStreamSeconds: 120, experimentalNvrControls: mode !== "controls-disabled",
      experimentalModelControls: true, experimentalNvrLive: true, normalNvrLive: true });
    const registry = new GatewayState();
    const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => registry.registerCamera(camera) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    try {
      await provider.start(events); context.mock.timers.enable({ apis: ["setTimeout"] });
      const operation = provider.testNvrGuardMode("synthetic-camera", { target: "home" }, new AbortController().signal);
      void operation.catch(() => undefined);
      for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(1_000);
      for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "valid") {
        const result = await operation; assert.equal(result.restored, true); assert.equal(result.scheduleUnchanged, true);
        assert.equal(guard, 2); assert.equal(writes, 2); assert.equal(prepare.mock.callCount(), 1);
        assert.ok(validate.mock.callCount() >= 2); assert.equal(effective.mock.callCount(), 2); assert.ok(close.mock.callCount() >= 1);
      } else await assert.rejects(operation, NvrGuardError);
    } finally {
      await provider.close(); context.mock.timers.tick(135_000);
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.reset(); await rm(directory, { recursive: true, force: true });
    }
  });
}
