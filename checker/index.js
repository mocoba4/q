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


async function sendTelegramAlert(message, _imageBuffer) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
        console.error('Missing Telegram configuration');
        return;
    }

    try {
        // Text-only notifications (no screenshots).
        await axios.post(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
            chat_id: CONFIG.telegramChatId,
            text: message
        });
        console.log('Telegram text sent.');
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

async function sendNtfyAlert(message, _imageBuffer) {
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

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Text-only notifications (no screenshots).
            await axios.post(url, message, { headers, timeout: 10000 });
            console.log('ntfy text sent.');
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

const isTruthyEnv = (v) => /^(1|true|on|yes)$/i.test(String(v || '').trim());
const NUCLEAR_ACCEPT_ENABLED = isTruthyEnv(process.env.NUCLEAR_ACCEPT || '');

// When enabled, we ignore jobs tagged as "high-poly" / "high poly".
// Enabled: LOWPOLY_ONLY_MODE=1, Disabled: LOWPOLY_ONLY_MODE=0 (or unset)
const LOWPOLY_ONLY_MODE = isTruthyEnv(process.env.LOWPOLY_ONLY_MODE || '');

// Optional word filter: ignore jobs if the title contains any of these keywords.
// Configure as a comma/newline-separated list. Example: "X-mas, Christmas, Mask"
function parseKeywordList(v) {
    const raw = String(v ?? '').trim();
    if (!raw) return [];
    return raw
        .split(/[\n,]+/g)
        .map(s => String(s || '').trim())
        .filter(Boolean);
}

const TITLE_FILTER_KEYWORDS = parseKeywordList(process.env.TITLE_FILTER_KEYWORDS);

function titleMatchesKeywordFilter(job) {
    if (!TITLE_FILTER_KEYWORDS || TITLE_FILTER_KEYWORDS.length === 0) return false;
    const title = String(job?.title ?? '').toLowerCase();
    if (!title) return false;
    return TITLE_FILTER_KEYWORDS.some(w => title.includes(String(w).toLowerCase()));
}

function isHighPolyJob(job) {
    const tags = job?.tags;
    if (!tags) return false;

    const tagList = Array.isArray(tags) ? tags : [tags];
    const combined = tagList.map(t => String(t || '')).join(' ');
    return /\bhigh[\s-]?poly\b/i.test(combined);
}

// Global per-account caps: limit how many tasks of each type we are willing to hold,
// regardless of the UI's max capacity. Example: if UI shows 6/12 and MAX_TAKE_GROUPED=8,
// we will accept at most 2 more grouped tasks (to reach 8/12).
function parsePositiveIntOrNull(v) {
    const s = String(v ?? '').trim();
    // Empty / unset => disabled cap (original behavior)
    if (!s) return null;
    // Explicit opt-out: allow setting secret to "max" to mean "no cap".
    if (/^max$/i.test(s)) return null;

    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

const MAX_TAKE_SINGLE = parsePositiveIntOrNull(process.env.MAX_TAKE_SINGLE);
const MAX_TAKE_GROUPED = parsePositiveIntOrNull(process.env.MAX_TAKE_GROUPED);

function applyGlobalTakeCaps(cap) {
    const out = JSON.parse(JSON.stringify(cap || { single: { current: 0, max: 0, available: 0 }, grouped: { current: 0, max: 0, available: 0 } }));

    const singleLimit = MAX_TAKE_SINGLE;
    const groupedLimit = MAX_TAKE_GROUPED;

    if (singleLimit) {
        const cur = Number(out?.single?.current) || 0;
        const avail = Number(out?.single?.available) || 0;
        const allowedRemaining = Math.max(0, singleLimit - cur);
        out.single.available = Math.min(avail, allowedRemaining);
    }

    if (groupedLimit) {
        const cur = Number(out?.grouped?.current) || 0;
        const avail = Number(out?.grouped?.available) || 0;
        const allowedRemaining = Math.max(0, groupedLimit - cur);
        out.grouped.available = Math.min(avail, allowedRemaining);
    }

    return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms || 0)));

function getNuclearDelayBounds() {
    const min = parseInt(process.env.NUCLEAR_ACCEPT_DELAY_MIN_MS || '50', 10);
    const max = parseInt(process.env.NUCLEAR_ACCEPT_DELAY_MAX_MS || '100', 10);
    const minMs = Number.isFinite(min) ? Math.max(0, min) : 50;
    const maxMs = Number.isFinite(max) ? Math.max(minMs, max) : Math.max(minMs, 100);
    return { minMs, maxMs };
}

function getNuclearDelayMs() {
    const { minMs, maxMs } = getNuclearDelayBounds();
    if (maxMs <= minMs) return minMs;
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

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

async function getCsrfTokenForAgent(agent) {
    try {
        // CSRF tokens can rotate; don't cache forever.
        // Keep a short TTL to reduce meta-tag reads but avoid stale-token 403s.
        const now = Date.now();
        const ttlMs = 60 * 1000;
        if (agent && agent.csrfToken && typeof agent.csrfTokenUpdatedAt === 'number' && (now - agent.csrfTokenUpdatedAt) < ttlMs) {
            return agent.csrfToken;
        }
        const page = agent?.page;
        if (!page) return '';

        // Most Rails apps expose CSRF in a meta tag.
        let token = '';
        try {
            token = await page.evaluate(() => {
                const el = document.querySelector('meta[name="csrf-token"]');
                return (el && el.getAttribute('content')) || '';
            });
        } catch (_) {
            token = '';
        }

        if (!token) {
            // Best-effort: refresh the parked page and try again.
            try {
                await page.reload({ waitUntil: 'domcontentloaded' });
                token = await page.evaluate(() => {
                    const el = document.querySelector('meta[name="csrf-token"]');
                    return (el && el.getAttribute('content')) || '';
                });
            } catch (_) {
                token = '';
            }
        }

        if (token && agent) {
            agent.csrfToken = token;
            agent.csrfTokenUpdatedAt = Date.now();
        }
        return token || '';
    } catch (_) {
        return '';
    }
}

async function processJobNuclear(agent, job) {
    try {
        const origin = new URL(CONFIG.url).origin;
        const acceptUrl = `${origin}/modeling-requests/${encodeURIComponent(String(job.id))}/update-status?status=accepted`;

        const roundDeadline = job?.roundDeadline || job?.nextRoundDeadline || '';
        if (!roundDeadline) {
            console.error(`[Account ${agent.id}] Nuclear accept skipped: missing round_deadline for job ${job?.id}`);
            return { ok: false, reason: 'missing_round_deadline' };
        }

        const csrfToken = await getCsrfTokenForAgent(agent);
        if (!csrfToken) {
            console.error(`[Account ${agent.id}] Nuclear accept skipped: missing x-csrf-token for job ${job?.id}`);
            return { ok: false, reason: 'missing_csrf' };
        }

        const displayUrl = (job?.url || '').replace('https://', 'https:// ');
        console.log(`[Account ${agent.id}] ⚡ Nuclear accept: ${displayUrl}`);

        const resp = await agent.context.request.post(acceptUrl, {
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'origin': origin,
                'referer': job.url,
                'x-csrf-token': csrfToken
            },
            data: { round_deadline: roundDeadline }
        });

        const status = resp.status();
        if (status === 200) {
            const rawPrice = String(job?.price ?? '').split('').join(' ');
            console.log(`[Account ${agent.id}] ✅ Nuclear accept SUCCESS (HTTP 200). Price: [ ${rawPrice} ]`);

            // Keep notifications lightweight to preserve speed (no screenshots).
            sendDualAlert(
                `✅ Account ${agent.id} SECURED Job! (NUCLEAR)\nPrice: $${job?.price}\nType: ${job?.isGrouped ? 'Grouped' : 'Single'}`,
                `Job Secured (NUCLEAR) ($${job?.price})`
            ).catch(() => {});

            return { ok: true, reason: 'secured', method: 'nuclear', status };
        }

        if (status === 403) {
            console.log(`[Account ${agent.id}] ❌ Nuclear accept FAILED (HTTP 403).`);
            // CSRF tokens can become stale/invalid; clear cache so next accept refreshes.
            if (agent) {
                agent.csrfToken = '';
                agent.csrfTokenUpdatedAt = 0;
            }
            return { ok: false, reason: 'forbidden', method: 'nuclear', status };
        }

        console.log(`[Account ${agent.id}] ❌ Nuclear accept FAILED (HTTP ${status}).`);
        return { ok: false, reason: `http_${status}`, method: 'nuclear', status };
    } catch (e) {
        console.error(`[Account ${agent.id}] Nuclear accept error for job ${job?.id}: ${e.message}`);
        return { ok: false, reason: 'exception', method: 'nuclear' };
    }
}

// --- JOB PROCESSING ---
async function processJob(agent, job) {
    if (NUCLEAR_ACCEPT_ENABLED) {
        return await processJobNuclear(agent, job);
    }

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

                const msg = `❌ Account ${agent.id} FAILED to take job\nReason: ${reason}${title}\nPrice: $${job?.price}\nType: ${job?.isGrouped ? 'Grouped' : 'Single'}\nURL: ${displayUrl}\n(Price raw: [ ${rawPrice} ])`;
                // Fire-and-forget so failures don't stall the swarm.
                sendDualAlert(msg, `Job take failed: ${reason}`)
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
            // /modeling-requests?forbidden=true, count as taken.
            if (clickedAccept && clickedYes) {
                try {
                    await page.waitForTimeout(1000);
                } catch (_) { /* ignore */ }

                const endUrl = page.url();
                const isForbidden = endUrl.includes('forbidden=true');
                if (!isForbidden) {
                    const rawPrice = String(job.price).split('').join(' ');
                    const msg = `✅ Account ${agent.id} SECURED Job!\nPrice: $${job.price}\nType: ${job.isGrouped ? 'Grouped' : 'Single'}`;
                    console.log(`[Account ${agent.id}] SUCCESS! Price: [ ${rawPrice} ]`);
                    sendDualAlert(msg, `Job Secured ($${job.price})`)
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

    if (NUCLEAR_ACCEPT_ENABLED) {
        console.log('⚡ NUCLEAR_ACCEPT is ENABLED. Accepts use direct POST (async; no spacing).');
    } else {
        console.log('🧭 NUCLEAR_ACCEPT is disabled. Using UI click flow.');
    }

    if (LOWPOLY_ONLY_MODE) {
        console.log('🟩 LOWPOLY_ONLY_MODE is ENABLED. High-poly jobs will be ignored and logged as "Ignored: High Poly".');
    }

    if (TITLE_FILTER_KEYWORDS.length > 0) {
        console.log(`🧹 TITLE_FILTER_KEYWORDS is ENABLED. Ignoring jobs whose title contains any of ${TITLE_FILTER_KEYWORDS.length} keyword(s).`);
    }

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
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_high_poly` }, 'ignored_high_poly');
        sheetsLogger.enqueue({ ...dummyBase, id: `${dummyBase.id}_word_filter` }, 'ignored_word_filter');
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

    // Cache the exact API URL used by the site for available requests.
    // We'll seed this from normal page traffic on startup, then poll it directly.
    const availableRequestsUrlByAgentId = {};

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
        // Seed the exact available-requests URL from real page traffic (for direct polling).
        page.on('response', async response => {
            try {
                if (response.url().includes('available-requests') && response.status() === 200) {
                    availableRequestsUrlByAgentId[acc.id] = response.url();

                    // Safe-mode logging only for the primary spotter (Account 1).
                    if (acc.id !== 1) return;

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
    const capacityCache = {}; // last scanned (actual)
    const expectedCapacityCache = {}; // local expected (used for planning during burst+nuclear)
    await Promise.all(agents.map(async (agent) => {
        const cap = await getCapacity(agent.page);
        capacityCache[agent.id] = cap;
        expectedCapacityCache[agent.id] = applyGlobalTakeCaps(cap);

        const eff = expectedCapacityCache[agent.id];
        const capNote = (MAX_TAKE_SINGLE || MAX_TAKE_GROUPED)
            ? ` (caps: single=${MAX_TAKE_SINGLE ?? 'off'}, grouped=${MAX_TAKE_GROUPED ?? 'off'})`
            : '';
        console.log(`[Account ${agent.id}] Init Capacity: Single ${eff.single.available}/${cap.single.available} | Grouped ${eff.grouped.available}/${cap.grouped.available}${capNote}`);
    }));

    // --- MAIN LOOP ---
    const Agent1 = agents[0]; // Primary Spotter (Account 1)
    const Agent2 = agents.length >= 2 ? agents[1] : null; // Secondary Spotter (Account 2)
    const LOOP_DURATION = 6 * 60 * 60 * 1000;
    const MIN_CYCLE_DURATION = CONFIG.checkInterval * 1000;

    // --- BURST MODE (default; not secret-toggled) ---
    // When we detect ANY jobs, switch to 1s refresh cadence to avoid missing updates.
    // After jobs disappear, keep 1s cadence for 60s; if still no jobs, return to normal cadence.
    // Soft-ban mitigation: during burst, rotate the 1s refresh load across spotter accounts.
    const BURST_REFRESH_MS = 1000;
    const BURST_GRACE_NO_JOB_MS = 60 * 1000;
    const BURST_SPOTTER_SLICE_MS = 30 * 1000;
    let burstActive = false;
    let burstLastJobSeenAt = 0;
    let burstEnteredAt = 0;
    let lastBurstSpotterId = null;

    function enterBurstMode(reason) {
        const now = Date.now();
        if (!burstActive) {
            burstEnteredAt = now;
            lastBurstSpotterId = null;
        }
        burstActive = true;
        burstLastJobSeenAt = now;
        if (NUCLEAR_ACCEPT_ENABLED) nuclearBurstSeenSinceLastReconcile = true;
        console.log(`⚡ Burst mode ON (${reason}). Refreshing every ${BURST_REFRESH_MS}ms.`);
    }

    function maybeExitBurstMode() {
        if (!burstActive) return;
        const now = Date.now();
        if (burstLastJobSeenAt > 0 && (now - burstLastJobSeenAt) > BURST_GRACE_NO_JOB_MS) {
            burstActive = false;
            if (NUCLEAR_ACCEPT_ENABLED && nuclearBurstSeenSinceLastReconcile) capacityReconcileRequested = true;
            console.log(`🟢 Burst mode OFF (no jobs for ${Math.round(BURST_GRACE_NO_JOB_MS / 1000)}s). Returning to normal cadence.`);
        }
    }
    const startTime = Date.now();
    let iterations = 0;
    let keepRunning = true;
    let isDispatching = false; // The Lock 🔒

    // Capacity reconciliation (used when we defer scans during burst+nuclear)
    // Policy:
    // - While burstActive && nuclear enabled: don't do deep refresh/capacity scans.
    // - After burst ends: run ONE scan to reconcile.
    // - Only send Telegram/ntfy if expected != actual.
    let capacityReconcileRequested = false;
    let capacityReconciling = false;
    let nuclearBurstSeenSinceLastReconcile = false;

    function applyExpectedCapacityDelta(agentId, requiredType, deltaAccepted) {
        const id = Number(agentId);
        if (!Number.isFinite(id)) return;
        const cap = expectedCapacityCache[id];
        if (!cap || !cap[requiredType]) return;

        const entry = cap[requiredType];
        const delta = Number(deltaAccepted) || 0;
        if (delta === 0) return;

        entry.current = Math.max(0, (Number(entry.current) || 0) + delta);
        entry.available = Math.max(0, (Number(entry.available) || 0) - delta);
    }

    async function reconcileCapacitiesAfterBurst({ reason }) {
        if (capacityReconciling) return;
        capacityReconciling = true;

        const expectedSnapshot = JSON.parse(JSON.stringify(expectedCapacityCache));

        try {
            console.log(`🧮 Reconciling capacities after burst (${reason || 'burst_end'})...`);

            // Deep refresh so UI capacity reflects latest state.
            await Promise.all(agents.map(async (agent) => {
                try {
                    if (!agent.page.url().includes('modeling-requests')) {
                        await agent.page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                    }
                    await agent.page.reload({ waitUntil: 'networkidle' });
                } catch (e) {
                    console.error(`[Account ${agent.id}] Capacity reconcile reload failed: ${e.message}`);
                }
            }));

            const actual = {};
            await Promise.all(agents.map(async (agent) => {
                const cap = await getCapacity(agent.page);
                actual[agent.id] = cap;
            }));

            const mismatches = [];
            for (const agent of agents) {
                const id = agent.id;
                const exp = expectedSnapshot[id];
                const act = actual[id];
                if (!exp || !act) continue;

                const actEff = applyGlobalTakeCaps(act);

                for (const t of ['single', 'grouped']) {
                    const eAvail = exp?.[t]?.available;
                    const aAvail = actEff?.[t]?.available;
                    if (Number(eAvail) !== Number(aAvail)) {
                        mismatches.push(`A${id} ${t}: expected ${eAvail} vs actual ${aAvail}`);
                    }
                }
            }

            // Update caches to scanned reality.
            for (const [idStr, cap] of Object.entries(actual)) {
                const id = Number(idStr);
                capacityCache[id] = cap;
                expectedCapacityCache[id] = applyGlobalTakeCaps(cap);
            }

            if (mismatches.length > 0) {
                const msg = `🧮 Capacity reconcile (${reason || 'burst_end'}) discrepancies:\n${mismatches.join('\n')}`;
                await sendDualAlert(msg, msg);
            } else {
                console.log('🧮 Capacity reconcile: expected matches actual.');
            }
        } catch (e) {
            console.error(`Capacity reconcile failed: ${e.message}`);
        } finally {
            capacityReconciling = false;
            capacityReconcileRequested = false;
            nuclearBurstSeenSinceLastReconcile = false;
        }
    }

    // Flood guard: if a single check returns too many available jobs, switch to check-only for the rest of the run.
    const MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY = (() => {
        const n = parseInt(process.env.MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY || '20', 10);
        return Number.isFinite(n) ? Math.max(0, n) : 20;
    })();
    let forcedCheckOnly = false;

    // If new jobs are detected while dispatching, we queue them instead of dropping them.
    const pendingJobsById = new Map();
    const seenJobIdsThisRun = new Set();
    // Nuclear-mode guard: ensure we only attempt accepting a given job ID once per run.
    const nuclearAttemptedJobIds = new Set();
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
                await sendDualAlert(telegramMsg, ntfyMsg);
            } catch (_) { /* ignore */ }
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

    async function waitForSwarmToSettle(timeoutMs) {
        const start = Date.now();
        const timeout = Math.max(0, timeoutMs || 0);
        while (Date.now() - start < timeout) {
            if (!isDispatching && pendingJobsById.size === 0) return true;
            try { await Agent1.page.waitForTimeout(100); } catch (_) { /* ignore */ }
        }
        return !isDispatching && pendingJobsById.size === 0;
    }

    // Helper: The Swarm Trigger
    async function triggerSwarm(validJobs) {
        const effectiveCheckOnly = CONFIG.checkOnly || forcedCheckOnly;

        // Title keyword filter: ignore matching jobs and always log them.
        // This has priority over lowpoly-only and price filters.
        let filteredJobs = Array.isArray(validJobs) ? validJobs : [];
        if (TITLE_FILTER_KEYWORDS.length > 0 && filteredJobs.length > 0) {
            const keywordMatched = filteredJobs.filter(titleMatchesKeywordFilter);
            if (keywordMatched.length > 0) {
                keywordMatched.forEach(j => sheetsLogger.enqueue(j, 'ignored_word_filter'));
            }
            filteredJobs = filteredJobs.filter(j => !titleMatchesKeywordFilter(j));
        }

        // Lowpoly-only mode: ignore high-poly jobs and always log them.
        // This must happen before any dispatch/queue logic so we don't silently drop them.
        if (LOWPOLY_ONLY_MODE && filteredJobs.length > 0) {
            const highPolyJobs = filteredJobs.filter(isHighPolyJob);
            if (highPolyJobs.length > 0) {
                highPolyJobs.forEach(j => sheetsLogger.enqueue(j, 'ignored_high_poly'));
            }
            filteredJobs = filteredJobs.filter(j => !isHighPolyJob(j));
        }

        if (effectiveCheckOnly) {
            // In check-only, we do not attempt accepts, but we still log + alert.
            if (isDispatching) {
            (filteredJobs || []).forEach(j => sheetsLogger.enqueue(j, 'check_only'));

                fireAndForgetSpotterAlert({
                    telegramMsg: `🛡️ Check Only Mode active. Logged ${filteredJobs.length} jobs (dispatch in progress).`,
                    ntfyMsg: `Check-only: logged ${filteredJobs.length} jobs during dispatch`,
                    cooldownMs: DISPATCH_QUEUE_ALERT_COOLDOWN_MS,
                    getLastAt: () => lastQueuedAlertAt,
                    setLastAt: v => { lastQueuedAlertAt = v; }
                });

                return;
            }

            isDispatching = true;
            console.log(`\n🛡️ [EVENT TRIGGER] Check Only Mode. Logging ${filteredJobs.length} jobs (no accepts).`);

            (filteredJobs || []).forEach(j => sheetsLogger.enqueue(j, 'check_only'));

            await sendDualAlert(`🚨 [Event] Jobs Detected (Check Only)`, `Tasks available! (Auto-Accept Disabled)`);

            isDispatching = false;
            drainPendingJobsSoon();
            return;
        }

        // If we filtered out everything (e.g. lowpoly-only and all were high-poly), we're done.
        if (!filteredJobs || filteredJobs.length === 0) {
            return;
        }

        if (isDispatching) {
            // Do not drop detections during an active dispatch.
            enqueuePendingJobs(filteredJobs);

            // Policy: Only log Detected (Queued) the FIRST time we ever see this job ID in this run.
            // This prevents the Jobs view from regressing a later status back to Detected (Queued).
            (filteredJobs || []).forEach(j => {
                const id = j?.id;
                if (id === undefined || id === null) return;
                const key = String(id);
                if (seenJobIdsThisRun.has(key)) return;
                seenJobIdsThisRun.add(key);
                sheetsLogger.enqueue(j, 'detected_queued');
            });

            fireAndForgetSpotterAlert({
                telegramMsg: `📥 Jobs detected while swarm is dispatching. Queued ${filteredJobs.length} jobs for next pass.`,
                ntfyMsg: `Queued ${filteredJobs.length} jobs during dispatch`,
                cooldownMs: DISPATCH_QUEUE_ALERT_COOLDOWN_MS,
                getLastAt: () => lastQueuedAlertAt,
                setLastAt: v => { lastQueuedAlertAt = v; }
            });

            return; // Let current dispatch finish; queued jobs will drain after.
        }

        // Mark these job IDs as seen for this run (so later dispatch-time detections won't re-log detected_queued).
        (filteredJobs || []).forEach(j => {
            const id = j?.id;
            if (id === undefined || id === null) return;
            seenJobIdsThisRun.add(String(id));
        });
        isDispatching = true;
        console.log(`\n🚀 [EVENT TRIGGER] Dispatching ${filteredJobs.length} jobs to swarm IMMEDIATELY...`);

        // A. Filter & Dispatch (using Cache)
        const singleJobs = filteredJobs
            .filter(j => !j.isGrouped && Number(j.price) >= CONFIG.minPriceSingle)
            .sort((a, b) => b.price - a.price);
        const groupedJobs = filteredJobs
            .filter(j => j.isGrouped && Number(j.pricePerUnit) >= CONFIG.minPriceVariation)
            .sort((a, b) => b.price - a.price);
        const jobsToAssign = [...singleJobs, ...groupedJobs];

        // Important: when we have a mixed batch (some jobs pass price filters, some do not),
        // we must still log the price-rejected jobs. Otherwise it looks like we "missed" them.
        const eligibleIds = new Set(jobsToAssign.map(j => String(j.id)));
        const priceRejected = (filteredJobs || []).filter(j => !eligibleIds.has(String(j.id)));
        if (priceRejected.length > 0) {
            priceRejected.forEach(j => sheetsLogger.enqueue(j, 'ignored_low_price'));
        }

        if (jobsToAssign.length === 0) {
            console.log('[Event] No jobs matched price criteria.');

            // Log all detected jobs as ignored (too cheap) without slowing down.
            filteredJobs.forEach(j => sheetsLogger.enqueue(j, 'ignored_low_price'));

            // CHEAP JOB WARNING
            // If we have valid jobs but filtered them all out, warn the user
            if (filteredJobs.length > 0) {
                console.log('⚠️ [Event] Jobs ignored due to low price. Sending warning...');
                // Fire and forget (text only)
                const ignoredPrices = filteredJobs.map(j => `$${j.price}`).join(', ');
                sendDualAlert(`⚠️ Jobs Ignored (Too Cheap): ${ignoredPrices}`, `Jobs Ignored: ${ignoredPrices}`)
                    .catch(e => console.error('Cheap Job Alert Failed:', e.message));
            }

            isDispatching = false;
            drainPendingJobsSoon();
            return;
        }

        const agentQueues = {};
        agents.forEach(a => agentQueues[a.id] = []);
        const currentCapacities = JSON.parse(JSON.stringify(expectedCapacityCache));

        const assignedJobIds = new Set();

        for (const job of jobsToAssign) {
            const requiredType = job.isGrouped ? 'grouped' : 'single';
            // Explicitly iterate agents in order (1, 2, 3...) to ensure Greedy Assignment
            // Agent 1 gets first dibs on the highest price job, then the next, until full.
            const bestAgent = agents.find(a => currentCapacities[a.id][requiredType].available > 0);

            if (bestAgent) {
                agentQueues[bestAgent.id].push(job);
                currentCapacities[bestAgent.id][requiredType].available--;
                assignedJobIds.add(String(job.id));
            }
        }

        // Anything that passes price filters but couldn't be assigned due to capacity
        // should still be logged to Sheets (otherwise it looks like we "missed" jobs).
        const unassigned = jobsToAssign.filter(j => !assignedJobIds.has(String(j.id)));
        if (unassigned.length > 0) {
            unassigned.forEach(j => sheetsLogger.enqueue(j, 'ignored_capacity'));
        }

        const totalJobs = Object.values(agentQueues).flat().length;
        if (totalJobs > 0) {
            // --- THE ATTACK ---
            if (NUCLEAR_ACCEPT_ENABLED) {
                // Nuclear mode: serialize accepts globally (highest price first), spaced by a small delay.
                // This avoids blasting many POSTs at once.
                const jobToAgent = new Map();
                for (const agent of agents) {
                    const q = agentQueues[agent.id] || [];
                    for (const j of q) jobToAgent.set(String(j.id), agent);
                }

                const orderedPlan = jobsToAssign
                    .map(j => ({ job: j, agent: jobToAgent.get(String(j.id)) }))
                    .filter(x => x.agent);

                console.log(`⚡ Nuclear mode: processing ${orderedPlan.length} jobs asynchronously (no spacing).`);

                // Pipeline nuclear accepts:
                // - Dispatch accept POSTs spaced by getNuclearDelayMs()
                // - Do NOT wait for confirmation before dispatching the next job
                // - Await all results at the end to log Sheets + adjust expected capacity
                const inFlight = [];

                for (const step of orderedPlan) {
                    const agent = step.agent;
                    const job = step.job;

                    // Dedupe: don't re-attempt the same job ID if it's rediscovered.
                    const jobKey = String(job?.id ?? '');
                    if (jobKey && nuclearAttemptedJobIds.has(jobKey)) {
                        console.log(`[Account ${agent.id}] Nuclear dedupe: already attempted job ${jobKey}, skipping.`);
                        continue;
                    }
                    if (jobKey) nuclearAttemptedJobIds.add(jobKey);

                    // If the agent became full since planning (rare), skip.
                    const requiredType = job.isGrouped ? 'grouped' : 'single';
                    if ((expectedCapacityCache[agent.id]?.[requiredType]?.available ?? 0) <= 0) {
                        sheetsLogger.enqueue(job, 'ignored_capacity');
                        continue;
                    }

                    // Reserve capacity now so we don't over-dispatch while requests are in-flight.
                    applyExpectedCapacityDelta(agent.id, requiredType, 1);

                    // Fire accept attempt now; confirmation can complete while we dispatch the next jobs.
                    inFlight.push(
                        (async () => {
                            const res = await processJob(agent, job);
                            return { agent, job, requiredType, res };
                        })()
                    );
                }

                const done = await Promise.all(inFlight);
                for (const item of done) {
                    const { agent, job, requiredType, res } = item;
                    if (res && res.ok) {
                        sheetsLogger.enqueue(job, 'taken');
                    } else {
                        // Roll back the reserved slot if we didn't actually take it.
                        applyExpectedCapacityDelta(agent.id, requiredType, -1);
                        sheetsLogger.enqueue(job, 'failed');
                    }
                }
            } else {
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
                                if (res && res.ok) {
                                    sheetsLogger.enqueue(job, 'taken');
                                    const requiredType = job.isGrouped ? 'grouped' : 'single';
                                    applyExpectedCapacityDelta(agent.id, requiredType, 1);
                                }
                                else if (res && res.reason === 'too_late') sheetsLogger.enqueue(job, 'failed');
                                else sheetsLogger.enqueue(job, 'failed');
                            });
                        }
                    }
                }));
            }

            // --- POST-PROCESSING ---
            try {
                console.log('🔄 Swarm done. Ensuring Spotter (Agent 1) is still active...');
                if (!Agent1.page.url().includes(CONFIG.url)) {
                    console.log('⚠️ [Agent 1] Spotter drifted! Returning to post...');
                    await Agent1.page.goto(CONFIG.url, { waitUntil: 'networkidle' });
                }

                // Text-only completion alert.
                sendDualAlert(`🎯 Swarm Complete!`, `Processing complete.`).catch(e => console.error('BG Alert Error:', e.message));

                const deferCapacityScan = Boolean(NUCLEAR_ACCEPT_ENABLED && burstActive);
                if (deferCapacityScan) {
                    nuclearBurstSeenSinceLastReconcile = true;
                    console.log('⏸️ Deferring capacity re-check (burst + nuclear). Will reconcile after burst ends.');
                } else {
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
                        expectedCapacityCache[agent.id] = applyGlobalTakeCaps(cap);
                        const eff = expectedCapacityCache[agent.id];
                        console.log(`[Account ${agent.id}] Capacity updated: Single ${eff.single.available}/${cap.single.available} | Grouped ${eff.grouped.available}/${cap.grouped.available}`);
                    }));
                }
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

    // Send a lightweight text alert when jobs are discovered (no screenshots).
    const DISCOVERY_ALERT_COOLDOWN_MS = Math.max(0, parseInt(process.env.DISCOVERY_ALERT_COOLDOWN_MS || '15000', 10) || 15000);
    let lastDiscoveryAlertAt = 0;
    function maybeAlertJobsDiscovered({ spotterId, jobs }) {
        const now = Date.now();
        if (DISCOVERY_ALERT_COOLDOWN_MS > 0 && now - lastDiscoveryAlertAt < DISCOVERY_ALERT_COOLDOWN_MS) return;
        lastDiscoveryAlertAt = now;

        const count = (jobs || []).length;
        if (count <= 0) return;
        const prices = jobs
            .slice(0, 10)
            .map(j => `$${j?.price}`)
            .join(', ');
        const msg = `🎯 Jobs detected (${count}) by Account ${spotterId}${prices ? `\nPrices: ${prices}` : ''}`;
        sendDualAlert(msg, msg).catch(() => {});
    }

    function parseJobsFromAvailableRequests({ json, spotterAgent }) {
        const rawJobs = json?.data || [];
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
            const uid = attr.uid ?? '';
            const nextRoundDeadline = attr.nextRoundDeadline ?? '';

            // Unmasked pricing in logs for verification
            const rawPriceLog = String(price).split('').join(' ');
            console.log(`[Sniper A${spotterAgent.id}] Detected Job ${item.id} | Price: [ ${rawPriceLog} ]`);

            const variations = isGrouped ? (attr.groupData?.size || 1) : 1;
            return {
                id: item.id,
                url: jobUrl,
                uid,
                nextRoundDeadline,
                roundDeadline: nextRoundDeadline,
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

        return parsed;
    }

    async function waitForAvailableRequestsUrl(agent, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < Math.max(0, timeoutMs || 0)) {
            const u = availableRequestsUrlByAgentId[agent.id];
            if (u) return u;
            try { await agent.page.waitForTimeout(100); } catch (_) { /* ignore */ }
        }
        return availableRequestsUrlByAgentId[agent.id] || '';
    }

    async function pollAvailableRequests(agent) {
        // Try to use a cached URL (captured from the real page traffic).
        let apiUrl = availableRequestsUrlByAgentId[agent.id];
        if (!apiUrl) {
            // Best effort: wait briefly for the initial page load to fire the API call.
            apiUrl = await waitForAvailableRequestsUrl(agent, 4000);
        }
        if (!apiUrl) {
            // If this agent hasn't seen the URL yet, fall back to any cached URL (endpoints are typically identical).
            apiUrl = Object.values(availableRequestsUrlByAgentId).find(Boolean) || '';
        }
        if (!apiUrl) {
            console.log(`[Sniper A${agent.id}] No available-requests URL cached yet; skipping poll.`);
            return [];
        }

        try {
            const resp = await agent.context.request.get(apiUrl, {
                headers: {
                    'accept': 'application/json, text/plain, */*'
                }
            });
            if (resp.status() !== 200) {
                if (resp.status() === 403 || resp.status() === 429) {
                    console.error(`\n🚨 [Sniper Alert] POTENTIAL SOFT BAN detected (HTTP ${resp.status()}) on Account ${agent.id}.`);
                    console.error('The server is blocking our check requests. Recommend stopping or increasing wait time.\n');
                }
                return [];
            }

            const json = await resp.json();
            const parsed = parseJobsFromAvailableRequests({ json, spotterAgent: agent });
            if (parsed.length > 0) {
                console.log(`[Sniper A${agent.id}] 🎯 Captured ${parsed.length} jobs via API (direct poll).`);
            }
            return parsed;
        } catch (e) {
            console.error(`[Sniper A${agent.id}] Direct poll failed: ${e.message}`);
            return [];
        }
    }

    // --- DIRECT API POLLING ---
    // We now poll the available-requests endpoint directly to reduce latency variance.
    // We still seed the exact URL from the real page responses, but do not rely on page reloads.

    try {
        while (keepRunning) {
            const cycleStart = Date.now();
            iterations++;

            // Burst mode auto-exit check (based on how long since we last saw any jobs).
            maybeExitBurstMode();

            // If we deferred capacity scans during burst+nuclear, reconcile once after burst ends.
            if (!burstActive && capacityReconcileRequested && !isDispatching) {
                await reconcileCapacitiesAfterBurst({ reason: 'burst_end' });
            }

            if (IS_CI) {
                const timeRemaining = Math.round((LOOP_DURATION - (Date.now() - startTime)) / 1000);
                console.log(`\n🔄 Iteration #${iterations} (Time remaining: ${timeRemaining}s)`);
            }

            try {
                // Dual-spotter check cadence: split CHECK_INTERVAL across Account 1 + Account 2.
                // This yields: A1 check, wait half-interval, A2 check, wait half-interval, repeat.
                const spotters = (!CONFIG.checkOnly && Agent2) ? [Agent1, Agent2] : [Agent1];
                const baseCycleMs = burstActive ? BURST_REFRESH_MS : MIN_CYCLE_DURATION;
                const subCycleMs = burstActive
                    ? BURST_REFRESH_MS
                    : Math.max(500, Math.floor(baseCycleMs / spotters.length));

                let activeSpotter;
                // Spec: in burst mode, alternate spotters each 1s tick (A1, A2, A1, A2...)
                activeSpotter = spotters[(iterations - 1) % spotters.length];

                // 1) Poll the API directly (fast). No page reload.
                const parsed = await pollAvailableRequests(activeSpotter);
                lastSniperJobs = parsed;

                if (parsed.length > 0) {
                    // Enter/extend burst mode whenever we see jobs.
                    enterBurstMode(`jobs_detected_by_A${activeSpotter.id}`);

                    // Alert user (text only) that jobs were discovered.
                    maybeAlertJobsDiscovered({ spotterId: activeSpotter.id, jobs: parsed });
                }

                // Flood guard: if too many jobs appear at once, switch to check-only for the rest of this run.
                if (!forcedCheckOnly && MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY > 0 && parsed.length > MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY) {
                    forcedCheckOnly = true;
                    pendingJobsById.clear();
                    console.error(`\n🚨 [Flood Guard] Detected ${parsed.length} jobs in a single check (> ${MAX_JOBS_PER_CHECK_BEFORE_CHECK_ONLY}). Switching to CHECK ONLY for the rest of the run.`);

                    // Text-only alert
                    sendDualAlert(
                        `🚨 Flood Guard: ${parsed.length} jobs detected at once. Switching to CHECK ONLY (no auto-accept) for the rest of the run.`,
                        `Flood Guard: ${parsed.length} jobs → check-only for rest of run`
                    ).catch(() => {});
                }

                // Always allow re-triggering accepts; Sheets logging has its own dedupe.
                if (parsed.length > 0) {
                    triggerSwarm(parsed).catch(err => console.error('Swarm Trigger Error:', err.message));
                }

                // Maintain timing.
                const elapsed = Date.now() - cycleStart;
                const waitTime = Math.max(0, subCycleMs - elapsed);
                await activeSpotter.page.waitForTimeout(waitTime);

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
        try {
            // Best-effort: don't drop in-flight accepts or queued Sheet rows on shutdown.
            await waitForSwarmToSettle(60000);
            await sheetsLogger.flushNow();
        } catch (_) {
            // ignore
        }

        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed.');
    }
}

run();
