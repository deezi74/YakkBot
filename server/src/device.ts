import { db, now } from './db.js';

/**
 * The YakkBot Android app's phone bridge. The app runs a small server on 127.0.0.1 that can read the
 * screen, tap, swipe, type, open apps and read notifications. It tells this server its port and token
 * when the owner opens the app while signed in ("pairing"); from then on the bots' `device` tool
 * calls it. Both ends are on the same phone, and the address is fixed to loopback here.
 */

db.exec(`CREATE TABLE IF NOT EXISTS device_bridge (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  port INTEGER NOT NULL,
  token TEXT NOT NULL,
  info TEXT,
  paired_at INTEGER NOT NULL
)`);

interface Pairing { port: number; token: string; info: any; pairedAt: number }

export function pairing(): Pairing | null {
  const r = db.prepare('SELECT * FROM device_bridge WHERE id=1').get() as any;
  if (!r) return null;
  let info: any = {};
  try { info = JSON.parse(r.info ?? '{}'); } catch { /* keep empty */ }
  return { port: r.port, token: r.token, info, pairedAt: r.paired_at };
}

export function pair(port: number, token: string, info: unknown) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('bad port');
  if (!/^[0-9a-f]{32,128}$/.test(token)) throw new Error('bad token');
  db.prepare(`INSERT INTO device_bridge(id,port,token,info,paired_at) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET port=excluded.port, token=excluded.token, info=excluded.info, paired_at=excluded.paired_at`)
    .run(port, token, JSON.stringify(info ?? {}), now());
  seen = { at: 0, ok: false };
}

export function unpair() {
  db.prepare('DELETE FROM device_bridge WHERE id=1').run();
  seen = { at: 0, ok: false };
}

export class BridgeError extends Error {}

/** Call the phone bridge. Throws BridgeError with a message meant for the model (and the user). */
export async function bridge(path: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
  const p = pairing();
  if (!p) throw new BridgeError('The YakkBot Android app is not connected. The owner needs to install it and open it once.');
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${p.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    seen = { at: Date.now(), ok: false };
    throw new BridgeError('The YakkBot Android app is not answering. The owner needs to open the YakkBot app (Android may have stopped it).');
  }
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new BridgeError('The YakkBot Android app no longer accepts this server. The owner needs to open the app once to reconnect.');
  if (!res.ok) throw new BridgeError(String(json?.error ?? `The phone bridge answered ${res.status}.`));
  seen = { at: Date.now(), ok: true };
  return json;
}

let seen: { at: number; ok: boolean } = { at: 0, ok: false };

/** Paired, and it answered recently (or answers now). Cheap enough to call when building the tool list. */
export function bridgeUsable(): boolean {
  if (!pairing()) return false;
  if (Date.now() - seen.at > 60_000) void bridge('/status', {}, 2500).catch(() => {});
  // Offer the tool whenever the app is paired: if the app is asleep, the tool's own error says how to wake it.
  return true;
}

export async function bridgeStatus(): Promise<{ paired: boolean; reachable: boolean; info: any }> {
  const p = pairing();
  if (!p) return { paired: false, reachable: false, info: null };
  try {
    return { paired: true, reachable: true, info: await bridge('/status', {}, 2500) };
  } catch {
    return { paired: true, reachable: false, info: p.info };
  }
}
