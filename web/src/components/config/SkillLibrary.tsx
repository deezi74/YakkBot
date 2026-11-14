import { useEffect, useMemo, useState } from 'react';
import type { Skill } from '@shared/types';
import { configApi, type LibrarySkill } from '../../lib/configApi';

/** Ready-made skill cards: tap one to read it, add it to this Bot with one more tap. */
export function SkillLibrary({ botId, have, onAdded }: { botId: string; have: Skill[]; onAdded: () => void }) {
  const [all, setAll] = useState<LibrarySkill[] | null>(null);
  const [cat, setCat] = useState('All');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { configApi.skillLibrary().then(setAll).catch(() => setAll([])); }, []);
  const owned = new Set(have.map((s) => s.name.toLowerCase()));
  const cats = useMemo(() => ['All', ...Array.from(new Set((all ?? []).map((s) => s.category)))], [all]);
  if (!all) return <div className="cfg-empty">Loading the skill library…</div>;
  const shown = all.filter((s) => cat === 'All' || s.category === cat);
  const add = async (s: LibrarySkill) => {
    setBusy(s.id);
    try { await configApi.addLibrarySkill(botId, s.id); onAdded(); } finally { setBusy(null); }
  };
  return (
    <div className="skill-lib">
      <div className="skill-lib__cats" role="tablist">
        {cats.map((c) => <button key={c} type="button" role="tab" aria-selected={cat === c} className={`skill-lib__cat${cat === c ? ' is-on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      <div className="skill-lib__grid">
        {shown.map((s) => {
          const added = owned.has(s.name.toLowerCase());
          const expanded = open === s.id;
          return (
            <div key={s.id} className={`skill-card${expanded ? ' is-open' : ''}${added ? ' is-added' : ''}`}>
              <button type="button" className="skill-card__main" onClick={() => setOpen(expanded ? null : s.id)} aria-expanded={expanded}>
                <span className="skill-card__icon" aria-hidden>{s.icon}</span>
                <span className="skill-card__name">{s.name}</span>
                <span className="skill-card__desc">{s.description}</span>
              </button>
              {expanded && <pre className="skill-card__body">{s.body}</pre>}
              <button type="button" className={`cfg-btn ${added ? 'cfg-btn--secondary' : 'cfg-btn--primary'} skill-card__add`} disabled={added || busy === s.id} onClick={() => add(s)}>
                {added ? 'Added ✓' : busy === s.id ? 'Adding…' : 'Add'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
