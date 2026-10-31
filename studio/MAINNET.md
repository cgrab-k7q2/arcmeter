# Arc Studio build: Arc mainnet

This folder is the Arc Studio project export (https://studio.arc.io/app/5418f538-9407-45e6-b790-f8a2dc895dbc), minus `.env`, build output, `node_modules` and `lib/forge-std` (`forge install foundry-rs/forge-std --no-git` restores it).

- `contracts/ArcMeter.sol` is unmodified from Studio. Tests: `forge test`, 87 passing (incl. invariant/fuzz and a mock ERC-1271 payer).
- Deployed to **Arc mainnet** at [`0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9`](https://explorer.arc.io/address/0x8cCc466E9645eF293bc1d5ee76AE17aAE066a7f9). Source is verified (Sourcify exact match), built with solc 0.8.28, optimizer 200, cancun, OpenZeppelin 5.6.1.
- The only change to the app is `mainnet-chain.patch`, which adds Arc mainnet (`viem/chains` `arc`) to `APP_CHAINS` and the wagmi config, as described in the Studio code comments. Build with `VITE_ARCMETER_ADDRESS_5042` set (see `.env.example`): `bun install && bunx vite build --base=./`. The built app is in `../studio-app/`.

Mainnet transactions on this contract (2026-10-31):

| Step | Via | Tx |
|---|---|---|
| deploy | script | [0x358a03a4…1791](https://explorer.arc.io/tx/0x358a03a4ea9d35c7e0022a26024604e98d156efa2a758032e910a9deeca41791) |
| approve + open 0.03 USDC | script | [0x4af80d00…40a0](https://explorer.arc.io/tx/0x4af80d00384f61d07332baf52780406cd4fde5d447e94e778ea70130d8f540a0), [0x0b1c7e6d…2409](https://explorer.arc.io/tx/0x0b1c7e6dbb6f7f5524bd4f30f58982d97b03e8ab2bb87c7f97315b1b7f702409) |
| claim 0.01 | script | [0xa5228525…f9b6](https://explorer.arc.io/tx/0xa5228525218ff843d7ce10195d82bb8789e4a59809d0885697192ab69355f9b6) |
| close with voucher: +0.01 to the payee, 0.01 refunded | script | [0x1aef8c27…38cd](https://explorer.arc.io/tx/0x1aef8c27fde4b160034ab474360af7ac441e69b2847964e4febeed7f66e338cd) |
| approve | **Studio app** | [0xae2177e2…4c36](https://explorer.arc.io/tx/0xae2177e279fd28ef9fa3df096e53f9eac1d6b638ac6cbf166d5644bc42c44c36) |
| open 0.03 USDC | **Studio app** | [0xf953190c…fc83](https://explorer.arc.io/tx/0xf953190c659d4b7d5dd41c0cb2a8f67d349b04354542be576f63050ac42bfc83) |
| 3 vouchers signed in the app, then close with voucher: 0.03 USDC to the payee | **Studio app** | [0xfebc845b…30c0](https://explorer.arc.io/tx/0xfebc845b91402faf23147eae3473de3d8522c3ce50fde497b11556b8885830c0) |
