/**
 * A model call that failed for a reason that may pass (throttling, a busy service, a dropped
 * stream). Retrying the same request can work; a validation error never will.
 */
export class TransientModelError extends Error {}
