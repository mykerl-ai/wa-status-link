/**
 * Download utilities. Extracted for testability.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 800;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupFile(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // ignore
    }
}

function downloadOnce(url, destPath, options) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const maxRedirects = Number(options.maxRedirects) >= 0 ? Number(options.maxRedirects) : DEFAULT_MAX_REDIRECTS;
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const requestOptions = {
            headers: {
                'User-Agent': 'WaStatusLink/1.0',
                Accept: '*/*'
            },
            timeout: timeoutMs
        };
        const req = protocol.get(urlObj, requestOptions, (res) => {
            const statusCode = Number(res.statusCode || 0);
            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                if (maxRedirects <= 0) {
                    res.resume();
                    return reject(new Error('Too many redirects'));
                }
                const nextUrl = new URL(res.headers.location, urlObj).toString();
                res.resume();
                return downloadOnce(nextUrl, destPath, {
                    ...options,
                    maxRedirects: maxRedirects - 1
                }).then(resolve).catch(reject);
            }
            if (statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${statusCode}`));
            }

            const out = fs.createWriteStream(destPath);
            let finished = false;
            const finish = (err) => {
                if (finished) return;
                finished = true;
                if (err) {
                    try { out.destroy(); } catch { /* ignore */ }
                    cleanupFile(destPath);
                    reject(err);
                    return;
                }
                out.close(() => resolve(destPath));
            };

            out.on('finish', () => finish(null));
            out.on('error', finish);
            res.on('error', finish);
            res.on('aborted', () => finish(new Error('Download aborted')));
            res.pipe(out);
        });

        req.on('error', (err) => {
            cleanupFile(destPath);
            reject(err);
        });
        req.on('timeout', () => {
            req.destroy(new Error('Download timeout'));
        });
    });
}

/**
 * Download a URL to a local file.
 * @param {string} url
 * @param {string} destPath
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @returns {Promise<string>} Path to downloaded file
 */
async function downloadUrl(url, destPath, options = {}) {
    const retries = Number(options.retries) >= 0 ? Number(options.retries) : DEFAULT_RETRIES;
    const retryDelayMs = Number(options.retryDelayMs) > 0 ? Number(options.retryDelayMs) : DEFAULT_RETRY_DELAY_MS;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await downloadOnce(url, destPath, options);
        } catch (err) {
            lastError = err;
            if (attempt >= retries) break;
            const delayMs = retryDelayMs * Math.pow(2, attempt);
            console.warn('[debug][download] retrying', {
                attempt: attempt + 1,
                retries,
                delayMs,
                reason: err && err.message ? err.message : String(err)
            });
            await wait(delayMs);
        }
    }

    const message = lastError && lastError.message ? lastError.message : 'Download failed';
    if (retries > 0) {
        throw new Error(`${message} after ${retries + 1} attempts`);
    }
    throw new Error(message);
}

module.exports = { downloadUrl };
