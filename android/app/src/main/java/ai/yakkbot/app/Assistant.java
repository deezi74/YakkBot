package ai.yakkbot.app;

import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

/**
 * Lets YakkBot be picked as the phone's digital assistant (Settings › Apps › Default apps ›
 * Digital assistant app). When it is the assistant, the phone's assist gesture (long-press the
 * power or home button, swipe up from a bottom corner) or a headset's voice button opens YakkBot
 * straight into a voice conversation with your bot.
 *
 * An activity-alias (AssistantEntry) answers the system's ASSIST and VOICE_COMMAND intents.
 * Turning assistant mode off disables the alias, so YakkBot leaves the phone's assistant list and
 * stops answering the gesture. No speech recognizer is registered, so the phone's own speech
 * recognition (which talk mode uses) keeps working whichever assistant is picked.
 */
final class Assistant {
    private Assistant() {}

    /** Class name of the activity-alias in the manifest. */
    static final String ALIAS = "ai.yakkbot.app.AssistantEntry";

    private static ComponentName component(Context c) { return new ComponentName(c.getPackageName(), ALIAS); }

    /** On by default; off once turned off in Settings › Phone control. */
    static boolean enabled(Context c) {
        return c.getPackageManager().getComponentEnabledSetting(component(c)) != PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
    }

    static void setEnabled(Context c, boolean on) {
        c.getPackageManager().setComponentEnabledSetting(component(c),
                on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
    }

    /** Whether YakkBot is the phone's assistant now; null where Android can't say (before Android 10). */
    static Boolean isDefault(Context c) {
        if (Build.VERSION.SDK_INT < 29) return null;
        try {
            RoleManager rm = c.getSystemService(RoleManager.class);
            if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) return null;
            return rm.isRoleHeld(RoleManager.ROLE_ASSISTANT);
        } catch (Exception e) {
            return null;
        }
    }

    static String info(Context c) {
        try {
            JSONObject o = new JSONObject().put("enabled", enabled(c));
            Boolean d = isDefault(c);
            if (d != null) o.put("isDefault", d.booleanValue());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Opens the phone's settings where the assistant is picked (an app can't pick itself). */
    static boolean openPicker(Context c) {
        String[] actions = { Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS };
        for (String a : actions) {
            try {
                c.startActivity(new Intent(a).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            } catch (Exception ignored) { /* try the next screen */ }
        }
        return false;
    }

    /** True when the intent came from the assist gesture or a voice-command button. */
    static boolean isAssistLaunch(Intent i) {
        if (i == null) return false;
        String a = i.getAction();
        return Intent.ACTION_ASSIST.equals(a) || Intent.ACTION_VOICE_COMMAND.equals(a);
    }
}
