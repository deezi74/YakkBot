import { useStore } from '../store';
import { useConfigUI } from '../configStore';

/** What the YakkBot Android app offers the page (see android/.../MainActivity.java). Absent in a normal browser. */
interface YakkAndroid {
  info(): string;
  openAccessibilitySettings(): void;
  openNotificationSettings(): void;
  openAppSettings(): void;
  requestBattery(): void;
  restartServer(): void;
}

export interface AndroidInfo {
  version?: string; device?: string; android?: number;
  screenControl?: boolean; notifications?: boolean; termuxPermission?: boolean; unrestrictedBattery?: boolean;
}

export const android: YakkAndroid | undefined = (window as unknown as { YakkAndroid?: YakkAndroid }).YakkAndroid;

export function androidInfo(): (AndroidInfo & { port?: number; token?: string }) | null {
  if (!android) return null;
  try { return JSON.parse(android.info()); } catch { return null; }
}

/** Tell the server where the app's phone bridge is. Safe to call often; it is the same pairing each time. */
export async function pairAndroid(): Promise<void> {
  const info = androidInfo();
  if (!info?.port || !info.token) return;
  const { port, token, ...rest } = info;
  await fetch('/api/device/pair', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, token, info: rest }) }).catch(() => {});
}

// The phone's Back button: close whatever is on top, then go back to the list. False = nothing left, leave the app.
(window as unknown as { __yakkBack?: () => boolean }).__yakkBack = () => {
  const s = useStore.getState();
  const cfg = useConfigUI.getState();
  if (s.viewerOpen) { s.set({ viewerOpen: false }); return true; }
  if (s.modal) { s.setModal(null); return true; }
  if (cfg.botSettings) { cfg.closeBotSettings(); return true; }
  if (cfg.appSettings) { cfg.closeAppSettings(); return true; }
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  if (narrow && s.detailsOpen && s.mobilePane === 'chat') { s.set({ detailsOpen: false }); return true; }
  if (cfg.view === 'tasks') { cfg.setView('chat'); return true; }
  if (narrow && s.mobilePane === 'chat') { s.set({ mobilePane: 'list' }); return true; }
  return false;
};
