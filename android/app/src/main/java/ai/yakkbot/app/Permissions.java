package ai.yakkbot.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/**
 * Android only shows a permission prompt from a screen the person is looking at. When a bot needs
 * one, the bridge posts a notification; tapping it opens the app, which shows the prompt.
 */
final class Permissions {
    static final String EXTRA = "yakk.ask";
    static final String EXTRA_WHY = "yakk.why";
    private static final String CHANNEL = "permissions";

    private Permissions() {}

    static void ask(Context c, String why, String[] perms) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Permission requests", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA, perms).putExtra(EXTRA_WHY, why);
        PendingIntent pi = PendingIntent.getActivity(c, why.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("A bot needs your permission")
                .setContentText("Tap to let YakkBot " + why.replaceFirst("^to ", "") + ".")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        try { nm.notify(1000 + Math.abs(why.hashCode() % 1000), n); } catch (SecurityException ignored) { /* notifications are off */ }
    }
}
