package com.smessage.app;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import com.getcapacitor.BridgeActivity;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;

public class MainActivity extends BridgeActivity {
    private InterstitialAd mInterstitialAd;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Force the Capacitor WebView to be transparent so it doesn't block native views
        WebView webView = getBridge().getWebView();
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT);

        MobileAds.initialize(this, status -> {
            loadInterstitial();
            runOnUiThread(() -> {
                // 2. CREATE the AdView manually (since XML is being ignored)
                com.google.android.gms.ads.AdView mAdView = new com.google.android.gms.ads.AdView(this);
                mAdView.setAdSize(com.google.android.gms.ads.AdSize.BANNER);
                mAdView.setAdUnitId("ca-app-pub-7380008351931153/8707210357"); // Test ID

                // 3. Define the layout (Top of the screen)
                android.widget.FrameLayout.LayoutParams params = new android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                        android.view.Gravity.TOP
                );

                // 4. Inject it into the very root of the Android content view
                android.view.ViewGroup rootView = (android.view.ViewGroup) getWindow().getDecorView().findViewById(android.R.id.content);
                rootView.addView(mAdView, params);

                // 5. Load and force to the front layer
                AdRequest adRequest = new AdRequest.Builder().build();
                mAdView.loadAd(adRequest);
                mAdView.bringToFront();

                android.util.Log.d("AdMob", "AdView manually injected to TOP");
            });
        });

        webView.addJavascriptInterface(new AdInterface(), "Android");
    }

    private void loadInterstitial() {
        AdRequest adRequest = new AdRequest.Builder().build();
        // GOOGLE TEST INTERSTITIAL ID
        InterstitialAd.load(this, "ca-app-pub-7380008351931153/2125245318",
                adRequest, new InterstitialAdLoadCallback() {
                    @Override
                    public void onAdLoaded(@NonNull InterstitialAd interstitialAd) {
                        mInterstitialAd = interstitialAd;
                        mInterstitialAd.setFullScreenContentCallback(new FullScreenContentCallback() {
                            @Override
                            public void onAdDismissedFullScreenContent() {
                                mInterstitialAd = null;
                                loadInterstitial();
                            }
                        });
                    }
                    @Override
                    public void onAdFailedToLoad(@NonNull LoadAdError loadAdError) {
                        mInterstitialAd = null;
                    }
                });
    }

    public class AdInterface {
        @JavascriptInterface
        public void showAd() {
            runOnUiThread(() -> {
                if (mInterstitialAd != null) {
                    mInterstitialAd.show(MainActivity.this);
                } else {
                    loadInterstitial();
                }
            });
        }

        @JavascriptInterface
        public void setBannerVisible(boolean show) {
            runOnUiThread(() -> {
                com.google.android.gms.ads.AdView mAdView = findViewById(R.id.adView);
                if (mAdView != null) {
                    mAdView.setVisibility(show ? android.view.View.VISIBLE : android.view.View.GONE);
                    if (show) mAdView.bringToFront();
                }
            });
        }
    }
}