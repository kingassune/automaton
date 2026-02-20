/**
 * GDEX Client
 *
 * Wraps the GDEX trading API (https://trade-api.gemach.io).
 * Uses browser-like headers required by the GDEX API.
 * Integrates with the gdex.pro-sdk if available, otherwise falls back
 * to direct fetch calls.
 */

import type {
  GdexTradeResult,
  GdexTokenInfo,
  GdexBalance,
  GdexPosition,
} from "../types.js";
import { GDEX_BROWSER_HEADERS } from "./config.js";

export interface BuyTokenParams {
  chain: string;
  tokenAddress: string;
  amountUsd: number;
  slippagePercent?: number;
}

export interface SellTokenParams {
  chain: string;
  tokenAddress: string;
  /** Amount of tokens to sell, or "all" to sell entire balance */
  amount: number | "all";
  slippagePercent?: number;
}

export interface LimitOrderParams {
  chain: string;
  tokenAddress: string;
  side: "buy" | "sell";
  amountUsd: number;
  limitPriceUsd: number;
  takeProfitUsd?: number;
  stopLossUsd?: number;
}

export interface CopyTradeParams {
  traderAddress: string;
  action: "start" | "stop";
  maxPositionUsd?: number;
}

/** One hour in milliseconds. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Extract an auth token string from a session/auth response object.
 * The GDEX SDK and direct API may return the token under different keys.
 */
function extractAuthToken(res: Record<string, any>): string {
  return res.token || res.apiKey || res.jwt || "";
}

export class GdexClient {
  private apiUrl: string;
  private privateKey: string;
  private authToken: string | null = null;

  constructor(apiUrl: string, privateKey: string) {
    this.apiUrl = apiUrl;
    this.privateKey = privateKey;
  }

  // ─── Authentication ───────────────────────────────────────────

  /**
   * Authenticate with the GDEX API using the private key.
   * Returns the auth token for subsequent requests.
   */
  async authenticate(): Promise<string> {
    if (this.authToken) return this.authToken;

    try {
      // Try to use gdex.pro-sdk if available
      const sdk = await this.tryLoadSdk();
      if (sdk) {
        const session = await sdk.createAuthenticatedSession(this.privateKey);
        const token = extractAuthToken(session);
        if (token) {
          this.authToken = token;
          return this.authToken;
        }
      }
    } catch {
      // Fall through to direct API
    }

    // Direct authentication via API
    const res = await this.post("/v1/auth/login", {
      privateKey: this.privateKey,
    });
    this.authToken = extractAuthToken(res);
    return this.authToken ?? "";
  }

  // ─── Market Data ──────────────────────────────────────────────

  /**
   * Get current price of a token.
   */
  async getPrice(
    chain: string,
    tokenAddress: string,
  ): Promise<GdexTokenInfo> {
    const data = await this.get(
      `/v1/market/price?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(tokenAddress)}`,
    );
    return {
      address: tokenAddress,
      symbol: data.symbol || "UNKNOWN",
      name: data.name || "Unknown Token",
      chain,
      priceUsd: data.priceUsd || data.price || 0,
      volume24h: data.volume24h,
      marketCap: data.marketCap,
    };
  }

  /**
   * Get trending tokens across chains.
   */
  async getTrending(chain?: string): Promise<GdexTokenInfo[]> {
    const query = chain ? `?chain=${encodeURIComponent(chain)}` : "";
    const data = await this.get(`/v1/market/trending${query}`);
    const tokens = data.tokens || data.data || [];
    return tokens.map((t: any) => ({
      address: t.address || t.tokenAddress,
      symbol: t.symbol || "UNKNOWN",
      name: t.name || "Unknown",
      chain: t.chain || chain || "unknown",
      priceUsd: t.priceUsd || t.price || 0,
      volume24h: t.volume24h,
      marketCap: t.marketCap,
    }));
  }

  /**
   * Scan for new Solana meme coins / pump.fun launches.
   */
  async scanSolanaTokens(limit = 20): Promise<GdexTokenInfo[]> {
    const data = await this.get(
      `/v1/solana/scan?limit=${limit}&source=pump.fun`,
    );
    const tokens = data.tokens || data.data || [];
    return tokens.map((t: any) => ({
      address: t.address || t.mintAddress,
      symbol: t.symbol || t.ticker || "UNKNOWN",
      name: t.name || "Unknown",
      chain: "solana",
      priceUsd: t.priceUsd || t.price || 0,
      volume24h: t.volume24h,
      marketCap: t.marketCap,
    }));
  }

  // ─── Wallet / Balances ────────────────────────────────────────

  /**
   * Get custodial wallet balances across all chains.
   */
  async getBalance(chain?: string): Promise<GdexBalance> {
    await this.authenticate();
    const query = chain ? `?chain=${encodeURIComponent(chain)}` : "";
    const data = await this.getAuthed(`/v1/wallet/balance${query}`);
    const balances = (data.balances || data.tokens || []).map((b: any) => ({
      token: b.token || b.address || "",
      symbol: b.symbol || "UNKNOWN",
      amount: b.amount || b.balance || 0,
      valueUsd: b.valueUsd || b.usdValue || 0,
    }));
    return {
      chain: chain || "all",
      address: data.walletAddress || data.address || "",
      balances,
      totalValueUsd: data.totalValueUsd || data.totalUsd || 0,
    };
  }

  /**
   * Get open positions.
   */
  async getPositions(): Promise<GdexPosition[]> {
    await this.authenticate();
    const data = await this.getAuthed("/v1/wallet/positions");
    const positions = data.positions || data.data || [];
    return positions.map((p: any) => ({
      chain: p.chain || "unknown",
      tokenAddress: p.tokenAddress || p.address || "",
      symbol: p.symbol || "UNKNOWN",
      amount: p.amount || 0,
      entryPriceUsd: p.entryPriceUsd || p.entryPrice || 0,
      currentPriceUsd: p.currentPriceUsd || p.currentPrice || 0,
      pnlUsd: p.pnlUsd || p.pnl || 0,
      pnlPercent: p.pnlPercent || p.pnlPct || 0,
    }));
  }

  // ─── Trading ──────────────────────────────────────────────────

  /**
   * Buy a token on the specified chain.
   */
  async buyToken(params: BuyTokenParams): Promise<GdexTradeResult> {
    try {
      await this.authenticate();
      const data = await this.postAuthed("/v1/trade/buy", {
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: params.amountUsd,
        slippage: params.slippagePercent ?? 1,
      });
      return {
        success: true,
        txHash: data.txHash || data.hash,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: params.amountUsd,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        success: false,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: params.amountUsd,
        error: err.message || String(err),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Sell a token on the specified chain.
   */
  async sellToken(params: SellTokenParams): Promise<GdexTradeResult> {
    try {
      await this.authenticate();
      const data = await this.postAuthed("/v1/trade/sell", {
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amount: params.amount,
        slippage: params.slippagePercent ?? 1,
      });
      return {
        success: true,
        txHash: data.txHash || data.hash,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: 0,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        success: false,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: 0,
        error: err.message || String(err),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Create a limit order with optional take-profit / stop-loss.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<GdexTradeResult> {
    try {
      await this.authenticate();
      const data = await this.postAuthed("/v1/trade/limit", {
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        side: params.side,
        amountUsd: params.amountUsd,
        limitPriceUsd: params.limitPriceUsd,
        takeProfitUsd: params.takeProfitUsd,
        stopLossUsd: params.stopLossUsd,
      });
      return {
        success: true,
        txHash: data.orderId || data.txHash,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: params.amountUsd,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        success: false,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        amountUsd: params.amountUsd,
        error: err.message || String(err),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Start or stop copy trading a HyperLiquid trader.
   * Note: opening HyperLiquid positions is BROKEN; only closing and copy trading work.
   */
  async copyTrade(params: CopyTradeParams): Promise<{ success: boolean; message: string }> {
    try {
      await this.authenticate();
      const data = await this.postAuthed("/v1/copytrade", {
        traderAddress: params.traderAddress,
        action: params.action,
        maxPositionUsd: params.maxPositionUsd,
      });
      return {
        success: true,
        message: data.message || `Copy trade ${params.action}ed for ${params.traderAddress}`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || String(err),
      };
    }
  }

  // ─── HTTP helpers ─────────────────────────────────────────────

  private async tryLoadSdk(): Promise<any | null> {
    try {
      // @ts-ignore — gdex.pro-sdk may not be installed; optional dependency
      const sdk = await import("gdex.pro-sdk");
      return sdk;
    } catch {
      return null;
    }
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: GDEX_BROWSER_HEADERS,
    });
    if (!res.ok) {
      throw new Error(`GDEX API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  private async getAuthed(path: string): Promise<any> {
    const token = await this.authenticate();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: {
        ...GDEX_BROWSER_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`GDEX API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: GDEX_BROWSER_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GDEX API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  private async postAuthed(path: string, body: unknown): Promise<any> {
    const token = await this.authenticate();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: {
        ...GDEX_BROWSER_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GDEX API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────────

/**
 * Simple in-memory rate limiter for trades.
 * Tracks trade timestamps and enforces a per-hour limit.
 */
export class TradeRateLimiter {
  private tradeTimestamps: number[] = [];
  readonly maxTradesPerHour: number;

  constructor(maxTradesPerHour: number) {
    this.maxTradesPerHour = maxTradesPerHour;
  }

  /**
   * Check if a trade is allowed under the rate limit.
   * Returns null if allowed, or an error message if blocked.
   */
  check(): string | null {
    const now = Date.now();
    const oneHourAgo = now - ONE_HOUR_MS;

    // Remove timestamps older than 1 hour
    this.tradeTimestamps = this.tradeTimestamps.filter(
      (ts) => ts > oneHourAgo,
    );

    if (this.tradeTimestamps.length >= this.maxTradesPerHour) {
      return `Rate limit: max ${this.maxTradesPerHour} trades per hour (${this.tradeTimestamps.length} already made)`;
    }
    return null;
  }

  /**
   * Record that a trade was made.
   */
  record(): void {
    this.tradeTimestamps.push(Date.now());
  }
}
