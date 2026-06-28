console.log("ReadAI content script loaded");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXPLAIN") {
    handleExplain();
  }
});



function getSelectionData() {
  const selection = window.getSelection();

  // No text selected, nothing to do
  if (!selection || selection.toString().trim() === "") {
    return null;
  }

  const selectedText = selection.toString().trim();

  // Walk up the DOM to find the paragraph wrapping the selection
  const anchorNode = selection.anchorNode;
  const paragraph = anchorNode?.parentElement?.closest("p, li, blockquote, td, div") ;

  const context = paragraph ? paragraph.innerText.trim() : "";

  // Get position of the selection to place the popup
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  return { selectedText, context, rect };
}


function createPopup(rect) {
  removePopup();

  const popup = document.createElement("div");
  popup.id = "readai-popup";

  // Don't position yet — add to DOM first so we can measure it
  popup.style.visibility = "hidden";
  popup.style.left = `${Math.min(window.scrollX + rect.left, window.innerWidth - 340)}px`;
  popup.style.top = "0px"; // temporary

  const closeBtn = document.createElement("button");
  closeBtn.id = "readai-close";
  closeBtn.textContent = "✕";
  
  const thread = document.createElement("div");
  thread.id = "readai-thread";
  
  const followup = document.createElement("div");
  followup.id = "readai-followup";
  
  const input = document.createElement("input");
  input.id = "readai-input";
  input.type = "text";
  input.placeholder = "Ask a follow-up...";
  
  const sendBtn = document.createElement("button");
  sendBtn.id = "readai-send";
  sendBtn.textContent = "→";
  
  followup.appendChild(input);
  followup.appendChild(sendBtn);
  
  popup.appendChild(closeBtn);
  popup.appendChild(thread);
  popup.appendChild(followup);

  document.body.appendChild(popup);

  // Now measure and position correctly
  positionPopup(popup, rect);

  // Close button
  document.getElementById("readai-close").addEventListener("click", removePopup);

  document.getElementById("readai-send").addEventListener("click", () => {
    const question = document.getElementById("readai-input").value.trim();
    if (question) handleFollowUp(question, rect);
  });

  document.getElementById("readai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const question = document.getElementById("readai-input").value.trim();
      if (question) handleFollowUp(question, rect);
    }
  });

  popup.style.visibility = "visible";
  return popup;
}

function positionPopup(popup, rect) {
  const popupHeight = popup.offsetHeight;
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  const showBelow = spaceAbove < popupHeight + 12 && spaceBelow > spaceAbove;

  const top = showBelow
    ? window.scrollY + rect.bottom + 12
    : window.scrollY + rect.top - popupHeight - 12;

  popup.style.top = `${top}px`;
}

function removePopup() {
  const existing = document.getElementById("readai-popup");
  if (existing) existing.remove();
}





let conversationHistory = [];

async function handleExplain() {
  const data = getSelectionData();
  if (!data) return;

  const { selectedText, context, rect } = data;
  conversationHistory = [];

  const response = await chrome.runtime.sendMessage({
    type: "GET_EXPLANATION",
    payload: { selectedText, context, history: conversationHistory }
  });

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
}

function appendToThread(role, text) {
  const thread = document.getElementById("readai-thread");
  const bubble = document.createElement("div");
  bubble.className = role === "user" ? "readai-user-bubble" : "readai-ai-bubble";
  bubble.textContent = text;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

async function handleFollowUp(question, rect) {
  const input = document.getElementById("readai-input");

  appendToThread("user", question);
  appendToThread("ai", "Thinking...");
  input.value = "";

  conversationHistory.push({ role: "user", content: question });

  const response = await chrome.runtime.sendMessage({
    type: "GET_EXPLANATION",
    payload: { history: conversationHistory }
  });

  const bubbles = document.querySelectorAll(".readai-ai-bubble");
  bubbles[bubbles.length - 1].textContent = response.explanation;

  conversationHistory.push({ role: "assistant", content: response.explanation });

  // Reposition now that popup has grown
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

  const closeBtn = document.createElement("button");
  closeBtn.id = "readai-close";
  closeBtn.textContent = "✕";
  
  const wordEl = document.createElement("div");
  wordEl.className = "readai-dict-word";
  wordEl.textContent = data.word;
  
  const meaningsEl = document.createElement("div");
  meaningsEl.className = "readai-dict-meanings";
  
  data.meanings.forEach(m => {
    const meaning = document.createElement("div");
    meaning.className = "readai-dict-meaning";
  
    if (m.partOfSpeech) {
      const pos = document.createElement("span");
      pos.className = "readai-dict-pos";
      pos.textContent = m.partOfSpeech;
      meaning.appendChild(pos);
    }
  
    const def = document.createElement("p");
    def.className = "readai-dict-def";
    def.textContent = m.definition;
    meaning.appendChild(def);
  
    if (m.example) {
      const ex = document.createElement("p");
      ex.className = "readai-dict-example";
      ex.textContent = `"${m.example}"`;
      meaning.appendChild(ex);
    }
  
    meaningsEl.appendChild(meaning);
  });
  
  popup.appendChild(closeBtn);
  popup.appendChild(wordEl);
  
  if (data.phonetic) {
    const phonetic = document.createElement("div");
    phonetic.className = "readai-dict-phonetic";
    phonetic.textContent = data.phonetic;
    popup.appendChild(phonetic);
  }
  
  popup.appendChild(meaningsEl);

  document.body.appendChild(popup);
  positionPopup(popup, rect);

  document.getElementById("readai-close").addEventListener("click", removePopup);

  popup.style.visibility = "visible";
}