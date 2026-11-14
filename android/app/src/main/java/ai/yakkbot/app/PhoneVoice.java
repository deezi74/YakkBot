package ai.yakkbot.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * The phone's own voice and ears for talk mode, free and offline where the phone supports it:
 * Android's text-to-speech reads replies, and its speech recognizer turns what you say into text.
 * Results go back to the page as window.__yakkSpoken(), __yakkHeard(text) and __yakkHeardError(msg).
 * Every method must be called on the main thread.
 */
final class PhoneVoice {
    private final Context ctx;
    private final WebView web;
    private TextToSpeech tts;
    private boolean ttsReady;
    private String pendingText;
    private float pendingRate = 1f;
    private SpeechRecognizer rec;

    PhoneVoice(Context ctx, WebView web) { this.ctx = ctx; this.web = web; }

    private void js(String code) { web.post(() -> web.evaluateJavascript(code, null)); }

    void speak(String text, float rate) {
        if (tts == null) {
            pendingText = text; pendingRate = rate;
            tts = new TextToSpeech(ctx, status -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (!ttsReady) { js("window.__yakkSpoken&&window.__yakkSpoken('This phone has no text-to-speech voice. Install one in Android settings.')"); return; }
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { js("window.__yakkSpoken&&window.__yakkSpoken()"); }
                    @Override public void onError(String id) { js("window.__yakkSpoken&&window.__yakkSpoken('The phone could not read that aloud.')"); }
                });
                if (pendingText != null) { say(pendingText, pendingRate); pendingText = null; }
            });
            return;
        }
        if (!ttsReady) { pendingText = text; pendingRate = rate; return; }
        say(text, rate);
    }

    private void say(String text, float rate) {
        tts.setSpeechRate(Math.max(0.5f, Math.min(2f, rate)));
        // Android caps one utterance; long replies are read in pieces, and only the last reports done.
        int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 50);
        ArrayList<String> parts = new ArrayList<>();
        String rest = text;
        while (rest.length() > max) {
            int cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf(' ', max));
            if (cut < max / 2) cut = max;
            parts.add(rest.substring(0, cut + 1));
            rest = rest.substring(cut + 1);
        }
        parts.add(rest);
        for (int i = 0; i < parts.size(); i++) {
            Bundle b = new Bundle();
            String id = i == parts.size() - 1 ? "yakk-last" : "yakk-" + i;
            tts.speak(parts.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, b, id);
        }
    }

    void stopSpeaking() { if (tts != null) tts.stop(); }

    void listen(String lang) {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) { js("window.__yakkHeardError&&window.__yakkHeardError('This phone has no speech recognizer. Pick another one in Settings › Voice.')"); return; }
        if (rec == null) {
            rec = SpeechRecognizer.createSpeechRecognizer(ctx);
            rec.setRecognitionListener(new RecognitionListener() {
                @Override public void onResults(Bundle results) {
                    ArrayList<String> r = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String text = r != null && !r.isEmpty() ? r.get(0) : "";
                    js("window.__yakkHeard&&window.__yakkHeard(" + JSONObject.quote(text) + ")");
                }
                @Override public void onError(int error) {
                    String msg = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "" :
                        error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "Allow the microphone for YakkBot." : "Speech recognition stopped (" + error + ").";
                    js(msg.isEmpty() ? "window.__yakkHeard&&window.__yakkHeard('')" : "window.__yakkHeardError&&window.__yakkHeardError(" + JSONObject.quote(msg) + ")");
                }
                @Override public void onReadyForSpeech(Bundle params) { js("window.__yakkListening&&window.__yakkListening()"); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang == null || lang.isEmpty() || lang.equals("auto") ? Locale.getDefault().toLanguageTag() : lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        rec.startListening(i);
    }

    void stopListening() { if (rec != null) rec.stopListening(); }

    void release() {
        if (tts != null) { tts.shutdown(); tts = null; ttsReady = false; }
        if (rec != null) { rec.destroy(); rec = null; }
    }
}
