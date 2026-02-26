/**
 * Download utilities. Extracted for testability.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');

/**
 * Download a URL to a local file.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<string>} Path to downloaded file
 */
function downloadUrl(url, destPath) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        const out = fs.createWriteStream(destPath);
        const opts = {
            headers: { 'User-Agent': 'WaStatusLink/1.0' },
            timeout: 30000
        };
        const req = protocol.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                out.close();
                fs.unlink(destPath, () => {});
                return downloadUrl(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                out.close();
                fs.unlink(destPath, () => {});
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(out);
            out.on('finish', () => {
                out.close();
                resolve(destPath);
            });
        });
        req.on('error', (err) => {
            out.close();
            fs.unlink(destPath, () => {});
            reject(err);
        });
        req.on('timeout', () => {
            req.destroy();
            out.close();
            fs.unlink(destPath, () => {});
            reject(new Error('Download timeout'));
        });
    });
}

module.exports = { downloadUrl };
