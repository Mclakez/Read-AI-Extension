const thread = document.getElementById("thread");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

let conversationHistory = [];
let isImageMode = false;

function appendBubble(role, text) {
  const bubble = document.createElement("div");
  bubble.className = role === "user" ? "user-bubble" : "ai-bubble";
  bubble.textContent = text;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

function showExplanation(text, opts) {
  opts = opts || {};
  thread.innerHTML = "";
  conversationHistory = [];
  isImageMode = !!opts.imageMode;
  appendBubble("ai", text || "No response.");

  if (opts.imageMode && opts.imageData) {
    conversationHistory = [
      {
        role: "user",
        content: [
          { type: "text", text: "Please explain what's shown in this image." },
          { type: "image_url", image_url: { url: opts.imageData } }
        ]
      },
      { role: "assistant", content: text || "" }
    ];
  } else if (opts.imageMode) {
    conversationHistory = [
      { role: "user", content: "Please explain what's shown in this image." },
      { role: "assistant", content: text || "" }
    ];
  } else {
    conversationHistory = [
      { role: "user", content: "Explain the selected text." },
      { role: "assistant", content: text || "" }
    ];
  }
}

async function loadPending() {
  const stored = await chrome.storage.local.get([
    "readaiPendingResult",
    "readaiPendingImageMode",
    "readaiPendingImageData"
  ]);
  if (stored.readaiPendingResult) {
    showExplanation(stored.readaiPendingResult, {
      imageMode: !!stored.readaiPendingImageMode,
      imageData: stored.readaiPendingImageData || null
    });
    await chrome.storage.local.remove([
      "readaiPendingResult",
      "readaiPendingImageMode",
      "readaiPendingImageData"
    ]);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_RESULT") {
    showExplanation(message.explanation, {
      imageMode: !!message.imageMode,
      imageData: message.imageData || null
    });
  }
});

async function handleFollowUp() {
  const question = input.value.trim();
  if (!question) return;

  appendBubble("user", question);
  const thinking = appendBubble("ai", "Thinking...");
  input.value = "";

  conversationHistory.push({ role: "user", content: question });

  try {
    const result = await chrome.runtime.sendMessage({
      type: "FOLLOW_UP",
      history: conversationHistory,
      imageMode: isImageMode
    });
    const text = (result && result.explanation) || "Something went wrong. Please try again.";
    thinking.textContent = text;
    conversationHistory.push({ role: "assistant", content: text });
  } catch (e) {
    thinking.textContent = "Could not reach the background script.";
  }
}

sendBtn.addEventListener("click", handleFollowUp);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleFollowUp();
});

loadPending();
