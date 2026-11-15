import { useEffect, useState } from 'react';

interface Ctx { chosen: number; auto: number; current: number; choices: number[] }
const k = (n: number) => `${Math.round(n / 1024)}K`;

/** How much an on-device model can hold at once (its context, in tokens). */
export function PhoneCtxSetting() {
  const [c, setC] = useState<Ctx | null>(null);
  useEffect(() => { fetch('/api/phone-ctx', { credentials: 'include' }).then((r) => r.json()).then(setC).catch(() => {}); }, []);
  if (!c) return null;
  const save = (v: number) => fetch('/api/phone-ctx', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ctx: v }) }).then((r) => r.json()).then(setC).catch(() => {});
  return (
    <div className="cfg-row cfg-row--stack">
      <div className="cfg-row__text">
        <div className="cfg-row__title">Context size (memory per conversation)</div>
        <div className="cfg-row__sub">How many tokens an on-device model holds at once. Bigger remembers more of the chat and fits the Bots' tools, but uses more RAM and starts slower. Now: {k(c.current)}.</div>
      </div>
      <select className="text-input" value={c.chosen} onChange={(e) => save(Number(e.target.value))} aria-label="Context size">
        <option value={0}>Automatic ({k(c.auto)} for this phone)</option>
        {c.choices.map((n) => <option key={n} value={n}>{k(n)} tokens</option>)}
      </select>
    </div>
  );
}
