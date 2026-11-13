package ai.yakkbot.app;

import android.app.ActivityManager;
import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * AI models that run on the phone itself, offline: GGUF files from Hugging Face, run by llama.cpp's
 * OpenAI-compatible server (shipped as libllamaserver.so) on 127.0.0.1. The YakkBot server talks
 * to it like any other provider ("On this phone"). Ported from D-Agent's LocalModels.
 */
final class LocalModels {
    static final int PORT = 8081;

    /** id, name, maker, repo, file, bytes, minimum RAM (GB), tag, note. Sizes checked 2026-11-02 (from D-Agent). */
    static final Object[][] CATALOG = {
        {"lfm25-1.2b", "LFM2.5 1.2B Instruct", "Liquid AI", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF", "LFM2.5-1.2B-Instruct-Q4_K_M.gguf", 730_895_168L, 3, "Fastest", "Built for phones: replies very fast on the CPU and handles simple tools."},
        {"qwen35-0.8b", "Qwen3.5 0.8B", "Qwen", "bartowski/Qwen_Qwen3.5-0.8B-GGUF", "Qwen_Qwen3.5-0.8B-Q4_K_M.gguf", 579_615_840L, 3, "Tiny", "The smallest of the 2026 Qwen family. Runs on any phone."},
        {"qwen35-2b", "Qwen3.5 2B", "Qwen", "bartowski/Qwen_Qwen3.5-2B-GGUF", "Qwen_Qwen3.5-2B-Q4_K_M.gguf", 1_396_198_496L, 4, "Best balance", "The best pick for most phones: reliable with tools, web search and phone controls."},
        {"lfm25-2.6b", "LFM2.5 2.6B", "Liquid AI", "LiquidAI/LFM2.5-2.6B-GGUF", "LFM2.5-2.6B-Q4_K_M.gguf", 1_674_455_040L, 4, "Quick agent", "Fast like the 1.2B but noticeably smarter."},
        {"gemma4-e2b", "Gemma 4 E2B", "Google", "bartowski/google_gemma-4-E2B-it-GGUF", "google_gemma-4-E2B-it-Q4_K_M.gguf", 3_462_680_032L, 6, "Natural writer", "Google's 2026 phone model with built-in tool calling."},
        {"qwen35-4b", "Qwen3.5 4B", "Qwen", "bartowski/Qwen_Qwen3.5-4B-GGUF", "Qwen_Qwen3.5-4B-Q4_K_M.gguf", 3_013_027_808L, 8, "Smartest for 8 GB", "Much stronger research and planning. Best with 8 GB of RAM or more."},
        {"nemotron-bolt-e4b", "Nemotron 3.5 Bolt E4B", "NVIDIA", "unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF", "NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf", 5_060_482_240L, 8, "Best tool user", "Tuned for fast, multi-step tool use. Needs 8 GB of RAM or more."},
        {"gemma4-e4b", "Gemma 4 E4B", "Google", "bartowski/google_gemma-4-E4B-it-GGUF", "google_gemma-4-E4B-it-Q4_K_M.gguf", 5_405_170_144L, 8, "Best writing", "The most natural chat and writing of these."},
        {"qwen35-9b", "Qwen3.5 9B", "Qwen", "bartowski/Qwen_Qwen3.5-9B-GGUF", "Qwen_Qwen3.5-9B-Q4_K_M.gguf", 6_169_341_984L, 12, "Flagship only", "Closest to a cloud model. Needs 12 GB of RAM and patience."},
    };
    private static final String TITLE = "YakkBot model: ";

    private final Context ctx;
    final File dir;
    private final File server, log;
    private static Process process;
    private static String runningFile = "";
    private static String state = "stopped", error = null;

    LocalModels(Context c) {
        ctx = c.getApplicationContext();
        File ext = ctx.getExternalFilesDir("models");
        dir = ext != null ? ext : new File(ctx.getFilesDir(), "models");
        dir.mkdirs();
        server = new File(ctx.getApplicationInfo().nativeLibraryDir, "libllamaserver.so");
        log = new File(ctx.getCacheDir(), "llama-server.log");
    }

    boolean engineBundled() { return server.isFile(); }

    double ramGb() {
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        ctx.getSystemService(ActivityManager.class).getMemoryInfo(mi);
        return mi.totalMem / 1e9;
    }

    String recommended() {
        double gb = ramGb();
        return gb >= 7.5 ? "qwen35-4b" : gb >= 3.6 ? "qwen35-2b" : "lfm25-1.2b";
    }

    // ---------- what is here ----------

    JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        o.put("engine", engineBundled());
        o.put("ramGb", Math.round(ramGb() * 10) / 10.0);
        o.put("recommended", recommended());
        o.put("state", process != null && process.isAlive() ? state : "running".equals(state) ? "stopped" : state);
        o.put("running", process != null && process.isAlive() ? runningFile : "");
        if (error != null) o.put("error", error);
        JSONArray cat = new JSONArray();
        for (Object[] m : CATALOG) {
            cat.put(new JSONObject().put("id", m[0]).put("name", m[1]).put("maker", m[2]).put("repo", m[3]).put("file", m[4])
                    .put("bytes", m[5]).put("minRamGb", m[6]).put("tag", m[7]).put("note", m[8]).put("fits", ramGb() >= ((int) m[6]) - 0.5));
        }
        o.put("catalog", cat);
        JSONArray inst = new JSONArray();
        File[] files = dir.listFiles((d, n) -> n.endsWith(".gguf"));
        if (files != null) for (File f : files) inst.put(new JSONObject().put("file", f.getName()).put("bytes", f.length()));
        o.put("installed", inst);
        o.put("downloads", downloads());
        return o;
    }

    // ---------- downloads (Android's download manager: keeps going with the app closed) ----------

    void download(String url, String fileName, String label) throws IOException {
        if (!fileName.endsWith(".gguf") || fileName.contains("/") || fileName.contains("..")) throw new IOException("Not a .gguf file name.");
        if (!url.startsWith("https://huggingface.co/")) throw new IOException("Models download from huggingface.co only.");
        if (new File(dir, fileName).isFile()) throw new IllegalStateException(fileName + " is already downloaded.");
        DownloadManager dm = ctx.getSystemService(DownloadManager.class);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                .setTitle(TITLE + label)
                .setDescription("On-phone AI model")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(ctx, "models", fileName + ".part")
                .setAllowedOverMetered(true);
        dm.enqueue(r);
    }

    /** Progress of model downloads; finished ones are renamed into place. */
    JSONArray downloads() throws Exception {
        JSONArray out = new JSONArray();
        DownloadManager dm = ctx.getSystemService(DownloadManager.class);
        try (Cursor c = dm.query(new DownloadManager.Query())) {
            while (c != null && c.moveToNext()) {
                String title = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
                if (title == null || !title.startsWith(TITLE)) continue;
                String local = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                if (local == null) continue;
                String name = Uri.parse(local).getLastPathSegment();
                if (name == null) continue;
                if (name.endsWith(".part")) name = name.substring(0, name.length() - 5);
                int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                long id = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    File part = new File(dir, name + ".part");
                    if (part.isFile()) part.renameTo(new File(dir, name));
                    dm.remove(id);
                    continue;
                }
                out.put(new JSONObject().put("file", name).put("done", done).put("total", total).put("failed", status == DownloadManager.STATUS_FAILED).put("id", id));
            }
        }
        return out;
    }

    void cancel(String fileName) throws Exception {
        JSONArray d = downloads();
        DownloadManager dm = ctx.getSystemService(DownloadManager.class);
        for (int i = 0; i < d.length(); i++) if (d.getJSONObject(i).getString("file").equals(fileName)) dm.remove(d.getJSONObject(i).getLong("id"));
        new File(dir, fileName + ".part").delete();
    }

    void delete(String fileName) {
        File f = new File(dir, fileName);
        if (!f.getParentFile().equals(dir) || !fileName.endsWith(".gguf")) throw new IllegalStateException("Not a model file.");
        if (fileName.equals(runningFile)) stop();
        f.delete();
    }

    // ---------- Hugging Face ----------

    JSONArray search(String query) throws Exception {
        String q = URLEncoder.encode(query.trim(), "UTF-8");
        JSONArray raw = new JSONArray(get("https://huggingface.co/api/models?search=" + q + "&filter=gguf&sort=downloads&direction=-1&limit=25"));
        JSONArray out = new JSONArray();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject m = raw.getJSONObject(i);
            out.put(new JSONObject().put("repo", m.optString("id", m.optString("modelId"))).put("downloads", m.optLong("downloads")).put("likes", m.optLong("likes")));
        }
        return out;
    }

    JSONArray files(String repoOrUrl) throws Exception {
        String repo = repoOrUrl.trim().replaceFirst("^https?://", "").replaceFirst("^huggingface\\.co/", "");
        String[] parts = repo.split("/");
        if (parts.length < 2) throw new IllegalStateException("Use owner/name, like bartowski/Qwen_Qwen3.5-2B-GGUF");
        repo = parts[0] + "/" + parts[1];
        JSONArray raw = new JSONArray(get("https://huggingface.co/api/models/" + repo + "/tree/main?recursive=true"));
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject f = raw.getJSONObject(i);
            String path = f.optString("path");
            if (!path.toLowerCase().endsWith(".gguf") || path.toLowerCase().contains("mmproj")) continue;
            long size = f.has("lfs") ? f.getJSONObject("lfs").optLong("size", f.optLong("size")) : f.optLong("size");
            list.add(new JSONObject().put("repo", repo).put("path", path).put("file", path.substring(path.lastIndexOf('/') + 1)).put("bytes", size)
                    .put("url", "https://huggingface.co/" + repo + "/resolve/main/" + path));
        }
        list.sort((a, b) -> Long.compare(a.optLong("bytes"), b.optLong("bytes")));
        return new JSONArray(list);
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "YakkBot");
        try {
            if (c.getResponseCode() != 200) throw new IOException("Hugging Face answered HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
        } finally { c.disconnect(); }
    }

    // ---------- running a model ----------

    /** Starts llama-server with this model unless it already runs it, and waits until it answers. */
    synchronized void use(String fileName, int contextSize) throws Exception {
        if (!engineBundled()) throw new IllegalStateException("This build has no on-phone model engine.");
        File f = new File(dir, fileName);
        if (!f.isFile()) throw new IllegalStateException("The model " + fileName + " is not downloaded. Download it in Settings > On-phone models.");
        if (process != null && process.isAlive() && fileName.equals(runningFile) && healthy()) return;
        stop();
        state = "starting";
        error = null;
        int cores = Runtime.getRuntime().availableProcessors();
        int threads = Math.max(2, Math.min(6, cores - 2));
        List<String> cmd = new ArrayList<>(List.of(server.getAbsolutePath(), "-m", f.getAbsolutePath(), "--host", "127.0.0.1", "--port", String.valueOf(PORT),
                "-c", String.valueOf(contextSize), "-t", String.valueOf(threads), "--jinja", "--no-webui", "-np", "1", "-a", fileName));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log);
        pb.environment().put("LD_LIBRARY_PATH", ctx.getApplicationInfo().nativeLibraryDir);
        process = pb.start();
        runningFile = fileName;
        long deadline = System.currentTimeMillis() + 180_000;
        boolean retried = false;
        while (System.currentTimeMillis() < deadline) {
            if (!process.isAlive()) {
                String tail = logTail(600);
                if (!retried && tail.contains("no-webui")) {
                    retried = true;
                    cmd.remove("--no-webui");
                    process = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log).start();
                    continue;
                }
                state = "failed";
                error = tail.isEmpty() ? "The model server stopped." : tail;
                throw new IllegalStateException("The on-phone model could not start (often: not enough free memory; try a smaller model). " + Linux.tail(tail, 300));
            }
            if (healthy()) { state = "running"; return; }
            Thread.sleep(700);
        }
        stop();
        state = "failed";
        throw new IllegalStateException("The on-phone model took too long to load. Try a smaller model.");
    }

    synchronized void stop() {
        if (process != null) process.destroy();
        process = null;
        runningFile = "";
        state = "stopped";
    }

    private boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/health").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(2000);
            boolean ok = c.getResponseCode() == 200;
            c.disconnect();
            return ok;
        } catch (Exception e) { return false; }
    }

    String logTail(int n) {
        try (RandomAccessFile f = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, f.length() - n);
            f.seek(start);
            byte[] b = new byte[(int) (f.length() - start)];
            f.readFully(b);
            return new String(b, StandardCharsets.UTF_8);
        } catch (IOException e) { return ""; }
    }
}
