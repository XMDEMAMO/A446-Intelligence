import { isIP } from "node:net";

const MAX_FORWARDED_HOPS = 16;
const MAX_FORWARDED_HEADER_LENGTH = 4_096;

export function clientIpForRequest(request, authConfig = {}) {
  const peerText = normalizeAddress(request.socket?.remoteAddress);
  const peer = peerText ?? String(request.socket?.remoteAddress ?? "unknown");
  const trustedProxyRules = parseTrustedProxyRules(authConfig?.trustedProxyIps ?? authConfig?.trustedProxies);
  const peerAddress = parseAddress(peerText);
  if (!peerAddress || !isTrustedProxy(peerAddress, trustedProxyRules)) return peer;

  const forwardedHeader = request.headers?.["x-forwarded-for"];
  const forwarded = Array.isArray(forwardedHeader) ? forwardedHeader.join(",") : forwardedHeader;
  if (typeof forwarded !== "string" || forwarded.length > MAX_FORWARDED_HEADER_LENGTH) return peer;

  const chain = forwarded.split(",").map((item) => item.trim());
  if (chain.length === 0 || chain.length > MAX_FORWARDED_HOPS || chain.some((item) => !parseAddress(item))) return peer;

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = parseAddress(chain[index]);
    if (!candidate) return peer;
    if (!isTrustedProxy(candidate, trustedProxyRules)) return candidate.text;
  }

  return peer;
}

function parseTrustedProxyRules(input) {
  if (!Array.isArray(input)) return [];
  return input.map(parseTrustedProxyRule).filter(Boolean);
}

function parseTrustedProxyRule(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  const separator = value.lastIndexOf("/");
  const addressText = separator < 0 ? value : value.slice(0, separator).trim();
  const address = parseAddress(addressText);
  if (!address) return null;
  const prefixLength = separator < 0 ? address.bits : Number(value.slice(separator + 1));
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > address.bits) return null;
  return { family: address.family, bits: address.bits, network: address.value, prefixLength };
}

function isTrustedProxy(address, rules) {
  return rules.some((rule) => {
    if (rule.family !== address.family) return false;
    const shift = BigInt(rule.bits - rule.prefixLength);
    return (address.value >> shift) === (rule.network >> shift);
  });
}

function normalizeAddress(input) {
  if (typeof input !== "string") return null;
  const parsed = parseAddress(input);
  return parsed?.text ?? null;
}

function parseAddress(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".").map(Number);
    const number = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    return { family: 4, bits: 32, value: number, text: value };
  }
  if (family !== 6) return null;

  const expanded = expandIpv6(value);
  if (!expanded) return null;
  const number = expanded.reduce((result, group) => (result << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
  if ((number >> 32n) === 0xffffn) {
    const ipv4 = number & 0xffff_ffffn;
    return {
      family: 4,
      bits: 32,
      value: ipv4,
      text: [24n, 16n, 8n, 0n].map((shift) => Number((ipv4 >> shift) & 0xffn)).join("."),
    };
  }
  return { family: 6, bits: 128, value: number, text: value.toLowerCase() };
}

function expandIpv6(input) {
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return null;
    const octets = value.slice(separator + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const ipv4Number = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    const high = (ipv4Number >> 16n).toString(16);
    const low = (ipv4Number & 0xffffn).toString(16);
    value = `${value.slice(0, separator + 1)}${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups;
}
