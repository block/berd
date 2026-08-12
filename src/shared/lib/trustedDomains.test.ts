import { describe, it, expect, beforeEach } from "vitest";
import {
  extractDomain,
  isDomainTrusted,
  isUrlTrusted,
  trustDomain,
  untrustDomain,
  getUserTrustedDomains,
  clearUserTrustedDomains,
} from "./trustedDomains";

describe("trustedDomains", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("extractDomain", () => {
    it("extracts domain from https URL", () => {
      expect(extractDomain("https://github.com/squareup/repo")).toBe(
        "github.com",
      );
    });

    it("extracts domain from http URL", () => {
      expect(extractDomain("http://example.com/path")).toBe("example.com");
    });

    it("strips www prefix", () => {
      expect(extractDomain("https://www.github.com/foo")).toBe("github.com");
    });

    it("returns null for invalid URL", () => {
      expect(extractDomain("not-a-url")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractDomain("")).toBeNull();
    });

    it("lowercases the domain", () => {
      expect(extractDomain("https://GitHub.COM/foo")).toBe("github.com");
    });
  });

  describe("isDomainTrusted", () => {
    it("returns false for domains not yet approved", () => {
      expect(isDomainTrusted("github.com")).toBe(false);
      expect(isDomainTrusted("evil.example.com")).toBe(false);
    });

    it("returns true for user-trusted domains", () => {
      trustDomain("mycompany.com");
      expect(isDomainTrusted("mycompany.com")).toBe(true);
    });

    it("is case-insensitive", () => {
      trustDomain("GitHub.COM");
      expect(isDomainTrusted("github.com")).toBe(true);
    });
  });

  describe("isUrlTrusted", () => {
    it("returns true for URLs with user-trusted domains", () => {
      trustDomain("github.com");
      expect(isUrlTrusted("https://github.com/squareup/repo")).toBe(true);
    });

    it("returns true for URLs with www prefix on trusted domains", () => {
      trustDomain("github.com");
      expect(isUrlTrusted("https://www.github.com/squareup/repo")).toBe(true);
    });

    it("returns false for URLs with untrusted domains", () => {
      expect(isUrlTrusted("https://phishing-site.com/login")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isUrlTrusted("not-a-url")).toBe(false);
    });
  });

  describe("trustDomain / untrustDomain", () => {
    it("adds and removes user-trusted domains", () => {
      trustDomain("custom.example.com");
      expect(isDomainTrusted("custom.example.com")).toBe(true);

      untrustDomain("custom.example.com");
      expect(isDomainTrusted("custom.example.com")).toBe(false);
    });

    it("persists across calls", () => {
      trustDomain("first.com");
      trustDomain("second.com");
      expect(getUserTrustedDomains()).toContain("first.com");
      expect(getUserTrustedDomains()).toContain("second.com");
    });
  });

  describe("clearUserTrustedDomains", () => {
    it("removes all user-trusted domains", () => {
      trustDomain("a.com");
      trustDomain("b.com");
      clearUserTrustedDomains();
      expect(getUserTrustedDomains()).toEqual([]);
    });
  });
});
