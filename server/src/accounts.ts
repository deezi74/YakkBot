import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';

/**
 * The owner's own accounts, connected directly (no third-party service in between):
 *  - email over IMAP/SMTP with an app password (Gmail, Yahoo, iCloud, Fastmail, most others)
 *  - GitHub with a personal access token
 * Credentials stay in this device's database. Bots use them through the email and github tools;
 * deleting mail, sending mail and deleting files on GitHub ask the owner first.
 */
db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

export interface EmailAccount { address: string; password: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }
export interface GithubAccount { token: string; login: string }

export const EMAIL_PRESETS: Record<string, { name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; help: string }> = {
  gmail: { name: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, help: 'Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords.' },
  yahoo: { name: 'Yahoo', imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, help: 'Yahoo Account Security › Generate app password.' },
  icloud: { name: 'iCloud', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, help: 'appleid.apple.com › Sign-In and Security › App-Specific Passwords.' },
  fastmail: { name: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465, help: 'Settings › Privacy & Security › App passwords.' },
  aol: { name: 'AOL', imapHost: 'imap.aol.com', imapPort: 993, smtpHost: 'smtp.aol.com', smtpPort: 465, help: 'Account Security › Generate app password.' },
  other: { name: 'Other (IMAP)', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, help: 'Use the IMAP and SMTP settings from your email provider.' },
};

interface Row { id: string; kind: 'email' | 'github'; label: string; data: string; created_at: number }
const rows = (kind?: string) => (kind ? db.prepare('SELECT * FROM accounts WHERE kind=? ORDER BY created_at').all(kind) : db.prepare('SELECT * FROM accounts ORDER BY created_at').all()) as unknown as Row[];

export function listAccounts() {
  return rows().map((r) => ({ id: r.id, kind: r.kind, label: r.label, createdAt: r.created_at }));
}
export const emailAccounts = (): (EmailAccount & { id: string })[] => rows('email').map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
export const githubAccount = (): GithubAccount | null => { const r = rows('github')[0]; return r ? JSON.parse(r.data) : null; };
export const hasEmail = () => rows('email').length > 0;
export const hasGithub = () => rows('github').length > 0;
export function removeAccount(id: string) { db.prepare('DELETE FROM accounts WHERE id=?').run(id); }

// ---------- email ----------

async function imap<T>(a: EmailAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: a.imapHost, port: a.imapPort, secure: a.imapPort === 993, auth: { user: a.address, pass: a.password }, logger: false, socketTimeout: 60_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

export async function addEmail(p: { preset?: string; address: string; password: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number }) {
  const pre = EMAIL_PRESETS[p.preset ?? 'other'] ?? EMAIL_PRESETS.other;
  const a: EmailAccount = {
    address: String(p.address ?? '').trim(), password: String(p.password ?? '').replace(/\s+/g, ''),
    imapHost: String(p.imapHost || pre.imapHost).trim(), imapPort: Number(p.imapPort || pre.imapPort),
    smtpHost: String(p.smtpHost || pre.smtpHost).trim(), smtpPort: Number(p.smtpPort || pre.smtpPort),
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address)) throw new Error('Enter the full email address.');
  if (!a.password) throw new Error('Paste the app password.');
  if (!a.imapHost || !a.smtpHost) throw new Error('Enter the IMAP and SMTP servers from your provider.');
  // Sign in once to make sure it works before saving.
  try { await imap(a, async (c) => { await c.mailboxOpen('INBOX', { readOnly: true }); }); }
  catch (e: any) { throw new Error(`Could not sign in to ${a.address}: ${e?.responseText || e?.message || e}. Check the app password.`); }
  const old = emailAccounts().find((x) => x.address.toLowerCase() === a.address.toLowerCase());
  if (old) db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(a), old.id);
  else db.prepare('INSERT INTO accounts(id,kind,label,data,created_at) VALUES (?,?,?,?,?)').run(newId('acct'), 'email', a.address, JSON.stringify(a), now());
}

const pickEmail = (address?: string) => {
  const all = emailAccounts();
  if (!all.length) throw new Error('No email account is connected. The owner can add one in Settings › Accounts.');
  const a = address ? all.find((x) => x.address.toLowerCase() === String(address).toLowerCase()) : all[0];
  if (!a) throw new Error(`No connected account ${address}. Connected: ${all.map((x) => x.address).join(', ')}`);
  return a;
};

const uidList = (v: unknown): string => {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new Error('Give the message uids (from list).');
  return list.slice(0, 500).join(',');
};

async function specialFolder(c: ImapFlow, use: string, fallback: string): Promise<string> {
  const boxes = await c.list();
  return boxes.find((b) => b.specialUse === use)?.path ?? boxes.find((b) => b.name.toLowerCase() === fallback.toLowerCase())?.path ?? fallback;
}

export async function emailTool(a: any): Promise<{ output: string; isError?: boolean }> {
  const acct = pickEmail(a.account);
  const folder = String(a.folder || 'INBOX');
  switch (a.action) {
    case 'accounts': return { output: emailAccounts().map((x) => x.address).join('\n') };
    case 'folders': return imap(acct, async (c) => ({ output: (await c.list()).map((b) => `${b.path}${b.specialUse ? ` (${b.specialUse})` : ''}`).join('\n') }));
    case 'list': return imap(acct, async (c) => {
      const box = await c.mailboxOpen(folder, { readOnly: true });
      const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 200);
      const q: any = {};
      if (a.unread_only) q.seen = false;
      if (a.from) q.from = String(a.from);
      if (a.subject) q.subject = String(a.subject);
      if (a.text) q.body = String(a.text);
      if (a.since) q.since = new Date(String(a.since));
      if (a.before) q.before = new Date(String(a.before));
      let uids = Object.keys(q).length ? ((await c.search(q, { uid: true })) || []) : [];
      if (!Object.keys(q).length) {
        const start = Math.max(1, box.exists - limit + 1);
        if (!box.exists) return { output: `${folder} is empty.` };
        const out: string[] = [];
        for await (const m of c.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, size: true })) out.push(line(m));
        return { output: `${folder}: ${box.exists} messages. Newest ${out.length}:\n${out.reverse().join('\n')}` };
      }
      uids = uids.slice(-limit);
      if (!uids.length) return { output: 'No messages match.' };
      const out: string[] = [];
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, flags: true, size: true }, { uid: true })) out.push(line(m));
      return { output: `${uids.length} matching in ${folder}:\n${out.reverse().join('\n')}` };
    });
    case 'read': return imap(acct, async (c) => {
      await c.mailboxOpen(folder);
      const uid = Number(a.uid);
      const m = await c.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!m || !m.source) return { output: `No message ${uid} in ${folder}.`, isError: true };
      const raw = m.source.toString('utf8');
      const text = bodyText(raw);
      return { output: `From: ${addr(m.envelope?.from)}\nTo: ${addr(m.envelope?.to)}\nDate: ${m.envelope?.date?.toISOString?.() ?? ''}\nSubject: ${m.envelope?.subject ?? ''}\n\n${text.slice(0, 12_000)}` };
    });
    case 'mark': return imap(acct, async (c) => {
      await c.mailboxOpen(folder);
      const ids = uidList(a.uids);
      if (a.read === false) await c.messageFlagsRemove(ids, ['\\Seen'], { uid: true });
      else await c.messageFlagsAdd(ids, ['\\Seen'], { uid: true });
      if (a.flagged === true) await c.messageFlagsAdd(ids, ['\\Flagged'], { uid: true });
      return { output: 'Done.' };
    });
    case 'move': return imap(acct, async (c) => {
      await c.mailboxOpen(folder);
      const to = String(a.to ?? '').trim();
      if (!to) return { output: 'Say which folder to move them to (to).', isError: true };
      const exists = (await c.list()).some((b) => b.path === to);
      if (!exists) await c.mailboxCreate(to);
      await c.messageMove(uidList(a.uids), to, { uid: true });
      return { output: `Moved to ${to}.` };
    });
    case 'archive': return imap(acct, async (c) => {
      await c.mailboxOpen(folder);
      const to = await specialFolder(c, '\\Archive', acct.imapHost.includes('gmail') ? '[Gmail]/All Mail' : 'Archive');
      if (to.includes('All Mail')) await c.messageFlagsAdd(uidList(a.uids), ['\\Deleted'], { uid: true }).then(() => c.mailboxClose());
      else await c.messageMove(uidList(a.uids), to, { uid: true });
      return { output: 'Archived.' };
    });
    case 'delete': return imap(acct, async (c) => {
      await c.mailboxOpen(folder);
      const trash = await specialFolder(c, '\\Trash', acct.imapHost.includes('gmail') ? '[Gmail]/Trash' : 'Trash');
      const ids = uidList(a.uids);
      await c.messageMove(ids, trash, { uid: true });
      return { output: `Moved ${ids.split(',').length} message(s) to ${trash}. They can be restored from there.` };
    });
    case 'send': {
      const to = String(a.to ?? '').trim();
      if (!to || !a.subject) return { output: 'send needs to and subject.', isError: true };
      const t = nodemailer.createTransport({ host: acct.smtpHost, port: acct.smtpPort, secure: acct.smtpPort === 465, auth: { user: acct.address, pass: acct.password } });
      const r = await t.sendMail({ from: acct.address, to, cc: a.cc || undefined, subject: String(a.subject), text: String(a.text ?? ''), ...(a.in_reply_to ? { inReplyTo: String(a.in_reply_to), references: String(a.in_reply_to) } : {}) });
      return { output: `Sent (${r.messageId}).` };
    }
    default: return { output: 'Actions: accounts, folders, list, read, mark, move, archive, delete, send.', isError: true };
  }
}

const addr = (list: any[] | undefined) => (list ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
const line = (m: any) => `uid ${m.uid}${m.flags?.has('\\Seen') ? '' : ' [unread]'}${m.flags?.has('\\Flagged') ? ' [flagged]' : ''} | ${m.envelope?.date ? new Date(m.envelope.date).toISOString().slice(0, 16).replace('T', ' ') : ''} | ${addr(m.envelope?.from).slice(0, 60)} | ${(m.envelope?.subject ?? '(no subject)').slice(0, 120)}`;

/** A readable body from a raw message: the plain-text part if there is one, else the HTML with tags removed. */
function bodyText(raw: string): string {
  const decodeQP = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/);
  const pick = (type: string) => parts.find((p) => new RegExp(`content-type:\\s*${type}`, 'i').test(p.slice(0, 600)));
  const part = pick('text/plain') ?? pick('text/html') ?? raw;
  const split = part.search(/\r?\n\r?\n/);
  let body = split >= 0 ? part.slice(split).trim() : part;
  const head = split >= 0 ? part.slice(0, split) : '';
  if (/content-transfer-encoding:\s*base64/i.test(head)) { try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* keep */ } }
  else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) body = decodeQP(body);
  if (/text\/html/i.test(head) || /<html|<body|<div/i.test(body)) body = body.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- GitHub ----------

async function gh(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${process.env.YAKK_GITHUB_API ?? 'https://api.github.com'}${path}`, {
    method, signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'YakkBot', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${typeof j === 'object' && j?.message ? j.message : String(text).slice(0, 200)}`);
  return j;
}

export async function addGithub(token: string) {
  const t = String(token ?? '').trim();
  if (!t) throw new Error('Paste a GitHub token.');
  let me: any;
  try { me = await gh(t, 'GET', '/user'); } catch (e: any) { throw new Error(`GitHub did not accept that token (${e.message}).`); }
  db.prepare("DELETE FROM accounts WHERE kind='github'").run();
  db.prepare('INSERT INTO accounts(id,kind,label,data,created_at) VALUES (?,?,?,?,?)').run(newId('acct'), 'github', `github.com/${me.login}`, JSON.stringify({ token: t, login: me.login }), now());
  return me.login as string;
}

const repoOf = (acct: GithubAccount, repo: unknown) => {
  const r = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!r) throw new Error('Say which repository (repo).');
  return r.includes('/') ? r : `${acct.login}/${r}`;
};
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function githubTool(a: any): Promise<{ output: string; isError?: boolean }> {
  const acct = githubAccount();
  if (!acct) throw new Error('GitHub is not connected. The owner can add a token in Settings › Accounts.');
  const T = acct.token;
  switch (a.action) {
    case 'whoami': return { output: `Signed in as ${acct.login}.` };
    case 'list_repos': {
      const list = await gh(T, 'GET', '/user/repos?per_page=100&sort=updated');
      return { output: list.map((r: any) => `${r.full_name}${r.private ? ' (private)' : ''}${r.has_pages ? ' [pages]' : ''}: ${r.description ?? ''}`).join('\n') || 'No repositories.' };
    }
    case 'create_repo': {
      const r = await gh(T, 'POST', '/user/repos', { name: String(a.name ?? a.repo ?? '').trim(), description: a.description ?? '', private: !!a.private, auto_init: true });
      return { output: `Created ${r.full_name}: ${r.html_url}` };
    }
    case 'list_files': {
      const repo = repoOf(acct, a.repo);
      const list = await gh(T, 'GET', `/repos/${repo}/contents/${enc(String(a.path ?? ''))}${a.branch ? `?ref=${encodeURIComponent(a.branch)}` : ''}`);
      return { output: (Array.isArray(list) ? list : [list]).map((f: any) => `${f.type === 'dir' ? '[dir] ' : ''}${f.path}${f.size ? ` (${f.size} bytes)` : ''}`).join('\n') };
    }
    case 'read_file': {
      const repo = repoOf(acct, a.repo);
      const f = await gh(T, 'GET', `/repos/${repo}/contents/${enc(String(a.path ?? ''))}${a.branch ? `?ref=${encodeURIComponent(a.branch)}` : ''}`);
      return { output: Buffer.from(f.content ?? '', 'base64').toString('utf8').slice(0, 60_000) };
    }
    case 'write_files': {
      const repo = repoOf(acct, a.repo);
      const files: { path: string; content: string }[] = Array.isArray(a.files) ? a.files : a.path ? [{ path: a.path, content: a.content ?? '' }] : [];
      if (!files.length) return { output: 'Give files: [{path, content}].', isError: true };
      const done: string[] = [];
      for (const f of files.slice(0, 50)) {
        const path = enc(String(f.path).replace(/^\/+/, ''));
        let sha: string | undefined;
        try { sha = (await gh(T, 'GET', `/repos/${repo}/contents/${path}${a.branch ? `?ref=${encodeURIComponent(a.branch)}` : ''}`)).sha; } catch { /* new file */ }
        await gh(T, 'PUT', `/repos/${repo}/contents/${path}`, { message: a.message || `Update ${f.path}`, content: Buffer.from(String(f.content ?? '')).toString('base64'), ...(sha ? { sha } : {}), ...(a.branch ? { branch: a.branch } : {}) });
        done.push(f.path);
      }
      return { output: `Saved ${done.length} file(s) to ${repo}: ${done.join(', ')}` };
    }
    case 'delete_file': {
      const repo = repoOf(acct, a.repo);
      const path = enc(String(a.path ?? ''));
      const f = await gh(T, 'GET', `/repos/${repo}/contents/${path}`);
      await gh(T, 'DELETE', `/repos/${repo}/contents/${path}`, { message: a.message || `Delete ${a.path}`, sha: f.sha });
      return { output: `Deleted ${a.path}.` };
    }
    case 'publish_site': {
      // GitHub Pages: the repository's files become a website.
      const repo = repoOf(acct, a.repo);
      const branch = a.branch || (await gh(T, 'GET', `/repos/${repo}`)).default_branch;
      try { await gh(T, 'POST', `/repos/${repo}/pages`, { source: { branch, path: a.path === '/docs' ? '/docs' : '/' } }); }
      catch (e: any) { if (!/409|already/i.test(e.message)) throw e; }
      const p = await gh(T, 'GET', `/repos/${repo}/pages`);
      return { output: `Publishing ${repo} at ${p.html_url} (it can take a minute or two to appear).` };
    }
    case 'create_issue': {
      const repo = repoOf(acct, a.repo);
      const i = await gh(T, 'POST', `/repos/${repo}/issues`, { title: a.title, body: a.body ?? '' });
      return { output: `Opened ${i.html_url}` };
    }
    default: return { output: 'Actions: whoami, list_repos, create_repo, list_files, read_file, write_files, delete_file, publish_site, create_issue.', isError: true };
  }
}
