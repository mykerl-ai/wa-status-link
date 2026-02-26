const path = require('path');
const fs = require('fs');
const os = require('os');

const mockSpawn = jest.fn();
const mockDownload = jest.fn();

jest.mock('child_process', () => ({
    spawn: (...args) => mockSpawn(...args)
}));

jest.mock('@ffmpeg-installer/ffmpeg', () => ({
    path: '/fake/ffmpeg'
}));

jest.mock('../lib/downloadUtils', () => ({
    downloadUrl: (url, destPath) => mockDownload(url, destPath)
}));

const {
    generateSlideshowVideo,
    uploadToCloudinary,
    DEFAULT_SLIDE_DURATION,
    DEFAULT_FADE_DURATION,
    DEFAULT_TRANSITION_TYPE
} = require('../lib/VideoGenerator');

describe('VideoGenerator', () => {
    let outputDir;

    beforeEach(() => {
        outputDir = path.join(os.tmpdir(), `videogen_test_${Date.now()}`);
        fs.mkdirSync(outputDir, { recursive: true });
        mockSpawn.mockReset();
        mockDownload.mockReset();

        mockDownload.mockImplementation((url, destPath) => {
            fs.writeFileSync(destPath, 'fake-image-content');
            return Promise.resolve(destPath);
        });

        mockSpawn.mockReturnValue({
            stderr: { on: jest.fn() },
            on: (ev, cb) => {
                if (ev === 'close') setTimeout(() => cb(0), 10);
                return {};
            }
        });
    });

    afterEach(() => {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
    });

    describe('generateSlideshowVideo', () => {
        it('throws if no image URLs', async () => {
            await expect(
                generateSlideshowVideo({ imageUrls: [], outputPath: path.join(outputDir, 'out.mp4') })
            ).rejects.toThrow('At least one image URL is required');
        });

        it('throws if outputPath missing', async () => {
            await expect(
                generateSlideshowVideo({ imageUrls: ['https://example.com/1.jpg'] })
            ).rejects.toThrow('outputPath is required');
        });

        it('downloads images and runs FFmpeg', async () => {
            const outputPath = path.join(outputDir, 'output.mp4');
            const urls = ['https://example.com/a.jpg', 'https://example.com/b.png'];

            const result = await generateSlideshowVideo({
                imageUrls: urls,
                outputPath
            });

            expect(result).toBe(outputPath);
            expect(mockDownload).toHaveBeenCalledTimes(2);
            expect(mockDownload).toHaveBeenCalledWith(urls[0], expect.any(String));
            expect(mockDownload).toHaveBeenCalledWith(urls[1], expect.any(String));
            expect(mockSpawn).toHaveBeenCalledWith(
                '/fake/ffmpeg',
                expect.arrayContaining(['-y', '-loop', '1', '-t', '3', outputPath]),
                expect.any(Object)
            );

            const ffmpegArgs = mockSpawn.mock.calls[0][1];
            const filterComplexIndex = ffmpegArgs.indexOf('-filter_complex');
            expect(filterComplexIndex).toBeGreaterThan(-1);
            const filterGraph = ffmpegArgs[filterComplexIndex + 1];
            expect(filterGraph).toContain('fps=30');
            expect(filterGraph).toContain('setsar=1/1');
        });

        it('uses custom slide duration', async () => {
            const outputPath = path.join(outputDir, 'out.mp4');
            await generateSlideshowVideo({
                imageUrls: ['https://ex.com/1.jpg'],
                outputPath,
                slideDuration: 5
            });
            expect(mockSpawn).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining(['-t', '5']),
                expect.any(Object)
            );
        });

        it('skips invalid URLs', async () => {
            const outputPath = path.join(outputDir, 'out.mp4');
            await generateSlideshowVideo({
                imageUrls: ['https://valid.com/1.jpg', null, '', 'https://valid.com/2.jpg'],
                outputPath
            });
            expect(mockDownload).toHaveBeenCalledTimes(2);
        });

        it('uses fade fallback transition when transition type is set', async () => {
            const outputPath = path.join(outputDir, 'xfade.mp4');
            await generateSlideshowVideo({
                imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
                outputPath,
                transitionType: 'slideleft',
                fadeDuration: 0.7
            });

            const ffmpegArgs = mockSpawn.mock.calls[0][1];
            const filterGraph = ffmpegArgs[ffmpegArgs.indexOf('-filter_complex') + 1];
            expect(filterGraph).toContain('fade=t=in:st=0:d=0.700');
            expect(filterGraph).toContain('fade=t=out:st=2.300:d=0.700');
            expect(filterGraph).not.toContain('xfade=');
        });

        it('uses concat when transition type is cut', async () => {
            const outputPath = path.join(outputDir, 'cut.mp4');
            await generateSlideshowVideo({
                imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
                outputPath,
                transitionType: 'cut'
            });

            const ffmpegArgs = mockSpawn.mock.calls[0][1];
            const filterGraph = ffmpegArgs[ffmpegArgs.indexOf('-filter_complex') + 1];
            expect(filterGraph).toContain('concat=n=2:v=1:a=0');
            expect(filterGraph).not.toContain('xfade=');
        });

        it('encodes audio as AAC when audioUrl is provided', async () => {
            const outputPath = path.join(outputDir, 'audio.mp4');
            await generateSlideshowVideo({
                imageUrls: ['https://example.com/a.jpg'],
                audioUrl: 'https://example.com/soundtrack.mp3',
                outputPath
            });

            const ffmpegArgs = mockSpawn.mock.calls[0][1];
            expect(ffmpegArgs).toEqual(expect.arrayContaining(['-c:a', 'aac', '-shortest']));
            const filterGraph = ffmpegArgs[ffmpegArgs.indexOf('-filter_complex') + 1];
            expect(filterGraph).toContain('apad,atrim=');
            expect(filterGraph).not.toContain('apad=whole_dur');
            expect(mockDownload).toHaveBeenCalledTimes(2);
        });
    });

    describe('constants', () => {
        it('exports DEFAULT_SLIDE_DURATION', () => {
            expect(DEFAULT_SLIDE_DURATION).toBe(3);
        });
        it('exports DEFAULT_FADE_DURATION', () => {
            expect(DEFAULT_FADE_DURATION).toBe(0.5);
        });
        it('exports DEFAULT_TRANSITION_TYPE', () => {
            expect(DEFAULT_TRANSITION_TYPE).toBe('fade');
        });
    });

    describe('uploadToCloudinary', () => {
        it('rejects when cloudinary upload fails', async () => {
            const cloudinary = {
                uploader: {
                    upload: (p, opts, cb) => cb(new Error('Upload failed'))
                }
            };
            const testFile = path.join(outputDir, 'test.mp4');
            fs.writeFileSync(testFile, 'video');

            await expect(
                uploadToCloudinary(testFile, cloudinary)
            ).rejects.toThrow('Upload failed');
        });

        it('resolves with url and publicId on success', async () => {
            const cloudinary = {
                uploader: {
                    upload: (p, opts, cb) => cb(null, {
                        secure_url: 'https://res.cloudinary.com/video.mp4',
                        public_id: 'folder/video123'
                    })
                }
            };
            const testFile = path.join(outputDir, 'test.mp4');
            fs.writeFileSync(testFile, 'video');

            const result = await uploadToCloudinary(testFile, cloudinary);
            expect(result).toEqual({
                url: 'https://res.cloudinary.com/video.mp4',
                publicId: 'folder/video123'
            });
        });
    });
});
