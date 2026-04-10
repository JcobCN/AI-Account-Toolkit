const path = require('path');
const fs = require('fs');
const { SMSProvider } = require('./src/smsProvider');
const { MailProvider } = require('./src/mailProvider');
const { BrowserService } = require('./src/browserService');
const { OAuthService } = require('./src/oauthService');
const { generateRandomName, generateRandomPassword } = require('./src/randomIdentity');
const config = require('./src/config');

// 命令行参数
const args = process.argv.slice(2);
const PHASE2_ONLY = args.includes('--phase2');
const TARGET_COUNT = parseInt(args.find(a => /^\d+$/.test(a)) || '1', 10);
const ACCOUNTS_FILE = path.join(process.cwd(), 'accounts.json');

/**
 * 生成随机用户数据
 */
function generateUserData() {
    const fullName = generateRandomName();
    const password = generateRandomPassword();

    const age = 25 + Math.floor(Math.random() * 16);
    const birthYear = new Date().getFullYear() - age;
    const birthMonth = 1 + Math.floor(Math.random() * 12);
    const birthDay = 1 + Math.floor(Math.random() * 28);
    const birthDate = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;

    return { fullName, password, age, birthDate, birthMonth, birthDay, birthYear };
}

/**
 * 从邮箱中轮询获取验证码
 */
async function pollEmailCode(mailProvider, maxAttempts = 30, interval = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[Mail] 轮询邮箱验证码... (${attempt}/${maxAttempts})`);

        try {
            const mails = await mailProvider.getMails(5, 0);
            if (mails.length > 0) {
                const latest = mails[0];
                const raw = latest.raw || '';

                // 从 MIME 原始邮件中提取正文（跳过邮件头）
                // 正文在 Content-Transfer-Encoding 之后的空行后面
                // 或者在 HTML 内容中查找验证码
                let body = raw;

                // 尝试提取 HTML/text 正文（在最后一个 boundary 后）
                const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
                if (htmlMatch) {
                    body = htmlMatch[1];
                } else {
                    // 没有 HTML，取最后一段（通常是正文）
                    const parts = raw.split(/\r?\n\r?\n/);
                    if (parts.length > 1) {
                        body = parts.slice(Math.max(1, parts.length - 3)).join('\n');
                    }
                }

                // 方法1：找 "code" / "验证码" / "verification" 附近的6位数字
                const codePatterns = [
                    /(?:code|验证码|verification|verify)[^\d]{0,30}(\d{6})/i,
                    /(\d{6})[^\d]{0,30}(?:code|验证码|verification)/i,
                    />\s*(\d{6})\s*</,  // HTML 标签之间的6位数字
                ];
                for (const pattern of codePatterns) {
                    const match = body.match(pattern);
                    if (match) {
                        console.log(`[Mail] 收到验证码: ${match[1]} (pattern: ${pattern.source.substring(0, 30)})`);
                        return match[1];
                    }
                }

                // 方法2：兜底 - 在正文中找任何6位数字（排除明显的非验证码）
                const allSixDigits = body.match(/\b(\d{6})\b/g) || [];
                const filtered = allSixDigits.filter(d => !raw.includes(`t=${d}`) && !raw.includes(`x=${d}`));
                if (filtered.length > 0) {
                    console.log(`[Mail] 收到验证码 (兜底): ${filtered[0]}`);
                    return filtered[0];
                }

                console.log(`[Mail] 邮件已收到但未提取到验证码，正文前200字: ${body.substring(0, 200)}`);
            }
        } catch (error) {
            console.error(`[Mail] 查询出错: ${error.message}`);
        }

        await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`邮箱验证码超时（等待 ${(maxAttempts * interval) / 1000} 秒）`);
}

/**
 * 保存已注册账号到 accounts.json
 */
function saveAccount(phone, password, name, birthDate) {
    let accounts = [];
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) {}
    }
    accounts.push({
        phone, password, name, birthDate,
        createdAt: new Date().toISOString(),
        status: 'registered',
    });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    console.log(`[账号] 已保存到 accounts.json (共 ${accounts.length} 个)`);
}

/**
 * 加载一个未完成 OAuth 的账号
 */
function loadAccount() {
    if (!fs.existsSync(ACCOUNTS_FILE)) return null;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const available = accounts.find(a => a.status === 'registered' && a.password);
    return available || null;
}

/**
 * 更新账号状态
 */
function updateAccountStatus(phone, status) {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const account = accounts.find(a => a.phone === phone);
    if (account) {
        account.status = status;
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    }
}

/**
 * 第一阶段：用手机号注册 ChatGPT
 */
async function phase1(smsProvider, browserService, userData) {
    console.log('\n=========================================');
    console.log('[阶段1] 开始 ChatGPT 手机号注册流程');
    console.log('=========================================');

    // 1. 先导航到注册页面（不花钱，失败了可以直接重试）
    await browserService.navigateToSignup();

    // 2. 浏览器就绪后，才获取手机号（花钱操作尽量靠后）
    await smsProvider.getNumber(config.heroSmsService, config.heroSmsCountry);
    await smsProvider.markReady();

    let numberUsed = false;

    try {
        // 3. 选择英国 +44 并输入手机号（去掉 +44 前缀）
        await browserService.selectCountry('44', '英国', 'GB');
        const localNumber = smsProvider.getPhone().replace(/^\+44/, '');
        await browserService.enterPhone(localNumber);
        numberUsed = true;

        // 4. 完成注册资料（密码、验证码、姓名、生日等）
        // 当页面需要 SMS 验证码时，通过回调获取
        await browserService.completeProfile(userData, async () => {
            console.log('[阶段1] 页面需要 SMS 验证码，开始轮询...');
            const code = await smsProvider.pollForCode({
                interval: 5000,
                maxAttempts: 60,
            });
            return code;
        });

        // 6. 完成 SMS 激活
        await smsProvider.complete();

        // 7. 保存账号信息
        saveAccount(smsProvider.getPhone(), userData.password, userData.fullName, userData.birthDate);

        console.log('[阶段1] ChatGPT 注册流程完成！');
        return true;

    } catch (error) {
        if (!numberUsed) {
            console.error('[阶段1] 流程失败，取消号码退款...');
            await smsProvider.cancel();
        } else {
            await smsProvider.complete().catch(() => {});
        }
        throw error;
    }
}

/**
 * 第 1.5 阶段：首次登录 chatgpt.com 完成 about-you
 */
async function phase1_5(smsProvider, browserService, userData) {
    console.log('\n=========================================');
    console.log('[阶段1.5] 首次登录 chatgpt.com 完成个人资料');
    console.log('=========================================');

    await browserService.loginAndCompleteProfile({
        phone: smsProvider.getPhone(),
        password: userData.password,
        fullName: userData.fullName,
        birthDate: userData.birthDate,
    });

    console.log('[阶段1.5] 完成！');
}

/**
 * 第二阶段：Codex OAuth 授权
 */
async function phase2(smsProvider, mailProvider, browserService, oauthService, userData) {
    console.log('\n=========================================');
    console.log('[阶段2] 开始 Codex OAuth 授权流程');
    console.log('=========================================');

    // 1. 创建临时邮箱
    await mailProvider.createAddress();
    console.log(`[阶段2] 邮箱: ${mailProvider.getEmail()}`);

    // 2. 重新生成 PKCE 参数
    oauthService.regeneratePKCE();
    const authUrl = oauthService.getAuthUrl();
    console.log(`[阶段2] OAuth URL: ${authUrl.substring(0, 100)}...`);

    // 3. 导航到 OAuth 页面
    await browserService.navigateToOAuth(authUrl);

    // 4. 一站式登录 + 授权（循环检测页面状态，自动处理每一步）
    const callbackUrl = await browserService.oauthLoginAndAuthorize({
        phone: smsProvider.getPhone(),
        email: mailProvider.getEmail(),
        password: userData.password,
        fullName: userData.fullName,
        age: userData.age,
        birthDate: userData.birthDate,
        redirectUri: oauthService.redirectUri,
        onSmsNeeded: async () => {
            console.log('[阶段2] 需要 SMS 验证码...');
            return await smsProvider.pollForCode({ interval: 5000, maxAttempts: 30 });
        },
        onEmailCodeNeeded: async () => {
            console.log('[阶段2] 需要邮箱验证码...');
            return await pollEmailCode(mailProvider);
        },
    });

    console.log(`[阶段2] 回调 URL: ${callbackUrl}`);

    // 5. 提取授权参数
    const params = oauthService.extractCallbackParams(callbackUrl);
    if (!params || params.error) {
        throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
    }
    if (!params.code) {
        throw new Error('回调 URL 中未找到授权码');
    }

    console.log(`[阶段2] 成功获取授权码: ${params.code.substring(0, 10)}...`);

    // 6. 用授权码换取 Token
    const tokenData = await oauthService.exchangeTokenAndSave(params.code, mailProvider.getEmail());
    return tokenData;
}

/**
 * 单次注册流程
 */
async function runSingleRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次全新的注册与授权流程');
    console.log('=========================================');

    const smsProvider = new SMSProvider(config.heroSmsApiKey);
    const mailProvider = new MailProvider({
        baseUrl: config.mailBaseUrl,
        adminPassword: config.mailAdminPassword,
        sitePassword: config.mailSitePassword,
        domain: config.mailDomain,
    });
    const proxy = config.proxyHost ? {
        host: config.proxyHost,
        port: config.proxyPort,
        username: config.proxyUsername,
        password: config.proxyPassword,
    } : null;
    const browserService = new BrowserService(proxy);
    const oauthService = new OAuthService();

    try {
        await browserService.launch();

        if (PHASE2_ONLY) {
            // --phase2 模式：使用已注册的账号跑 Phase 1.5 + Phase 2
            const account = loadAccount();
            if (!account) {
                throw new Error('accounts.json 中没有可用账号，请先跑完整流程注册');
            }
            console.log(`[主程序] Phase2 模式: 使用账号 ${account.phone} (${account.name})`);
            smsProvider.phoneNumber = account.phone;
            const userData = {
                fullName: account.name,
                password: account.password,
                birthDate: account.birthDate,
                age: new Date().getFullYear() - parseInt(account.birthDate),
            };

            // 先完成首次登录 about-you
            await phase1_5(smsProvider, browserService, userData);

            const tokenData = await phase2(smsProvider, mailProvider, browserService, oauthService, userData);
            updateAccountStatus(account.phone, 'oauth_done');
            console.log('[主程序] Phase2 完成！');
            console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
            return true;
        }

        // 正常模式：Phase 1 + Phase 1.5 + Phase 2
        const userData = generateUserData();
        console.log(`[主程序] 用户: ${userData.fullName}, 年龄: ${userData.age}, 生日: ${userData.birthDate}`);

        // 1. 第一阶段：手机号注册
        await phase1(smsProvider, browserService, userData);

        // 1.5. 首次登录完成个人资料
        await phase1_5(smsProvider, browserService, userData);

        // 2. 第二阶段：OAuth 授权
        const tokenData = await phase2(smsProvider, mailProvider, browserService, oauthService, userData);

        updateAccountStatus(smsProvider.getPhone(), 'oauth_done');
        console.log('[主程序] 本次注册流程圆满结束！');
        console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
        return true;

    } catch (error) {
        console.error('[主程序] 本次任务执行失败:', error.message);
        throw error;
    } finally {
        await browserService.close();
    }
}

/**
 * 检查 token 数量
 */
async function checkTokenCount() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) return 0;
    return fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json')).length;
}

/**
 * 归档已有 tokens
 */
function archiveExistingTokens() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) return;
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
    for (const file of files) {
        fs.renameSync(path.join(outputDir, file), path.join(outputDir, `old_${file}`));
        console.log(`[归档] ${file} → old_${file}`);
    }
}

/**
 * 启动批量注册
 */
async function startBatch() {
    console.log(`[启动] Codex 远程注册机（手机号 + Puppeteer 模式），目标: ${TARGET_COUNT}`);

    if (!config.heroSmsApiKey) {
        console.error('[错误] 未配置 heroSmsApiKey');
        process.exit(1);
    }
    if (!config.mailAdminPassword) {
        console.error('[错误] 未配置 mailAdminPassword');
        process.exit(1);
    }

    archiveExistingTokens();

    while (true) {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            console.log(`\n[完成] Token 数量 (${currentCount}) 已达目标 (${TARGET_COUNT})。`);
            break;
        }

        console.log(`\n[进度] ${currentCount} / ${TARGET_COUNT}`);

        try {
            await runSingleRegistration();
        } catch (error) {
            console.error('[主程序] 注册失败，30 秒后重试...');
            await new Promise(r => setTimeout(r, 30000));
        }
    }
}

startBatch().catch(console.error);
