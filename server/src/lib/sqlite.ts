import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * A thin wrapper over Node's built-in SQLite with the handful of better-sqlite3 calls the app uses
 * (prepare/run/get/all, exec, pragma, transaction). Built-in means nothing to compile, which is what
 * makes the server install cleanly on a phone (Termux, ARM64) as well as on a PC.
 */

type Param = string | number | bigint | Buffer | Uint8Array | null;

function bind(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export class Statement {
  constructor(private stmt: StatementSync) {}
  run(...params: unknown[]) { return this.stmt.run(...params.map(bind)); }
  get(...params: unknown[]): unknown { return this.stmt.get(...params.map(bind)); }
  all(...params: unknown[]): unknown[] { return this.stmt.all(...params.map(bind)); }
}

export class Database {
  private db: DatabaseSync;
  private cache = new Map<string, Statement>();
  private depth = 0;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
  }

  prepare(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = new Statement(this.db.prepare(sql));
      // Statements are reused; the cap only guards against SQL built from user input.
      if (this.cache.size < 500) this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string) { this.db.exec(sql); }

  pragma(text: string) { this.db.exec(`PRAGMA ${text}`); }

  /** Wrap a function so it runs inside a transaction (nested calls use savepoints). */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const name = `sp_${this.depth}`;
      this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const out = fn(...args);
        this.depth--;
        this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (e) {
        this.depth--;
        try { this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* already rolled back */ }
        throw e;
      }
    };
  }

  close() { this.db.close(); }
}
