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
        case 'taken':
            return 'Job taken';
        case 'failed':
            return 'Failed to take job';
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
    const statusRange = { sheetId, startRowIndex: 1, startColumnIndex: 12, endColumnIndex: 13 };

    return [
        // Green = taken
        {
            addConditionalFormatRule: {
                index: 0,
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
                index: 1,
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
                index: 2,
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
                index: 3,
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
        // Legacy alias (kept for older rows)
        {
            addConditionalFormatRule: {
                index: 4,
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

function isEnabled() {
    return Boolean(process.env.GOOGLE_SHEETS_ID);
}

function createSheetsLogger() {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetTitle = process.env.GOOGLE_SHEETS_TAB || 'Jobs';

    const queue = [];
    let sheetsClient = null;
    let sheetId = null;
    let isReady = false;
    let isFlushing = false;

    function enqueue(job, status) {
        if (!isEnabled()) return;

        const variations = Number(job.variations || 1) || 1;
        const finalPrice = Number(job.finalPrice ?? job.price ?? 0) || 0;
        const pricePerVariation = variations > 0 ? (finalPrice / variations) : finalPrice;

        queue.push({
            values: [
                '=ROW()-1',
                safeString(job.title),
                safeString(job.id),
                safeString(job.originalPrice ?? ''),
                safeString(finalPrice),
                safeString(job.multiplier ?? ''),
                safeString(job.complexity ?? ''),
                job.isGrouped ? 'Grouped' : 'Solo',
                safeString(variations),
                safeString(pricePerVariation),
                safeString(job.groupType ?? ''),
                safeString(job.tags ?? ''),
                statusToText(status)
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
            const existing = sheets.find(s => s.properties && s.properties.title === sheetTitle);

            if (!existing) {
                const addSheetRes = await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        requests: [{ addSheet: { properties: { title: sheetTitle } } }]
                    }
                });
                sheetId = addSheetRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
            } else {
                sheetId = existing.properties.sheetId;
            }

            // Keep conditional formatting rules in sync for Status column (M).
            // Remove prior rules that target column M, then re-add our current set.
            if (typeof sheetId === 'number') {
                const existingSheet = sheets.find(s => s.properties && s.properties.sheetId === sheetId);
                const currentRules = existingSheet?.conditionalFormats || [];
                const deleteRequests = [];

                for (let i = currentRules.length - 1; i >= 0; i--) {
                    const rule = currentRules[i];
                    const ranges = rule?.ranges || [];
                    const touchesStatusColumn = ranges.some(r => {
                        const startCol = r.startColumnIndex ?? 0;
                        const endCol = r.endColumnIndex ?? 0;
                        return startCol <= 12 && endCol >= 13;
                    });
                    if (touchesStatusColumn) {
                        deleteRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
                    }
                }

                const requests = [
                    ...deleteRequests,
                    ...buildStatusConditionalFormattingRequests(sheetId)
                ];

                if (requests.length > 0) {
                    await sheetsClient.spreadsheets.batchUpdate({
                        spreadsheetId,
                        requestBody: { requests }
                    });
                }
            }

            // If the header row is empty, write headers and conditional formatting rules.
            const headerRes = await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetTitle}!A1:M1`
            }).catch(() => null);

            const headerRow = headerRes?.data?.values?.[0] || [];
            const isHeaderEmpty = headerRow.length === 0;

            if (isHeaderEmpty) {
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetTitle}!A1:M1`,
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: [[
                            '#',
                            'Job title',
                            'Job ID',
                            'Original price',
                            'Final price',
                            'Multiplier',
                            'Complexity',
                            'Job type',
                            'Variations',
                            'Price per variation',
                            'Group type',
                            'Tags',
                            'Status'
                        ]]
                    }
                });

                // Conditional formatting handled above (kept in sync even if sheet already exists).
            }

            isReady = true;
            console.log(`[Sheets] Logging enabled → ${sheetTitle} (spreadsheet ${spreadsheetId})`);
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
                range: `${sheetTitle}!A:M`,
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

    return { start, enqueue };
}

module.exports = {
    createSheetsLogger
};
