package ai.yakkbot.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Starts things inside Termux through its RUN_COMMAND intent. Termux only honours it when the
 * person has granted this app the "Run commands in Termux" permission and Termux's own settings
 * say `allow-external-apps = true` (the YakkBot installer sets that).
 */
final class Termux {
    static final String PKG = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String PREFIX = "/data/data/com.termux/files/usr";
    private static final String HOME = "/data/data/com.termux/files/home";

    private Termux() {}

    static boolean installed(Context c) {
        try { c.getPackageManager().getPackageInfo(PKG, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    static boolean permitted(Context c) {
        return c.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Run `yakkbot <arg>` in the background. Returns null when sent, or why it could not be. */
    static String yakkbot(Context c, String arg) {
        return run(c, new String[]{PREFIX + "/bin/yakkbot", arg}, true);
    }

    private static String run(Context c, String[] args, boolean background) {
        if (!installed(c)) return "Termux is not installed.";
        if (!permitted(c)) return "YakkBot is not allowed to run commands in Termux yet.";
        Intent i = new Intent();
        i.setClassName(PKG, "com.termux.app.RunCommandService");
        i.setAction("com.termux.RUN_COMMAND");
        i.putExtra("com.termux.RUN_COMMAND_PATH", PREFIX + "/bin/bash");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args);
        i.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i); else c.startService(i);
            return null;
        } catch (Exception e) {
            return "Termux did not accept the command: " + e.getMessage();
        }
    }
}
