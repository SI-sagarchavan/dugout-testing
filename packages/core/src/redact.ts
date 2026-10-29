export interface RedactionRule {
  label: string;
  pattern: RegExp; // must be global
}

export const SECRET_RULES: RedactionRule[] = [
  { label: "jwt", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },
  { label: "api_key", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
  { label: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
];

// Order matters: Aadhaar (12 digits) runs before phone (10 digits) so a phone match never splits one.
export const PII_RULES: RedactionRule[] = [
  { label: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: "pan", pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { label: "aadhaar", pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { label: "phone", pattern: /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g },
  { label: "phone", pattern: /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,13}\b/g },
];

export interface Redactor {
  text(value: string): string;
  /** Redacts every string inside a JSON-like value; keys are left alone. */
  value<T>(value: T): T;
}

export function createRedactor(rules: RedactionRule[] = [...SECRET_RULES, ...PII_RULES]): Redactor {
  const text = (value: string) =>
    rules.reduce((out, rule) => out.replace(rule.pattern, `[REDACTED:${rule.label}]`), value);

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return { text, value: <T>(value: T) => walk(value) as T };
}
