import net from "node:net";

export interface ValidateUrlTargetOptions {
	ssrfWhitelist?: string[];
	resolveHostname?: (hostname: string) => string[] | Promise<string[]>;
}

export async function validateUrlTarget(
	rawUrl: string,
	options: ValidateUrlTargetOptions = {},
): Promise<{ ok: boolean; error?: string }> {
	let target: URL;
	try {
		target = new URL(rawUrl);
	} catch {
		return { ok: false, error: `Invalid URL: ${rawUrl}` };
	}

	if (target.protocol !== "http:" && target.protocol !== "https:") {
		return {
			ok: false,
			error: `Unsupported URL scheme '${target.protocol}'.`,
		};
	}

	return validateResolvedUrl(target.toString(), options);
}

export async function validateResolvedUrl(
	rawUrl: string,
	options: ValidateUrlTargetOptions = {},
): Promise<{ ok: boolean; error?: string }> {
	let target: URL;
	try {
		target = new URL(rawUrl);
	} catch {
		return { ok: false, error: `Invalid URL: ${rawUrl}` };
	}

	const hostname = target.hostname;
	if (!hostname) {
		return { ok: false, error: "URL hostname is required." };
	}

	const addresses = await resolveTargetAddresses(hostname, options);
	if (addresses.length === 0) {
		return {
			ok: false,
			error: `Could not resolve hostname '${hostname}'.`,
		};
	}

	for (const address of addresses) {
		const blockedReason = getBlockedAddressReason(
			address,
			options.ssrfWhitelist ?? [],
		);
		if (blockedReason) {
			return {
				ok: false,
				error: blockedReason,
			};
		}
	}

	return { ok: true };
}

export async function containsInternalUrl(
	command: string,
	options: ValidateUrlTargetOptions = {},
): Promise<boolean> {
	const matches = command.match(/\bhttps?:\/\/[^\s"'<>]+/gi) ?? [];
	for (const match of matches) {
		const result = await validateUrlTarget(match, options);
		if (!result.ok) {
			return true;
		}
	}
	return false;
}

async function resolveTargetAddresses(
	hostname: string,
	options: ValidateUrlTargetOptions,
): Promise<string[]> {
	if (net.isIP(hostname)) {
		return [hostname];
	}

	if (!options.resolveHostname) {
		return [];
	}

	const resolved = await options.resolveHostname(hostname);
	return resolved.filter((value) => Boolean(value));
}

function getBlockedAddressReason(
	address: string,
	ssrfWhitelist: string[],
): string | null {
	const normalized = normalizeIp(address);
	if (!normalized) {
		return `Unrecognized IP address '${address}'.`;
	}

	if (isWhitelisted(normalized, ssrfWhitelist)) {
		return null;
	}

	if (isPrivateOrInternalAddress(normalized)) {
		return `Blocked internal network target '${address}'.`;
	}

	return null;
}

function isWhitelisted(ip: NormalizedIp, whitelist: string[]): boolean {
	for (const cidr of whitelist) {
		const parsed = parseCidr(cidr);
		if (!parsed || parsed.family !== ip.family) {
			continue;
		}
		if (isIpInCidr(ip, parsed)) {
			return true;
		}
	}
	return false;
}

function isPrivateOrInternalAddress(ip: NormalizedIp): boolean {
	const blocks = ip.family === 4 ? IPV4_BLOCKED_RANGES : IPV6_BLOCKED_RANGES;
	return blocks.some((cidr) => isIpInCidr(ip, cidr));
}

function normalizeIp(value: string): NormalizedIp | null {
	const family = net.isIP(value);
	if (family === 4) {
		return {
			family: 4,
			value: ipv4ToBigInt(value),
		};
	}
	if (family === 6) {
		return {
			family: 6,
			value: ipv6ToBigInt(value),
		};
	}
	return null;
}

function parseCidr(value: string): ParsedCidr | null {
	const [rawIp = "", prefixPart] = value.trim().split("/");
	const ip = normalizeIp(rawIp);
	if (!ip) {
		return null;
	}

	const maxPrefix = ip.family === 4 ? 32 : 128;
	const prefix = prefixPart ? Number.parseInt(prefixPart, 10) : maxPrefix;
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
		return null;
	}

	return {
		family: ip.family,
		value: ip.value,
		prefix,
	};
}

function isIpInCidr(ip: NormalizedIp, cidr: ParsedCidr): boolean {
	const totalBits = cidr.family === 4 ? 32n : 128n;
	const prefix = BigInt(cidr.prefix);
	if (prefix === 0n) {
		return true;
	}
	const hostBits = totalBits - prefix;
	const mask = ((1n << totalBits) - 1n) ^ ((1n << hostBits) - 1n);
	return (ip.value & mask) === (cidr.value & mask);
}

function ipv4ToBigInt(value: string): bigint {
	return value
		.split(".")
		.map((part) => BigInt(Number.parseInt(part, 10)))
		.reduce((acc, part) => (acc << 8n) + part, 0n);
}

function ipv6ToBigInt(value: string): bigint {
	const normalized = expandIpv6(value);
	return normalized
		.split(":")
		.map((part) => BigInt(Number.parseInt(part, 16)))
		.reduce((acc, part) => (acc << 16n) + part, 0n);
}

function expandIpv6(value: string): string {
	if (value.includes(".")) {
		const lastColon = value.lastIndexOf(":");
		const head = value.slice(0, lastColon);
		const tail = value.slice(lastColon + 1);
		const convertedTail = convertIpv4TailToIpv6(tail);
		return expandIpv6(`${head}:${convertedTail}`);
	}

	const [leftRaw, rightRaw] = value.split("::");
	const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
	const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
	if (!value.includes("::")) {
		return [...left, ...right].map((part) => part.padStart(4, "0")).join(":");
	}

	const missing = 8 - (left.length + right.length);
	const middle = Array.from({ length: Math.max(0, missing) }, () => "0000");
	return [...left, ...middle, ...right]
		.map((part) => part.padStart(4, "0"))
		.join(":");
}

function convertIpv4TailToIpv6(ipv4: string): string {
	const parts = ipv4.split(".").map((part) => Number.parseInt(part, 10));
	const [a = 0, b = 0, c = 0, d = 0] = parts;
	return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

type IpFamily = 4 | 6;

interface NormalizedIp {
	family: IpFamily;
	value: bigint;
}

interface ParsedCidr extends NormalizedIp {
	prefix: number;
}

const IPV4_BLOCKED_RANGES: ParsedCidr[] = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
]
	.map((cidr) => parseCidr(cidr))
	.filter((cidr): cidr is ParsedCidr => cidr !== null);

const IPV6_BLOCKED_RANGES: ParsedCidr[] = ["::1/128", "fc00::/7", "fe80::/10"]
	.map((cidr) => parseCidr(cidr))
	.filter((cidr): cidr is ParsedCidr => cidr !== null);
