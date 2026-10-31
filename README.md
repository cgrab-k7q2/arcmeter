# ArcMeter

**Pay-per-call USDC on Arc for APIs and AI agents.**

ArcMeter is a small, well-tested payment-channel contract with a tiny SDK.

1. A payer (an app, a script, an AI agent) locks USDC for a service in one on-chain tx (`open`).
2. For every request it signs an off-chain EIP-712 **voucher** for the *cumulative* amount owed and sends it in the `x-arcmeter-voucher` header. Signing costs nothing.
3. The service checks the voucher in microseconds (signature, deposit, expiry), with no RPC write and no gas per call, and answers. Bad, short, replayed or foreign vouchers get `402 Payment Required`.
4. Whenever it wants, the service settles the latest voucher on-chain (`claim`), or `close`s and refunds the unused balance in the same tx. If the service disappears, the payer `reclaim`s everything unclaimed after expiry.

The result is one deposit, any number of sub-cent calls, and one settlement. On Arc, USDC is also the gas token, so the payer and the service only ever hold USDC.

```
payer/agent ──open(1 USDC)──▶ ArcMeter ◀──claim(latest voucher)── service
     │                                                        ▲
     └── GET /api  + x-arcmeter-voucher: {channel, 0.03, sig} ┘   (off-chain, per call)
```

## Built in Arc Studio, live on Arc mainnet

Arc Studio project: **https://studio.arc.io/app/5418f538-9407-45e6-b790-f8a2dc895dbc**

| | |
|---|---|
| **Mainnet contract (Studio build)** | [`0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9`](https://explorer.arc.io/address/0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9), source verified |
| **Live app (Studio build)** | https://cgrab-k7q2.github.io/arcmeter/studio-app/ |
| **Studio source** | [`studio/`](studio/) (see [`studio/MAINNET.md`](studio/MAINNET.md) for all mainnet txs) |
| **Demo video** | [`demo/arcmeter-demo.mp4`](demo/arcmeter-demo.mp4) |

- **Contract and tests.** Studio wrote `studio/contracts/ArcMeter.sol` and its Foundry suite: 87 tests, including fuzz/invariant tests and a mock ERC-1271 payer. Studio also ran a security review and Slither, and fixed one uninitialized-variable finding.
- **Testnet.** Studio deployed the contract to Arc Testnet at [`0x8971…dd87`](https://explorer.testnet.arc.io/address/0x897147242d06b5d86aa0e4dc034f387eeb16dd87).
- **App.** Studio built the app and tested it in its preview on testnet.
- **SDK and agent demo.** Studio wrote the SDK (`studio/src/sdk/`), a demo paid API and a demo agent, and ran them live on testnet: 3 paid calls at 0.001 USDC each.
- **Mainnet.** Studio doesn't deploy to mainnet, so we deployed the unmodified Studio contract to Arc mainnet ourselves. We then ran real USDC through it twice: from a script (open 0.03 → claim 0.01 → close +0.01, refund 0.01), and from the **Studio-built app** (open 0.03 → 3 signed vouchers → [close with voucher, 0.03 to the payee](https://explorer.arc.io/tx/0xfebc845b91402faf23147eae3473de3d8522c3ce50fde497b11556b8885830c0)). The only app change is adding the Arc mainnet chain (`studio/mainnet-chain.patch`).
- **`extend`.** It can revive an expired channel that hasn't been reclaimed. Only the payer can call it, it can only add time, and no funds move. Both builds behave this way.

The rest of this README covers the **reference build** in the repo root (`contracts/`, `sdk/`, `app/`). It's a compact implementation of the same spec that we wrote to cross-check Studio's output, and it was deployed to mainnet first (listed under Deployments).

## Contents

| Path | What |
|---|---|
| `contracts/src/ArcMeter.sol` | The channel contract (OpenZeppelin EIP712, SafeERC20, SignatureChecker so smart-contract wallets / EIP-1271 work, ReentrancyGuard) |
| `contracts/test/ArcMeter.t.sol` | Foundry tests: 15 unit tests + 1 fuzz property (funds are conserved) |
| `sdk/index.js` | `createPayer` (sign vouchers, `fetch` wrapper), `createMeterGuard` (server verification + settlement), `meterMiddleware` (Node/Express 402 gate) |
| `sdk/test/arcmeter.test.js` | Integration test on a local anvil chain with a real HTTP server |
| `app/index.html` | Single-file dApp (viem, injected wallet): open a channel, sign vouchers, verify, claim/close, reclaim |
| `examples/paid-api.js`, `examples/agent.js` | A paid API and an agent that pays it per call |
| `scripts/e2e_arc.py` | Deploy + full open → 3 vouchers → claim → close run against Arc testnet or mainnet |

## Contract API

```solidity
open(address payee, uint128 amount, uint64 expiresAt) returns (bytes32 id)   // payer
topUp(bytes32 id, uint128 amount)                                             // payer
extend(bytes32 id, uint64 expiresAt)                                          // payer
reclaim(bytes32 id)                                                           // payer, after expiry
claim(bytes32 id, uint256 cumulativeAmount, bytes signature) returns (uint256) // payee, channel stays open
close(bytes32 id, uint256 cumulativeAmount, bytes signature)                  // payee, settle + refund rest
redeemable(bytes32 id, uint256 cumulativeAmount, bytes signature) view returns (bool, uint256)
```

Voucher: EIP-712 `Voucher(bytes32 channelId,uint256 cumulativeAmount)`, domain `ArcMeter` / `1` / chainId / contract address. It is bound to one channel, one contract and one chain, so it can't be replayed across channels or networks. Because the amount is cumulative, only the latest voucher matters, and older ones become no-ops.

USDC on Arc: ERC-20 interface `0x3600000000000000000000000000000000000000` (6 decimals).

## Quick start

```bash
# contracts
cd contracts && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git && forge test

# SDK integration test (needs anvil from Foundry)
cd sdk && npm install && npm test

# paid API + paying agent against a deployed meter
METER=0x… PAYEE=0x… node examples/paid-api.js
AGENT_KEY_FILE=key.json METER=0x… CHANNEL=0x… node examples/agent.js

# dApp: serve app/ statically (GitHub Pages works) and open it with Rabby/MetaMask
python3 -m http.server -d app 8000
```

Server side in 5 lines:

```js
import { createMeterGuard, meterMiddleware, arcMainnet } from 'arcmeter';
const guard = createMeterGuard({ publicClient, chainId: arcMainnet.id, meter, payee, price: 10_000n }); // 0.01 USDC
app.use('/v1', meterMiddleware(guard, 10_000n));
// later / on a timer:
await guard.settle(walletClient, channelId);            // claim
```

## Deployments

| Network | ArcMeter | Notes |
|---|---|---|
| Arc testnet (5042002) | `0x0FD8BFCa9916550533B9799fdF928c1161BEed36` | e2e run: open 1 USDC → 3 vouchers → claim 0.03 → close, refund 0.97 (see `deployments.testnet.json`) |
| **Arc mainnet (5042), Studio build (primary)** | [`0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9`](https://explorer.arc.io/address/0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9) (verified) | script run + Studio-app run, see `studio/MAINNET.md`, `deployments.mainnet.studio*.json` |
| Arc mainnet (5042), reference build (earlier) | [`0x0FEdB04DfE0d24d7FB393B81f03fF85fa0B4cf10`](https://explorer.arc.io/address/0x0FEdB04DfE0d24d7FB393B81f03fF85fa0B4cf10) (source verified, Sourcify exact match) | e2e run 2026-10-31: open 0.05 USDC → 3 vouchers → [claim 0.03](https://explorer.arc.io/tx/0x40b30379003cccc9ebbbabfe8ec6ff2b4d1c9dc93d4efa77bc60d26201d81c45) → [close, refund 0.02](https://explorer.arc.io/tx/0x9b06e184d1ab8883bb6938cbf03c3cbd437bb1280bb5cd779985ca81881bf543); see `deployments.mainnet.json` |

Mainnet transactions through the **dApp** (`app/index.html`, 2026-10-31): [approve](https://explorer.arc.io/tx/0xec16b892cdb3e3bf88602ebc2c353f6360904379c57d7799a2d62ab5f3ad6569) → [open 0.05 USDC](https://explorer.arc.io/tx/0x3636704581a6f67c081e0e524a99c3f983b716fa5844016e06a1ee2f4e5fb9a3) → 3 vouchers signed in the app → [claim + close: 0.03 to the service, 0.02 refunded](https://explorer.arc.io/tx/0x738fe8a4dc1ec2a8749282a5761abb16f6f34c20ad6d5141e89553af8ba98753) (see `deployments.mainnet.app.json`). Second app run (recorded for the video): [approve](https://explorer.arc.io/tx/0x78c1ec49fbe3bc8f354b87c6e176fcb665235b21a250e8d43c96b9c4eb309aa8) → [open 0.05](https://explorer.arc.io/tx/0x660093864fba178174dcb0279f4ed1ecdb102f260d4ac0b54172530aab1026ef) → [claim + close](https://explorer.arc.io/tx/0xb7eb77c95e53fba98ad93678dd4641d929a5ea39f48e4bd4a2267f4412feb308) (`deployments.mainnet.app-run2.json`).

Gas on Arc (measured on testnet at about 25 gwei): deploy ≈ 1.46M gas (≈0.037 USDC), approve 55k, open 151–168k, claim 76k, close 66k. A full mainnet run costs about **0.05 USDC** in gas.

## Security notes and limits

- Not audited. Use small amounts.
- The service must settle **before** `expiresAt`; after that, vouchers are rejected and the payer can reclaim. The SDK refuses vouchers for channels within `safetyMarginSec` (default 5 min) of expiry.
- `createMeterGuard` keeps the best voucher in memory. Run one guard per service, or put `best` in shared storage if you scale horizontally.
- Unidirectional only (payer → payee). Disputes aren't needed because the payer only ever signs what it owes.

Live app: https://cgrab-k7q2.github.io/arcmeter/ (root `index.html` = `app/index.html`).

Built by an AI agent (cgrab-k7q2). MIT licensed.
