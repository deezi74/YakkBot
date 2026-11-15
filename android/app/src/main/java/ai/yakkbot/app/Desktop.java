package ai.yakkbot.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.util.Map;

/**
 * The bots' computer screen, like Dots: a desktop (XFCE) with Chromium in the app's own Linux,
 * served over VNC on 127.0.0.1. The YakkBot server shows it live in the chat, lets the owner take
 * control, and gives the bots a screen tool (screenshots, clicks, typing). Optional: about 600 MB.
 */
final class Desktop {
    static final int VNC_PORT = 5901;
    static final String DISPLAY = ":1";
    /**
     * Only the desktop parts the bots use, not the full xfce4 bundle (which also pulls a second web
     * engine, speech synthesis and media plugins): 266 packages, about 350 MB to download, instead of
     * 373 and 430 MB. Chromium is most of what is left.
     */
    static final String PACKAGES = "chromium tigervnc xfwm4 xfce4-panel xfce4-session xfce4-terminal xfdesktop thunar dbus dbus-x11 xdotool scrot font-dejavu font-noto font-noto-emoji adwaita-icon-theme";
    private static volatile String state = null;

    private Desktop() {}

    static File marker(Context c) { return new File(new Linux(c).base, ".desktop"); }
    static boolean installed(Context c) { return marker(c).isFile(); }

    static JSONObject status(Context c) {
        try {
            String s = state != null ? state : installed(c) ? "ready" : "none";
            JSONObject o = new JSONObject().put("state", s);
            if ("ready".equals(s)) {
                boolean up = running();
                o.put("running", up);
                if (!up) o.put("log", logTail(c));
            }
            return o;
        } catch (Exception e) { return new JSONObject(); }
    }

    /** Installs the desktop in the background; the server is restarted with a screen when it is done. */
    static synchronized void installAsync(Context ctx) {
        Context c = ctx.getApplicationContext();
        if (state != null && state.startsWith("installing")) return;
        Linux linux = new Linux(c);
        if (!linux.installed()) throw new IllegalStateException("Set up YakkBot's Linux first.");
        state = "installing: getting the package list";
        new Thread(() -> {
            File log = new File(linux.base, "desktop-install.log");
            try {
                Linux.write(log, "");
                // apk prints "(45/231) Installing chromium (...)": show that as it goes, so it never looks stuck.
                java.util.regex.Pattern step = java.util.regex.Pattern.compile("\\((\\d+)/(\\d+)\\) (Installing|Upgrading|Executing) ([^\\s(]+)");
                Linux.Result r = linux.run("apk update && apk add --no-progress " + PACKAGES, 3600, null, chunk -> {
                    try (java.io.FileWriter w = new java.io.FileWriter(log, true)) { w.write(chunk); } catch (java.io.IOException ignored) {}
                    java.util.regex.Matcher m = step.matcher(chunk);
                    String last = null;
                    while (m.find()) last = "installing: " + m.group(1) + " of " + m.group(2) + " packages (" + m.group(4) + ")";
                    if (last != null) state = last;
                    else if (chunk.contains("fetch ")) state = "installing: getting the package list";
                });
                if (r.code != 0) throw new IllegalStateException(Linux.tail(r.output, 600));
                state = "installing: setting it up";
                String pw = linux.secret("vnc.secret").substring(0, 8);
                String browser = "#!/bin/sh\n# Chromium inside YakkBot's Linux (no sandbox under PRoot).\nexec chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check \"$@\"\n";
                Linux.write(new File(linux.rootfs, "usr/local/bin/browser"), browser);
                Linux.Result s = linux.run("chmod +x /usr/local/bin/browser && mkdir -p /root/.vnc /root/Desktop && printf '%s\\n' '" + pw + "' | vncpasswd -f > /root/.vnc/passwd && chmod 600 /root/.vnc/passwd"
                        + " && printf '[Desktop Entry]\\nType=Application\\nName=Browser\\nExec=browser\\nIcon=chromium\\n' > /root/Desktop/browser.desktop && chmod +x /root/Desktop/browser.desktop"
                        + " && mkdir -p /root/.config/xfce4 && printf 'WebBrowser=custom-WebBrowser\\n' > /root/.config/xfce4/helpers.rc", 120, null);
                if (s.code != 0) throw new IllegalStateException(Linux.tail(s.output, 600));
                Linux.write(marker(c), "1\n");
                state = null;
                BridgeService.restartServer(c);
            } catch (Exception e) {
                state = "failed: " + e.getMessage();
            }
        }, "yakk-desktop-install").start();
    }

    /** The command that runs the desktop: the VNC server, then the XFCE session on it. */
    static String script() {
        // The screen (Xvnc) runs in front and keeps the computer up; the desktop session runs beside
        // it and is started again if it ever exits, so a crash in a panel never takes the screen down.
        return "rm -f /tmp/.X1-lock /tmp/.X11-unix/X1; mkdir -p /tmp/.X11-unix /tmp/runtime-root /var/lib/dbus; chmod 1777 /tmp/.X11-unix; chmod 700 /tmp/runtime-root; "
                // D-Bus refuses to start without a machine id, and the app's Linux has none.
                + "[ -s /etc/machine-id ] || dbus-uuidgen > /etc/machine-id; [ -e /var/lib/dbus/machine-id ] || ln -sf /etc/machine-id /var/lib/dbus/machine-id; "
                + "export HOME=/root USER=root XDG_RUNTIME_DIR=/tmp/runtime-root DISPLAY=" + DISPLAY + " NO_AT_BRIDGE=1; "
                + "( for i in $(seq 1 30); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 1; done; "
                + "while true; do echo \"[desktop] starting the session\"; dbus-launch --exit-with-session sh -c 'xfwm4 --replace & xfdesktop & while true; do browser --start-maximized --user-data-dir=/root/.config/yakkbot-browser --remote-debugging-port=9222 $(cat /root/.yakkbot/desk.url 2>/dev/null); sleep 2; done'; echo \"[desktop] session ended, starting it again\"; sleep 3; done ) & "
                + "exec Xvnc " + DISPLAY + " -geometry 1280x800 -depth 24 -rfbport " + VNC_PORT + " -localhost -SecurityTypes VncAuth -PasswordFile /root/.vnc/passwd -AlwaysShared -nolisten tcp -BlacklistThreshold=1000000";
    }

    /** Whether the computer's screen answers right now. */
    static boolean running() {
        try (java.net.Socket s = new java.net.Socket()) { s.connect(new java.net.InetSocketAddress("127.0.0.1", VNC_PORT), 400); return true; }
        catch (Exception e) { return false; }
    }

    static String logTail(Context c) {
        try { return Linux.tail(new String(java.nio.file.Files.readAllBytes(new File(new Linux(c).base, "desktop.log").toPath()), java.nio.charset.StandardCharsets.UTF_8), 1500); }
        catch (Exception e) { return ""; }
    }

    static void addServerEnv(Context c, Map<String, String> env) throws java.io.IOException {
        // Always passed: the server switches the computer on by itself once Xvnc is installed, no restart needed.
        env.put("YAKK_DESKTOP_BIN", "/usr/bin/Xvnc");
        env.put("YAKK_COMPUTER", "local");
        env.put("VNC_HOST", "127.0.0.1");
        env.put("VNC_PORT", String.valueOf(VNC_PORT));
        env.put("VNC_PASSWORD", new Linux(c).secret("vnc.secret").substring(0, 8));
        env.put("YAKK_DISPLAY", DISPLAY);
    }
}
