package ai.yakkbot.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * One-tap updates: asks GitHub for the newest YakkBot release, downloads its APK and hands it to
 * Android's package installer, which shows its usual "install this update?" screen. The app's data
 * (chats, models, the computer) stays, because every release is signed with the same key.
 */
final class Updater {
    static final String LATEST = "https://api.github.com/repos/deezi74/YakkBot/releases/latest";
    private static volatile String state = "idle";
    private static volatile int progress = 0;
    private static volatile String error = "";

    private Updater() {}

    /** "0.7.10" > "0.7.9". Anything that is not a version (an old "build-12" tag) never counts as newer. */
    static int compare(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? num(x[i]) : 0, q = i < y.length ? num(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }
    private static int num(String s) { try { return Integer.parseInt(s.replaceAll("[^0-9].*$", "")); } catch (Exception e) { return 0; } }

    static JSONObject check() {
        JSONObject out = new JSONObject();
        try {
            out.put("current", BuildConfig.VERSION_NAME);
            HttpURLConnection c = (HttpURLConnection) new URL(LATEST).openConnection();
            c.setConnectTimeout(8000); c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "YakkBot");
            if (c.getResponseCode() != 200) return out.put("error", "GitHub answered " + c.getResponseCode());
            JSONObject rel;
            try (InputStream in = c.getInputStream()) { rel = new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)); }
            String tag = rel.optString("tag_name", "");
            String latest = tag.startsWith("v") ? tag.substring(1) : "";
            String url = "";
            JSONArray assets = rel.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                if (a.optString("name").endsWith(".apk")) { url = a.optString("browser_download_url"); break; }
            }
            out.put("latest", latest).put("url", url).put("notes", rel.optString("body", ""));
            out.put("available", !latest.isEmpty() && !url.isEmpty() && compare(latest, BuildConfig.VERSION_NAME) > 0);
        } catch (Exception e) {
            try { out.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
        }
        return out;
    }

    private static volatile JSONObject lastCheck = null;
    private static volatile boolean checking = false;

    /** Starts a check in the background; lastCheck() has the answer once it arrives. */
    static void checkAsync() {
        if (checking) return;
        checking = true;
        new Thread(() -> { try { lastCheck = check(); } finally { checking = false; } }, "yakk-update-check").start();
    }
    static String lastCheck() {
        try { return checking ? "{\"checking\":true}" : lastCheck == null ? "{}" : lastCheck.toString(); } catch (Exception e) { return "{}"; }
    }

    static JSONObject status() {
        try { return new JSONObject().put("state", state).put("progress", progress).put("error", error); } catch (Exception e) { return new JSONObject(); }
    }

    static synchronized void install(Context ctx, String url) {
        if ("downloading".equals(state) || "installing".equals(state)) return;
        if (url == null || !url.startsWith("https://github.com/deezi74/YakkBot/")) { state = "failed"; error = "Not a YakkBot download."; return; }
        Context c = ctx.getApplicationContext();
        state = "downloading"; progress = 0; error = "";
        new Thread(() -> {
            try {
                PackageInstaller pi = c.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(c.getPackageName());
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                int id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
                    h.setInstanceFollowRedirects(true);
                    h.setConnectTimeout(15000); h.setReadTimeout(60000);
                    h.setRequestProperty("User-Agent", "YakkBot");
                    long total = h.getContentLengthLong();
                    try (InputStream in = h.getInputStream(); OutputStream out = s.openWrite("yakkbot.apk", 0, total > 0 ? total : -1)) {
                        byte[] buf = new byte[1 << 16];
                        long done = 0; int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n); done += n;
                            if (total > 0) progress = (int) (done * 100 / total);
                        }
                        s.fsync(out);
                    }
                    state = "installing";
                    Intent done = new Intent(c, UpdateReceiver.class);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    s.commit(PendingIntent.getBroadcast(c, 7, done, flags).getIntentSender());
                }
            } catch (Exception e) {
                state = "failed"; error = String.valueOf(e.getMessage());
            }
        }, "yakk-update").start();
    }

    /** Android reports back here: ask the person to confirm, or tell the page how it went. */
    public static final class UpdateReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(confirm); }
            } else if (status == PackageInstaller.STATUS_SUCCESS) {
                state = "done";
            } else {
                state = "failed";
                String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                error = status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
                        ? "This update is signed differently from the YakkBot on this phone. Uninstall YakkBot once, then install the update; after that, updates keep your data."
                        : status == PackageInstaller.STATUS_FAILURE_ABORTED ? "The update was cancelled." : (msg == null ? "The update did not install." : msg);
            }
        }
    }
}
