/** Standalone agent: `bun run demo:agent` against a running `bun run demo:server`. */
import { runAgent } from './agent'

const url = process.env.DEMO_API_URL ?? 'http://127.0.0.1:8402'
const { channelId, cumulative } = await runAgent(url)
console.log(`Done. Channel ${channelId} holds vouchers up to ${cumulative} base units. Stop the server with Ctrl+C to claim.`)
