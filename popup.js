const explainBtn = document.getElementById("explain-btn");
const input = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const status = document.getElementById("status");

chrome.storage.local.get("groqApiKey", (result) => {
  if (result.groqApiKey) {
    input.value = result.groqApiKey;
    status.textContent = "\u2713 Key saved";
  }
});

saveBtn.addEventListener("click", () => {
  const key = input.value.trim();
  if (!key) {
    status.textContent = "Please enter a key first";
    return;
  }
  chrome.storage.local.set({ groqApiKey: key }, () => {
    status.textContent = "\u2713 Key saved";
  });
});

explainBtn.addEventListener("click", async () => {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return;

  if (!input.value.trim()) {
    status.textContent = "Enter your API key first";
    return;
  }

  // 1. Try content script (text selection, images, PDF screenshot)
  try {
    var response = await chrome.tabs.sendMessage(tabs[0].id, { type: "EXPLAIN" });
    if (response && response.handled) {
      window.close();
      return;
    }
  } catch (e) {}

  // 2. Try injected script to read selection (works on directly-opened PDFs)
  var text = await getSelectedText(tabs[0].id);
  if (text) {
    try {
      var result = await chrome.runtime.sendMessage({ type: "EXPLAIN_CLIPBOARD", text: text });
      var notifText = formatExplanation(result);
      if (notifText) {
        await showInChat(tabs[0].id, notifText, false);
        window.close();
        return;
      }
    } catch (e) {}
  }

  // 3. Fallback: capture visible tab as image
  try {
    var result = await chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });
    if (result && result.explanation) {
      await showInChat(tabs[0].id, result.explanation, true, result.imageData || null);
      window.close();
      return;
    }
  } catch (e) {}

  status.textContent = "Could not explain this page.";
});

function formatExplanation(explanation) {
  if (!explanation) return null;
  if (explanation.explanation) return explanation.explanation;
  if (explanation.type === "dictionary" && explanation.meanings && explanation.meanings.length) {
    return explanation.word + ": " + explanation.meanings
      .map(function (m) {
        return (m.partOfSpeech ? m.partOfSpeech + ": " : "") + m.definition;
      })
      .join(" | ");
  }
  return null;
}

async function getSelectedText(tabId) {
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        var sel = window.getSelection();
        return sel ? sel.toString().trim() : "";
      }
    });
    return results?.[0]?.result || "";
  } catch {
    return "";
  }
}

async function showInChat(tabId, message, imageMode, imageData) {
  try {
    var resp = await chrome.runtime.sendMessage({
      type: "SHOW_RESULT_IN_TAB",
      tabId: tabId,
      explanation: message,
      imageMode: !!imageMode,
      imageData: imageData || null
    });
    if (resp && resp.ok) return;
  } catch (e) {}
}
