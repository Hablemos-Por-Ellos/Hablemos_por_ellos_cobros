// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./run-monthly-charges.mjs";

const local = { APP_OPERATION_MODE: "active", FINANCIAL_OPERATIONS_ENABLED: "true",
  SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-local-key",
  WOMPI_ENV: "sandbox", WOMPI_PRIVATE_KEY_SANDBOX: "prv_test_fixture",
  NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX: "pub_test_fixture", WOMPI_INTEGRITY_SECRET_SANDBOX: "test_integrity_fixture" };
const silent = () => ({ log: vi.fn(), error: vi.fn() });
const readyClient = () => vi.fn(() => ({ rpc: vi.fn().mockResolvedValue({ data: true, error: null }) }));
const emptyReceipts = () => vi.fn().mockResolvedValue({ received: 0, processed: 0, review: 0, failed: 0 });
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => ({ data }) });
const verified = { id: "tx-fixture", status: "APPROVED", reference: "fixture-ref", amount_in_cents: 150000,
  currency: "COP", payment_source_id: "source-fixture", finalized_at: "2026-10-03T12:00:00.000Z" };

describe("monthly CLI runtime", () => {
  it.each([[], ["--mode=unknown"]])("rejects missing/unknown mode before creating a client %j", async (argv) => {
    const clientFactory = vi.fn();
    const fetchImpl = vi.fn();
    await expect(main({ argv, env: local, clientFactory, fetchImpl })).rejects.toThrow("BILLING_JOB_MODE_REQUIRED");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { ...local, VERCEL_ENV: "preview", SUPABASE_URL: "https://fixture.supabase.co" },
    { ...local, CI: "true", WOMPI_ENV: "prod" },
    { ...local, APP_OPERATION_MODE: "demo" },
    { ...local, APP_OPERATION_MODE: "cutover" },
    { ...local, FINANCIAL_OPERATIONS_ENABLED: "false" },
    { ...local, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/dev" },
    { ...local, GITHUB_ACTIONS: "true", GITHUB_REF: undefined },
  ])("rejects unsafe operations before client construction", async (env) => {
    const clientFactory = vi.fn();
    await expect(main({ argv: ["--mode=charge"], env, clientFactory })).rejects.toThrow();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("inventory needs no Wompi configuration and has no Wompi functions", async () => {
    const fetchImpl = vi.fn();
    const supabase = { rpc: vi.fn() };
    const reconcileReceipts = vi.fn().mockRejectedValue(new Error("inventory must never invoke receipts"));
    const runner = vi.fn(async ({ mode, getTransaction, createTransaction }) => {
      expect(mode).toBe("inventory");
      expect(getTransaction).toBeUndefined();
      expect(createTransaction).toBeUndefined();
      return { mode, noIds: 2, blocked: 2 };
    });
    await main({ argv: ["--mode=inventory"], env: { SUPABASE_URL: local.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: "fixture" }, clientFactory: () => supabase,
      reconcileReceipts, fetchImpl, runner, logger: silent() });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(reconcileReceipts).not.toHaveBeenCalled();
  });

  it("reconcile uses only GET transactions and never loads acceptance credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(verified));
    await main({ argv: ["--mode=reconcile"], env: { ...local, APP_OPERATION_MODE: "cutover",
      NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX: undefined, WOMPI_INTEGRITY_SECRET_SANDBOX: undefined },
    clientFactory: readyClient(), reconcileReceipts: emptyReceipts(), fetchImpl,
    logger: silent(), runner: async ({ getTransaction, createTransaction }) => {
      expect(createTransaction).toBeUndefined();
      const tx = await getTransaction({ transactionId: "tx-fixture" });
      expect(tx.finalizedAt).toBe(verified.finalized_at);
      return { reconciled: 1 };
    } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://sandbox.wompi.co/v1/transactions/tx-fixture");
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
  });

  it.each([[0, "read_only_observation"], [2, "legacy_incomplete"]])(
    "inventory reports schema coverage without claiming readiness (%i)", async (schemaUnknown, inventoryStatus) => {
      const logger = silent();
      const fetchImpl = vi.fn();
      const supabase = { rpc: vi.fn() };
      await main({ argv: ["--mode=inventory"], env: local, logger, fetchImpl,
        clientFactory: () => supabase, runner: async () => ({ schemaUnknown, charged: 0 }) });
      const summary = JSON.parse(logger.log.mock.calls.at(-1)[0].replace("Monthly billing complete ", ""));
      expect(summary).toMatchObject({ mode: "inventory", inventoryStatus, schemaUnknown, charged: 0 });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

  it("keeps merchants/info acceptance and personal authorization tokens independent", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({
      presigned_acceptance: { acceptance_token: "fixture-acceptance" },
      presigned_personal_data_auth: { acceptance_token: "fixture-personal" },
    })).mockResolvedValueOnce(response({ id: verified.id, status: "PENDING" }))
      .mockResolvedValueOnce(response(verified));
    const onSending = vi.fn();
    const onDispatched = vi.fn();
    await main({ argv: ["--mode=charge"], env: local, clientFactory: readyClient(),
      reconcileReceipts: emptyReceipts(), fetchImpl, logger: silent(),
      runner: async ({ createTransaction }) => {
        await createTransaction({ reference: verified.reference, amountInCents: verified.amount_in_cents,
          currency: "COP", customerEmail: "fixture@example.test", paymentSourceId: "source-fixture",
          onSending, onDispatched });
        return { charged: 1 };
      } });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://sandbox.wompi.co/v1/merchants/info");
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "x-merchant-public-key": "pub_test_fixture" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      acceptance_token: "fixture-acceptance", accept_personal_auth: "fixture-personal", recurrent: true });
    expect(onSending).toHaveBeenCalledOnce();
    expect(onDispatched).toHaveBeenCalledWith({ id: verified.id, status: "pending" });
  });

  it("only pre-POST acceptance failure is retryable and never exposes its message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("opaque-fixture-secret"));
    await main({ argv: ["--mode=charge"], env: local, clientFactory: readyClient(),
      reconcileReceipts: emptyReceipts(), fetchImpl, logger: silent(),
      runner: async ({ createTransaction }) => {
        await expect(createTransaction({})).rejects.toMatchObject({ message: "PRE_DISPATCH_FAILURE", safeToRetry: true });
        return {};
      } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("operational failures yield a fixed error and keep the summary free of arbitrary text", async () => {
    const logger = silent();
    await expect(main({ argv: ["--mode=inventory"], env: local, clientFactory: vi.fn(), logger,
      runner: async () => ({ failed: 1, message: "fixture-secret", mode: "fixture-secret" }) }))
      .rejects.toThrow("BILLING_JOB_OPERATIONAL_FAILURE");
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("fixture-secret");
    expect(logger.log.mock.calls.at(-1)[0]).toContain('"inventoryStatus":"operational_failure"');
  });

  it("direct missing mode exits nonzero with a sanitized code without loading env files", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run-monthly-charges.mjs", import.meta.url))], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("code=BILLING_JOB_MODE_REQUIRED");
    expect(result.stderr).not.toContain("Error:");
  });
});

describe("durable receipts before monthly processing", () => {
  it("runs schema readiness, receipts and the charge runner in that order", async () => {
    const order = [];
    const supabase = { rpc: vi.fn(async (name) => {
      order.push(name);
      return { data: true, error: null };
    }) };
    const reconcileReceipts = vi.fn(async ({ supabase: client, getTransaction, logger }) => {
      expect(client).toBe(supabase);
      expect(typeof getTransaction).toBe("function");
      expect(typeof logger.error).toBe("function");
      order.push("receipts");
      return { received: 2, processed: 2, review: 0, failed: 0 };
    });
    const runner = vi.fn(async ({ mode, createTransaction }) => {
      order.push("runner");
      expect(mode).toBe("charge");
      expect(typeof createTransaction).toBe("function");
      return { due: 1, blocked: 0 };
    });
    const fetchImpl = vi.fn();
    const stats = await main({ argv: ["--mode=charge"], env: local, clientFactory: () => supabase,
      fetchImpl, reconcileReceipts, runner, logger: silent() });
    expect(order).toEqual(["payment_admin_schema_ready", "receipts", "runner"]);
    expect(stats).toMatchObject({ mode: "charge", runnerMode: "charge", chargesBlockedByReceipts: false,
      receipts: { received: 2, processed: 2, review: 0, failed: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, null, undefined, "true", 1, {}])("never invokes receipts or runner without boolean readiness %j", async (data) => {
    const reconcileReceipts = emptyReceipts();
    const runner = vi.fn();
    const supabase = { rpc: vi.fn().mockResolvedValue({ data, error: null }) };
    await expect(main({ argv: ["--mode=reconcile"], env: local, clientFactory: () => supabase,
      reconcileReceipts, runner, logger: silent() })).rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(supabase.rpc).toHaveBeenCalledWith("payment_admin_schema_ready");
    expect(reconcileReceipts).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("readiness RPC exceptions are sanitized and stop connected phases", async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error("opaque-fixture-secret")) };
    const reconcileReceipts = emptyReceipts();
    const runner = vi.fn();
    await expect(main({ argv: ["--mode=reconcile"], env: local, clientFactory: () => supabase,
      reconcileReceipts, runner, logger: silent() })).rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(reconcileReceipts).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    { received: 1, processed: 0, review: 0, failed: 1 },
    { received: 1, processed: 0, review: 1, failed: 0 },
  ])("unresolved receipts disable every new charge even when the runner ledger appears safe %j", async (receipts) => {
    const runner = vi.fn(async ({ mode, createTransaction }) => {
      expect(mode).toBe("reconcile");
      expect(createTransaction).toBeUndefined();
      return { due: 1, charged: 0, reconciled: 1, failed: 0, blocked: 0 };
    });
    const logger = silent();
    const fetchImpl = vi.fn();
    await expect(main({ argv: ["--mode=charge"], env: local, clientFactory: readyClient(), fetchImpl,
      reconcileReceipts: vi.fn().mockResolvedValue(receipts), runner, logger }))
      .rejects.toThrow("BILLING_JOB_OPERATIONAL_FAILURE");
    expect(runner).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    const summary = JSON.parse(logger.log.mock.calls.at(-1)[0].slice("Monthly billing complete ".length));
    expect(summary).toMatchObject({ mode: "charge", runnerMode: "reconcile", receipts,
      chargesBlockedByReceipts: true, blocked: 1 });
  });

  it("receipt helper errors still allow reconciliation and never expose arbitrary error text", async () => {
    const runner = vi.fn(async ({ mode, createTransaction }) => {
      expect(mode).toBe("reconcile");
      expect(createTransaction).toBeUndefined();
      return { reconciled: 1 };
    });
    const logger = silent();
    await expect(main({ argv: ["--mode=reconcile"], env: local, clientFactory: readyClient(), logger,
      reconcileReceipts: vi.fn().mockRejectedValue(new Error("opaque-receipt-fixture-secret")), runner }))
      .rejects.toThrow("BILLING_JOB_OPERATIONAL_FAILURE");
    expect(runner).toHaveBeenCalledOnce();
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.error.mock.calls])).not.toContain("opaque-receipt-fixture-secret");
  });

  it.each([undefined, {}, { received: 1, processed: 0, review: 0, failed: 0 },
    { received: 1, processed: 1, review: "0", failed: 0 },
    { received: -1, processed: -1, review: 0, failed: 0 }])("invalid receipt counters fail closed %j", async (result) => {
    const runner = vi.fn().mockResolvedValue({});
    await expect(main({ argv: ["--mode=charge"], env: local, clientFactory: readyClient(), logger: silent(),
      reconcileReceipts: vi.fn().mockResolvedValue(result), runner })).rejects.toThrow("BILLING_JOB_OPERATIONAL_FAILURE");
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ mode: "reconcile", createTransaction: undefined }));
  });

  it.each([
    ["processed", "processed"], ["duplicate", undefined], ["review", "needs_review"],
  ])("integrates the parent's receipt helper with SQL result %s", async (result, processingState) => {
    const query = { select: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn() };
    for (const field of ["select", "in", "order"]) query[field].mockReturnValue(query);
    query.range.mockResolvedValue({ data: [{ id: "receipt-fixture", processing_state: "received", raw: {
      receipt_version: 1, transaction: { id: verified.id, status: "APPROVED", reference: verified.reference,
        amount_in_cents: verified.amount_in_cents, currency: "COP" },
    } }], error: null });
    const supabase = { from: vi.fn().mockReturnValue(query), rpc: vi.fn(async (name) => ({
      data: name === "payment_admin_schema_ready" ? true : { result, processingState }, error: null,
    })) };
    const fetchImpl = vi.fn().mockResolvedValue(response(verified));
    const runner = vi.fn().mockResolvedValue({ due: 1, reconciled: 1, charged: 0 });
    const logger = silent();
    const execution = main({ argv: ["--mode=charge"], env: local, clientFactory: () => supabase,
      fetchImpl, runner, logger });
    if (result === "review") {
      await expect(execution).rejects.toThrow("BILLING_JOB_OPERATIONAL_FAILURE");
      expect(runner).toHaveBeenCalledWith(expect.objectContaining({ mode: "reconcile", createTransaction: undefined }));
      const summary = JSON.parse(logger.log.mock.calls.at(-1)[0].slice("Monthly billing complete ".length));
      expect(summary.receipts).toEqual({ received: 1, processed: 0, review: 1, failed: 0 });
    } else {
      const stats = await execution;
      expect(stats.receipts).toEqual({ received: 1, processed: 1, review: 0, failed: 0 });
      expect(stats.chargesBlockedByReceipts).toBe(false);
    }
    expect(supabase.from).toHaveBeenCalledWith("webhook_events");
    expect(query.order.mock.calls).toEqual([["created_at", { ascending: true }], ["id", { ascending: true }]]);
    expect(query.range).toHaveBeenCalledWith(0, 99);
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, "payment_admin_schema_ready");
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, "apply_verified_wompi_event", expect.objectContaining({
      p_raw: expect.objectContaining({ receipt_id: "receipt-fixture" }),
    }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
  });

  it("rechecks app safety after readiness before calling the helper", async () => {
    const env = { ...local };
    const supabase = { rpc: vi.fn(async () => {
      env.APP_OPERATION_MODE = "demo";
      return { data: true, error: null };
    }) };
    const reconcileReceipts = emptyReceipts();
    const runner = vi.fn();
    await expect(main({ argv: ["--mode=reconcile"], env, clientFactory: () => supabase,
      reconcileReceipts, runner, logger: silent() })).rejects.toThrow("BILLING_JOB_DEMO_DISABLED");
    expect(reconcileReceipts).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("rechecks financial flags after receipts before dispatching the charge runner", async () => {
    const env = { ...local };
    const runner = vi.fn();
    await expect(main({ argv: ["--mode=charge"], env, clientFactory: readyClient(), logger: silent(), runner,
      reconcileReceipts: async () => {
        env.FINANCIAL_OPERATIONS_ENABLED = "false";
        return { received: 0, processed: 0, review: 0, failed: 0 };
      } })).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rechecks app safety at Wompi GET before any network call", async () => {
    const env = { ...local };
    const fetchImpl = vi.fn();
    await main({ argv: ["--mode=reconcile"], env, clientFactory: readyClient(), fetchImpl,
      reconcileReceipts: emptyReceipts(), logger: silent(), runner: async ({ getTransaction }) => {
        env.APP_OPERATION_MODE = "demo";
        expect(() => getTransaction({ transactionId: "tx-fixture" })).toThrow("BILLING_JOB_DEMO_DISABLED");
        return {};
      } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks financial flags between acceptance GET and POST", async () => {
    const env = { ...local };
    const fetchImpl = vi.fn(async () => {
      env.FINANCIAL_OPERATIONS_ENABLED = "false";
      return response({ presigned_acceptance: { acceptance_token: "fixture-acceptance" },
        presigned_personal_data_auth: { acceptance_token: "fixture-personal" } });
    });
    await main({ argv: ["--mode=charge"], env, clientFactory: readyClient(), fetchImpl,
      reconcileReceipts: emptyReceipts(), logger: silent(), runner: async ({ createTransaction }) => {
        await expect(createTransaction({})).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
        return {};
      } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://sandbox.wompi.co/v1/merchants/info");
  });
});
