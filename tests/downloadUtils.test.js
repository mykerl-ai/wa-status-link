const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mockGet = jest.fn();
jest.mock('https', () => ({
    get: (url, opts, cb) => mockGet(url, opts, cb)
}));
jest.mock('http', () => ({
    get: jest.fn()
}));

const { downloadUrl } = require('../lib/downloadUtils');

describe('downloadUtils', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `download_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        mockGet.mockReset();
    });

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('resolves with dest path on 200', async () => {
        const dest = path.join(tmpDir, 'file.jpg');
        mockGet.mockImplementation((url, opts, cb) => {
            const res = {
                statusCode: 200,
                pipe: (stream) => {
                    stream.write('content');
                    stream.end();
                }
            };
            setImmediate(() => cb(res));
            return { on: jest.fn() };
        });

        const result = await downloadUrl('https://example.com/img.jpg', dest);
        expect(result).toBe(dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('content');
    });

    it('rejects on non-2xx status', async () => {
        mockGet.mockImplementation((url, opts, cb) => {
            const res = { statusCode: 404 };
            setImmediate(() => cb(res));
            return { on: jest.fn() };
        });

        await expect(
            downloadUrl('https://example.com/missing.jpg', path.join(tmpDir, 'out.jpg'))
        ).rejects.toThrow('HTTP 404');
    });

    it('rejects on request error', async () => {
        mockGet.mockImplementation((url, opts, cb) => {
            const req = {
                on: (ev, handler) => {
                    if (ev === 'error') setImmediate(() => handler(new Error('Network error')));
                    return req;
                }
            };
            return req;
        });

        await expect(
            downloadUrl('https://example.com/img.jpg', path.join(tmpDir, 'out.jpg'))
        ).rejects.toThrow('Network error');
    });
});
