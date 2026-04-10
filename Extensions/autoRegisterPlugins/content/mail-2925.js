const MAIL2925_PREFIX = '[AutoRegister:mail-2925]';
const SEEN_CODES_KEY = 'seen2925Codes';
const isTopFrame = window === window.top;

console.log(MAIL2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(MAIL2925_PREFIX, 'Skipping child frame');
} else {
  let seenCodes = new Set();
  loadSeenCodes();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'POLL_EMAIL') {
      resetStopState();
      handlePollEmail(message.step, message.payload)
        .then(sendResponse)
        .catch((error) => {
          if (isStopError(error)) {
            sendResponse({ stopped: true, error: error.message });
            return;
          }
          sendResponse({ error: error.message });
        });
      return true;
    }
  });

  async function handlePollEmail(step, payload) {
    const config = payload || {};
    const recentUsedCodes = new Set((config.recentUsedCodes || []).map((value) => String(value || '').trim()).filter(Boolean));
    const maxAttempts = Number(config.maxAttempts);
    const intervalMs = Number(config.intervalMs);

    if (!Number.isFinite(maxAttempts) || !Number.isFinite(intervalMs)) {
      throw new Error('2925 mailbox poll config is invalid.');
    }

    log(`Step ${step}: Waiting for 2925 mailbox UI...`);
    await waitForMailboxReady(30000);
    await ensureInboxSelected();

    log(`Step ${step}: Starting email poll on 2925 mailbox (${maxAttempts} attempts)`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfStopped();

      if (attempt > 1) {
        await refreshMailbox(step, attempt);
      }

      let messages = extractMessagesFromDom();
      if (!messages.length) {
        log(`Step ${step}: Mail rows not ready, waiting once more...`, 'warn');
        await waitForMailboxReady(10000);
        messages = extractMessagesFromDom();
      }

      const matched = pickMatchingMessage(messages, config);
      if (matched?.code) {
        const duplicateMessages = findMessagesByCode(messages, matched.code);
        if (recentUsedCodes.has(matched.code)) {
          log(`Step ${step}: Skipping recently used code ${matched.code}`, 'info');
          await deleteMatchedMessages(duplicateMessages, step);
          continue;
        }
        if (seenCodes.has(matched.code)) {
          log(`Step ${step}: Skipping seen code ${matched.code}`, 'info');
          await deleteMatchedMessages(duplicateMessages, step);
          continue;
        }

        seenCodes.add(matched.code);
        await persistSeenCodes();
        log(`Step ${step}: Code found: ${matched.code}`, 'ok');
        await deleteMatchedMessages(duplicateMessages, step);
        return {
          ok: true,
          code: matched.code,
          emailTimestamp: matched.timestamp || Date.now(),
          messageId: matched.messageId,
        };
      }

      if (attempt < maxAttempts) {
        log(`Step ${step}: No matching code yet, retrying (${attempt}/${maxAttempts})...`, 'warn');
        await sleep(intervalMs);
      }
    }

    log(`Step ${step}: No code found after ${maxAttempts} attempts`, 'warn');
    return { ok: true, code: null, error: null };
  }

  async function waitForMailboxReady(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      throwIfStopped();

      if (isLoginPage()) {
        await sleep(500);
        continue;
      }

      const table = document.querySelector('.maillist-table');
      const container = document.querySelector('.list-container');
      const header = document.querySelector('.mail-header');
      if (table || (container && header)) {
        return;
      }

      await sleep(300);
    }

    throw new Error('2925 邮箱列表页面加载超时，请确认已经进入收件箱。');
  }

  function isLoginPage() {
    return location.pathname.startsWith('/login')
      || Boolean(document.querySelector('input[placeholder*="邮箱账号"], input[placeholder*="手机号"]'));
  }

  async function ensureInboxSelected() {
    const inboxItem = [...document.querySelectorAll('li')].find((node) => (node.textContent || '').trim() === '收件箱');
    if (!inboxItem) {
      return;
    }

    if (!inboxItem.classList.contains('select')) {
      simulateClick(inboxItem);
      await sleep(1200);
    }
  }

  async function refreshMailbox(step, attempt) {
    const refreshButton = findRefreshButton();
    if (!refreshButton) {
      log(`Step ${step}: Refresh button not found, using passive wait (${attempt})`, 'warn');
      return;
    }

    simulateClick(refreshButton);
    log(`Step ${step}: Clicked refresh (${attempt})`, 'info');
    await sleep(1500);
  }

  function findRefreshButton() {
    return [...document.querySelectorAll('.mail-header .tool-common, .mail-header button, .mail-header div')]
      .find((node) => /刷新/.test(node.textContent || '')) || null;
  }

  async function deleteMatchedMessages(messages, step) {
    const rows = [...new Set((messages || []).map((message) => message?.rowElement).filter(Boolean))]
      .filter((row) => row.isConnected);
    if (!rows.length) {
      return;
    }

    try {
      let selectedCount = 0;
      for (const row of rows) {
        const checkboxTarget = findRowCheckboxTarget(row);
        if (!checkboxTarget) {
          continue;
        }
        simulateClick(checkboxTarget);
        selectedCount += 1;
        await sleep(250);
      }

      if (!selectedCount) {
        log(`Step ${step}: Checkbox not found for matched email`, 'warn');
        return;
      }

      log(
        selectedCount > 1
          ? `Step ${step}: Selected ${selectedCount} matched emails by checkbox`
          : `Step ${step}: Selected matched email by checkbox`,
        'info',
      );
      await sleep(500);

      const deleteButton = findDeleteButton();
      if (!deleteButton) {
        log(`Step ${step}: Delete button not found, keeping matched email`, 'warn');
        return;
      }

      simulateClick(deleteButton);
      log(`Step ${step}: Clicked delete for matched email`, 'info');
      await sleep(500);

      const confirmButton = findDeleteConfirmButton();
      if (confirmButton) {
        simulateClick(confirmButton);
        log(`Step ${step}: Confirmed email deletion`, 'info');
        await sleep(900);
      }
    } catch (error) {
      log(`Step ${step}: Failed to delete matched email: ${error.message}`, 'warn');
    }
  }

  function findRowCheckboxTarget(row) {
    return row.querySelector('.check label')
      || row.querySelector('.check .ivu-checkbox')
      || row.querySelector('.check .ivu-checkbox-inner')
      || row.querySelector('.check input[type="checkbox"]');
  }

  function findDeleteButton() {
    return document.querySelector('.mail-header .delete.tool-common[title="删除"]')
      || [...document.querySelectorAll('.mail-header .tool-common, .mail-header button, .mail-header div, button, [role="button"]')]
      .find((node) => {
        const text = cleanText(node.textContent || '');
        return /删除|彻底删除|trash|delete/i.test(text) && !/刷新/.test(text);
      }) || null;
  }

  function findDeleteConfirmButton() {
    return [...document.querySelectorAll('.el-message-box__btns button, .ant-modal-footer button, .dialog-footer button, button, [role="button"]')]
      .find((node) => /确定|确认|删除|是|yes/i.test(cleanText(node.textContent || '')));
  }

  function extractMessagesFromDom() {
    const rows = [...document.querySelectorAll('.maillist-table tbody tr, .maillist-table tr')]
      .filter((row) => row.querySelector('.sender, .mail-content-title, .mail-content'));

    return rows.map((row, index) => {
      const sender = cleanText(row.querySelector('.sender')?.textContent || '');
      const subject = cleanText(row.querySelector('.mail-content-title')?.textContent || row.querySelector('.mail-content')?.textContent || '');
      const preview = cleanText(row.querySelector('.mail-content-text')?.textContent || '');
      const dateText = cleanText(row.querySelector('.date-time-text, .date-time')?.textContent || '');
      const rowText = cleanText(row.innerText || '');
      const timestamp = normalizeTimestamp(dateText);

      return {
        messageId: row.dataset.id || row.getAttribute('data-id') || `${sender}-${subject}-${dateText}-${index}`,
        fromName: sender,
        from: sender,
        subject,
        text: preview,
        bodyContent: rowText,
        toAddress: [rowText],
        date: timestamp || dateText,
        rowElement: row,
      };
    });
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function findMessagesByCode(messages, code) {
    return (messages || []).filter((message) => {
      const extracted = extractVerificationCode(`${message.subject || ''} ${message.text || ''} ${message.bodyContent || ''}`);
      return extracted && extracted === code;
    });
  }

  function pickMatchingMessage(messages, config) {
    const filterAfterTimestamp = Number(config.filterAfterTimestamp || 0);
    const senderFilters = (config.senderFilters || []).map((value) => String(value).toLowerCase());
    const subjectFilters = (config.subjectFilters || []).map((value) => String(value).toLowerCase());
    const targetEmail = String(config.targetEmail || '').toLowerCase();
    const mainEmail = String(config.mainEmail || '').toLowerCase();

    const candidates = messages
      .map((message) => {
        const senderText = `${message.fromName || ''} ${message.from || ''}`.toLowerCase();
        const subjectText = String(message.subject || '').toLowerCase();
        const bodyText = `${message.text || ''} ${message.bodyContent || ''}`.toLowerCase();
        const toList = Array.isArray(message.toAddress) ? message.toAddress : [message.toAddress].filter(Boolean);
        const toText = toList.join(' ').toLowerCase();
        const timestamp = normalizeTimestamp(message.date);
        const combined = `${senderText}\n${subjectText}\n${bodyText}\n${toText}`;
        const code = extractVerificationCode(`${message.subject || ''} ${message.text || ''} ${message.bodyContent || ''}`);

        let score = 0;
        if (matchesAny(senderText, senderFilters)) score += 6;
        if (matchesAny(subjectText, subjectFilters)) score += 6;
        if (/openai|chatgpt/.test(combined)) score += 4;
        if (targetEmail && combined.includes(targetEmail)) score += 6;
        if (mainEmail && combined.includes(mainEmail)) score += 2;
        if (code) score += 4;
        if (timestamp && filterAfterTimestamp && timestamp < filterAfterTimestamp) {
          return null;
        }
        if (timestamp && filterAfterTimestamp) {
          score += 2;
        }

        return {
          ...message,
          timestamp,
          code,
          score,
        };
      })
      .filter(Boolean)
      .filter((message) => message.score > 0)
      .sort((left, right) => right.score - left.score || (right.timestamp || 0) - (left.timestamp || 0));

    return candidates.find((message) => message.code) || null;
  }

  function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }

    const text = cleanText(value);
    if (!text) {
      return 0;
    }

    if (/^\d{10,13}$/.test(text)) {
      const numeric = Number(text);
      return text.length === 13 ? numeric : numeric * 1000;
    }

    if (text === '刚刚') {
      return Date.now();
    }

    let match = text.match(/(\d+)\s*分钟前/);
    if (match) {
      return Date.now() - Number(match[1]) * 60 * 1000;
    }

    match = text.match(/(\d+)\s*小时前/);
    if (match) {
      return Date.now() - Number(match[1]) * 60 * 60 * 1000;
    }

    match = text.match(/昨天\s*(\d{1,2}:\d{2})?/);
    if (match) {
      const base = new Date();
      base.setDate(base.getDate() - 1);
      if (match[1]) {
        const [hours, minutes] = match[1].split(':').map(Number);
        base.setHours(hours || 0, minutes || 0, 0, 0);
      }
      return base.getTime();
    }

    const now = new Date();
    match = text.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);
    if (match) {
      const base = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), 0, 0, 0, 0);
      if (match[3]) {
        const [hours, minutes] = match[3].split(':').map(Number);
        base.setHours(hours || 0, minutes || 0, 0, 0);
      }
      return base.getTime();
    }

    const parsed = Date.parse(text.replace(/-/g, '/'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function matchesAny(text, patterns) {
    return patterns.some((pattern) => pattern && text.includes(pattern));
  }

  function extractVerificationCode(text) {
    const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
    if (matchCn) return matchCn[1];
    const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
    if (matchEn) return matchEn[1] || matchEn[2];
    const match6 = text.match(/\b(\d{6})\b/);
    if (match6) return match6[1];
    return null;
  }

  async function loadSeenCodes() {
    try {
      const data = await chrome.storage.session.get(SEEN_CODES_KEY);
      if (Array.isArray(data[SEEN_CODES_KEY])) {
        seenCodes = new Set(data[SEEN_CODES_KEY]);
      }
    } catch {}
  }

  async function persistSeenCodes() {
    try {
      await chrome.storage.session.set({ [SEEN_CODES_KEY]: [...seenCodes] });
    } catch {}
  }
}






