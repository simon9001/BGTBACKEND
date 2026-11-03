import type { Context, Next } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { appLogger } from '../logger/logger.js';

/**
 * In-memory cache for read results, so pages answer in milliseconds instead of
 * waiting on SQL Server each time.
 *
 *   - Any successful save through the API clears the cache straight away, so
 *     nobody sees old data after a change (see invalidateOnWrite).
 *   - Results are refreshed in the background about once a minute, which also
 *     keeps time-based figures such as "days at step" current.
 *   - Identical requests arriving together share one database call.
 *
 * It lives inside the API process. If the API ever runs as several processes,
 * move this to a shared store such as Redis, or a save in one will not clear
 * the others.
 */

const FRESH_FOR_MS = 60_000;          // refreshed in the background after this
const FORGET_AFTER_MS = 30 * 60_000;  // entries nobody asked for lately are dropped
const MAX_ENTRIES = 500;
const REFRESH_EVERY_MS = 60_000;

interface Entry {
    load: () => Promise<unknown>;
    value?: unknown;
    hasValue: boolean;
    storedAt: number;
    lastUsedAt: number;
    pinned: boolean;   // kept warm even when nobody has asked for it lately
    loading?: Promise<unknown>;
}

const entries = new Map<string, Entry>();

// Bumped by every save, so a query that started before the save cannot store its old result
let generation = 0;

// Runs the query once, shares it with anyone asking meanwhile, and stores the result
const refresh = (key: string, entry: Entry): Promise<unknown> => {
    if (entry.loading) return entry.loading;

    const startedIn = generation;
    entry.loading = entry.load()
        .then((value) => {
            if (startedIn === generation) {
                entry.value = value;
                entry.hasValue = true;
                entry.storedAt = Date.now();
            }
            return value;
        })
        .finally(() => { entry.loading = undefined; });
    return entry.loading;
};

// Background refresh: a failure keeps the last good result and is only logged
const refreshQuietly = (key: string, entry: Entry) =>
    refresh(key, entry).catch((err) => appLogger.warn({ err, cache_key: key }, 'Background cache refresh failed'));

// Removes the entries used longest ago once the cache is full
const evictIfFull = () => {
    if (entries.size <= MAX_ENTRIES) return;
    const oldest = [...entries.entries()]
        .filter(([, entry]) => !entry.pinned)
        .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
        .slice(0, entries.size - MAX_ENTRIES);
    for (const [key] of oldest) entries.delete(key);
};

/**
 * Returns the cached result for `key`, running `load` only when there is none.
 * Treat the returned value as read-only: it is shared between requests.
 */
export const cached = async <T>(key: string, load: () => Promise<T>, options: { pinned?: boolean } = {}): Promise<T> => {
    let entry = entries.get(key);
    if (!entry) {
        entry = { load, hasValue: false, storedAt: 0, lastUsedAt: 0, pinned: false };
        entries.set(key, entry);
        evictIfFull();
    }
    entry.load = load;
    entry.lastUsedAt = Date.now();
    entry.pinned ||= options.pinned ?? false;

    if (!entry.hasValue) return refresh(key, entry) as Promise<T>;

    // Answer now; bring it up to date for the next request
    if (Date.now() - entry.storedAt > FRESH_FOR_MS) void refreshQuietly(key, entry);
    return entry.value as T;
};

/** Forgets every stored result and reloads the recently used ones in the background. */
export const invalidateCache = () => {
    generation++;
    for (const entry of entries.values()) {
        entry.hasValue = false;
        entry.value = undefined;
        entry.loading = undefined;
    }
    void reloadRecent();
};

// One at a time, so reloading does not compete with people using the app
const reloadRecent = async () => {
    const startedIn = generation;
    const recent = [...entries.entries()].sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt);
    for (const [key, entry] of recent) {
        if (startedIn !== generation) return; // another save happened: that one reloads instead
        if (!entry.hasValue) await refreshQuietly(key, entry);
    }
};

// Keeps results current and drops what nobody has used lately
const refreshDue = async () => {
    const now = Date.now();
    for (const [key, entry] of entries) {
        if (!entry.pinned && now - entry.lastUsedAt > FORGET_AFTER_MS) {
            entries.delete(key);
        } else if (now - entry.storedAt > FRESH_FOR_MS) {
            await refreshQuietly(key, entry);
        }
    }
};

/** Starts the background refresh. Does not keep the process alive on shutdown. */
export const startCacheRefresh = () => {
    setInterval(() => void refreshDue(), REFRESH_EVERY_MS).unref();
};

/**
 * Clears the cache after any successful save. Logging in is the one POST that
 * changes nothing the cached pages show.
 */
export const invalidateOnWrite = async (c: Context<AppEnv>, next: Next) => {
    await next();
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (isWrite && c.res.status < 400 && !c.req.path.endsWith('/auth/login')) {
        invalidateCache();
    }
};
