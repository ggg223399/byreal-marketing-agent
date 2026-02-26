# Byreal Solana/DeFi Signal Classification Rules

Classify each tweet into exactly one signal category for Byreal market intelligence.

## Allowed Signal Categories (Use Number)

- `1` = `solana_growth_milestone`
- `2` = `institutional_adoption`
- `3` = `rwa_signal`
- `4` = `liquidity_signal`
- `5` = `market_structure_insight`
- `6` = `byreal_ranking_mention`
- `7` = `partner_momentum`
- `8` = `risk_event`

## Detection Logic (Scoring-Based)

Use evidence-based scoring. Assign confidence by signal density, clarity, and specificity.

1. Category `1` (`solana_growth_milestone`)
- Must contain all 3 components:
  - metric keyword (TVL, volume, DAU, active wallets, transactions, open interest, fees, revenue)
  - growth descriptor (ATH, breakout, surging, accelerating, record high, up, increasing)
  - numeric expression (% change, absolute number, MoM/YoY/QoQ)
- Example: "Solana TVL hits ATH, up 23% MoM"

2. Category `2` (`institutional_adoption`)
- Solana tied to institutions, custody, ETF, RWA rails, prime brokerage, banks, asset managers, funds.
- Also applies when capital markets narrative density is high (institutional framing, compliance, allocation, enterprise rollout).

3. Category `3` (`rwa_signal`)
- RWA issuance, tokenized equities/bonds/T-bills/credit, onchain securitization, TradFi asset tokenization.
- Mentions of TradFi integration into tokenized real-world assets.

4. Category `4` (`liquidity_signal`)
- TVL growth/decline, volume spikes, net inflow/outflow, capital rotation, liquidity formation.
- Includes pair depth, LP migration, order book/AMM liquidity concentration shifts.

5. Category `5` (`market_structure_insight`)
- Structural shift or market regime transition, not just one-off news.
- 3+ accounts reporting same milestone OR clear quarter-over-quarter pattern evidence.
- Includes durable changes in flow, participant mix, venue dominance, narrative regime.

6. Category `6` (`byreal_ranking_mention`)
- Byreal appears in ranking, leaderboard, chart, list, benchmark, side-by-side comparison.
- High importance when top-5 mention or negative comparison framing.

7. Category `7` (`partner_momentum`)
- Byreal partner account posts measurable progress: metrics, funding, launch, integration, institutional deal.
- Should indicate momentum beyond generic marketing language.

8. Category `8` (`risk_event`)
- Exploit, hack, drained funds, insolvency, rug, outage, validator failure, depeg, major incident, regulatory ban.
- Safety-first: if severe operational/financial risk is explicit, classify as category `8` (`risk_event`).

## Multi-Class Resolution

If multiple categories could fit, choose one category using action priority:
- red-priority classes > orange-priority classes > yellow-priority classes
- If still tied, choose the category with strongest explicit evidence and numeric specificity.

## Output JSON Requirements

Return valid JSON array only. No markdown, no extra text.

Each item must include:
- `tweetId`: string
- `category`: integer from 1 to 8
- `confidence`: integer from 0 to 100
- `sentiment`: `positive` | `neutral` | `negative`
- `priority`: integer 1-5 (5 = highest urgency)
- `riskLevel`: `low` | `medium` | `high`
- `suggestedAction`: `qrt_positioning` | `reply_supportive` | `like_only` | `monitor` | `escalate_internal`
- `reason`: concise evidence-based reason
