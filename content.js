
let isImageMode = false;
let lastMouseTarget = null;

document.addEventListener('mousemove', function (e) {
  lastMouseTarget = e.target;
}, { passive: true });

var lastMouseX = 0;
var lastMouseY = 0;

document.addEventListener('contextmenu', function (e) {
  lastMouseTarget = e.target;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, { passive: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "EXPLAIN") {
    handleExplain(message.selectionText).then((handled) => {
      try {
        sendResponse({ handled: !!handled });
      } catch (e) {}
    }).catch((err) => {
      try { sendResponse({ handled: false, error: err.message }); } catch (e) {}
    });
    return true;
  }
  if (message.type === "SHOW_RESULT") {
    try {
      showResultInPopup(message.explanation);
      sendResponse({ handled: true });
    } catch (e) {
      sendResponse({ handled: false, error: e.message });
    }
    return false;
  }
});


let backgroundPort = null;
let pendingRequests = {};

function getBackgroundPort() {
  if (!backgroundPort) {
    try {
      backgroundPort = chrome.runtime.connect({ name: "readai-content" });
    } catch (e) {
      return null;
    }
    backgroundPort.onMessage.addListener((msg) => {
      if (msg.type === "RESPONSE" && msg.requestId && pendingRequests[msg.requestId]) {
        pendingRequests[msg.requestId](msg.result);
        delete pendingRequests[msg.requestId];
      }
    });
    backgroundPort.onDisconnect.addListener(() => {
      backgroundPort = null;
      Object.values(pendingRequests).forEach(resolve => resolve(null));
      pendingRequests = {};
    });
  }
  return backgroundPort;
}

function sendMessageToBackground(type, payload) {
  return new Promise((resolve) => {
    const port = getBackgroundPort();
    if (!port) {
      resolve(null);
      return;
    }
    const requestId = Date.now() + "-" + Math.random().toString(36).substr(2, 6);
    pendingRequests[requestId] = resolve;
    try {
      port.postMessage({ type, payload, requestId });
    } catch (e) {
      delete pendingRequests[requestId];
      resolve(null);
    }
  });
}


function getSelectionData() {
  const selection = window.getSelection();

  if (!selection || selection.toString().trim() === "") {
    return null;
  }

  const selectedText = selection.toString().trim();

  const anchorNode = selection.anchorNode;
  const paragraph = anchorNode?.parentElement?.closest("p, li, blockquote, td, div") ;

  const context = paragraph ? paragraph.innerText.trim() : "";

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  return { selectedText, context, rect };
}


function createPopup(rect) {
  removePopup();

  const popup = document.createElement("div");
  popup.id = "readai-popup";

  popup.style.visibility = "hidden";
  popup.style.left = `${Math.min(window.scrollX + rect.left, window.innerWidth - 340)}px`;
  popup.style.top = "0px";

  popup.innerHTML = `
    <button id="readai-close">\u2715</button>
    <div id="readai-thread"></div>
    <div id="readai-followup">
      <input id="readai-input" type="text" placeholder="Ask a follow-up..." />
      <button id="readai-send">\u2192</button>
    </div>
  `;

  document.body.appendChild(popup);

  positionPopup(popup, rect);

  document.getElementById("readai-close").addEventListener("click", removePopup);

  document.getElementById("readai-send").addEventListener("click", () => {
    const question = document.getElementById("readai-input").value.trim();
    if (question) handleFollowUp(question, rect);
  });

  document.getElementById("readai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const question = e.target.value.trim();
      if (question) handleFollowUp(question, rect);
    }
  });

  popup.style.visibility = "visible";
  return popup;
}

function positionPopup(popup, rect) {
  var popupWidth = 320;
  var left = rect.left + window.scrollX;
  if (left + popupWidth > window.innerWidth - 20) {
    left = window.innerWidth - popupWidth - 20;
  }
  if (left < 10) left = 10;
  popup.style.left = left + "px";
  popup.style.top = (rect.top + window.scrollY - 10) + "px";
}

function showErrorPopup(rect, message) {
  createPopup(rect || {
    left: lastMouseX || 20,
    top: lastMouseY || 20,
    bottom: (lastMouseY || 20) + 20,
    right: (lastMouseX || 20) + 200
  });
  appendToThread("ai", message);
}

function removePopup() {
  const existing = document.getElementById("readai-popup");
  if (existing) existing.remove();
  conversationHistory = [];
  isImageMode = false;
}





let conversationHistory = [];

async function handleExplain(fallbackSelectionText) {
  try {
    const data = getSelectionData();

    if (data) {
      const { selectedText, context, rect } = data;
      conversationHistory = [];

      const response = await sendMessageToBackground("GET_EXPLANATION", {
        selectedText, context, history: conversationHistory
      });

      if (!response) {
        showErrorPopup(rect, "Could not reach the background script.");
        return false;
      }

      if (response.type === "dictionary") {
        createDictionaryPopup(rect, response);
      } else {
        createPopup(rect);
        appendToThread("ai", response.explanation);
        conversationHistory.push(
          { role: "user", content: `Explain: "${selectedText}" in context: "${context}"` },
          { role: "assistant", content: response.explanation }
        );
      }
      return true;
    }

    // Context-menu selection text (works inside Chrome's PDF viewer)
    if (fallbackSelectionText && fallbackSelectionText.trim()) {
      conversationHistory = [];
      var anchorX = lastMouseX || window.innerWidth / 2;
      var anchorY = lastMouseY || window.innerHeight / 2;
      var anchorRect = { x: anchorX, y: anchorY, width: 200, height: 20, left: anchorX, top: anchorY, bottom: anchorY + 20, right: anchorX + 200 };

      const response = await sendMessageToBackground("GET_EXPLANATION", {
        selectedText: fallbackSelectionText, context: "", history: conversationHistory
      });

      if (!response) {
        showErrorPopup(anchorRect, "Could not reach the background script.");
        return false;
      }

      if (response.type === "dictionary") {
        createDictionaryPopup(anchorRect, response);
      } else {
        createPopup(anchorRect);
        appendToThread("ai", response.explanation || formatResultText(response));
        conversationHistory.push(
          { role: "user", content: `Explain: "${fallbackSelectionText}"` },
          { role: "assistant", content: response.explanation || formatResultText(response) }
        );
      }
      return true;
    }

    // PDFs: no reliable text selection → screenshot the visible page into the chat
    if (isPdfDocument()) {
      return await explainViaScreenshot();
    }

    // Right-clicked on an <img> — use its bounds directly, no overlay needed
    if (lastMouseTarget && lastMouseTarget.tagName === "IMG") {
      var img = lastMouseTarget;
      var imgBounds = img.getBoundingClientRect();
      var rect = {
        x: imgBounds.left, y: imgBounds.top,
        width: imgBounds.width, height: imgBounds.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        left: imgBounds.left, top: imgBounds.top,
        bottom: imgBounds.top + imgBounds.height,
        right: imgBounds.left + imgBounds.width
      };
      await handleImageMode(rect, img);
      return true;
    }

    if (lastMouseTarget && lastMouseTarget.tagName === "CANVAS") {
      var cvsBounds = lastMouseTarget.getBoundingClientRect();
      var rect = {
        x: cvsBounds.left, y: cvsBounds.top,
        width: cvsBounds.width, height: cvsBounds.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        left: cvsBounds.left, top: cvsBounds.top,
        bottom: cvsBounds.top + cvsBounds.height,
        right: cvsBounds.left + cvsBounds.width
      };
      await handleImageMode(rect, lastMouseTarget);
      return true;
    }

    if (shouldUseBoxSelect()) {
      const boxRect = await startBoxSelection();
      if (!boxRect) return false;
      await handleImageMode(boxRect);
      return true;
    }

    return false;
  } catch (err) {
    showErrorPopup({ left: lastMouseX || 0, top: lastMouseY || 0 }, `Error: ${err.message}`);
    return false;
  }
}

function isPdfDocument() {
  var path = (window.location.pathname || "").toLowerCase();
  if (path.includes(".pdf")) return true;
  if (/\.pdf($|\?)/i.test(window.location.href || "")) return true;
  if (document.querySelector('embed[type="application/pdf"], object[type="application/pdf"], iframe[type="application/pdf"]')) {
    return true;
  }
  if (document.querySelector("#viewer.pdfViewer, .pdfViewer, #viewerContainer")) return true;
  return false;
}

function formatResultText(response) {
  if (!response) return "No response.";
  if (response.explanation) return response.explanation;
  if (response.type === "dictionary" && response.meanings && response.meanings.length) {
    return response.word + ": " + response.meanings
      .map(function (m) {
        return (m.partOfSpeech ? m.partOfSpeech + ": " : "") + m.definition;
      })
      .join(" | ");
  }
  return "No response.";
}

async function explainViaScreenshot() {
  var anchorX = lastMouseX || window.innerWidth / 2;
  var anchorY = lastMouseY || 80;
  var anchorRect = {
    left: anchorX, top: anchorY,
    bottom: anchorY + 20, right: anchorX + 200
  };

  createPopup(anchorRect);
  appendToThread("ai", "Thinking...");

  try {
    var response = await chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });
    var text = (response && response.explanation) || "Could not capture this page.";
    var bubbles = document.querySelectorAll(".readai-ai-bubble");
    if (bubbles.length) {
      bubbles[bubbles.length - 1].textContent = text;
    } else {
      appendToThread("ai", text);
    }
    isImageMode = true;
    conversationHistory = [
      { role: "user", content: "Please explain what's shown in this image." },
      { role: "assistant", content: text }
    ];
    return true;
  } catch (e) {
    var bubbles = document.querySelectorAll(".readai-ai-bubble");
    var msg = "Failed to capture page: " + (e && e.message ? e.message : "unknown error");
    if (bubbles.length) bubbles[bubbles.length - 1].textContent = msg;
    else appendToThread("ai", msg);
    return true;
  }
}

async function handleImageMode(rect, imgElement) {
  isImageMode = true;
  conversationHistory = [];

  var payload;
  if (imgElement && imgElement.tagName === "IMG") {
    var src = imgElement.currentSrc || imgElement.src || "";
    if (src && src.startsWith("http")) {
      payload = { imageUrl: src, history: [] };
    } else {
      var imageData = imageFromImgElement(imgElement);
      if (!imageData) {
        imageData = await captureRegionWithHtml2canvas(rect);
      }
      payload = imageData
        ? { imageData: imageData, history: [] }
        : { rect: rect, history: [] };
    }
  } else {
    var imageData = await captureImageRegion(rect);
    payload = imageData
      ? { imageData: imageData, history: [] }
      : { rect: rect, history: [] };
  }

  console.log("[CONTENT] handleImageMode: payload type:", payload.imageUrl ? "imageUrl" : payload.imageData ? "imageData" : "rect");

  console.log("[CONTENT] handleImageMode: sending GET_IMAGE_EXPLANATION");
  var response = await sendMessageToBackground("GET_IMAGE_EXPLANATION", payload);

  if (!response || response.type === "error") {
    if (rect) showErrorPopup(rect, response?.explanation || "Could not reach the background script.");
    return;
  }

  createPopup(rect);
  appendToThread("ai", response.explanation);

  var storedUrl = payload.imageUrl || payload.imageData || response.imageData;
  conversationHistory.push(
    {
      role: "user",
      content: [
        { type: "text", text: "Please explain what's shown in this image." },
        { type: "image_url", image_url: { url: storedUrl } }
      ]
    },
    { role: "assistant", content: response.explanation }
  );
}

function imageFromImgElement(img) {
  try {
    var c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.9);
  } catch (e) {
    return null;
  }
}


function shouldUseBoxSelect() {
  var path = window.location.pathname.toLowerCase();
  if (path.includes(".pdf")) return true;

  if (document.querySelector('embed[type="application/pdf"], iframe[type="application/pdf"]')) {
    return true;
  }

  var canvases = document.querySelectorAll("canvas");
  for (var i = 0; i < canvases.length; i++) {
    var c = canvases[i];
    if (c.offsetWidth > window.innerWidth * 0.5 && c.offsetHeight > window.innerHeight * 0.5) {
      return true;
    }
  }

  if (lastMouseTarget) {
    var tag = lastMouseTarget.tagName;
    if (tag === "IMG" || tag === "CANVAS") return true;
  }

  return false;
}

async function captureImageRegion(rect) {
  var isPdf = window.location.pathname.toLowerCase().includes(".pdf") ||
              document.querySelector('embed[type="application/pdf"]');
  if (isPdf) return null;

  var target = lastMouseTarget;
  if (target && target.tagName === "CANVAS") {
    var cr = target.getBoundingClientRect();
    var x = Math.round(rect.x - cr.left);
    var y = Math.round(rect.y - cr.top);
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (x >= 0 && y >= 0 && w > 0 && h > 0) {
      var ctx = target.getContext("2d");
      if (ctx) {
        var out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        out.getContext("2d").putImageData(ctx.getImageData(x, y, w, h), 0, 0);
        return out.toDataURL("image/jpeg", 0.9);
      }
    }
  }
  return captureRegionWithHtml2canvas(rect);
}

async function captureRegionWithHtml2canvas(rect) {
  try {
    const canvas = await html2canvas(document.documentElement, {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      scale: window.devicePixelRatio || 1,
      useCORS: true,
      logging: false
    });
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch (e) {
    console.error("ReadAI: html2canvas failed", e);
    return null;
  }
}

function appendToThread(role, text) {
  const thread = document.getElementById("readai-thread");
  if (!thread) return;

  const bubble = document.createElement("div");
  bubble.className = role === "user" ? "readai-user-bubble" : "readai-ai-bubble";
  bubble.textContent = text;

  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

function showResultInPopup(explanation, rect) {
  var anchor = rect || {
    left: lastMouseX || window.innerWidth / 2,
    top: lastMouseY || 80,
    bottom: (lastMouseY || 80) + 20,
    right: (lastMouseX || window.innerWidth / 2) + 200
  };
  createPopup(anchor);
  appendToThread("ai", explanation || "No response.");
}

async function handleFollowUp(question, rect) {
  const input = document.getElementById("readai-input");

  appendToThread("user", question);
  appendToThread("ai", "Thinking...");
  input.value = "";

  conversationHistory.push({ role: "user", content: question });

  const messageType = isImageMode ? "GET_IMAGE_EXPLANATION" : "GET_EXPLANATION";
  const response = await sendMessageToBackground(messageType, { history: conversationHistory });

  const bubbles = document.querySelectorAll(".readai-ai-bubble");
  if (!response) {
    bubbles[bubbles.length - 1].textContent = "Could not reach the background script.";
    return;
  }
  bubbles[bubbles.length - 1].textContent = response.explanation;

  conversationHistory.push({ role: "assistant", content: response.explanation });

  const popup = document.getElementById("readai-popup");
  if (popup) positionPopup(popup, rect);
}


function createDictionaryPopup(rect, data) {
  removePopup();

  const popup = document.createElement("div");
  popup.id = "readai-popup";
  popup.classList.add("readai-dict-mode");
  popup.style.visibility = "hidden";
  popup.style.left = `${Math.min(window.scrollX + rect.left, window.innerWidth - 340)}px`;
  popup.style.top = "0px";

  const meaningsHTML = data.meanings.map(m => `
    <div class="readai-dict-meaning">
      ${m.partOfSpeech ? `<span class="readai-dict-pos">${m.partOfSpeech}</span>` : ""}
      <p class="readai-dict-def">${m.definition}</p>
      ${m.example ? `<p class="readai-dict-example"><em>e.g.</em> ${m.example}</p>` : ""}
    </div>
  `).join("");

  popup.innerHTML = `
    <button id="readai-close">\u2715</button>
    <div class="readai-dict-word">${data.word}</div>
    ${data.phonetic ? `<div class="readai-dict-phonetic">${data.phonetic}</div>` : ""}
    <div class="readai-dict-meanings">${meaningsHTML}</div>
  `;

  document.body.appendChild(popup);
  positionPopup(popup, rect);

  document.getElementById("readai-close").addEventListener("click", removePopup);

  popup.style.visibility = "visible";
}
