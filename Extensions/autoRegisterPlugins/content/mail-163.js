// content/mail-163.js — Content script for 163 Mail (steps 4, 7)

const MAIL163_PREFIX = '[AutoRegister:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

let seenCodes = new Set();

async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get('seenCodes');
    if (data.seenCodes && Array.isArray(data.seenCodes)) {
      seenCodes = new Set(data.seenCodes);
    }
  } catch {}
}
loadSeenCodes();

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ seenCodes: [...seenCodes] });
  } catch {}
}

let pollSendResponse = null;

(async function checkAndResume() {
  try {
    const data = await chrome.storage.session.get('mail163PollState');
    if (data.mail163PollState) {
      console.log(MAIL163_PREFIX, `Resuming poll from attempt ${data.mail163PollState.attempt}...`);
      await chrome.storage.session.remove('mail163PollState');

      if (data.mail163PollState.seenCodes) {
        seenCodes = new Set(data.mail163PollState.seenCodes);
      }

      await sleep(3000);

      const state = data.mail163PollState;
      const result = await continuePoll(state);

      if (pollSendResponse) {
        pollSendResponse(result);
      } else {
        chrome.runtime.sendMessage({ type: 'MAIL163_RESULT', payload: result }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Resume check failed:', err.message);
  }
})();

async function continuePoll(state) {
  for (let attempt = state.attempt; attempt <= state.maxAttempts; attempt++) {
    if (attempt > state.attempt) {
      if ((attempt - 1) % 5 === 0 && attempt > 1) {
        console.log(MAIL163_PREFIX, `Refreshing page at attempt ${attempt}...`);
        await chrome.storage.session.set({
          mail163PollState: { ...state, attempt, seenCodes: [...seenCodes] },
        });
        window.location.reload();
        return new Promise(() => {});
      }
      await refreshInbox();
      await sleep(1000);
    }

    const allItems = findMailItems();
    const existingMailIds = new Set(state.existingMailIds || []);
    const useFallback = attempt > 3;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';
      if (existingMailIds.has(id)) continue;

      const code = getMatchingCodeForItem(item, state);
      if (!code) {
        continue;
      }

      const duplicateIds = collectDuplicateItemIds(allItems, state, code);
      const recentUsedCodes = new Set((state.recentUsedCodes || []).map((value) => String(value || '').trim()).filter(Boolean));
      if (recentUsedCodes.has(code)) {
        log(`Step ${state.step}: Skipping recently used code: ${code}`, 'info');
        continue;
      }
      if (seenCodes.has(code)) {
        log(`Step ${state.step}: Skipping seen code: ${code}`, 'info');
        await deleteEmailsByIds(duplicateIds, state.step);
        continue;
      }

      seenCodes.add(code);
      await persistSeenCodes();
      log(`Step ${state.step}: Code found: ${code}`, 'ok');
      await deleteEmailsByIds(duplicateIds, state.step);
      await sleep(1000);
      return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
    }

    if (attempt < state.maxAttempts) {
      await sleep(state.intervalMs);
    }
  }

  log(`Step ${state.step}: No code found after ${state.maxAttempts} attempts`, 'warn');
  return { ok: true, code: null, error: null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    pollSendResponse = sendResponse;

    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function findMailItems() {
  return document.querySelectorAll('div[sign="letter"]');
}

function getCurrentMailIds() {
  const ids = new Set();
  findMailItems().forEach(item => {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
  });
  return ids;
}

function getMatchingCodeForItem(item, state) {
  const sender = (item.querySelector('.nui-user')?.textContent || '').toLowerCase();
  const subject = item.querySelector('span.da0')?.textContent || '';
  const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

  const senderMatch = state.senderFilters.some(filter => sender.includes(filter.toLowerCase()) || ariaLabel.includes(filter.toLowerCase()));
  const subjectMatch = state.subjectFilters.some(filter => subject.toLowerCase().includes(filter.toLowerCase()) || ariaLabel.includes(filter.toLowerCase()));
  if (!senderMatch && !subjectMatch) {
    return null;
  }

  return extractVerificationCode(subject + ' ' + ariaLabel);
}

function collectDuplicateItemIds(items, state, code) {
  const ids = [];
  for (const item of items) {
    const itemId = item.getAttribute('id') || '';
    if (!itemId) {
      continue;
    }
    if (getMatchingCodeForItem(item, state) === code) {
      ids.push(itemId);
    }
  }
  return [...new Set(ids)];
}


async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs, newOnly = false } = payload;
  const recentUsedCodes = Array.isArray(payload.recentUsedCodes) ? payload.recentUsedCodes.map((value) => String(value || '').trim()).filter(Boolean) : [];

  log(`Step ${step}: Starting email poll on 163 Mail (max ${maxAttempts} attempts)`);

  try {
    const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"]', 5000);
    inboxLink.click();
  } catch {
    log(`Step ${step}: Inbox link not found, proceeding...`, 'warn');
  }

  let items = [];
  for (let index = 0; index < 20; index++) {
    items = findMailItems();
    if (items.length > 0) break;
    await sleep(500);
  }

  if (items.length === 0) {
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    throw new Error('163 Mail list did not load.');
  }

  log(`Step ${step}: Mail list loaded, ${items.length} items`);

  const existingMailIds = newOnly ? [...getCurrentMailIds()] : [];
  if (newOnly) {
    log(`Step ${step}: Snapshotted ${existingMailIds.length} existing emails as old before this resend round`);
  }

  const state = {
    step,
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    attempt: 1,
    existingMailIds,
    recentUsedCodes,
  };

  return continuePoll(state);
}

async function deleteEmailsByIds(itemIds, step) {
  const uniqueIds = [...new Set((itemIds || []).filter(Boolean))];
  if (!uniqueIds.length) {
    return;
  }

  if (uniqueIds.length > 1) {
    log(`Step ${step}: Deleting ${uniqueIds.length} emails with the same verification code`, 'info');
  }

  for (const itemId of uniqueIds) {
    const currentItem = document.getElementById(itemId);
    if (!currentItem) {
      continue;
    }
    await deleteEmail(currentItem, step);
    await sleep(500);
  }
}

async function deleteEmail(item, step) {
  try {
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(300);

    const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"]');
    if (trashIcon) {
      trashIcon.click();
      await sleep(1500);
      return;
    }

    const checkbox = item.querySelector('[sign="checkbox"], .nui-chk');
    if (checkbox) {
      checkbox.click();
      await sleep(300);
      const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
      for (const btn of toolbarBtns) {
        if (btn.textContent.replace(/\s/g, '').includes('删除')) {
          btn.closest('.nui-btn').click();
          await sleep(1500);
          return;
        }
      }
    }
  } catch (err) {
    log(`Step ${step}: Failed to delete email: ${err.message}`, 'warn');
  }
}

async function refreshInbox() {
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    if (btn.textContent.replace(/\s/g, '') === '刷新') {
      btn.closest('.nui-btn').click();
      await sleep(800);
      return;
    }
  }
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    if (btn.textContent.replace(/\s/g, '').includes('收信')) {
      btn.click();
      await sleep(800);
      return;
    }
  }
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

}


