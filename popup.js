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

  // 1. Try content script (text selection, images on regular pages)
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
      if (result && result.explanation) {
        await injectNotification(tabs[0].id, result.explanation);
        window.close();
        return;
      }
    } catch (e) {}
  }

  // 3. Fallback: capture visible tab as image
  try {
    var result = await chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" });
    if (result && result.explanation) {
      await injectNotification(tabs[0].id, result.explanation);
      window.close();
      return;
    }
  } catch (e) {}

  status.textContent = "Could not explain this page.";
});

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

async function injectNotification(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (msg) => {
      var d = document.createElement("div");
      d.textContent = msg;
      d.style.cssText = "position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:8px;z-index:99999;max-width:400px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 15000);
    },
    args: [message]
  });
}
