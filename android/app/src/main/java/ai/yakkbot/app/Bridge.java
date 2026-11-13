package ai.yakkbot.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The phone bridge: a tiny HTTP server the YakkBot server (in Termux, on this same phone) calls to
 * operate the handset. It listens on 127.0.0.1 only, and every request must carry the token this
 * app generated; the YakkBot server learns the token when you open the app while signed in.
 */
final class Bridge implements Runnable {
    private final Context ctx;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final PhoneActions phone;
    private volatile ServerSocket server;
    private volatile boolean running = true;

    Bridge(Context ctx) { this.ctx = ctx.getApplicationContext(); this.phone = new PhoneActions(this.ctx); }

    void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        pool.shutdownNow();
    }

    @Override public void run() {
        while (running) {
            try (ServerSocket s = new ServerSocket(Prefs.BRIDGE_PORT, 16, InetAddress.getByName("127.0.0.1"))) {
                server = s;
                while (running) {
                    final Socket client = s.accept();
                    pool.execute(() -> serve(client));
                }
            } catch (Exception e) {
                if (!running) return;
                try { Thread.sleep(3000); } catch (InterruptedException ie) { return; }
            }
        }
    }

    // ---------- HTTP ----------

    private void serve(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(30000);
            InputStream in = c.getInputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] first = lines[0].split(" ");
            if (first.length < 2) return;
            String method = first[0], path = first[1];
            int length = 0;
            String auth = "";
            for (int i = 1; i < lines.length; i++) {
                int k = lines[i].indexOf(':');
                if (k < 0) continue;
                String name = lines[i].substring(0, k).trim().toLowerCase(Locale.ROOT), value = lines[i].substring(k + 1).trim();
                if (name.equals("content-length")) length = Integer.parseInt(value);
                else if (name.equals("authorization")) auth = value;
            }
            if (length > 1_000_000) { reply(c, 413, err("too large")); return; }
            byte[] body = new byte[length];
            int got = 0;
            while (got < length) { int n = in.read(body, got, length - got); if (n < 0) break; got += n; }

            String given = auth.startsWith("Bearer ") ? auth.substring(7).trim() : "";
            if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), Prefs.token(ctx).getBytes(StandardCharsets.UTF_8))) {
                reply(c, 401, err("unauthorized"));
                return;
            }
            JSONObject args = length > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();
            JSONObject out;
            int status = 200;
            try {
                out = handle(method, path, args);
            } catch (PhoneActions.NeedPermission e) {
                Permissions.ask(ctx, e.why, e.perms);
                status = 409;
                out = err("The owner has not allowed YakkBot " + e.why + " yet. A notification now asks them; try again after they allow it.");
            } catch (IllegalStateException e) {
                status = 409; out = err(e.getMessage());
            } catch (Exception e) {
                status = 500; out = err(String.valueOf(e.getMessage()));
            }
            reply(c, status, out);
        } catch (Exception ignored) { /* a dropped connection */ }
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0, b;
        while ((b = in.read()) >= 0) {
            buf.write(b);
            if (b == '\r' && (state == 0 || state == 2)) state++;
            else if (b == '\n' && (state == 1 || state == 3)) state++;
            else state = 0;
            if (state == 4) return buf.toString("UTF-8");
            if (buf.size() > 16384) return null;
        }
        return null;
    }

    private static void reply(Socket c, int status, JSONObject body) throws Exception {
        byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
        OutputStream out = c.getOutputStream();
        out.write(("HTTP/1.1 " + status + " OK\r\nContent-Type: application/json\r\nContent-Length: " + data.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }

    private static JSONObject err(String m) {
        try { return new JSONObject().put("error", m == null ? "failed" : m); } catch (Exception e) { return new JSONObject(); }
    }

    // ---------- what the bots can ask for ----------

    static JSONObject status(Context c) throws Exception {
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        return new JSONObject()
                .put("ok", true)
                .put("app", "yakkbot-android")
                .put("version", BuildConfig.VERSION_NAME)
                .put("android", android.os.Build.VERSION.SDK_INT)
                .put("device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL)
                .put("screenControl", YakkAccessibilityService.instance != null)
                .put("notifications", YakkNotificationListener.instance != null)
                .put("phone", true)
                .put("permissions", new PhoneActions(c).groups())
                .put("unrestrictedBattery", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
    }

    private YakkAccessibilityService screen() {
        YakkAccessibilityService s = YakkAccessibilityService.instance;
        if (s == null) throw new IllegalStateException("Screen control is off. The owner turns it on in the YakkBot app: Phone control > Allow screen control.");
        return s;
    }

    private JSONObject handle(String method, String path, JSONObject a) throws Exception {
        JSONObject ok = new JSONObject().put("ok", true);
        switch (path) {
            case "/status":
                return status(ctx);

            case "/phone":
                return phone.run(a);

            case "/ui/dump":
                return screen().dump(Math.min(a.optInt("max", 250), 600));

            case "/ui/tap": {
                YakkAccessibilityService s = screen();
                int x = a.optInt("x", -1), y = a.optInt("y", -1);
                if (a.has("text")) {
                    int[] hit = s.find(a.getString("text"));
                    if (hit == null) throw new IllegalStateException("Nothing on screen contains \"" + a.getString("text") + "\". Read the screen again.");
                    x = hit[0]; y = hit[1];
                }
                if (x < 0 || y < 0) throw new IllegalStateException("tap needs x and y, or text.");
                if (!s.tap(x, y, a.optBoolean("long") ? 700 : 60)) throw new IllegalStateException("The tap was cancelled (the screen may be locked).");
                return ok.put("x", x).put("y", y);
            }

            case "/ui/swipe":
                if (!screen().swipe(a.getInt("x1"), a.getInt("y1"), a.getInt("x2"), a.getInt("y2"), a.optLong("ms", 300))) throw new IllegalStateException("The swipe was cancelled.");
                return ok;

            case "/ui/type": {
                String problem = screen().type(a.optString("text", ""), a.optBoolean("append"), a.optBoolean("enter"));
                if (problem != null) throw new IllegalStateException(problem);
                return ok;
            }

            case "/ui/key":
                if (!screen().key(a.optString("key"))) throw new IllegalStateException("Unknown or unavailable key. Use back, home, recents, notifications, quick_settings, power_menu or lock.");
                return ok;

            case "/ui/screenshot":
                return screen().screenshot(Math.max(480, Math.min(a.optInt("maxSide", 1280), 2400)));

            case "/apps/list": {
                JSONArray apps = new JSONArray();
                for (ResolveInfo r : launchable()) {
                    apps.put(new JSONObject().put("name", String.valueOf(r.loadLabel(ctx.getPackageManager()))).put("package", r.activityInfo.packageName));
                }
                return new JSONObject().put("apps", apps);
            }

            case "/apps/open": {
                String want = a.optString("package", a.optString("name", "")).trim();
                if (want.isEmpty()) throw new IllegalStateException("open needs an app name or package.");
                ResolveInfo best = null;
                String low = want.toLowerCase(Locale.ROOT);
                for (ResolveInfo r : launchable()) {
                    String label = String.valueOf(r.loadLabel(ctx.getPackageManager())).toLowerCase(Locale.ROOT);
                    if (r.activityInfo.packageName.equals(want) || label.equals(low)) { best = r; break; }
                    if (best == null && label.contains(low)) best = r;
                }
                if (best == null) throw new IllegalStateException("No installed app matches \"" + want + "\".");
                Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                        .setComponent(new ComponentName(best.activityInfo.packageName, best.activityInfo.name))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                launch(i);
                return ok.put("package", best.activityInfo.packageName);
            }

            case "/open": {
                // A link, a phone number to dial (tel:), a place (geo:), a settings page (android.settings.*).
                String target = a.optString("url", "").trim();
                if (target.isEmpty()) throw new IllegalStateException("open needs a url.");
                Intent i = target.startsWith("android.settings.") ? new Intent(target) : new Intent(Intent.ACTION_VIEW, Uri.parse(target));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                launch(i);
                return ok;
            }

            case "/notifications/list": {
                YakkNotificationListener n = YakkNotificationListener.instance;
                if (n == null) throw new IllegalStateException("Notification access is off. The owner turns it on in the YakkBot app: Phone control > Allow reading notifications.");
                return new JSONObject().put("notifications", n.list(Math.min(a.optInt("limit", 30), 100)));
            }

            case "/notifications/dismiss": {
                YakkNotificationListener n = YakkNotificationListener.instance;
                if (n == null) throw new IllegalStateException("Notification access is off.");
                n.dismiss(a.getString("key"));
                return ok;
            }

            default:
                throw new IllegalStateException("Unknown request " + path);
        }
    }

    private List<ResolveInfo> launchable() {
        return ctx.getPackageManager().queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), PackageManager.MATCH_ALL);
    }

    /** Android only lets an app open another app from the background when it runs an accessibility service. */
    private void launch(Intent i) {
        Context from = YakkAccessibilityService.instance != null ? YakkAccessibilityService.instance : ctx;
        try {
            from.startActivity(i);
        } catch (Exception e) {
            throw new IllegalStateException("Android would not open that: " + e.getMessage());
        }
    }

    static boolean notificationAccess(Context c) {
        String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(c.getPackageName());
    }
}
