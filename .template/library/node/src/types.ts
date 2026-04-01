/**
 * Public types exported by this library.
 * Keep this file focused on types consumers need.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
