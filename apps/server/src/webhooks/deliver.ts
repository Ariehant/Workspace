/**
 * Sending a webhook (automations now, integrations later): an HTTPS POST of JSON, signed,
 * to a public address only.
 *
 * - The address is checked after DNS resolution, and the request connects to exactly the
 *   address that was checked (no second lookup a rebinding DNS server could change).
 *   Loopback, private, link-local, CGNAT, multicast and reserved addresses are refused
 *   (cloud metadata services among them), unless the server allows its own network.
 * - No redirects are followed; a 10 s timeout; at most 1 MB sent, and only the first 4 KB
 *   of the response is read (for run logs).
 * - `X-Notion-Signature: sha256=<hex HMAC of the body>` with the hook's secret, as
 *   Notion signs its webhooks, so receivers written for it work.
 */
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { PermanentJobError } from '../jobs/runner';

export interface WebhookOptions {
  allowPrivate: boolean;
  allowHttp: boolean;
  timeoutMs?: number;
}

export interface Delivery {
  status: number;
  /** The start of the response body. */
  body: string;
}

const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024;
const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'x-notion-signature',
]);

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Is this address one a webhook may not reach (unless private ones are allowed)? */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1): judge the IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** Check a webhook URL before saving it (the same rules, without resolving). */
export function webhookUrlProblem(raw: string, options: WebhookOptions): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid address';
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return 'Webhooks must use https';
  }
  if (url.username || url.password) return 'No credentials in the address';
  return null;
}

export const signature = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * POST `payload` to `url`. Resolves with the response for any status (the caller decides
 * what a 500 means); throws `PermanentJobError` for an address that may never be reached,
 * and a plain error for network failures (worth retrying).
 */
export async function deliver(
  url: string,
  payload: unknown,
  secret: string,
  headers: Record<string, string>,
  options: WebhookOptions,
): Promise<Delivery> {
  const problem = webhookUrlProblem(url, options);
  if (problem) throw new PermanentJobError(problem);
  const target = new URL(url);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_BODY) throw new PermanentJobError('The payload is too large');

  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(`No address for ${host}`);
  const chosen = addresses[0]!;
  if (!options.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new PermanentJobError(`${host} is a private address`);
  }

  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(name.toLowerCase()) && /^[\w-]{1,64}$/.test(name)) {
      extra[name] = String(value).slice(0, 1000);
    }
  }
  const client = target.protocol === 'https:' ? https : http;
  return new Promise<Delivery>((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: 'POST',
        // Connect to the address that was checked, whatever DNS says now.
        lookup: (_hostname, _opts, callback) => {
          const cb = callback as (e: Error | null, address: string, family: number) => void;
          cb(null, chosen.address, chosen.family);
        },
        headers: {
          ...extra,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'Workspace-Webhooks/1',
          'x-notion-signature': signature(secret, body),
        },
        timeout: options.timeoutMs ?? 10_000,
      },
      (response) => {
        let received = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (received.length < MAX_RESPONSE) received += chunk;
          if (received.length >= MAX_RESPONSE) response.destroy();
        });
        const done = () =>
          resolve({ status: response.statusCode ?? 0, body: received.slice(0, MAX_RESPONSE) });
        response.on('end', done);
        response.on('close', done);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
