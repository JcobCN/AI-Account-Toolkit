importScripts('data/names.js', 'lib/mail-polling.js', 'lib/step-waiters.js');

const LOG_PREFIX = '[AutoRegister:bg]';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const MAIL_2925_URL = 'https://www.2925.com/#/mailList';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const QQ_MAIL_URL = 'https://wx.mail.qq.com/';
const MAIL_163_URL = 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D';
const HUMAN_STEP_DELAY_MIN = 400;
const HUMAN_STEP_DELAY_MAX = 900;
const STEP_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PERSISTED_SETTINGS_KEY = 'persistentSettings';
const PERSISTED_SETTING_FIELDS = [
  'vpsUrl',
  'mailProvider',
  'mainEmail',
  'ddgMailboxProvider',
  'customPassword',
  'oauthUrl',
  'runCount',
];
const SIGNUP_SENDER_FILTERS = ['openai', 'noreply', 'chatgpt', 'auth'];
const SIGNUP_SUBJECT_FILTERS = ['verify', 'verification', 'code', '验证码', 'confirm'];
const LOGIN_SENDER_FILTERS = ['openai', 'noreply', 'chatgpt', 'auth'];
const LOGIN_SUBJECT_FILTERS = ['verify', 'verification', 'code', '验证码', 'confirm', 'login', 'signin', 'sign in'];
const DDG_SIGNUP_SENDER_FILTERS = ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'];
const DDG_SIGNUP_SUBJECT_FILTERS = ['verify', 'verification', 'code', '验证', 'confirm'];
const DDG_LOGIN_SENDER_FILTERS = ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'];
const DDG_LOGIN_SUBJECT_FILTERS = ['verify', 'verification', 'code', '验证', 'confirm', 'login'];
const RECENT_USED_VERIFICATION_CODE_LIMIT = 3;
const STEP_TIMEOUTS = {
  3: 180000,
  7: 180000,
  8: 180000,
};
const STEP_DELAY_AFTER = {
  1: 1800,
  2: 2500,
  3: 2000,
  4: 3000,
  5: 1200,
  6: 2000,
  7: 2000,
  8: 1000,
};
const STEP8_SURFACE_READY_TIMEOUT = 30000;
const STEP8_SURFACE_READY_POLL_INTERVAL = 500;
const STEP_VERIFICATION_RETRY_LIMIT = 5;
const STEP_VERIFICATION_READY_TIMEOUT = 120000;
const OPENAI_STORAGE_ORIGINS = [
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://accounts.openai.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
];
const CLOSABLE_TAB_SOURCES = ['signup-page', 'vps-panel'];

const DEFAULT_STATE = {
  currentStep: 0,
  currentRunIndex: 0,
  stepStatuses: createDefaultStepStatuses(),
  flowStartTime: null,
  lastEmailTimestamp: null,
  localhostUrl: '',
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  mailProvider: '2925',
  mainEmail: '',
  ddgMailboxProvider: 'qq',
  email: '',
  password: '',
  customPassword: '',
  oauthUrl: '',
  runCount: 1,
  runSuccessCount: 0,
  runFailureCount: 0,
  recentUsedVerificationCodes: [],
  runState: 'idle',
  manualContinueVisible: false,
  manualResumeFromStep: null,
  lastManualStep: null,
  resumeAfterManual: false,
};

const pendingCommands = new Map();
const stepWaiterRegistry = createStepWaiterRegistry();
let stopRequested = false;
let runLoopActive = false;
let manualExecutionActive = false;
let activeRunPromise = null;
let webNavListener = null;
let step8TabUpdatedListener = null;
let step8TabRemovedListener = null;
let mail163Waiter = null;
let persistentStateReadyPromise = null;

initializeSessionStorageAccess();
void ensurePersistentStateLoaded();
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error(LOG_PREFIX, 'Handler error:', error);
      sendResponse({ error: error.message });
    });

  return true;
});

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session access:', error?.message || error);
  }
}

async function ensurePersistentStateLoaded() {
  if (!persistentStateReadyPromise) {
    persistentStateReadyPromise = hydratePersistentState();
  }
  return persistentStateReadyPromise;
}

async function hydratePersistentState() {
  try {
    const localData = await chrome.storage.local.get(PERSISTED_SETTINGS_KEY);
    const savedSettings = normalizeSettings(localData[PERSISTED_SETTINGS_KEY] || {});
    const current = await chrome.storage.session.get(PERSISTED_SETTING_FIELDS);
    const updates = {};

    for (const field of PERSISTED_SETTING_FIELDS) {
      if (
        (current[field] === undefined || current[field] === null)
        && Object.prototype.hasOwnProperty.call(savedSettings, field)
      ) {
        updates[field] = savedSettings[field];
      }
    }

    if (Object.keys(updates).length) {
      await chrome.storage.session.set(updates);
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to hydrate persistent state:', error?.message || error);
  }
}

async function persistLocalState(updates) {
  if (!updates || !Object.keys(updates).length) {
    return;
  }

  const settingsPatch = {};

  for (const field of PERSISTED_SETTING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      settingsPatch[field] = updates[field];
    }
  }

  if (!Object.keys(settingsPatch).length) {
    return;
  }

  const existing = await chrome.storage.local.get(PERSISTED_SETTINGS_KEY);
  await chrome.storage.local.set({
    [PERSISTED_SETTINGS_KEY]: {
      ...(existing[PERSISTED_SETTINGS_KEY] || {}),
      ...settingsPatch,
    },
  });
}

async function handleMessage(message, sender) {
  await ensurePersistentStateLoaded();

  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
      }
      return { ok: true };
    }

    case 'LOG': {
      const payload = message.payload || {};
      await addLog(`[${message.source}] ${payload.message || ''}`, payload.level || 'info');
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }

      await setStepStatus(message.step, 'completed');
      await handleStepData(message.step, message.payload || {});
      await addLog(`Step ${message.step} completed`, 'ok');
      notifyStepComplete(message.step, message.payload || {});
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      }
      notifyStepError(message.step, message.error || 'Unknown step error');
      return { ok: true };
    }

    case 'GET_STATE':
      return getState();

    case 'SAVE_SETTINGS': {
      const payload = message.payload || {};
      const updates = normalizeSettings(payload);
      if (
        Object.prototype.hasOwnProperty.call(payload, 'mailProvider')
        || Object.prototype.hasOwnProperty.call(payload, 'mainEmail')
        || Object.prototype.hasOwnProperty.call(payload, 'ddgMailboxProvider')
      ) {
        updates.email = '';
        updates.lastEmailTimestamp = null;
      }
      await setState(updates);
      return { ok: true };
    }

    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const email = await fetchDuckEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'TOGGLE_RUN': {
      const state = await getState();
      if (state.runState === 'running' || runLoopActive || manualExecutionActive) {
        await requestStop({ clearManualContinuation: false });
        if (activeRunPromise) {
          await activeRunPromise.catch(() => {});
        }
        return { ok: true, runState: 'paused' };
      }

      validateStartConfig(state);
      void startRunLoop(state.runCount);
      return { ok: true, runState: 'running' };
    }

    case 'STOP_FLOW': {
      await requestStop({ clearManualContinuation: false });
      if (activeRunPromise) {
        await activeRunPromise.catch(() => {});
      }
      return { ok: true };
    }

    case 'MANUAL_RUN_STEP': {
      const step = Number(message.payload?.step);
      if (!STEP_IDS.includes(step)) {
        throw new Error(`Unknown step: ${step}`);
      }

      await runManualStep(step);
      return { ok: true };
    }

    case 'CONTINUE_FROM_MANUAL': {
      await continueFromManual();
      return { ok: true };
    }

    case 'REFRESH_RUNTIME': {
      if (runLoopActive || manualExecutionActive || (await getState()).runState === 'running') {
        await requestStop({ clearManualContinuation: true });
        if (activeRunPromise) {
          await activeRunPromise.catch(() => {});
        }
      }

      clearStopRequest();
      cleanupStep8Listeners();
      await chrome.storage.session.remove(['step3RetryPending', 'step3Email', 'step3Password', 'seen2925Codes', 'seenCodes', 'mail163PollState']);
      const state = await getState();
      await setState({
        currentStep: 0,
        currentRunIndex: 0,
        stepStatuses: createDefaultStepStatuses(),
        flowStartTime: null,
        lastEmailTimestamp: null,
        localhostUrl: '',
        email: '',
        password: '',
        oauthUrl: state.oauthUrl,
        runState: 'idle',
        runSuccessCount: 0,
        runFailureCount: 0,
        recentUsedVerificationCodes: [],
        manualContinueVisible: false,
        manualResumeFromStep: null,
        lastManualStep: null,
        resumeAfterManual: false,
      });
      await addLog('运行状态已刷新。', 'info');
      return { ok: true };
    }

    case 'CLEAR_LOGS':
      await chrome.storage.session.set({ logs: [] });
      broadcast('LOGS_CLEARED', {});
      return { ok: true };

    case 'MAIL163_RESULT': {
      if (mail163Waiter) {
        mail163Waiter.resolve(message.payload);
        mail163Waiter = null;
      }
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

function createDefaultStepStatuses() {
  return STEP_IDS.reduce((statuses, step) => {
    statuses[step] = 'pending';
    return statuses;
  }, {});
}

async function getState() {
  await ensurePersistentStateLoaded();
  const current = await chrome.storage.session.get(null);
  return {
    ...DEFAULT_STATE,
    ...current,
    stepStatuses: {
      ...createDefaultStepStatuses(),
      ...(current.stepStatuses || {}),
    },
    tabRegistry: current.tabRegistry || {},
    logs: Array.isArray(current.logs) ? current.logs : [],
    runCount: clampRunCount(current.runCount),
    runSuccessCount: clampRunCounter(current.runSuccessCount),
    runFailureCount: clampRunCounter(current.runFailureCount),
    recentUsedVerificationCodes: normalizeRecentVerificationCodes(current.recentUsedVerificationCodes),
    manualResumeFromStep: current.manualResumeFromStep == null ? null : Number(current.manualResumeFromStep),
  };
}

async function setState(updates) {
  if (!updates || !Object.keys(updates).length) {
    return;
  }

  const normalized = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalized, 'runCount')) {
    normalized.runCount = clampRunCount(normalized.runCount);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'runSuccessCount')) {
    normalized.runSuccessCount = clampRunCounter(normalized.runSuccessCount);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'runFailureCount')) {
    normalized.runFailureCount = clampRunCounter(normalized.runFailureCount);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'recentUsedVerificationCodes')) {
    normalized.recentUsedVerificationCodes = normalizeRecentVerificationCodes(normalized.recentUsedVerificationCodes);
  }

  await chrome.storage.session.set(normalized);
  await persistLocalState(normalized);
  broadcast('STATE_UPDATED', normalized);
}

async function addLog(message, level = 'info') {
  const state = await getState();
  const entry = { message, level, timestamp: Date.now() };
  const logs = [...state.logs, entry].slice(-500);
  await chrome.storage.session.set({ logs });
  broadcast('LOG_ENTRY', entry);
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

function broadcastDataUpdate(payload) {
  broadcast('DATA_UPDATED', payload);
}

async function handleStepData(step, payload) {
  if (step === 5 && payload.oauthUrl) {
    await setState({ oauthUrl: payload.oauthUrl });
    broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
  }
  if (step === 2 && payload.email) {
    await setState({ email: payload.email });
    broadcastDataUpdate({ email: payload.email });
  }
  if ((step === 3 || step === 7) && payload.emailTimestamp) {
    await setState({ lastEmailTimestamp: payload.emailTimestamp });
  }
  if (step === 8 && payload.localhostUrl) {
    await setState({ localhostUrl: payload.localhostUrl });
    broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
    await captureAuthPayloadFromLocalhost(payload.localhostUrl);
  }
}

async function captureAuthPayloadFromLocalhost(localhostUrl, timeoutMs = 12000) {
  if (!localhostUrl) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const authData = await tryExtractAuthPayloadFromLocalhostTabs(localhostUrl);
    if (authData) {
      await addLog('Step 8: Captured auth payload from localhost page.', 'ok');
      return authData;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await addLog('Step 8: Localhost page did not expose auth payload.', 'warn');
  return null;
}

async function tryExtractAuthPayloadFromLocalhostTabs(localhostUrl) {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs
    .filter((tab) => typeof tab.url === 'string' && tab.url.startsWith('http://localhost'))
    .sort((left, right) => {
      if (left.url === localhostUrl) return -1;
      if (right.url === localhostUrl) return 1;
      return (right.id || 0) - (left.id || 0);
    });

  for (const tab of candidates) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token', 'account_id'];

          const hasTokenKeys = (value) => TOKEN_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value || {}, key));

          const findTokenObject = (value, depth = 0) => {
            if (!value || depth > 4) return null;

            if (typeof value === 'string') {
              const trimmed = value.trim();
              if (!trimmed) return null;
              try {
                return findTokenObject(JSON.parse(trimmed), depth + 1);
              } catch {
                const match = trimmed.match(/\{[\s\S]*"access_token"[\s\S]*\}/);
                if (!match) return null;
                try {
                  return findTokenObject(JSON.parse(match[0]), depth + 1);
                } catch {
                  return null;
                }
              }
            }

            if (Array.isArray(value)) {
              for (const item of value) {
                const found = findTokenObject(item, depth + 1);
                if (found) return found;
              }
              return null;
            }

            if (typeof value === 'object') {
              if (hasTokenKeys(value)) {
                return value;
              }
              for (const nested of Object.values(value)) {
                const found = findTokenObject(nested, depth + 1);
                if (found) return found;
              }
            }

            return null;
          };

          const textCandidates = [];
          const seenTexts = new Set();
          const pushText = (value) => {
            const text = String(value || '').trim();
            if (!text || seenTexts.has(text)) return;
            seenTexts.add(text);
            textCandidates.push(text);
          };

          pushText(document.body?.innerText || '');
          pushText(document.documentElement?.innerText || '');
          document.querySelectorAll('pre, code, textarea, body').forEach((node) => {
            pushText(node.textContent || node.value || '');
          });

          for (const text of textCandidates) {
            const found = findTokenObject(text);
            if (found) return found;
          }

          try {
            for (let index = 0; index < localStorage.length; index++) {
              const value = localStorage.getItem(localStorage.key(index));
              const found = findTokenObject(value);
              if (found) return found;
            }
          } catch {}

          try {
            for (let index = 0; index < sessionStorage.length; index++) {
              const value = sessionStorage.getItem(sessionStorage.key(index));
              const found = findTokenObject(value);
              if (found) return found;
            }
          } catch {}

          return null;
        },
      });

      const authData = results?.[0]?.result || null;
      if (isPlainObject(authData)) {
        return authData;
      }
    } catch {}
  }

  return null;
}

function normalizeSettings(payload) {
  const nextState = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'vpsUrl')) {
    nextState.vpsUrl = String(payload.vpsUrl || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'mailProvider')) {
    nextState.mailProvider = normalizeMailProvider(payload.mailProvider);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'mainEmail')) {
    nextState.mainEmail = String(payload.mainEmail || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'ddgMailboxProvider')) {
    nextState.ddgMailboxProvider = normalizeDdgMailboxProvider(payload.ddgMailboxProvider);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'email')) {
    nextState.email = String(payload.email || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'customPassword')) {
    nextState.customPassword = String(payload.customPassword || '');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'oauthUrl')) {
    nextState.oauthUrl = String(payload.oauthUrl || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'runCount')) {
    nextState.runCount = clampRunCount(payload.runCount);
  }

  return nextState;
}

function normalizeMailProvider(value) {
  return String(value || '').trim().toLowerCase() === 'ddg' ? 'ddg' : '2925';
}

function normalizeDdgMailboxProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '163') return '163';
  if (normalized === '2925') return '2925';
  return 'qq';
}

function clampRunCount(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 1;
  }
  return Math.min(numeric, 999);
}

function clampRunCounter(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

async function incrementRunCounter(key) {
  const state = await getState();
  const nextValue = clampRunCounter(state[key]) + 1;
  await setState({ [key]: nextValue });
}

function normalizeRecentVerificationCodes(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = [];

  for (const item of list) {
    const code = String(item || '').trim();
    if (!/^\d{4,8}$/.test(code) || normalized.includes(code)) {
      continue;
    }
    normalized.push(code);
    if (normalized.length >= RECENT_USED_VERIFICATION_CODE_LIMIT) {
      break;
    }
  }

  return normalized;
}

async function rememberUsedVerificationCode(code) {
  const normalizedCode = String(code || '').trim();
  if (!/^\d{4,8}$/.test(normalizedCode)) {
    return;
  }

  const state = await getState();
  const existing = normalizeRecentVerificationCodes(state.recentUsedVerificationCodes);
  const nextCodes = [normalizedCode, ...existing.filter((item) => item !== normalizedCode)]
    .slice(0, RECENT_USED_VERIFICATION_CODE_LIMIT);
  await setState({ recentUsedVerificationCodes: nextCodes });
}

function validateStartConfig(state) {
  if (normalizeMailProvider(state.mailProvider) === '2925') {
    parseMainEmail(state.mainEmail);
    return;
  }
  validateDdgMailboxProvider(state.ddgMailboxProvider);
}

function validateDdgMailboxProvider(provider) {
  return normalizeDdgMailboxProvider(provider);
}

function parseMainEmail(mainEmail) {
  const trimmed = String(mainEmail || '').trim();
  const match = trimmed.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) {
    throw new Error('主邮箱格式不正确，请填写完整的 2925 邮箱地址。');
  }

  const localPart = match[1];
  const domain = match[2].toLowerCase();
  if (domain !== '2925.com') {
    throw new Error('主邮箱必须是 @2925.com。');
  }

  return { localPart, domain };
}

function build2925Alias(mainEmail, runIndex) {
  const { localPart, domain } = parseMainEmail(mainEmail);
  return `${localPart}_${createAliasSuffix(runIndex)}@${domain}`;
}

function createAliasSuffix(runIndex) {
  const random = Math.random().toString(36).slice(2, 7);
  const stamp = Date.now().toString(36).slice(-5);
  return `${stamp}${random}${runIndex}`.toLowerCase();
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  let password = '';
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  password += digits[Math.floor(Math.random() * digits.length)];
  password += symbols[Math.floor(Math.random() * symbols.length)];

  for (let index = 0; index < 10; index++) {
    password += all[Math.floor(Math.random() * all.length)];
  }

  return password
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('');
}

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId, ready = true) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready };
  await setState({ tabRegistry: registry });
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry?.tabId) {
    return false;
  }

  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    delete registry[source];
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

function doesTabMatchSource(source, tabUrl, targetUrl = '') {
  if (typeof tabUrl !== 'string' || !tabUrl) {
    return false;
  }

  if (targetUrl && tabUrl === targetUrl) {
    return true;
  }

  switch (source) {
    case 'signup-page':
      return /https:\/\/(auth0|auth|accounts)\.openai\.com\//i.test(tabUrl);
    case 'qq-mail':
      return /https:\/\/(wx\.)?mail\.qq\.com\//i.test(tabUrl);
    case 'mail-163':
      return /https:\/\/mail\.163\.com\//i.test(tabUrl);
    case 'duck-mail':
      return /^https:\/\/duckduckgo\.com\/email\/settings\/autofill/i.test(tabUrl);
    case 'mail-2925':
      return /^https:\/\/(www\.)?2925\.com\//i.test(tabUrl);
    case 'vps-panel':
      if (!targetUrl) {
        return false;
      }
      try {
        const tabParsedUrl = new URL(tabUrl);
        const targetParsedUrl = new URL(targetUrl);
        return tabParsedUrl.origin === targetParsedUrl.origin
          && tabParsedUrl.pathname === targetParsedUrl.pathname;
      } catch {
        return tabUrl === targetUrl;
      }
    default:
      return false;
  }
}

async function findExistingTabForSource(source, targetUrl) {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => tab?.id);

  const exactMatch = candidates.find((tab) => tab.url === targetUrl);
  if (exactMatch) {
    return exactMatch;
  }

  return candidates.find((tab) => doesTabMatchSource(source, tab.url, targetUrl)) || null;
}

function getInjectConfigForSource(source, options = {}) {
  if (Array.isArray(options.inject) && options.inject.length) {
    return {
      files: options.inject,
      injectSource: options.injectSource || source,
    };
  }

  switch (source) {
    case 'signup-page':
      return {
        files: ['content/utils.js', 'content/signup-page.js'],
        injectSource: 'signup-page',
      };
    case 'qq-mail':
      return {
        files: ['content/utils.js', 'content/qq-mail.js'],
        injectSource: 'qq-mail',
      };
    case 'mail-163':
      return {
        files: ['content/utils.js', 'content/mail-163.js'],
        injectSource: 'mail-163',
      };
    case 'duck-mail':
      return {
        files: ['content/utils.js', 'content/duck-mail.js'],
        injectSource: 'duck-mail',
      };
    case 'mail-2925':
      return {
        files: ['content/utils.js', 'content/mail-2925.js'],
        injectSource: 'mail-2925',
      };
    case 'vps-panel':
      return {
        files: ['content/utils.js', 'content/vps-panel.js'],
        injectSource: 'vps-panel',
      };
    default:
      return null;
  }
}

async function canReuseExistingTabWithoutInject(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'AUTO_REGISTER_PING',
      source: 'background',
      payload: {},
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function ensureExistingTabReady(source, tabId, options = {}) {
  const alreadyReady = await canReuseExistingTabWithoutInject(tabId);
  if (alreadyReady) {
    await registerTab(source, tabId, true);
    return;
  }

  const injectConfig = getInjectConfigForSource(source, options);
  if (!injectConfig?.files?.length) {
    await registerTab(source, tabId, false);
    return;
  }

  await registerTab(source, tabId, false);
  await injectFilesIntoTab(tabId, injectConfig.files, injectConfig.injectSource);
}

function queueCommand(source, message, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      reject(new Error(`Content script on ${source} did not respond in ${timeout / 1000}s.`));
    }, timeout);

    pendingCommands.set(source, { message, resolve, reject, timer });
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  pendingCommands.delete(source);
  chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const pending of pendingCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  pendingCommands.clear();
}

async function reuseOrCreateTab(source, url, options = {}) {
  let currentTab = null;
  const alive = await isTabAlive(source);

  if (alive) {
    const tabId = await getTabId(source);
    const registeredTab = await chrome.tabs.get(tabId);
    if (doesTabMatchSource(source, registeredTab.url, url)) {
      currentTab = registeredTab;
    }
  }

  const reusableTab = currentTab || await findExistingTabForSource(source, url);
  if (reusableTab?.id) {
    const tabId = reusableTab.id;
    const sameUrl = reusableTab.url === url;

    if (sameUrl) {
      if (Array.isArray(options.inject) && options.inject.length) {
        await registerTab(source, tabId, false);
        await injectFilesIntoTab(tabId, options.inject, options.injectSource || source);
      } else {
        await ensureExistingTabReady(source, tabId, options);
      }

      await chrome.tabs.update(tabId, { active: true });

      if (options.forceReload) {
        await registerTab(source, tabId, false);
        await chrome.tabs.reload(tabId, { bypassCache: true });
        await waitForTabLoad(tabId);
      }

      return tabId;
    }

    await registerTab(source, tabId, false);
    await chrome.tabs.update(tabId, { url, active: true });
    await waitForTabLoad(tabId);

    if (options.inject) {
      await injectFilesIntoTab(tabId, options.inject, options.injectSource || source);
    }

    return tabId;
  }

  const tab = await chrome.tabs.create({ url, active: true });
  if (options.inject) {
    await registerTab(source, tab.id, false);
    await waitForTabLoad(tab.id);
    await injectFilesIntoTab(tab.id, options.inject, options.injectSource || source);
  }
  return tab.id;
}

async function injectFilesIntoTab(tabId, files, injectSource) {
  if (injectSource) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (source) => {
        window.__AUTO_REGISTER_SOURCE = source;
      },
      args: [injectSource],
    });
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    return queueCommand(source, message);
  }

  const alive = await isTabAlive(source);
  if (!alive) {
    return queueCommand(source, message);
  }

  return chrome.tabs.sendMessage(entry.tabId, message);
}

async function setStepStatus(step, status) {
  const state = await getState();
  const stepStatuses = {
    ...state.stepStatuses,
    [step]: status,
  };
  await setState({ stepStatuses, currentStep: step });
}

function waitForStepComplete(step, timeoutMs = 120000) {
  throwIfStopped();
  return stepWaiterRegistry.waitForStepComplete(step, timeoutMs);
}

function notifyStepComplete(step, payload) {
  stepWaiterRegistry.notifyStepComplete(step, payload);
}

function notifyStepError(step, error) {
  stepWaiterRegistry.notifyStepError(step, new Error(error));
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function createSkipToNextRunError(message) {
  const error = new Error(message);
  error.code = 'SKIP_TO_NEXT_RUN';
  return error;
}

function isSkipToNextRunError(error) {
  return error?.code === 'SKIP_TO_NEXT_RUN';
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) {
      continue;
    }
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses)
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

function cleanupStep8Listeners() {
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }
  if (step8TabUpdatedListener) {
    chrome.tabs.onUpdated.removeListener(step8TabUpdatedListener);
    step8TabUpdatedListener = null;
  }
  if (step8TabRemovedListener) {
    chrome.tabs.onRemoved.removeListener(step8TabRemovedListener);
    step8TabRemovedListener = null;
  }
}

async function closeManagedTabsExceptMailbox() {
  const registry = await getTabRegistry();
  const nextRegistry = { ...registry };

  for (const source of CLOSABLE_TAB_SOURCES) {
    const tabId = registry[source]?.tabId;
    if (!tabId) {
      delete nextRegistry[source];
      continue;
    }

    try {
      await chrome.tabs.remove(tabId);
    } catch {}

    delete nextRegistry[source];
  }

  await setState({ tabRegistry: nextRegistry });
}

async function resetManagedTab(source) {
  const registry = await getTabRegistry();
  const tabId = registry[source]?.tabId;
  if (tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {}
    delete registry[source];
    await setState({ tabRegistry: registry });
  }
}

async function clearOpenAIBrowsingState() {
  if (!chrome.browsingData?.remove) {
    return;
  }

  try {
    await chrome.browsingData.remove(
      { origins: OPENAI_STORAGE_ORIGINS, since: 0 },
      {
        cacheStorage: true,
        cookies: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true,
        fileSystems: true,
      },
    );
    await addLog('已清理 OpenAI 相关站点存储。', 'info');
  } catch (error) {
    await addLog(`清理 OpenAI 站点存储失败: ${error.message}`, 'warn');
  }
}

async function cleanupAfterRun() {
  cleanupStep8Listeners();
  await closeManagedTabsExceptMailbox();
  await clearOpenAIBrowsingState();
}

async function requestStop(options = {}) {
  const { clearManualContinuation = false } = options;

  if (stopRequested) {
    return;
  }

  stopRequested = true;
  cancelPendingCommands();
  cleanupStep8Listeners();
  await chrome.storage.session.remove(['mail163PollState']);
  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  stepWaiterRegistry.rejectAll(new Error(STOP_ERROR_MESSAGE));

  if (mail163Waiter) {
    mail163Waiter.reject(new Error(STOP_ERROR_MESSAGE));
    mail163Waiter = null;
  }

  await markRunningStepsStopped();

  const updates = { runState: 'paused' };
  if (clearManualContinuation) {
    Object.assign(updates, {
      manualContinueVisible: false,
      manualResumeFromStep: null,
      lastManualStep: null,
      resumeAfterManual: false,
    });
  }
  await setState(updates);
}

async function startRunLoop(totalRuns) {
  if (runLoopActive || manualExecutionActive) {
    await addLog('已有运行中的任务，请先暂停当前流程。', 'warn');
    return;
  }

  runLoopActive = true;
  clearStopRequest();
  await setState({
    runState: 'running',
    runSuccessCount: 0,
    runFailureCount: 0,
    manualContinueVisible: false,
    manualResumeFromStep: null,
    lastManualStep: null,
    resumeAfterManual: false,
  });
  await addLog(`开始执行注册流程，共 ${totalRuns} 轮。`, 'info');

  activeRunPromise = (async () => {
    try {
      for (let runIndex = 1; runIndex <= totalRuns; runIndex++) {
        try {
          throwIfStopped();
          await prepareRunState(runIndex);
          const preparedState = await ensureRunCredentials(runIndex);
          await addLog(`=== Run ${runIndex}/${totalRuns}: ${preparedState.email} ===`, 'info');
          await runSequenceFromStep(getFirstSequenceStep(preparedState));
          await addLog(`Run ${runIndex}/${totalRuns} completed.`, 'ok');
          await cleanupAfterRun();
          await incrementRunCounter('runSuccessCount');
          if (runIndex < totalRuns) {
            await sleepWithStop(1200);
          }
        } catch (error) {
          if (isSkipToNextRunError(error)) {
            const hasNextRun = runIndex < totalRuns;
            await addLog(
              hasNextRun
                ? `Run ${runIndex}/${totalRuns} 注册失败: ${error.message}，跳过当前账号并进入下一轮。`
                : `Run ${runIndex}/${totalRuns} 注册失败: ${error.message}，没有剩余次数。`,
              'warn',
            );
            await cleanupAfterRun();
            await incrementRunCounter('runFailureCount');
            if (hasNextRun) {
              await sleepWithStop(1200);
              continue;
            }
            break;
          }
          throw error;
        }
      }

      await setState({
        runState: 'idle',
        currentStep: 0,
        manualContinueVisible: false,
        manualResumeFromStep: null,
        lastManualStep: null,
        resumeAfterManual: false,
      });
      await addLog(`全部 ${totalRuns} 轮执行完成。`, 'ok');
    } catch (error) {
      if (isStopError(error)) {
        await addLog('当前流程已暂停。', 'warn');
        await setState({ runState: 'paused' });
      } else {
        await addLog(`流程执行失败: ${error.message}`, 'error');
        await setState({ runState: 'paused' });
      }
      throw error;
    } finally {
      runLoopActive = false;
      activeRunPromise = null;
      cleanupStep8Listeners();
      clearStopRequest();

      const state = await getState();
      if (!manualExecutionActive && state.runState === 'running') {
        await setState({ runState: 'idle' });
      }
    }
  })();

  activeRunPromise.catch(() => {});
}

async function prepareRunState(runIndex) {
  const state = await getState();
  await chrome.storage.session.remove(['step3RetryPending', 'step3Email', 'step3Password', 'seen2925Codes', 'seenCodes', 'mail163PollState']);
  await setState({
    currentRunIndex: runIndex,
    currentStep: 0,
    stepStatuses: createDefaultStepStatuses(),
    flowStartTime: Date.now(),
    lastEmailTimestamp: null,
    localhostUrl: '',
    email: '',
    password: '',
    oauthUrl: state.oauthUrl,
    runState: 'running',
    manualContinueVisible: false,
    manualResumeFromStep: null,
    lastManualStep: null,
    resumeAfterManual: false,
  });
}

async function ensureRunCredentials(runIndex) {
  const state = await getState();
  const effectiveRunIndex = runIndex || state.currentRunIndex || 1;
  const updates = {};

  if (!state.currentRunIndex) {
    updates.currentRunIndex = effectiveRunIndex;
  }
  if (!state.flowStartTime) {
    updates.flowStartTime = Date.now();
  }

  const mailProvider = normalizeMailProvider(state.mailProvider);
  const email = state.email || (mailProvider === 'ddg'
    ? await fetchDuckEmail({ generateNew: true })
    : build2925Alias(state.mainEmail, effectiveRunIndex));
  const password = state.password || state.customPassword || generatePassword();

  if (!state.email) {
    updates.email = email;
  }
  if (!state.password) {
    updates.password = password;
  }

  if (Object.keys(updates).length) {
    await setState(updates);
  }

  return {
    ...(await getState()),
    email,
    password,
  };
}

function getStepSequence(state) {
  return [...STEP_IDS];
}

function getFirstSequenceStep(state) {
  return getStepSequence(state)[0];
}

function getNextSequenceStep(step, state) {
  const sequence = getStepSequence(state);
  const index = sequence.indexOf(step);
  return index >= 0 ? sequence[index + 1] || null : null;
}

function getRemainingSequenceFrom(startStep, state) {
  const sequence = getStepSequence(state);
  const index = sequence.indexOf(startStep);
  if (index >= 0) {
    return sequence.slice(index);
  }

  const nextIndex = sequence.findIndex((step) => step > startStep);
  return nextIndex >= 0 ? sequence.slice(nextIndex) : [];
}

function getStepTimeout(step) {
  return STEP_TIMEOUTS[step] || 120000;
}

function getStepDelayAfter(step) {
  return STEP_DELAY_AFTER[step] || 1500;
}

async function runSequenceFromStep(startStep) {
  const state = await getState();
  const sequence = getRemainingSequenceFrom(startStep, state);
  if (!sequence.length) {
    return;
  }

  for (const step of sequence) {
    await executeStepAndWait(step, getStepDelayAfter(step));
  }
}

async function stopActiveAutoRunForManual() {
  if (!runLoopActive) {
    return false;
  }

  await requestStop({ clearManualContinuation: true });
  if (activeRunPromise) {
    await activeRunPromise.catch(() => {});
  }
  clearStopRequest();
  return true;
}

async function ensureManualContext(step) {
  const state = await getState();
  const updates = {};

  if (!state.currentRunIndex) {
    updates.currentRunIndex = 1;
  }
  if (!state.flowStartTime) {
    updates.flowStartTime = Date.now();
  }
  if (!state.stepStatuses || !Object.keys(state.stepStatuses).length) {
    updates.stepStatuses = createDefaultStepStatuses();
  }

  if (Object.keys(updates).length) {
    await setState(updates);
  }

  if (step > 1) {
    await ensureRunCredentials(updates.currentRunIndex || state.currentRunIndex || 1);
  }
}

async function runManualStep(step) {
  if (manualExecutionActive) {
    throw new Error('当前已有步骤在执行，请稍后再试。');
  }

  const resumedFromAuto = await stopActiveAutoRunForManual();
  const startState = await getState();
  if (!resumedFromAuto && startState.runState === 'running') {
    throw new Error('当前有步骤正在执行，请稍后再试。');
  }

  const isPausedAutoContext = startState.runState === 'paused'
    && Number(startState.currentRunIndex || 0) > 0
    && Number(startState.currentRunIndex || 0) < Number(startState.runCount || 1)
    && !startState.manualContinueVisible;
  const shouldResumeAfterManual = resumedFromAuto || isPausedAutoContext;

  clearStopRequest();
  manualExecutionActive = true;

  try {
    await ensureManualContext(step);
    await setState({
      runState: 'running',
      manualContinueVisible: false,
      manualResumeFromStep: null,
      lastManualStep: step,
      resumeAfterManual: shouldResumeAfterManual,
    });

    await executeStepAndWait(step, getStepDelayAfter(step));

    const state = await getState();
    const nextStep = state.stepStatuses[step] === 'completed'
      ? getNextSequenceStep(step, state)
      : step;

    if (!nextStep) {
      await cleanupAfterRun();
    }

    await setState({
      runState: nextStep ? 'paused' : 'idle',
      manualContinueVisible: Boolean(nextStep),
      manualResumeFromStep: nextStep,
      lastManualStep: step,
      resumeAfterManual: nextStep ? shouldResumeAfterManual : false,
    });

    if (nextStep) {
      await addLog(`Step ${step} 手动执行完成，可继续后续流程。`, 'ok');
    } else {
      await addLog(`Step ${step} 手动执行完成。`, 'ok');
    }
  } catch (error) {
    const failedState = await getState();
    const resumeStep = failedState.currentStep || step;
    await setState({
      runState: 'paused',
      manualContinueVisible: true,
      manualResumeFromStep: resumeStep,
      lastManualStep: step,
      resumeAfterManual: shouldResumeAfterManual,
    });
    throw error;
  } finally {
    manualExecutionActive = false;
    cleanupStep8Listeners();
    clearStopRequest();
  }
}

async function continueFromManual() {
  if (manualExecutionActive || runLoopActive) {
    throw new Error('当前已有流程在执行，请稍后再试。');
  }

  const state = await getState();
  const startStep = Number(state.manualResumeFromStep || 0);
  if (!startStep) {
    throw new Error('当前没有可继续的流程。');
  }

  validateStartConfig(state);
  clearStopRequest();
  manualExecutionActive = true;

  try {
        await setState({
      runState: 'running',
      manualContinueVisible: false,
    });

    if (startStep > 1) {
      await ensureRunCredentials(state.currentRunIndex || 1);
    }

    try {
      await runSequenceFromStep(startStep);
      await cleanupAfterRun();
      await incrementRunCounter('runSuccessCount');
    } catch (error) {
      if (!isSkipToNextRunError(error)) {
        throw error;
      }

      const skippedState = await getState();
      const hasNextRun = skippedState.resumeAfterManual && skippedState.currentRunIndex < skippedState.runCount;
      await addLog(
        hasNextRun
          ? `Run ${skippedState.currentRunIndex}/${skippedState.runCount} 注册失败: ${error.message}，跳过当前账号并进入下一轮。`
          : `Run ${skippedState.currentRunIndex}/${skippedState.runCount} 注册失败: ${error.message}，没有剩余次数。`,
        'warn',
      );
      await cleanupAfterRun();
      await incrementRunCounter('runFailureCount');
      if (hasNextRun) {
        await sleepWithStop(1200);
      }
    }

    let latest = await getState();
    if (latest.resumeAfterManual && latest.currentRunIndex < latest.runCount) {
      for (let runIndex = latest.currentRunIndex + 1; runIndex <= latest.runCount; runIndex++) {
        try {
          throwIfStopped();
          await prepareRunState(runIndex);
          const preparedState = await ensureRunCredentials(runIndex);
          await addLog(`=== Run ${runIndex}/${latest.runCount}: ${preparedState.email} ===`, 'info');
          await runSequenceFromStep(getFirstSequenceStep(preparedState));
          await addLog(`Run ${runIndex}/${latest.runCount} completed.`, 'ok');
          await cleanupAfterRun();
          await incrementRunCounter('runSuccessCount');
          if (runIndex < latest.runCount) {
            await sleepWithStop(1200);
          }
        } catch (error) {
          if (isSkipToNextRunError(error)) {
            const hasNextRun = runIndex < latest.runCount;
            await addLog(
              hasNextRun
                ? `Run ${runIndex}/${latest.runCount} 注册失败: ${error.message}，跳过当前账号并进入下一轮。`
                : `Run ${runIndex}/${latest.runCount} 注册失败: ${error.message}，没有剩余次数。`,
              'warn',
            );
            await cleanupAfterRun();
            await incrementRunCounter('runFailureCount');
            if (hasNextRun) {
              await sleepWithStop(1200);
              continue;
            }
            break;
          }
          throw error;
        }
      }
      latest = await getState();
    }

    await setState({
      runState: 'idle',
      currentStep: 0,
      manualContinueVisible: false,
      manualResumeFromStep: null,
      lastManualStep: null,
      resumeAfterManual: false,
    });
    await addLog('继续执行已完成。', 'ok');
  } catch (error) {
    const failedState = await getState();
    const resumeStep = failedState.currentStep || startStep;
    await setState({
      runState: 'paused',
      manualContinueVisible: true,
      manualResumeFromStep: resumeStep,
    });
    throw error;
  } finally {
    manualExecutionActive = false;
    cleanupStep8Listeners();
    clearStopRequest();
  }
}

async function completeStepFromBackground(step, payload = {}) {
  if (stopRequested) {
    await setStepStatus(step, 'stopped');
    notifyStepError(step, STOP_ERROR_MESSAGE);
    return;
  }

  await setStepStatus(step, 'completed');
  await handleStepData(step, payload);
  await addLog(`Step ${step} completed`, 'ok');
  notifyStepComplete(step, payload);
}

async function executeStep(step) {
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`, 'info');
  await humanStepDelay();

  const state = await getState();

  try {
    switch (step) {
      case 1:
        await executeStep1(state);
        break;
      case 2:
        await executeStep2(state);
        break;
      case 3:
        await executeStep3(state);
        break;
      case 4:
        await executeStep4(state);
        break;
      case 5:
        await executeStep5(state);
        break;
      case 6:
        await executeStep6(state);
        break;
      case 7:
        await executeStep7(state);
        break;
      case 8:
        await executeStep8(state);
        break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (error) {
    if (isStopError(error)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      throw error;
    }

    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${error.message}`, 'error');
    throw error;
  }
}

async function executeStepAndWait(step, delayAfter = 2000) {
  const completion = waitForStepComplete(step, getStepTimeout(step));
  await executeStep(step);
  await completion;
  await ensureStepVerificationReady(step);
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter);
  }
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`, 'info');
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Duck email not returned.');
  }

  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
}

function shouldWaitVerificationSubmit(step) {
  return step === 2 || step === 6;
}

async function ensureStepVerificationReady(step) {
  if (!shouldWaitVerificationSubmit(step)) {
    return;
  }

  try {
    await waitForVerificationSubmitButton(step);
  } catch (error) {
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${error.message}`, 'error');
    throw error;
  }
}

async function waitForVerificationSubmitButton(step, options = {}) {
  const allowCredentialRecovery = Boolean(options.allowCredentialRecovery);
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error(`Step ${step}: 未找到注册页面标签页。`);
  }

  let retryCount = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < STEP_VERIFICATION_READY_TIMEOUT) {
    throwIfStopped();

    const state = await inspectSignupVerificationState(signupTabId);
    if (state.hasErrorPage) {
      if (retryCount >= STEP_VERIFICATION_RETRY_LIMIT) {
        throw new Error(
          `Step ${step}: 错误页重试已达 ${STEP_VERIFICATION_RETRY_LIMIT} 次，仍未出现验证码提交按钮。`,
        );
      }

      await chrome.tabs.update(signupTabId, { active: true }).catch(() => {});
      const clicked = await clickSignupRetryButton(signupTabId);
      if (!clicked) {
        throw new Error(`Step ${step}: 检测到错误页但未找到“重试”按钮。`);
      }

      retryCount += 1;
      await addLog(`Step ${step}: 检测到“糟糕，出错了！”，已点击重试 (${retryCount}/${STEP_VERIFICATION_RETRY_LIMIT})`, 'warn');
      await sleepWithStop(3000);

      const postRetryState = await inspectSignupVerificationState(signupTabId);
      if (postRetryState.hasVerificationSubmitButton) {
        await addLog(`Step ${step}: 重试后已进入验证码页，继续下一步。`, 'ok');
        return;
      }

      if (postRetryState.hasCredentialForm) {
        await addLog(`Step ${step}: 重试后回到账号密码页，重新执行该步骤。`, 'warn');
        await rerunCredentialStep(step);
        await sleepWithStop(2500);
      }
      continue;
    }

    if ((retryCount > 0 || allowCredentialRecovery) && state.hasCredentialForm) {
      await addLog(`Step ${step}: 处于账号密码页，重新执行该步骤。`, 'warn');
      await rerunCredentialStep(step);
      await sleepWithStop(2500);
      continue;
    }

    if (state.hasVerificationSubmitButton) {
      await addLog(`Step ${step}: 检测到验证码提交按钮，继续下一步。`, 'ok');
      return;
    }

    await sleepWithStop(1200);
  }

  throw new Error(`Step ${step}: 超时，未检测到验证码提交按钮。`);
}

async function resendAndRecoverVerificationSurface(step, signupTabId) {
  await chrome.tabs.update(signupTabId, { active: true }).catch(() => {});
  const clickResult = await sendToContentScript('signup-page', {
    type: 'CLICK_RESEND_CODE',
    source: 'background',
    payload: {},
  });

  if (clickResult?.error) {
    throw new Error(clickResult.error);
  }

  await addLog(`Step ${step}: Clicked resend button successfully`, 'ok');
  await addLog(`Step ${step}: Resend requested, waiting to recover verification page...`, 'info');
  await waitForVerificationSubmitButton(step, { allowCredentialRecovery: true });
}

async function rerunCredentialStep(step) {
  const state = await getState();
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error(`Step ${step}: 注册页面已关闭，无法重新执行该步骤。`);
  }

  await chrome.tabs.update(signupTabId, { active: true }).catch(() => {});

  if (step === 2) {
    if (!state.email || !state.password) {
      throw new Error('Step 2: 缺少邮箱或密码，无法重新填写。');
    }
    await executeStep2(state);
    return;
  }

  if (step === 6) {
    if (!state.email || !state.password || !state.oauthUrl) {
      throw new Error('Step 6: 缺少登录参数，无法重新填写。');
    }
    await executeStep6(state);
    return;
  }
}

async function inspectSignupVerificationState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const isVisible = (node) => {
          if (!node || !node.getClientRects || node.getClientRects().length === 0) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) {
            return false;
          }
          return true;
        };

        const pageText = normalize(document.body?.innerText || '');
        const hasErrorPage = /糟糕.*出错|route\s+error|method\s+not\s+allowed|operation\s+timed\s*out|something\s+went\s+wrong|we.?re\s+sorry/i.test(pageText);
        const hasVerificationContext = /verification\s*code|check.*inbox|email\s*verification|输入.*验证码|验证码|收件箱|验证代码/.test(pageText);
        const emailInput = Array.from(document.querySelectorAll('input[type="email"], input[name="email"], input[name="username"]'))
          .find((node) => isVisible(node));
        const passwordInput = Array.from(document.querySelectorAll('input[type="password"]'))
          .find((node) => isVisible(node));

        const codeInputs = Array.from(document.querySelectorAll(
          'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[inputmode="numeric"], input[maxlength="1"]',
        )).filter((node) => {
          const input = node;
          const disabled = input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true';
          return !disabled && isVisible(input);
        });
        const hasCodeInput = codeInputs.length >= 1;

        const submitLikeButton = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .find((node) => {
            const text = normalize(node.textContent || node.value || '');
            if (!text) {
              return false;
            }

            const isDisabled = node.disabled || node.getAttribute?.('aria-disabled') === 'true';
            if (isDisabled || !isVisible(node)) {
              return false;
            }
            if (/重试|retry|try\s*again|resend|重新发送|重发/.test(text)) {
              return false;
            }
            return /verify|confirm|submit|continue|验证|确认|提交|继续/.test(text);
          });

        const credentialSubmitButton = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .find((node) => {
            const text = normalize(node.textContent || node.value || '');
            if (!text) {
              return false;
            }
            const isDisabled = node.disabled || node.getAttribute?.('aria-disabled') === 'true';
            if (isDisabled || !isVisible(node)) {
              return false;
            }
            if (/重试|retry|try\s*again/.test(text)) {
              return false;
            }
            return /continue|next|submit|log\s*in|sign\s*in|登录|继续|下一步|注册|创建|create/.test(text);
          });

        return {
          hasErrorPage,
          hasCredentialForm: !hasErrorPage && Boolean(emailInput || passwordInput) && Boolean(credentialSubmitButton),
          hasVerificationSubmitButton: !hasErrorPage && hasVerificationContext && hasCodeInput && Boolean(submitLikeButton),
        };
      },
    });
    return results?.[0]?.result || { hasErrorPage: false, hasCredentialForm: false, hasVerificationSubmitButton: false };
  } catch {
    return { hasErrorPage: false, hasCredentialForm: false, hasVerificationSubmitButton: false };
  }
}

async function clickSignupRetryButton(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const isVisible = (node) => {
          if (!node || !node.getClientRects || node.getClientRects().length === 0) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) {
            return false;
          }
          return true;
        };

        const attrTarget = document.querySelector(
          'button[data-dd-action-name*="Try again"], button[data-dd-action-name*="retry" i]',
        );
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const textTarget = nodes.find((node) => {
          if (!isVisible(node)) {
            return false;
          }
          return /重试|try\s*again|retry/i.test(normalize(node.textContent || ''));
        });
        const target = isVisible(attrTarget) ? attrTarget : textTarget;
        if (!target) {
          return false;
        }
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.click();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    return false;
  }
}

async function fetchOAuthUrlForStep(step, state) {
  const currentState = state || await getState();
  const existingOauthUrl = String(currentState.oauthUrl || '').trim();

  if (!currentState.vpsUrl) {
    if (!existingOauthUrl) {
      throw new Error(`Step ${step}: No OAuth URL available.`);
    }
    return existingOauthUrl;
  }

  await addLog(`Step ${step}: Refreshing OAuth URL from VPS panel...`, 'info');

  const injectConfig = getInjectConfigForSource('vps-panel');
  const injectFiles = injectConfig?.files ?? ['content/utils.js', 'content/vps-panel.js'];
  const injectSource = injectConfig?.injectSource || 'vps-panel';
  const registeredTabId = await getTabId('vps-panel');
  const registeredTab = registeredTabId ? await chrome.tabs.get(registeredTabId).catch(() => null) : null;
  const matchedRegisteredTab = doesTabMatchSource('vps-panel', registeredTab?.url, currentState.vpsUrl)
    ? registeredTab
    : null;
  const reusableTab = matchedRegisteredTab || await findExistingTabForSource('vps-panel', currentState.vpsUrl);
  const shouldReloadCurrentTab = reusableTab?.id && reusableTab.url === currentState.vpsUrl;

  if (shouldReloadCurrentTab) {
    await registerTab('vps-panel', reusableTab.id, false);
    await chrome.tabs.update(reusableTab.id, { active: true });
    await chrome.tabs.reload(reusableTab.id, { bypassCache: true });
    await waitForTabLoad(reusableTab.id);
    await injectFilesIntoTab(reusableTab.id, injectFiles, injectSource);
  } else {
    await reuseOrCreateTab('vps-panel', currentState.vpsUrl, {
      inject: injectFiles,
      injectSource,
    });
  }

  const result = await sendToContentScript('vps-panel', {
    type: 'FETCH_OAUTH_URL',
    source: 'background',
    payload: { step },
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  const oauthUrl = String(result?.oauthUrl || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Step ${step}: VPS 未返回有效 OAuth URL。`);
  }

  if (oauthUrl !== existingOauthUrl) {
    await setState({ oauthUrl });
    broadcastDataUpdate({ oauthUrl });
  }

  return oauthUrl;
}

async function executeStep1(state) {
  if (!state.oauthUrl) {
    throw new Error('OAuth URL 为空。');
  }

  await addLog('Step 1: Opening auth URL...', 'info');
  await reuseOrCreateTab('signup-page', state.oauthUrl);
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

async function executeStep2(state) {
  if (!state.email) {
    throw new Error('注册邮箱为空。');
  }
  if (!state.password) {
    throw new Error('账号密码为空。');
  }

  await addLog(`Step 2: Filling email ${state.email}`, 'info');

  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 2,
        source: 'background',
        payload: {
          email: state.email,
          password: state.password,
        },
      });
      return;
    } catch (error) {
      const message = error?.message || '';
      const isChannelClosed = message.includes('message channel closed')
        || message.includes('port is moved into back/forward cache');

      if (isChannelClosed && attempt < maxRetries) {
        await addLog(`Step 2: Page reloaded during retry, waiting to resend (${attempt}/${maxRetries})...`, 'warn');
        await sleepWithStop(5000);
        continue;
      }

      throw error;
    }
  }
}

async function executeStep3(state) {
  const mailProvider = normalizeMailProvider(state.mailProvider);
  const maxResendAttempts = MAIL_POLL_TOTAL_ROUNDS;
  let result = null;

  for (let resendAttempt = 1; resendAttempt <= maxResendAttempts; resendAttempt++) {
    throwIfStopped();

    if (resendAttempt > 1) {
      await addLog(`Step 3: Resend attempt ${resendAttempt}/${maxResendAttempts}, navigating back to click resend...`, 'warn');
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Signup tab not found, cannot click resend.');
      }

      await resendAndRecoverVerificationSurface(3, signupTabId);
    }

    const currentState = await getState();
    const roundStartedAt = resendAttempt > 1 ? Date.now() : (currentState.flowStartTime || Date.now());
    await addLog(
      formatMailPollingLog(
        3,
        mailProvider === 'ddg' ? 'DDG forwarded mailbox' : '2925 mailbox',
        resendAttempt,
      ),
      'info',
    );

    try {
      result = mailProvider === 'ddg'
        ? await pollDdgCode(3, currentState, {
          filterAfterTimestamp: roundStartedAt,
          senderFilters: DDG_SIGNUP_SENDER_FILTERS,
          subjectFilters: DDG_SIGNUP_SUBJECT_FILTERS,
          maxAttempts: MAIL_POLL_ATTEMPTS_PER_ROUND,
          intervalMs: MAIL_POLL_INTERVAL_MS,
          newOnly: resendAttempt > 1,
        })
        : await poll2925Code(3, currentState, {
          filterAfterTimestamp: roundStartedAt,
          senderFilters: SIGNUP_SENDER_FILTERS,
          subjectFilters: SIGNUP_SUBJECT_FILTERS,
          maxAttempts: MAIL_POLL_ATTEMPTS_PER_ROUND,
          intervalMs: MAIL_POLL_INTERVAL_MS,
        });
      await addLog(`Step 3: Got verification code ${result.code}`, 'ok');
      break;
    } catch (error) {
      if (!shouldRetryMailPollRound(resendAttempt, maxResendAttempts)) {
        throw error;
      }
      await addLog(`Step 3: Poll attempt ${resendAttempt} failed: ${error.message}`, 'warn');
      await sleepWithStop(2000);
    }
  }

  if (!result?.code) {
    throw new Error('Step 3: Failed to get verification code.');
  }

  await setState({ lastEmailTimestamp: result.emailTimestamp || Date.now() });

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup tab not found.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step: 3,
    source: 'background',
    payload: { code: result.code },
  });
  await rememberUsedVerificationCode(result.code);
  await completeStepFromBackground(3, { code: result.code });
}

function getDdgMailConfig(state) {
  const mailboxProvider = validateDdgMailboxProvider(state.ddgMailboxProvider);
  if (mailboxProvider === '163') {
    return { source: 'mail-163', url: MAIL_163_URL, label: '163邮箱' };
  }
  if (mailboxProvider === '2925') {
    return { source: 'mail-2925', url: MAIL_2925_URL, label: '2925邮箱' };
  }
  return { source: 'qq-mail', url: QQ_MAIL_URL, label: 'QQ邮箱' };
}

async function openVerificationMailbox(mail) {
  await reuseOrCreateTab(mail.source, mail.url, {
    inject: mail.inject,
    injectSource: mail.injectSource,
  });
}

async function poll2925Code(step, state, options) {
  await addLog(`Step ${step}: Opening 2925 mailbox...`, 'info');
  await reuseOrCreateTab('mail-2925', MAIL_2925_URL);
  const maxAttempts = Number(options.maxAttempts);
  const intervalMs = Number(options.intervalMs);

  const result = await sendToContentScript('mail-2925', {
    type: 'POLL_EMAIL',
    step,
    source: 'background',
    payload: {
      filterAfterTimestamp: options.filterAfterTimestamp,
      senderFilters: options.senderFilters,
      subjectFilters: options.subjectFilters,
      targetEmail: state.email,
      mainEmail: state.mainEmail,
      maxAttempts,
      intervalMs,
      pageCount: options.pageCount || 50,
      recentUsedCodes: normalizeRecentVerificationCodes(state.recentUsedVerificationCodes),
    },
  });

  if (!result?.code) {
    throw new Error(result?.error || '未在 2925 邮箱中拿到验证码。');
  }

  return result;
}

async function pollDdgCode(step, state, options) {
  const mail = getDdgMailConfig(state);
  await addLog(`Step ${step}: Opening ${mail.label}...`, 'info');
  await openVerificationMailbox(mail);

  if (mail.source === 'mail-2925') {
    const maxAttempts = Number(options.maxAttempts);
    const intervalMs = Number(options.intervalMs);
    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step,
      source: 'background',
      payload: {
        filterAfterTimestamp: options.filterAfterTimestamp,
        senderFilters: options.senderFilters,
        subjectFilters: options.subjectFilters,
        targetEmail: state.email,
        mainEmail: state.mainEmail,
        maxAttempts,
        intervalMs,
        pageCount: options.pageCount || 50,
      },
    });
    if (!result?.code) {
      throw new Error(result?.error || `未在${mail.label}中拿到验证码。`);
    }
    return result;
  }

  const is163 = mail.source === 'mail-163';
  if (is163) {
    const maxAttempts = Number(options.maxAttempts);
    const intervalMs = Number(options.intervalMs);
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        mail163Waiter = null;
        reject(new Error('163 Mail poll timed out after 30s'));
      }, 30000);

      mail163Waiter = {
        resolve: (value) => {
          clearTimeout(timeout);
          mail163Waiter = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          mail163Waiter = null;
          reject(error);
        },
      };

      sendToContentScript(mail.source, {
        type: 'POLL_EMAIL',
        step,
        source: 'background',
        payload: {
          senderFilters: options.senderFilters,
          subjectFilters: options.subjectFilters,
          maxAttempts,
          intervalMs,
          recentUsedCodes: normalizeRecentVerificationCodes(state.recentUsedVerificationCodes),
        },
      }).then((response) => {
        if (response && (response.code !== undefined || response.error !== undefined)) {
          mail163Waiter?.resolve(response);
        }
      }).catch(() => {
        // The 163 page may refresh during polling and report via MAIL163_RESULT.
      });
    });
    if (!result?.code) {
      throw new Error(result?.error || `未在${mail.label}中拿到验证码。`);
    }
    return result;
  }

  const maxAttempts = Number(options.maxAttempts);
  const intervalMs = Number(options.intervalMs);
  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step,
    source: 'background',
    payload: {
      filterAfterTimestamp: options.filterAfterTimestamp,
      senderFilters: options.senderFilters,
      subjectFilters: options.subjectFilters,
      targetEmail: state.email,
      maxAttempts,
      intervalMs,
      recentUsedCodes: normalizeRecentVerificationCodes(state.recentUsedVerificationCodes),
    },
  });
  if (!result?.code) {
    throw new Error(result?.error || `未在${mail.label}中拿到验证码。`);
  }
  return result;
}

async function executeStep4() {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 4: Generated profile ${firstName} ${lastName} (${year}-${month}-${day})`, 'info');
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 4,
    source: 'background',
    payload: {
      firstName,
      lastName,
      year,
      month,
      day,
    },
  });
}

async function executeStep5(state) {
  if (!state.vpsUrl) {
    if (!state.oauthUrl) {
      throw new Error('Step 5: OAuth URL 为空。');
    }
    await addLog('Step 5: Using existing OAuth URL.', 'info');
    await completeStepFromBackground(5, { oauthUrl: state.oauthUrl });
    return;
  }

  const oauthUrl = await fetchOAuthUrlForStep(5, state);
  await completeStepFromBackground(5, { oauthUrl });
}

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 5 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 2 first.');
  }
  if (!state.password) {
    throw new Error('No password. Complete step 2 first.');
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await addLog(`Step 6: Opening OAuth URL for login... (${attempt}/${maxAttempts})`, 'info');
      await reuseOrCreateTab('signup-page', state.oauthUrl);

      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 6,
        source: 'background',
        payload: { email: state.email, password: state.password },
      });
      return;
    } catch (error) {
      const isPasswordWaitTimeout = error?.message === 'Step 6: Password field did not appear within 30s.';
      if (!isPasswordWaitTimeout || attempt >= maxAttempts) {
        throw error;
      }
      await addLog(`Step 6: 密码框 30s 未出现，重试 ${attempt}/${maxAttempts}`, 'warn');
      await sleepWithStop(1500);
    }
  }
}

async function executeStep7(state) {
  const mailProvider = normalizeMailProvider(state.mailProvider);
  const maxResendAttempts = MAIL_POLL_TOTAL_ROUNDS;
  let codeResult = null;

  for (let resendAttempt = 1; resendAttempt <= maxResendAttempts; resendAttempt++) {
    throwIfStopped();

    if (resendAttempt > 1) {
      await addLog(`Step 7: Resend attempt ${resendAttempt}/${maxResendAttempts}, navigating back to click resend...`, 'warn');
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Auth tab not found, cannot click resend.');
      }

      await resendAndRecoverVerificationSurface(7, signupTabId);
    }

    const currentState = await getState();
    const roundStartedAt = resendAttempt > 1
      ? Date.now()
      : (currentState.lastEmailTimestamp || currentState.flowStartTime || Date.now());
    await addLog(
      formatMailPollingLog(
        7,
        mailProvider === 'ddg' ? 'DDG forwarded mailbox' : '2925 mailbox',
        resendAttempt,
      ),
      'info',
    );

    try {
      codeResult = mailProvider === 'ddg'
        ? await pollDdgCode(7, currentState, {
          filterAfterTimestamp: roundStartedAt,
          senderFilters: DDG_LOGIN_SENDER_FILTERS,
          subjectFilters: DDG_LOGIN_SUBJECT_FILTERS,
          maxAttempts: MAIL_POLL_ATTEMPTS_PER_ROUND,
          intervalMs: MAIL_POLL_INTERVAL_MS,
          newOnly: resendAttempt > 1,
        })
        : await poll2925Code(7, currentState, {
          filterAfterTimestamp: roundStartedAt,
          senderFilters: LOGIN_SENDER_FILTERS,
          subjectFilters: LOGIN_SUBJECT_FILTERS,
          maxAttempts: MAIL_POLL_ATTEMPTS_PER_ROUND,
          intervalMs: MAIL_POLL_INTERVAL_MS,
        });
      await addLog(`Step 7: Got login verification code ${codeResult.code}`, 'ok');
      break;
    } catch (error) {
      if (!shouldRetryMailPollRound(resendAttempt, maxResendAttempts)) {
        throw error;
      }
      await addLog(`Step 7: Poll attempt ${resendAttempt} failed: ${error.message}`, 'warn');
      await sleepWithStop(2000);
    }
  }

  if (!codeResult?.code) {
    throw new Error('Step 7: Failed to get login verification code.');
  }

  await setState({ lastEmailTimestamp: codeResult.emailTimestamp || Date.now() });

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Auth page tab was closed. Cannot fill verification code.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step: 7,
    source: 'background',
    payload: { code: codeResult.code },
  });
  await rememberUsedVerificationCode(codeResult.code);
  await completeStepFromBackground(7, { code: codeResult.code });
}

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 5 first.');
  }

  let signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  } else {
    signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
  }

  await addLog('Step 8: Waiting for OAuth consent page to become ready...', 'info');
  const readyResult = await waitForStep8SurfaceReady(signupTabId);
  if (readyResult?.localhostUrl || readyResult?.authSuccess) {
    await completeStepFromBackground(8, readyResult);
    return;
  }

  await addLog('Step 8: Preparing OAuth consent click...', 'info');

  const clickResult = await sendToContentScript('signup-page', {
    type: 'STEP8_FIND_AND_CLICK',
    source: 'background',
    payload: {},
  });

  if (clickResult?.error) {
    if (/电话号码是必填项|手机号是必填项|phone number is required/i.test(String(clickResult.error))) {
      throw createSkipToNextRunError('Step 8 检测到“电话号码是必填项”');
    }
    throw new Error(clickResult.error);
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let removalFallbackTimer = null;
    const timeoutHandle = setTimeout(async () => {
      try {
        const fallbackUrl = await findLocalhostAcrossTabs() || await extractLocalhostFromTab(signupTabId);
        if (fallbackUrl) {
          await finish({ localhostUrl: fallbackUrl });
          return;
        }
        if (await checkAuthSuccessOnTab(signupTabId)) {
          await addLog('Step 8: Authentication successful! detected, treating current run as success.', 'ok');
          await finish({ localhostUrl: '', authSuccess: true });
          return;
        }
        fail(new Error('Localhost redirect not captured after 120s. Step 8 click may have been blocked.'));
      } catch (error) {
        fail(error);
      }
    }, getStepTimeout(8));

    const cleanup = () => {
      cleanupStep8Listeners();
      clearTimeout(timeoutHandle);
      if (removalFallbackTimer) {
        clearTimeout(removalFallbackTimer);
        removalFallbackTimer = null;
      }
    };

    const finish = async (payload = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      await completeStepFromBackground(8, payload);
      resolve();
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    webNavListener = (details) => {
      if (details.url && details.url.startsWith('http://localhost')) {
        void finish({ localhostUrl: details.url });
      }
    };

    step8TabUpdatedListener = (tabId, changeInfo) => {
      if (tabId === signupTabId && changeInfo.url && changeInfo.url.startsWith('http://localhost')) {
        void finish({ localhostUrl: changeInfo.url });
      }
    };

    step8TabRemovedListener = (tabId) => {
      if (tabId !== signupTabId || settled) {
        return;
      }

      removalFallbackTimer = setTimeout(async () => {
        try {
          const fallbackUrl = await findLocalhostAcrossTabs();
          if (fallbackUrl) {
            await finish({ localhostUrl: fallbackUrl });
            return;
          }
          if (await checkAuthSuccessOnTab(signupTabId)) {
            await addLog('Step 8: Authentication successful! detected after page close, treating current run as success.', 'ok');
            await finish({ localhostUrl: '', authSuccess: true });
            return;
          }
          fail(new Error('认证页面已关闭，但未捕获到 localhost 回调。'));
        } catch (error) {
          fail(error);
        }
      }, 5000);
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);
    chrome.tabs.onUpdated.addListener(step8TabUpdatedListener);
    chrome.tabs.onRemoved.addListener(step8TabRemovedListener);

    (async () => {
      try {
        await clickWithDebugger(signupTabId, clickResult?.rect);
        await addLog('Step 8: Debugger click dispatched, waiting for redirect...', 'info');

        const completionResult = await waitForAuthComplete(signupTabId, () => settled);
        if (completionResult?.localhostUrl || completionResult?.authSuccess) {
          await finish(completionResult);
        }
      } catch (error) {
        fail(error);
      }
    })();
  });
}

async function waitForStep8SurfaceReady(tabId) {
  const start = Date.now();
  let lastCrossTabCheckAt = 0;

  while (Date.now() - start < STEP8_SURFACE_READY_TIMEOUT) {
    throwIfStopped();

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('Step 8: 授权页面标签页已关闭。');
    }

    const url = tab?.url || '';
    if (url.startsWith('http://localhost')) {
      return { localhostUrl: url };
    }

    const surfaceState = await inspectStep8SurfaceState(tabId);
    if (surfaceState.phoneRequired) {
      throw createSkipToNextRunError('Step 8 检测到“电话号码是必填项”');
    }
    if (surfaceState.authSuccess) {
      await addLog('Step 8: Authentication successful page detected before consent click.', 'ok');
      return { localhostUrl: '', authSuccess: true };
    }
    if (surfaceState.hasContinueButton) {
      await addLog('Step 8: OAuth consent page is ready.', 'ok');
      return null;
    }

    const extracted = await extractLocalhostFromTab(tabId);
    if (extracted) {
      return { localhostUrl: extracted };
    }

    if (Date.now() - lastCrossTabCheckAt >= 2000) {
      lastCrossTabCheckAt = Date.now();
      const fallbackUrl = await findLocalhostAcrossTabs();
      if (fallbackUrl) {
        return { localhostUrl: fallbackUrl };
      }
    }

    await sleepWithStop(STEP8_SURFACE_READY_POLL_INTERVAL);
  }

  const fallbackUrl = await findLocalhostAcrossTabs();
  if (fallbackUrl) {
    return { localhostUrl: fallbackUrl };
  }

  const finalState = await inspectStep8SurfaceState(tabId);
  if (finalState.phoneRequired) {
    throw createSkipToNextRunError('Step 8 检测到“电话号码是必填项”');
  }
  if (finalState.authSuccess) {
    await addLog('Step 8: Authentication successful page detected after waiting for consent page.', 'ok');
    return { localhostUrl: '', authSuccess: true };
  }
  if (finalState.hasContinueButton) {
    await addLog('Step 8: OAuth consent page is ready.', 'ok');
    return null;
  }

  throw new Error(`Step 8: 验证码提交后等待 ${Math.round(STEP8_SURFACE_READY_TIMEOUT / 1000)} 秒，仍未出现“继续”按钮。当前页面: ${finalState.url || 'unknown'}`);
}

async function waitForAuthComplete(tabId, isResolved) {
  const start = Date.now();
  let successPageLogged = false;

  while (Date.now() - start < getStepTimeout(8)) {
    throwIfStopped();

    if (isResolved()) {
      return null;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || '';

      if (url.startsWith('http://localhost')) {
        return { localhostUrl: url };
      }

      if (await checkPhoneRequiredOnTab(tabId)) {
        throw createSkipToNextRunError('Step 8 检测到“电话号码是必填项”');
      }

      if (await checkAuthSuccessOnTab(tabId)) {
        if (!successPageLogged) {
          successPageLogged = true;
          await addLog('Step 8: Authentication successful! detected, treating current run as success.', 'ok');
        }
        return { localhostUrl: '', authSuccess: true };
      }

      if (!successPageLogged && /Authentication successful|auth-success/i.test(url)) {
        successPageLogged = true;
        await addLog('Step 8: Authentication successful page detected, treating current run as success.', 'ok');
        return { localhostUrl: '', authSuccess: true };
      }

      const extracted = await extractLocalhostFromTab(tabId);
      if (extracted) {
        return { localhostUrl: extracted };
      }
    } catch (error) {
      if (isSkipToNextRunError(error)) {
        throw error;
      }
      const fallbackUrl = await findLocalhostAcrossTabs();
      if (fallbackUrl) {
        return { localhostUrl: fallbackUrl };
      }
    }

    await sleepWithStop(800);
  }

  const fallbackUrl = await findLocalhostAcrossTabs();
  if (fallbackUrl) {
    return { localhostUrl: fallbackUrl };
  }

  if (await checkAuthSuccessOnTab(tabId)) {
    return { localhostUrl: '', authSuccess: true };
  }

  return null;
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (error) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${error.message}. If DevTools is open on the auth tab, close it and retry.`,
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function findLocalhostAcrossTabs() {
  const tabs = await chrome.tabs.query({});
  const localhostTab = tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith('http://localhost'));
  return localhostTab?.url || null;
}

async function inspectStep8SurfaceState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const isVisible = (node) => {
          if (!node || !node.getClientRects || node.getClientRects().length === 0) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) {
            return false;
          }
          return true;
        };

        const text = document.body?.innerText || '';
        const title = document.title || '';
        const pageText = normalize(text);
        const exactSelector = 'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107';
        const candidates = Array.from(document.querySelectorAll(`${exactSelector}, button[type="submit"], button, [role="button"]`))
          .filter((node, index, list) => list.indexOf(node) === index);

        const hasContinueButton = candidates.some((node) => {
          if (!isVisible(node)) {
            return false;
          }
          const combined = `${node.textContent || ''} ${node.getAttribute('data-dd-action-name') || ''} ${node.getAttribute('aria-label') || ''}`;
          return node.matches(exactSelector) || /继续|continue/i.test(combined);
        });

        const hasVerificationInput = Array.from(document.querySelectorAll('input[name="code"], input[name="otp"], input[inputmode="numeric"], input[maxlength="1"]'))
          .some((node) => isVisible(node));

        return {
          url: location.href,
          phoneRequired: /电话号码是必填项|手机号是必填项|phone number is required/i.test(text),
          authSuccess: /authentication successful!?/i.test(text) || /authentication successful!?/i.test(title),
          hasContinueButton,
          hasVerificationInput,
          hasVerificationPrompt: /verification\s*code|check.*inbox|email\s*verification|输入.*验证码|验证码|收件箱|验证代码/.test(pageText),
        };
      },
    });
    return results?.[0]?.result || {
      url: '',
      phoneRequired: false,
      authSuccess: false,
      hasContinueButton: false,
      hasVerificationInput: false,
      hasVerificationPrompt: false,
    };
  } catch {
    return {
      url: '',
      phoneRequired: false,
      authSuccess: false,
      hasContinueButton: false,
      hasVerificationInput: false,
      hasVerificationPrompt: false,
    };
  }
}

async function checkPhoneRequiredOnTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || '';
        return /电话号码是必填项|手机号是必填项|phone number is required/i.test(text);
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    return false;
  }
}

async function checkAuthSuccessOnTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || '';
        const title = document.title || '';
        return /Authentication successful!?/i.test(text) || /Authentication successful!?/i.test(title);
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    return false;
  }
}

async function extractLocalhostFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'EXTRACT_LOCALHOST_URL',
      source: 'background',
      payload: {},
    });
    if (response?.localhostUrl) {
      return response.localhostUrl;
    }
  } catch {}

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || '';
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
          const content = metaRefresh.getAttribute('content') || '';
          const match = content.match(/url=(http:\/\/localhost[^\s"]+)/i);
          if (match) {
            return match[1];
          }
        }

        const link = document.querySelector('a[href^="http://localhost"]');
        if (link) {
          return link.href;
        }

        const match = text.match(/http:\/\/localhost[^\s"<>]+/);
        return match ? match[0] : null;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}





























