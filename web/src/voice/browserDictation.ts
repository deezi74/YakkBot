// Dictation without a voice provider: the browser's own speech recognition (Chrome on Android and
// desktop, Safari). The browser decides where the audio is transcribed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DictationState } from './dictation';

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };
const ctor = (): (new () => Recognition) | null => (typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null));

export function useBrowserDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<Recognition | null>(null);
  const cb = useRef({ onText, onError, language });
  cb.current = { onText, onError, language };
  const supported = !!ctor();

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const begin = useCallback(() => {
    const C = ctor();
    if (!C || rec.current) return;
    const r = new C();
    r.lang = cb.current.language && cb.current.language !== 'auto' ? cb.current.language : navigator.language;
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cb.current.onText(String(e.results[i][0].transcript).trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') cb.current.onError('Allow the microphone for this page to dictate.');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') cb.current.onError('Dictation stopped. Try again.');
    };
    r.onend = () => { rec.current = null; setState('idle'); };
    rec.current = r;
    try { r.start(); setState('recording'); } catch { rec.current = null; }
  }, []);
  useEffect(() => () => rec.current?.abort(), []);

  // Tap to start, tap again to stop.
  const toggle = useCallback(() => { if (rec.current) stop(); else begin(); }, [begin, stop]);
  return {
    state, supported,
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); toggle(); },
    onPointerUp: (_e: React.PointerEvent) => {},
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && rec.current) { e.preventDefault(); rec.current.abort(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    },
  };
}
