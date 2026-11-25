const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("delshivHost", {
  loginWithGoogle: () => ipcRenderer.invoke("google-login"),
  getCurrentUser: () => ipcRenderer.invoke("get-current-user"),
  logout: () => ipcRenderer.invoke("logout"),
  getApiKey: () => ipcRenderer.invoke("delshiv:get-api-key"),
  getSettings: () => ipcRenderer.invoke("delshiv:get-settings"),
  saveSettings: (opts = {}) => ipcRenderer.invoke("delshiv:save-settings", opts),
  getAutoStart: () => ipcRenderer.invoke("delshiv:get-auto-start"),
  fetchLiveNews: (opts = {}) => ipcRenderer.invoke("delshiv:fetch-live-news", opts),
  executeTool: (payload = {}) => ipcRenderer.invoke("delshiv:execute-tool", payload),
  runCommand: (opts = {}) => ipcRenderer.invoke("delshiv:run-command", opts),
  readFile: (opts = {}) => ipcRenderer.invoke("delshiv:read-file", opts),
  writeFile: (opts = {}) => ipcRenderer.invoke("delshiv:write-file", opts),
  editFile: (opts = {}) => ipcRenderer.invoke("delshiv:edit-file", opts),
  globFiles: (opts = {}) => ipcRenderer.invoke("delshiv:glob-files", opts),
  webSearch: (opts = {}) => ipcRenderer.invoke("delshiv:web-search", opts),
  openUrl: (opts = {}) => ipcRenderer.invoke("delshiv:open-url", opts),
  manageNotes: (opts = {}) => ipcRenderer.invoke("delshiv:manage-notes", opts),
  manageTasks: (opts = {}) => ipcRenderer.invoke("delshiv:manage-tasks", opts),
  getTavilyKeyStatus: () => ipcRenderer.invoke("delshiv:get-tavily-key-status"),
  saveTavilyKey: (key) => ipcRenderer.invoke("delshiv:save-tavily-key", key),
  fetchPage: (opts = {}) => ipcRenderer.invoke("delshiv:fetch-page", opts),
  youtubeTranscript: (opts = {}) => ipcRenderer.invoke("delshiv:youtube-transcript", opts),
  saveApiKey: (key) => ipcRenderer.invoke("delshiv:save-api-key", key),
  setAutoStart: (enabled) => ipcRenderer.invoke("delshiv:set-auto-start", enabled),
  getErrorLogs: () => ipcRenderer.invoke("delshiv:get-error-logs"),
  clearErrorLogs: () => ipcRenderer.invoke("delshiv:clear-error-logs"),
  logError: (payload = {}) => ipcRenderer.invoke("delshiv:log-error", payload),
  onErrorLog: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on("delshiv:error-log", handler);
    return () => ipcRenderer.removeListener("delshiv:error-log", handler);
  },
  behaviorRecord: (opts = {}) => ipcRenderer.invoke("delshiv:behavior-record", opts),
  behaviorSummary: () => ipcRenderer.invoke("delshiv:behavior-summary"),
  behaviorReset: () => ipcRenderer.invoke("delshiv:behavior-reset"),
  queueAdd: (opts = {}) => ipcRenderer.invoke("delshiv:queue-add", opts),
  queueList: () => ipcRenderer.invoke("delshiv:queue-list"),
  queueRemove: (id) => ipcRenderer.invoke("delshiv:queue-remove", { id }),
  generateReport: (opts = {}) => ipcRenderer.invoke("delshiv:generate-report", opts),
  organizeFiles: (opts = {}) => ipcRenderer.invoke("delshiv:organize-files", opts),
  memory: (opts = {}) => ipcRenderer.invoke("delshiv:memory", opts),
  queryDocument: (opts = {}) => ipcRenderer.invoke("delshiv:query-document", opts),
  manageWindows: (opts = {}) => ipcRenderer.invoke("delshiv:manage-windows", opts),
  automateInput: (opts = {}) => ipcRenderer.invoke("delshiv:automate-input", opts),
  memoryAutoExtract: (opts = {}) => ipcRenderer.invoke("delshiv:memory-auto-extract", opts),
  chatSearch: (opts = {}) => ipcRenderer.invoke("delshiv:chat-search", opts),
  memoryRetrieve: (opts = {}) => ipcRenderer.invoke("delshiv:memory-retrieve", opts),
  memoryFacts: (opts = {}) => ipcRenderer.invoke("delshiv:memory-facts", opts),
  memoryUpdateFact: (opts = {}) => ipcRenderer.invoke("delshiv:memory-update-fact", opts),
  memoryDeleteFact: (opts = {}) => ipcRenderer.invoke("delshiv:memory-delete-fact", opts),
  onOpenMemoryViewer: (cb) => {
    if (typeof cb !== "function") return () => {};
    const h = () => cb();
    ipcRenderer.on("delshiv:open-memory-viewer", h);
    return () => ipcRenderer.removeListener("delshiv:open-memory-viewer", h);
  },
  memoryDbSaveMsg: (opts = {}) => ipcRenderer.invoke("delshiv:memory-db-save-msg", opts),
  memoryDbBootstrap: (opts = {}) => ipcRenderer.invoke("delshiv:memory-db-bootstrap", opts),
  memoryDbSummarize: (opts = {}) => ipcRenderer.invoke("delshiv:memory-db-summarize", opts),
  getPcKnowledge: (opts = {}) => ipcRenderer.invoke("delshiv:pc-knowledge", opts),
  understandCommand: (opts = {}) => ipcRenderer.invoke("delshiv:understand-command", opts),
  readWebPage: (opts = {}) => ipcRenderer.invoke("delshiv:read-web-page", opts),
  clipboardHistory: (opts = {}) => ipcRenderer.invoke("delshiv:clipboard-history", opts),
  focusMode: (opts = {}) => ipcRenderer.invoke("delshiv:focus-mode", opts),
  mediaControl: (opts = {}) => ipcRenderer.invoke("delshiv:media-control", opts),
  pinLock: (opts = {}) => ipcRenderer.invoke("delshiv:pin-lock", opts),
  managePlugins: (opts = {}) => ipcRenderer.invoke("delshiv:manage-plugins", opts),
  cleanJunk: (opts = {}) => ipcRenderer.invoke("delshiv:clean-junk", opts),
  readGmail: (opts = {}) => ipcRenderer.invoke("delshiv:read-gmail", opts),
  openFile: (opts = {}) => ipcRenderer.invoke("delshiv:open-file", opts),
  smartExecute: (opts = {}) => ipcRenderer.invoke("delshiv:smart-execute", opts),
  systemHealth: (opts = {}) => ipcRenderer.invoke("delshiv:system-health", opts),
  networkTools: (opts = {}) => ipcRenderer.invoke("delshiv:network-tools", opts),
  ruleEngine: (opts = {}) => ipcRenderer.invoke("delshiv:rule-engine", opts),
  extractTextFromImage: (opts = {}) => ipcRenderer.invoke("delshiv:extract-text-ocr", opts),
  ollamaStatus: () => ipcRenderer.invoke("delshiv:ollama-status"),
  ollamaChat: (opts = {}) => ipcRenderer.invoke("delshiv:ollama-chat", opts),
  onRuleFired: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("delshiv:rule-fired", handler);
    return () => ipcRenderer.removeListener("delshiv:rule-fired", handler);
  },
  quickbarRun: (text) => ipcRenderer.invoke("delshiv:quickbar-run", String(text || "")),
  quickbarHide: () => ipcRenderer.invoke("delshiv:quickbar-hide"),
  quickbarResize: (height) => ipcRenderer.invoke("delshiv:quickbar-resize", Number(height)),
  scheduleTask: (opts = {}) => ipcRenderer.invoke("delshiv:schedule-task", opts),
  onScheduledTaskFired: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("delshiv:scheduler-fired", handler);
    return () => ipcRenderer.removeListener("delshiv:scheduler-fired", handler);
  },
  analyzeClipboard: (opts = {}) => ipcRenderer.invoke("delshiv:analyze-clipboard", opts),
  setClipboardWatch: (enabled) => ipcRenderer.invoke("delshiv:set-clipboard-watch", Boolean(enabled)),
  onClipboardAnalysis: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("delshiv:clipboard-analysis", handler);
    return () => ipcRenderer.removeListener("delshiv:clipboard-analysis", handler);
  },
  copyText: (text) => ipcRenderer.invoke("delshiv:copy-text", String(text || "")),
  onTriggerVoice: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = () => callback();
    ipcRenderer.on("delshiv:trigger-voice-listening", handler);
    return () => ipcRenderer.removeListener("delshiv:trigger-voice-listening", handler);
  },
});
