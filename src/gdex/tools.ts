/**
 * GDEX Trading Tools
 *
 * AutomatonTool definitions for GDEX DEX trading.
 * Includes safety guardrails: max trade size, rate limiting, survival checks.
 */

import type { AutomatonTool, SurvivalTier } from "../types.js";
import { GdexClient, TradeRateLimiter } from "./client.js";
import { resolveGdexConfig } from "./config.js";
import { logModification } from "../self-mod/audit-log.js";

// Shared rate limiter (singleton per process)
const rateLimiter = new TradeRateLimiter(10);

/**
 * Check survival tier and return an error string if trading should be blocked.
 */
function checkSurvivalTier(tier: SurvivalTier | string): string | null {
  if (tier === "critical" || tier === "dead") {
    return `Trading blocked: survival tier is '${tier}'. Preserve remaining resources.`;
  }
  return null;
}

/**
 * Get or throw GDEX client from context config.
 */
function getClient(ctx: Parameters<AutomatonTool["execute"]>[1]): { client: GdexClient; maxTradeSizeUsd: number } | string {
  const gdexConfig = resolveGdexConfig(ctx.config);
  if (!gdexConfig) {
    return "GDEX not configured: set GDEX_PRIVATE_KEY environment variable or gdexPrivateKey in config";
  }
  const client = new GdexClient(gdexConfig.apiUrl, gdexConfig.privateKey);
  return { client, maxTradeSizeUsd: gdexConfig.maxTradeSizeUsd };
}

/**
 * Get the current survival tier from the database.
 */
function getCurrentTier(ctx: Parameters<AutomatonTool["execute"]>[1]): string {
  return ctx.db.getKV("current_tier") || "normal";
}

export function createGdexTools(): AutomatonTool[] {
  return [
    // ── gdex_get_balance ──
    {
      name: "gdex_get_balance",
      description:
        "Check GDEX custodial wallet balances across all chains (or a specific chain).",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description:
              "Optional chain filter: base, arbitrum, ethereum, bsc, solana. Omit for all chains.",
          },
        },
      },
      execute: async (args, ctx) => {
        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        try {
          const balance = await client.getBalance(args.chain as string | undefined);
          const lines = [
            `GDEX Wallet Balance${args.chain ? ` (${args.chain})` : " (all chains)"}:`,
            `Total Value: $${balance.totalValueUsd.toFixed(2)} USD`,
          ];
          if (balance.address) {
            lines.push(`Address: ${balance.address}`);
          }
          if (balance.balances.length > 0) {
            lines.push("Tokens:");
            for (const b of balance.balances) {
              lines.push(`  ${b.symbol}: ${b.amount} (~$${b.valueUsd.toFixed(2)})`);
            }
          } else {
            lines.push("No token balances found.");
          }
          return lines.join("\n");
        } catch (err: any) {
          return `Failed to get GDEX balance: ${err.message || String(err)}`;
        }
      },
    },

    // ── gdex_get_price ──
    {
      name: "gdex_get_price",
      description: "Get the current price of any token on a supported chain.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain: base, arbitrum, ethereum, bsc, solana",
          },
          token_address: {
            type: "string",
            description: "Token contract address",
          },
        },
        required: ["chain", "token_address"],
      },
      execute: async (args, ctx) => {
        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        const chain = args.chain as string;
        const tokenAddress = args.token_address as string;

        try {
          const info = await client.getPrice(chain, tokenAddress);
          return [
            `Token: ${info.name} (${info.symbol})`,
            `Chain: ${info.chain}`,
            `Address: ${info.address}`,
            `Price: $${info.priceUsd.toFixed(8)} USD`,
            info.volume24h !== undefined ? `24h Volume: $${info.volume24h.toLocaleString()}` : null,
            info.marketCap !== undefined ? `Market Cap: $${info.marketCap.toLocaleString()}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        } catch (err: any) {
          return `Failed to get price: ${err.message || String(err)}`;
        }
      },
    },

    // ── gdex_buy_token ──
    {
      name: "gdex_buy_token",
      description:
        "Buy a token on any supported chain using the GDEX custodial wallet.",
      category: "financial",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain: base, arbitrum, ethereum, bsc, solana",
          },
          token_address: {
            type: "string",
            description: "Token contract address to buy",
          },
          amount_usd: {
            type: "number",
            description: "Amount in USD to spend (max $5 by default)",
          },
          slippage_percent: {
            type: "number",
            description: "Slippage tolerance in percent (default: 1)",
          },
        },
        required: ["chain", "token_address", "amount_usd"],
      },
      execute: async (args, ctx) => {
        // Survival check
        const tierErr = checkSurvivalTier(getCurrentTier(ctx));
        if (tierErr) return tierErr;

        // Rate limit check
        const rateErr = rateLimiter.check();
        if (rateErr) return rateErr;

        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client, maxTradeSizeUsd } = result;

        const amountUsd = args.amount_usd as number;
        if (amountUsd <= 0) return "amount_usd must be positive";
        if (amountUsd > maxTradeSizeUsd) {
          return `Trade blocked: $${amountUsd} exceeds max trade size of $${maxTradeSizeUsd}. Reduce amount or increase gdexMaxTradeSizeUsd in config.`;
        }

        const chain = args.chain as string;
        const tokenAddress = args.token_address as string;

        const tradeResult = await client.buyToken({
          chain,
          tokenAddress,
          amountUsd,
          slippagePercent: args.slippage_percent as number | undefined,
        });

        // Log audit trail
        logModification(
          ctx.db,
          "tool_use",
          `GDEX buy: $${amountUsd} of ${tokenAddress} on ${chain}${tradeResult.txHash ? ` (tx: ${tradeResult.txHash})` : ""}${tradeResult.error ? ` ERROR: ${tradeResult.error}` : ""}`,
        );

        if (tradeResult.success) {
          rateLimiter.record();
          return [
            `✓ Buy order executed on ${chain}`,
            `Token: ${tokenAddress}`,
            `Amount: $${amountUsd} USD`,
            tradeResult.txHash ? `Tx: ${tradeResult.txHash}` : null,
            `Time: ${tradeResult.timestamp}`,
          ]
            .filter(Boolean)
            .join("\n");
        }
        return `Buy failed on ${chain}: ${tradeResult.error}`;
      },
    },

    // ── gdex_sell_token ──
    {
      name: "gdex_sell_token",
      description:
        "Sell a token on any supported chain using the GDEX custodial wallet.",
      category: "financial",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain: base, arbitrum, ethereum, bsc, solana",
          },
          token_address: {
            type: "string",
            description: "Token contract address to sell",
          },
          amount: {
            type: "string",
            description:
              'Amount of tokens to sell, or "all" to sell entire balance',
          },
          slippage_percent: {
            type: "number",
            description: "Slippage tolerance in percent (default: 1)",
          },
        },
        required: ["chain", "token_address", "amount"],
      },
      execute: async (args, ctx) => {
        // Survival check
        const tierErr = checkSurvivalTier(getCurrentTier(ctx));
        if (tierErr) return tierErr;

        // Rate limit check
        const rateErr = rateLimiter.check();
        if (rateErr) return rateErr;

        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        const chain = args.chain as string;
        const tokenAddress = args.token_address as string;
        const rawAmount = args.amount as string;
        const amount: number | "all" =
          rawAmount === "all" ? "all" : parseFloat(rawAmount);

        if (typeof amount === "number" && (isNaN(amount) || amount <= 0)) {
          return 'amount must be a positive number or "all"';
        }

        const tradeResult = await client.sellToken({
          chain,
          tokenAddress,
          amount,
          slippagePercent: args.slippage_percent as number | undefined,
        });

        // Log audit trail
        logModification(
          ctx.db,
          "tool_use",
          `GDEX sell: ${amount} of ${tokenAddress} on ${chain}${tradeResult.txHash ? ` (tx: ${tradeResult.txHash})` : ""}${tradeResult.error ? ` ERROR: ${tradeResult.error}` : ""}`,
        );

        if (tradeResult.success) {
          rateLimiter.record();
          return [
            `✓ Sell order executed on ${chain}`,
            `Token: ${tokenAddress}`,
            `Amount: ${amount}`,
            tradeResult.txHash ? `Tx: ${tradeResult.txHash}` : null,
            `Time: ${tradeResult.timestamp}`,
          ]
            .filter(Boolean)
            .join("\n");
        }
        return `Sell failed on ${chain}: ${tradeResult.error}`;
      },
    },

    // ── gdex_scan_solana ──
    {
      name: "gdex_scan_solana",
      description:
        "Scan for new Solana meme coins and pump.fun launches. Returns top tokens by volume.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of tokens to return (default: 20, max: 50)",
          },
        },
      },
      execute: async (args, ctx) => {
        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        const limit = Math.min((args.limit as number) || 20, 50);

        try {
          const tokens = await client.scanSolanaTokens(limit);
          if (tokens.length === 0) {
            return "No Solana meme coins found at this time.";
          }
          const lines = [`Solana Meme Coins / pump.fun (top ${tokens.length}):`];
          for (const t of tokens) {
            lines.push(
              `  ${t.symbol} (${t.address.slice(0, 8)}...): $${t.priceUsd.toFixed(8)}${t.volume24h ? ` | vol: $${t.volume24h.toLocaleString()}` : ""}`,
            );
          }
          return lines.join("\n");
        } catch (err: any) {
          return `Failed to scan Solana tokens: ${err.message || String(err)}`;
        }
      },
    },

    // ── gdex_limit_order ──
    {
      name: "gdex_limit_order",
      description:
        "Create a limit buy or sell order with optional take-profit and stop-loss.",
      category: "financial",
      dangerous: true,
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain: base, arbitrum, ethereum, bsc, solana",
          },
          token_address: {
            type: "string",
            description: "Token contract address",
          },
          side: {
            type: "string",
            description: "buy or sell",
          },
          amount_usd: {
            type: "number",
            description: "Amount in USD",
          },
          limit_price_usd: {
            type: "number",
            description: "Limit price in USD per token",
          },
          take_profit_usd: {
            type: "number",
            description: "Optional take-profit price in USD",
          },
          stop_loss_usd: {
            type: "number",
            description: "Optional stop-loss price in USD",
          },
        },
        required: ["chain", "token_address", "side", "amount_usd", "limit_price_usd"],
      },
      execute: async (args, ctx) => {
        // Survival check
        const tierErr = checkSurvivalTier(getCurrentTier(ctx));
        if (tierErr) return tierErr;

        // Rate limit check
        const rateErr = rateLimiter.check();
        if (rateErr) return rateErr;

        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client, maxTradeSizeUsd } = result;

        const amountUsd = args.amount_usd as number;
        if (amountUsd > maxTradeSizeUsd) {
          return `Trade blocked: $${amountUsd} exceeds max trade size of $${maxTradeSizeUsd}.`;
        }

        const side = args.side as "buy" | "sell";
        if (side !== "buy" && side !== "sell") {
          return 'side must be "buy" or "sell"';
        }

        const tradeResult = await client.createLimitOrder({
          chain: args.chain as string,
          tokenAddress: args.token_address as string,
          side,
          amountUsd,
          limitPriceUsd: args.limit_price_usd as number,
          takeProfitUsd: args.take_profit_usd as number | undefined,
          stopLossUsd: args.stop_loss_usd as number | undefined,
        });

        // Log audit trail
        logModification(
          ctx.db,
          "tool_use",
          `GDEX limit order: ${side} $${amountUsd} of ${args.token_address} on ${args.chain} @ $${args.limit_price_usd}${tradeResult.error ? ` ERROR: ${tradeResult.error}` : ""}`,
        );

        if (tradeResult.success) {
          rateLimiter.record();
          return [
            `✓ Limit ${side} order placed on ${args.chain}`,
            `Token: ${args.token_address}`,
            `Amount: $${amountUsd} @ $${args.limit_price_usd}`,
            args.take_profit_usd ? `Take-profit: $${args.take_profit_usd}` : null,
            args.stop_loss_usd ? `Stop-loss: $${args.stop_loss_usd}` : null,
            tradeResult.txHash ? `Order ID: ${tradeResult.txHash}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        }
        return `Limit order failed: ${tradeResult.error}`;
      },
    },

    // ── gdex_copy_trade ──
    {
      name: "gdex_copy_trade",
      description:
        "Start or stop copy trading a HyperLiquid trader. Note: only copy trading and closing positions work — opening new HyperLiquid positions directly is broken.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "start or stop",
          },
          trader_address: {
            type: "string",
            description: "HyperLiquid trader wallet address to copy",
          },
          max_position_usd: {
            type: "number",
            description: "Maximum position size in USD per trade",
          },
        },
        required: ["action", "trader_address"],
      },
      execute: async (args, ctx) => {
        // Survival check
        const tierErr = checkSurvivalTier(getCurrentTier(ctx));
        if (tierErr) return tierErr;

        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        const action = args.action as "start" | "stop";
        if (action !== "start" && action !== "stop") {
          return 'action must be "start" or "stop"';
        }

        const copyResult = await client.copyTrade({
          traderAddress: args.trader_address as string,
          action,
          maxPositionUsd: args.max_position_usd as number | undefined,
        });

        // Log audit trail
        logModification(
          ctx.db,
          "tool_use",
          `GDEX copy trade ${action}: trader=${args.trader_address}${args.max_position_usd ? ` maxPos=$${args.max_position_usd}` : ""}`,
        );

        return copyResult.success
          ? `✓ Copy trade ${action}ed: ${copyResult.message}`
          : `Copy trade ${action} failed: ${copyResult.message}`;
      },
    },

    // ── gdex_trending ──
    {
      name: "gdex_trending",
      description:
        "Get trending tokens across all supported chains or a specific chain.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description:
              "Optional chain filter: base, arbitrum, ethereum, bsc, solana",
          },
        },
      },
      execute: async (args, ctx) => {
        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        try {
          const tokens = await client.getTrending(args.chain as string | undefined);
          if (tokens.length === 0) {
            return "No trending tokens found.";
          }
          const lines = [`Trending tokens${args.chain ? ` on ${args.chain}` : ""}:`];
          for (const t of tokens) {
            lines.push(
              `  [${t.chain}] ${t.symbol} (${t.address.slice(0, 8)}...): $${t.priceUsd.toFixed(8)}${t.volume24h ? ` | vol: $${t.volume24h.toLocaleString()}` : ""}`,
            );
          }
          return lines.join("\n");
        } catch (err: any) {
          return `Failed to get trending tokens: ${err.message || String(err)}`;
        }
      },
    },

    // ── gdex_positions ──
    {
      name: "gdex_positions",
      description: "Check current open positions in the GDEX custodial wallet.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (args, ctx) => {
        const result = getClient(ctx);
        if (typeof result === "string") return result;
        const { client } = result;

        try {
          const positions = await client.getPositions();
          if (positions.length === 0) {
            return "No open positions.";
          }
          const lines = [`Open positions (${positions.length}):`];
          for (const p of positions) {
            const pnlSign = p.pnlUsd >= 0 ? "+" : "";
            lines.push(
              `  [${p.chain}] ${p.symbol}: ${p.amount} tokens | Entry: $${p.entryPriceUsd.toFixed(6)} | Now: $${p.currentPriceUsd.toFixed(6)} | PnL: ${pnlSign}$${p.pnlUsd.toFixed(2)} (${pnlSign}${p.pnlPercent.toFixed(1)}%)`,
            );
          }
          return lines.join("\n");
        } catch (err: any) {
          return `Failed to get positions: ${err.message || String(err)}`;
        }
      },
    },
  ];
}
