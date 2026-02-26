const path = require('path');
const fs = require('fs');
const os = require('os');

const mockGenerate = jest.fn();
const mockUpload = jest.fn();
const mockProductList = jest.fn();

jest.mock('../lib/VideoGenerator', () => ({
    generateSlideshowVideo: (...args) => mockGenerate(...args),
    uploadToCloudinary: (...args) => mockUpload(...args)
}));

const { VideoJobQueue, JOB_STATUS } = require('../lib/VideoJobQueue');

describe('VideoJobQueue', () => {
    let queue;
    let outputDir;

    beforeEach(() => {
        outputDir = path.join(os.tmpdir(), `videojob_test_${Date.now()}`);
        fs.mkdirSync(outputDir, { recursive: true });
        queue = new VideoJobQueue({
            cloudinary: { uploader: {} },
            productService: {
                list: mockProductList
            },
            categoryService: {},
            outputDir
        });
        mockGenerate.mockReset();
        mockUpload.mockReset();
        mockProductList.mockReset();
    });

    afterEach(() => {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
    });

    describe('add', () => {
        it('returns a job ID', () => {
            mockProductList.mockResolvedValue([
                { previewUrl: 'https://ex.com/1.jpg' }
            ]);
            mockGenerate.mockResolvedValue(path.join(outputDir, 'out.mp4'));
            mockUpload.mockResolvedValue({ url: 'https://cloudinary.com/v.mp4', publicId: 'v123' });

            const jobId = queue.add('owner-1', 'cat-1');
            expect(jobId).toMatch(/^vid_\d+_[a-z0-9]+$/);
        });

        it('creates a pending job', () => {
            mockProductList.mockResolvedValue([{ previewUrl: 'https://ex.com/1.jpg' }]);
            mockGenerate.mockResolvedValue(path.join(outputDir, 'out.mp4'));
            mockUpload.mockResolvedValue({ url: 'https://c.com/v.mp4', publicId: 'v1' });

            const jobId = queue.add('owner-1', 'cat-1');
            const job = queue.get(jobId);
            expect(job).toBeDefined();
            expect(job.ownerId).toBe('owner-1');
            expect(job.categoryId).toBe('cat-1');
        });
    });

    describe('get', () => {
        it('returns null for unknown job', () => {
            expect(queue.get('unknown')).toBeNull();
        });
    });

    describe('JOB_STATUS', () => {
        it('has expected statuses', () => {
            expect(JOB_STATUS.PENDING).toBe('pending');
            expect(JOB_STATUS.PROCESSING).toBe('processing');
            expect(JOB_STATUS.COMPLETED).toBe('completed');
            expect(JOB_STATUS.FAILED).toBe('failed');
        });
    });

    describe('processing', () => {
        it('completes job and sets videoUrl', async () => {
            const outputPath = path.join(outputDir, 'gen.mp4');
            fs.writeFileSync(outputPath, 'video');
            mockProductList.mockResolvedValue([
                { previewUrl: 'https://ex.com/1.jpg' }
            ]);
            mockGenerate.mockResolvedValue(outputPath);
            mockUpload.mockResolvedValue({
                url: 'https://res.cloudinary.com/vid.mp4',
                publicId: 'folder/vid123'
            });

            const jobId = queue.add('owner-1', 'cat-1');
            await new Promise((r) => setTimeout(r, 100));

            const job = queue.get(jobId);
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
            expect(job.videoUrl).toBe('https://res.cloudinary.com/vid.mp4');
            expect(job.progress).toBe(100);
            expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
                imageUrls: ['https://ex.com/1.jpg'],
                audioUrl: null,
                slideDuration: 3,
                fadeDuration: 0.5,
                transitionType: 'fade',
                outputPath: expect.any(String)
            }));
        });

        it('passes custom video options to generator', async () => {
            const outputPath = path.join(outputDir, 'custom.mp4');
            fs.writeFileSync(outputPath, 'video');
            mockProductList.mockResolvedValue([
                { previewUrl: 'https://ex.com/1.jpg' },
                { previewUrl: 'https://ex.com/2.jpg' }
            ]);
            mockGenerate.mockResolvedValue(outputPath);
            mockUpload.mockResolvedValue({
                url: 'https://res.cloudinary.com/custom.mp4',
                publicId: 'folder/custom'
            });

            const jobId = queue.add('owner-1', 'cat-1', {
                audioUrl: '   https://cdn.example.com/audio.mp3   ',
                slideDuration: 4,
                fadeDuration: 1.1,
                transitionType: 'slideleft'
            });
            await new Promise((r) => setTimeout(r, 100));

            const job = queue.get(jobId);
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
            expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
                imageUrls: ['https://ex.com/1.jpg', 'https://ex.com/2.jpg'],
                audioUrl: 'https://cdn.example.com/audio.mp3',
                slideDuration: 4,
                fadeDuration: 1.1,
                transitionType: 'slideleft'
            }));
        });

        it('sets failed status when no products', async () => {
            mockProductList.mockResolvedValue([]);

            const jobId = queue.add('owner-1', 'cat-1');
            await new Promise((r) => setTimeout(r, 100));

            const job = queue.get(jobId);
            expect(job.status).toBe(JOB_STATUS.FAILED);
            expect(job.error).toContain('No products');
        });

        it('sets failed status when generate fails', async () => {
            mockProductList.mockResolvedValue([{ previewUrl: 'https://ex.com/1.jpg' }]);
            mockGenerate.mockRejectedValue(new Error('FFmpeg failed'));

            const jobId = queue.add('owner-1', 'cat-1');
            await new Promise((r) => setTimeout(r, 100));

            const job = queue.get(jobId);
            expect(job.status).toBe(JOB_STATUS.FAILED);
            expect(job.error).toContain('FFmpeg failed');
        });
    });
});
