/**
 * Which client a send is for.
 *
 * One sign-in covers every client the person may send for, like the admin panel.
 * The plugin only remembers which of them THIS FILE is for, so reopening a club's
 * file does not ask again. The remembered choice is a convenience, never an
 * authorisation: it is dropped when the backend no longer lists it, and the
 * backend checks the client on every send regardless.
 *
 * PURE.
 */
import type { Tenant } from "./credentials.js";

export type TenantsView =
  /** Signed out: there is nothing to list. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; tenants: Tenant[]; selected: string | null }
  | { status: "error"; message: string };

/**
 * The client to preselect: the file's remembered one if the person can still
 * send for it, the only one if there is only one, otherwise nothing, so the
 * person chooses.
 */
export function chooseTenant(tenants: readonly Tenant[], remembered: string | null): string | null {
  if (remembered && tenants.some((tenant) => tenant.code === remembered)) return remembered;
  return tenants.length === 1 ? tenants[0]!.code : null;
}

/** The sentence a blocked Handoff gives for a client problem, or null when it can go. */
export function tenantBlocker(view: TenantsView): string | null {
  switch (view.status) {
    case "idle":
      return "Connect your account to send.";
    case "loading":
      return "Loading your clients…";
    case "error":
      return `Couldn’t load your clients: ${view.message}`;
    case "ready":
      if (view.tenants.length === 0) {
        return "Your account can’t send for any client yet. Ask an admin for Surface access.";
      }
      return view.selected ? null : "Choose the client you are sending for.";
  }
}
