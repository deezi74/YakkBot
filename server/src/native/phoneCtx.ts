import os from 'node:os';
import { getAppSettings } from '../env.js';

/**
 * How many tokens a model on this device can hold at once (its context). The bots' instructions and
 * tools alone take about 12,000, so the floor is 16K. Unless chosen in Settings, it is sized from the
 * phone's memory; a conversation that still outgrows it raises it for the session (up to 64K).
 */
export const PHONE_CTX_CHOICES = [16384, 24576, 32768, 49152, 65536];
let bumped = 0;

export function autoPhoneCtx(): number {
  const gb = os.totalmem() / 1e9;
  return gb >= 11 ? 32768 : gb >= 7 ? 24576 : 16384;
}

export function phoneCtx(): number {
  const chosen = Number(getAppSettings().phoneCtx) || 0;
  return Math.max(chosen || autoPhoneCtx(), bumped);
}

/** The model said the request does not fit: allow a bigger context. Returns the new size, or 0 at the top. */
export function bumpPhoneCtx(): number {
  const cur = phoneCtx();
  const next = PHONE_CTX_CHOICES.find((c) => c > cur) ?? 0;
  if (next) bumped = next;
  return next;
}

/** Characters of conversation the model can take before it must be condensed (about 3 per token). */
export function phoneCharBudget(promptChars: number): number {
  return Math.max(4000, phoneCtx() * 3 - promptChars - 4096 * 3);
}
