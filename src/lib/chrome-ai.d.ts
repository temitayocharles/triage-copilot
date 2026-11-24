// Minimal typings for Chrome's built-in Prompt API (Gemini Nano).
// The standard TypeScript DOM library does not include these yet.
export {};

declare global {
  interface LanguageModelAvailability {
    availability(): Promise<"available" | "downloading" | "downloadable" | "unavailable">;
  }

  interface Window {
    LanguageModel?: LanguageModelAvailability;
  }

  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelAvailability | undefined;
}
