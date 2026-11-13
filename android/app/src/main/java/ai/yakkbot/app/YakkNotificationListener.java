package ai.yakkbot.app;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

/** Lets a bot read what is in the notification shade, and dismiss an entry. */
public class YakkNotificationListener extends NotificationListenerService {
    static volatile YakkNotificationListener instance;

    @Override public void onListenerConnected() { instance = this; }
    @Override public void onListenerDisconnected() { instance = null; }

    JSONArray list(int limit) throws Exception {
        JSONArray out = new JSONArray();
        StatusBarNotification[] all = getActiveNotifications();
        if (all == null) return out;
        for (int i = all.length - 1; i >= 0 && out.length() < limit; i--) {
            StatusBarNotification n = all[i];
            Bundle x = n.getNotification().extras;
            CharSequence title = x.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null) text = x.getCharSequence(Notification.EXTRA_TEXT);
            if (title == null && text == null) continue;
            JSONObject o = new JSONObject();
            o.put("key", n.getKey());
            o.put("app", n.getPackageName());
            o.put("title", title == null ? "" : title.toString());
            o.put("text", text == null ? "" : clip(text.toString(), 600));
            o.put("time", n.getPostTime());
            o.put("ongoing", n.isOngoing());
            out.put(o);
        }
        return out;
    }

    void dismiss(String key) { cancelNotification(key); }

    private static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) + "…" : s; }
}
