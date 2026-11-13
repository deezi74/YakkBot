package ai.yakkbot.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts (or the app updates): bring the bridge and the YakkBot server back. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Prefs.startOnBoot(context)) return;
        // The service starts the bridge and the server in the app's own Linux.
        BridgeService.start(context);
    }
}
