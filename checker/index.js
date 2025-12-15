const { chromium } = require('playwright');
const axios = require('axios');
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
    checkInterval: 5 * 60 * 1000 // 5 minutes (handled by GitHub Actions largely)
};

async function sendTelegramAlert(message) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
        console.error('Missing Telegram configuration');
        return;
    }

    const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: CONFIG.telegramChatId,
            text: message
        });
        console.log('Telegram alert sent.');
    } catch (error) {
        console.error('Failed to send Telegram alert:', error.message);
    }
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
        slowMo: showBrowser ? 1000 : 0 // Slow down by 1 second per action if browser is shown
    });
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        console.log(`Navigating to ${CONFIG.url}...`);
        await page.goto(CONFIG.url, { waitUntil: 'networkidle' });

        // Check if we were redirected to login
        if (page.url().includes('/users/login')) {
            console.log('Redirected to login page. Logging in...');

            // Fill login form - assuming standard IDs based on Rails/common practices
            // If specific IDs are unknown, we can try generic selectors or exact text matches for labels
            // Strategy: Look for input with type="email" or name="user[email]"
            const emailInput = page.locator('input[type="email"], input[name*="email"]');
            const passwordInput = page.locator('input[type="password"]');

            if (await emailInput.count() > 0) {
                await emailInput.fill(CONFIG.email);
            } else {
                throw new Error('Could not find email input field');
            }

            if (await passwordInput.count() > 0) {
                await passwordInput.fill(CONFIG.password);
            } else {
                throw new Error('Could not find password input field');
            }

            // Try to tick "Remember me"
            try {
                // Look for a checkbox near "Remember me" text or generic checkbox
                const rememberMe = page.getByLabel('Remember me').or(page.getByText('Remember me'));
                if (await rememberMe.count() > 0) {
                    // Sometimes the label is clickable, sometimes the checkbox input itself
                    // We will try to click the input if we can find it relative to text, or just the text
                    const checkbox = page.locator('input[type="checkbox"]');
                    if (await checkbox.count() > 0) {
                        await checkbox.first().check();
                        console.log('Ticked "Remember me".');
                    } else {
                        // Fallback: click the text, assuming it toggles the box
                        await rememberMe.first().click();
                        console.log('Clicked "Remember me" text.');
                    }
                } else {
                    // Try finding any checkbox
                    const anyCheckbox = page.locator('input[type="checkbox"]').first();
                    if (await anyCheckbox.count() > 0) {
                        await anyCheckbox.check();
                        console.log('Ticked a checkbox (likely Remember me).');
                    }
                }
            } catch (e) {
                console.log('Could not tick "Remember me" (non-fatal):', e.message);
            }

            // Click submit button (usually type="submit" or text "Log in" / "Sign in")
            const submitButton = page.locator('button[type="submit"], input[type="submit"]');

            // Promise.all to wait for navigation
            await Promise.all([
                page.waitForURL('**/modeling-requests'), // Wait for redirect back
                submitButton.click()
            ]);

            console.log('Login submitted. Waiting for redirection...');
            await page.waitForLoadState('networkidle');

            // Save session after successful login
            console.log('Saving session state...');
            await context.storageState({ path: SESSION_FILE });
        } else {
            console.log('Already logged in!');
            // Refresh session file time/content if needed, or just save to ensure latest cookies
            await context.storageState({ path: SESSION_FILE });
        }

        // Verify we are on the right page
        if (!page.url().includes('modeling-requests')) {
            console.log(`Current URL: ${page.url()}`);
            // If we are not on modeling-requests, maybe we are still on login (failed)?
            if (page.url().includes('/users/login')) {
                throw new Error('Login failed (remained on login page). Check credentials.');
            }
            // Or maybe redirected elsewhere?
            console.warn('Warning: Not exactly on modeling-requests page, but proceeding with check.');
        }

        console.log('Checking for target phrase...');
        const content = await page.content();

        if (content.includes(CONFIG.targetPhrase)) {
            console.log('Phrase FOUND: "Looks like all tasks were picked up before you". No actions needed.');
        } else {
            console.log('phrase NOT FOUND! Tasks might be available.');
            const msg = `🚨 CGTrader Alert\nThe phrase was NOT found on the modeling requests page.\nTasks might be available!\nTime: ${new Date().toUTCString()}`;
            await sendTelegramAlert(msg);
        }

    } catch (error) {
        console.error('An error occurred:', error);
        await sendTelegramAlert(`⚠️ Checker Error: ${error.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
