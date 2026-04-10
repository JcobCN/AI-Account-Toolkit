// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)

const QQ_MAIL_PREFIX = '[AutoRegister:qq-mail]';
const isTopFrame = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs, newOnly = false } = payload;
  const recentUsedCodes = new Set((payload.recentUsedCodes || []).map((value) => String(value || '').trim()).filter(Boolean));

  log(`Step ${step}: Starting email poll (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`Step ${step}: Mail list loaded`);
  } catch {
    throw new Error('Mail list did not load. Make sure QQ Mail inbox is open.');
  }

  const existingMailIds = newOnly ? getCurrentMailIds() : new Set();
  if (newOnly) {
    log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails as old before this resend round`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling QQ Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(800);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');

    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');

      if (newOnly && existingMailIds.has(mailId)) continue;

      const sender = (item.querySelector('.cmp-account-nick')?.textContent || '').toLowerCase();
      const subject = (item.querySelector('.mail-subject')?.textContent || '').toLowerCase();
      const digest = item.querySelector('.mail-digest')?.textContent || '';

      const senderMatch = senderFilters.some(filter => sender.includes(filter.toLowerCase()));
      const subjectMatch = subjectFilters.some(filter => subject.includes(filter.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + digest);
        if (!code) {
          continue;
        }
        if (recentUsedCodes.has(code)) {
          log(`Step ${step}: Skipping recently used code ${code}`, 'info');
          continue;
        }
        log(`Step ${step}: Code found: ${code} (subject: ${subject.slice(0, 40)})`, 'ok');
        return { ok: true, code, emailTimestamp: Date.now(), mailId };
      }
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  log(`Step ${step}: No new matching email found after ${maxAttempts} attempts, returning no code`, 'warn');
  return { ok: true, code: null, error: null };
}

async function refreshInbox() {
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleep(500);
    return;
  }

  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    console.log(QQ_MAIL_PREFIX, 'Clicked sidebar inbox');
    await sleep(500);
    return;
  }

  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    console.log(QQ_MAIL_PREFIX, 'Clicked toolbar folder name');
    await sleep(500);
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



