chrome.runtime.onInstalled.addListener(() => {
  console.log("ReadAI installed — initializing dictionary...");
  getDatabase();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "explain-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { type: "EXPLAIN" });
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_EXPLANATION") {
    handleExplanationRequest(message.payload)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({
        type: "ai",
        explanation: "Something went wrong. Please try again."
      }));

    return true;
  }
});

async function handleExplanationRequest(payload) {
  let isOnline = true;
  try {
    const test = await fetch("https://api.groq.com", { method: "HEAD" });
    isOnline = true;
  } catch {
    isOnline = false;
  }
  const wordCount = payload.selectedText?.trim().split(/\s+/).length ?? 0;

  // Single word — use dictionary
  if (wordCount === 1) {
    return getDictionaryDefinition(payload.selectedText.trim());
  }

  // Multiple words but offline — tell the user
  if (!isOnline) {
    return {
      type: "ai",
      explanation: "You're offline. Highlight a single word to get an offline definition."
    };
  }

  // Multiple words and online — use AI
  return getAIExplanation(payload);
}

async function getAIExplanation({ selectedText, context, history }) {
  // Read key from storage instead of hardcoding
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
  // First try the free online dictionary
  // This still works on most connections even when Groq is down
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
    // Network failed completely — fall through to local
    console.log("Dictionary API unavailable, using local fallback");
  }

  // True offline fallback — common English words
  return getLocalDefinition(word);
}

function formatDictionaryEntry(entry, word) {
  if (!entry || !entry.meanings || entry.meanings.length === 0) {
    return { explanation: `No definition found for "${word}".` };
  }

  // Build a clean explanation from the entry
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
  const url = "https://raw.githubusercontent.com/Mclakez/readai-assets/refs/heads/main/dictionary.json";
  const response = await fetch(url);
  const data = await response.json();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("words", "readwrite");
    const store = tx.objectStore("words");

    // data is an object like { "word": "definition", ... }
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