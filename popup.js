const input = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const status = document.getElementById("status");

// Load existing key when popup opens
chrome.storage.local.get("groqApiKey", (result) => {
  if (result.groqApiKey) {
    input.value = result.groqApiKey;
    status.textContent = "✓ Key saved";
  }
});

// Save key when button clicked
saveBtn.addEventListener("click", () => {
  const key = input.value.trim();

  if (!key) {
    status.textContent = "Please enter a key first";
    return;
  }

  chrome.storage.local.set({ groqApiKey: key }, () => {
    status.textContent = "✓ Key saved successfully";
  });
});