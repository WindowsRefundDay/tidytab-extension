# TidyTab

A dependency-free Manifest V3 Chrome extension that sorts the current browser window into tab groups using local title/domain sorting or AI.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this folder.
5. Open the extension options page and configure a provider before using Smart AI Sort or Agentic Sort.

## Modes

- **Title Sort**: groups tabs locally by domain and sorts them by title.
- **Smart AI Sort**: sends tab title/URL, or title/URL/page snippets, to the selected AI provider.
- **Agentic Sort**: asks the AI provider for a draft grouping, then asks it to refine and normalize the final grouping.
- **History-aware AI**: optional setting that adds recent browser history, visit transitions, referrer visit IDs, and nearby timeline context to AI sorting.

Use **Undo last sort** in the popup to restore the most recent pre-sort tab order and group state. Closed tabs are skipped during undo.

Enable **Click extension icon to sort immediately** in Options to make the toolbar button run the saved default sort instead of opening the popup. Right-click the extension icon and choose Options to turn the popup back on.
Chrome Built-in AI is disabled while this option is on because Chrome's local model session needs the popup/user-activation flow.

## Providers

- OpenAI Responses API
- OpenAI-compatible chat completions endpoint
- Google Vertex AI Gemini `generateContent`
- Google Gemini API key `generateContent`
- Chrome Built-in AI with local Gemini Nano where Chrome supports the Prompt API

API keys and provider settings are stored in Chrome extension local storage. This is convenient for local use, but it is not a secure secret vault.

History context is off by default. Enabling it asks Chrome for history permission, and history details may be sent to the selected AI provider during AI sorting.

## Development

Run the local tests:

```sh
npm test
```
