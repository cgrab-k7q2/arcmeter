// An "agent" that pays the paid API per call using an already-open channel.
// Usage: AGENT_KEY_FILE=… METER=0x… CHANNEL=0x… API=http://localhost:8787 node examples/agent.js
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { arcMainnet, arcTestnet, createPayer } from '../sdk/index.js';

const chain = process.env.NETWORK === 'mainnet' ? arcMainnet : arcTestnet;
const pk = JSON.parse(readFileSync(process.env.AGENT_KEY_FILE)).private_key;
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const payer = createPayer({ account, chainId: chain.id, meter: process.env.METER, channelId: process.env.CHANNEL, startAt: BigInt(process.env.SPENT || 0) });
for (let i = 0; i < 3; i++) {
  const r = await payer.fetch(process.env.API || 'http://localhost:8787', {}, BigInt(process.env.PRICE || 10_000));
  console.log(r.status, await r.text());
}
console.log('spent (micro-USDC):', payer.spent.toString());
