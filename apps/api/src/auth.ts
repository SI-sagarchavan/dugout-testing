import type { TenantRegistry } from "@dugout/core";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "dugout-local";
const AUDIENCE = "dugout-api";
export const LOCAL_DEV_SECRET = "dugout-local-dev-secret-not-for-production";

export interface Identity {
  subject: string;
  tenantId: string;
}

const key = (secret: string) => new TextEncoder().encode(secret);

/**
 * Local stand-in for FanOS auth: an HS256 token with a `tenant_id` claim. Only the key source
 * changes when real tokens arrive; the tenant still comes from a verified claim.
 */
export async function issueToken(opts: {
  secret: string;
  subject: string;
  tenantId: string;
  ttl?: string;
}): Promise<string> {
  return new SignJWT({ tenant_id: opts.tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.ttl ?? "8h")
    .sign(key(opts.secret));
}

export async function verifyToken(
  token: string,
  secret: string,
  tenants: TenantRegistry,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  const tenantId = payload.tenant_id;
  if (typeof tenantId !== "string" || !payload.sub)
    throw new Error("token lacks tenant or subject");
  tenants.require(tenantId);
  return { subject: payload.sub, tenantId };
}
