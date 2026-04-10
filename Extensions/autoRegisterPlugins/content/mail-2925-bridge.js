(() => {
  if (window.__AUTO_REGISTER_2925_BRIDGE_INSTALLED) {
    return;
  }

  window.__AUTO_REGISTER_2925_BRIDGE_INSTALLED = true;

  const BRIDGE_SOURCE = 'auto-register-2925-bridge';

  window.addEventListener('message', async (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE || data.direction !== 'content-to-page') {
      return;
    }

    try {
      let result;
      switch (data.action) {
        case 'FETCH_MAIL_LIST':
          result = await fetchMailList(data.payload || {});
          break;
        default:
          throw new Error(`Unknown bridge action: ${data.action}`);
      }

      window.postMessage({
        source: BRIDGE_SOURCE,
        direction: 'page-to-content',
        requestId: data.requestId,
        ok: true,
        result,
      }, '*');
    } catch (error) {
      window.postMessage({
        source: BRIDGE_SOURCE,
        direction: 'page-to-content',
        requestId: data.requestId,
        ok: false,
        error: error?.message || String(error),
      }, '*');
    }
  });

  async function fetchMailList(payload) {
    if (!payload.mainEmail) {
      throw new Error('2925 主邮箱缺失。');
    }

    if (isLoginPage()) {
      throw new Error('2925 邮箱未登录，请先在浏览器中登录主邮箱账号。');
    }

    const store = findVueStore();
    if (!store?.dispatch) {
      throw new Error('未找到 2925 页面 store，请确认页面已进入收件箱。');
    }

    const mailboxCandidates = [...new Set([
      String(payload.mainEmail || '').trim(),
      String(payload.mainEmail || '').trim().split('@')[0],
    ].filter(Boolean))];

    let lastError = null;

    for (const mailBox of mailboxCandidates) {
      try {
        const response = await store.dispatch('getMailListApi', {
          Folder: 'Inbox',
          MailBox: mailBox,
          FilterType: 0,
          PageIndex: 1,
          PageCount: payload.pageCount || 50,
        });

        if (response?.code === 200) {
          return {
            mailbox: mailBox,
            messages: normalizeMessages(response.result?.pageData || []),
          };
        }

        lastError = new Error(response?.message || `2925 邮件列表接口返回异常 code=${response?.code}`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('2925 邮件列表接口调用失败。');
  }

  function isLoginPage() {
    return location.pathname.startsWith('/login')
      || Boolean(document.querySelector('input[placeholder*="邮箱账号"], input[placeholder*="手机号"]'));
  }

  function findVueStore() {
    const root = document.querySelector('#app') || document.body;
    if (!root) {
      return null;
    }

    const queue = [root];
    const visited = new Set();

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visited.has(node)) {
        continue;
      }
      visited.add(node);

      const vueInstance = node.__vue__;
      if (vueInstance?.$store) {
        return vueInstance.$store;
      }

      if (node.children) {
        for (const child of node.children) {
          queue.push(child);
        }
      }
    }

    return null;
  }

  function normalizeMessages(pageData) {
    return pageData.map((item) => ({
      messageId: item.messageId,
      folder: item.folder,
      subject: item.subject || '',
      text: item.text || '',
      bodyContent: item.text || '',
      fromName: item.fromName || '',
      from: item.from || '',
      toAddress: Array.isArray(item.to)
        ? item.to
        : String(item.to || '')
          .split(/\s+/)
          .map((value) => value.trim())
          .filter(Boolean),
      date: item.date,
      isAttachment: item.isAttachment,
    }));
  }
})();
