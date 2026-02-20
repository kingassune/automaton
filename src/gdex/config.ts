/**
 * GDEX Trading Configuration
 *
 * Loads GDEX-specific settings from environment variables or automaton config.
 */

import type { AutomatonConfig } from "../types.js";

export const GDEX_API_URL = "https://trade-api.gemach.io";

export const GDEX_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: "https://gdex.pro",
  Referer: "https://gdex.pro/",
  "Content-Type": "application/json",
} as const;

export const GDEX_DEFAULT_MAX_TRADE_USD = 5;
export const GDEX_DEFAULT_MAX_TRADES_PER_HOUR = 10;

export interface GdexConfig {
  privateKey: string;
  apiUrl: string;
  defaultChain: string;
  maxTradeSizeUsd: number;
  maxTradesPerHour: number;
}

/**
 * Resolve GDEX configuration from env vars and automaton config.
 * Returns null if no private key is available.
 */
export function resolveGdexConfig(
  config: AutomatonConfig,
): GdexConfig | null {
  const privateKey =
    process.env.GDEX_PRIVATE_KEY ||
    config.gdexPrivateKey ||
    process.env.PRIVATE_KEY ||
    null;

  if (!privateKey) {
    return null;
  }

  return {
    privateKey,
    apiUrl: config.gdexApiUrl || process.env.GDEX_API_URL || GDEX_API_URL,
    defaultChain: config.gdexDefaultChain || "base",
    maxTradeSizeUsd:
      config.gdexMaxTradeSizeUsd ?? GDEX_DEFAULT_MAX_TRADE_USD,
    maxTradesPerHour:
      config.gdexMaxTradesPerHour ?? GDEX_DEFAULT_MAX_TRADES_PER_HOUR,
  };
}
