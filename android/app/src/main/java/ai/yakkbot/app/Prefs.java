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
}
