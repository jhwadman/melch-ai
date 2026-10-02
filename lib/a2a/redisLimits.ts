/**
 * lib/a2a/redisLimits.ts — the request limits in Redis (ADR 0021 item 5).
 *
 * The server's two limiters (task submissions, failed logins) count in the
 * process by default, so each replica keeps its own count and N replicas
 * allow N times the limit. With a Redis store every replica counts against
 * one shared window. (Budgets need no Redis: they are Postgres counters,
 * ADR 0026. An adopter may also turn limits off and let a gateway enforce
 * them.)
 *
 * The store speaks to Redis through one function, `command(args)`, so it
 * needs no Redis client of its own:
 *
 *   node-redis:  redisRateLimitStore({ command: (a) => client.sendCommand(a) })
 *   ioredis:     redisRateLimitStore({ command: ([c, ...a]) => client.call(c, ...a) })
 *
 * Each increment is one Lua script (INCR, set the expiry on the first hit,
 * read the time left), so concurrent replicas never lose a hit or leave a
 * counter without an expiry.
 */
import type { Options, Store, IncrementResponse } from 'express-rate-limit';

export type RedisCommand = (args: string[]) => Promise<unknown>;

const INCREMENT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {n, t}`;

export function redisRateLimitStore(options: { command: RedisCommand; prefix?: string }): Store {
  const prefix = options.prefix ?? 'melchizedek:rl:';
  let windowMs = 60_000;
  const key = (k: string) => `${prefix}${k}`;
  return {
    // Counts are shared across processes: say so, so express-rate-limit does
    // not warn about a per-process store behind a load balancer.
    localKeys: false,
    prefix,
    init(o: Options) {
      windowMs = o.windowMs;
    },
    async increment(k: string): Promise<IncrementResponse> {
      const out = (await options.command(['EVAL', INCREMENT, '1', key(k), String(windowMs)])) as [number | string, number | string];
      const hits = Number(out?.[0] ?? 0);
      const ttl = Number(out?.[1] ?? windowMs);
      return { totalHits: hits, resetTime: new Date(Date.now() + Math.max(0, ttl)) };
    },
    async decrement(k: string): Promise<void> {
      await options.command(['DECR', key(k)]);
    },
    async resetKey(k: string): Promise<void> {
      await options.command(['DEL', key(k)]);
    },
  };
}
