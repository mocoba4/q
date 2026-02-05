const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();
const { createSheetsLogger } = require('./sheetsLogger');

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
    checkOnly: /^(1|true|on|yes)$/i.test(process.env.CHECK_ONLY || ''),
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '10', 10)
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

async function sendTelegramDocument({ caption, filename, buffer }) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
        console.error('Missing Telegram configuration');
        return;
    }

    try {
        const form = new FormData();
        form.append('chat_id', CONFIG.telegramChatId);
        if (caption) form.append('caption', caption);
        form.append('document', buffer, filename || 'trace.json');

        await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        console.log('Telegram document sent.');
    } catch (error) {
        console.error('Failed to send Telegram document:', error.message);
    }
}

async function sendNtfyAlert(message, imageBuffer) {
    if (!CONFIG.ntfyTopic) {
        console.log('No NTFY_TOPIC configured, skipping push notification.');
        return;
    }

    const url = `https://ntfy.sh/${CONFIG.ntfyTopic}`;
    const headers = {
        'Title': 'Website Checker Alert',
        'Priority': '5',
        'Tags': 'warning,rocket'
    };
    if (imageBuffer) {
        headers['Filename'] = 'screenshot.png';
        headers['Header'] = 'X-Message';
    }

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (imageBuffer) {
                await axios.put(url, imageBuffer, { headers, timeout: 10000 }); // 10s timeout
                console.log('ntfy screenshot sent.');
            } else {
                await axios.post(url, message, { headers, timeout: 10000 });
                console.log('ntfy text sent.');
            }
            return; // Success, exit
        } catch (error) {
            console.error(`ntfy alert failed (Attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
        }
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

function getJobPriceFromAttributes(attributes) {
    const attr = attributes || {};
    const isGrouped = attr.partOfGroupOfRequests === true;

    // For grouped jobs, the UI list price corresponds to groupData.pricingInformation.price
    // (falls back to the per-item pricingInformation if groupData is missing).
    const groupedPrice = attr.groupData?.pricingInformation?.price;
    const itemPrice = attr.pricingInformation?.price;

    const priceCandidate = (isGrouped ? (groupedPrice ?? itemPrice) : itemPrice);
    return priceCandidate ?? parseFloat(attr.compensation) ?? 0;
}

function getJobOriginalPriceFromAttributes(attributes) {
    const attr = attributes || {};
    const isGrouped = attr.partOfGroupOfRequests === true;

    const groupedOriginal = attr.groupData?.pricingInformation?.originalPrice;
    const groupedComp = attr.groupData?.compensation;

    const itemOriginal = attr.pricingInformation?.originalPrice;
    const itemComp = attr.compensation;

    const originalCandidate = (isGrouped ? (groupedOriginal ?? groupedComp ?? itemOriginal ?? itemComp) : (itemOriginal ?? itemComp));
    const n = typeof originalCandidate === 'string' ? parseFloat(originalCandidate) : originalCandidate;
    return Number.isFinite(n) ? n : 0;
}

function getJobMultiplierFromAttributes(attributes) {
    const attr = attributes || {};
    const isGrouped = attr.partOfGroupOfRequests === true;
    const groupedMultiplier = attr.groupData?.pricingInformation?.multiplier;
    const itemMultiplier = attr.pricingInformation?.multiplier;
    return (isGrouped ? (groupedMultiplier ?? itemMultiplier) : itemMultiplier) ?? '';
}

// --- JOB PROCESSING ---
async function processJob(agent, job) {
    let page;
    try {
        // Create a new page within the agent's context for each job
        page = await agent.context.newPage();

        const ACCEPT_TRACE_ENABLED = /^(1|true|on|yes)$/i.test(process.env.ACCEPT_TRACE || '');
        const ACCEPT_TRACE_SEND_ON_FAILURE = (() => {
            if (!ACCEPT_TRACE_ENABLED) return false;
            const v = process.env.ACCEPT_TRACE_SEND_ON_FAILURE;
            if (v === undefined || v === null || String(v).trim() === '') return true; // backward-compatible default
            return /^(1|true|on|yes)$/i.test(String(v));
        })();
        const ACCEPT_TRACE_SEND_ON_SUCCESS = (() => {
            if (!ACCEPT_TRACE_ENABLED) return false;
            return /^(1|true|on|yes)$/i.test(process.env.ACCEPT_TRACE_SEND_ON_SUCCESS || '');
        })();
        const ACCEPT_TRACE_SAVE_UNREDACTED_LOCAL = (() => {
            if (!ACCEPT_TRACE_ENABLED) return false;
            return /^(1|true|on|yes)$/i.test(process.env.ACCEPT_TRACE_SAVE_UNREDACTED_LOCAL || '');
        })();
        const acceptTrace = [];
        const traceStart = Date.now();

        const redactUrlForLog = (u) => {
            try {
                // Keep the existing masking-bypass convention for URLs
                return String(u || '').replace('https://', 'https:// ');
            } catch (_) {
                return '';
            }
        };

        const redactHeadersForLog = (headers) => {
            const out = {};
            const h = headers || {};
            for (const [rawKey, rawVal] of Object.entries(h)) {
                const key = String(rawKey || '').toLowerCase();
                const val = String(rawVal ?? '');

                if (key === 'cookie') {
                    // Only keep cookie names, never values
                    const names = val.split(';').map(s => s.trim().split('=')[0]).filter(Boolean);
                    out[rawKey] = `[redacted cookies: ${names.join(', ')}]`;
                    continue;
                }

                if (key === 'authorization') {
                    out[rawKey] = '[redacted authorization]';
                    continue;
                }

                if (key.includes('csrf') || key.includes('token') || key.includes('auth') || key.includes('session')) {
                    out[rawKey] = `[redacted ${key} len=${val.length}]`;
                    continue;
                }

                // Keep small headers; truncate the rest
                out[rawKey] = val.length > 200 ? `${val.slice(0, 200)}…(trunc)` : val;
            }
            return out;
        };

        const redactPostDataForLog = (postData) => {
            if (!postData) return undefined;
            const s = String(postData);
            // Heuristic: redact obvious token-like fields in JSON-ish bodies
            const redacted = s
                .replace(/"(token|csrf|auth|session|cookie|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
                .replace(/(token|csrf|auth|session|cookie|authorization)=([^&\s]+)/gi, '$1=[redacted]');
            return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…(trunc)` : redacted;
        };

        const pushTrace = (entry) => {
            acceptTrace.push(entry);
            // Keep last N entries to avoid huge payloads
            if (acceptTrace.length > 250) acceptTrace.shift();
        };

        const attachAcceptTrace = () => {
            if (!ACCEPT_TRACE_ENABLED) return;

            page.on('request', (req) => {
                try {
                    const rt = req.resourceType();
                    const method = req.method();
                    // Accept/confirm can be XHR/fetch or sometimes a form/navigation POST.
                    // Capture all XHR/fetch, plus any non-GET regardless of resource type.
                    if (rt !== 'xhr' && rt !== 'fetch' && method === 'GET') return;
                    pushTrace({
                        t: Date.now() - traceStart,
                        kind: 'request',
                        method,
                        url: redactUrlForLog(req.url()),
                        resourceType: rt,
                        headers: redactHeadersForLog(req.headers()),
                        postData: redactPostDataForLog(req.postData())
                    });
                } catch (_) {
                    // ignore
                }
            });

            page.on('response', async (resp) => {
                try {
                    const req = resp.request();
                    const rt = req.resourceType();
                    const method = req.method();
                    if (rt !== 'xhr' && rt !== 'fetch' && method === 'GET') return;

                    const url = resp.url();
                    const status = resp.status();
                    const shouldCaptureBody = status >= 400 || /accept|confirm|forbidden|request|brief/i.test(url);

                    let bodySnippet;
                    if (shouldCaptureBody) {
                        try {
                            const txt = await resp.text();
                            const safeTxt = String(txt || '').replace(/\s+/g, ' ').trim();
                            bodySnippet = safeTxt.length > 1200 ? `${safeTxt.slice(0, 1200)}…(trunc)` : safeTxt;
                        } catch (_) {
                            bodySnippet = '[unavailable]';
                        }
                    }

                    pushTrace({
                        t: Date.now() - traceStart,
                        kind: 'response',
                        method,
                        url: redactUrlForLog(url),
                        status,
                        bodySnippet
                    });
                } catch (_) {
                    // ignore
                }
            });
        };

        attachAcceptTrace();

        // If user explicitly enabled unredacted local saving, we capture a parallel raw trace.
        const acceptTraceRaw = ACCEPT_TRACE_SAVE_UNREDACTED_LOCAL ? [] : null;
        const pushTraceRaw = (entry) => {
            if (!acceptTraceRaw) return;
            acceptTraceRaw.push(entry);
            if (acceptTraceRaw.length > 250) acceptTraceRaw.shift();
        };

        if (ACCEPT_TRACE_SAVE_UNREDACTED_LOCAL) {
            page.on('request', (req) => {
                try {
                    const rt = req.resourceType();
                    if (rt !== 'xhr' && rt !== 'fetch') return;
                    pushTraceRaw({
                        t: Date.now() - traceStart,
                        kind: 'request',
                        method: req.method(),
                        url: redactUrlForLog(req.url()),
                        resourceType: rt,
                        headers: req.headers(),
                        postData: req.postData()
                    });
                } catch (_) {
                    // ignore
                }
            });

            page.on('response', async (resp) => {
                try {
                    const req = resp.request();
                    const rt = req.resourceType();
                    if (rt !== 'xhr' && rt !== 'fetch') return;
                    let bodySnippet;
                    try {
                        const txt = await resp.text();
                        const safeTxt = String(txt || '').replace(/\s+/g, ' ').trim();
                        bodySnippet = safeTxt.length > 2000 ? `${safeTxt.slice(0, 2000)}…(trunc)` : safeTxt;
                    } catch (_) {
                        bodySnippet = '[unavailable]';
                    }
                    pushTraceRaw({
                        t: Date.now() - traceStart,
                        kind: 'response',
                        method: req.method(),
                        url: redactUrlForLog(resp.url()),
                        status: resp.status(),
                        bodySnippet
                    });
                } catch (_) {
                    // ignore
                }
            });
        }

        const maybeSendAcceptTrace = async ({ reason, when }) => {
            if (!ACCEPT_TRACE_ENABLED) return;
            const shouldSend = (when === 'success') ? ACCEPT_TRACE_SEND_ON_SUCCESS : ACCEPT_TRACE_SEND_ON_FAILURE;
            if (!shouldSend) return;

            if (!acceptTrace || acceptTrace.length === 0) {
                console.warn(`[Account ${agent.id}] Accept trace enabled for ${when}, but no matching requests were captured.`);
                return;
            }

            const displayUrl = (job?.url || '').replace('https://', 'https:// ');
            const tracePayload = {
                capturedAt: new Date().toISOString(),
                accountId: agent.id,
                jobId: job?.id,
                jobUrl: displayUrl,
                when,
                reason,
                note: 'Sensitive headers/cookies/tokens are redacted. Use this to identify endpoints + required fields.',
                trace: acceptTrace
            };

            const buf = Buffer.from(JSON.stringify(tracePayload, null, 2), 'utf8');
            const fname = `accept_trace_${when}_acc${agent.id}_job${job?.id || 'unknown'}_${Date.now()}.json`;
            await sendTelegramDocument({
                caption: `🧾 Accept trace (redacted)\n${when.toUpperCase()} | Account ${agent.id} | Job ${job?.id || 'unknown'}\nReason: ${reason}`,
                filename: fname,
                buffer: buf
            });

            if (ACCEPT_TRACE_SAVE_UNREDACTED_LOCAL && acceptTraceRaw && acceptTraceRaw.length > 0) {
                try {
                    const tracesDir = path.join(__dirname, 'accept_traces');
                    fs.mkdirSync(tracesDir, { recursive: true });
                    const localName = `accept_trace_${when}_UNREDACTED_acc${agent.id}_job${job?.id || 'unknown'}_${Date.now()}.json`;
                    const localPath = path.join(tracesDir, localName);
                    const localPayload = {
                        capturedAt: new Date().toISOString(),
                        accountId: agent.id,
                        jobId: job?.id,
                        jobUrl: displayUrl,
                        when,
                        reason,
                        note: 'UNREDACTED LOCAL TRACE: contains sensitive auth/cookies/tokens. Do not share.',
                        trace: acceptTraceRaw
                    };
                    fs.writeFileSync(localPath, JSON.stringify(localPayload, null, 2), 'utf8');
                    console.log(`[Account ${agent.id}] Saved unredacted accept trace locally: ${localPath}`);
                } catch (e) {
                    console.error(`[Account ${agent.id}] Failed to save unredacted accept trace locally: ${e.message}`);
                }
            }
        };

        const notifyFailure = async (reason) => {
            try {
                // Hack to bypass GitHub Secret masking (insert space after https://)
                const displayUrl = (job?.url || '').replace('https://', 'https:// ');
                const rawPrice = String(job?.price ?? '').split('').join(' ');
                const title = (job?.title ? `\nTitle: ${job.title}` : '');

                let screenshot;
                try {
                    screenshot = await page.screenshot({ fullPage: true });
                } catch (_) {
                    screenshot = undefined;
                }

                const msg = `❌ Account ${agent.id} FAILED to take job\nReason: ${reason}${title}\nPrice: $${job?.price}\nType: ${job?.isGrouped ? 'Grouped' : 'Single'}\nURL: ${displayUrl}\n(Price raw: [ ${rawPrice} ])`;
                // Fire-and-forget so failures don't stall the swarm.
                sendDualAlert(msg, `Job take failed: ${reason}`, screenshot)
                    .catch(err => console.error(`Background Failure Notification Failed: ${err.message}`));

                // Optional: Send redacted XHR/fetch trace to Telegram for building a future direct-API flow.
                maybeSendAcceptTrace({ reason, when: 'failure' }).catch(() => {});
            } catch (_) {
                // Never let notifications break the worker.
            }
        };

        // --- VISIBILITY SPOOFING ---
        // Force the page to believe it's always visible and active
        await page.addInitScript(() => {
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true // Allow subsequent overrides if needed
            });
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true
            });
            // Optional: Mock window focus
            window.hasFocus = () => true;
        });

        // Speed Optimization: Block images/fonts on the specific TASK page for all agents (including Agent 1)
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,webm,ico}', route => route.abort());

        // Hack to bypass GitHub Secret masking (insert space after https://)
        const displayUrl = job.url.replace('https://', 'https:// ');
        console.log(`[Account ${agent.id}] Handling Job: ${displayUrl}`);

        // Agent 1 clicks, others go direct
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });

        // IMPORTANT: Some UIs hide the "Accept task" button unless the tab is active.
        // In headed mode, we bring it to the front before attempting to detect/click.
        try { await page.bringToFront(); } catch (e) { /* ignore */ }

        // Triple-Retry Logic for Accept Button
        let acceptBtn = null;
        // First attempt after 0.3s (0.1s was too early / unreliable).
        const attempts = [300, 500, 1000]; // 300ms, 500ms, 1000ms waits

        for (let i = 0; i < attempts.length; i++) {
            if (attempts[i] > 0) await page.waitForTimeout(attempts[i]);

            // Re-affirm focus between retries (headed mode).
            try { await page.bringToFront(); } catch (e) { /* ignore */ }

            console.log(`[Account ${agent.id}] Identifying Accept button (Attempt ${i + 1})...`);
            // Prefer CSS selector for speed, but keep text-based fallbacks.
            acceptBtn = page
                .locator('button.cgt-button--primary:has-text("Accept task"), .cgt-button--primary:has-text("Accept task")')
                .or(page.getByText('Accept task', { exact: true }))
                .or(page.locator('button:has-text("Accept task")'));
            if (await acceptBtn.count() > 0) break;

            // Early Exit Optimization: Check if "Too Late" message appeared
            const tooLateInfo = page.getByText('Oops, looks like you are too late', { exact: false });
            if (await tooLateInfo.count() > 0) {
                acceptBtn = null; // Ensure null so we skip
                console.log(`[Account ${agent.id}] FAILED: Job already taken (Early Exit on Attempt ${i + 1})`);
                return { ok: false, reason: 'too_late' };
            }
            acceptBtn = null;
        }

        let clickedAccept = false;
        let clickedYes = false;

        if (acceptBtn) {
            try { await page.bringToFront(); } catch (e) { /* ignore */ }
            await acceptBtn.first().click();
            clickedAccept = true;
            console.log(`[Account ${agent.id}] Clicked Accept Task...`);

            // Handle Modal
            await page.waitForTimeout(500); // Shorter wait for modal
            // Prefer role/text first (safer than global CSS), then fall back to provided CSS selector.
            const confirmBtn = page.getByRole('button', { name: 'Yes' })
                .or(page.getByText('Yes', { exact: true }))
                .or(page.getByRole('button', { name: 'Confirm' }))
                .or(page.getByRole('button', { name: 'OK' }))
                .or(page.locator('button.cgt-button--primary:nth-child(2)'));

            // Click "Yes" with a retry after 1s.
            for (let yesAttempt = 0; yesAttempt < 2; yesAttempt++) {
                if (yesAttempt === 1) await page.waitForTimeout(1000);
                try { await page.bringToFront(); } catch (e) { /* ignore */ }

                if (await confirmBtn.count() > 0) {
                    try {
                        await confirmBtn.first().click();
                        clickedYes = true;
                        console.log(`[Account ${agent.id}] Clicked Modal Confirmation (Attempt ${yesAttempt + 1}).`);
                        break;
                    } catch (e) {
                        console.log(`[Account ${agent.id}] Confirm click failed (Attempt ${yesAttempt + 1}): ${e.message}`);
                    }
                }
            }

            // SIMPLE VERIFICATION:
            // If we successfully clicked BOTH Accept + Yes, and we are NOT redirected to
            // https://example.invalid/modeling-requests?forbidden=true, count as taken.
            if (clickedAccept && clickedYes) {
                try {
                    await page.waitForTimeout(1000);
                } catch (_) { /* ignore */ }

                const endUrl = page.url();
                const isForbidden = endUrl.includes('forbidden=true');
                if (!isForbidden) {
                    const screenshot = await page.screenshot({ fullPage: true });
                    const rawPrice = String(job.price).split('').join(' ');
                    const msg = `✅ Account ${agent.id} SECURED Job!\nPrice: $${job.price}\nType: ${job.isGrouped ? 'Grouped' : 'Single'}`;
                    console.log(`[Account ${agent.id}] SUCCESS! Price: [ ${rawPrice} ]`);
                    sendDualAlert(msg, `Job Secured ($${job.price})`, screenshot)
                        .catch(err => console.error(`Background Notification Failed: ${err.message}`));

                    // Optional: capture the successful accept/confirm request sequence.
                    maybeSendAcceptTrace({ reason: 'secured', when: 'success' }).catch(() => {});

                    return { ok: true, reason: 'secured' };
                }

                console.log(`[Account ${agent.id}] FAILED: Redirected to forbidden page after Accept+Yes.`);
                await notifyFailure('redirected_forbidden_after_accept_yes');
                return { ok: false, reason: 'forbidden' };
            }

            console.log(`[Account ${agent.id}] No confirmation modal found/clicked. (clickedAccept=${clickedAccept}, clickedYes=${clickedYes})`);
            // If we clicked Accept but couldn't complete the modal flow, send a screenshot for debugging.
            if (clickedAccept && !clickedYes) {
                await notifyFailure('confirm_modal_missing_or_not_clicked');
            }
        } else {
            console.log(`[Account ${agent.id}] Accept button not found after ${attempts.length} attempts.`);
            // "Too Late" Detection
            const tooLate = page.getByText('Oops, looks like you are too late', { exact: false });
            if (await tooLate.count() > 0) {
                console.log(`[Account ${agent.id}] FAILED: Job already taken by another user ("Too Late" message found).`);
            } else {
                console.log(`[Account ${agent.id}] FAILED: Button missing and no "Too Late" message found. (Site lag or layout change?)`);
                // Key debug case: capture the page so we can see what's on-screen.
                await notifyFailure('accept_button_missing_no_too_late_message');
            }
        }
    } catch (e) {
        console.error(`[Account ${agent.id}] Error processing job ${job.url}: ${e.message}`);
        try {
            if (page) await notifyFailure(`exception: ${e.message}`);
        } catch (_) { /* ignore */ }
    } finally {
        if (page) await page.close();
    }
    return { ok: false, reason: 'failed' };
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

    // Google Sheets logging (non-blocking; does not affect accept speed)
    const sheetsLogger = createSheetsLogger();

    const SHEETS_TEST_MODE = /^(1|true|on|yes)$/i.test(process.env.SHEETS_TEST_MODE || '');
    if (SHEETS_TEST_MODE) {
        console.log('[Sheets] TEST MODE enabled. Sending dummy rows and exiting.');

        const dummyBase = {
            id: `test_${Date.now()}`,
            url: 'https://example.com/job/brief',
            title: 'Sheets Test Job',
            originalPrice: 20,
            finalPrice: 25,
            multiplier: 1.25,
            complexity: 4,
            groupType: 'variations',
            tags: ['test', 'dummy'],
            isGrouped: true,
            variations: 4,
            pricePerUnit: 6.25
        };

        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_taken` }, 'taken');
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_failed` }, 'failed');
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_low_price` }, 'ignored_low_price');
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_capacity` }, 'ignored_capacity');
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_check_only` }, 'check_only');

        await sheetsLogger.flushNow();
        console.log('[Sheets] TEST MODE done.');
        process.exit(0);
    }

    const showBrowser = process.env.SHOW_BROWSER === 'true';

    // Safety Mode Override: If checkOnly, only use the first account for spotting
    const effectiveAccounts = CONFIG.checkOnly ? [ACTIVE_ACCOUNTS[0]] : ACTIVE_ACCOUNTS;
    console.log(`Debug: Initializing ${effectiveAccounts.length} accounts.`);

    const browser = await chromium.launch({ headless: !showBrowser });
    const agents = [];
    sheetsLogger.start();

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
                    // OPTIMIZED SPY: Only log main jobs list, skip product detail noise
                    if (response.url().includes('available-requests') && response.status() === 200) {
                        const body = await response.text();
                        if (body.includes('"uid"') || body.includes('"price"') || body.includes('"id"')) {
                            console.log('\n🔍 --- SNIPER DATA CAPTURED (SAFE MODE) ---');
                            // Safe Log: Parse and log critical fields with spacing to bypass masking
                            try {
                                const data = JSON.parse(body);
                                const jobs = data.data || [];
                                jobs.forEach(j => {
                                    const attrs = j.attributes || {};
                                    const safeId = String(j.id).split('').join(' ');
                                    const safeTitle = String(attrs.title).split('').join(' ');
                                    const isGrouped = attrs.partOfGroupOfRequests === true;
                                    const groupedPrice = attrs.groupData?.pricingInformation?.price;
                                    const itemPrice = attrs.pricingInformation?.price;
                                    const priceForLog = (isGrouped ? (groupedPrice ?? itemPrice) : itemPrice) ?? attrs.compensation;
                                    const safePrice = String(priceForLog).split('').join(' ');

                                    console.log(`[Job] ID: ${safeId}`);
                                    console.log(`      Title: ${safeTitle}`);
                                    console.log(`      Price: ${safePrice}`);
                                    console.log('--------------------------------------------------');
                                });
                            } catch (e) {
                                console.log('[SafeLog Error] Could not parse JSON body.');
                            }
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
    const MIN_CYCLE_DURATION = CONFIG.checkInterval * 1000;
    const startTime = Date.now();
    let iterations = 0;
    let keepRunning = true;
    let isDispatching = false; // The Lock 🔒

    // Flood guard: if a single check returns too many available jobs, switch to check-only for the rest of the run.
    const MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY = (() => {
        const n = parseInt(process.env.MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY || '20', 10);
        return Number.isFinite(n) ? Math.max(0, n) : 20;
    })();
    let forcedCheckOnly = false;

    // If new jobs are detected while dispatching, we queue them instead of dropping them.
    const pendingJobsById = new Map();
    const seenJobIdsThisRun = new Set();
    const DISPATCH_QUEUE_ALERT_COOLDOWN_MS = Math.max(0, parseInt(process.env.DISPATCH_QUEUE_ALERT_COOLDOWN_MS || '15000', 10) || 15000);
    const CAPACITY_FULL_ALERT_COOLDOWN_MS = Math.max(0, parseInt(process.env.CAPACITY_FULL_ALERT_COOLDOWN_MS || '30000', 10) || 30000);
    let lastQueuedAlertAt = 0;
    let lastCapacityFullAlertAt = 0;

    function enqueuePendingJobs(jobs) {
        for (const job of jobs || []) {
            if (!job || job.id === undefined || job.id === null) continue;
            pendingJobsById.set(String(job.id), job);
        }
    }

    function fireAndForgetSpotterAlert({ telegramMsg, ntfyMsg, cooldownMs, getLastAt, setLastAt }) {
        const now = Date.now();
        const lastAt = getLastAt();
        if (cooldownMs > 0 && now - lastAt < cooldownMs) return;
        setLastAt(now);

        void (async () => {
            try {
                const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                await sendDualAlert(telegramMsg, ntfyMsg, screenshotBuffer);
            } catch (e) {
                // Best-effort: If screenshot fails, still send a text alert.
                try {
                    await sendDualAlert(telegramMsg, ntfyMsg);
                } catch (_) {
                    // ignore
                }
            }
        })().catch(() => {});
    }

    function drainPendingJobsSoon() {
        if (isDispatching) return;
        if (pendingJobsById.size === 0) return;

        const jobs = Array.from(pendingJobsById.values());
        pendingJobsById.clear();

        // Run next tick to avoid deep recursion / stack growth.
        setTimeout(() => {
            triggerSwarm(jobs).catch(err => console.error('Swarm Trigger Error (drain):', err.message));
        }, 0);
    }

    // Helper: The Swarm Trigger
    async function triggerSwarm(validJobs) {
        const effectiveCheckOnly = CONFIG.checkOnly || forcedCheckOnly;

        if (effectiveCheckOnly) {
            // In check-only, we do not attempt accepts, but we still log + alert.
            if (isDispatching) {
                (validJobs || []).forEach(j => sheetsLogger.enqueue(j, 'check_only'));

                fireAndForgetSpotterAlert({
                    telegramMsg: `🛡️ Check Only Mode active. Logged ${validJobs.length} jobs (dispatch in progress).`,
                    ntfyMsg: `Check-only: logged ${validJobs.length} jobs during dispatch`,
                    cooldownMs: DISPATCH_QUEUE_ALERT_COOLDOWN_MS,
                    getLastAt: () => lastQueuedAlertAt,
                    setLastAt: v => { lastQueuedAlertAt = v; }
                });

                return;
            }

            isDispatching = true;
            console.log(`\n🛡️ [EVENT TRIGGER] Check Only Mode. Logging ${validJobs.length} jobs (no accepts).`);

            (validJobs || []).forEach(j => sheetsLogger.enqueue(j, 'check_only'));

            try {
                const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                await sendDualAlert(`🚨 [Event] Jobs Detected (Check Only)`, `Tasks available! (Auto-Accept Disabled)`, screenshotBuffer);
            } catch (e) {
                await sendDualAlert(`🚨 [Event] Jobs Detected (Check Only)`, `Tasks available! (Auto-Accept Disabled)`);
            }

            isDispatching = false;
            drainPendingJobsSoon();
            return;
        }

        if (isDispatching) {
            // Do not drop detections during an active dispatch.
            enqueuePendingJobs(validJobs);

            // Policy: Only log Detected (Queued) the FIRST time we ever see this job ID in this run.
            // This prevents the Jobs view from regressing a later status back to Detected (Queued).
            (validJobs || []).forEach(j => {
                const id = j?.id;
                if (id === undefined || id === null) return;
                const key = String(id);
                if (seenJobIdsThisRun.has(key)) return;
                seenJobIdsThisRun.add(key);
                sheetsLogger.enqueue(j, 'detected_queued');
            });

            fireAndForgetSpotterAlert({
                telegramMsg: `📥 Jobs detected while swarm is dispatching. Queued ${validJobs.length} jobs for next pass.`,
                ntfyMsg: `Queued ${validJobs.length} jobs during dispatch`,
                cooldownMs: DISPATCH_QUEUE_ALERT_COOLDOWN_MS,
                getLastAt: () => lastQueuedAlertAt,
                setLastAt: v => { lastQueuedAlertAt = v; }
            });

            return; // Let current dispatch finish; queued jobs will drain after.
        }

        // Mark these job IDs as seen for this run (so later dispatch-time detections won't re-log detected_queued).
        (validJobs || []).forEach(j => {
            const id = j?.id;
            if (id === undefined || id === null) return;
            seenJobIdsThisRun.add(String(id));
        });
        isDispatching = true;
        console.log(`\n🚀 [EVENT TRIGGER] Dispatching ${validJobs.length} jobs to swarm IMMEDIATELY...`);

        // A. Filter & Dispatch (using Cache)
        const singleJobs = validJobs.filter(j => !j.isGrouped && j.price >= CONFIG.minPriceSingle).sort((a, b) => b.price - a.price);
        const groupedJobs = validJobs.filter(j => j.isGrouped && j.pricePerUnit >= CONFIG.minPriceVariation).sort((a, b) => b.price - a.price);
        const jobsToAssign = [...singleJobs, ...groupedJobs];

        if (jobsToAssign.length === 0) {
            console.log('[Event] No jobs matched price criteria.');

            // Log all detected jobs as ignored (too cheap) without slowing down.
            validJobs.forEach(j => sheetsLogger.enqueue(j, 'ignored_low_price'));

            // CHEAP JOB WARNING
            // If we have valid jobs but filtered them all out, warn the user
            if (validJobs.length > 0) {
                console.log('⚠️ [Event] Jobs ignored due to low price. Sending warning...');
                try {
                    const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                    // Fire and forget
                    const ignoredPrices = validJobs.map(j => `$${j.price}`).join(', ');
                    sendDualAlert(`⚠️ Jobs Ignored (Too Cheap): ${ignoredPrices}`, `Jobs Ignored: ${ignoredPrices}`, screenshotBuffer)
                        .catch(e => console.error('Cheap Job Alert Failed:', e.message));
                } catch (e) {
                    console.error('Failed to capture cheap job screenshot:', e.message);
                }
            }

            isDispatching = false;
            drainPendingJobsSoon();
            return;
        }

        const agentQueues = {};
        agents.forEach(a => agentQueues[a.id] = []);
        const currentCapacities = JSON.parse(JSON.stringify(capacityCache));

        for (const job of jobsToAssign) {
            const requiredType = job.isGrouped ? 'grouped' : 'single';
            // Explicitly iterate agents in order (1, 2, 3...) to ensure Greedy Assignment
            // Agent 1 gets first dibs on the highest price job, then the next, until full.
            const bestAgent = agents.find(a => currentCapacities[a.id][requiredType].available > 0);

            if (bestAgent) {
                agentQueues[bestAgent.id].push(job);
                currentCapacities[bestAgent.id][requiredType].available--;
            }
        }

        const totalJobs = Object.values(agentQueues).flat().length;
        if (totalJobs > 0) {
            // --- THE ATTACK ---
            await Promise.all(agents.map(async (agent) => {
                const queue = agentQueues[agent.id];
                if (queue && queue.length > 0) {
                    console.log(`[Account ${agent.id}] Parallel attack on ${queue.length} jobs...`);
                    while (queue.length > 0) {
                        const batch = queue.splice(0, CONFIG.maxConcurrentTabs);
                        const results = await Promise.all(batch.map(j => processJob(agent, j)));

                        // Non-blocking logging of outcomes.
                        results.forEach((res, idx) => {
                            const job = batch[idx];
                            if (!job) return;
                            if (res && res.ok) sheetsLogger.enqueue(job, 'taken');
                            else if (res && res.reason === 'too_late') sheetsLogger.enqueue(job, 'failed');
                            else sheetsLogger.enqueue(job, 'failed');
                        });
                    }
                }
            }));

            // --- POST-PROCESSING ---
            try {
                console.log('🔄 Swarm done. Ensuring Spotter (Agent 1) is still active...');
                if (!Agent1.page.url().includes(CONFIG.url)) {
                    console.log('⚠️ [Agent 1] Spotter drifted! Returning to post...');
                    await Agent1.page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                }

                // Always take a screenshot of the swarm event for the user's peace of mind
                // This happens in parallel with workers, so it doesn't slow them down.
                const screenshotBuffer = await Agent1.page.screenshot({ fullPage: true });
                sendDualAlert(`🎯 Swarm Complete!`, `Processing complete.`, screenshotBuffer).catch(e => console.error('BG Alert Error:', e.message));

                console.log('🔄 Deep Refreshing for capacity scan...');
                await Promise.all(agents.map(async (agent) => {
                    // Spotter (Agent 1) should reload to refresh session/capacity token
                    // But we do it carefully
                    await agent.page.reload({ waitUntil: 'networkidle' });
                }));

                console.log('Updating memory with fresh capacities...');
                await Promise.all(agents.map(async (agent) => {
                    const cap = await getCapacity(agent.page);
                    capacityCache[agent.id] = cap;
                    console.log(`[Account ${agent.id}] Capacity updated: ${cap.single.available}/${cap.grouped.available}`);
                }));
            } catch (e) {
                console.error('Post-processing error:', e.message);
            }
        } else {
            console.log('[Event] No agents have capacity for these jobs.');

            // Log jobs as ignored due to capacity.
            jobsToAssign.forEach(j => sheetsLogger.enqueue(j, 'ignored_capacity'));

            // Optional alert with screenshot so we don't silently miss opportunities.
            fireAndForgetSpotterAlert({
                telegramMsg: `⚠️ Jobs detected but capacity is full. (Queued count: 0)\nPassing price filter: ${jobsToAssign.length}`,
                ntfyMsg: `Capacity full: ${jobsToAssign.length} jobs passed price filter`,
                cooldownMs: CAPACITY_FULL_ALERT_COOLDOWN_MS,
                getLastAt: () => lastCapacityFullAlertAt,
                setLastAt: v => { lastCapacityFullAlertAt = v; }
            });
        }

        isDispatching = false;
        drainPendingJobsSoon();
    }

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
                    const isGrouped = attr.partOfGroupOfRequests === true;

                    const jobUrl = `${CONFIG.url}/${item.id}/brief`;
                    const price = getJobPriceFromAttributes(attr);
                    const originalPrice = getJobOriginalPriceFromAttributes(attr);
                    const multiplier = getJobMultiplierFromAttributes(attr);
                    const complexity = (attr.complexity ?? attr.groupData?.complexity) ?? '';
                    const title = attr.title ?? '';
                    const groupType = attr.groupType ?? '';
                    const tags = Array.isArray(attr.tags) ? attr.tags : [];

                    // Unmasked pricing in logs for Sniper verification
                    const rawPriceLog = String(price).split('').join(' ');
                    console.log(`[Sniper] Detected Job ${item.id} | Price: [ ${rawPriceLog} ]`);

                    const variations = isGrouped ? (attr.groupData?.size || 1) : 1;

                    return {
                        id: item.id,
                        url: jobUrl,
                        price: price,
                        finalPrice: price,
                        originalPrice,
                        multiplier,
                        complexity,
                        title,
                        groupType,
                        tags,
                        isGrouped: isGrouped,
                        variations,
                        pricePerUnit: isGrouped ? (price / variations) : price
                    };
                });

                lastSniperJobs = parsed;
                if (parsed.length > 0) {
                    console.log(`[Sniper] 🎯 Captured ${parsed.length} jobs via API.`);
                }

                // Flood guard: if too many jobs appear at once, switch to check-only for the rest of this run.
                if (!forcedCheckOnly && MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY > 0 && parsed.length > MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY) {
                    forcedCheckOnly = true;
                    pendingJobsById.clear();
                    console.error(`\n🚨 [Flood Guard] Detected ${parsed.length} jobs in a single check (> ${MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY}). Switching to CHECK ONLY for the rest of the run.`);

                    fireAndForgetSpotterAlert({
                        telegramMsg: `🚨 Flood Guard: ${parsed.length} jobs detected at once. Switching to CHECK ONLY (no auto-accept) for the rest of the run.`,
                        ntfyMsg: `Flood Guard: ${parsed.length} jobs → check-only for rest of run`,
                        cooldownMs: 0,
                        getLastAt: () => 0,
                        setLastAt: () => {}
                    });
                }

                // Always allow re-triggering accepts; Sheets logging has its own dedupe.
                if (parsed.length > 0) {
                    triggerSwarm(parsed).catch(err => console.error('Swarm Trigger Error:', err.message));
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
                    // Logic already triggered by JSON or phrase is missing (loading?)
                    if (isDispatching) {
                        console.log('⏳ Swarm attack currently in progress (Event-Triggered). Waiting for completion...');
                        while (isDispatching) await Agent1.page.waitForTimeout(500);
                    } else {
                        console.log('❌ Phrase NOT FOUND but no event triggered. (Server lag?). Waiting for next cycle.');
                    }

                    const elapsed = Date.now() - cycleStart;
                    const waitTime = Math.max(0, MIN_CYCLE_DURATION - elapsed);
                    await Agent1.page.waitForTimeout(waitTime);
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
