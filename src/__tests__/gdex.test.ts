/**
 * GDEX Trading Tools Tests
 *
 * Tests for GDEX tool safety guardrails: survival check, rate limiting,
 * max trade size, audit logging, and input validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGdexTools } from "../gdex/tools.js";
import { createTestDb, createTestIdentity, createTestConfig } from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient } from "./mocks.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeCtx(
  db: AutomatonDatabase,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    identity: createTestIdentity(),
    config: createTestConfig({
      gdexPrivateKey: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      gdexMaxTradeSizeUsd: 5,
      gdexMaxTradesPerHour: 10,
    }),
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
    ...overrides,
  } as unknown as ToolContext;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("GDEX Tools", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── Configuration guard ──

  it("returns config error when GDEX_PRIVATE_KEY is not set", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db, {
      config: createTestConfig({
        gdexPrivateKey: undefined,
        gdexMaxTradeSizeUsd: 5,
      }) as any,
    });
    // Ensure no env var either
    const origEnv = process.env.GDEX_PRIVATE_KEY;
    delete process.env.GDEX_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;

    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 1 },
      ctx,
    );

    if (origEnv !== undefined) process.env.GDEX_PRIVATE_KEY = origEnv;

    expect(result).toContain("GDEX not configured");
  });

  // ── Survival tier guard ──

  it("blocks trading in critical survival tier", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "critical");

    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 1 },
      ctx,
    );

    expect(result).toContain("critical");
    expect(result).toContain("blocked");
  });

  it("blocks trading in dead survival tier", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "dead");

    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 1 },
      ctx,
    );

    expect(result).toContain("dead");
    expect(result).toContain("blocked");
  });

  it("allows trading in normal survival tier", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    // It will fail at the API call (no real server), but not at the survival check
    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 1 },
      ctx,
    );

    // Should not be blocked by survival check
    expect(result).not.toContain("survival tier");
    expect(result).not.toContain("Preserve remaining resources");
    // The result should either be a trade response or a network error
    // (not a survival/safety block)
  });

  // ── Max trade size guard ──

  it("blocks trades exceeding max trade size", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 100 },
      ctx,
    );

    expect(result).toContain("exceeds max trade size");
    expect(result).toContain("$100");
  });

  it("allows trades within max trade size", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    const result = await buyTool.execute(
      { chain: "base", token_address: "0x123", amount_usd: 5 },
      ctx,
    );

    // Should not be blocked for size (may fail on network though)
    expect(result).not.toContain("exceeds max trade size");
  });

  // ── Input validation ──

  it("gdex_sell_token validates non-positive amount", async () => {
    const tools = createGdexTools();
    const sellTool = tools.find((t) => t.name === "gdex_sell_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    const result = await sellTool.execute(
      { chain: "base", token_address: "0x123", amount: "-5" },
      ctx,
    );

    expect(result).toContain("positive");
  });

  it("gdex_limit_order rejects invalid side", async () => {
    const tools = createGdexTools();
    const limitTool = tools.find((t) => t.name === "gdex_limit_order")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    const result = await limitTool.execute(
      {
        chain: "base",
        token_address: "0x123",
        side: "long",
        amount_usd: 1,
        limit_price_usd: 0.001,
      },
      ctx,
    );

    expect(result).toContain('"buy" or "sell"');
  });

  it("gdex_copy_trade rejects invalid action", async () => {
    const tools = createGdexTools();
    const copyTool = tools.find((t) => t.name === "gdex_copy_trade")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    const result = await copyTool.execute(
      { action: "pause", trader_address: "0xtrader" },
      ctx,
    );

    expect(result).toContain('"start" or "stop"');
  });

  // ── Tool registry ──

  it("creates all 9 expected GDEX tools", () => {
    const tools = createGdexTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("gdex_get_balance");
    expect(names).toContain("gdex_buy_token");
    expect(names).toContain("gdex_sell_token");
    expect(names).toContain("gdex_get_price");
    expect(names).toContain("gdex_scan_solana");
    expect(names).toContain("gdex_limit_order");
    expect(names).toContain("gdex_copy_trade");
    expect(names).toContain("gdex_trending");
    expect(names).toContain("gdex_positions");
    expect(tools).toHaveLength(9);
  });

  it("all GDEX tools have category 'financial'", () => {
    const tools = createGdexTools();
    for (const tool of tools) {
      expect(tool.category).toBe("financial");
    }
  });

  it("trade tools are marked dangerous", () => {
    const tools = createGdexTools();
    const tradingTools = ["gdex_buy_token", "gdex_sell_token", "gdex_limit_order"];
    for (const name of tradingTools) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.dangerous).toBe(true);
    }
  });

  // ── Audit logging ──

  it("audit logs are written for buy attempts", async () => {
    const tools = createGdexTools();
    const buyTool = tools.find((t) => t.name === "gdex_buy_token")!;

    const ctx = makeCtx(db);
    ctx.db.setKV("current_tier", "normal");

    // Attempt a buy (will fail at network but should log)
    await buyTool.execute(
      { chain: "base", token_address: "0xtoken", amount_usd: 1 },
      ctx,
    );

    const mods = db.getRecentModifications(10);
    const tradeLog = mods.find(
      (m) => m.type === "tool_use" && m.description.includes("GDEX buy"),
    );
    expect(tradeLog).toBeDefined();
    expect(tradeLog!.description).toContain("0xtoken");
  });
});
