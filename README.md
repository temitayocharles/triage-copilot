# Triage Copilot

Incident triage for DevOps teams, built with Firebase AI Logic hybrid inference.
Entry for the **#BuildHybridAI 2026** hackathon (Web platform).

Paste logs or describe an incident. The app triages it in two stages:

1. **Fast triage, on-device when possible.** A structured classification
   (severity P1–P4, category, affected component, one-line summary, confidence,
   supporting signals) runs through Firebase AI Logic in `prefer_on_device`
   mode. On Chrome for desktop with Gemini Nano available, it runs locally:
   logs never leave the device, and it works offline. When the on-device model
   is not available, the same call falls back to the cloud model.
2. **Full diagnosis in the cloud.** The longer, higher-context job — what
   happened, likely root cause, evidence, numbered fix steps with commands,
   verification, and prevention — runs on the cloud Gemini model through the
   same SDK, streamed as it is written.

Every result shows where inference actually ran (on-device or in cloud), which
model answered, and how long it took. The path comes from the SDK response
(`response.inferenceSource`), not from a guess.

## How hybrid inference is used

All AI calls live in `src/lib/triage.ts`:

| Step | Call | Mode |
| --- | --- | --- |
| Backend | `getAI(app, { backend: new GoogleAIBackend() })` | Gemini Developer API |
| Triage | `getGenerativeModel(ai, { mode, inCloudParams, onDeviceParams })` | `PREFER_ON_DEVICE` (default), `ONLY_ON_DEVICE`, or `ONLY_IN_CLOUD` — user selectable |
| Triage output | Structured JSON via `Schema` helpers | `inCloudParams.generationConfig.responseSchema` + `onDeviceParams.promptOptions.responseConstraint`, same schema both paths |
| On-device init | `model.initializeDeviceModel(onDownloadProgress)` | After the Triage click, before the prompt |
| Which path ran | `result.response.inferenceSource` | `on_device` or `in_cloud`, shown on every result |
| Diagnosis | `getGenerativeModel(ai, { model: "gemini-3.5-flash-lite" })` + `generateContentStream` | Cloud-only by design |

Firebase App Check is enforced for AI Logic (`src/lib/firebase.ts`):
reCAPTCHA Enterprise on the deployment, debug tokens for local development.

## Run it

```bash
npm install
cp .env.example .env   # fill in your Firebase web app values
npm run dev            # http://localhost:5173
npm run build          # production build in dist/
```

### Firebase setup

1. Create a Firebase project (no Analytics needed).
2. AI Services → AI Logic → Get started, choose the **Gemini Developer API**
   provider, complete the workflow (this enforces App Check for AI Logic).
3. Project settings → Your apps → add a Web app, copy the config into `.env`.
4. App Check → register the web app with reCAPTCHA Enterprise (Classic v3
   registration is deprecated) and put the site key in `.env`
   (`VITE_RECAPTCHA_SITE_KEY`). For local development, register a debug
   token instead (`VITE_APPCHECK_DEBUG_TOKEN`). The debug token is honoured
   only in dev mode and is cleared in `.env.production`, so it never ships
   in the deployed bundle.
5. Deploy: `firebase deploy --only hosting` (or deploy `dist/` anywhere static,
   e.g. Vercel).

### On-device inference (Gemini Nano)

On-device triage needs Chrome on desktop, version 139 or higher, with the flag
`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` enabled and the
Gemini Nano model downloaded (the app starts the download on first use and
shows progress). In any other browser, or before the model is ready, triage
falls back to the cloud automatically. The status pill in the header shows what
this browser supports.

## Project layout

```
src/
  App.tsx            UI: input, triage card, streaming diagnosis, history
  App.css            styles
  index.css          base styles
  lib/
    firebase.ts      Firebase init, App Check, AI Logic backend
    triage.ts        hybrid triage + cloud diagnosis (all AI calls)
    samples.ts       three sample incidents for one-click demos
    types.ts         shared types
    chrome-ai.d.ts   minimal typings for Chrome's Prompt API
```

## Privacy

- On-device triage sends nothing anywhere: the input stays in the browser.
- Cloud fallback and the diagnosis step send the incident text to Google's
  Gemini API via Firebase AI Logic.
- Triage history is stored in the browser's localStorage only.

## License

Apache License 2.0. See `LICENSE`.
