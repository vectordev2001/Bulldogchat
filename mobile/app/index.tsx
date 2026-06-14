/**
 * Bulldogchat mobile shell
 *
 * A thin Expo wrapper around the production web app at
 *   https://vector-chat-zzlq.onrender.com
 *
 * Responsibilities:
 *  - Mount a full-screen WebView on the live deployment (override with
 *    EXPO_PUBLIC_APP_URL at build time for staging).
 *  - Register the device for Expo push notifications and POST the token to
 *    `/api/push/expo-subscribe` so the server can route @mentions, DM pings,
 *    and channel alerts to the device.
 *  - Forward notification taps back into the WebView via injected JS so the
 *    page can deep-link the user to the right channel / message.
 *  - Honor safe-area insets and dark backgrounds while the bundle loads so the
 *    app feels native on iOS and Android.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ?? "https://vector-chat-zzlq.onrender.com";

/**
 * Pull the web meeting URL out of a `bulldogchat://join?url=<webUrl>` deep
 * link. The link is sent in scheduled-call SMS bodies so iOS users with the
 * app land directly in the room (real WebView, camera/mic allowed) instead
 * of the in-app browser that blocks media. Returns null for any other URL.
 */
function joinUrlFromDeepLink(deepLink: string | null): string | null {
  if (!deepLink) return null;
  try {
    const parsed = Linking.parse(deepLink);
    if (parsed.hostname !== "join") return null;
    const url = parsed.queryParams?.url;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Request notification permissions and grab the Expo push token. Returns null
 * on simulators or when the user denies the prompt; the WebView shell still
 * works without push, mentions just won't ping the device.
 */
async function registerForPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== "granted") {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== "granted") return null;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Bulldogchat",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c53030",
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      // @ts-expect-error legacy field
      Constants.easConfig?.projectId;

    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return tokenResponse.data;
  } catch (err) {
    console.warn("[push] registration failed", err);
    return null;
  }
}

/**
 * Inject the captured Expo push token into the WebView and ask the page to
 * POST it to `/api/push/expo-subscribe`. The page handles the auth headers; we
 * just hand it the token plus platform metadata.
 */
function buildSubscribeScript(token: string): string {
  const payload = JSON.stringify({
    token,
    platform: Platform.OS,
    deviceName: Device.deviceName ?? null,
    osVersion: Device.osVersion ?? null,
  });
  return `
    (function () {
      try {
        window.__BULLDOGCHAT_PUSH__ = ${payload};
        var doSubscribe = function () {
          try {
            var jwt =
              localStorage.getItem('vc_token') ||
              localStorage.getItem('token') ||
              null;
            if (!jwt) return;
            fetch('/api/push/expo-subscribe', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + jwt,
              },
              body: JSON.stringify(${payload}),
            }).catch(function () {});
          } catch (e) {}
        };
        doSubscribe();
        window.addEventListener('vc:loggedin', doSubscribe);
      } catch (err) {
        window.ReactNativeWebView &&
          window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'push-subscribe-error', message: String(err) })
          );
      }
      true;
    })();
  `;
}

export default function MobileShell() {
  const webRef = useRef<WebView>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [webReady, setWebReady] = useState(false);
  const [sourceUri, setSourceUri] = useState(APP_URL);

  // Handle `bulldogchat://join?url=...` deep links. On a cold launch we read
  // the initial URL; while running we listen for warm-launch links. In both
  // cases we point the WebView straight at the meeting URL so the user joins
  // in the native WebView (which Apple grants camera/mic) rather than the
  // in-app browser that blocks them.
  useEffect(() => {
    let cancelled = false;

    Linking.getInitialURL().then((initial) => {
      if (cancelled) return;
      const joinUrl = joinUrlFromDeepLink(initial);
      if (joinUrl) setSourceUri(joinUrl);
    });

    const sub = Linking.addEventListener("url", ({ url }) => {
      const joinUrl = joinUrlFromDeepLink(url);
      if (!joinUrl) return;
      setSourceUri(joinUrl);
      webRef.current?.injectJavaScript(`
        try { window.location.href = ${JSON.stringify(joinUrl)}; } catch (e) {}
        true;
      `);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Register for push once on mount.
  useEffect(() => {
    let cancelled = false;
    registerForPushToken().then((token) => {
      if (!cancelled) setPushToken(token);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // When a notification is tapped, forward any `data.url` payload into the
  // WebView so the page can route to the right channel/message.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as
          | { url?: string; channelId?: number; messageId?: number }
          | undefined;
        if (!data || !webRef.current) return;
        const target =
          typeof data.url === "string"
            ? data.url
            : data.channelId
            ? `/#/channel/${data.channelId}${
                data.messageId ? `?msg=${data.messageId}` : ""
              }`
            : null;
        if (!target) return;
        webRef.current.injectJavaScript(`
          try {
            if (window.location.hash !== ${JSON.stringify(target)}) {
              window.location.href = ${JSON.stringify(target)};
            }
            window.dispatchEvent(new CustomEvent('vc:notification-tap', {
              detail: ${JSON.stringify(data)}
            }));
          } catch (e) {}
          true;
        `);
      },
    );
    return () => sub.remove();
  }, []);

  // After the page tells us the user has logged in (or the page first loads
  // with a token already), push the subscribe script.
  useEffect(() => {
    if (!webReady || !pushToken || !webRef.current) return;
    webRef.current.injectJavaScript(buildSubscribeScript(pushToken));
  }, [webReady, pushToken]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const parsed = JSON.parse(event.nativeEvent.data);
      if (parsed?.type === "vc:loggedin" && pushToken && webRef.current) {
        webRef.current.injectJavaScript(buildSubscribeScript(pushToken));
      }
    } catch {
      // ignore non-JSON messages
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <WebView
        ref={webRef}
        source={{ uri: sourceUri }}
        style={styles.web}
        allowsBackForwardNavigationGestures
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={["*"]}
        decelerationRate="normal"
        setSupportMultipleWindows={false}
        onLoadEnd={() => setWebReady(true)}
        onMessage={handleMessage}
        injectedJavaScriptBeforeContentLoaded={`
          window.__BULLDOGCHAT_MOBILE__ = true;
          window.__BULLDOGCHAT_PLATFORM__ = ${JSON.stringify(Platform.OS)};
          true;
        `}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color="#c53030" />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a1828",
  },
  web: {
    flex: 1,
    backgroundColor: "#0a1828",
  },
  loading: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a1828",
  },
});
