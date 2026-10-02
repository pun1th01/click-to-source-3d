declare const process: { env: { NODE_ENV?: string } };

/**
 * True unless a bundler has told us this is a production build.
 *
 * Written as a bare `process.env.NODE_ENV` read because that is the literal
 * every bundler substitutes; routing it through a variable would defeat the
 * substitution. The catch covers an unbundled consumer, where `process` is
 * simply not defined — treated as development, since the alternative is a
 * ReferenceError inside a component.
 *
 * Every component in this package is a development tool, and each renders
 * nothing when this is false. A consumer who mounts them unconditionally
 * would otherwise ship a live panel, a render-loop takeover and — for the
 * bridge — an EventSource retrying a dev-server endpoint that does not exist
 * in production, every few seconds, for as long as the page is open.
 */
export const DEV = (() => {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();
