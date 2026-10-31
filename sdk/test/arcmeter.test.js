// Integration test: real ArcMeter bytecode on a local anvil chain, real HTTP server using the middleware.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createPublicClient, createWalletClient, http as httpT, parseAbi, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { arcMeterAbi, createPayer, createMeterGuard, meterMiddleware, HEADER } from '../index.js';

const OUT = new URL('../../contracts/out/', import.meta.url);
const art = (p) => JSON.parse(readFileSync(new URL(p, OUT)));
const PORT = 8547;
// anvil default dev keys (public, test-only)
const payerAcc = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const svcAcc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const chain = { ...foundry, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } };
let anvil, server, pub, payerW, svcW, meter, usdc, channelId, guard, payer;
const mockAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

async function deploy(wallet, a, args = []) {
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
}

before(async () => {
  anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--silent']);
  pub = createPublicClient({ chain, transport: httpT() });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  payerW = createWalletClient({ chain, transport: httpT(), account: payerAcc });
  svcW = createWalletClient({ chain, transport: httpT(), account: svcAcc });
  usdc = await deploy(payerW, art('ArcMeter.t.sol/MockUSDC.json'));
  meter = await deploy(payerW, art('ArcMeter.sol/ArcMeter.json'), [usdc]);
  await send(payerW, usdc, mockAbi, 'mint', [payerAcc.address, 10_000_000n]);
  await send(payerW, usdc, mockAbi, 'approve', [meter, 10_000_000n]);
  const now = Number((await pub.getBlock()).timestamp);
  const r = await send(payerW, meter, arcMeterAbi, 'open', [svcAcc.address, 1_000_000n, BigInt(now + 3600)]);
  const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: arcMeterAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'ChannelOpened');
  channelId = ev.args.id;

  guard = createMeterGuard({ publicClient: pub, chainId: chain.id, meter, payee: svcAcc.address, price: 10_000n, now: () => now });
  const mw = meterMiddleware(guard, 10_000n);
  server = http.createServer((req, res) => mw(req, res, () => { res.end(JSON.stringify({ answer: 42, charged: req.arcmeter.charged.toString() })); }));
  await new Promise((r) => server.listen(0, r));
  payer = createPayer({ account: payerAcc, chainId: chain.id, meter, channelId });
});

after(() => { server?.close(); anvil?.kill(); });

const url = () => `http://127.0.0.1:${server.address().port}/v1/answer`;

test('request without voucher gets 402', async () => {
  const r = await fetch(url());
  assert.equal(r.status, 402);
  assert.equal((await r.json()).header, HEADER);
});

test('three paid calls succeed, each charged exactly the price', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await payer.fetch(url(), {}, 10_000n);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).charged, '10000');
  }
  assert.equal(payer.spent, 30_000n);
});

test('replayed voucher is rejected', async () => {
  const best = guard.best.get(channelId);
  const { encodeVoucher } = await import('../index.js');
  const r = await fetch(url(), { headers: { [HEADER]: encodeVoucher({ channelId, ...best }) } });
  assert.equal(r.status, 402);
});

test('underpaying voucher is rejected', async () => {
  const cheap = createPayer({ account: payerAcc, chainId: chain.id, meter, channelId, startAt: payer.spent });
  const r = await fetch(url(), { headers: { [HEADER]: await cheap.pay(1n) } });
  assert.equal(r.status, 402);
});

test('voucher signed by someone else is rejected', async () => {
  const thief = createPayer({ account: svcAcc, chainId: chain.id, meter, channelId, startAt: payer.spent });
  const r = await fetch(url(), { headers: { [HEADER]: await thief.pay(10_000n) } });
  assert.equal((await r.json()).error, 'bad signature');
});

test('overspending the deposit is rejected', async () => {
  const greedy = createPayer({ account: payerAcc, chainId: chain.id, meter, channelId, startAt: payer.spent });
  const r = await fetch(url(), { headers: { [HEADER]: await greedy.pay(2_000_000n) } });
  assert.equal((await r.json()).error, 'insufficient channel balance');
});

test('service settles on-chain and payer gets the refund', async () => {
  const hash = await guard.settle(svcW, channelId, { close: true });
  await pub.waitForTransactionReceipt({ hash });
  assert.equal(await pub.readContract({ address: usdc, abi: mockAbi, functionName: 'balanceOf', args: [svcAcc.address] }), 30_000n);
  assert.equal(await pub.readContract({ address: usdc, abi: mockAbi, functionName: 'balanceOf', args: [payerAcc.address] }), 9_970_000n);
});
