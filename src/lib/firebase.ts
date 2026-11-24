import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";

// All Firebase values come from environment variables (see .env.example).
// The app renders a setup message instead of crashing when they are missing.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

// The debug token is honoured only in dev mode, so a production bundle can
// never bypass attestation even if a token value leaked into the build env.
const debugToken =
  import.meta.env.DEV &&
  (import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined);

export const appCheckMode: "recaptcha" | "debug" | "none" = debugToken
  ? "debug"
  : import.meta.env.VITE_RECAPTCHA_SITE_KEY
    ? "recaptcha"
    : "none";

let app: FirebaseApp | null = null;
let ai: AI | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  if (!firebaseConfigured) return null;
  if (!app) {
    app = initializeApp(firebaseConfig);

    // App Check is required by Firebase AI Logic. Debug tokens are accepted
    // for local development; reCAPTCHA Enterprise protects the deployment.
    // (Classic v3 registration is deprecated in the console, so the project
    // uses Enterprise. The v3 key created earlier is unused.)
    const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
    if (debugToken) {
      // When this flag is set, the App Check SDK exchanges the debug token
      // instead of running attestation. The token must be registered in the
      // Firebase console (App Check > Manage debug tokens).
      (self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
        debugToken;
    }
    initializeAppCheck(app, {
      // In debug mode the provider below is bypassed by the SDK, so a missing
      // site key is fine locally. The deployed app always sets a real key.
      provider: new ReCaptchaEnterpriseProvider(siteKey ?? "debug-mode-no-site-key"),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

export function getFirebaseAI(): AI | null {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;
  if (!ai) {
    // Gemini Developer API backend: free tier, no billing needed.
    ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
  }
  return ai;
}
