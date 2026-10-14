import { lookup } from "node:dns/promises";
import net from "node:net";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_PRIVATE: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    // IPv4 embedded in IPv6: dotted (::ffff:1.2.3.4) or the hex form Node's URL parser produces (::ffff:7f00:1), also NAT64.
    const dotted = v.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = v.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return v === "::" || v === "::1" || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("ff");
  }
  return false;
}

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * Validate and normalise a user-supplied target URL.
 * Rejects non-http(s), credentials in the URL, non-default ports, internal hostnames and private IPs,
 * and applies the operator's ALLOWED_DOMAINS / BLOCKED_DOMAINS policy.
 */
export function validateTargetUrl(raw: unknown, cfg: Pick<Config, "allowedDomains" | "blockedDomains">): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new HttpError(400, "invalid_url", "url must be a non-empty string up to 2048 characters.");
  }
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new HttpError(400, "invalid_url", "url is not a valid absolute URL."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "invalid_url", "Only http and https URLs are allowed.");
  if (u.username || u.password) throw new HttpError(400, "invalid_url", "URLs containing credentials are not allowed.");
  if (u.port && !(u.protocol === "https:" && u.port === "443") && !(u.protocol === "http:" && u.port === "80")) {
    throw new HttpError(400, "invalid_url", "Non-standard ports are not allowed.");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new HttpError(400, "invalid_url", "url has no hostname.");
  const isIp = net.isIP(host) !== 0;
  if (isIp ? isPrivateAddress(host) : (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes("."))) {
    throw new HttpError(400, "blocked_target", "Private, local and internal addresses are not allowed.");
  }
  if (cfg.blockedDomains.some((d) => hostMatches(host, d))) throw new HttpError(403, "blocked_domain", "This domain is blocked by the operator's policy.");
  if (cfg.allowedDomains.length && !cfg.allowedDomains.some((d) => hostMatches(host, d))) {
    throw new HttpError(403, "domain_not_allowed", "This domain is not on the operator's allow-list.");
  }
  u.hash = "";
  return u.toString();
}

/** Extra defence for self-hosted Firecrawl inside your network: refuse hostnames that resolve to private IPs. */
export async function assertPublicDns(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return;
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new HttpError(400, "unresolvable_host", "Hostname could not be resolved."); }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "blocked_target", "Hostname resolves to a private address.");
}
