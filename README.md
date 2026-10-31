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

## Built in Arc Studio

Arc Studio project: **https://studio.arc.io/app/5418f538-9407-45e6-b790-f8a2dc895dbc**

- Contract + Foundry suite written in Studio: 87 tests, incl. fuzz and a mock ERC-1271 payer. Studio also ran a security review + Slither and fixed one uninitialized-variable finding.
- Deployed by Studio to Arc Testnet: [`0x897147242d06b5d86aa0e4dc034f387eeb16dd87`](https://explorer.testnet.arc.io/address/0x897147242d06b5d86aa0e4dc034f387eeb16dd87) (tx `0x512aace4880b2d69a793c1f48f45576e1c9138ab576f980fe413e560426f8906`).
- The web app (open / pay per call / service / channel status) was built and tested in Studio's preview on testnet.
- The SDK, demo paid API and demo agent were run live by Studio on testnet: 3 paid calls at 0.001 USDC, channel closed with 0.003 settled.
- Studio is testnet-only, so the mainnet contract below was deployed with our own tooling from the reviewed reference build in `contracts/` (same spec, source verified on explorer.arc.io). `extend` may revive an expired-but-unreclaimed channel (payer-only, time can only be added, no funds move). Both builds behave this way; see `test_extendRevivesExpiredUnreclaimedChannel`.

Demo video: [`demo/arcmeter-demo.mp4`](demo/arcmeter-demo.mp4)

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
| Arc mainnet (5042) | [`0x0FEdB04DfE0d24d7FB393B81f03fF85fa0B4cf10`](https://explorer.arc.io/address/0x0FEdB04DfE0d24d7FB393B81f03fF85fa0B4cf10) (source verified, Sourcify exact match) | e2e run 2026-10-31: open 0.05 USDC → 3 vouchers → [claim 0.03](https://explorer.arc.io/tx/0x40b30379003cccc9ebbbabfe8ec6ff2b4d1c9dc93d4efa77bc60d26201d81c45) → [close, refund 0.02](https://explorer.arc.io/tx/0x9b06e184d1ab8883bb6938cbf03c3cbd437bb1280bb5cd779985ca81881bf543); see `deployments.mainnet.json` |

Mainnet transactions through the **dApp** (`app/index.html`, 2026-10-31): [approve](https://explorer.arc.io/tx/0xec16b892cdb3e3bf88602ebc2c353f6360904379c57d7799a2d62ab5f3ad6569) → [open 0.05 USDC](https://explorer.arc.io/tx/0x3636704581a6f67c081e0e524a99c3f983b716fa5844016e06a1ee2f4e5fb9a3) → 3 vouchers signed in the app → [claim + close: 0.03 to the service, 0.02 refunded](https://explorer.arc.io/tx/0x738fe8a4dc1ec2a8749282a5761abb16f6f34c20ad6d5141e89553af8ba98753) (see `deployments.mainnet.app.json`). Second app run (recorded for the video): [approve](https://explorer.arc.io/tx/0x78c1ec49fbe3bc8f354b87c6e176fcb665235b21a250e8d43c96b9c4eb309aa8) → [open 0.05](https://explorer.arc.io/tx/0x660093864fba178174dcb0279f4ed1ecdb102f260d4ac0b54172530aab1026ef) → [claim + close](https://explorer.arc.io/tx/0xb7eb77c95e53fba98ad93678dd4641d929a5ea39f48e4bd4a2267f4412feb308) (`deployments.mainnet.app-run2.json`).

Gas on Arc (measured on testnet at about 25 gwei): deploy ≈ 1.46M gas (≈0.037 USDC), approve 55k, open 151–168k, claim 76k, close 66k. A full mainnet run costs about **0.05 USDC** in gas.

## Security notes and limits

- Not audited. Use small amounts.
- The service must settle **before** `expiresAt`; after that, vouchers are rejected and the payer can reclaim. The SDK refuses vouchers for channels within `safetyMarginSec` (default 5 min) of expiry.
- `createMeterGuard` keeps the best voucher in memory. Run one guard per service, or put `best` in shared storage if you scale horizontally.
- Unidirectional only (payer → payee). Disputes aren't needed because the payer only ever signs what it owes.

Live app: https://cgrab-k7q2.github.io/arcmeter/ (root `index.html` = `app/index.html`).

Built by an AI agent (cgrab-k7q2). MIT licensed.
