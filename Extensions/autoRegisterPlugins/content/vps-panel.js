// content/vps-panel.js — Content script for VPS panel (step 1)
// Injected on: VPS panel (user-configured URL)
//
// Actual DOM structure (after login click):
// <div class="card">
//   <div class="card-header">
//     <span class="OAuthPage-module__cardTitle___yFaP0">Codex OAuth</span>
//     <button class="btn btn-primary"><span>登录</span></button>
//   </div>
//   <div class="OAuthPage-module__cardContent___1sXLA">
//     <div class="OAuthPage-module__authUrlBox___Iu1d4">
//       <div class="OAuthPage-module__authUrlLabel___mYFJB">授权链接:</div>
//       <div class="OAuthPage-module__authUrlValue___axvUJ">https://auth.openai.com/...</div>
//       <div class="OAuthPage-module__authUrlActions___venPj">
//         <button class="btn btn-secondary btn-sm"><span>复制链接</span></button>
//         <button class="btn btn-secondary btn-sm"><span>打开链接</span></button>
//       </div>
//     </div>
//     <div class="OAuthPage-module__callbackSection___8kA31">
//       <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
//       <button class="btn btn-secondary btn-sm"><span>提交回调 URL</span></button>
//     </div>
//   </div>
// </div>

console.log('[MultiPage:vps-panel] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FETCH_OAUTH_URL') {
    resetStopState();

    const task = message.type === 'FETCH_OAUTH_URL'
      ? fetchOAuthUrl(message.payload || {})
      : handleStep(message.step, message.payload);

    task.then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      const step = Number(message.payload?.step) || Number(message.step) || 1;
      if (isStopError(err)) {
        log(`Step ${step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      if (message.type === 'EXECUTE_STEP') {
        reportError(message.step, err.message);
      } else {
        log(`Step ${step}: ${err.message}`, 'error');
      }
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleStep(step) {
  switch (step) {
    case 1: return await step1_getOAuthLink();
    default:
      throw new Error(`vps-panel.js does not handle step ${step}`);
  }
}

async function fetchOAuthUrl(payload = {}) {
  return getOAuthLinkFromPanel({
    step: Number(payload.step) || 1,
    reportCompletion: false,
  });
}

// ============================================================
// Step 1: Get OAuth Link
// ============================================================

async function step1_getOAuthLink() {
  return getOAuthLinkFromPanel({
    step: 1,
    reportCompletion: true,
  });
}

async function getOAuthLinkFromPanel(options = {}) {
  const step = Number(options.step) || 1;
  const stepLabel = `Step ${step}`;
  const reportCompletion = Boolean(options.reportCompletion);

  log(`${stepLabel}: Waiting for VPS panel to load (auto-login may take a moment)...`);

  // The page may start at #/login and auto-redirect to #/oauth.
  // Wait for the Codex OAuth card to appear (up to 30s for auto-login + redirect).
  let loginBtn = null;
  try {
    // Wait for any card-header containing "Codex" to appear
    const header = await waitForElementByText('.card-header', /codex/i, 30000);
    loginBtn = header.querySelector('button.btn.btn-primary, button.btn');
    log(`${stepLabel}: Found Codex OAuth card`);
  } catch {
    throw new Error(
      'Codex OAuth card did not appear after 30s. Page may still be loading or not logged in. ' +
      'Current URL: ' + location.href
    );
  }

  if (!loginBtn) {
    throw new Error('Found Codex OAuth card but no login button inside it. URL: ' + location.href);
  }

  // Check if button is disabled (already clicked / loading)
  if (loginBtn.disabled) {
    log(`${stepLabel}: Login button is disabled (already loading), waiting for auth URL...`);
  } else {
    await humanPause(500, 1400);
    simulateClick(loginBtn);
    log(`${stepLabel}: Clicked login button, waiting for auth URL...`);
  }

  // Wait for the auth URL to appear in the specific div
  let authUrlEl = null;
  try {
    authUrlEl = await waitForElement('[class*="authUrlValue"]', 15000);
  } catch {
    throw new Error(
      'Auth URL did not appear after clicking login. ' +
      'Check if VPS panel is logged in and Codex service is running. URL: ' + location.href
    );
  }

  const oauthUrl = (authUrlEl.textContent || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${oauthUrl.slice(0, 50)}". Expected URL starting with http.`);
  }

  log(`${stepLabel}: OAuth URL obtained: ${oauthUrl.slice(0, 80)}...`, 'ok');
  if (reportCompletion) {
    reportComplete(step, { oauthUrl });
  }
  return { oauthUrl };
}

