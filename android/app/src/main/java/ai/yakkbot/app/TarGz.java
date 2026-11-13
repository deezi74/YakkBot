package ai.yakkbot.app;

import android.system.Os;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * Unpacks a Linux root filesystem (.tar.gz): files, folders, symlinks, hard links (copied), GNU
 * long names and pax paths. Paths that would escape the destination are refused. A Java port of
 * D-Agent's TarExtractor.
 */
final class TarGz {
    private TarGz() {}

    static int extract(File archive, File dest) throws IOException {
        dest.mkdirs();
        File root = dest.getCanonicalFile();
        int files = 0;
        byte[] header = new byte[512];
        String longName = null, longLink = null, paxPath = null, paxLink = null;
        List<File[]> hardLinks = new ArrayList<>();
        List<Object[]> symlinks = new ArrayList<>();
        try (InputStream in = new GZIPInputStream(new BufferedInputStream(new FileInputStream(archive), 65536), 65536)) {
            while (readFully(in, header)) {
                if (allZero(header)) break;
                long size = octal(header, 124, 12);
                char type = (char) header[156];
                String prefix = str(header, 345, 155);
                String raw = str(header, 0, 100);
                String name = paxPath != null ? paxPath : longName != null ? longName
                        : (!prefix.isEmpty() && str(header, 257, 6).startsWith("ustar")) ? prefix + "/" + raw : raw;
                String link = paxLink != null ? paxLink : longLink != null ? longLink : str(header, 157, 100);
                int mode = (int) octal(header, 100, 8);
                if (type == 'L') { longName = readString(in, size); continue; }
                if (type == 'K') { longLink = readString(in, size); continue; }
                if (type == 'x') {
                    Map<String, String> pax = parsePax(readString(in, size));
                    paxPath = pax.get("path");
                    paxLink = pax.get("linkpath");
                    continue;
                }
                if (type == 'g') { skip(in, size); continue; }
                longName = null; longLink = null; paxPath = null; paxLink = null;

                String clean = name;
                while (clean.startsWith("/")) clean = clean.substring(1);
                if (clean.startsWith("./")) clean = clean.substring(2);
                if (clean.isEmpty() || clean.equals(".")) { skip(in, size); continue; }
                File out = new File(root, clean);
                if (!out.toPath().normalize().startsWith(root.toPath())) throw new IOException("unsafe path in archive: " + name);

                if (type == '5') {
                    out.mkdirs();
                    chmod(out, mode);
                    skip(in, size);
                } else if (type == '2') {
                    symlinks.add(new Object[]{link, out});
                    skip(in, size);
                } else if (type == '1') {
                    String src = link;
                    while (src.startsWith("/")) src = src.substring(1);
                    if (src.startsWith("./")) src = src.substring(2);
                    hardLinks.add(new File[]{new File(root, src), out});
                    skip(in, size);
                } else if (type == '0' || type == 0 || type == '7') {
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    if (Files.isSymbolicLink(out.toPath())) out.delete();
                    try (OutputStream o = new FileOutputStream(out)) { copy(in, o, size); }
                    skipPadding(in, size);
                    chmod(out, mode);
                    files++;
                } else {
                    skip(in, size); // devices and fifos are not needed under proot
                }
            }
        }
        for (File[] h : hardLinks) {
            if (!h[0].isFile()) continue;
            File parent = h[1].getParentFile();
            if (parent != null) parent.mkdirs();
            try (InputStream i = new FileInputStream(h[0]); OutputStream o = new FileOutputStream(h[1])) { copy(i, o, h[0].length()); }
            if (h[0].canExecute()) h[1].setExecutable(true, false);
            files++;
        }
        // Symlinks last, so no file is ever written through one (an absolute link would point outside dest).
        for (Object[] s : symlinks) {
            File l = (File) s[1];
            if (l.isDirectory() && !Files.isSymbolicLink(l.toPath())) continue;
            File parent = l.getParentFile();
            if (parent != null) parent.mkdirs();
            if (l.exists() || Files.isSymbolicLink(l.toPath())) l.delete();
            try { Os.symlink((String) s[0], l.getAbsolutePath()); } catch (Exception e) { throw new IOException("symlink " + l + ": " + e.getMessage()); }
        }
        return files;
    }

    private static void chmod(File f, int mode) {
        try { Os.chmod(f.getAbsolutePath(), mode & 0777); } catch (Exception ignored) {}
    }

    private static Map<String, String> parsePax(String text) {
        Map<String, String> map = new HashMap<>();
        String rest = text;
        while (!rest.isEmpty()) {
            int space = rest.indexOf(' ');
            if (space <= 0) break;
            int len;
            try { len = Integer.parseInt(rest.substring(0, space)); } catch (NumberFormatException e) { break; }
            if (len > rest.length() || len <= space) break;
            String record = rest.substring(space + 1, len);
            if (record.endsWith("\n")) record = record.substring(0, record.length() - 1);
            int eq = record.indexOf('=');
            if (eq > 0) map.put(record.substring(0, eq), record.substring(eq + 1));
            rest = rest.substring(len);
        }
        return map;
    }

    private static String readString(InputStream in, long size) throws IOException {
        byte[] b = new byte[(int) size];
        if (!readFully(in, b)) throw new IOException("truncated archive");
        skipPadding(in, size);
        int end = b.length;
        while (end > 0 && b[end - 1] == 0) end--;
        return new String(b, 0, end, StandardCharsets.UTF_8);
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[65536];
        long left = size;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("truncated archive");
            if (out != null) out.write(buf, 0, n);
            left -= n;
        }
    }

    private static void skip(InputStream in, long size) throws IOException { copy(in, null, size); skipPadding(in, size); }

    private static void skipPadding(InputStream in, long size) throws IOException {
        long pad = (512 - size % 512) % 512;
        if (pad > 0) copy(in, null, pad);
    }

    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) { if (off == 0) return false; throw new IOException("truncated archive"); }
            off += n;
        }
        return true;
    }

    private static boolean allZero(byte[] b) { for (byte x : b) if (x != 0) return false; return true; }

    private static String str(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long octal(byte[] b, int off, int len) {
        if ((b[off] & 0x80) != 0) {
            long v = 0;
            for (int i = off + 1; i < off + len; i++) v = (v << 8) | (b[i] & 0xff);
            return v;
        }
        String s = str(b, off, len).trim();
        return s.isEmpty() ? 0 : Long.parseLong(s, 8);
    }
}
