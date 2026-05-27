# Bulldogchat Mobile

Native iOS and Android wrapper around the production Bulldogchat web app. The
shell is intentionally thin: a full-screen `react-native-webview` pointed at
the live deployment plus Expo push notification registration so `@mention`,
`@here`, and `@everyone` events from the server can ping the device.

- **Bundle ID:** `com.bulldogops.bulldogchat`
- **Scheme:** `bulldogchat://`
- **Live web target:** `https://vector-chat-zzlq.onrender.com`
- **Override via env:** `EXPO_PUBLIC_APP_URL` at build time
- **Server endpoint:** `POST /api/push/expo-subscribe` (Bearer JWT)

## Architecture

```
mobile/
├── app.json              Expo config (icons, splash, permissions, bundle ID)
├── eas.json              Build profiles for EAS
├── app/
│   ├── _layout.tsx       SafeArea + dark status bar wrapper
│   └── index.tsx         WebView shell + push registration
└── assets/
    ├── icon.png          1024×1024 app icon
    ├── splash.png        1284×2778 splash screen
    └── favicon.png       32×32 favicon
```

`app/index.tsx` does three things:

1. Registers the device for an Expo push token on first launch.
2. Injects the token into the WebView and posts it to
   `/api/push/expo-subscribe` once the user is logged in (the page emits a
   `vc:loggedin` window event after login; the shell re-injects on that event).
3. Listens for `Notifications.addNotificationResponseReceivedListener` so when
   the user taps a push, the shell navigates the WebView to the deep link in
   the notification payload (`data.url` or `data.channelId` + `data.messageId`).

## One-time setup

```bash
cd mobile
npm install
npm install -g eas-cli
eas login                              # use the bulldogops Expo account
eas init --id REPLACE_WITH_PROJECT_ID  # writes extra.eas.projectId
```

Replace the `REPLACE_WITH_*` placeholders in `app.json` and `eas.json` with the
real Expo project ID, Apple Team ID, Apple ID, and App Store Connect ID before
the first production build.

## Local development

```bash
cd mobile
npm install
npm start            # Metro bundler + QR code for Expo Go
npm run ios          # iOS simulator
npm run android      # Android emulator
```

For local dev against a non-production web target:

```bash
EXPO_PUBLIC_APP_URL=http://192.168.1.42:5000 npm start
```

## Building for the App Store / Play Store

We use [EAS Build](https://docs.expo.dev/build/introduction/) — no local Xcode
or Android Studio toolchain required.

```bash
# iOS — TestFlight or App Store
eas build --platform ios --profile production

# Android — Play Console internal track
eas build --platform android --profile production

# Both at once
eas build --platform all --profile production
```

EAS will prompt the first time for Apple credentials (App Store Connect API key
recommended) and an Android keystore. Let EAS manage the keystore unless the
org already has one.

## Submitting

```bash
eas submit --platform ios       # uploads to App Store Connect
eas submit --platform android   # uploads to Play Console (internal track)
```

Make sure `submit.production.android.serviceAccountKeyPath` in `eas.json`
points at a valid Google Play service account JSON (gitignored).

## Push notifications

The server uses `expo-server-sdk` (`server/expo-push.ts`) to send pushes via
`https://exp.host/--/api/v2/push/send` using the token captured here. No
Firebase or APNs cert configuration is required on the server side because
Expo proxies to FCM/APNs for us. The Expo project ID in `app.json` is the only
binding.

To test a push end-to-end:

1. Sign into Bulldogchat from the mobile app and complete login.
2. Inspect the server logs for `[expo-push] subscribed device=<...>`.
3. From a different browser, send a message that mentions you (`@yourname`),
   or have an admin send `@everyone` / `@here` to a channel you're in.
4. The device should receive a banner; tapping it should deep-link into the
   right channel.

## Known limitations & next steps

- **WebRTC voice channels via WebView** work on Android (Chromium) but iOS
  WKWebView does not expose `getUserMedia()` for arbitrary origins on iOS 14.3
  and below. For full voice-channel support on iOS, swap the voice route to
  the native `@livekit/react-native` SDK and have the WebView post the room
  token to the shell when the user joins a voice channel.
- **Background audio** is not configured; calls will pause when the app is
  backgrounded. Add `UIBackgroundModes: ["audio", "voip"]` to `ios.infoPlist`
  and PushKit VoIP integration when you ship native voice.
- **Universal links** (deep links from email/SMS) are not yet configured.
  Add `associatedDomains` (iOS) and `intentFilters` (Android) once the
  `bulldogops.com` apex domain hosts the `apple-app-site-association` and
  `assetlinks.json` files.

## Bundle / scheme reference

| Field             | Value                                     |
| ----------------- | ----------------------------------------- |
| iOS Bundle ID     | `com.bulldogops.bulldogchat`              |
| Android package   | `com.bulldogops.bulldogchat`              |
| URL scheme        | `bulldogchat://`                          |
| Display name      | `Bulldogchat`                             |
| Splash background | `#0a1828` (navy)                          |
| Tint              | `#c53030` (Vector red)                    |
| Server push API   | `POST /api/push/expo-subscribe` (JWT)     |
| Push send route   | `server/expo-push.ts` → Expo HTTPS API    |
