---
name: gdex-trading
description: Trade crypto across chains via GDEX DEX to earn revenue for survival
auto-activate: true
requires:
  env:
    - GDEX_PRIVATE_KEY
---

# GDEX Trading Skill

You have access to the GDEX DEX aggregator via 9 built-in tools. Use these to trade
crypto, earn revenue, and ensure your survival. Your GDEX wallet is **separate** from
your Conway operating wallet — trading capital never touches your compute credits.

## Tools Available

| Tool | Description |
|------|-------------|
| `gdex_get_balance` | Check custodial wallet balances across all chains |
| `gdex_get_price` | Get current price of any token |
| `gdex_buy_token` | Buy a token on any supported chain |
| `gdex_sell_token` | Sell a token (or all) on any supported chain |
| `gdex_scan_solana` | Scan for new Solana meme coins / pump.fun launches |
| `gdex_limit_order` | Create a limit buy/sell order with optional TP/SL |
| `gdex_copy_trade` | Start/stop copy trading a HyperLiquid trader |
| `gdex_trending` | Get trending tokens across chains |
| `gdex_positions` | Check current open positions |

## Supported Chains

- `base` — Base L2 (verified working)
- `arbitrum` — Arbitrum One
- `ethereum` — Ethereum mainnet
- `bsc` — BNB Smart Chain
- `solana` — Solana (verified working for meme coins)

## Authentication

GDEX uses a custodial wallet system. Authentication happens automatically using
your `GDEX_PRIVATE_KEY` env var. You do NOT need to call any auth function
yourself — the tools handle it internally.

## Safety Guardrails (enforced automatically)

1. **Max trade size**: $5 USD per trade by default (configurable via `gdexMaxTradeSizeUsd`)
2. **Rate limit**: max 10 trades per hour (configurable via `gdexMaxTradesPerHour`)
3. **Survival check**: trading is blocked when tier is `critical` or `dead`
4. **Audit trail**: every trade is logged automatically

## Trading Workflow

### Check your situation first
```
1. gdex_get_balance              → see what you have
2. gdex_positions                → see open positions
3. gdex_trending (chain: base)   → find opportunities
```

### Buy a token on Base
```
gdex_buy_token:
  chain: base
  token_address: 0x...
  amount_usd: 2
  slippage_percent: 1
```

### Sell a token on Base
```
gdex_sell_token:
  chain: base
  token_address: 0x...
  amount: "all"
```

### Scan Solana meme coins (pump.fun)
```
gdex_scan_solana:
  limit: 20
```

Then buy promising ones:
```
gdex_buy_token:
  chain: solana
  token_address: <mint_address>
  amount_usd: 1
```

### Limit order with take-profit and stop-loss
```
gdex_limit_order:
  chain: base
  token_address: 0x...
  side: buy
  amount_usd: 3
  limit_price_usd: 0.00005
  take_profit_usd: 0.00010
  stop_loss_usd: 0.00003
```

### Copy trading (HyperLiquid)
```
gdex_copy_trade:
  action: start
  trader_address: 0x...
  max_position_usd: 5
```

**IMPORTANT**: Opening new HyperLiquid positions directly is BROKEN.
Only copy trading and closing positions work on HyperLiquid.

## Revenue Strategy

1. **Start small**: begin with $1-$2 trades to learn price action
2. **Diversify**: don't put all capital in one token
3. **Use stop-losses**: always set stop_loss_usd to cap downside
4. **Monitor positions**: check gdex_positions regularly
5. **Take profits**: don't be greedy; sell half at 2x
6. **Solana memes**: high risk/reward; use tiny amounts ($0.50-$1)
7. **Copy successful traders**: find profitable HyperLiquid traders

## API Details

- API URL: `https://trade-api.gemach.io`
- All requests use browser-like headers automatically (required to avoid 403)
- The `/v1/health` endpoint does NOT exist (returns 404) — do not check it

## Error Handling

If a tool returns an error:
- `GDEX not configured` → set `GDEX_PRIVATE_KEY` env var
- `Rate limit` → wait before trading again
- `Trading blocked: survival tier` → replenish Conway credits first
- `Trade blocked: exceeds max trade size` → reduce amount_usd

## Privacy

Your GDEX private key (`GDEX_PRIVATE_KEY`) is kept separate from your
Conway wallet (`wallet.json`). Never log or expose private keys.
