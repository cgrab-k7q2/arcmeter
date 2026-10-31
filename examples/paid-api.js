// A tiny paid API: every request must carry an ArcMeter voucher worth PRICE micro-USDC.
// Usage: METER=0x… PAYEE=0x… [NETWORK=testnet|mainnet] [PRICE=10000] node examples/paid-api.js
import http from 'node:http';
import { createPublicClient, http as httpT } from 'viem';
import { arcMainnet, arcTestnet, createMeterGuard, meterMiddleware } from '../sdk/index.js';

const chain = process.env.NETWORK === 'mainnet' ? arcMainnet : arcTestnet;
const price = BigInt(process.env.PRICE || 10_000); // 0.01 USDC
const guard = createMeterGuard({
  publicClient: createPublicClient({ chain, transport: httpT() }),
  chainId: chain.id, meter: process.env.METER, payee: process.env.PAYEE, price,
});
const paid = meterMiddleware(guard, price);
http.createServer((req, res) => paid(req, res, () => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ quote: 'USDC is gas on Arc.', charged: req.arcmeter.charged.toString() }));
})).listen(process.env.PORT || 8787, () => console.log(`paid API on :${process.env.PORT || 8787}, ${price} micro-USDC per call`));
