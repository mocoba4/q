const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

// Configuration
const CONFIG = {
    url: process.env.TARGET_URL,
    loginUrl: process.env.LOGIN_URL,
    targetPhrase: 'Looks like all tasks were picked up before you',
    email: process.env.CG_EMAIL,
    password: process.env.CG_PASSWORD,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    ntfyTopic: process.env.NTFY_TOPIC,
};

async function sendTelegramAlert(message, imageBuffer) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
        console.error('Missing Telegram configuration');
        return;
    }

    try {
        if (imageBuffer) {
            const form = new FormData();
            form.append('chat_id', CONFIG.telegramChatId);
            form.append('caption', message);
            form.append('photo', imageBuffer, 'screenshot.png');

            await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
            console.log('Telegram photo sent.');
        } else {
            await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
                chat_id: CONFIG.telegramChatId,
                text: message
            });
            console.log('Telegram text sent.');
        }
    } catch (error) {
        console.error('Failed to send Telegram alert:', error.message);
    }
}

async function sendNtfyAlert(message, imageBuffer) {
    if (!CONFIG.ntfyTopic) {
        console.log('No NTFY_TOPIC configured, skipping push notification.');
        return;
    }

    const url = `https://ntfy.sh/${CONFIG.ntfyTopic}`;
    try {
        if (imageBuffer) {
            await axios.put(url, imageBuffer, {
                headers: {
                    'Title': 'Website Checker Alert',
                    'Priority': '5',
                    'Tags': 'warning,rocket',
                    'Filename': 'screenshot.png',
                    'Header': 'X-Message'
                }
            });
            console.log('ntfy screenshot sent.');
        } else {
            await axios.post(url, message, {
                headers: {
                    'Title': 'Website Checker Alert',
                    'Priority': '5',
                    'Tags': 'warning,rocket'
                }
            });
            console.log('ntfy text sent.');
        }

    } catch (error) {
        console.error('Failed to send ntfy alert:', error.message);
    }
}

async function sendDualAlert(telegramMsg, ntfyMsg, imageBuffer) {
    // Send both independently
    await Promise.allSettled([
        sendTelegramAlert(telegramMsg, imageBuffer),
        sendNtfyAlert(ntfyMsg, imageBuffer)
    ]);
}

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'session.json');

async function run() {
    console.log('Starting Website Checker...');

    // Validation
    if (!CONFIG.email || !CONFIG.password || !CONFIG.url || !CONFIG.loginUrl) {
        console.error('Missing configuration. Check CG_EMAIL, CG_PASSWORD, TARGET_URL, LOGIN_URL.');
        process.exit(1);
    }

    const showBrowser = process.env.SHOW_BROWSER === 'true';

    // Check for existing session
    let contextOptions = {};
    if (fs.existsSync(SESSION_FILE)) {
        console.log('Found existing session. Loading...');
        contextOptions.storageState = SESSION_FILE;
    }

    const browser = await chromium.launch({
        headless: !showBrowser,
        slowMo: showBrowser ? 1000 : 0
    });
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        console.log(`Navigating to ${CONFIG.url}...`);
        await page.goto(CONFIG.url, { waitUntil: 'networkidle' });

        // Check if we were redirected to login
        if (page.url().includes('/users/login')) {
            console.log('Redirected to login page. Logging in...');

            const emailInput = page.locator('input[type="email"], input[name*="email"]');
            const passwordInput = page.locator('input[type="password"]');

            if (await emailInput.count() > 0) {
                await emailInput.fill(CONFIG.email);
            }
            if (await passwordInput.count() > 0) {
                await passwordInput.fill(CONFIG.password);
            }

            // Try to tick "Remember me"
            try {
                const rememberMe = page.getByLabel('Remember me').or(page.getByText('Remember me'));
                if (await rememberMe.count() > 0) {
                    const checkbox = page.locator('input[type="checkbox"]');
                    if (await checkbox.count() > 0) {
                        await checkbox.first().check();
                    } else {
                        await rememberMe.first().click();
                    }
                } else {
                    const anyCheckbox = page.locator('input[type="checkbox"]').first();
                    if (await anyCheckbox.count() > 0) {
                        await anyCheckbox.check();
                    }
                }
            } catch (e) { /* ignore */ }

            const submitButton = page.locator('button[type="submit"], input[type="submit"]');

            await Promise.all([
                page.waitForURL('**/modeling-requests'),
                submitButton.click()
            ]);

            console.log('Login submitted. Redirection complete.');
            await page.waitForLoadState('networkidle');

            console.log('Saving session state...');
            await context.storageState({ path: SESSION_FILE });
        } else {
            // Refresh session file to keep it alive
            console.log('Already logged in!');
            await context.storageState({ path: SESSION_FILE });
        }

        // Verify page
        if (!page.url().includes('modeling-requests')) {
            console.warn(`Warning: Might not be on target page. URL: ${page.url()}`);
        }

        console.log('Checking for target phrase...');
        const content = await page.content();

        if (content.includes(CONFIG.targetPhrase)) {
            console.log('✅ Phrase FOUND: No work available.');
        } else {
            console.log('❌ phrase NOT FOUND! Tasks might be available.');

            console.log('📸 Taking screenshot...');
            const screenshotBuffer = await page.screenshot({ fullPage: true });

            const telegramMsg = `🚨 Task Alert\nThe phrase was NOT found!\nTasks might be available!\nTime: ${new Date().toUTCString()}`;
            const ntfyMsg = `Tasks might be available! (Phrase not found)`;

            await sendDualAlert(telegramMsg, ntfyMsg, screenshotBuffer);
        }

    } catch (error) {
        console.error('Fatal error in runner:', error);
        await sendDualAlert(`⚠️ Checker Error: ${error.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
