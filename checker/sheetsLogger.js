const fs = require('fs');
const path = require('path');

let google;

function parseServiceAccountFromEnv() {
    const jsonBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    const jsonInline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;

    if (jsonBase64) {
        const raw = Buffer.from(jsonBase64, 'base64').toString('utf8');
        return JSON.parse(raw);
    }

    if (jsonInline) {
        return JSON.parse(jsonInline);
    }

    if (jsonPath) {
        const absolute = path.isAbsolute(jsonPath) ? jsonPath : path.join(process.cwd(), jsonPath);
        const raw = fs.readFileSync(absolute, 'utf8');
        return JSON.parse(raw);
    }

    return null;
}

function safeString(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
}

function statusToText(status) {
    switch (status) {
        case 'detected_queued':
            return 'Detected (Queued)';
        case 'taken':
            return 'Job taken';
        case 'failed':
            return 'Failed to take job';
        case 'check_only':
            return 'Check Only Mode';
        case 'ignored_capacity':
            return 'Ignored: Capacity Full';
        case 'ignored_low_price':
            return 'Ignored: Low Price';
        case 'ignored':
        default:
            return 'Job ignored';
    }
}

function buildStatusConditionalFormattingRequests(sheetId) {
    // Status is column A (index 0). Apply formatting from row 2 downward.
    const statusRange = { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };

    return [
        // Purple = detected (queued)
        {
            addConditionalFormatRule: {
                index: 0,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Detected (Queued)' }] },
                        format: {
                            backgroundColor: { red: 0.9, green: 0.85, blue: 1.0 },
                            textFormat: { foregroundColor: { red: 0.25, green: 0.1, blue: 0.45 } }
                        }
                    }
                }
            }
        },
        // Green = taken
        {
            addConditionalFormatRule: {
                index: 1,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Job taken' }] },
                        format: {
                            backgroundColor: { red: 0.75, green: 0.95, blue: 0.75 },
                            textFormat: { foregroundColor: { red: 0, green: 0.4, blue: 0 } }
                        }
                    }
                }
            }
        },
        // Red = failed
        {
            addConditionalFormatRule: {
                index: 2,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Failed to take job' }] },
                        format: {
                            backgroundColor: { red: 0.98, green: 0.8, blue: 0.8 },
                            textFormat: { foregroundColor: { red: 0.6, green: 0, blue: 0 } }
                        }
                    }
                }
            }
        },
        // Yellow = capacity full
        {
            addConditionalFormatRule: {
                index: 3,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Ignored: Capacity Full' }] },
                        format: {
                            backgroundColor: { red: 1.0, green: 0.95, blue: 0.6 },
                            textFormat: { foregroundColor: { red: 0.1, green: 0.1, blue: 0.1 } }
                        }
                    }
                }
            }
        },
        // Black/gray = low price
        {
            addConditionalFormatRule: {
                index: 4,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Ignored: Low Price' }] },
                        format: {
                            backgroundColor: { red: 0.92, green: 0.92, blue: 0.92 },
                            textFormat: { foregroundColor: { red: 0.05, green: 0.05, blue: 0.05 } }
                        }
                    }
                }
            }
        },
        // Blue = check-only
        {
            addConditionalFormatRule: {
                index: 5,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Check Only Mode' }] },
                        format: {
                            backgroundColor: { red: 0.8, green: 0.9, blue: 1.0 },
                            textFormat: { foregroundColor: { red: 0.05, green: 0.2, blue: 0.55 } }
                        }
                    }
                }
            }
        },
        // Legacy alias (kept for older rows)
        {
            addConditionalFormatRule: {
                index: 6,
                rule: {
                    ranges: [statusRange],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Job ignored' }] },
                        format: {
                            backgroundColor: { red: 0.92, green: 0.92, blue: 0.92 },
                            textFormat: { foregroundColor: { red: 0.05, green: 0.05, blue: 0.05 } }
                        }
                    }
                }
            }
        }
    ];
}

function buildStatusDropdownValidationRule() {
    const allowed = [
        'Detected (Queued)',
        'Job taken',
        'Failed to take job',
        'Check Only Mode',
        'Ignored: Capacity Full',
        'Ignored: Low Price',
        'Job ignored'
    ];

    return {
        condition: {
            type: 'ONE_OF_LIST',
            values: allowed.map(v => ({ userEnteredValue: v }))
        },
        showCustomUi: true,
        strict: true
    };
}

function buildDetectedAtDateTimeFormat() {
    return {
        numberFormat: {
            type: 'DATE_TIME',
            pattern: 'yyyy-mm-dd hh:mm:ss'
        }
    };
}

function isEnabled() {
    return Boolean(process.env.GOOGLE_SHEETS_ID);
}

function createSheetsLogger() {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const viewTitle = process.env.GOOGLE_SHEETS_TAB || 'Jobs';
    let rawTitle = process.env.GOOGLE_SHEETS_RAW_TAB || 'Original';
    const legacyRawTitle = 'Not Important';

    const statusFilteredViewTabs = [
        { title: 'Accepted', statusText: 'Job taken' },
        { title: 'Failed', statusText: 'Failed to take job' },
        { title: 'Ignored: Low Price', statusText: 'Ignored: Low Price' },
        { title: 'Ignored: Capacity Full', statusText: 'Ignored: Capacity Full' },
        { title: 'Check Only', statusText: 'Check Only Mode' }
    ];

    const queue = [];
    const recentlyEnqueuedKeys = new Map();
    const dedupeWindowMs = (() => {
        // Back-compat: JOBS_DEDUPE_WINDOW_MS used to exist; prefer SHEETS_DEDUPE_WINDOW_MS.
        const v = process.env.SHEETS_DEDUPE_WINDOW_MS ?? process.env.JOBS_DEDUPE_WINDOW_MS;
        // Default to 6 hours so the same job/status won't spam rows within a single CI run.
        const DEFAULT_MS = 6 * 60 * 60 * 1000;
        const n = parseInt(v || String(DEFAULT_MS), 10);
        return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_MS;
    })();
    let sheetsClient = null;
    let rawSheetId = null;
    let viewSheetId = null;
    let isReady = false;
    let isFlushing = false;

    function quoteSheetName(name) {
        // Google Sheets uses single quotes for sheet names with spaces.
        const safe = String(name).replace(/'/g, "''");
        return `'${safe}'`;
    }

    function buildHeaderIndexMap(headerRow) {
        const map = new Map();
        (headerRow || []).forEach((v, idx) => {
            const key = safeString(v).trim().toLowerCase();
            if (!key) return;
            if (!map.has(key)) map.set(key, idx);
        });
        return map;
    }

    function normalizeRowToStandardOrder(row, headerIndex, standardHeaders) {
        const out = new Array(standardHeaders.length).fill('');
        for (let i = 0; i < standardHeaders.length; i++) {
            const key = safeString(standardHeaders[i]).trim().toLowerCase();
            let idx = headerIndex.get(key);
            if (idx === undefined && key === 'final price (raw)') {
                idx = headerIndex.get('final price');
            }
            // Never migrate into the calculated Final price field.
            if (key === 'final price') idx = undefined;
            if (typeof idx === 'number' && idx >= 0 && idx < (row || []).length) {
                out[i] = row[idx];
            }
        }
        return out;
    }

    function enqueue(job, status) {
        if (!isEnabled()) return;

        if (dedupeWindowMs > 0) {
            const key = `${safeString(job?.id)}:${safeString(status)}`;
            const now = Date.now();
            const last = recentlyEnqueuedKeys.get(key);
            if (typeof last === 'number' && now - last < dedupeWindowMs) return;
            recentlyEnqueuedKeys.set(key, now);

            // Light pruning to prevent unbounded growth in long runs.
            // Keep this O(n) sweep very infrequent.
            if (recentlyEnqueuedKeys.size > 5000) {
                for (const [k, t] of recentlyEnqueuedKeys.entries()) {
                    if (typeof t === 'number' && now - t >= dedupeWindowMs) {
                        recentlyEnqueuedKeys.delete(k);
                    }
                }
            }
        }

        const variations = Number(job.variations || 1) || 1;
        const finalPrice = Number(job.finalPrice ?? job.price ?? 0) || 0;
        const pricePerVariation = variations > 0 ? (finalPrice / variations) : finalPrice;
        const detectedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

        queue.push({
            values: [
                statusToText(status),
                detectedAt,
                '=ROW()-1',
                safeString(job.title),
                safeString(job.id),
                safeString(job.uid ?? ''),
                safeString(job.originalPrice ?? ''),
                '',
                safeString(job.multiplier ?? ''),
                safeString(job.complexity ?? ''),
                job.isGrouped ? 'Grouped' : 'Solo',
                safeString(variations),
                safeString(pricePerVariation),
                safeString(job.groupType ?? ''),
                safeString(job.tags ?? ''),
                safeString(finalPrice)
            ],
            status
        });
    }

    async function lazyInit() {
        if (!isEnabled() || isReady) return;

        const credentials = parseServiceAccountFromEnv();
        if (!credentials) {
            console.error('[Sheets] GOOGLE_SHEETS_ID set but no service account JSON provided. Set GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 (preferred) or GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_PATH.');
            return;
        }

        try {
            // Lazy-load dependency so the checker can still run without it if sheets disabled.
            // eslint-disable-next-line global-require
            google = google || require('googleapis').google;

            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });

            sheetsClient = google.sheets({ version: 'v4', auth });

            // Ensure tab exists, headers exist, and conditional formatting is set once.
            const meta = await sheetsClient.spreadsheets.get({
                spreadsheetId,
                fields: 'sheets(properties(sheetId,title),conditionalFormats)'
            });

            const sheets = meta.data.sheets || [];
            const sheetIdByTitle = new Map();
            for (const s of sheets) {
                const title = s?.properties?.title;
                const sid = s?.properties?.sheetId;
                if (title && sid !== undefined && sid !== null) sheetIdByTitle.set(title, sid);
            }

            // Rename legacy raw sheet "Not Important" -> "Original" (only when not explicitly overridden).
            if (!process.env.GOOGLE_SHEETS_RAW_TAB && rawTitle === 'Original') {
                const legacyId = sheetIdByTitle.get(legacyRawTitle);
                const alreadyId = sheetIdByTitle.get(rawTitle);
                if (legacyId && !alreadyId) {
                    try {
                        await sheetsClient.spreadsheets.batchUpdate({
                            spreadsheetId,
                            requestBody: {
                                requests: [
                                    {
                                        updateSheetProperties: {
                                            properties: {
                                                sheetId: legacyId,
                                                title: rawTitle
                                            },
                                            fields: 'title'
                                        }
                                    }
                                ]
                            }
                        });
                        sheetIdByTitle.delete(legacyRawTitle);
                        sheetIdByTitle.set(rawTitle, legacyId);
                        console.log(`[Sheets] Renamed raw tab "${legacyRawTitle}" → "${rawTitle}".`);
                    } catch (e) {
                        console.error(`[Sheets] Raw tab rename failed: ${e.message}`);
                    }
                }
            }

            const requiredTitles = [rawTitle, viewTitle, ...statusFilteredViewTabs.map(t => t.title)];
            const missingTitles = requiredTitles.filter(t => !sheetIdByTitle.has(t));

            if (missingTitles.length > 0) {
                const requests = missingTitles.map(title => ({ addSheet: { properties: { title } } }));
                const addRes = await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: { requests }
                });

                const replies = addRes.data.replies || [];
                for (let i = 0; i < missingTitles.length; i++) {
                    const title = missingTitles[i];
                    const sheetId = replies[i]?.addSheet?.properties?.sheetId ?? null;
                    if (sheetId !== null) sheetIdByTitle.set(title, sheetId);
                }
            }

            rawSheetId = sheetIdByTitle.get(rawTitle) ?? null;
            viewSheetId = sheetIdByTitle.get(viewTitle) ?? null;
            const statusFilteredTabsWithIds = statusFilteredViewTabs.map(t => ({
                ...t,
                sheetId: sheetIdByTitle.get(t.title) ?? null
            }));

            // Color-code tabs for fast scanning.
            // (We do this in one batchUpdate to reduce API calls.)
            try {
                const tabColorRequests = [];

                // Raw tab: very dark red (distinct from Failed).
                if (!process.env.GOOGLE_SHEETS_RAW_TAB && rawTitle === 'Original') {
                    tabColorRequests.push({
                        updateSheetProperties: {
                            properties: {
                                sheetId: Number(rawSheetId),
                                tabColor: { red: 0.35, green: 0.0, blue: 0.0 }
                            },
                            fields: 'tabColor'
                        }
                    });
                }

                const colorByTitle = new Map([
                    ['Accepted', { red: 0.2, green: 0.75, blue: 0.2 }],
                    // Hot saturated red for Failed
                    ['Failed', { red: 1.0, green: 0.05, blue: 0.05 }],
                    ['Ignored: Capacity Full', { red: 1.0, green: 0.85, blue: 0.15 }],
                    ['Ignored: Low Price', { red: 0.45, green: 0.45, blue: 0.45 }],
                    ['Check Only', { red: 0.2, green: 0.45, blue: 1.0 }]
                ]);

                for (const t of statusFilteredTabsWithIds) {
                    const rgb = colorByTitle.get(t.title);
                    if (!rgb) continue;
                    const sid = Number(t.sheetId);
                    if (!Number.isFinite(sid)) continue;
                    tabColorRequests.push({
                        updateSheetProperties: {
                            properties: {
                                sheetId: sid,
                                tabColor: rgb
                            },
                            fields: 'tabColor'
                        }
                    });
                }

                if (tabColorRequests.length > 0) {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: { requests: tabColorRequests }
                    });
                }
            } catch (e) {
                console.error(`[Sheets] Tab color update failed: ${e.message}`);
            }

            const headerValues = [[
                'Status',
                'Detected at',
                '#',
                'Job title',
                'Job ID',
                'UID',
                'Original price',
                'Final price',
                'Multiplier',
                'Complexity',
                'Job type',
                'Variations',
                'Price per variation',
                'Group type',
                'Tags',
                'Final price (raw)'
            ]];

            // --- ONE-TIME MIGRATION (legacy Jobs -> raw tab) ---
            // If the raw tab is empty, copy any existing rows from the Jobs tab into it once.
            // We mark completion in raw!Z1 so this won't repeat on GitHub Actions restarts.
            try {
                const [markerRes, rawPeekRes] = await Promise.all([
                    sheetsClient.spreadsheets.values.get({
                        spreadsheetId,
                        range: `${rawTitle}!Z1:Z1`
                    }).catch(() => null),
                    sheetsClient.spreadsheets.values.get({
                        spreadsheetId,
                        range: `${rawTitle}!A1:P3`
                    }).catch(() => null)
                ]);

                const markerVal = markerRes?.data?.values?.[0]?.[0];
                const isMigrationDone = safeString(markerVal).trim() === 'migrated_from_jobs_v1';

                const rawPeek = rawPeekRes?.data?.values || [];
                // Consider raw non-empty if there is any non-header row with a Job ID value.
                const rawHasData = rawPeek.length >= 2 && rawPeek.slice(1).some(r => safeString(r?.[4]).trim() !== '');

                if (!isMigrationDone && !rawHasData) {
                    const jobsRes = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId,
                        range: `${viewTitle}!A1:Z`
                    }).catch(() => null);

                    const jobsValues = jobsRes?.data?.values || [];
                    const jobsHeader = jobsValues[0] || [];
                    const jobsRows = jobsValues.slice(1);

                    // Only attempt migration if there are any rows with a Job ID value.
                    if (jobsRows.length > 0) {
                        const headerIndex = buildHeaderIndexMap(jobsHeader);
                        const jobIdIdx = headerIndex.get('job id');
                        const hasAnyJobIds = typeof jobIdIdx === 'number' && jobsRows.some(r => safeString(r?.[jobIdIdx]).trim() !== '');

                        if (hasAnyJobIds) {
                            // Ensure raw headers exist before appending.
                            await sheetsClient.spreadsheets.values.update({
                                spreadsheetId,
                                range: `${rawTitle}!A1:P1`,
                                valueInputOption: 'RAW',
                                requestBody: { values: headerValues }
                            });

                            const standardHeaders = headerValues[0];
                            const normalized = jobsRows
                                .filter(r => typeof jobIdIdx === 'number' && safeString(r?.[jobIdIdx]).trim() !== '')
                                .map(r => normalizeRowToStandardOrder(r, headerIndex, standardHeaders));

                            if (normalized.length > 0) {
                                await sheetsClient.spreadsheets.values.append({
                                    spreadsheetId,
                                    range: `${rawTitle}!A:P`,
                                    valueInputOption: 'USER_ENTERED',
                                    insertDataOption: 'INSERT_ROWS',
                                    requestBody: { values: normalized }
                                });

                                // Mark migration done.
                                await sheetsClient.spreadsheets.values.update({
                                    spreadsheetId,
                                    range: `${rawTitle}!Z1:Z1`,
                                    valueInputOption: 'RAW',
                                    requestBody: { values: [['migrated_from_jobs_v1']] }
                                });
                                console.log(`[Sheets] Migrated ${normalized.length} legacy rows from ${viewTitle} -> ${rawTitle}.`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Sheets] Legacy migration check failed: ${e.message}`);
            }

            // One-time migration:
            // - Preserve legacy numeric Final price values into "Final price (raw)" (column P)
            // - Make "Final price" (column H) a calculated field: Original price (G) * Multiplier (I), rounded UP to 2 decimals
            // Marker stored in raw!Z2
            try {
                const markerRes = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId,
                    range: `${rawTitle}!Z2:Z2`
                }).catch(() => null);
                const markerVal = markerRes?.data?.values?.[0]?.[0];
                const isDone = safeString(markerVal).trim() === 'final_price_calc_v1';

                if (!isDone) {
                    // Best-effort: copy existing H values to P as RAW values (bounded).
                    const oldFinalRes = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId,
                        range: `${rawTitle}!H2:H10000`
                    }).catch(() => null);
                    const oldFinalVals = oldFinalRes?.data?.values || [];
                    if (oldFinalVals.length > 0) {
                        await sheetsClient.spreadsheets.values.update({
                            spreadsheetId,
                            range: `${rawTitle}!P2:P${oldFinalVals.length + 1}`,
                            valueInputOption: 'RAW',
                            requestBody: { values: oldFinalVals }
                        });
                    }

                    // Clear H so the calculated ARRAYFORMULA can spill.
                    await sheetsClient.spreadsheets.values.clear({
                        spreadsheetId,
                        range: `${rawTitle}!H2:H10000`
                    }).catch(() => null);

                    // Calculated Final price formula:
                    // - Blank when Job ID is blank
                    // - ROUNDUP to 2 decimals
                    const calcFormula = '=ARRAYFORMULA(IF(LEN(E2:E)=0, "", IFERROR(ROUNDUP(VALUE(G2:G)*VALUE(I2:I), 2), "")))';
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${rawTitle}!H2:H2`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [[calcFormula]] }
                    });

                    // Ensure headers match the new schema width.
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${rawTitle}!A1:P1`,
                        valueInputOption: 'RAW',
                        requestBody: { values: headerValues }
                    }).catch(() => null);

                    // Mark migration done.
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${rawTitle}!Z2:Z2`,
                        valueInputOption: 'RAW',
                        requestBody: { values: [['final_price_calc_v1']] }
                    });

                    console.log('[Sheets] Migrated Final price to calculated field + preserved Final price (raw).');
                }
            } catch (e) {
                console.error(`[Sheets] Final price migration failed: ${e.message}`);
            }

            // If this sheet already has headers with Status in a different column,
            // migrate by moving that column to the front (column A).
            // This keeps existing rows aligned without rewriting cell values.
            const headerScanRes = await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: `${rawTitle}!A1:Z1`
            }).catch(() => null);

            const headerScanRow = headerScanRes?.data?.values?.[0] || [];
            const statusIndex = headerScanRow.findIndex(v => safeString(v).trim() === 'Status');
            if (statusIndex > 0) {
                try {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            requests: [
                                {
                                    moveDimension: {
                                        source: {
                                            sheetId: rawSheetId,
                                            dimension: 'COLUMNS',
                                            startIndex: statusIndex,
                                            endIndex: statusIndex + 1
                                        },
                                        destinationIndex: 0
                                    }
                                }
                            ]
                        }
                    });
                    console.log(`[Sheets] Migrated Status column from index ${statusIndex} to column A.`);
                } catch (e) {
                    console.error(`[Sheets] Status column migration failed: ${e.message}`);
                }
            }

            // Ensure we have a Detected at column right after Status.
            // If missing, insert it at index 1 (column B) and set the header.
            const headerScanRes2 = await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: `${rawTitle}!A1:Z1`
            }).catch(() => null);
            const headerScanRow2 = headerScanRes2?.data?.values?.[0] || [];
            const detectedAtIndex = headerScanRow2.findIndex(v => safeString(v).trim() === 'Detected at');
            if (detectedAtIndex === -1) {
                try {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            requests: [
                                {
                                    insertDimension: {
                                        range: {
                                            sheetId: rawSheetId,
                                            dimension: 'COLUMNS',
                                            startIndex: 1,
                                            endIndex: 2
                                        },
                                        inheritFromBefore: false
                                    }
                                }
                            ]
                        }
                    });

                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${rawTitle}!B1:B1`,
                        valueInputOption: 'RAW',
                        requestBody: { values: [['Detected at']] }
                    });

                    console.log('[Sheets] Added "Detected at" column at B.');
                } catch (e) {
                    console.error(`[Sheets] Detected-at column migration failed: ${e.message}`);
                }
            }

            // Ensure we have a UID column right after Job ID.
            // If missing, insert it at index 5 (column F) and set the header.
            // This keeps Job ID in column E for compatibility.
            const headerScanRes3 = await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: `${rawTitle}!A1:Z1`
            }).catch(() => null);
            const headerScanRow3 = headerScanRes3?.data?.values?.[0] || [];
            const uidIndex = headerScanRow3.findIndex(v => safeString(v).trim() === 'UID');
            if (uidIndex === -1) {
                try {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            requests: [
                                {
                                    insertDimension: {
                                        range: {
                                            sheetId: rawSheetId,
                                            dimension: 'COLUMNS',
                                            startIndex: 5,
                                            endIndex: 6
                                        },
                                        inheritFromBefore: false
                                    }
                                }
                            ]
                        }
                    });

                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${rawTitle}!F1:F1`,
                        valueInputOption: 'RAW',
                        requestBody: { values: [['UID']] }
                    });

                    console.log('[Sheets] Added "UID" column at F.');
                } catch (e) {
                    console.error(`[Sheets] UID column migration failed: ${e.message}`);
                }
            }

            // Keep conditional formatting rules in sync for Status column (A).
            // Remove prior rules that target column A, then re-add our current set.
            async function syncStatusFormattingForSheet(targetSheetId) {
                const numericSheetId = Number(targetSheetId);
                if (!Number.isFinite(numericSheetId)) return;

                // Re-fetch to ensure we see any updates after moveDimension.
                const meta2 = await sheetsClient.spreadsheets.get({
                    spreadsheetId,
                    fields: 'sheets(properties(sheetId,title),conditionalFormats)'
                });

                const sheets2 = meta2.data.sheets || [];
                const existingSheet = sheets2.find(s => s.properties && Number(s.properties.sheetId) === numericSheetId);
                const currentRules = existingSheet?.conditionalFormats || [];
                const deleteRequests = [];

                for (let i = currentRules.length - 1; i >= 0; i--) {
                    const rule = currentRules[i];
                    const ranges = rule?.ranges || [];
                    const touchesStatusColumn = ranges.some(r => {
                        const startCol = r.startColumnIndex ?? 0;
                        const endCol = r.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
                        return startCol <= 0 && endCol >= 1;
                    });
                    if (touchesStatusColumn) {
                        deleteRequests.push({ deleteConditionalFormatRule: { sheetId: numericSheetId, index: i } });
                    }
                }

                const requests = [
                    ...deleteRequests,
                    ...buildStatusConditionalFormattingRequests(numericSheetId)
                ];

                if (requests.length > 0) {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: { requests }
                    });
                }
            }

            await syncStatusFormattingForSheet(rawSheetId);
            await syncStatusFormattingForSheet(viewSheetId);
            for (const t of statusFilteredTabsWithIds) {
                await syncStatusFormattingForSheet(t.sheetId);
            }

            // Ensure "Detected at" (column B) displays as a date/time instead of raw serial numbers.
            // This fixes cases where the underlying value is a valid Sheets date but the column format is "Number".
            async function syncDetectedAtNumberFormatForSheet(targetSheetId) {
                const numericSheetId = Number(targetSheetId);
                if (!Number.isFinite(numericSheetId)) return;

                await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                repeatCell: {
                                    range: {
                                        sheetId: numericSheetId,
                                        startRowIndex: 1,
                                        endRowIndex: 10000,
                                        startColumnIndex: 1,
                                        endColumnIndex: 2
                                    },
                                    cell: {
                                        userEnteredFormat: buildDetectedAtDateTimeFormat()
                                    },
                                    fields: 'userEnteredFormat.numberFormat'
                                }
                            }
                        ]
                    }
                });
            }

            await syncDetectedAtNumberFormatForSheet(rawSheetId);
            await syncDetectedAtNumberFormatForSheet(viewSheetId);
            for (const t of statusFilteredTabsWithIds) {
                await syncDetectedAtNumberFormatForSheet(t.sheetId);
            }

            // Add a dropdown for Status on the RAW tab so you can manually adjust statuses if needed.
            // (Note: the Jobs tab is a formula-driven view, so editing cells there won't persist.)
            try {
                await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                setDataValidation: {
                                    range: {
                                        sheetId: Number(rawSheetId),
                                        startRowIndex: 1,
                                        endRowIndex: 10000,
                                        startColumnIndex: 0,
                                        endColumnIndex: 1
                                    },
                                    rule: buildStatusDropdownValidationRule()
                                }
                            }
                        ]
                    }
                });
            } catch (e) {
                console.error(`[Sheets] Status dropdown validation failed: ${e.message}`);
            }

            // If the header row is empty, write headers and conditional formatting rules.
            // RAW tab: write headers if empty.
            const rawHeaderRes = await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: `${rawTitle}!A1:P1`
            }).catch(() => null);

            const rawHeaderRow = rawHeaderRes?.data?.values?.[0] || [];
            if (rawHeaderRow.length === 0) {
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${rawTitle}!A1:P1`,
                    valueInputOption: 'RAW',
                    requestBody: { values: headerValues }
                });
            }

            // View tabs setup/versioning:
            // Clearing A2:Z causes a visible "empty then repopulate" flicker.
            // Only clear/rewrite when we detect setup hasn't been applied yet.
            const VIEW_SETUP_VERSION = 'view_setup_v4';

            async function getCellValue(sheetTitle, a1, valueRenderOption) {
                const res = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId,
                    range: `${sheetTitle}!${a1}:${a1}`,
                    valueRenderOption: valueRenderOption || 'UNFORMATTED_VALUE'
                }).catch(() => null);
                return res?.data?.values?.[0]?.[0] ?? '';
            }

            async function setCellValue(sheetTitle, a1, value, userEntered) {
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetTitle}!${a1}:${a1}`,
                    valueInputOption: userEntered ? 'USER_ENTERED' : 'RAW',
                    requestBody: { values: [[value]] }
                });
            }

            const viewSheetTitles = [viewTitle, ...statusFilteredTabsWithIds.map(t => t.title)];
            const markers = await Promise.all(viewSheetTitles.map(t => getCellValue(t, 'Z1', 'UNFORMATTED_VALUE')));
            const markerByTitle = new Map(viewSheetTitles.map((t, i) => [t, safeString(markers[i]).trim()]));

            const rawQ = quoteSheetName(rawTitle);
            // Jobs view (compat-friendly; avoids LET):
            // - 1 row per unique Job ID (latest event wins)
            // - Ordered by the FIRST time the Job ID was discovered (MIN raw '#')
            // - Jobs '#' column shows that first-seen number (stable)
            //
            // NOTE: This formula intentionally avoids LET/XLOOKUP so it works on older Sheets accounts.
            const latestExpr = `SORTN(SORT(FILTER(${rawQ}!A2:P, LEN(${rawQ}!E2:E)), 2, FALSE), 9^9, 2, 5, TRUE)`;
            const minsExpr = `QUERY({${rawQ}!E2:E&"", ${rawQ}!C2:C}, "select Col1, min(Col2) where Col1 is not null group by Col1 label min(Col2) ''", 0)`;
            const firstNoExpr = `(IFERROR(VLOOKUP(INDEX(${latestExpr},,5)&"", ${minsExpr}, 2, FALSE), ))`;
            // Base view query (16 columns total): includes "Final price (raw)" at far right.
            // We append a SUM row at the bottom with the sum of calculated Final price (column 8).
            const baseQuery = `QUERY(SORT({
${firstNoExpr},
INDEX(${latestExpr},,1),
INDEX(${latestExpr},,2),
${firstNoExpr},
INDEX(${latestExpr},,4),
INDEX(${latestExpr},,5),
INDEX(${latestExpr},,6),
INDEX(${latestExpr},,7),
INDEX(${latestExpr},,8),
INDEX(${latestExpr},,9),
INDEX(${latestExpr},,10),
INDEX(${latestExpr},,11),
INDEX(${latestExpr},,12),
INDEX(${latestExpr},,13),
INDEX(${latestExpr},,14),
INDEX(${latestExpr},,15),
INDEX(${latestExpr},,16)
}, 1, TRUE), "select Col2,Col3,Col4,Col5,Col6,Col7,Col8,Col9,Col10,Col11,Col12,Col13,Col14,Col15,Col16,Col17", 0)`;

            const sumRow = `{\"\",\"\",\"\",\"TOTAL\",\"\",\"\",\"\",SUM(INDEX(${baseQuery},,8)),\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"}`;
            const viewFormula2 = `=IFERROR({${baseQuery};${sumRow}}, "")`;

            async function ensureViewTab({ sheetTitle, desiredFormula }) {
                const marker = markerByTitle.get(sheetTitle);
                const needsReset = marker !== VIEW_SETUP_VERSION;

                if (needsReset) {
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${sheetTitle}!A1:P1`,
                        valueInputOption: 'RAW',
                        requestBody: { values: headerValues }
                    });

                    // Clear any legacy values that would block the spill formula.
                    await sheetsClient.spreadsheets.values.clear({
                        spreadsheetId,
                        range: `${sheetTitle}!A2:Z`
                    }).catch(() => null);

                    await setCellValue(sheetTitle, 'A2', desiredFormula, true);
                    await setCellValue(sheetTitle, 'Z1', VIEW_SETUP_VERSION, false);
                    return;
                }

                // Marker matches; only repair the formula if A2 is empty/non-formula.
                const a2 = safeString(await getCellValue(sheetTitle, 'A2', 'FORMULA')).trim();
                if (!a2.startsWith('=')) {
                    await setCellValue(sheetTitle, 'A2', desiredFormula, true);
                }
            }

            function escapeQueryStringLiteral(s) {
                return String(s || '').replace(/'/g, "''");
            }

            function buildStatusFilteredViewFormula(statusText) {
                const lit = escapeQueryStringLiteral(statusText);
                const q = `QUERY(SORT({
${firstNoExpr},
INDEX(${latestExpr},,1),
INDEX(${latestExpr},,2),
${firstNoExpr},
INDEX(${latestExpr},,4),
INDEX(${latestExpr},,5),
INDEX(${latestExpr},,6),
INDEX(${latestExpr},,7),
INDEX(${latestExpr},,8),
INDEX(${latestExpr},,9),
INDEX(${latestExpr},,10),
INDEX(${latestExpr},,11),
INDEX(${latestExpr},,12),
INDEX(${latestExpr},,13),
INDEX(${latestExpr},,14),
INDEX(${latestExpr},,15),
INDEX(${latestExpr},,16)
}, 1, TRUE), "select Col2,Col3,Col4,Col5,Col6,Col7,Col8,Col9,Col10,Col11,Col12,Col13,Col14,Col15,Col16,Col17 where Col2 = '${lit}'", 0)`;

                const footer = `{\"\",\"\",\"\",\"TOTAL\",\"\",\"\",\"\",SUM(INDEX(${q},,8)),\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"}`;
                return `=IFERROR({${q};${footer}}, "")`;
            }

            await ensureViewTab({ sheetTitle: viewTitle, desiredFormula: viewFormula2 });
            for (const t of statusFilteredTabsWithIds) {
                if (!t.sheetId) continue;
                await ensureViewTab({ sheetTitle: t.title, desiredFormula: buildStatusFilteredViewFormula(t.statusText) });
            }

            isReady = true;
            console.log(`[Sheets] Logging enabled → ${viewTitle} (view) + ${rawTitle} (raw) (spreadsheet ${spreadsheetId})`);
        } catch (e) {
            console.error(`[Sheets] Init failed: ${e.message}`);
        }
    }

    async function flushOnce() {
        if (!isEnabled()) return;
        if (isFlushing) return;
        if (queue.length === 0) return;

        isFlushing = true;
        try {
            await lazyInit();
            if (!isReady || !sheetsClient) return;

            const batchSize = parseInt(process.env.GOOGLE_SHEETS_BATCH_SIZE || '25', 10);
            const items = queue.splice(0, Math.max(1, batchSize));
            const rows = items.map(i => i.values);

            await sheetsClient.spreadsheets.values.append({
                spreadsheetId,
                range: `${rawTitle}!A:P`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values: rows }
            });
        } catch (e) {
            console.error(`[Sheets] Append failed: ${e.message}`);
        } finally {
            isFlushing = false;
        }
    }

    async function flushNow() {
        if (!isEnabled()) return;
        // Drain the queue in batches.
        while (queue.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            await flushOnce();
            // Give the event loop a tick if the sheet is unavailable.
            if (queue.length > 0 && !isReady) break;
        }
    }

    function start() {
        if (!isEnabled()) return;

        // Fire-and-forget init; do not block the checker.
        lazyInit().catch(() => {});

        const intervalMs = parseInt(process.env.GOOGLE_SHEETS_FLUSH_MS || '1000', 10);
        setInterval(() => {
            flushOnce().catch(() => {});
        }, Math.max(250, intervalMs));

        // Best-effort flush on shutdown.
        process.on('SIGINT', () => flushOnce().finally(() => process.exit(0)));
        process.on('SIGTERM', () => flushOnce().finally(() => process.exit(0)));
    }

    return { start, enqueue, flushNow };
}

module.exports = {
    createSheetsLogger
};
