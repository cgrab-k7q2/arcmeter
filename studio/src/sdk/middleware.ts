import type { IncomingMessage, ServerResponse } from 'node:http'
import { VOUCHER_HEADER } from '../lib/arcmeter'
import type { CheckAccepted, MeterGuard } from './guard'

/** Request after the middleware accepted a voucher. */
export interface MeterRequest extends IncomingMessage {
  arcmeter?: CheckAccepted
}

export interface MeterMiddlewareOptions {
  /** Called after a voucher is accepted, before the handler runs. */
  onPaid?: (payment: CheckAccepted, req: MeterRequest) => void
}

const json = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

/**
 * Paywall for Node `http` and Express. Express: `app.use('/api', meterMiddleware(guard))`.
 * Plain http: `if (await meterMiddleware(guard)(req, res)) handle(req, res)`.
 * On success it sets `req.arcmeter` and calls `next()`; otherwise it answers 402 (or 503
 * if the chain cannot be queried) with the payment requirements and resolves `false`.
 */
export function meterMiddleware(guard: MeterGuard, options: MeterMiddlewareOptions = {}) {
  const need = guard.requirements()

  return async function meter(req: MeterRequest, res: ServerResponse, next?: (error?: unknown) => void): Promise<boolean> {
    let result
    try {
      result = await guard.check(req.headers[VOUCHER_HEADER])
    } catch (error) {
      if (next) next(error)
      else throw error
      return false
    }

    if (!result.ok) {
      res.statusCode = result.status
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-arcmeter-chain-id', String(need.chainId))
      res.setHeader('x-arcmeter-meter', need.meter)
      res.setHeader('x-arcmeter-payee', need.payee)
      res.setHeader('x-arcmeter-price', need.price.toString())
      if (result.required !== undefined) res.setHeader('x-arcmeter-required-cumulative', result.required.toString())
      res.end(
        json({
          error: result.status === 402 ? 'payment_required' : 'verification_unavailable',
          reason: result.reason,
          message: result.message,
          channelId: result.channelId,
          requiredCumulative: result.required,
          chainId: need.chainId,
          meter: need.meter,
          payee: need.payee,
          price: need.price,
        }),
      )
      return false
    }

    req.arcmeter = result
    res.setHeader('x-arcmeter-accepted', result.cumulative.toString())
    options.onPaid?.(result, req)
    next?.()
    return true
  }
}
