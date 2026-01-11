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
    // New Configs
    minPriceSingle: parseFloat(process.env.MIN_PRICE_SINGLE || '25'),
    minPriceVariation: parseFloat(process.env.MIN_PRICE_VARIATION || '6'),
    maxConcurrentTabs: 5,
    checkOnly: process.env.CHECK_ONLY === '1'
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
    await Promise.allSettled([
        sendTelegramAlert(telegramMsg, imageBuffer),
        sendNtfyAlert(ntfyMsg, imageBuffer)
    ]);
}

const fs = require('fs');
const path = require('path');
const SESSION_FILE = path.join(__dirname, 'session.json');

// --- HELPER FUNCTIONS ---

const parseCapacity = (str) => {
    if (!str || str === 'N/A') return { current: 0, max: 0, available: 0 };
    const parts = str.split('/').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return { current: 0, max: 0, available: 0 };
    return {
        current: parts[0],
        max: parts[1],
        available: Math.max(0, parts[1] - parts[0])
    };
};

async function getCapacity(page) {
    try {
        // Hover over the "Eye" icon to reveal limits
        // Note: We might be on different pages, so we use a loose selector if needed, 
        // but user provided specific ones.
        const eyeIconSelector = '.SidebarCapacityMenuItemContent-module__icon___2Ql5x > svg:nth-child(1)';
        const eyeIcon = page.locator(eyeIconSelector).first();
        if (await eyeIcon.count() > 0) {
            await eyeIcon.hover();
            await page.waitForTimeout(1000);
        }

        const acceptedTasksSelector = '.Limits-module__content___1tzEL > div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)';
        const groupedTasksSelector = 'div.row:nth-child(3) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)';

        const acceptedTasks = await page.textContent(acceptedTasksSelector, { timeout: 2000 }).catch(() => 'N/A');
        const groupedTasks = await page.textContent(groupedTasksSelector, { timeout: 2000 }).catch(() => 'N/A');

        return {
            single: parseCapacity(acceptedTasks),
            grouped: parseCapacity(groupedTasks)
        };
    } catch (e) {
        console.error('Error fetching capacity:', e);
        return { single: { available: 0 }, grouped: { available: 0 } };
    }
}

async function acceptJob(browser, jobUrl, contextOptions) {
    let page;
    try {
        const context = await browser.newContext(contextOptions);
        page = await context.newPage();

        console.log(`Open Job: ${jobUrl}`);
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });

        // Execute Wait and Scroll simultaneously (Total wait: 2s)
        console.log('Waiting 2s (with scroll)...');
        await Promise.all([
            page.waitForTimeout(2000), // Enforce strictly 2 seconds wait
            (async () => {
                try {
                    await page.waitForTimeout(500); // 0.5s loading buffer
                    await page.mouse.wheel(0, 300); // Scroll Down
                    await page.waitForTimeout(500); // Hold
                    await page.mouse.wheel(0, -300); // Scroll Up
                } catch (e) { console.error('Scroll error (non-fatal):', e.message); }
            })()
        ]);

        // Click Accept
        // Try multiple selectors or text
        const acceptBtn = page.getByText('Accept task', { exact: true }).or(page.locator('button:has-text("Accept task")'));
        if (await acceptBtn.count() > 0) {
            await acceptBtn.first().click();
            console.log('Clicked Accept Task...');

            // Wait for Modal
            await page.waitForTimeout(1000);

            // Try to handle confirmation
            // Look for "Yes", "Confirm", "OK"
            const confirmBtn = page.getByRole('button', { name: 'Yes' })
                .or(page.getByRole('button', { name: 'Confirm' }))
                .or(page.getByRole('button', { name: 'OK' }))
                .or(page.getByText('Yes', { exact: true }));

            if (await confirmBtn.count() > 0) {
                // Take debug screenshot of modal first time? 
                // Creating a simplified debug flow: just click it.
                await confirmBtn.first().click();
                console.log('Clicked Modal Confirmation.');
                await page.waitForTimeout(2000); // Wait for action
                return true;
            } else {
                console.log('No confirmation modal found? (Or auto-accepted?)');
                return true;
            }
        } else {
            console.log('Accept button not found.');
            return false;
        }

    } catch (e) {
        console.error(`Error accepting job ${jobUrl}:`, e.message);
        return false;
    } finally {
        if (page) await page.close();
    }
}


async function run() {
    console.log('Starting Website Checker...');
    const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    if (IS_CI) console.log('🚀 Mode: Cloud (CI) - 6h Loop');
    else console.log('💻 Mode: Local - Single Run');

    if (CONFIG.checkOnly) {
        console.log('🛡️ SAFETY MODE: "CHECK_ONLY" is ON. Auto-Accept disabled.');
    }

    if (!CONFIG.email || !CONFIG.password || !CONFIG.url || !CONFIG.loginUrl) {
        console.error('Missing configuration.');
        process.exit(1);
    }

    const showBrowser = process.env.SHOW_BROWSER === 'true';
    let contextOptions = {};
    if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;

    const browser = await chromium.launch({ headless: !showBrowser });
    // Main context for the "Listing" page
    const mainContext = await browser.newContext(contextOptions);
    const page = await mainContext.newPage();

    const LOOP_DURATION = 6 * 60 * 60 * 1000;
    const CHECK_INTERVAL = 0; // Not used with dynamic cycle logic
    const MIN_CYCLE_DURATION = 20 * 1000;
    const startTime = Date.now();
    let iterations = 0;

    try {
        let keepRunning = true;
        while (keepRunning) {
            const cycleStart = Date.now();
            iterations++;
            if (IS_CI) {
                const timeRemaining = Math.round((LOOP_DURATION - (Date.now() - startTime)) / 1000);
                console.log(`\n🔄 Iteration #${iterations} (Time remaining: ${timeRemaining}s)`);
            }

            try {
                // 1. Navigate & Login Check
                if (page.url().includes(CONFIG.url)) {
                    console.log('🔄 Reloading page...');
                    await page.reload({ waitUntil: 'networkidle' });
                } else {
                    console.log('Navigating to target...');
                    await page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                }
                if (page.url().includes('/users/login')) {
                    console.log('Logging in...');
                    const emailInput = page.locator('input[type="email"], input[name*="email"]');
                    const passwordInput = page.locator('input[type="password"]');

                    if (await emailInput.count() > 0) await emailInput.fill(CONFIG.email);
                    if (await passwordInput.count() > 0) await passwordInput.fill(CONFIG.password);

                    try {
                        const rememberMe = page.getByLabel('Remember me').or(page.getByText('Remember me'));
                        if (await rememberMe.count() > 0) await rememberMe.first().click();
                    } catch (e) { }

                    const submitButton = page.locator('button[type="submit"], input[type="submit"]');
                    await Promise.all([
                        page.waitForURL('**/modeling-requests'),
                        submitButton.click()
                    ]);
                    await context.storageState({ path: SESSION_FILE });
                }

                if (!page.url().includes('modeling-requests')) {
                    console.warn(`Warning: URL seems off: ${page.url()}`);
                }

                // 2. Check for "No Jobs" Phrase
                console.log('Checking for target phrase...');

                // Wait for the phrase to appear. If it appears, we know there are no jobs.
                // If it DOESN'T appear within timeout, we assume jobs might be available.
                // Using a timeout (e.g. 3s) handles the "loading delay" false positive.
                let phraseFound = false;
                try {
                    const phraseLocator = page.getByText(CONFIG.targetPhrase);
                    await phraseLocator.waitFor({ state: 'visible', timeout: 3000 });
                    phraseFound = true;
                } catch (e) {
                    phraseFound = false;
                }

                if (phraseFound) {
                    const elapsed = Date.now() - cycleStart;
                    const waitTime = Math.max(0, MIN_CYCLE_DURATION - elapsed);
                    console.log(`✅ Phrase FOUND (No jobs). Waiting ${(waitTime / 1000).toFixed(1)}s to complete 20s cycle...`);
                    await page.waitForTimeout(waitTime);
                    // Loop naturally wraps around to "Reload" step immediately.
                } else {
                    console.log('❌ phrase NOT FOUND! Tasks likely available! Starting Logic IMMEDIATELY.');

                    // --- AUTO-ACCEPT LOGIC ---

                    if (CONFIG.checkOnly) {
                        console.log('🛡️ Check Only Mode active. Sending Alert (No Actions Taken).');
                        const screenshotBuffer = await page.screenshot({ fullPage: true });
                        const telegramMsg = `🚨 Task Alert (Check Only)\nTasks available, but Auto-Accept is DISABLED.\nTime: ${new Date().toUTCString()}`;
                        const ntfyMsg = `Tasks available! (Auto-Accept Disabled)`;
                        await sendDualAlert(telegramMsg, ntfyMsg, screenshotBuffer);
                    } else {
                        // A. Refresh First (SKIP this now, we just refreshed/loaded)
                        // User said: "Reloads... Checks... If not found trigger logic"
                        // But wait, if we arrived here, we probably haven't grabbed the latest list perfectly if the page was "loading".
                        // Use the current page state since we waited 3s.

                        // B. Check Capacity
                        console.log('Checking Capacity...');
                        const capacity = await getCapacity(page);
                        console.log(`Limit: Single ${capacity.single.available} | Grouped ${capacity.grouped.available}`);

                        if (capacity.single.available === 0 && capacity.grouped.available === 0) {
                            console.log('⚠️ Capacity FULL. Sending alert only.');
                            const screenshotBuffer = await page.screenshot({ fullPage: true });
                            await sendDualAlert(
                                `🚨 Jobs Found but Capacity FULL!\nAccepted: ${capacity.single.current}/${capacity.single.max}\nGrouped: ${capacity.grouped.current}/${capacity.grouped.max}`,
                                `Jobs found (Capacity Full)`,
                                screenshotBuffer
                            );
                        } else {
                            // C. Scrape Jobs
                            console.log('Scraping Jobs...');
                            const jobButtons = await page.locator('a:has-text("Open requirements"), button:has-text("Open requirements")').all();

                            let availableJobs = [];
                            for (const btn of jobButtons) {
                                const url = await btn.getAttribute('href');
                                if (!url) continue;

                                const card = btn.locator('xpath=./ancestor::div[contains(@class, "row") or contains(@class, "Card")]').first();
                                let cardText = '';
                                if (await card.count() > 0) {
                                    cardText = await card.innerText();
                                } else {
                                    cardText = await btn.locator('..').locator('..').innerText();
                                }

                                const priceMatch = cardText.match(/\$(\d+(\.\d+)?)/);
                                const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
                                const varMatch = cardText.match(/(\d+)\s+variations/i);
                                const isGrouped = !!varMatch;
                                const variationCount = isGrouped ? parseInt(varMatch[1], 10) : 1;
                                const fullUrl = url.startsWith('http') ? url : new URL(url, CONFIG.url).toString();

                                availableJobs.push({
                                    url: fullUrl,
                                    price: price,
                                    isGrouped: isGrouped,
                                    variations: variationCount,
                                    pricePerUnit: isGrouped ? (price / variationCount) : price
                                });
                            }

                            console.log(`Found ${availableJobs.length} potential jobs.`);

                            const singleJobs = availableJobs.filter(j => !j.isGrouped && j.price >= CONFIG.minPriceSingle).sort((a, b) => b.price - a.price);
                            const groupedJobs = availableJobs.filter(j => j.isGrouped && j.pricePerUnit >= CONFIG.minPriceVariation).sort((a, b) => b.price - a.price);

                            let jobsToProcess = [];
                            jobsToProcess.push(...singleJobs.slice(0, capacity.single.available));
                            jobsToProcess.push(...groupedJobs.slice(0, capacity.grouped.available));

                            if (jobsToProcess.length > 0) {
                                // FIRE "FOUND" ALERT IMMEDIATELY (Non-blocking / Background)
                                const count = jobsToProcess.length;
                                const msg = `🚨 Found ${count} Jobs! Attempting to accept...`;
                                console.log(msg);
                                // Start Screenshot + Alert in background (don't await)
                                page.screenshot({ fullPage: true }).then(buff => {
                                    sendDualAlert(msg, msg, buff).catch(e => console.error('Pre-alert error:', e));
                                }).catch(e => console.error('Screenshot error:', e));

                                console.log(`Attempting to accept ${jobsToProcess.length} jobs (Limit: ${CONFIG.maxConcurrentTabs})...`);
                                while (jobsToProcess.length > 0) {
                                    const batch = jobsToProcess.splice(0, CONFIG.maxConcurrentTabs);
                                    const results = await Promise.all(batch.map(job => acceptJob(browser, job.url, contextOptions)));
                                    const successCount = results.filter(r => r).length;
                                    if (successCount > 0) await sendDualAlert(`✅ Accepted ${successCount} new jobs!`);
                                }
                            } else {
                                console.log('No jobs matched criteria.');
                                const screenshotBuffer = await page.screenshot({ fullPage: true });
                                await sendDualAlert(`🚨 Jobs Found but ignored.`, `Jobs available (ignored)`, screenshotBuffer);
                            }
                        }
                    }
                }

            } catch (innerError) {
                console.error(`⚠️ loop error: ${innerError.message}`);
                if (!IS_CI) throw innerError;
            }

            if (IS_CI) {
                if (Date.now() - startTime >= LOOP_DURATION) keepRunning = false;
                // REMOVED CHECK_INTERVAL WAIT for fast looping
                // We depend on networkidle in reload() to pace us roughly.
            } else {
                keepRunning = false;
            }
        }
    } catch (error) {
        console.error('Fatal:', error);
        await sendDualAlert(`⚠️ Checker Error: ${error.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
