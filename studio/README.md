# ArcMeter

A unidirectional USDC payment channel for pay-per-call APIs and AI agents on Arc, with a web app to use it. A payer locks USDC, signs off-chain vouchers as usage grows, and the payee redeems them whenever it likes. Unused funds go back to the payer.

Built with [Arc Studio](https://studio.arc.io)

## What the app does

- Connect a wallet and open a channel: payee, USDC deposit, and how many hours it stays open (approve and open in one flow, with the channel id shown).
- Pay per call: set a price, sign the next cumulative voucher, and copy it for the `x-arcmeter-voucher` header.
- Service: paste a voucher, check it onchain, then claim or close.
- Channel status: payer, payee, deposit, claimed, remaining, expiry, and a reclaim button after expiry.

## SDK for APIs and agents

A small TypeScript module in `src/sdk/` (import from `src/sdk`):

- `createPayer({ account, chainId, meter, channelId })` for agents: `pay(amount)` signs the next voucher, `fetch(url, init, price)` makes a paid request with the `x-arcmeter-voucher` header attached.
- `createMeterGuard({ publicClient, chainId, meter, payee, price })` for services: `check(header)` returns ok or a 402 reason, `settle(walletClient, channelId, { close })` claims or closes.
- `meterMiddleware(guard)` puts the guard in front of a Node `http` server or an Express app.

### Demo

The demo runs on Arc Testnet. It needs the payer and payee to hold a little testnet USDC.

```
bun run demo:setup     # create throwaway testnet keys in .env and print the two addresses
bun run demo:selftest  # offline checks of the SDK, no funds needed
bun run demo           # paid API + agent making 3 paid calls, then the payee closes the channel
```

`bun run demo:server` and `bun run demo:agent` run the API and the agent as separate processes.

## Tech stack

- Solidity 0.8.28, OpenZeppelin Contracts, Foundry
- Vite, React, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```
bun install
bun run dev      # start the app
bun run check    # lint and typecheck
forge test       # contract tests
```

Contract: `contracts/ArcMeter.sol`. Tests: `contracts/test/ArcMeter.t.sol`.

### Environment variables

- `VITE_ARCMETER_ADDRESS_<chainId>`: ArcMeter contract address for that chain, for example `VITE_ARCMETER_ADDRESS_5042002` for Arc Testnet. It can also be overridden at runtime under "Contract" in the app header.
- `DEMO_PAYER_PRIVATE_KEY`, `DEMO_PAYEE_PRIVATE_KEY`: demo-only testnet keys, created by `bun run demo:setup`. Never use them with real funds.
- `DEMO_DEPOSIT` (optional): USDC the demo agent locks in its channel. Default `0.01`.
- `DEMO_API_URL` (optional): where `bun run demo:agent` finds the paid API. Default `http://127.0.0.1:8402`.
- `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` (optional outside Arc Studio): keyed RPC used by the demo when provisioned. Otherwise the public Arc RPC is used.
