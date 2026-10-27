package com.aegent.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

/**
 * Aegent's main activity.
 *
 * We extend Capacitor's BridgeActivity so all the Capacitor plugin
 * plumbing keeps working, and then we install a WebChromeClient that
 * relays the WebView's runtime permission requests (mic, camera) up
 * to Android's normal permission system.
 *
 * Without this hook, `navigator.mediaDevices.getUserMedia()` and
 * `SpeechRecognition.start()` silently fail inside the WebView —
 * the OS-level RECORD_AUDIO / CAMERA permissions might already be
 * granted, but the WebView layer still has to consent, and the
 * default Capacitor client does not.
 */
public class MainActivity extends BridgeActivity {

    // Any Android request-code that doesn't collide with Capacitor's
    // plugin ones (Capacitor uses 12345+ for its own).
    private static final int WEBVIEW_PERM_REQ = 4711;
    private PermissionRequest pendingRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Stop the WebView from algorithmically inverting our colours
        // when the system is in dark mode. The web app themes itself
        // via CSS (data-theme + color-scheme), so a native force-dark
        // pass would fight it — the symptom was "picking Light does
        // nothing when the phone is dark." With this off, our CSS wins.
        WebSettings settings = getBridge().getWebView().getSettings();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }

        getBridge().getWebView().setWebChromeClient(new com.getcapacitor.BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handlePermissionRequest(request));
            }
        });
    }

    private void handlePermissionRequest(PermissionRequest request) {
        String[] resources = request.getResources();
        boolean wantsAudio = false, wantsVideo = false;
        for (String r : resources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
            else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsVideo = true;
        }

        // If the OS-level permissions are already granted, just consent
        // to the WebView request immediately.
        boolean audioOk = !wantsAudio
            || ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
               == PackageManager.PERMISSION_GRANTED;
        boolean videoOk = !wantsVideo
            || ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
               == PackageManager.PERMISSION_GRANTED;

        if (audioOk && videoOk) {
            request.grant(resources);
            return;
        }

        // Otherwise ask Android for the missing ones, and grant the
        // WebView request in onRequestPermissionsResult.
        pendingRequest = request;
        String[] toAsk = wantsAudio && wantsVideo
            ? new String[] { Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA }
            : (wantsAudio
                ? new String[] { Manifest.permission.RECORD_AUDIO }
                : new String[] { Manifest.permission.CAMERA });
        ActivityCompat.requestPermissions(this, toAsk, WEBVIEW_PERM_REQ);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != WEBVIEW_PERM_REQ || pendingRequest == null) return;

        boolean allGranted = true;
        for (int r : grantResults) {
            if (r != PackageManager.PERMISSION_GRANTED) { allGranted = false; break; }
        }
        if (allGranted) {
            pendingRequest.grant(pendingRequest.getResources());
        } else {
            pendingRequest.deny();
        }
        pendingRequest = null;
    }
}
