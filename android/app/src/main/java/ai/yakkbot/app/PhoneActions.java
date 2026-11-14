package ai.yakkbot.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.Telephony;
import android.speech.tts.TextToSpeech;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.widget.Toast;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The phone's own jobs, done by the app with Android permissions: texts, calls, contacts,
 * calendar, alarms, location, notifications and more. Called by the YakkBot server through the
 * bridge (POST /phone). Ported from D-Agent's PhoneActions.
 */
final class PhoneActions {
    /** A permission the owner has not given yet. The bridge asks for it and tells the bot. */
    static final class NeedPermission extends IllegalStateException {
        final String why; final String[] perms;
        NeedPermission(String why, String... perms) { super("needs permission " + why); this.why = why; this.perms = perms; }
    }

    static final String CHANNEL = "bots";
    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static TextToSpeech tts;

    PhoneActions(Context c) { ctx = c.getApplicationContext(); }

    JSONObject run(JSONObject a) throws Exception {
        String action = a.optString("action");
        String out;
        switch (action) {
            case "notify": out = notify(a.optString("title", "YakkBot"), a.optString("text", a.optString("message", ""))); break;
            case "toast": onMain(() -> Toast.makeText(ctx, a.optString("text"), Toast.LENGTH_LONG).show()); out = "Shown."; break;
            case "vibrate": out = vibrate(a.optLong("ms", 400)); break;
            case "speak": out = speak(need(a, "text")); break;
            case "clipboard_get": out = clipboardGet(); break;
            case "clipboard_set": out = clipboardSet(a.optString("text")); break;
            case "battery": out = battery(); break;
            case "device": out = device(); break;
            case "wifi": out = wifi(); break;
            case "location": out = location(); break;
            case "sms_send": out = smsSend(firstOf(a, "number", "to"), need(a, "text"), sim(a)); break;
            case "sms_list": out = smsList(a.optInt("limit", 10), a.optString("number", "")); break;
            case "call": out = call(firstOf(a, "number", "to"), sim(a)); break;
            case "contacts": out = contacts(a.optString("query", a.optString("text", ""))); break;
            case "call_log": out = callLog(a.optInt("limit", 10)); break;
            case "torch": out = torch(a.optBoolean("on", true)); break;
            case "volume": out = volume(a); break;
            case "open_url": out = start(new Intent(Intent.ACTION_VIEW, Uri.parse(need(a, "url"))), "Opened " + a.optString("url") + "."); break;
            case "share": out = start(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, firstOf(a, "text", "path")), "Share"), "Opened the share sheet."); break;
            case "alarm": out = alarm(need(a, "time"), a.optString("label"), a.optString("days")); break;
            case "timer": out = timer(a.optInt("seconds", 60), a.optString("label")); break;
            case "calendar_events": out = calendarEvents(a.optInt("days", 7), a.optString("query")); break;
            case "calendar_add": out = calendarAdd(a); break;
            case "maps": out = maps(firstOf(a, "query", "text"), a.optString("mode", "search")); break;
            case "photo": throw new IllegalStateException("Taking photos is not available in the app yet. Ask the owner to send a picture instead.");
            default: throw new IllegalStateException("Unknown phone action \"" + action + "\".");
        }
        return new JSONObject().put("ok", true).put("output", out);
    }

    // ---------- permissions ----------

    boolean granted(String... perms) {
        for (String p : perms) if (ctx.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    private void require(String why, String... perms) {
        if (!granted(perms)) throw new NeedPermission(why, perms);
    }

    /** The groups the app asks for, and whether each is granted. Shown on the Phone control page. */
    static final Map<String, String[]> GROUPS = new LinkedHashMap<>();
    static {
        GROUPS.put("sms", new String[]{Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS});
        GROUPS.put("calls", new String[]{Manifest.permission.CALL_PHONE, Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE});
        GROUPS.put("contacts", new String[]{Manifest.permission.READ_CONTACTS});
        GROUPS.put("calendar", new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR});
        GROUPS.put("location", new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION});
        if (Build.VERSION.SDK_INT >= 33) GROUPS.put("notifications", new String[]{Manifest.permission.POST_NOTIFICATIONS});
    }

    JSONObject groups() throws Exception {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, String[]> e : GROUPS.entrySet()) o.put(e.getKey(), granted(e.getValue()));
        return o;
    }

    // ---------- the actions ----------

    @SuppressLint("MissingPermission")
    private String notify(String title, String text) {
        if (Build.VERSION.SDK_INT >= 33) require("to show notifications", Manifest.permission.POST_NOTIFICATIONS);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Messages from your bots", NotificationManager.IMPORTANCE_HIGH));
        PendingIntent open = PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        android.app.Notification n = new android.app.Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true).setContentIntent(open).build();
        nm.notify((int) (System.currentTimeMillis() % 100000), n);
        return "Notification shown.";
    }

    private String vibrate(long ms) {
        Vibrator v = ctx.getSystemService(Vibrator.class);
        v.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(ms, 5000)), VibrationEffect.DEFAULT_AMPLITUDE));
        return "Buzzed.";
    }

    private String speak(String text) throws InterruptedException {
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<String> problem = new AtomicReference<>();
        onMain(() -> {
            if (tts != null) { ready.countDown(); return; }
            tts = new TextToSpeech(ctx, status -> {
                if (status != TextToSpeech.SUCCESS) { problem.set("This phone has no text-to-speech voice."); tts = null; }
                ready.countDown();
            });
        });
        ready.await(10, TimeUnit.SECONDS);
        if (problem.get() != null) throw new IllegalStateException(problem.get());
        if (tts == null) throw new IllegalStateException("Text-to-speech did not start.");
        tts.speak(text.length() > 3900 ? text.substring(0, 3900) : text, TextToSpeech.QUEUE_ADD, null, "yakk" + System.nanoTime());
        return "Speaking.";
    }

    private String clipboardGet() throws InterruptedException {
        AtomicReference<String> v = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        onMain(() -> {
            ClipboardManager cm = ctx.getSystemService(ClipboardManager.class);
            ClipData clip = cm.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence t = clip.getItemAt(0).coerceToText(ctx);
                v.set(t == null ? null : t.toString());
            }
            done.countDown();
        });
        done.await(3, TimeUnit.SECONDS);
        if (v.get() == null) return "The clipboard is empty, or Android hid it: Android only lets an app read the clipboard while it is open on screen.";
        return "Clipboard: " + v.get();
    }

    private String clipboardSet(String text) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        onMain(() -> { ctx.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("YakkBot", text)); done.countDown(); });
        done.await(3, TimeUnit.SECONDS);
        return "Copied to the clipboard.";
    }

    private String battery() {
        BatteryManager bm = ctx.getSystemService(BatteryManager.class);
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) + "%" + (bm.isCharging() ? ", charging" : "");
    }

    private String device() {
        android.app.ActivityManager am = ctx.getSystemService(android.app.ActivityManager.class);
        android.app.ActivityManager.MemoryInfo mem = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mem);
        android.os.StatFs stat = new android.os.StatFs(ctx.getFilesDir().getAbsolutePath());
        return String.format(Locale.US, "%s %s, Android %s (API %d), RAM %.1f GB (%.1f GB free), storage %.1f GB free, battery %s",
                Build.MANUFACTURER, Build.MODEL, Build.VERSION.RELEASE, Build.VERSION.SDK_INT,
                mem.totalMem / 1e9, mem.availMem / 1e9, stat.getAvailableBytes() / 1e9, battery());
    }

    @SuppressWarnings("deprecation")
    private String wifi() {
        WifiManager wm = ctx.getSystemService(WifiManager.class);
        if (wm == null || !wm.isWifiEnabled()) return "Wi-Fi is off.";
        WifiInfo info = wm.getConnectionInfo();
        String ssid = info == null ? null : info.getSSID();
        if (ssid == null || ssid.contains("unknown")) ssid = "a network (Android hides its name without location access)";
        return "Wi-Fi is on, connected to " + ssid + (info != null ? ", signal " + info.getRssi() + " dBm" : "") + ".";
    }

    @SuppressLint("MissingPermission")
    private String location() throws Exception {
        require("to know where you are", Manifest.permission.ACCESS_COARSE_LOCATION);
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        Location best = null;
        for (String p : lm.getProviders(true)) {
            try { Location l = lm.getLastKnownLocation(p); if (l != null && (best == null || l.getTime() > best.getTime())) best = l; } catch (Exception ignored) {}
        }
        if ((best == null || System.currentTimeMillis() - best.getTime() > 10 * 60_000) && Build.VERSION.SDK_INT >= 30) {
            List<String> providers = lm.getProviders(true);
            String provider = providers.contains(LocationManager.FUSED_PROVIDER) ? LocationManager.FUSED_PROVIDER
                    : providers.contains(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER
                    : providers.contains(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : null;
            if (provider != null) {
                AtomicReference<Location> fresh = new AtomicReference<>();
                CountDownLatch done = new CountDownLatch(1);
                lm.getCurrentLocation(provider, null, ctx.getMainExecutor(), l -> { fresh.set(l); done.countDown(); });
                done.await(15, TimeUnit.SECONDS);
                if (fresh.get() != null) best = fresh.get();
            }
        }
        if (best == null) return "Location is off, or the phone has no fix yet.";
        String addr = "";
        try {
            @SuppressWarnings("deprecation")
            List<android.location.Address> list = new android.location.Geocoder(ctx, Locale.US).getFromLocation(best.getLatitude(), best.getLongitude(), 1);
            if (list != null && !list.isEmpty() && list.get(0).getAddressLine(0) != null) addr = "\nAddress: " + list.get(0).getAddressLine(0);
        } catch (Exception ignored) {}
        return String.format(Locale.US, "Latitude %.5f, longitude %.5f (accuracy about %d m)%s", best.getLatitude(), best.getLongitude(), (int) best.getAccuracy(), addr);
    }

    @SuppressLint("MissingPermission")
    private List<SubscriptionInfo> sims() {
        if (!granted(Manifest.permission.READ_PHONE_STATE)) return new ArrayList<>();
        SubscriptionManager sm = ctx.getSystemService(SubscriptionManager.class);
        try { List<SubscriptionInfo> l = sm.getActiveSubscriptionInfoList(); return l == null ? new ArrayList<>() : l; } catch (Exception e) { return new ArrayList<>(); }
    }

    private int sim(JSONObject a) {
        String s = a.optString("sim", "").replaceAll("[^0-9]", "");
        try { int n = Integer.parseInt(s); return n >= 1 && n <= 4 ? n : 0; } catch (NumberFormatException e) { return 0; }
    }

    private SubscriptionInfo simFor(int slot) {
        if (slot <= 0) return null;
        for (SubscriptionInfo s : sims()) if (s.getSimSlotIndex() == slot - 1) return s;
        return null;
    }

    /** A number as given, or the first number of the best matching contact. */
    private String resolveNumber(String to) {
        int digits = 0;
        for (char c : to.toCharArray()) if (Character.isDigit(c)) digits++;
        if (digits >= 3) return to;
        require("to find " + to + " in your contacts", Manifest.permission.READ_CONTACTS);
        try (Cursor c = ctx.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.NUMBER}, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?", new String[]{"%" + to + "%"}, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        }
        throw new IllegalStateException("No contact called \"" + to + "\" has a phone number.");
    }

    @SuppressWarnings("deprecation")
    private String smsSend(String to, String text, int slot) {
        require("to send texts", Manifest.permission.SEND_SMS);
        String number = resolveNumber(to);
        SubscriptionInfo s = simFor(slot);
        if (slot > 0 && s == null) throw new IllegalStateException("There is no SIM " + slot + " in this phone.");
        SmsManager sms = s != null
                ? (Build.VERSION.SDK_INT >= 31 ? ctx.getSystemService(SmsManager.class).createForSubscriptionId(s.getSubscriptionId()) : SmsManager.getSmsManagerForSubscriptionId(s.getSubscriptionId()))
                : (Build.VERSION.SDK_INT >= 31 ? ctx.getSystemService(SmsManager.class) : SmsManager.getDefault());
        sms.sendMultipartTextMessage(number, null, sms.divideMessage(text), null, null);
        return "Text sent to " + to + (number.equals(to) ? "" : " (" + number + ")") + (s != null ? " from SIM " + slot : "") + ".";
    }

    private String smsList(int limit, String number) {
        require("to read your texts", Manifest.permission.READ_SMS);
        StringBuilder out = new StringBuilder();
        String sel = number.isEmpty() ? null : Telephony.Sms.ADDRESS + " LIKE ?";
        String[] args = number.isEmpty() ? null : new String[]{"%" + number.replaceAll("[^0-9+]", "") + "%"};
        SimpleDateFormat fmt = new SimpleDateFormat("MMM d, h:mm a", Locale.US);
        try (Cursor c = ctx.getContentResolver().query(Telephony.Sms.CONTENT_URI, new String[]{Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE}, sel, args, Telephony.Sms.DATE + " DESC")) {
            int n = 0;
            while (c != null && c.moveToNext() && n++ < Math.min(Math.max(limit, 1), 50)) {
                boolean sent = c.getInt(3) == Telephony.Sms.MESSAGE_TYPE_SENT;
                out.append(fmt.format(new Date(c.getLong(2)))).append(sent ? " to " : " from ").append(c.getString(0)).append(": ").append(c.getString(1)).append('\n');
            }
        }
        return out.length() == 0 ? "No texts found." : out.toString().trim();
    }

    @SuppressLint("MissingPermission")
    private String call(String to, int slot) {
        String number = resolveNumber(to);
        if (!granted(Manifest.permission.CALL_PHONE)) {
            start(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number))), "");
            throw new NeedPermission("to place calls (the dialer is open with the number, so the owner can tap Call)", Manifest.permission.CALL_PHONE);
        }
        Intent i = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)));
        if (slot > 0) {
            SubscriptionInfo s = simFor(slot);
            if (s == null) throw new IllegalStateException("There is no SIM " + slot + " in this phone.");
            android.telecom.TelecomManager tm = ctx.getSystemService(android.telecom.TelecomManager.class);
            for (android.telecom.PhoneAccountHandle h : tm.getCallCapablePhoneAccounts()) {
                if (h.getId().equals(String.valueOf(s.getSubscriptionId())) || h.getId().equals(s.getIccId())) i.putExtra(android.telecom.TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, h);
            }
            i.putExtra("com.android.phone.extra.slot", slot - 1).putExtra("simSlot", slot - 1);
        }
        return start(i, "Calling " + to + (number.equals(to) ? "" : " (" + number + ")") + ".");
    }

    private String contacts(String query) {
        require("to look up your contacts", Manifest.permission.READ_CONTACTS);
        Map<String, List<String>> out = new LinkedHashMap<>();
        String sel = query.isEmpty() ? null : ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ? OR " + ContactsContract.CommonDataKinds.Phone.NUMBER + " LIKE ?";
        String[] args = query.isEmpty() ? null : new String[]{"%" + query + "%", "%" + query + "%"};
        try (Cursor c = ctx.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER}, sel, args, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
            while (c != null && c.moveToNext() && out.size() < 60) {
                String name = c.getString(0) == null ? "?" : c.getString(0);
                out.computeIfAbsent(name, k -> new ArrayList<>()).add(c.getString(1));
            }
        }
        if (out.isEmpty()) return query.isEmpty() ? "No contacts." : "No contacts match \"" + query + "\".";
        StringBuilder s = new StringBuilder();
        for (Map.Entry<String, List<String>> e : out.entrySet()) s.append(e.getKey()).append(": ").append(String.join(", ", e.getValue())).append('\n');
        return s.toString().trim();
    }

    private String callLog(int limit) {
        require("to read your call history", Manifest.permission.READ_CALL_LOG);
        StringBuilder out = new StringBuilder();
        SimpleDateFormat fmt = new SimpleDateFormat("MMM d, h:mm a", Locale.US);
        try (Cursor c = ctx.getContentResolver().query(CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION}, null, null, CallLog.Calls.DATE + " DESC")) {
            int n = 0;
            while (c != null && c.moveToNext() && n++ < Math.min(Math.max(limit, 1), 50)) {
                int type = c.getInt(2);
                String kind = type == CallLog.Calls.INCOMING_TYPE ? "incoming" : type == CallLog.Calls.OUTGOING_TYPE ? "outgoing" : type == CallLog.Calls.MISSED_TYPE ? "missed" : "other";
                String name = c.getString(1);
                out.append(fmt.format(new Date(c.getLong(3)))).append(' ').append(kind).append(' ')
                        .append(name != null && !name.isEmpty() ? name + " (" + c.getString(0) + ")" : c.getString(0))
                        .append(", ").append(c.getLong(4)).append(" s\n");
            }
        }
        return out.length() == 0 ? "No calls." : out.toString().trim();
    }

    private String torch(boolean on) throws Exception {
        CameraManager cm = ctx.getSystemService(CameraManager.class);
        for (String id : cm.getCameraIdList()) {
            Boolean flash = cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (Boolean.TRUE.equals(flash)) { cm.setTorchMode(id, on); return "Flashlight " + (on ? "on" : "off") + "."; }
        }
        return "This phone has no flashlight.";
    }

    private String volume(JSONObject a) {
        AudioManager am = ctx.getSystemService(AudioManager.class);
        String which = a.optString("stream", "music");
        int stream = which.equals("ring") ? AudioManager.STREAM_RING : which.equals("alarm") ? AudioManager.STREAM_ALARM : which.equals("notification") ? AudioManager.STREAM_NOTIFICATION : AudioManager.STREAM_MUSIC;
        int max = am.getStreamMaxVolume(stream);
        if (!a.has("level")) return which + " volume is " + Math.round(100.0 * am.getStreamVolume(stream) / max) + "%.";
        int level = Math.max(0, Math.min(100, a.optInt("level")));
        am.setStreamVolume(stream, (int) Math.round(level * max / 100.0), 0);
        return which + " volume set to " + level + "%.";
    }

    private String alarm(String time, String label, String days) {
        int[] hm = parseTime(time);
        if (hm == null) throw new IllegalStateException("Couldn't read the time \"" + time + "\". Use 7:30 or 19:30.");
        Intent i = new Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, hm[0]).putExtra(AlarmClock.EXTRA_MINUTES, hm[1]).putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        if (!label.isEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        ArrayList<Integer> list = new ArrayList<>();
        String[] names = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};
        for (String d : days.toLowerCase(Locale.ROOT).split("[,\\s]+")) for (int k = 0; k < 7; k++) if (d.startsWith(names[k])) list.add(k + 1);
        if (!list.isEmpty()) i.putExtra(AlarmClock.EXTRA_DAYS, list);
        return start(i, String.format(Locale.US, "Alarm set for %d:%02d%s.", hm[0], hm[1], label.isEmpty() ? "" : " (" + label + ")"));
    }

    private static int[] parseTime(String s) {
        String t = s.trim().toLowerCase(Locale.ROOT).replace(".", "");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?$").matcher(t);
        if (!m.find()) return null;
        int h = Integer.parseInt(m.group(1)), mi = m.group(2) == null ? 0 : Integer.parseInt(m.group(2));
        if ("pm".equals(m.group(3)) && h < 12) h += 12;
        if ("am".equals(m.group(3)) && h == 12) h = 0;
        return h > 23 || mi > 59 ? null : new int[]{h, mi};
    }

    private String timer(int seconds, String label) {
        Intent i = new Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, Math.max(1, seconds)).putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        if (!label.isEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        return start(i, "Timer set for " + seconds + " seconds.");
    }

    private String calendarEvents(int days, String query) {
        require("to read your calendar", Manifest.permission.READ_CALENDAR);
        long now = System.currentTimeMillis(), end = now + Math.max(1, Math.min(days, 365)) * 86_400_000L;
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, now);
        ContentUris.appendId(b, end);
        SimpleDateFormat fmt = new SimpleDateFormat("EEE MMM d, h:mm a", Locale.US);
        StringBuilder out = new StringBuilder();
        try (Cursor c = ctx.getContentResolver().query(b.build(), new String[]{CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.ALL_DAY}, null, null, CalendarContract.Instances.BEGIN + " ASC")) {
            int n = 0;
            while (c != null && c.moveToNext() && n < 60) {
                String title = c.getString(0) == null ? "(no title)" : c.getString(0);
                if (!query.isEmpty() && !title.toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT))) continue;
                String loc = c.getString(2);
                out.append("- ").append(c.getInt(3) == 1 ? new SimpleDateFormat("EEE MMM d", Locale.US).format(new Date(c.getLong(1))) + " (all day)" : fmt.format(new Date(c.getLong(1))))
                        .append(": ").append(title).append(loc != null && !loc.isEmpty() ? " @ " + loc : "").append('\n');
                n++;
            }
        }
        return out.length() == 0 ? "No events in the next " + days + " days." : out.toString().trim();
    }

    private String calendarAdd(JSONObject a) throws Exception {
        require("to add to your calendar", Manifest.permission.WRITE_CALENDAR, Manifest.permission.READ_CALENDAR);
        Date start = parseDate(need(a, "start"));
        if (start == null) throw new IllegalStateException("Couldn't read the start \"" + a.optString("start") + "\". Use YYYY-MM-DD HH:MM.");
        Date end = a.has("end") ? parseDate(a.optString("end")) : null;
        if (end == null) end = new Date(start.getTime() + 3_600_000L);
        Long calId = null;
        try (Cursor c = ctx.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, new String[]{CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (c.getInt(2) < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) continue;
                if (calId == null || c.getInt(1) == 1) calId = c.getLong(0);
            }
        }
        if (calId == null) throw new IllegalStateException("No calendar on this phone accepts new events. Sign in to a calendar account first.");
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Events.CALENDAR_ID, calId);
        v.put(CalendarContract.Events.TITLE, need(a, "title"));
        v.put(CalendarContract.Events.DTSTART, start.getTime());
        v.put(CalendarContract.Events.DTEND, end.getTime());
        v.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
        if (a.has("location")) v.put(CalendarContract.Events.EVENT_LOCATION, a.optString("location"));
        if (a.has("notes")) v.put(CalendarContract.Events.DESCRIPTION, a.optString("notes"));
        if (ctx.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, v) == null) throw new IllegalStateException("The calendar refused the event.");
        return "Added \"" + a.optString("title") + "\" on " + new SimpleDateFormat("EEE MMM d, h:mm a", Locale.US).format(start) + ".";
    }

    private static Date parseDate(String s) {
        String t = s.trim().replace('T', ' ');
        for (String p : new String[]{"yyyy-MM-dd HH:mm", "yyyy-MM-dd H:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd h:mm a", "MM/dd/yyyy HH:mm", "MM/dd/yyyy h:mm a", "yyyy-MM-dd"}) {
            try {
                SimpleDateFormat f = new SimpleDateFormat(p, Locale.US);
                f.setLenient(false);
                Date d = f.parse(t);
                if (d == null) continue;
                if (p.equals("yyyy-MM-dd")) { Calendar c = Calendar.getInstance(); c.setTime(d); c.set(Calendar.HOUR_OF_DAY, 9); return c.getTime(); }
                return d;
            } catch (Exception ignored) {}
        }
        return null;
    }

    private String maps(String query, String mode) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(mode.equals("navigate") ? "google.navigation:q=" + Uri.encode(query) : "geo:0,0?q=" + Uri.encode(query)));
        if (i.resolveActivity(ctx.getPackageManager()) == null) i = new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/search/?api=1&query=" + Uri.encode(query)));
        return start(i, "Opened maps for " + query + ".");
    }

    // ---------- helpers ----------

    /** Opening another app from the background is allowed while YakkBot's accessibility service runs. */
    private String start(Intent i, String done) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Context from = YakkAccessibilityService.instance != null ? YakkAccessibilityService.instance : ctx;
        try { from.startActivity(i); return done; }
        catch (Exception e) { throw new IllegalStateException("No app on this phone can do that, or Android blocked it from the background (" + e.getMessage() + "). Turning on screen control lets YakkBot open apps from the background."); }
    }

    private void onMain(Runnable r) { if (Looper.myLooper() == Looper.getMainLooper()) r.run(); else main.post(r); }

    private static String need(JSONObject a, String key) {
        String v = a.optString(key, "").trim();
        if (v.isEmpty()) throw new IllegalStateException("missing \"" + key + "\"");
        return v;
    }

    private static String firstOf(JSONObject a, String... keys) {
        for (String k : keys) { String v = a.optString(k, "").trim(); if (!v.isEmpty()) return v; }
        throw new IllegalStateException("missing \"" + keys[0] + "\"");
    }
}
