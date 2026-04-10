// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// ============================================================
// Retry State Recovery (survives page navigation/reload)
// ============================================================

// Flag to prevent double execution when both checkAndResumeRetry and step3_fillEmailPassword run
let step3AutoResumeActive = false;

// Check if there's a pending retry from a previous page navigation
(async function checkAndResumeRetry() {
  try {
    const data = await chrome.storage.session.get(['step3RetryPending', 'step3Email', 'step3Password']);
    if (data.step3RetryPending) {
      step3AutoResumeActive = true; // Set flag to prevent double execution
      console.log('[MultiPage:signup-page] Detected pending step 3 retry, resuming...');
      await chrome.storage.session.set({ step3RetryPending: false });
      
      // Wait for page to settle
      await sleep(2000);
      
      // Auto-fill email and password, then submit
      const email = data.step3Email;
      const password = data.step3Password;
      
      if (email) {
        const emailInput = document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
        if (emailInput) {
          fillInput(emailInput, email);
          console.log('[MultiPage:signup-page] Resumed: Email filled');
        }
      }
      
      // Find and click continue to get to password page
      await sleep(1000);
      const continueBtn = document.querySelector('button[type="submit"]')
        || await waitForElementByText('button', /continue|next|继续|下一步/i, 5000).catch(() => null);
      
      if (continueBtn) {
        simulateClick(continueBtn);
        console.log('[MultiPage:signup-page] Resumed: Submitted email');
        await sleep(2000);
      }
      
      // Now fill password
      if (password) {
        const passwordInput = document.querySelector('input[type="password"]');
        if (passwordInput) {
          fillInput(passwordInput, password);
          console.log('[MultiPage:signup-page] Resumed: Password filled');
          
          // Submit password
          await sleep(500);
          const submitBtn = document.querySelector('button[type="submit"]')
            || await waitForElementByText('button', /continue|sign\s*up|submit|create/i, 3000).catch(() => null);
          
          if (submitBtn) {
            simulateClick(submitBtn);
            console.log('[MultiPage:signup-page] Resumed: Form submitted');
            reportComplete(2, { email, retryResumed: true });
          }
        }
      }
      
      // Reset flag after completion
      step3AutoResumeActive = false;
    }
  } catch (err) {
    console.warn('[MultiPage:signup-page] Failed to check retry state:', err.message);
    step3AutoResumeActive = false;
  }
})();

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP8_FIND_AND_CLICK') {
    resetStopState();
    handleCommand(message).then((result) => {
      try {
        sendResponse({ ok: true, ...(result || {}) });
      } catch (err) {
        // Channel already closed (page navigated), ignore
        console.log('[MultiPage:signup-page] Message channel closed after response, ignoring');
      }
    }).catch(err => {
      // Check if this is a retry-triggered error
      if (err.message && err.message.startsWith('RETRY_TRIGGERED')) {
        // Retry was triggered, state is saved, don't report as error
        log(`Step ${message.step || 3}: ${err.message}`, 'warn');
        try {
          sendResponse({ retryTriggered: true, error: err.message });
        } catch { /* channel closed, ignore */ }
        return;
      }

      if (isStopError(err)) {
        log(`Step ${message.step || 8}: Stopped by user.`, 'warn');
        try { sendResponse({ stopped: true, error: err.message }); } catch {}
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK') {
        log(`Step 8: ${err.message}`, 'error');
        try { sendResponse({ error: err.message }); } catch {}
        return;
      }

      reportError(message.step, err.message);
      try { sendResponse({ error: err.message }); } catch {}
    });
    return true;
  }
  
  // Handle localhost URL extraction from auth success page
  if (message.type === 'EXTRACT_LOCALHOST_URL') {
    const localhostUrl = extractLocalhostUrlFromPage();
    sendResponse({ localhostUrl });
    return true;
  }
  
  // Handle resend code button click
  if (message.type === 'CLICK_RESEND_CODE') {
    resetStopState();
    clickResendCode().then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log('Resend code: Stopped by user.', 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`Resend code: ${err.message}`, 'error');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

/**
 * Extract localhost callback URL from authentication success page
 */
function extractLocalhostUrlFromPage() {
  // Check if we're on an authentication success page
  const pageText = document.body?.innerText || '';
  
  // Look for localhost URLs in the page
  const localhostMatch = pageText.match(/http:\/\/localhost[^\s"<>]+/);
  if (localhostMatch) {
    log(`Found localhost URL in page content: ${localhostMatch[0]}`, 'info');
    return localhostMatch[0];
  }
  
  // Check for meta refresh redirect
  const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
  if (metaRefresh) {
    const content = metaRefresh.getAttribute('content') || '';
    const metaMatch = content.match(/url=(http:\/\/localhost[^\s"']+)/i);
    if (metaMatch) {
      log(`Found localhost URL in meta refresh: ${metaMatch[1]}`, 'info');
      return metaMatch[1];
    }
  }
  
  // Check for links containing localhost
  const localhostLinks = document.querySelectorAll('a[href*="localhost"]');
  if (localhostLinks.length > 0) {
    const href = localhostLinks[0].href;
    log(`Found localhost URL in link: ${href}`, 'info');
    return href;
  }
  
  // Check for any visible URL in the page (common in success pages)
  const urlElements = document.querySelectorAll('code, pre, .url, .callback-url, [class*="url"], [class*="callback"]');
  for (const el of urlElements) {
    const text = el.textContent?.trim();
    if (text && text.startsWith('http://localhost')) {
      log(`Found localhost URL in element: ${text}`, 'info');
      return text;
    }
  }
  
  log('No localhost URL found in page content', 'warn');
  return null;
}

/**
 * Click resend/resend code button on verification code page
 */
async function clickResendCode() {
  log('Looking for resend验证码 button...');

  // Wait a bit for page to settle
  await sleep(500);

  // Common patterns for resend code buttons:
  // - "重新发送" / "重发" / "Resend" / "Send again"
  // - "没有收到代码？" / "Didn't receive code?"
  // - "重新获取" / "获取新代码"
  const resendBtn = await waitForElementByText(
    'button, a, [role="button"]',
    /重新发送|重发|resend|send.*again|没有收到|didn.*t.*receive|重新获取|获取新代码|resend.*code|send.*new/i,
    8000
  );

  await humanPause(400, 1000);
  simulateClick(resendBtn);
  log(`Clicked resend code button: ${(resendBtn.textContent || '').trim()}`);

  return { clicked: true };
}

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 1: return await step2_clickRegister();
        case 2: return await step3_fillEmailPassword(message.payload);
        case 4: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 8: return await step8_findAndClick();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 3 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'HANDLE_ERROR_RETRY':
      return await handleErrorRetry();
  }
}

// ============================================================
// Error Retry Handler
// ============================================================

async function handleErrorRetry() {
  log('Checking for error page...');

  // Wait a bit for page to settle
  await sleep(500);

  // Check if error page is present
  const errorTitle = await waitForElementByText('h1, [class*="title"]', /糟糕.*出错|error|timed\s*out|operation.*timeout/i, 3000).catch(() => null);
  
  if (!errorTitle) {
    log('No error page detected');
    return { hasError: false };
  }

  log('Error page detected: ' + (errorTitle.textContent || '').trim());

  // Find retry button
  const retryBtn = await waitForElementByText('button', /重试|try\s*again|retry/i, 3000).catch(() => null);
  
  if (!retryBtn) {
    throw new Error('Error page found but no "重试" button available');
  }

  log('Found retry button, clicking...');
  await humanPause(400, 1000);
  simulateClick(retryBtn);
  
  return { hasError: true, retried: true };
}

const STEP3_EMAIL_SELECTOR = 'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]';
const STEP3_PASSWORD_SELECTOR = 'input[type="password"]';
const STEP3_CODE_SELECTOR = 'input[name="code"], input[name="otp"], input[maxlength="1"]';
const STEP3_PRIMARY_SUBMIT_PATTERN = /continue|next|submit|继续|下一步/i;
const STEP3_FINAL_SUBMIT_PATTERN = /continue|sign\s*up|submit|注册|创建|create/i;
const STEP3_VERIFICATION_PATTERN = /检查.*收件箱|check.*inbox|verify.*email|verification\s*code(?:.*sent)?|输入.*验证码/i;
const AUTH_ERROR_PATTERN = /糟糕.*出错|验证过程中出错|invalid_auth_step|operation\s+timed\s+out|something\s+went\s+wrong|we.?re\s+sorry|error/i;
const AUTH_RETRY_BUTTON_PATTERN = /重试|try\s*again|retry/i;

function getStep3ProgressState() {
  const pageText = document.body?.innerText || '';
  return {
    pageText,
    hasCodeInput: Boolean(document.querySelector(STEP3_CODE_SELECTOR)),
    hasNameInput: Boolean(document.querySelector('input[name="name"]')),
    hasCodeText: STEP3_VERIFICATION_PATTERN.test(pageText),
  };
}

function findElementByTextNow(containerSelector, textPattern) {
  const candidates = document.querySelectorAll(containerSelector);
  for (const el of candidates) {
    const ariaLabel = el.getAttribute ? (el.getAttribute('aria-label') || '' ) : '';
    const actionName = el.getAttribute ? (el.getAttribute('data-dd-action-name') || '' ) : '';
    const combinedText = `${el.textContent || ''} ${ariaLabel} ${actionName}`.trim();
    if (combinedText && textPattern.test(combinedText)) {
      return el;
    }
  }
  return null;
}

function findAuthErrorStateNow() {
  const pageText = document.body?.innerText || '';
  const errorTitle = findElementByTextNow(
    'h1, .heading, [class*="title"], [class*="heading"]',
    AUTH_ERROR_PATTERN
  );

  if (!errorTitle && !AUTH_ERROR_PATTERN.test(pageText)) {
    return null;
  }

  return {
    pageText,
    errorTitle,
    retryBtn: findElementByTextNow('button, a, [role="button"]', AUTH_RETRY_BUTTON_PATTERN),
  };
}

async function saveStep3RetryState(payload) {
  try {
    await chrome.storage.session.set({
      step3RetryPending: true,
      step3Email: payload.email,
      step3Password: payload.password,
    });
  } catch (storageErr) {
    log(`Step 2: Failed to save retry state: ${storageErr.message}`, 'warn');
  }
}

async function clearStep3RetryState() {
  try {
    await chrome.storage.session.remove(['step3RetryPending', 'step3Email', 'step3Password']);
  } catch (storageErr) {
    log(`Step 2: Failed to clear retry state: ${storageErr.message}`, 'warn');
  }
}

async function waitForStep3SurfaceAfterRetry(timeout = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();

    const emailInput = document.querySelector(STEP3_EMAIL_SELECTOR);
    if (emailInput) {
      return { emailInput };
    }

    const passwordInput = document.querySelector(STEP3_PASSWORD_SELECTOR);
    if (passwordInput) {
      return { passwordInput };
    }

    const progressState = getStep3ProgressState();
    if (progressState.hasCodeInput || progressState.hasNameInput || progressState.hasCodeText) {
      return { verificationReached: true };
    }

    await sleep(250);
  }

  return null;
}

async function maybeRecoverStep3ErrorPage(payload, context) {
  const errorState = findAuthErrorStateNow();
  if (!errorState) {
    return null;
  }

  const titleText = (errorState.errorTitle?.textContent || '' ).trim() || 'authentication error page';
  log(`Step 2: Error page detected ${context}: "${titleText}"`, 'warn');

  if (!errorState.retryBtn) {
    throw new Error(`Step 2: Error page detected ${context} but no retry button was found. URL: ${location.href}`);
  }

  await saveStep3RetryState(payload);

  await humanPause(350, 900);
  simulateClick(errorState.retryBtn);
  log(`Step 2: Retry clicked ${context}, waiting for the form to recover...`, 'warn');

  const recovered = await waitForStep3SurfaceAfterRetry(5000).catch(() => null);
  if (recovered) {
    await clearStep3RetryState();
    if (recovered.passwordInput) {
      log('Step 2: Retry recovered to the password page in the same document.', 'ok');
    } else if (recovered.emailInput) {
      log('Step 2: Retry recovered to the email page in the same document.', 'ok');
    } else if (recovered.verificationReached) {
      log('Step 2: Retry landed on the verification page.', 'info');
    }
    return recovered;
  }

  if (findAuthErrorStateNow()) {
    throw new Error(`Step 2: Retry was clicked ${context}, but the auth page stayed on the error screen. URL: ${location.href}`);
  }

  return null;
}

async function waitForStep3StartSurface(payload, timeout = 10000) {
  log(`Waiting for selector: ${STEP3_EMAIL_SELECTOR}...`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();

    const passwordInput = document.querySelector(STEP3_PASSWORD_SELECTOR);
    if (passwordInput) {
      await clearStep3RetryState();
      log(`Found element: ${STEP3_PASSWORD_SELECTOR}`);
      return { passwordInput };
    }

    const emailInput = document.querySelector(STEP3_EMAIL_SELECTOR);
    if (emailInput) {
      await clearStep3RetryState();
      log(`Found element: ${STEP3_EMAIL_SELECTOR}`);
      return { emailInput };
    }

    const progressState = getStep3ProgressState();
    if (progressState.hasCodeInput || progressState.hasNameInput || progressState.hasCodeText) {
      await clearStep3RetryState();
      return { verificationReached: true };
    }

    const recovered = await maybeRecoverStep3ErrorPage(payload, 'while waiting for the email field');
    if (recovered) {
      return recovered;
    }

    await sleep(250);
  }

  throw new Error('Could not find email input field on signup page. URL: ' + location.href);
}

async function waitForPasswordFieldOrTransition(payload, timeout = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();

    const passwordInput = document.querySelector(STEP3_PASSWORD_SELECTOR);
    if (passwordInput) {
      await clearStep3RetryState();
      return { passwordInput };
    }

    const progressState = getStep3ProgressState();
    if (progressState.hasCodeInput || progressState.hasNameInput || progressState.hasCodeText) {
      await clearStep3RetryState();
      return { verificationReached: true };
    }

    const recovered = await maybeRecoverStep3ErrorPage(payload, 'after submitting the email step');
    if (recovered) {
      return recovered;
    }

    if (Date.now() - startedAt >= 2500) {
      const emailInput = document.querySelector(STEP3_EMAIL_SELECTOR);
      if (emailInput) {
        await clearStep3RetryState();
        return { emailInput };
      }
    }

    await sleep(250);
  }

  throw new Error(`Could not find password input after submitting email. URL: ${location.href}`);
}

// ============================================================
// Step 1: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 1: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  await humanPause(450, 1200);
  reportComplete(1);
  simulateClick(registerBtn);
  log('Step 1: Clicked Register button');
}

// ============================================================
// Step 2: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  // Wait if auto-resume is in progress (checkAndResumeRetry is running)
  if (step3AutoResumeActive) {
    log('Step 2: Auto-resume in progress, waiting for it to complete...', 'info');
    let waitCount = 0;
    while (step3AutoResumeActive && waitCount < 30) {
      await sleep(500);
      waitCount++;
    }

    const progressState = getStep3ProgressState();
    if (progressState.hasCodeInput || progressState.hasNameInput || progressState.hasCodeText) {
      log('Step 2: Already past step 2 after auto-resume, skipping', 'info');
      await clearStep3RetryState();
      reportComplete(2, { email, skipped: true });
      return;
    }
  }

  // Check if we're already past step 2 (e.g., on verification code page or name page)
  const progressState = getStep3ProgressState();
  if (progressState.hasCodeInput || progressState.hasNameInput || progressState.hasCodeText) {
    log('Step 2: Already past step 2 (on verification or name page), skipping', 'info');
    await clearStep3RetryState();
    reportComplete(2, { email, skipped: true });
    return;
  }

  log(`Step 2: Filling email: ${email}`);

  const startSurface = await waitForStep3StartSurface(payload, 10000);
  if (startSurface.verificationReached) {
    log('Step 2: Reached verification page before entering credentials, skipping', 'info');
    await clearStep3RetryState();
    reportComplete(2, { email, skipped: true });
    return;
  }

  let emailInput = startSurface.emailInput || null;
  let passwordInput = startSurface.passwordInput || document.querySelector(STEP3_PASSWORD_SELECTOR);

  if (emailInput) {
    await humanPause(500, 1400);
    fillInput(emailInput, email);
    log('Step 2: Email filled');
  } else if (passwordInput) {
    log('Step 2: Password field already visible, skipping email entry.', 'info');
  }

  if (!passwordInput) {
    const maxSubmitAttempts = 2;

    for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
      if (!emailInput) {
        const retrySurface = await waitForStep3StartSurface(payload, 5000);
        if (retrySurface.verificationReached) {
          log('Step 2: Redirected to verification page, password will be handled later', 'info');
          await clearStep3RetryState();
          reportComplete(2, { email, skippedPassword: true });
          return;
        }

        emailInput = retrySurface.emailInput || null;
        passwordInput = retrySurface.passwordInput || document.querySelector(STEP3_PASSWORD_SELECTOR);
        if (passwordInput) {
          break;
        }
        if (!emailInput) {
          throw new Error('Could not find email input field on signup page. URL: ' + location.href);
        }
      }

      if (attempt > 1) {
        await humanPause(500, 1400);
        fillInput(emailInput, email);
        log(`Step 2: Email refilled after retry (attempt ${attempt})`, 'warn');
      }

      log(
        attempt === 1
          ? 'Step 2: No password field yet, submitting email first...'
          : `Step 2: Still on email page after retry, submitting email again (attempt ${attempt})...`,
        attempt === 1 ? 'info' : 'warn'
      );

      const submitBtn = document.querySelector('button[type="submit"]')
        || await waitForElementByText('button', STEP3_PRIMARY_SUBMIT_PATTERN, 5000).catch(() => null);

      if (!submitBtn) {
        throw new Error('Could not find submit button to proceed to password field. URL: ' + location.href);
      }

      await humanPause(400, 1100);
      simulateClick(submitBtn);
      log('Step 2: Submitted email, waiting for password field...');

      const nextSurface = await waitForPasswordFieldOrTransition(payload, 10000);
      if (nextSurface.passwordInput) {
        passwordInput = nextSurface.passwordInput;
        log(`Step 2: Password field found on attempt ${attempt}`);
        break;
      }

      if (nextSurface.verificationReached) {
        log('Step 2: Redirected to email verification page, password will be on next step', 'info');
        await clearStep3RetryState();
        reportComplete(2, { email, skippedPassword: true });
        return;
      }

      if (nextSurface.emailInput && attempt < maxSubmitAttempts) {
        emailInput = nextSurface.emailInput;
        log('Step 2: Retry returned to the email page, preparing another submit attempt...', 'warn');
        continue;
      }

      throw new Error(`Could not find password input after submitting email. URL: ${location.href}`);
    }

    if (!passwordInput) {
      throw new Error(`Could not find password input after ${maxSubmitAttempts} attempts. URL: ${location.href}`);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 2 requires a generated password.');
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('Step 2: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  await clearStep3RetryState();
  reportComplete(2, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', STEP3_FINAL_SUBMIT_PATTERN, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('Step 2: Form submitted');
  }

  // DO NOT do any further waiting/checking after submit — page navigation kills the connection
  // Error retry logic is handled before submit while the page is still stable enough to recover
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleep(1000);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 6: Email filled');

  // Submit email
  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  let passwordInput = null;
  try {
    passwordInput = await waitForElement('input[type="password"]', 30000);
  } catch {
    throw new Error('Step 6: Password field did not appear within 30s.');
  }

  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }

    // Wait for page transition and check for errors
    await sleep(2000);
    
    // Check for error page (Operation timed out)
    const errorTitle = await waitForElementByText('h1, [class*="title"]', /糟糕.*出错|error|timed\s*out|operation.*timeout/i, 3000).catch(() => null);
    
    if (errorTitle) {
      log('Step 6: Error page detected after password submit', 'warn');
      
      // Find and click retry button
      const retryBtn = await waitForElementByText('button', /重试|try\s*again|retry/i, 5000).catch(() => null);
      
      if (retryBtn) {
        log('Step 6: Clicking retry button...', 'warn');
        await humanPause(400, 1000);
        simulateClick(retryBtn);
        
        // Wait for retry to take effect
        await sleep(3000);
        
        // After retry, check if we need to resubmit password
        const passwordInput = document.querySelector('input[type="password"]');
        if (passwordInput && !passwordInput.value) {
          log('Step 6: Back on password form after retry, resubmitting...', 'info');
          // Refill password and submit
          await humanPause(550, 1450);
          fillInput(passwordInput, password);
          
          await sleep(500);
          const submitBtnAfterRetry = document.querySelector('button[type="submit"]')
            || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
          
          if (submitBtnAfterRetry) {
            await humanPause(450, 1200);
            simulateClick(submitBtnAfterRetry);
            log('Step 6: Resubmitted password after retry');
          }
        }
      } else {
        throw new Error('Step 6: Error page appeared but no retry button found');
      }
    }
    
    return;
  }

}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('Step 8: Checking whether phone number is required before looking for consent button...');
  assertPhoneNotRequired();
  log('Step 8: Looking for OAuth consent "继续" button...');

  let continueBtn = await findContinueButton();
  continueBtn = await waitForButtonEnabled(continueBtn);

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  continueBtn.focus();
  await sleep(300);

  const rect = getSerializableRect(continueBtn);
  log('Step 8: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

async function findContinueButton(timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    assertPhoneNotRequired();
    const candidate = findBestContinueButtonNow();
    if (candidate) {
      log(`Found element: ${describeContinueButton(candidate)}`);
      return candidate;
    }
    await sleep(150);
  }
  throw new Error('Could not find visible "继续" button on OAuth consent page. URL: ' + location.href);
}

async function waitForButtonEnabled(button, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    assertPhoneNotRequired();
    const latest = findBestContinueButtonNow() || button;
    if (isButtonEnabled(latest)) return latest;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function assertPhoneNotRequired() {
  if (hasPhoneRequiredNoticeNow()) {
    log('Step 8: Detected phone number required prompt.', 'warn');
    throw new Error('Step 8 检测到“电话号码是必填项”');
  }
}

function hasPhoneRequiredNoticeNow() {
  const text = document.body?.innerText || '';
  return /电话号码是必填项|手机号是必填项|phone number is required/i.test(text);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function findBestContinueButtonNow() {
  const exactSelector = 'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107';
  const candidates = [
    ...document.querySelectorAll(`${exactSelector}, button[type="submit"], button, [role="button"]`),
  ].filter((node, index, list) => list.indexOf(node) === index);

  const scored = candidates
    .filter((node) => {
      const combined = `${node.textContent || ''} ${node.getAttribute('data-dd-action-name') || ''} ${node.getAttribute('aria-label') || ''}`;
      return node.matches(exactSelector) || /继续|continue/i.test(combined);
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const area = rect ? rect.width * rect.height : 0;
      let score = area;
      if (node.matches(exactSelector)) score += 500000;
      if (node.getAttribute('data-dd-action-name') === 'Continue') score += 200000;
      if (node.type === 'submit') score += 100000;
      if (isButtonEnabled(node)) score += 50000;
      if (isElementActuallyVisible(node)) score += 25000;
      return { node, score, area };
    })
    .filter((item) => item.area > 0 || isElementActuallyVisible(item.node))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.node || null;
}

function describeContinueButton(button) {
  const actionName = button.getAttribute('data-dd-action-name') || '';
  const label = (button.textContent || '').trim();
  return actionName ? `button[data-dd-action-name="${actionName}"]` : `button(${label || 'continue'})`;
}

function isElementActuallyVisible(node) {
  if (!node || !node.isConnected) return false;
  const style = window.getComputedStyle(node);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
    return false;
  }
  return Boolean(node.getClientRects().length);
}

function clampPoint(value, min, max) {
  if (max <= min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function resolveClickablePoint(node, rect) {
  const viewportMaxX = Math.max(1, window.innerWidth - 2);
  const viewportMaxY = Math.max(1, window.innerHeight - 2);
  const candidates = [
    [0.5, 0.5],
    [0.38, 0.5],
    [0.62, 0.5],
    [0.5, 0.38],
    [0.5, 0.62],
    [0.25, 0.5],
    [0.75, 0.5],
  ];

  for (const [xRatio, yRatio] of candidates) {
    const x = clampPoint(rect.left + (rect.width * xRatio), 1, viewportMaxX);
    const y = clampPoint(rect.top + (rect.height * yRatio), 1, viewportMaxY);
    const hit = document.elementFromPoint(x, y);
    if (hit === node || node.contains(hit)) {
      return { x, y };
    }
  }

  return {
    x: clampPoint(rect.left + (rect.width / 2), 1, viewportMaxX),
    y: clampPoint(rect.top + (rect.height / 2), 1, viewportMaxY),
  };
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  const point = resolveClickablePoint(el, rect);

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: point.x,
    centerY: point.y,
  };
}

// ============================================================
// Step 4: Fill Name & Birthday / Age
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step 4: Filling name: ${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      30000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`Step 4: Name filled: ${fullName}`);

  let birthdayMode = false;
  let ageInput = null;
  let hiddenBirthday = null;

  for (let i = 0; i < 100; i++) {
    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');

    // Important: some pages include a hidden birthday input even when the real UI is "age".
    // In that case we must prioritize filling age to satisfy required validation.
    if (ageInput) break;

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('Birthday field detected, but no birthday data provided.');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 4: Birthday fields detected, filling birthday...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 4: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 4: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step 4: Age filled: ${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 4: Hidden birthday input set (age mode): ${dateStr}`);
    }
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(4);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log('Step 4: Clicked "完成帐户创建"');
  }
}



