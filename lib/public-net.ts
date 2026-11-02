/**
 * Fetching a URL a reader or an agent handed us, on the server, without being
 * turned against the server's own network: loopback, private ranges, cloud
 * metadata (169.254.169.254), and every IPv6 spelling of them.
 *
 * Two checks. `isPublicAddress` refuses anything but public unicast; IPv6 must
 * sit in 2000::/3, which leaves out IPv4 written as IPv6 (::ffff:127.0.0.1,
 * NAT64, ...). `publicFetch` applies the same check at connect time, to the
 * address the socket actually uses, so a hostname that resolves to a public
 * address for a pre-check and a private one a moment later (DNS rebinding)
 * still can't get through. Server-side only.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit, type Response } from "undici";

/** IPv4 special-use ranges (RFC 6890 and friends): never fetched. */
const V4_SPECIAL = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  V4_SPECIAL.addSubnet(net, bits, "ipv4");

/** Global unicast IPv6, less the parts of it that tunnel or embed IPv4 (Teredo, 6to4) or are reserved. */
const V6_GLOBAL = new BlockList();
V6_GLOBAL.addSubnet("2000::", 3, "ipv6");
const V6_SPECIAL = new BlockList();
for (const [net, bits] of [
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  V6_SPECIAL.addSubnet(net, bits, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !V4_SPECIAL.check(ip, "ipv4");
  if (v === 6) return V6_GLOBAL.check(ip, "ipv6") && !V6_SPECIAL.check(ip, "ipv6");
  return false;
}

/** What a refused connection throws, so callers can tell it from a site that is down. */
export class NotPublicError extends Error {
  readonly code = "ENOTPUBLIC";
}

/** dns.lookup for sockets, refusing a host if any of its addresses is not public. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, options.all ? [] : "");
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new NotPublicError(`${hostname} is not a public address.`), options.all ? [] : "");
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * Every socket this agent opens is checked, including for redirects undici follows itself:
 * a host given by name through guardedLookup, a host given as an IP (which never reaches
 * a lookup) here.
 */
const connectPublic = buildConnector({ lookup: guardedLookup } as buildConnector.BuildOptions);
const agent = new Agent({
  connect: (opts, callback) => {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host)) return callback(new NotPublicError(`${host} is not a public address.`), null);
    connectPublic(opts, callback);
  },
});

/** fetch for untrusted URLs: the same as fetch, but it only ever connects to public addresses. */
export function publicFetch(url: string | URL, init: Omit<RequestInit, "dispatcher"> = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: agent });
}

/** Whether a fetch failed because the address was refused, rather than the site being down. */
export function wasRefused(e: unknown): boolean {
  for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause) if (x instanceof NotPublicError) return true;
  return false;
}

export type { Response as PublicResponse } from "undici";
