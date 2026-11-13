package ai.yakkbot.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The YakkBot app: your bots' chat, full screen. The chat itself is served by YakkBot running in
 * Termux on this phone; this app starts that for you, shows it, and gives the bots the phone
 * bridge. Until the server answers, it shows the setup steps instead.
 */
public class MainActivity extends Activity {
    private static final String INSTALL = "pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/deezi74/YakkBot/main/install.sh | bash";
    private static final int REQ_TERMUX = 1, REQ_MIC = 2, REQ_NOTIFY = 3;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private ScrollView setup;
    private LinearLayout steps;
    private TextView status;
    private boolean showingWeb = false;
    private boolean triedStart = false;
    private PermissionRequest pendingMic;
    private final Runnable poll = this::checkServer;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(dark() ? 0xFF0E0E0E : 0xFFFCFCFC);

        web = new WebView(this);
        web.setVisibility(View.GONE);
        configure(web);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setup = new ScrollView(this);
        steps = new LinearLayout(this);
        steps.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        steps.setPadding(pad, dp(36), pad, pad);
        setup.addView(steps);
        root.addView(setup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        BridgeService.start(this);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (!showingWeb) { buildSetup(); checkServer(); }
    }

    @Override protected void onPause() {
        ui.removeCallbacks(poll);
        super.onPause();
    }

    // ---------- is the server up? ----------

    private void checkServer() {
        ui.removeCallbacks(poll);
        new Thread(() -> {
            final boolean up = ping();
            ui.post(() -> {
                if (isFinishing() || showingWeb) return;
                if (up) { showWeb(); return; }
                // Not running: ask Termux to start it, once, then keep looking.
                if (!triedStart && Termux.installed(this) && Termux.permitted(this)) {
                    triedStart = true;
                    String problem = Termux.yakkbot(this, "start");
                    status.setText(problem == null ? "Starting YakkBot in Termux…" : problem);
                }
                ui.postDelayed(poll, 2000);
            });
        }).start();
    }

    private boolean ping() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.serverUrl(this) + "/api/health").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            boolean ok = c.getResponseCode() == 200;
            c.disconnect();
            return ok;
        } catch (Exception e) {
            return false;
        }
    }

    private void showWeb() {
        showingWeb = true;
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(Prefs.serverUrl(this) + "/");
    }

    private void showSetup(String why) {
        showingWeb = false;
        triedStart = false;
        web.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        buildSetup();
        if (why != null) status.setText(why);
        checkServer();
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
                if (req.isForMainFrame()) showSetup("YakkBot stopped answering. Starting it again…");
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
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
        // The page decides: close a sheet or go back to the list; when there is nothing to go back to, leave the app.
        web.evaluateJavascript("(function(){try{return !!(window.__yakkBack&&window.__yakkBack())}catch(e){return false}})()", handled -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    /** What the page may ask of the app. Only this phone's own YakkBot page is ever loaded here. */
    private final class Js {
        @JavascriptInterface public String info() {
            try {
                return Bridge.status(MainActivity.this).put("port", Prefs.BRIDGE_PORT).put("token", Prefs.token(MainActivity.this)).toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void openAccessibilitySettings() { ui.post(() -> open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))); }
        @JavascriptInterface public void openNotificationSettings() { ui.post(() -> open(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))); }
        @JavascriptInterface public void openAppSettings() { ui.post(MainActivity.this::appInfo); }
        @JavascriptInterface public void requestBattery() { ui.post(MainActivity.this::battery); }
        @JavascriptInterface public void restartServer() { ui.post(() -> { String p = Termux.yakkbot(MainActivity.this, "restart"); toast(p == null ? "Restarting YakkBot…" : p); }); }
    }

    // ---------- setup screen ----------

    private void buildSetup() {
        steps.removeAllViews();
        steps.addView(text("YakkBot", 28, true));
        status = text("Looking for YakkBot on this phone…", 15, false);
        status.setPadding(0, dp(6), 0, dp(18));
        steps.addView(status);

        boolean termux = Termux.installed(this);
        steps.addView(heading("Get it running"));
        steps.addView(step(termux ? "✓ Termux is installed" : "1. Install Termux (from F-Droid)", termux ? null : "Termux is the small Linux system YakkBot runs in. Use the F-Droid version; the Play Store one is out of date.", termux ? null : "Get Termux", v -> open(new Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/")))));
        steps.addView(step("2. Install YakkBot in Termux", "Copies one command. Paste it into Termux and press Enter. It takes a few minutes and shows your sign-in passphrase at the end. You only do this once.", "Copy command and open Termux", v -> {
            ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("YakkBot install", INSTALL));
            toast("Copied. Long-press in Termux and choose Paste.");
            Intent i = getPackageManager().getLaunchIntentForPackage(Termux.PKG);
            if (i != null) startActivity(i); else toast("Install Termux first.");
        }));
        boolean may = Termux.permitted(this);
        steps.addView(step(may ? "✓ YakkBot can start itself in Termux" : "3. Let this app start YakkBot", may ? null : "So you never have to open Termux again: the app starts the server when you open it, and after the phone restarts.", may ? "Start YakkBot now" : "Allow", v -> {
            if (Termux.permitted(this)) { String p = Termux.yakkbot(this, "start"); status.setText(p == null ? "Starting YakkBot in Termux…" : p); }
            else if (!Termux.installed(this)) toast("Install Termux first.");
            else requestPermissions(new String[]{Termux.PERMISSION}, REQ_TERMUX);
        }));

        steps.addView(heading("Phone control for your bots"));
        boolean acc = YakkAccessibilityService.instance != null;
        steps.addView(step(acc ? "✓ Screen control is on" : "Allow screen control", acc ? null : "Lets bots read the screen and tap, swipe and type in any app. In the list that opens, choose YakkBot phone control and turn it on. If Android says the setting is restricted: open App info for YakkBot, tap ⋮ and choose Allow restricted settings, then try again.", acc ? null : "Open Accessibility settings", v -> open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
        boolean notif = Bridge.notificationAccess(this);
        steps.addView(step(notif ? "✓ Bots can read notifications" : "Allow reading notifications", notif ? null : "Lets bots see and clear what is in your notification shade.", notif ? null : "Open notification access", v -> open(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))));
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        boolean batt = pm.isIgnoringBatteryOptimizations(getPackageName());
        steps.addView(step(batt ? "✓ Allowed to run in the background" : "Keep running in the background", batt ? null : "Stops Android from putting YakkBot to sleep. Do the same for Termux: Settings > Apps > Termux > Battery > Unrestricted.", batt ? null : "Allow", v -> battery()));
        steps.addView(step("App info", "Permissions, restricted settings and battery for this app.", "Open", v -> appInfo()));
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(dark() ? 0xFFF5F5F5 : 0xFF1C1C1C);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s.toUpperCase(), 12, true);
        t.setTextColor(dark() ? 0x99F5F5F5 : 0x991C1C1C);
        t.setLetterSpacing(0.08f);
        t.setPadding(0, dp(18), 0, dp(8));
        return t;
    }

    private View step(String title, String detail, String action, View.OnClickListener onClick) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(dark() ? 0xFF1A1A1A : 0xFFFFFFFF);
        bg.setCornerRadius(dp(16));
        bg.setStroke(1, dark() ? 0x22FFFFFF : 0x221C1C1C);
        card.setBackground(bg);
        int p = dp(16);
        card.setPadding(p, dp(14), p, dp(14));
        card.addView(text(title, 16, true));
        if (detail != null) {
            TextView d = text(detail, 14, false);
            d.setTextColor(dark() ? 0xB3F5F5F5 : 0xB31C1C1C);
            d.setPadding(0, dp(4), 0, 0);
            d.setLineSpacing(0, 1.15f);
            card.addView(d);
        }
        if (action != null) {
            Button b = new Button(this);
            b.setText(action);
            b.setAllCaps(false);
            b.setTextColor(Color.WHITE);
            b.setTextSize(15);
            GradientDrawable bb = new GradientDrawable();
            bb.setColor(0xFFEE620D);
            bb.setCornerRadius(dp(22));
            b.setBackground(bb);
            b.setOnClickListener(onClick);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44));
            lp.topMargin = dp(12);
            lp.gravity = Gravity.START;
            b.setPadding(dp(20), 0, dp(20), 0);
            card.addView(b, lp);
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(10);
        card.setLayoutParams(lp);
        return card;
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

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_MIC && pendingMic != null) {
            if (granted) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else pendingMic.deny();
            pendingMic = null;
        } else if (code == REQ_TERMUX) {
            if (granted) { triedStart = false; buildSetup(); checkServer(); }
            else toast("Android did not grant it. Open App info > Permissions > Additional permissions and allow \"Run commands in Termux\".");
        }
    }
}
