/**
 * Starting a sign-in from the panel.
 *
 * The PKCE verifier is made HERE, in the iframe, because only the iframe is
 * promised `crypto.getRandomValues`; the sandbox does the network and never sees
 * randomness it did not hash itself. The verifier goes to the sandbox once, over
 * postMessage inside this plugin, and only its hash ever reaches the server.
 */
import { verifierFromBytes } from "../auth/pkce.js";
import { send } from "./main.js";

export function connect(): void {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  send({ type: "auth-start", verifier: verifierFromBytes(bytes) });
}
