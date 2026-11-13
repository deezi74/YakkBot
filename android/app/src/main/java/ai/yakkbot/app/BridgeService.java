package ai.yakkbot.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.HashMap;
import java.util.Map;

/**
 * Keeps YakkBot alive while the app is in the background: the phone bridge, and the YakkBot server
 * running in the app's own Linux (restarted if it stops). Shows a quiet notification while it runs.
 */
public class BridgeService extends Service {
    private static final String CHANNEL = "bridge";
    static final String ACTION_RESTART = "yakk.restart";
    static volatile String state = "stopped";
    static volatile String lastError = null;

    private Bridge bridge;
    private Thread server;
    private volatile boolean running = true;
    private volatile Process process, desktop;
    private PowerManager.WakeLock wake;

    static void start(Context c) {
        Intent i = new Intent(c, BridgeService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i); else c.startService(i);
        } catch (Exception ignored) { /* refused from the background on some versions; the app starts it when opened */ }
    }

    static void restartServer(Context c) {
        Intent i = new Intent(c, BridgeService.class).setAction(ACTION_RESTART);
        try { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i); else c.startService(i); } catch (Exception ignored) {}
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "YakkBot running", NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("YakkBot")
                .setContentText("Your bots are running on this phone")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        // Bots keep working with the screen off.
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yakkbot:server");
        wake.setReferenceCounted(false);
        wake.acquire();
        bridge = new Bridge(this);
        new Thread(bridge, "yakk-bridge").start();
        server = new Thread(this::superviseServer, "yakk-server");
        server.start();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_RESTART.equals(intent.getAction())) {
            // The supervisor starts it again, with the desktop if one was just installed.
            Process p = process;
            if (p != null) p.destroy();
        }
        return START_STICKY;
    }

    /** Runs the server in the app's Linux, and starts it again (with a growing pause) if it stops. */
    private void superviseServer() {
        Linux linux = new Linux(this);
        long pause = 2000;
        while (running) {
            if (!linux.installed()) { state = "not-installed"; sleep(3000); continue; }
            try {
                state = "starting";
                linux.configure();
                linux.installApp(BuildConfig.VERSION_CODE);
                long started = System.currentTimeMillis();
                startDesktop(linux);
                process = linux.startServer(serverEnv(this, linux));
                state = "running";
                int code = process.waitFor();
                if (!running) return;
                lastError = "The server stopped (exit " + code + ").";
                state = "crashed";
                // Ran a good while: it was not a start-up failure, so start again quickly.
                pause = System.currentTimeMillis() - started > 60_000 ? 2000 : Math.min(pause * 2, 60_000);
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                state = "crashed";
                pause = Math.min(pause * 2, 60_000);
            }
            sleep(pause);
        }
    }

    static Map<String, String> serverEnv(Context c, Linux linux) throws java.io.IOException {
        Map<String, String> env = new HashMap<>();
        env.put("YAKK_PLATFORM", "android-app");
        env.put("YAKK_HOME", "/root/.yakkbot");
        env.put("YAKK_WEB_DIST", "/opt/yakkbot/web");
        env.put("PORT", String.valueOf(Prefs.SERVER_PORT));
        env.put("APP_URL", Prefs.serverUrl(c));
        env.put("SERVER_URL", Prefs.serverUrl(c));
        // On the home Wi-Fi the PC can open it too; the passphrase then protects it.
        env.put("HOST", Prefs.lan(c) ? "0.0.0.0" : "127.0.0.1");
        env.put("SESSION_SECRET", linux.secret("session.secret"));
        env.put("YAKK_PASSWORD", linux.secret("passphrase").substring(0, 16));
        env.put("YAKK_BRIDGE_PORT", String.valueOf(Prefs.BRIDGE_PORT));
        env.put("YAKK_BRIDGE_TOKEN", Prefs.token(c));
        env.put("YAKK_OWNER", Prefs.ownerName(c));
        env.put("NODE_OPTIONS", "--max-old-space-size=384");
        Desktop.addServerEnv(c, env);
        return env;
    }

    /** The bots' desktop (when installed): started once, and again if it stopped. */
    private void startDesktop(Linux linux) {
        if (!Desktop.installed(this)) return;
        Process d = desktop;
        if (d != null && d.isAlive()) return;
        try {
            ProcessBuilder pb = linux.command(Desktop.script(), null);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(new java.io.File(linux.base, "desktop.log")));
            desktop = pb.start();
            Thread.sleep(3000);
        } catch (Exception e) {
            lastError = "The desktop did not start: " + e.getMessage();
        }
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    @Override public void onDestroy() {
        running = false;
        Process p = process;
        if (p != null) p.destroy();
        Process d = desktop;
        if (d != null) d.destroy();
        if (server != null) server.interrupt();
        if (bridge != null) bridge.stop();
        if (wake != null && wake.isHeld()) wake.release();
        state = "stopped";
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
