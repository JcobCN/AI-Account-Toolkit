const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>';

const STEPS = [
  { id: 1, title: 'Open Signup', subtitle: '打开注册授权页' },
  { id: 2, title: 'Fill Email / Password', subtitle: '填入注册邮箱和密码' },
  { id: 3, title: 'Get Signup Code', subtitle: '轮询注册验证码并回填' },
  { id: 4, title: 'Fill Name / Birthday', subtitle: '填写姓名和生日' },
  { id: 5, title: 'Get OAuth Link', subtitle: '获取登录所需的最新授权链接' },
  { id: 6, title: 'Login via OAuth', subtitle: '使用已注册账号重新登录' },
  { id: 7, title: 'Get Login Code', subtitle: '轮询登录验证码并回填' },
  { id: 8, title: 'OAuth Auto Confirm', subtitle: '自动点击继续并捕获 localhost 回调' },
];

const STATUS_LABELS = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ICONS = {
  pending: '',
  running: '...',
  completed: '✓',
  failed: '✕',
  stopped: '■',
};

const uiState = {
  runState: 'idle',
  currentStep: 0,
  currentRunIndex: 0,
  runCount: 1,
  runSuccessCount: 0,
  runFailureCount: 0,
  mainEmail: '',
  email: '',
  password: '',
  customPassword: '',
  oauthUrl: '',
  vpsUrl: '',
  mailProvider: '2925',
  ddgMailboxProvider: 'qq',
  manualContinueVisible: false,
  manualResumeFromStep: null,
  lastManualStep: null,
  stepStatuses: createDefaultStepStatuses(),
};

const logArea = document.getElementById('log-area');
const inputVpsUrl = document.getElementById('input-vps-url');
const selectMailProvider = document.getElementById('select-mail-provider');
const rowMainEmail = document.getElementById('row-main-email');
const inputMainEmail = document.getElementById('input-main-email');
const selectDdgMailboxProvider = document.getElementById('select-ddg-mailbox-provider');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const inputOauthUrl = document.getElementById('input-oauth-url');
const inputRunCount = document.getElementById('input-run-count');
const btnToggleRun = document.getElementById('btn-toggle-run');
const btnToggleRunLabel = document.getElementById('btn-toggle-run-label');
const btnRefresh = document.getElementById('btn-refresh');
const btnClearLog = document.getElementById('btn-clear-log');
const statusBar = document.getElementById('status-bar');
const displayStatus = document.getElementById('display-status');
const displayRunSummary = document.getElementById('display-run-summary');
const displayRunSuccess = document.getElementById('display-run-success');
const displayRunFailure = document.getElementById('display-run-failure');
const stepsList = document.getElementById('steps-list');
const stepsProgress = document.getElementById('steps-progress');
const btnWorkflowContinue = document.getElementById('btn-workflow-continue');
const toastContainer = document.getElementById('toast-container');

renderWorkflowRows();
bindEvents();
restoreState();

function createDefaultStepStatuses() {
  return STEPS.reduce((statuses, step) => {
    statuses[step.id] = 'pending';
    return statuses;
  }, {});
}

function renderWorkflowRows() {
  stepsList.innerHTML = STEPS.map((step) => `
    <div class="step-row" data-step="${step.id}">
      <div class="step-indicator"><span class="step-num">${step.id}</span></div>
      <button class="step-btn" data-step="${step.id}" type="button">
        <span class="step-title">${escapeHtml(step.title)}</span>
        <span class="step-subtitle">${escapeHtml(step.subtitle)}</span>
      </button>
      <span class="step-status pending" data-step="${step.id}">
        <span class="step-status-icon"></span>
        <span class="step-status-label">${STATUS_LABELS.pending}</span>
      </span>
    </div>
  `).join('');
}

function bindEvents() {
  inputVpsUrl.addEventListener('change', () => saveSettings({ vpsUrl: inputVpsUrl.value }));
  selectMailProvider.addEventListener('change', () => {
    updateMailProviderUI();
    saveSettings({ mailProvider: selectMailProvider.value });
  });
  inputMainEmail.addEventListener('change', () => saveSettings({ mainEmail: inputMainEmail.value }));
  selectDdgMailboxProvider.addEventListener('change', () => saveSettings({ ddgMailboxProvider: selectDdgMailboxProvider.value }));
  inputPassword.addEventListener('change', () => saveSettings({ customPassword: inputPassword.value }));
  inputOauthUrl.addEventListener('change', () => saveSettings({ oauthUrl: inputOauthUrl.value }));
  inputRunCount.addEventListener('change', handleRunCountChange);

  btnTogglePassword.addEventListener('click', () => {
    inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
    btnTogglePassword.textContent = inputPassword.type === 'password' ? 'Show' : 'Hide';
  });

  btnToggleRun.addEventListener('click', async () => {
    btnToggleRun.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TOGGLE_RUN' });
      if (response?.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      btnToggleRun.disabled = false;
    }
  });

  btnRefresh.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REFRESH_RUNTIME' });
      if (response?.error) {
        throw new Error(response.error);
      }
      showToast('运行状态已刷新', 'info');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  btnClearLog.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
      if (response?.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  btnWorkflowContinue.addEventListener('click', async () => {
    btnWorkflowContinue.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CONTINUE_FROM_MANUAL' });
      if (response?.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      btnWorkflowContinue.disabled = false;
    }
  });

  stepsList.addEventListener('click', async (event) => {
    const button = event.target.closest('.step-btn');
    if (!button) {
      return;
    }

    const step = Number(button.dataset.step);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'MANUAL_RUN_STEP',
        payload: { step },
      });
      if (response?.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'STATE_UPDATED':
      case 'DATA_UPDATED':
        applyPartialState(message.payload || {});
        break;
      case 'LOG_ENTRY':
        appendLog(message.payload);
        if (message.payload?.level === 'error') {
          showToast(message.payload.message, 'error');
        }
        break;
      case 'LOGS_CLEARED':
        logArea.innerHTML = '';
        break;
      default:
        break;
    }
  });
}

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state?.error) {
      throw new Error(state.error);
    }

    Object.assign(uiState, state, {
      stepStatuses: {
        ...createDefaultStepStatuses(),
        ...(state.stepStatuses || {}),
      },
    });

    renderState();
    logArea.innerHTML = '';
    for (const entry of state.logs || []) {
      appendLog(entry);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function applyPartialState(payload) {
  const nextState = { ...payload };
  if (payload.stepStatuses) {
    nextState.stepStatuses = {
      ...uiState.stepStatuses,
      ...payload.stepStatuses,
    };
  }
  Object.assign(uiState, nextState);
  renderState();
}

function renderState() {
  inputVpsUrl.value = uiState.vpsUrl || '';
  selectMailProvider.value = uiState.mailProvider || '2925';
  inputMainEmail.value = uiState.mainEmail || '';
  selectDdgMailboxProvider.value = uiState.ddgMailboxProvider || 'qq';
  inputEmail.value = uiState.email || '';
  inputPassword.value = uiState.customPassword || uiState.password || '';
  inputOauthUrl.value = uiState.oauthUrl || '';
  inputRunCount.value = String(uiState.runCount || 1);
  updateMailProviderUI();
  updateRunState();
  renderWorkflow();
}

function updateRunState() {
  const runState = uiState.runState || 'idle';
  statusBar.className = `status-bar ${runState}`;
  displayStatus.textContent = buildStatusText();
  renderRunSummary();

  const isRunning = runState === 'running';
  inputRunCount.disabled = isRunning;
  inputVpsUrl.disabled = isRunning;
  selectMailProvider.disabled = isRunning;
  inputMainEmail.disabled = isRunning;
  selectDdgMailboxProvider.disabled = isRunning;
  inputOauthUrl.disabled = isRunning;
  inputPassword.disabled = isRunning;

  btnToggleRun.className = isRunning ? 'btn btn-warning' : 'btn btn-success';
  btnToggleRun.querySelector('.btn-icon').innerHTML = isRunning ? PAUSE_ICON : PLAY_ICON;
  btnToggleRunLabel.textContent = isRunning ? '暂停' : '开始';
}

function renderRunSummary() {
  const totalRuns = Number(uiState.runCount || 1);
  const successCount = Number(uiState.runSuccessCount || 0);
  const failureCount = Number(uiState.runFailureCount || 0);
  const shouldShow = totalRuns > 1 && (uiState.currentRunIndex > 0 || successCount > 0 || failureCount > 0);

  displayRunSummary.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    return;
  }

  displayRunSuccess.textContent = `成功 ${successCount}`;
  displayRunFailure.textContent = `失败 ${failureCount}`;
}
function updateMailProviderUI() {
  const useDdg = (selectMailProvider.value || '2925') === 'ddg';
  rowMainEmail.dataset.mode = useDdg ? 'ddg' : '2925';
  inputMainEmail.classList.toggle('hidden', useDdg);
  selectDdgMailboxProvider.classList.toggle('hidden', !useDdg);
}

function buildStatusText() {
  const runState = uiState.runState || 'idle';
  if (runState === 'running') {
    const totalRuns = uiState.runCount || 1;
    const runIndex = uiState.currentRunIndex || 1;
    const step = uiState.currentStep || 1;
    return totalRuns > 1 ? `第 ${runIndex}/${totalRuns} 轮 · Step ${step}` : `Step ${step} 执行中`;
  }

  if (runState === 'paused' && uiState.manualContinueVisible && uiState.manualResumeFromStep) {
    return `已暂停 · 可从 Step ${uiState.manualResumeFromStep} 继续`;
  }

  return runState === 'paused' ? '已暂停' : '就绪';
}

function renderWorkflow() {
  const completedCount = STEPS.filter((step) => uiState.stepStatuses[step.id] === 'completed').length;
  stepsProgress.textContent = `${completedCount} / ${STEPS.length}`;

  const showContinue = Boolean(uiState.manualContinueVisible && uiState.manualResumeFromStep);
  btnWorkflowContinue.classList.toggle('hidden', !showContinue);
  btnWorkflowContinue.textContent = showContinue ? `继续 Step ${uiState.manualResumeFromStep}` : '继续';

  for (const step of STEPS) {
    const status = uiState.stepStatuses[step.id] || 'pending';
    const row = stepsList.querySelector(`.step-row[data-step="${step.id}"]`);
    const statusEl = stepsList.querySelector(`.step-status[data-step="${step.id}"]`);
    if (!row || !statusEl) {
      continue;
    }

    row.className = `step-row ${status}${showContinue && uiState.manualResumeFromStep === step.id ? ' resume-target' : ''}`;
    statusEl.className = `step-status ${status}`;
    statusEl.innerHTML = [
      `<span class="step-status-icon">${escapeHtml(STATUS_ICONS[status] || '')}</span>`,
      `<span class="step-status-label">${escapeHtml(STATUS_LABELS[status] || STATUS_LABELS.pending)}</span>`,
    ].join('');
  }
}

async function saveSettings(payload) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      payload,
    });
    if (response?.error) {
      throw new Error(response.error);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleRunCountChange() {
  const numeric = Number.parseInt(inputRunCount.value, 10);
  const safeCount = Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, 999) : 1;
  inputRunCount.value = String(safeCount);
  saveSettings({ runCount: safeCount });
}

function appendLog(entry) {
  if (!entry) {
    return;
  }

  const line = document.createElement('div');
  line.className = `log-line log-${entry.level || 'info'}`;

  const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString('en-US', { hour12: false });
  const level = String(entry.level || 'info').toUpperCase();

  line.innerHTML = [
    `<span class="log-time">${escapeHtml(time)}</span>`,
    `<span class="log-level log-level-${escapeHtml((entry.level || 'info').toLowerCase())}">${escapeHtml(level)}</span>`,
    `<span class="log-msg">${escapeHtml(entry.message || '')}</span>`,
  ].join(' ');

  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" type="button" aria-label="关闭">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

