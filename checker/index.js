const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

// Configuration
const CONFIG = {
    url: process.env.TARGET_URL,
    loginUrl: process.env.LOGIN_URL,
    targetPhrase: 'Looks like all tasks were picked up before you',
    email: process.env.CG_EMAIL, // Kept for backward compatibility if only one account
    password: process.env.CG_PASSWORD, // Kept for backward compatibility if only one account
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    ntfyTopic: process.env.NTFY_TOPIC,
    // New Configs
    minPriceSingle: parseFloat(process.env.MIN_PRICE_SINGLE || '25'),
    minPriceVariation: parseFloat(process.env.MIN_PRICE_VARIATION || '6'),
    maxConcurrentTabs: 5,
    checkOnly: /^(1|true|on|yes)$/i.test(process.env.CHECK_ONLY || '')
};

// --- UPDATED CONFIG FOR MULTI-ACCOUNT ---
const ACCOUNT_COUNT = parseInt(process.env.ACCOUNT_COUNT || '1', 10);
const ACCOUNTS = [];
for (let i = 1; i <= 5; i++) { // Support up to 5 accounts
    const suffix = i === 1 ? '' : i; // CG_EMAIL, CG_EMAIL2...
    const email = process.env[`CG_EMAIL${suffix}`];
    const password = process.env[`CG_PASSWORD${suffix}`];
    if (email && password) {
        ACCOUNTS.push({ id: i, email, password });
    }
}
// Limit by ACCOUNT_COUNT if set lower than available secrets
const ACTIVE_ACCOUNTS = ACCOUNTS.slice(0, ACCOUNT_COUNT);
if (ACTIVE_ACCOUNTS.length === 0) {
    console.error('No active accounts configured. Please set CG_EMAIL and CG_PASSWORD (and optionally CG_EMAIL2, etc.)');
    process.exit(1);
}


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
// SESSION_FILE is now dynamic per account
// const SESSION_FILE = path.join(__dirname, 'session.json');

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
        return { single: { available: 0, current: 0, max: 0 }, grouped: { available: 0, current: 0, max: 0 } };
    }
}

// --- JOB PROCESSING ---
async function processJob(agent, job) {
    let page;
    try {
        // Create a new page within the agent's context for each job
        page = await agent.context.newPage();

        // Speed Optimization: Block images/fonts on the specific TASK page for all agents (including Agent 1)
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,webm,ico}', route => route.abort());

        // Hack to bypass GitHub Secret masking (insert space after https://)
        const displayUrl = job.url.replace('https://', 'https:// ');
        console.log(`[Account ${agent.id}] Handling Job: ${displayUrl}`);

        // Agent 1 clicks, others go direct
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });

        // 0.5s Wait (Total) - Fast Scroll
        console.log(`[Account ${agent.id}] waiting 0.5s...`);
        await Promise.all([
            page.waitForTimeout(500),
            (async () => {
                try {
                    await page.waitForTimeout(100);
                    await page.mouse.wheel(0, 300);
                    await page.waitForTimeout(100);
                    await page.mouse.wheel(0, -300);
                } catch (e) { /* Scroll errors are non-fatal */ }
            })()
        ]);

        const acceptBtn = page.getByText('Accept task', { exact: true }).or(page.locator('button:has-text("Accept task")'));
        if (await acceptBtn.count() > 0) {
            await acceptBtn.first().click();
            console.log(`[Account ${agent.id}] Clicked Accept Task...`);

            // Handle Modal
            await page.waitForTimeout(500); // Shorter wait for modal
            const confirmBtn = page.getByRole('button', { name: 'Yes' })
                .or(page.getByRole('button', { name: 'Confirm' }))
                .or(page.getByRole('button', { name: 'OK' }))
                .or(page.getByText('Yes', { exact: true }));

            if (await confirmBtn.count() > 0) {
                await confirmBtn.first().click();
                console.log(`[Account ${agent.id}] Clicked Modal Confirmation. Verifying...`);

                // Verification
                try {
                    await page.waitForURL('**/my-requests/**', { timeout: 10000 });
                    if (page.url().includes('/my-requests/')) {
                        const screenshot = await page.screenshot({ fullPage: true });
                        const msg = `✅ Account ${agent.id} SECURED Job!\nPrice: $${job.price}\nType: ${job.isGrouped ? 'Grouped' : 'Single'}`;
                        await sendDualAlert(msg, `Job Secured ($${job.price})`, screenshot);
                        return true;
                    }
                } catch (e) { console.log(`[Account ${agent.id}] Verification Failed: ${e.message}`); }
            } else {
                console.log(`[Account ${agent.id}] No confirmation modal found? (Or auto-accepted?)`);
            }
        } else {
            console.log(`[Account ${agent.id}] Accept button not found.`);
        }
    } catch (e) {
        console.error(`[Account ${agent.id}] Error processing job ${job.url}: ${e.message}`);
    } finally {
        if (page) await page.close();
    }
    return false;
}


async function run() {
    console.log('Starting Multi-Account Swarm...');
    const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    if (IS_CI) console.log('🚀 Mode: Cloud (CI) - 6h Loop');
    else console.log('💻 Mode: Local - Single Run');

    if (CONFIG.checkOnly) {
        console.log('🛡️ SAFETY MODE: "CHECK_ONLY" is ON. Auto-Accept disabled.');
    }

    if (!CONFIG.url || !CONFIG.loginUrl) {
        console.error('Missing TARGET_URL or LOGIN_URL configuration.');
        process.exit(1);
    }

    const showBrowser = process.env.SHOW_BROWSER === 'true';

    // Safety Mode Override: If checkOnly, only use the first account for spotting
    const effectiveAccounts = CONFIG.checkOnly ? [ACTIVE_ACCOUNTS[0]] : ACTIVE_ACCOUNTS;
    console.log(`Debug: Initializing ${effectiveAccounts.length} accounts.`);

    const browser = await chromium.launch({ headless: !showBrowser });
    const agents = [];

    // --- INIT SWARM ---
    for (const acc of effectiveAccounts) {
        console.log(`Initializing Account ${acc.id} (${acc.email})...`);
        const sessionPath = path.join(__dirname, `session_${acc.id}.json`);
        let ctxOpts = {};
        if (fs.existsSync(sessionPath)) ctxOpts.storageState = sessionPath;

        const context = await browser.newContext(ctxOpts);

        // OPTION 1: Resource Blocking (Images, Fonts, Media) - Speed Boost 🚀
        // Modified: Only block for Workers (Agents 2+). Agent 1 needs images for Screenshots.
        if (acc.id !== 1) {
            await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,webm,ico}', route => route.abort());
        }

        const page = await context.newPage();

        // OPTION 2 PREP: JSON Logger (The Sniper Spy) 🕵️‍♂️
        if (acc.id === 1) {
            page.on('response', async response => {
                try {
                    if (response.url().includes('available-requests') && response.status() === 200) {
                        const body = await response.text();
                        // Only log if it contains potential job indicators to avoid empty spam
                        if (body.includes('"uid"') || body.includes('"price"') || body.includes('"id"')) {
                            console.log('\n🔍 --- SNIPER DATA CAPTURED ---');
                            console.log(body);
                            console.log('------------------------------\n');
                        }
                    }
                } catch (e) { /* ignore spy errors */ }
            });
        }

        // Login Flow
        await page.goto(CONFIG.url, { waitUntil: 'networkidle' });
        if (page.url().includes('/users/login')) {
            console.log(`[Account ${acc.id}] Logging in...`);
            const emailInput = page.locator('input[type="email"], input[name*="email"]');
            const passwordInput = page.locator('input[type="password"]');

            if (await emailInput.count() > 0) await emailInput.fill(acc.email);
            if (await passwordInput.count() > 0) await passwordInput.fill(acc.password);

            try {
                const rememberMe = page.getByLabel('Remember me').or(page.getByText('Remember me'));
                if (await rememberMe.count() > 0) await rememberMe.first().click();
            } catch (e) { /* ignore if remember me not found */ }

            const submitButton = page.locator('button[type="submit"], input[type="submit"]');
            await Promise.all([
                page.waitForURL('**/modeling-requests', { timeout: 15000 }), // Increased timeout for login
                submitButton.click()
            ]);
            await context.storageState({ path: sessionPath });
        }
        console.log(`✅ Account ${acc.id}: Logged In`);

        // Park on available tasks page
        if (!page.url().includes('modeling-requests')) {
            console.log(`[Account ${acc.id}] Navigating to main tasks page.`);
            await page.goto(CONFIG.url, { waitUntil: 'networkidle' });
        }

        agents.push({ id: acc.id, page, context, sessionPath, browser });
    }

    // --- INITIAL CAPACITY SCAN ---
    console.log('🔄 Performing initial capacity scan...');
    const capacityCache = {};
    await Promise.all(agents.map(async (agent) => {
        const cap = await getCapacity(agent.page);
        capacityCache[agent.id] = cap;
        console.log(`[Account ${agent.id}] Init Capacity: Single ${cap.single.available} | Grouped ${cap.grouped.available}`);
    }));

    // --- MAIN LOOP ---
    const Agent1 = agents[0]; // The Spotter
    const LOOP_DURATION = 6 * 60 * 60 * 1000;
    const MIN_CYCLE_DURATION = 10 * 1000; // Reduced to 10s as per user request
    const startTime = Date.now();
    let iterations = 0;
    let keepRunning = true;

    // Sniper Storage
    let lastSniperJobs = [];

    // --- SNIPER ENGINE (Option 2) ---
    // We listen to the network to catch jobs BEFORE the browser even finishes drawing them.
    Agent1.page.on('response', async response => {
        const url = response.url();
        if (url.includes('available-requests') && response.status() === 200) {
            try {
                const json = await response.json();
                const rawJobs = json.data || [];

                const parsed = rawJobs.map(item => {
                    const attr = item.attributes || {};
                    const priceInfo = attr.pricingInformation || {};
                    const isGrouped = attr.partOfGroupOfRequests === true;

                    // The site uses a specific URL structure: .../modeling-requests/ID/brief
                    // CONFIG.url is usually the full modeling-requests URL
                    const jobUrl = `${CONFIG.url}/${item.id}/brief`;

                    return {
                        id: item.id,
                        url: jobUrl,
                        price: priceInfo.price || parseFloat(attr.compensation) || 0,
                        isGrouped: isGrouped,
                        variations: isGrouped ? (attr.groupData?.size || 1) : 1,
                        pricePerUnit: isGrouped ? (priceInfo.price / (attr.groupData?.size || 1)) : priceInfo.price
                    };
                });

                lastSniperJobs = parsed;
                if (parsed.length > 0) {
                    console.log(`[Sniper] 🎯 Captured ${parsed.length} jobs via API.`);
                }
            } catch (e) {
                // Ignore parse errors if body is not JSON or empty
            }
        } else if (url.includes('available-requests') && (response.status() === 403 || response.status() === 429)) {
            console.error(`\n🚨 [Sniper Alert] POTENTIAL SOFT BAN detected (HTTP ${response.status()}).`);
            console.error('The server is blocking our check requests. Recommend stopping or increasing wait time.\n');
        }
    });

    try {
        while (keepRunning) {
            const cycleStart = Date.now();
            iterations++;
            if (IS_CI) {
                const timeRemaining = Math.round((LOOP_DURATION - (Date.now() - startTime)) / 1000);
                console.log(`\n🔄 Iteration #${iterations} (Time remaining: ${timeRemaining}s)`);
            }

            try {
                // 1. Refresh Spotter (Agent 1)
                if (Agent1.page.url().includes(CONFIG.url)) {
                    console.log('[Agent 1] Reloading page...');
                    await Agent1.page.reload({ waitUntil: 'networkidle' });
                } else {
                    console.log('[Agent 1] Navigating to target...');
                    await Agent1.page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                }

                // 2. Check for "No Jobs" Phrase
                console.log('[Agent 1] Checking for target phrase...');
                let phraseFound = false;
                try {
                    const phraseLocator = Agent1.page.getByText(CONFIG.targetPhrase);
                    await phraseLocator.waitFor({ state: 'visible', timeout: 3000 });
                    phraseFound = true;
                } catch (e) {
                    phraseFound = false;
                }

                if (phraseFound) {
                    const elapsed = Date.now() - cycleStart;
                    const waitTime = Math.max(0, MIN_CYCLE_DURATION - elapsed);
                    console.log(`✅ Phrase FOUND (No jobs). Waiting ${(waitTime / 1000).toFixed(1)}s to complete 20s cycle...`);
                    await Agent1.page.waitForTimeout(waitTime);
                } else {
                    console.log('❌ Phrase NOT FOUND! Tasks likely available! Starting Logic IMMEDIATELY.');

                    // --- AUTO-ACCEPT LOGIC ---
                    if (CONFIG.checkOnly) {
                        console.log('🛡️ Check Only Mode active. Sending Alert (No Actions Taken).');
                        const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                        const telegramMsg = `🚨 Task Alert (Check Only)\nTasks available, but Auto-Accept is DISABLED.\nTime: ${new Date().toUTCString()}`;
                        const ntfyMsg = `Tasks available! (Auto-Accept Disabled)`;
                        await sendDualAlert(telegramMsg, ntfyMsg, screenshotBuffer);
                    } else {
                        console.log('🚨 JOBS FOUND! SWARM ATTACK!');

                        // Use Stored Capacity Cache (0ms delay)
                        const totalAvailableSingle = Object.values(capacityCache).reduce((sum, c) => sum + c.single.available, 0);
                        const totalAvailableGrouped = Object.values(capacityCache).reduce((sum, c) => sum + c.grouped.available, 0);

                        if (totalAvailableSingle === 0 && totalAvailableGrouped === 0) {
                            console.log('⚠️ All agents have FULL capacity (Cache). Sending alert only.');
                            const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                            sendDualAlert(
                                `🚨 Jobs Found but ALL Agents at FULL Capacity!`,
                                `Jobs found (All Agents Full)`,
                                screenshotBuffer
                            ).catch(e => console.error('BG Alert Error:', e.message));
                        } else {
                            // Use Sniper Data if available (0ms delay)
                            const availableJobs = lastSniperJobs;

                            if (availableJobs.length === 0) {
                                console.log('⚠️ Logic triggered but Sniper found 0 jobs in API. (Possible race condition or UI weirdness). skipping.');
                                await Agent1.page.waitForTimeout(2000);
                                continue;
                            }

                            console.log(`🚨 [Sniper] ${availableJobs.length} JOBS DETECTED! SWARM ATTACK!`);

                            const singleJobs = availableJobs.filter(j => !j.isGrouped && j.price >= CONFIG.minPriceSingle).sort((a, b) => b.price - a.price);
                            const groupedJobs = availableJobs.filter(j => j.isGrouped && j.pricePerUnit >= CONFIG.minPriceVariation).sort((a, b) => b.price - a.price);

                            const validJobs = [...singleJobs, ...groupedJobs]; // Combine for dispatch

                            if (validJobs.length > 0) {
                                // C. Dispatch Jobs to Agents (using Cache)
                                const agentQueues = {}; // { 1: [job1], 2: [job2] }
                                agents.forEach(a => agentQueues[a.id] = []);

                                // Create a mutable copy of capacityCache for dispatch logic
                                const currentCapacities = JSON.parse(JSON.stringify(capacityCache));

                                for (const job of validJobs) {
                                    const requiredType = job.isGrouped ? 'grouped' : 'single';

                                    // Find first agent with room in cached capacity
                                    const bestAgentId = Object.keys(currentCapacities).find(id => currentCapacities[id][requiredType].available > 0);

                                    if (bestAgentId) {
                                        agentQueues[bestAgentId].push(job);
                                        currentCapacities[bestAgentId][requiredType].available--;
                                    } else {
                                        console.log(`No agent found with (cached) capacity for job: $${job.price}`);
                                    }
                                }

                                // D. Execute Parallel Job Processing (Ultra-Aggressive: NO SCREENSHOT YET)
                                const jobsToProcessCount = Object.values(agentQueues).flat().length;
                                if (jobsToProcessCount > 0) {
                                    console.log(`🚀 Dispatching ${jobsToProcessCount} jobs to swarm IMMEDIATELY...`);

                                    await Promise.all(agents.map(async (agent) => {
                                        const queue = agentQueues[agent.id];
                                        if (queue && queue.length > 0) {
                                            console.log(`[Account ${agent.id}] Processing ${queue.length} jobs...`);
                                            while (queue.length > 0) {
                                                const batch = queue.splice(0, CONFIG.maxConcurrentTabs);
                                                await Promise.all(batch.map(j => processJob(agent, j)));
                                            }
                                        }
                                    }));

                                    console.log('Swarm processing done. Capturing aftermath and updating capacities...');

                                    // E. Post-Processing (Refresh all agents and re-scan capacity)
                                    try {
                                        console.log('🔄 Refreshing all agents for capacity update...');
                                        await Promise.all(agents.map(async (agent) => {
                                            if (!agent.page.url().includes(CONFIG.url)) {
                                                await agent.page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                                            } else {
                                                await agent.page.reload({ waitUntil: 'networkidle' });
                                            }
                                        }));

                                        const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                                        const alertMsg = `🎯 Swarm complete! Found ${jobsToProcessCount} jobs. Check logs for acceptance status.`;
                                        sendDualAlert(alertMsg, alertMsg, screenshotBuffer).catch(e => console.error('BG Alert Error:', e.message));

                                        // RE-SCAN ALL CAPACITIES (Update memory for next cycle)
                                        console.log('Update memory with fresh capacities...');
                                        await Promise.all(agents.map(async (agent) => {
                                            const cap = await getCapacity(agent.page);
                                            capacityCache[agent.id] = cap;
                                            console.log(`[Account ${agent.id}] Capacity updated: ${cap.single.available}/${cap.grouped.available}`);
                                        }));
                                    } catch (e) {
                                        console.error('Post-processing error:', e.message);
                                    }
                                } else {
                                    console.log('No jobs matched criteria or could be dispatched (Cache empty).');
                                }
                            } else {
                                console.log('No jobs matched criteria.');
                                const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                                await sendDualAlert(`🚨 Jobs Found but ignored.`, `Jobs available (ignored)`, screenshotBuffer);
                            }
                        }
                    }
                }

            } catch (innerError) {
                console.error(`⚠️ Loop error: ${innerError.message}`);
                if (!IS_CI) throw innerError; // Re-throw fatal errors in local mode
            }

            if (IS_CI) {
                if (Date.now() - startTime >= LOOP_DURATION) keepRunning = false;
            } else {
                keepRunning = false; // Local mode runs once
            }
        }
    } catch (error) {
        console.error('Fatal error in main run loop:', error);
        await sendDualAlert(`⚠️ Checker Error: ${error.message}`, `Checker Error: ${error.message}`);
        process.exit(1);
    } finally {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed.');
    }
}

run();
