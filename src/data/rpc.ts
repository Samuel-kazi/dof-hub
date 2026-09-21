import { getTick } from "./store";

// When the app is signed in to the server, every change a person makes is also sent there as a call:
// the name of the function and what it was given. The server runs the same function with the same
// rules, checks who is asking, and saves the result. The person sees the change straight away, and
// the server has the final say.

export interface Call { name: string; args: unknown[] }

let sink: ((c: Call) => void) | null = null;
let blockedMessage: string | null = null;
let depth = 0;

/** Turns recording on. Passing null turns it off, which is how the local demo runs. */
export function setRpcSink(next: ((c: Call) => void) | null, blocked: string | null = null): void {
  sink = next;
  blockedMessage = blocked;
}

type AnyFn = (...a: unknown[]) => unknown;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Wraps a service function so that a call which changes data is recorded. Reads pass straight through. */
export function rpc<F extends (...a: never[]) => unknown>(name: string, fn: F): F {
  const wrapped = ((...args: unknown[]) => {
    if (!sink || depth > 0) return (fn as unknown as AnyFn)(...args);
    const snapshot = clone(args);
    const before = getTick();
    depth++;
    try {
      const out = (fn as unknown as AnyFn)(...args);
      if (getTick() !== before) sink({ name, args: snapshot });
      return out;
    } finally {
      depth--;
    }
  }) as unknown as F;
  return wrapped;
}

/** For functions that must only run on the server, such as anything that touches passwords. */
export function serverOnly<F extends (...a: never[]) => unknown>(name: string, fn: F): F {
  return ((...args: unknown[]) => {
    if (sink) throw new Error(blockedMessage ?? `${name} is handled by the server.`);
    return (fn as unknown as AnyFn)(...args);
  }) as unknown as F;
}
