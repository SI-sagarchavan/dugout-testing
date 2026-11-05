import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64Url, codeChallenge, sha256, sha256Async, verifierFromBytes } from "../src/auth/pkce.js";

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe("sha256, written out because the sandbox may not have crypto.subtle", () => {
  // FIPS 180-2 vectors. The 56-byte one forces a second padding block.
  it("matches the standard vectors", () => {
    expect(hex(sha256(ascii("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(ascii("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles input that is not a multiple of a block", () => {
    expect(hex(sha256(new Uint8Array(1000).fill(0x61)))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });
});

describe("PKCE", () => {
  // RFC 7636 appendix B.
  it("derives the RFC's challenge from the RFC's verifier", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a 43-character, URL-safe verifier from 32 bytes", () => {
    const verifier = verifierFromBytes(Uint8Array.from({ length: 32 }, (_, i) => i * 8));
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses too little randomness rather than making a guessable verifier", () => {
    expect(() => verifierFromBytes(new Uint8Array(16))).toThrow(/32/);
  });

  it("encodes base64url without padding", () => {
    expect(base64Url(ascii("f"))).toBe("Zg");
    expect(base64Url(ascii("fo"))).toBe("Zm8");
    expect(base64Url(ascii("foo"))).toBe("Zm9v");
    expect(base64Url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
  });
});

describe("sha256Async", () => {
  // Around the padding boundary (55/56/64), a view into a bigger buffer, and
  // sizes that cross several yield slices.
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 262_144, 262_144 + 77, 1_000_000])(
    "matches node's sha256 for %i bytes, and yields on big inputs",
    async (size) => {
      const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
      let ticks = 0;
      const out = await sha256Async(bytes, async () => {
        ticks++;
      });
      expect(hex(out)).toBe(createHash("sha256").update(bytes).digest("hex"));
      if (size >= 262_144 * 2) expect(ticks).toBeGreaterThan(0);
    },
  );

  it("hashes a view onto a larger buffer by its own bytes", async () => {
    const whole = new Uint8Array(500).map((_, i) => i & 0xff);
    const view = whole.subarray(13, 300);
    expect(hex(await sha256Async(view, async () => {}))).toBe(
      createHash("sha256").update(view).digest("hex"),
    );
  });
});
