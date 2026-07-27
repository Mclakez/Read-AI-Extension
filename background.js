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

// Ensure context menu exists (in case onInstalled didn't fire)
function ensureContextMenuExists() {
  try {
    chrome.contextMenus.remove("explain-selection").catch(() => {});
    chrome.contextMenus.create({
      id: "explain-selection",
      title: "Explain with ReadAI",
      contexts: ["selection", "image"]
    });
  } catch (e) {}
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
  
  // Try to send message to content script (so chat popup shows there)
  try {
    var response = await chrome.tabs.sendMessage(resolvedTab.id, { type: "EXPLAIN", selectionText: info.selectionText || "" });
    if (response && response.handled) return;
  } catch (e) {}
  
  // Fallback: handle directly in background if content script not available
  if (info.selectionText && info.selectionText.trim()) {
    var explanation = await explainClipboardText(info.selectionText);
    var notifText = formatExplanationForNotification(explanation);
    if (notifText) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: resolvedTab.id },
          func: (msg) => {
            var d = document.createElement("div");
            d.textContent = msg;
            d.style.cssText = "position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:8px;z-index:99999;max-width:400px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
            document.body.appendChild(d);
            setTimeout(() => d.remove(), 15000);
          },
          args: [notifText]
        });
        return;
      } catch (e) {}
    }
  }
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: resolvedTab.id },
      func: () => { var sel = window.getSelection(); return sel ? sel.toString().trim() : ""; }
    });
    var text = results?.[0]?.result || "";
    if (text) {
      var result = await explainClipboardText(text);
      var notifText = formatExplanationForNotification(result);
      if (notifText) {
        await chrome.scripting.executeScript({
          target: { tabId: resolvedTab.id },
          func: (msg) => {
            var d = document.createElement("div");
            d.textContent = msg;
            d.style.cssText = "position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:8px;z-index:99999;max-width:400px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
            document.body.appendChild(d);
            setTimeout(() => d.remove(), 15000);
          },
          args: [notifText]
        });
        return;
      }
    }
  } catch (e) {}
  try {
    var screenshotResult = await capturePageAsImage(resolvedTab.id);
    if (screenshotResult && screenshotResult.explanation) {
      await chrome.scripting.executeScript({
        target: { tabId: resolvedTab.id },
        func: (msg) => {
          var d = document.createElement("div");
          d.textContent = msg;
          d.style.cssText = "position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:8px;z-index:99999;max-width:400px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
          document.body.appendChild(d);
          setTimeout(() => d.remove(), 15000);
        },
        args: [screenshotResult.explanation]
      });
    }
  } catch (e) {}
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "explain-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "EXPLAIN" }).catch(() => {});
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_PAGE") {
    capturePageAsImage().then((result) => sendResponse(result));
    return true;
  }
  if (message.type === "EXPLAIN_CLIPBOARD") {
    explainClipboardText(message.text).then((result) => sendResponse(result));
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
    return { explanation: stripThinking(content) };
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
    const request = indexedDB.open("readai-dictionary", 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("words")) {
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
    const count = store.count();
    count.onsuccess = () => resolve(count.result > 0);
    count.onerror = () => resolve(false);
  });
}

// Load dictionary.json and store every word in IndexedDB
async function loadDictionaryIntoDatabase(db) {
  const url = chrome.runtime.getURL("dictionary.json");
  const response = await fetch(url);
  const data = await response.json();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("words", "readwrite");
    const store = tx.objectStore("words");

    Object.entries(data).forEach(([word, definition]) => {
      store.put({ word: word.toLowerCase(), definition });
    });

    tx.oncomplete = () => {
      console.log("ReadAI: dictionary loaded into IndexedDB");
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
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
