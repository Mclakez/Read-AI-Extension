// Ensure context menu exists (in case onInstalled didn't fire)
function ensureContextMenuExists() {
  try {
    chrome.contextMenus.remove("explain-selection").catch(() => {});
    chrome.contextMenus.create({
      id: "explain-selection",
      title: "Explain with ReadAI",
      contexts: ["selection", "image", "page"]
    });
  } catch (e) {}
}

function formatExplanationForNotification(explanation) {
  if (!explanation) return null;
  if (explanation.explanation) return explanation.explanation;
  if (explanation.type === "dictionary" && explanation.meanings?.length) {
    return explanation.word + ": " + explanation.meanings
      .map(m => (m.partOfSpeech ? m.partOfSpeech + ": " : "") + m.definition)
      .join(" | ");
  }
  return null;
}

function injectChatPopupFunc(msg) {
  var existing = document.getElementById("readai-popup");
  if (existing) existing.remove();
  var popup = document.createElement("div");
  popup.id = "readai-popup";
  popup.style.cssText = "position:fixed;top:80px;right:20px;z-index:2147483647;width:320px;max-height:70vh;overflow-y:auto;background:#1a1a2e;border:1px solid rgba(255,255,255,0.09);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#e8e8f0;padding:16px;box-sizing:border-box;";
  var close = document.createElement("button");
  close.textContent = "\u2715";
  close.style.cssText = "position:absolute;top:8px;right:10px;background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;";
  close.onclick = function () { popup.remove(); };
  var thread = document.createElement("div");
  thread.id = "readai-thread";
  var bubble = document.createElement("div");
  bubble.className = "readai-ai-bubble";
  bubble.style.cssText = "background:rgba(255,255,255,0.06);border-radius:8px;padding:10px 12px;white-space:pre-wrap;margin-top:8px;";
  bubble.textContent = msg;
  thread.appendChild(bubble);
  popup.appendChild(close);
  popup.appendChild(thread);
  document.body.appendChild(popup);
}

let resultWindowId = null;

async function isPdfTab(tabId) {
  try {
    var tab = await chrome.tabs.get(tabId);
    var url = tab.url || tab.pendingUrl || "";
    if (/\.pdf($|\?|#)/i.test(url)) return true;
    if (/^file:\/\//i.test(url) && /\.pdf/i.test(url)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await isPdfTab(tabId)) return false;

  try {
    var ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (ping && ping.ok) return true;
  } catch (e) {}
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ["content.css"] });
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["html2canvas.min.js", "imageSelect.js", "content.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function openResultWindow(text, imageMode, imageData) {
  var pending = {
    readaiPendingResult: text,
    readaiPendingImageMode: !!imageMode
  };
  if (imageMode && imageData) {
    pending.readaiPendingImageData = imageData;
  } else {
    await chrome.storage.local.remove("readaiPendingImageData");
  }
  await chrome.storage.local.set(pending);

  if (resultWindowId != null) {
    try {
      await chrome.windows.update(resultWindowId, { focused: true });
      var tabs = await chrome.tabs.query({ windowId: resultWindowId });
      if (tabs && tabs[0]) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, {
            type: "SHOW_RESULT",
            explanation: text,
            imageMode: !!imageMode,
            imageData: imageData || null
          });
          return true;
        } catch (e) {
          await chrome.tabs.update(tabs[0].id, { url: chrome.runtime.getURL("result.html") });
          return true;
        }
      }
    } catch (e) {
      resultWindowId = null;
    }
  }

  var win = await chrome.windows.create({
    url: chrome.runtime.getURL("result.html"),
    type: "popup",
    width: 400,
    height: 560
  });
  resultWindowId = win && win.id != null ? win.id : null;
  return true;
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === resultWindowId) resultWindowId = null;
  });
}

async function showResultInChat(tabId, text, imageMode, imageData) {
  if (!text) return false;

  // Firefox PDF viewer is privileged — content scripts / executeScript never work there.
  if (!(await isPdfTab(tabId))) {
    await ensureContentScript(tabId);

    try {
      var resp = await chrome.tabs.sendMessage(tabId, {
        type: "SHOW_RESULT",
        explanation: text
      });
      if (resp && resp.handled) return true;
    } catch (e) {}

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: injectChatPopupFunc,
        args: [text]
      });
      return true;
    } catch (e) {}
  }

  return openResultWindow(text, imageMode, imageData);
}

async function explainSelectionInTab(tabId, selectionText) {
  var pdf = await isPdfTab(tabId);

  // Normal pages: prefer in-page content script chat.
  if (!pdf) {
    try {
      var response = await chrome.tabs.sendMessage(tabId, {
        type: "EXPLAIN",
        selectionText: selectionText || ""
      });
      if (response && response.handled) return true;
    } catch (e) {}

    await ensureContentScript(tabId);

    try {
      var response2 = await chrome.tabs.sendMessage(tabId, {
        type: "EXPLAIN",
        selectionText: selectionText || ""
      });
      if (response2 && response2.handled) return true;
    } catch (e) {}
  }

  // PDF (and any leftover fallback): use context-menu selection text, then screenshot.
  // Never rely on injecting into Firefox's PDF viewer.
  if (selectionText && selectionText.trim()) {
    var explanation = await explainClipboardText(selectionText);
    var notifText = formatExplanationForNotification(explanation);
    if (notifText) {
      await showResultInChat(tabId, notifText, false);
      return true;
    }
  }

  if (!pdf) {
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => { var sel = window.getSelection(); return sel ? sel.toString().trim() : ""; }
      });
      var text = results?.[0]?.result || "";
      if (text) {
        var result = await explainClipboardText(text);
        var notifText2 = formatExplanationForNotification(result);
        if (notifText2) {
          await showResultInChat(tabId, notifText2, false);
          return true;
        }
      }
    } catch (e) {}
  }

  try {
    var screenshotResult = await capturePageAsImage(tabId);
    if (screenshotResult && screenshotResult.explanation) {
      await showResultInChat(
        tabId,
        screenshotResult.explanation,
        true,
        screenshotResult.imageData || null
      );
      return true;
    }
  } catch (e) {
    console.error("ReadAI: PDF/page screenshot failed", e);
  }

  await openResultWindow("Could not explain this page. On PDFs, select text and right-click, or right-click the page to screenshot.", false);
  return false;
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    getDatabase();
  } catch (e) {}
  ensureContextMenuExists();
});

// Ensure menu exists on startup too
ensureContextMenuExists();

// Delayed check to confirm menu exists
setTimeout(() => {
  ensureContextMenuExists();
}, 5000);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "explain-selection") return;

  // Resolve real tab if tab.id is invalid (e.g., -1 from PDF viewer guest frame)
  let resolvedTab = tab;
  if (!resolvedTab || typeof resolvedTab.id !== "number" || resolvedTab.id < 0) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    resolvedTab = tabs?.[0];
  }

  if (!resolvedTab || typeof resolvedTab.id !== "number" || resolvedTab.id < 0) return;

  await explainSelectionInTab(resolvedTab.id, info.selectionText || "");
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "explain-selection") return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return;
  await explainSelectionInTab(tabs[0].id, "");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_PAGE") {
    capturePageAsImage(sender.tab?.id).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === "EXPLAIN_CLIPBOARD") {
    explainClipboardText(message.text).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === "SHOW_RESULT_IN_TAB") {
    showResultInChat(message.tabId, message.explanation, message.imageMode, message.imageData).then((ok) => sendResponse({ ok: !!ok }));
    return true;
  }
  if (message.type === "FOLLOW_UP") {
    const runner = message.imageMode
      ? handleImageExplanationRequest({ history: message.history })
      : getAIExplanation({ selectedText: "", context: "", history: message.history });
    runner.then((result) => sendResponse(result || { explanation: "Something went wrong." }))
      .catch(() => sendResponse({ explanation: "Something went wrong. Please try again." }));
    return true;
  }
});

async function explainClipboardText(text) {
  if (!text) return { explanation: "No text to explain." };
  const words = text.trim().split(/\s+/).length;
  if (words === 1) {
    return getDictionaryDefinition(text.trim());
  }
  return getAIExplanation({ selectedText: text, context: "", history: [] });
}

async function capturePageAsImage(tabId) {
  try {
    const keyResult = await chrome.storage.local.get("groqApiKey");
    const GROQ_KEY = keyResult.groqApiKey;
    if (!GROQ_KEY) return { explanation: "No API key found. Add one in the popup." };

    var targetTab;
    if (tabId) {
      targetTab = await chrome.tabs.get(tabId).catch(() => null);
    }
    if (!targetTab) {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTab = tabs?.[0];
    }
    if (!targetTab) return { explanation: "No active tab." };

    var screenshotUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: "jpeg", quality: 70 });
    var response = await fetch(screenshotUrl);
    var blob = await response.blob();
    var buffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    var imageData = "data:image/jpeg;base64," + btoa(binary);

    var groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_KEY },
      body: JSON.stringify({
        model: "qwen/qwen3.6-27b",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe what's shown in this image in 2-4 sentences. Be direct and factual. No reasoning, no thinking, just the description." },
            { type: "image_url", image_url: { url: imageData } }
          ]
        }]
      })
    });
    var data = await groqResponse.json();
    var content = data.choices[0].message.content || "";
    return { explanation: stripThinking(content), imageData: imageData };
  } catch (e) {
    console.error("ReadAI: capturePageAsImage failed", e);
    return { explanation: "Failed to capture page: " + e.message };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "readai-content") return;
  console.log("ReadAI: port connected");

  port.onMessage.addListener(async (message) => {
    if (message.type === "GET_EXPLANATION") {
      console.log("ReadAI: got GET_EXPLANATION");
      try {
        const result = await handleExplanationRequest(message.payload);
        console.log("ReadAI: GET_EXPLANATION result type:", result?.type);
        try { port.postMessage({ type: "RESPONSE", requestId: message.requestId, result }); } catch {}
      } catch {
        console.log("ReadAI: GET_EXPLANATION failed");
        try { port.postMessage({ type: "RESPONSE", requestId: message.requestId, result: { type: "ai", explanation: "Something went wrong. Please try again." } }); } catch {}
      }
    } else if (message.type === "GET_IMAGE_EXPLANATION") {
      console.log("ReadAI: got GET_IMAGE_EXPLANATION", message.payload?.imageData ? "with imageData" : "with rect");
      try {
        const result = await handleImageExplanationRequest(message.payload, port.sender?.tab?.id);
        console.log("ReadAI: GET_IMAGE_EXPLANATION result:", result?.type, result?.explanation?.substring(0, 40));
        try { port.postMessage({ type: "RESPONSE", requestId: message.requestId, result }); } catch {}
      } catch (e) {
        console.error("ReadAI: GET_IMAGE_EXPLANATION failed:", e?.message || e);
        try { port.postMessage({ type: "RESPONSE", requestId: message.requestId, result: { type: "ai", explanation: "Something went wrong. Please try again." } }); } catch {}
      }
    }
  });
});

async function handleExplanationRequest(payload) {
  const hasImageContent = payload.history?.some(msg =>
    Array.isArray(msg.content) && msg.content.some(c => c.type === 'image_url')
  );

  if (hasImageContent) {
    return handleImageExplanationRequest({ history: payload.history });
  }

  let isOnline = true;
  try {
    const test = await fetch("https://api.groq.com", { method: "HEAD" });
    isOnline = true;
  } catch {
    isOnline = false;
  }
  const wordCount = payload.selectedText?.trim().split(/\s+/).length ?? 0;

  if (wordCount === 1) {
    return getDictionaryDefinition(payload.selectedText.trim());
  }

  if (!isOnline) {
    return {
      type: "ai",
      explanation: "You're offline. Highlight a single word to get an offline definition."
    };
  }

  return getAIExplanation(payload);
}

async function getAIExplanation({ selectedText, context, history }) {
  const result = await chrome.storage.local.get("groqApiKey");
  const GROQ_KEY = result.groqApiKey;

  if (!GROQ_KEY) {
    return {
      type: "ai",
      explanation: "No API key found. Click the ReadAI extension icon to add your Groq key."
    };
  }
  const messages = history && history.length > 0
    ? history
    : [
        {
          role: "system",
          content: "You are a reading companion. When given a passage and a highlighted section, explain the highlighted part clearly and simply using the passage as context. When answering follow-up questions, stay grounded in the same reading context."
        },
        {
          role: "user",
          content: `I am reading the following passage:

"${context}"

Please explain this part in plain, simple English as if talking to a curious reader:

"${selectedText}"

Keep it concise — 2 to 4 sentences. No bullet points.`
        }
      ];

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 300,
        messages
      })
    });

    const data = await response.json();
    return {
      type: "ai",
      explanation: data.choices[0].message.content
    };

  } catch (error) {
    console.error("Full error:", error);
    throw error;
  }
}


async function getDictionaryDefinition(word) {
  try {
    const response = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );

    if (response.ok) {
      const data = await response.json();
      console.log(data)
      return formatDictionaryEntry(data[0], word);
    }
  } catch (error) {
    console.log("Dictionary API unavailable, using local fallback");
  }

  return getLocalDefinition(word);
}

function formatDictionaryEntry(entry, word) {
  if (!entry || !entry.meanings || entry.meanings.length === 0) {
    return { explanation: `No definition found for "${word}".` };
  }

  const lines = [];

  entry.meanings.slice(0, 2).forEach(meaning => {
    const partOfSpeech = meaning.partOfSpeech;
    const definition = meaning.definitions[0]?.definition;
    const example = meaning.definitions[0]?.example;

    if (definition) {
      let line = `${partOfSpeech}: ${definition}`;
      if (example) line += ` (e.g. "${example}")`;
      lines.push(line);
    }
  });

  return {
    type: "dictionary",
    word: entry.word,
    phonetic: entry.phonetic ?? "",
    meanings: entry.meanings.slice(0, 2).map(meaning => ({
      partOfSpeech: meaning.partOfSpeech,
      definition: meaning.definitions[0]?.definition ?? "",
      example: meaning.definitions[0]?.example ?? ""
    }))
  };
}

async function getLocalDefinition(word) {
  try {
    const db = await getDatabase();
    const entry = await lookupWord(db, word);

    if (entry) {
      return {
        type: "dictionary",
        word: word,
        phonetic: "",
        meanings: [{
          partOfSpeech: "",
          definition: entry.definition,
          example: ""
        }]
      };
    }
  } catch (error) {
    console.error("IndexedDB lookup failed:", error);
  }

  return {
    type: "dictionary",
    word: word,
    phonetic: "",
    meanings: [{
      partOfSpeech: "",
      definition: `No definition found for "${word}".`,
      example: ""
    }]
  };
}



// Open (or create) the IndexedDB database
function openDatabase() {
  return new Promise((resolve, reject) => {
    // v2: chunked dict/*.txt import (dictionary.json was too large for Firefox)
    const request = indexedDB.open("readai-dictionary", 2);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (event.oldVersion < 1) {
        db.createObjectStore("words", { keyPath: "word" });
      } else if (event.oldVersion < 2 && db.objectStoreNames.contains("words")) {
        // Force a clean re-import from chunked dictionary files
        db.deleteObjectStore("words");
        db.createObjectStore("words", { keyPath: "word" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Check if dictionary is already loaded
function isDictionaryLoaded(db) {
  return new Promise((resolve) => {
    const tx = db.transaction("words", "readonly");
    const store = tx.objectStore("words");
    const request = store.get("__meta__");
    request.onsuccess = () => {
      const meta = request.result;
      resolve(!!(meta && meta.definition === "v2-complete"));
    };
    request.onerror = () => resolve(false);
  });
}

// Load dict/part-XX.txt chunks into IndexedDB (avoids parsing one giant JSON)
async function loadDictionaryIntoDatabase(db) {
  const indexUrl = chrome.runtime.getURL("dict/index.json");
  const index = await (await fetch(indexUrl)).json();
  const partCount = index.parts || 0;

  for (var i = 0; i < partCount; i++) {
    var partName = "dict/part-" + String(i).padStart(2, "0") + ".txt";
    var text = await (await fetch(chrome.runtime.getURL(partName))).text();
    var lines = text.split("\n");

    await new Promise(function (resolve, reject) {
      var tx = db.transaction("words", "readwrite");
      var store = tx.objectStore("words");
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (!line) continue;
        try {
          var pair = JSON.parse(line);
          if (pair && pair[0]) {
            store.put({ word: String(pair[0]).toLowerCase(), definition: pair[1] || "" });
          }
        } catch (e) {}
      }
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }

  await new Promise(function (resolve, reject) {
    var tx = db.transaction("words", "readwrite");
    tx.objectStore("words").put({ word: "__meta__", definition: "v2-complete" });
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });

  console.log("ReadAI: dictionary loaded into IndexedDB from", partCount, "chunks");
}

// Look up a word in IndexedDB
function lookupWord(db, word) {
  return new Promise((resolve) => {
    const tx = db.transaction("words", "readonly");
    const store = tx.objectStore("words");
    const request = store.get(word.toLowerCase());
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

// Initialize dictionary on startup
let dbInstance = null;

async function getDatabase() {
  if (dbInstance) return dbInstance;

  const db = await openDatabase();
  const loaded = await isDictionaryLoaded(db);

  if (!loaded) {
    console.log("ReadAI: loading dictionary for first time...");
    await loadDictionaryIntoDatabase(db);
  }

  dbInstance = db;
  return db;
}



// ── Image explanation ──────────────────────────────────────────────

async function handleImageExplanationRequest({ rect, history, imageData, imageUrl }, senderTabId) {
  const result = await chrome.storage.local.get("groqApiKey");
  const GROQ_KEY = result.groqApiKey;

  if (!GROQ_KEY) {
    return {
      type: "ai",
      explanation: "No API key found. Click the ReadAI extension icon to add your Groq key."
    };
  }

  var messages;

  if (history && history.length > 0) {
    messages = history;
  }

  var rx = rect && (rect.x !== undefined ? rect.x : rect.left);
  var ry = rect && (rect.y !== undefined ? rect.y : rect.top);
  var rw = rect && rect.width;
  var rh = rect && rect.height;

  if (!messages) {
    var imagePrompt = { type: "text", text: "Describe what's shown in this image in 2-4 sentences. Be direct and factual. No reasoning, no thinking, just the description." };
    var imageContent;
    if (imageUrl) {
      imageContent = imageUrl;
    } else if (imageData) {
      imageContent = imageData;
    } else if (rx !== undefined && rw > 0) {
      try {
        var targetTab = senderTabId ? await chrome.tabs.get(senderTabId).catch(() => null) : null;
        if (!targetTab) {
          var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTab = tabs?.[0];
        }
        if (!targetTab) return { type: "ai", explanation: "Could not identify the tab to capture." };
        const screenshotUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: "jpeg", quality: 90 });
        var dpr = rect.devicePixelRatio || 1;
        imageContent = imageData = await cropImage(screenshotUrl, { x: rx, y: ry, width: rw, height: rh, devicePixelRatio: dpr });
      } catch (e) {
        console.error("ReadAI: capture+crop failed", e);
        return { type: "ai", explanation: "Failed to capture the selected area. Try again or use a different selection." };
      }
    } else {
      return { type: "ai", explanation: "No image data available to analyze." };
    }
    if (imageContent) {
      messages = [{
        role: "user",
        content: [
          imagePrompt,
          { type: "image_url", image_url: { url: imageContent } }
        ]
      }];
    } else {
      return { type: "ai", explanation: "No image data available to analyze." };
    }
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "qwen/qwen3.6-27b",
        max_tokens: 4096,
        messages
      })
    });

    const data = await response.json();
    var content = data.choices[0].message.content || "";
    var reasoning = data.choices[0].message.reasoning || "";
    // Qwen reasoning models include the thinking in `content` before the answer,
    // separated by <think> tags or double newlines
    var explanation = stripThinking(reasoning || content);
    return {
      type: "ai",
      explanation: explanation,
      imageData
    };
  } catch (error) {
    console.error("Full error:", error);
    throw error;
  }
}

function stripThinking(content) {
  if (!content) return content;
  // Remove <think> tags
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Split on paragraph breaks and take the last meaningful part
  var parts = content.split(/\n{2,}/).filter(Boolean);
  if (parts.length > 1) {
    var last = parts[parts.length - 1].trim();
    if (last.length > 0 && last.length < content.length * 0.5) {
      return last;
    }
  }
  return content;
}

async function cropImage(screenshotUrl, rect) {
  const response = await fetch(screenshotUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const dpr = rect.devicePixelRatio || 1;
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.round(rect.width * dpr);
  const sh = Math.round(rect.height * dpr);

  if (sw < 1 || sh < 1) throw new Error("Selection too small: " + sw + "x" + sh);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Could not create canvas context");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const buffer = await croppedBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return `data:image/jpeg;base64,${base64}`;
}
