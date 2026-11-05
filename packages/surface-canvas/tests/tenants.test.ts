/**
 * Which client a send is for: what the file remembers, and when a send must wait
 * for the designer to choose.
 */
import { describe, expect, it } from "vitest";
import { chooseTenant, tenantBlocker, type TenantsView } from "../src/auth/tenants.js";

const PBKS = { code: "pbks", name: "Punjab Kings" };
const KKR = { code: "kkr", name: "KKR" };

describe("chooseTenant", () => {
  it("uses the client the file remembers when the person can still send for it", () => {
    expect(chooseTenant([PBKS, KKR], "kkr")).toBe("kkr");
  });

  it("forgets a remembered client that is no longer on the list", () => {
    expect(chooseTenant([PBKS, KKR], "rcb")).toBeNull();
  });

  it("picks the only client there is", () => {
    expect(chooseTenant([PBKS], null)).toBe("pbks");
    expect(chooseTenant([PBKS], "rcb")).toBe("pbks");
  });

  it("leaves several clients to the designer, and none to nobody", () => {
    expect(chooseTenant([PBKS, KKR], null)).toBeNull();
    expect(chooseTenant([], "pbks")).toBeNull();
  });
});

describe("tenantBlocker", () => {
  const ready = (tenants: Array<typeof PBKS>, selected: string | null): TenantsView => ({
    status: "ready",
    tenants,
    selected,
  });

  it("lets a send go only when a client is chosen", () => {
    expect(tenantBlocker(ready([PBKS, KKR], "pbks"))).toBeNull();
  });

  it("says what to do in every state that blocks", () => {
    expect(tenantBlocker({ status: "idle" })).toMatch(/Connect your account/);
    expect(tenantBlocker({ status: "loading" })).toMatch(/Loading/);
    expect(tenantBlocker({ status: "error", message: "offline" })).toMatch(/offline/);
    expect(tenantBlocker(ready([PBKS, KKR], null))).toMatch(/Choose the client/);
    expect(tenantBlocker(ready([], null))).toMatch(/Ask an admin/);
  });
});
