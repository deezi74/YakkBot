package ai.yakkbot.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.SecureRandom;

/** Small settings kept on the phone: where the YakkBot server is, and the bridge's token. */
final class Prefs {
    static final int SERVER_PORT = 8787;
    static final int BRIDGE_PORT = 8765;

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("yakkbot", Context.MODE_PRIVATE);
    }

    static String serverUrl(Context c) {
        return "http://127.0.0.1:" + sp(c).getInt("serverPort", SERVER_PORT);
    }

    /** The secret a caller must present to the phone bridge. Made once, on first use. */
    static synchronized String token(Context c) {
        String t = sp(c).getString("bridgeToken", null);
        if (t == null) {
            byte[] b = new byte[32];
            new SecureRandom().nextBytes(b);
            StringBuilder s = new StringBuilder();
            for (byte x : b) s.append(String.format("%02x", x));
            t = s.toString();
            sp(c).edit().putString("bridgeToken", t).apply();
        }
        return t;
    }

    static boolean startOnBoot(Context c) { return sp(c).getBoolean("startOnBoot", true); }

    /** What the bots call the owner. Asked once during setup. */
    static String ownerName(Context c) { return sp(c).getString("ownerName", "Owner"); }
    static void setOwnerName(Context c, String name) { sp(c).edit().putString("ownerName", name).apply(); }

    /** Open the app to the home Wi-Fi (so a PC can use it), instead of this phone only. */
    static boolean lan(Context c) { return sp(c).getBoolean("lan", false); }
    static void setLan(Context c, boolean on) { sp(c).edit().putBoolean("lan", on).apply(); }

    /** Signed in once in the app's chat window. */
    static boolean signedIn(Context c) { return sp(c).getBoolean("signedIn", false); }
    static void setSignedIn(Context c, boolean v) { sp(c).edit().putBoolean("signedIn", v).apply(); }
}
