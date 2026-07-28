# ReadAI — Version 1.0.1

## Version description (release notes)

**ReadAI 1.0.1** — Firefox release

ReadAI helps you understand what you read. Highlight text on a web page and get a plain-language explanation with context, or look up a single word offline.

**How to use**
- Select text → right-click → **Explain with ReadAI**
- Or press **Alt+Shift+X**
- Or click the toolbar icon → **Explain selected text on this page**
- Ask follow-up questions in the chat popup

**Features**
- AI explanations for highlighted passages (requires your own Groq API key)
- Single-word dictionary lookups (online API with offline fallback)
- Image / region explanation on regular web pages
- On PDFs: results open in a separate ReadAI window (Firefox does not allow extensions inside the built-in PDF viewer)

**Changes in 1.0.1**
- Firefox compatibility: background uses `background.scripts` instead of MV3 service worker
- Offline dictionary split into small `dict/` chunks (under 4 MB each) for Firefox packaging limits
- PDF support via background screenshot + dedicated result window
- Removed unused `clipboardRead` permission
- Context-menu and dictionary fallbacks show results in the chat UI, not a corner toast

---

## Notes to reviewers

### Summary

ReadAI is a reading assistant. The user highlights text; the extension sends the selection (and nearby paragraph context) to the Groq API for an explanation, or to a dictionary service / local word list for single-word lookups. No account or server is operated by the extension author — the user supplies their own Groq API key, stored locally with `chrome.storage.local`.

### Permissions — why each is needed

| Permission | Purpose |
|------------|---------|
| `activeTab` | Run content scripts and capture the visible tab when the user invokes the extension (context menu, shortcut, toolbar button). |
| `scripting` | Inject content scripts on pages where automatic injection failed, and read selection as a fallback. |
| `storage` | Save the user’s Groq API key and temporary result payload for the PDF result window. |
| `contextMenus` | Add **Explain with ReadAI** to the right-click menu. |
| `tabs` | Resolve the active tab, capture visible tab screenshots for PDF/image fallback, and open the result window. |

**Not requested:** `clipboardRead` — removed; selection is read via `window.getSelection()` or `info.selectionText` from the context menu.

### Host permissions

| Host | Purpose |
|------|---------|
| `https://api.groq.com/*` | Send highlighted text / images to the user’s Groq account for AI explanations. |
| `https://api.dictionaryapi.dev/*` | Online dictionary lookup when the user is online and selects a single word. |
| `file://*/*` | Support local HTML files and local PDFs opened in the browser. |

### Data sent to third parties

- **Groq** (`api.groq.com`): Selected text, surrounding context, follow-up messages, and optionally a JPEG screenshot of the visible tab (PDF / image fallback). Only when the user triggers explain and has saved an API key.
- **Free Dictionary API** (`api.dictionaryapi.dev`): Single-word lookups when online.

No analytics, tracking, or author-operated backend.

### Bundled data — `dict/` folder

The offline dictionary (~102k words) is shipped as eight text files (`dict/part-00.txt` … `dict/part-07.txt`) plus `dict/index.json`. Each part is under 3 MB to stay within Firefox’s per-file lint limit (~4 MB for JSON). On first use, the background script loads these line-by-line into IndexedDB (`readai-dictionary`); the monolithic `dictionary.json` (~23 MB) is **not** included in the package.

Regenerate chunks (development only): `node scripts/split-dictionary.js path/to/dictionary.json`

### PDF behavior (Firefox limitation)

Firefox blocks content scripts and `scripting.executeScript` in the built-in PDF viewer (privileged chrome page). ReadAI does **not** modify the PDF viewer. Instead:

1. Context menu provides `selection`, `image`, and `page` contexts.
2. Selected text from the menu is explained in the background.
3. With no selection, the extension captures a visible-tab screenshot and explains it via Groq.
4. Results are shown in `result.html` (extension popup window), not overlaid on the PDF.

This is expected behavior, not a bypass of PDF security.

### Third-party libraries

- `html2canvas.min.js` — capture page regions for image explanation on normal web pages (minified upstream build).

### How to test

1. Load the extension temporarily in `about:debugging`.
2. Open the popup, enter a Groq API key (`gsk_...`), click **Save Key**.
3. On any regular page: select text → right-click → **Explain with ReadAI** → chat popup should appear.
4. Select one word → dictionary-style result (online or offline from IndexedDB).
5. Open a PDF: select text → right-click → **Explain with ReadAI** → ReadAI result window should open (may take a few seconds on first run while the offline dictionary imports into IndexedDB).
6. On a PDF with no selection: right-click → **Explain with ReadAI** → screenshot explanation in the result window.

### Extension ID

`readai@extension` (set in `browser_specific_settings.gecko.id`)
