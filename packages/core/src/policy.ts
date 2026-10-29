import { SECRET_RULES } from "./redact.ts";

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;
const TENANT_KEY = /^tenant[_-]?id$/i;

/** Returns why the arguments are refused, or undefined when they pass. Runs before schema checks. */
export function policyViolation(input: unknown, path = "$"): string | undefined {
  if (typeof input === "string") {
    if (input.includes("\0")) return `${path} contains a NUL byte`;
    if (TRAVERSAL.test(input)) return `${path} contains a path traversal`;
    // search() ignores the rules' global flag and lastIndex
    const secret = SECRET_RULES.find((rule) => input.search(rule.pattern) !== -1);
    if (secret) return `${path} contains a secret (${secret.label})`;
    return undefined;
  }
  if (Array.isArray(input)) {
    for (const [i, item] of input.entries()) {
      const violation = policyViolation(item, `${path}[${i}]`);
      if (violation) return violation;
    }
    return undefined;
  }
  if (input !== null && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      if (TENANT_KEY.test(key)) return `${path}.${key}: the tenant is set by the harness`;
      const violation = policyViolation(value, `${path}.${key}`);
      if (violation) return violation;
    }
  }
  return undefined;
}
