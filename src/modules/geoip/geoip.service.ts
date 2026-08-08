import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { Reader, type City, type ReaderModel } from "@maxmind/geoip2-node";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";

export type GeoIpLocation = {
  source: "ip";
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
  countryCode?: string;
};

type GeoIpReader = Pick<ReaderModel, "city">;
type GeoIpReaderFactory = (dbPath: string) => Promise<GeoIpReader>;

const internalIpBlockList = new BlockList();
internalIpBlockList.addSubnet("0.0.0.0", 8, "ipv4");
internalIpBlockList.addSubnet("10.0.0.0", 8, "ipv4");
internalIpBlockList.addSubnet("100.64.0.0", 10, "ipv4");
internalIpBlockList.addSubnet("127.0.0.0", 8, "ipv4");
internalIpBlockList.addSubnet("169.254.0.0", 16, "ipv4");
internalIpBlockList.addSubnet("172.16.0.0", 12, "ipv4");
internalIpBlockList.addSubnet("192.0.0.0", 24, "ipv4");
internalIpBlockList.addSubnet("192.0.2.0", 24, "ipv4");
internalIpBlockList.addSubnet("192.168.0.0", 16, "ipv4");
internalIpBlockList.addSubnet("198.18.0.0", 15, "ipv4");
internalIpBlockList.addSubnet("198.51.100.0", 24, "ipv4");
internalIpBlockList.addSubnet("203.0.113.0", 24, "ipv4");
internalIpBlockList.addSubnet("224.0.0.0", 4, "ipv4");
internalIpBlockList.addSubnet("240.0.0.0", 4, "ipv4");
internalIpBlockList.addAddress("::", "ipv6");
internalIpBlockList.addAddress("::1", "ipv6");
internalIpBlockList.addSubnet("64:ff9b:1::", 48, "ipv6");
internalIpBlockList.addSubnet("100::", 64, "ipv6");
internalIpBlockList.addSubnet("2001:2::", 48, "ipv6");
internalIpBlockList.addSubnet("2001:db8::", 32, "ipv6");
internalIpBlockList.addSubnet("fc00::", 7, "ipv6");
internalIpBlockList.addSubnet("fe80::", 10, "ipv6");
internalIpBlockList.addSubnet("ff00::", 8, "ipv6");

const ipv4MappedIpv6Pattern = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

const trimDisplayName = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

export const normalizeClientIp = (rawIp: string | null | undefined): string | null => {
  const trimmed = rawIp?.trim();

  if (!trimmed) {
    return null;
  }

  const mappedIpv4 = trimmed.match(ipv4MappedIpv6Pattern)?.[1];
  const candidate = mappedIpv4 ?? trimmed;

  return isIP(candidate) ? candidate : null;
};

export const isInternalClientIp = (ip: string): boolean => {
  const version = isIP(ip);

  if (version === 4) {
    return internalIpBlockList.check(ip, "ipv4");
  }

  if (version === 6) {
    return internalIpBlockList.check(ip, "ipv6");
  }

  return true;
};

export const getPublicClientIp = (rawIp: string | null | undefined): string | null => {
  const ip = normalizeClientIp(rawIp);

  if (!ip || isInternalClientIp(ip)) {
    return null;
  }

  return ip;
};

export class GeoIpService {
  private readerPromise?: Promise<GeoIpReader | null>;

  public constructor(
    private readonly dbPath: string | undefined = env.GEOIP_DB_PATH,
    private readonly openReader: GeoIpReaderFactory = (path) => Reader.open(path),
  ) {}

  public async lookup(rawIp: string | null | undefined): Promise<GeoIpLocation | null> {
    const ip = getPublicClientIp(rawIp);

    if (!ip) {
      return null;
    }

    const reader = await this.getReader();

    if (!reader) {
      return null;
    }

    try {
      return this.toLocation(reader.city(ip));
    } catch (error) {
      logger.debug({ err: error }, "GeoIP lookup unavailable");
      return null;
    }
  }

  private async getReader(): Promise<GeoIpReader | null> {
    if (!this.readerPromise) {
      this.readerPromise = this.openConfiguredReader();
    }

    return this.readerPromise;
  }

  private async openConfiguredReader(): Promise<GeoIpReader | null> {
    if (!this.dbPath || !existsSync(this.dbPath)) {
      return null;
    }

    try {
      return await this.openReader(this.dbPath);
    } catch (error) {
      logger.warn({ err: error }, "GeoIP database unavailable");
      return null;
    }
  }

  private toLocation(record: City | null | undefined): GeoIpLocation | null {
    if (!record) {
      return null;
    }

    const subdivision = record.subdivisions?.[0];
    const country = record.country ?? record.registeredCountry;
    const location: GeoIpLocation = {
      source: "ip",
      city: trimDisplayName(record.city?.names.en),
      region: trimDisplayName(subdivision?.names.en),
      regionCode: trimDisplayName(subdivision?.isoCode),
      country: trimDisplayName(country?.names.en),
      countryCode: trimDisplayName(country?.isoCode),
    };

    if (!location.city && !location.region && !location.regionCode && !location.country && !location.countryCode) {
      return null;
    }

    return location;
  }
}
