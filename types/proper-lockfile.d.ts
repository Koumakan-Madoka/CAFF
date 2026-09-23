// Typed subset of proper-lockfile 4.x used by CAFF's auth store.
// index.js wraps the callback API: lock resolves to an async release function.
declare module 'proper-lockfile' {
  interface LockOptions {
    realpath?: boolean;
    retries?: number;
    stale?: number;
    onCompromised?: (error: NodeJS.ErrnoException) => void;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
}
