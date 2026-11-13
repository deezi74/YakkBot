package ai.yakkbot.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The hands and eyes a bot uses on the phone: read what is on screen, tap, swipe, type, press the
 * system buttons, take a screenshot. It acts only on calls from the bridge; it watches nothing on
 * its own.
 */
public class YakkAccessibilityService extends AccessibilityService {
    static volatile YakkAccessibilityService instance;

    @Override protected void onServiceConnected() { instance = this; }
    @Override public boolean onUnbind(android.content.Intent intent) { instance = null; return super.onUnbind(intent); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* nothing is recorded */ }
    @Override public void onInterrupt() {}

    // ---------- reading the screen ----------

    JSONObject dump(int max) throws Exception {
        JSONObject out = new JSONObject();
        JSONArray nodes = new JSONArray();
        AccessibilityNodeInfo root = activeRoot();
        if (root != null) {
            out.put("app", String.valueOf(root.getPackageName()));
            walk(root, nodes, max, 0);
        }
        android.util.DisplayMetrics m = getResources().getDisplayMetrics();
        out.put("screen", new JSONObject().put("width", m.widthPixels).put("height", m.heightPixels));
        out.put("nodes", nodes);
        return out;
    }

    private AccessibilityNodeInfo activeRoot() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) return root;
        List<AccessibilityWindowInfo> ws = getWindows();
        for (AccessibilityWindowInfo w : ws) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && w.getRoot() != null) return w.getRoot();
        }
        return null;
    }

    private void walk(AccessibilityNodeInfo n, JSONArray out, int max, int depth) throws Exception {
        if (n == null || out.length() >= max || depth > 60) return;
        if (n.isVisibleToUser()) {
            String text = str(n.getText());
            String desc = str(n.getContentDescription());
            boolean useful = !text.isEmpty() || !desc.isEmpty() || n.isClickable() || n.isEditable() || n.isScrollable() || n.isCheckable();
            if (useful) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0) {
                    JSONObject o = new JSONObject();
                    if (!text.isEmpty()) o.put("text", clip(text, 200));
                    if (!desc.isEmpty()) o.put("label", clip(desc, 120));
                    String id = n.getViewIdResourceName();
                    if (id != null) o.put("id", id.substring(id.indexOf('/') + 1));
                    String cls = str(n.getClassName());
                    o.put("kind", cls.substring(cls.lastIndexOf('.') + 1));
                    o.put("x", r.centerX());
                    o.put("y", r.centerY());
                    if (n.isClickable()) o.put("tap", true);
                    if (n.isEditable()) o.put("edit", true);
                    if (n.isScrollable()) o.put("scroll", true);
                    if (n.isCheckable()) o.put("checked", n.isChecked());
                    if (n.isFocused()) o.put("focused", true);
                    out.put(o);
                }
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), out, max, depth + 1);
    }

    /** The centre of the first visible element whose text or label contains `needle`. */
    int[] find(String needle) {
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return null;
        return findIn(root, needle.toLowerCase(Locale.ROOT), 0);
    }

    private int[] findIn(AccessibilityNodeInfo n, String needle, int depth) {
        if (n == null || depth > 60) return null;
        if (n.isVisibleToUser()) {
            String hay = (str(n.getText()) + "\n" + str(n.getContentDescription())).toLowerCase(Locale.ROOT);
            if (hay.contains(needle)) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0) return new int[]{r.centerX(), r.centerY()};
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            int[] hit = findIn(n.getChild(i), needle, depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    // ---------- acting ----------

    boolean tap(int x, int y, long holdMs) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x, y);
        return gesture(p, Math.max(40, holdMs));
    }

    boolean swipe(int x1, int y1, int x2, int y2, long ms) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        return gesture(p, Math.max(80, ms));
    }

    private boolean gesture(Path path, long ms) throws InterruptedException {
        GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, ms)).build();
        final CountDownLatch done = new CountDownLatch(1);
        final boolean[] ok = {false};
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ok[0] = true; done.countDown(); }
            @Override public void onCancelled(GestureDescription d) { done.countDown(); }
        }, null);
        if (!sent) return false;
        done.await(ms + 3000, TimeUnit.MILLISECONDS);
        return ok[0];
    }

    /** Put text into the field that has the keyboard. */
    String type(String text, boolean append, boolean enter) {
        AccessibilityNodeInfo root = activeRoot();
        AccessibilityNodeInfo field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null || !field.isEditable()) return "No text field has the keyboard. Tap the field first.";
        String value = append ? str(field.getText()) + text : text;
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b)) return "That field did not accept text.";
        if (enter) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
            else return "Typed, but pressing Enter needs Android 11 or newer. Tap the send or search button instead.";
        }
        return null;
    }

    boolean key(String name) {
        switch (name) {
            case "back": return performGlobalAction(GLOBAL_ACTION_BACK);
            case "home": return performGlobalAction(GLOBAL_ACTION_HOME);
            case "recents": return performGlobalAction(GLOBAL_ACTION_RECENTS);
            case "notifications": return performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
            case "quick_settings": return performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS);
            case "power_menu": return performGlobalAction(GLOBAL_ACTION_POWER_DIALOG);
            case "lock": return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN);
            default: return false;
        }
    }

    // ---------- screenshot ----------

    /** A JPEG of the screen, scaled so its longer side is at most `maxSide`. Android 11+. */
    JSONObject screenshot(final int maxSide) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw new IllegalStateException("Screenshots need Android 11 or newer. Use the screen text instead.");
        final CountDownLatch done = new CountDownLatch(1);
        final JSONObject out = new JSONObject();
        final String[] error = {null};
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult result) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                    result.getHardwareBuffer().close();
                    if (hw == null) throw new IllegalStateException("empty screenshot");
                    Bitmap soft = hw.copy(Bitmap.Config.ARGB_8888, false);
                    int w = soft.getWidth(), h = soft.getHeight();
                    float scale = Math.min(1f, maxSide / (float) Math.max(w, h));
                    Bitmap small = scale < 1f ? Bitmap.createScaledBitmap(soft, Math.round(w * scale), Math.round(h * scale), true) : soft;
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    small.compress(Bitmap.CompressFormat.JPEG, 70, bytes);
                    out.put("image", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                    out.put("mime", "image/jpeg");
                    out.put("width", small.getWidth()).put("height", small.getHeight());
                    out.put("screenWidth", w).put("screenHeight", h);
                } catch (Exception e) {
                    error[0] = String.valueOf(e.getMessage());
                }
                done.countDown();
            }
            @Override public void onFailure(int code) { error[0] = "Android refused the screenshot (code " + code + "). Some screens, like banking apps, block it."; done.countDown(); }
        });
        if (!done.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("The screenshot timed out.");
        if (error[0] != null) throw new IllegalStateException(error[0]);
        return out;
    }

    private static String str(CharSequence c) { return c == null ? "" : c.toString(); }
    private static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) + "…" : s; }
}
