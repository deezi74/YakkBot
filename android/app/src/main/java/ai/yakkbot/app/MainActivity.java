package ai.yakkbot.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The YakkBot app. First run: one tap installs YakkBot's own Linux (Alpine, through PRoot, the way
 * D-Agent does it) with Node.js, and the server starts inside it. After that, the app signs you in
 * and shows your bots' chat full screen, and gives the bots the phone (see Bridge).
 */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 2, REQ_PERMS = 3, REQ_FILE = 4;
    private android.webkit.ValueCallback<Uri[]> pendingFiles;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private PhoneVoice voice;
    private ScrollView setup;
    private LinearLayout steps;
    private TextView status, detail;
    private boolean showingWeb = false, installing = false, signingIn = false;
    private PermissionRequest pendingMic;
    private final Runnable poll = this::checkServer;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(bg());

        web = new WebView(this);
        web.setVisibility(View.GONE);
        configure(web);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setup = new ScrollView(this);
        steps = new LinearLayout(this);
        steps.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        steps.setPadding(pad, dp(40), pad, pad);
        setup.addView(steps);
        root.addView(setup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        BridgeService.start(this);
        handleAsk(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAsk(intent);
    }

    @Override protected void onResume() {
        super.onResume();
        if (!showingWeb) { buildSetup(); checkServer(); }
        else web.evaluateJavascript("window.dispatchEvent(new Event('yakk:resume'))", null);
    }

    @Override protected void onPause() {
        ui.removeCallbacks(poll);
        super.onPause();
    }

    // ---------- is the server up? ----------

    private void checkServer() {
        ui.removeCallbacks(poll);
        if (installing || signingIn) return;
        new Thread(() -> {
            final boolean up = ping();
            ui.post(() -> {
                if (isFinishing() || showingWeb) return;
                if (up) { signIn(); return; }
                if (status != null) {
                    Linux linux = new Linux(this);
                    if (linux.installed()) {
                        String st = BridgeService.state;
                        status.setText("crashed".equals(st) ? "YakkBot stopped. Starting it again…" : "Starting your bots…");
                        if ("crashed".equals(st) && detail != null) {
                            String why = BridgeService.lastError == null ? "" : BridgeService.lastError + "\n";
                            detail.setText(why + Linux.tail(linux.logTail(1500), 1500));
                            detail.setVisibility(View.VISIBLE);
                        }
                    }
                }
                ui.postDelayed(poll, 1500);
            });
        }).start();
    }

    private boolean ping() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.serverUrl(this) + "/api/health").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            boolean ok = c.getResponseCode() == 200;
            // Only the app's own server counts, never another YakkBot that happens to answer here.
            String body = ok ? new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8) : "";
            c.disconnect();
            return ok && body.contains("\"platform\":\"android-app\"");
        } catch (Exception e) {
            return false;
        }
    }

    /** Signs the chat window in as the owner, with a one-time link only this phone can make. */
    private void signIn() {
        signingIn = true;
        new Thread(() -> {
            String target = Prefs.serverUrl(this) + "/";
            try {
                if (!sessionValid()) {
                    String key = hmac(new Linux(this).secret("session.secret"), "owner-login");
                    JSONObject body = new JSONObject().put("email", "owner@yakkbot.local").put("name", Prefs.ownerName(this)).put("link", true);
                    JSONObject r = post("/api/auth/owner", body, key);
                    if (r.has("url")) target = r.getString("url");
                }
            } catch (Exception ignored) { /* falls back to the passphrase screen */ }
            final String go = target;
            ui.post(() -> { signingIn = false; showWeb(go); });
        }).start();
    }

    private boolean sessionValid() {
        try {
            String cookie = CookieManager.getInstance().getCookie(Prefs.serverUrl(this));
            if (cookie == null || !cookie.contains("yakkbot_session=")) return false;
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.serverUrl(this) + "/api/auth/me").openConnection();
            c.setRequestProperty("Cookie", cookie);
            c.setConnectTimeout(2000);
            try (InputStream in = c.getInputStream()) {
                return !new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)).isNull("user");
            } finally { c.disconnect(); }
        } catch (Exception e) { return false; }
    }

    private JSONObject post(String path, JSONObject body, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Prefs.serverUrl(this) + path).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(3000);
        c.setReadTimeout(10000);
        c.setRequestProperty("Content-Type", "application/json");
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        try (InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream()) {
            return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } finally { c.disconnect(); }
    }

    private static String hmac(String key, String msg) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        StringBuilder s = new StringBuilder();
        for (byte b : mac.doFinal(msg.getBytes(StandardCharsets.UTF_8))) s.append(String.format("%02x", b));
        return s.toString();
    }

    private void showWeb(String url) {
        showingWeb = true;
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private void showSetup() {
        showingWeb = false;
        web.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        buildSetup();
        checkServer();
    }

    // ---------- install ----------

    private void install(String name) {
        if (installing) return;
        if (!name.trim().isEmpty()) Prefs.setOwnerName(this, name.trim());
        installing = true;
        buildSetup();
        final Linux linux = new Linux(this);
        new Thread(() -> {
            try {
                linux.install(step -> ui.post(() -> status.setText(step + "…")));
                ui.post(() -> {
                    installing = false;
                    status.setText("Starting your bots…");
                    BridgeService.start(this);
                    buildSetup();
                    checkServer();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    installing = false;
                    buildSetup();
                    status.setText("Setup did not finish: " + e.getMessage());
                });
            }
        }).start();
    }

    // ---------- the chat ----------

    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        w.addJavascriptInterface(new Js(), "YakkAndroid");
        w.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // Only this phone's YakkBot loads in here (it is the only page that gets the bridge); the rest opens in the browser.
                if (local(u)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) ui.post(MainActivity.this::showSetup);
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            // <input type=file> in the page: importing a bot card a friend shared.
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    pendingFiles = null;
                    callback.onReceiveValue(null);
                    toast("This phone has no file picker.");
                }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                boolean wantsMic = false;
                for (String r : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                if (!wantsMic || !local(request.getOrigin())) { request.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingMic = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            }
        });
        // Files from a bot's Library.
        w.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            try {
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) r.addRequestHeader("Cookie", cookie);
                String name = URLUtil.guessFileName(url, disposition, mime);
                r.setTitle(name);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                toast("Downloading " + name);
            } catch (Exception e) {
                toast("Could not download: " + e.getMessage());
            }
        });
    }

    private static boolean local(Uri u) {
        String h = u.getHost();
        return "http".equals(u.getScheme()) && ("127.0.0.1".equals(h) || "localhost".equals(h));
    }

    @Override public void onBackPressed() {
        if (!showingWeb) { super.onBackPressed(); return; }
        // The page decides: close a sheet or go back to the list; with nothing to go back to, leave the app.
        web.evaluateJavascript("(function(){try{return !!(window.__yakkBack&&window.__yakkBack())}catch(e){return false}})()", handled -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    /** What the page may ask of the app. Only this phone's own YakkBot page is ever loaded here. */
    private final class Js {
        @JavascriptInterface public String info() {
            try {
                JSONObject o = Bridge.status(MainActivity.this).put("port", Prefs.BRIDGE_PORT).put("token", Prefs.token(MainActivity.this));
                o.put("lan", Prefs.lan(MainActivity.this));
                o.put("server", BridgeService.state);
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void openAccessibilitySettings() { ui.post(() -> open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))); }
        @JavascriptInterface public void openNotificationSettings() { ui.post(() -> open(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))); }
        @JavascriptInterface public void openAppSettings() { ui.post(MainActivity.this::appInfo); }
        @JavascriptInterface public void requestBattery() { ui.post(MainActivity.this::battery); }
        /** Ask for one permission group ("sms", "calls", "contacts", "calendar", "location", "notifications") or "all". */
        @JavascriptInterface public void grant(String group) { ui.post(() -> askGroup(group)); }
        /** Install the bots' desktop computer (XFCE + Chromium) in the app's Linux. */
        @JavascriptInterface public void installDesktop() { ui.post(() -> { try { Desktop.installAsync(MainActivity.this); toast("Installing the computer. This takes a while; you can keep chatting."); } catch (Exception e) { toast(e.getMessage()); } }); }
        /** Talk mode with the phone's own voice and speech recognition (see PhoneVoice). */
        @JavascriptInterface public void speak(String text, float rate) { ui.post(() -> phoneVoice().speak(text, rate)); }
        @JavascriptInterface public void stopSpeaking() { ui.post(() -> { if (voice != null) voice.stopSpeaking(); }); }
        @JavascriptInterface public void listen(String lang) {
            ui.post(() -> {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    web.evaluateJavascript("window.__yakkHeardError&&window.__yakkHeardError('Allow the microphone, then tap talk again.')", null);
                    return;
                }
                phoneVoice().listen(lang);
            });
        }
        @JavascriptInterface public void stopListening() { ui.post(() -> { if (voice != null) voice.stopListening(); }); }
        @JavascriptInterface public void restartServer() { ui.post(() -> { BridgeService.restartServer(MainActivity.this); toast("Restarting YakkBot…"); }); }
        @JavascriptInterface public void setLan(boolean on) {
            ui.post(() -> { Prefs.setLan(MainActivity.this, on); BridgeService.restartServer(MainActivity.this); toast(on ? "Opening YakkBot to your Wi-Fi…" : "YakkBot is on this phone only."); });
        }
        /** For signing in from a PC on the same Wi-Fi. */
        @JavascriptInterface public String passphrase() {
            try { return new Linux(MainActivity.this).secret("passphrase").substring(0, 16); } catch (Exception e) { return ""; }
        }
    }

    // ---------- permissions ----------

    private void askGroup(String group) {
        List<String> perms = new ArrayList<>();
        for (java.util.Map.Entry<String, String[]> e : PhoneActions.GROUPS.entrySet()) {
            if (group.equals("all") || group.equals(e.getKey())) for (String p : e.getValue()) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) perms.add(p);
        }
        if (perms.isEmpty()) { toast("Already allowed."); return; }
        requestPermissions(perms.toArray(new String[0]), REQ_PERMS);
    }

    private void handleAsk(Intent i) {
        String[] perms = i == null ? null : i.getStringArrayExtra(Permissions.EXTRA);
        if (perms == null || perms.length == 0) return;
        i.removeExtra(Permissions.EXTRA);
        String why = i.getStringExtra(Permissions.EXTRA_WHY);
        if (why != null) toast("A bot asked for permission " + why + ".");
        requestPermissions(perms, REQ_PERMS);
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILE && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_MIC && pendingMic != null) {
            if (granted) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else pendingMic.deny();
            pendingMic = null;
        } else if (code == REQ_PERMS) {
            if (showingWeb) web.evaluateJavascript("window.dispatchEvent(new Event('yakk:resume'))", null);
            else buildSetup();
            boolean all = true;
            for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) all = false;
            if (!all) toast("Some were not allowed. If Android stops asking, allow them in App info > Permissions.");
        }
    }

    // ---------- setup screen ----------

    private void buildSetup() {
        steps.removeAllViews();
        Linux linux = new Linux(this);
        steps.addView(text("YakkBot", 30, true));
        TextView sub = text("Your own team of AI agents, living on this phone.", 15, false);
        sub.setTextColor(muted());
        sub.setPadding(0, dp(4), 0, dp(20));
        steps.addView(sub);

        status = text("", 15, true);
        status.setPadding(0, 0, 0, dp(6));
        detail = text("", 12, false);
        detail.setTypeface(Typeface.MONOSPACE);
        detail.setTextColor(muted());
        detail.setVisibility(View.GONE);

        if (!linux.engineBundled()) {
            steps.addView(card("This phone can't run YakkBot's built-in Linux", "YakkBot needs a 64-bit ARM phone (almost every phone from the last few years). This build has no Linux engine for this one.", null, null, null));
            return;
        }
        if (!linux.installed()) {
            LinearLayout c = cardLayout();
            c.addView(text(installing ? "Setting up" : "One-time setup", 18, true));
            TextView d = text(installing
                    ? "Downloading Linux and Node.js for your bots. Keep the app open; this takes a few minutes on Wi-Fi."
                    : "YakkBot downloads a small Linux system (Alpine) with Node.js into the app, about 150 MB. No Termux needed, and nothing else on the phone changes.", 14, false);
            d.setTextColor(muted());
            d.setPadding(0, dp(6), 0, dp(12));
            c.addView(d);
            if (!installing) {
                EditText name = new EditText(this);
                name.setHint("What should your bots call you?");
                name.setSingleLine(true);
                name.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
                if (!"Owner".equals(Prefs.ownerName(this))) name.setText(Prefs.ownerName(this));
                name.setTextColor(fg());
                name.setHintTextColor(muted());
                c.addView(name, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                c.addView(button("Set up YakkBot", v -> install(name.getText().toString())));
            } else {
                status.setText("Starting…");
                c.addView(status);
            }
            steps.addView(c);
        } else {
            LinearLayout c = cardLayout();
            status.setText("Starting your bots…");
            c.addView(status);
            c.addView(detail);
            c.addView(button("Restart YakkBot", v -> { BridgeService.restartServer(this); toast("Restarting…"); }));
            steps.addView(c);
        }

        steps.addView(heading("Let your bots use the phone"));
        boolean perms = true;
        for (String[] g : PhoneActions.GROUPS.values()) for (String p : g) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) perms = false;
        steps.addView(card(perms ? "✓ Texts, calls, contacts, calendar and location" : "Texts, calls, contacts, calendar and location",
                perms ? null : "Android asks you once for each. Bots still ask you before they text, call or read anything private.",
                perms ? null : "Allow", v -> askGroup("all"), null));
        boolean acc = YakkAccessibilityService.instance != null;
        steps.addView(card(acc ? "✓ Screen control is on" : "Screen control",
                acc ? null : "Lets bots read the screen and tap, swipe and type in any app. Choose \"YakkBot phone control\" and turn it on. If Android says it's restricted: open App info, tap ⋮, choose \"Allow restricted settings\", then try again.",
                acc ? null : "Open Accessibility settings", v -> open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)), acc ? null : "App info"));
        boolean notif = Bridge.notificationAccess(this);
        steps.addView(card(notif ? "✓ Bots can read notifications" : "Read notifications", notif ? null : "Lets bots see and clear what's in your notification shade.",
                notif ? null : "Open notification access", v -> open(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)), null));
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        boolean batt = pm.isIgnoringBatteryOptimizations(getPackageName());
        steps.addView(card(batt ? "✓ Allowed to run in the background" : "Keep running in the background", batt ? null : "Stops Android from putting your bots to sleep.",
                batt ? null : "Allow", v -> battery(), null));
    }

    private LinearLayout cardLayout() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(dark() ? 0xFF1A1A1A : 0xFFFFFFFF);
        bg.setCornerRadius(dp(20));
        bg.setStroke(1, dark() ? 0x22FFFFFF : 0x221C1C1C);
        card.setBackground(bg);
        card.setPadding(dp(18), dp(16), dp(18), dp(16));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(10);
        card.setLayoutParams(lp);
        return card;
    }

    private View card(String title, String detailText, String action, View.OnClickListener onClick, String infoButton) {
        LinearLayout c = cardLayout();
        c.addView(text(title, 16, true));
        if (detailText != null) {
            TextView d = text(detailText, 14, false);
            d.setTextColor(muted());
            d.setPadding(0, dp(4), 0, 0);
            d.setLineSpacing(0, 1.15f);
            c.addView(d);
        }
        if (action != null) c.addView(button(action, onClick));
        if (infoButton != null) {
            TextView link = text(infoButton, 14, true);
            link.setTextColor(0xFFEE620D);
            link.setPadding(0, dp(10), 0, 0);
            link.setOnClickListener(v -> appInfo());
            c.addView(link);
        }
        return c;
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(15);
        GradientDrawable bb = new GradientDrawable();
        bb.setColor(0xFFEE620D);
        bb.setCornerRadius(dp(22));
        b.setBackground(bb);
        b.setOnClickListener(onClick);
        b.setPadding(dp(20), 0, dp(20), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44));
        lp.topMargin = dp(12);
        lp.gravity = Gravity.START;
        b.setLayoutParams(lp);
        return b;
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(fg());
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s.toUpperCase(), 12, true);
        t.setTextColor(muted());
        t.setLetterSpacing(0.08f);
        t.setPadding(0, dp(18), 0, dp(8));
        return t;
    }

    // ---------- helpers ----------

    private void battery() {
        try { startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))); }
        catch (Exception e) { open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
    }

    private void appInfo() { open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }

    private void open(Intent i) {
        try { startActivity(i); } catch (Exception e) { toast("This phone has no screen for that setting."); }
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private boolean dark() { return (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES; }
    private int bg() { return dark() ? 0xFF0E0E0E : 0xFFF5F5F5; }
    private int fg() { return dark() ? 0xFFF5F5F5 : 0xFF1C1C1C; }
    private int muted() { return dark() ? 0xB3F5F5F5 : 0xB31C1C1C; }

    private PhoneVoice phoneVoice() {
        if (voice == null) voice = new PhoneVoice(this, web);
        return voice;
    }

    @Override protected void onDestroy() {
        if (voice != null) voice.release();
        super.onDestroy();
    }
}
