package ai.yakkbot.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.system.Os;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * YakkBot's own Linux computer, the way D-Agent does it: an Alpine Linux root filesystem in the
 * app's private storage, run through PRoot (shipped as libproot.so). The YakkBot server runs in it
 * with Alpine's Node.js, and the bots' shell commands run in it too. No root and no Termux.
 */
final class Linux {
    private static final String ALPINE = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64";
    static final String PACKAGES = "nodejs bash curl wget git python3 py3-pip nano jq file unzip zip tzdata ca-certificates openssl";

    interface Progress { void step(String text); }

    private final Context ctx;
    final File base, rootfs, tmp, log;
    private final File marker, nativeDir, proot;
    private static volatile boolean noSeccomp = false;

    Linux(Context c) {
        ctx = c.getApplicationContext();
        base = new File(ctx.getFilesDir(), "linux");
        rootfs = new File(base, "rootfs");
        tmp = new File(base, "tmp");
        log = new File(base, "server.log");
        marker = new File(base, ".installed");
        nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
        proot = new File(nativeDir, "libproot.so");
    }

    boolean engineBundled() { return proot.isFile(); }
    boolean installed() { return marker.isFile() && rootfs.isDirectory(); }

    // ---------- install ----------

    /** Downloads Alpine Linux (a few MB), unpacks it, and installs Node.js and the bots' tools. */
    void install(Progress p) throws Exception {
        if (!engineBundled()) throw new IOException("This build has no Linux engine for this phone. YakkBot needs a 64-bit ARM phone.");
        p.step("Finding the latest Alpine Linux");
        String index = new String(get(ALPINE + "/latest-releases.yaml"), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("file:\\s*(alpine-minirootfs-[0-9.]+-aarch64\\.tar\\.gz)").matcher(index);
        if (!m.find()) throw new IOException("Couldn't find the Alpine Linux download.");
        String file = m.group(1);
        p.step("Downloading " + file);
        File archive = new File(ctx.getCacheDir(), file);
        download(ALPINE + "/" + file, archive);
        p.step("Unpacking Linux");
        if (base.exists()) deleteTree(base);
        rootfs.mkdirs();
        int files = TarGz.extract(archive, rootfs);
        archive.delete();
        tmp.mkdirs();
        configure();
        write(marker, files + " files\n");
        p.step("Installing Node.js and tools (a few minutes, about 150 MB)");
        Result r = run("apk update && apk add --no-progress " + PACKAGES, 1500, null);
        if (r.code != 0) {
            marker.delete();
            throw new IOException("Installing packages failed:\n" + tail(r.output, 1200));
        }
        p.step("Linux is ready");
    }

    /** Files that tie Linux to the app; safe to write on every start. */
    void configure() throws IOException {
        if (!rootfs.isDirectory()) return;
        File resolv = new File(rootfs, "etc/resolv.conf");
        resolv.delete();
        write(resolv, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        write(new File(rootfs, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n");
        new File(rootfs, "root").mkdirs();
        new File(rootfs, "opt/yakkbot").mkdirs();
        write(new File(rootfs, "etc/profile.d/yakkbot.sh"), "export PS1='yakkbot:\\w# '\nexport LANG=C.UTF-8\nexport PIP_BREAK_SYSTEM_PACKAGES=1\nexport PYTHONDONTWRITEBYTECODE=1\n");
    }

    void uninstall() { deleteTree(base); }

    // ---------- the server's files ----------

    /** Copies the bundled server and web app out of the APK when this version has not done so yet. */
    void installApp(int versionCode) throws IOException {
        File dir = new File(rootfs, "opt/yakkbot");
        File stamp = new File(dir, ".version");
        String want = String.valueOf(versionCode);
        if (stamp.isFile() && want.equals(read(stamp).trim()) && new File(dir, "server.mjs").isFile()) return;
        deleteTree(new File(dir, "web"));
        copyAssets(ctx.getAssets(), "yakkbot", dir);
        write(stamp, want + "\n");
    }

    boolean appBundled() {
        try { InputStream i = ctx.getAssets().open("yakkbot/server.mjs"); i.close(); return true; } catch (IOException e) { return false; }
    }

    // ---------- running things ----------

    static final class Result {
        final int code; final String output;
        Result(int code, String output) { this.code = code; this.output = output; }
    }

    ProcessBuilder command(String script, Map<String, String> extraEnv) {
        ProcessBuilder pb = new ProcessBuilder(
                proot.getAbsolutePath(), "--kill-on-exit", "--link2symlink", "-0",
                "-r", rootfs.getAbsolutePath(),
                "-b", "/dev", "-b", "/proc", "-b", "/sys",
                "-b", tmp.getAbsolutePath() + ":/tmp",
                "-w", "/root",
                "/bin/sh", "-c", ". /etc/profile >/dev/null 2>&1; " + script);
        Map<String, String> env = pb.environment();
        env.clear();
        File loader = new File(nativeDir, "libproot-loader.so");
        if (loader.isFile()) env.put("PROOT_LOADER", loader.getAbsolutePath());
        File loader32 = new File(nativeDir, "libproot-loader32.so");
        if (loader32.isFile()) env.put("PROOT_LOADER_32", loader32.getAbsolutePath());
        env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        env.put("LD_LIBRARY_PATH", nativeDir.getAbsolutePath());
        if (noSeccomp) env.put("PROOT_NO_SECCOMP", "1");
        env.put("HOME", "/root");
        env.put("USER", "root");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("TZ", TimeZone.getDefault().getID());
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        if (extraEnv != null) env.putAll(extraEnv);
        tmp.mkdirs();
        return pb.redirectErrorStream(true);
    }

    /** Runs a command to the end. On kernels that reject PRoot's seccomp filter, retries without it. */
    Result run(String script, int timeoutSec, Map<String, String> env) throws Exception {
        Result r = runOnce(script, timeoutSec, env);
        if (!noSeccomp && r.code != 0 && (r.output.contains("Function not implemented") || r.output.contains("Bad system call") || r.output.contains("seccomp"))) {
            noSeccomp = true;
            r = runOnce(script, timeoutSec, env);
        }
        return r;
    }

    private Result runOnce(String script, int timeoutSec, Map<String, String> env) throws Exception {
        Process p = command(script, env).start();
        StringBuilder out = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (InputStream in = p.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    synchronized (out) {
                        out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                        if (out.length() > 200_000) out.delete(0, out.length() - 100_000);
                    }
                }
            } catch (IOException ignored) {}
        });
        reader.start();
        boolean done = p.waitFor(timeoutSec, java.util.concurrent.TimeUnit.SECONDS);
        if (!done) p.destroyForcibly();
        reader.join(2000);
        synchronized (out) { return new Result(done ? p.exitValue() : -1, out.toString()); }
    }

    /** Starts the YakkBot server; its output goes to server.log. */
    Process startServer(Map<String, String> env) throws IOException {
        if (log.length() > 2_000_000) log.renameTo(new File(base, "server.log.1"));
        ProcessBuilder pb = command("cd /opt/yakkbot && exec node --disable-warning=ExperimentalWarning server.mjs", env);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return pb.start();
    }

    String logTail(int chars) {
        if (!log.isFile()) return "";
        try (RandomAccessFile f = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, f.length() - chars);
            f.seek(start);
            byte[] b = new byte[(int) (f.length() - start)];
            f.readFully(b);
            return new String(b, StandardCharsets.UTF_8);
        } catch (IOException e) { return ""; }
    }

    /** A random secret kept in the app's private storage (the server's session secret). */
    String secret(String name) throws IOException {
        File f = new File(base, name);
        if (f.isFile()) return read(f).trim();
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        write(f, s + "\n");
        try { Os.chmod(f.getAbsolutePath(), 0600); } catch (Exception ignored) {}
        return s.toString();
    }

    // ---------- small helpers ----------

    private static byte[] get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("Download failed (HTTP " + c.getResponseCode() + ")");
            try (InputStream in = c.getInputStream()) { return in.readAllBytes(); }
        } finally { c.disconnect(); }
    }

    private static void download(String url, File to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("Download failed (HTTP " + c.getResponseCode() + ")");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) { in.transferTo(out); }
        } finally { c.disconnect(); }
    }

    private static void copyAssets(AssetManager am, String path, File dest) throws IOException {
        String[] children = am.list(path);
        if (children == null || children.length == 0) {
            File parent = dest.getParentFile();
            if (parent != null) parent.mkdirs();
            try (InputStream in = am.open(path); OutputStream out = new FileOutputStream(dest)) { in.transferTo(out); }
            return;
        }
        dest.mkdirs();
        for (String c : children) copyAssets(am, path + "/" + c, new File(dest, c));
    }

    static void write(File f, String text) throws IOException {
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        try (OutputStream o = new FileOutputStream(f)) { o.write(text.getBytes(StandardCharsets.UTF_8)); }
    }

    static String read(File f) throws IOException { return new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    static String tail(String s, int n) { return s.length() > n ? s.substring(s.length() - n) : s; }

    static void deleteTree(File f) {
        if (f == null || !f.exists() && !java.nio.file.Files.isSymbolicLink(f.toPath())) return;
        // Never follow a symlink out of the tree.
        if (f.isDirectory() && !java.nio.file.Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }
}
