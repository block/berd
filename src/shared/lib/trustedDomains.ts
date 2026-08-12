const STORAGE_KEY = "goose_trusted_domains";

/**
 * Extract the registrable domain from a URL (e.g. "https://www.github.com/foo" → "github.com").
 * Returns null if the URL is invalid or has no hostname.
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Strip leading "www."
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return null;
  }
}

function loadUserTrustedDomains(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((d): d is string => typeof d === "string"));
  } catch {
    return new Set();
  }
}

function saveUserTrustedDomains(domains: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...domains]));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

/**
 * Check whether a domain is trusted (user-approved).
 */
export function isDomainTrusted(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return loadUserTrustedDomains().has(normalized);
}

/**
 * Check whether a URL's domain is trusted.
 */
export function isUrlTrusted(url: string): boolean {
  const domain = extractDomain(url);
  if (!domain) return false;
  return isDomainTrusted(domain);
}

/**
 * Add a domain to the user's trusted list.
 */
export function trustDomain(domain: string): void {
  const normalized = domain.toLowerCase();
  const domains = loadUserTrustedDomains();
  domains.add(normalized);
  saveUserTrustedDomains(domains);
}

/**
 * Remove a domain from the user's trusted list.
 */
export function untrustDomain(domain: string): void {
  const normalized = domain.toLowerCase();
  const domains = loadUserTrustedDomains();
  domains.delete(normalized);
  saveUserTrustedDomains(domains);
}

/**
 * Get all user-trusted domains (excludes defaults).
 */
export function getUserTrustedDomains(): string[] {
  return [...loadUserTrustedDomains()].sort();
}

/**
 * Clear all user-trusted domains.
 */
export function clearUserTrustedDomains(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}
