/**
 * FFmpeg-based video generator. Creates slideshow videos from product images
 * with fade transitions and optional background music.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { downloadUrl } = require('./downloadUtils');

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_SLIDE_DURATION = 3;
const DEFAULT_FADE_DURATION = 0.5;
const DEFAULT_FPS = 30;
const DEFAULT_TRANSITION_TYPE = 'fade';
const IMAGE_DOWNLOAD_OPTIONS = {
    timeoutMs: 60_000,
    retries: 1,
    retryDelayMs: 800,
    maxRedirects: 5
};
const AUDIO_DOWNLOAD_OPTIONS = {
    timeoutMs: 150_000,
    retries: 2,
    retryDelayMs: 1_200,
    maxRedirects: 6
};

const TRANSITION_ALIASES = {
    fade: 'fade',
    crossfade: 'fade',
    cut: 'cut',
    none: 'cut',
    slideleft: 'slideleft',
    'slide-left': 'slideleft',
    slide_left: 'slideleft',
    slideright: 'slideright',
    'slide-right': 'slideright',
    slide_right: 'slideright',
    wipeleft: 'wipeleft',
    'wipe-left': 'wipeleft',
    wipe_left: 'wipeleft',
    wiperight: 'wiperight',
    'wipe-right': 'wiperight',
    wipe_right: 'wiperight',
    dissolve: 'dissolve'
};

/**
 * Ensure directory exists.
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Recursively remove directory.
 */
function rmRecursive(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) rmRecursive(p);
        else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
}

/**
 * Run FFmpeg with arguments. Returns a promise that resolves when done.
 */
function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr = [];
        proc.stderr.on('data', (d) => stderr.push(d.toString()));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else {
                const stderrTail = stderr.join('').slice(-1200);
                const argsTail = args.join(' ').slice(-1200);
                reject(new Error(`FFmpeg exited ${code}: ${stderrTail}\nArgs: ${argsTail}`));
            }
        });
        proc.on('error', reject);
    });
}

function toPositiveNumber(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

function normalizeTransitionType(input) {
    const raw = String(input || '').trim().toLowerCase();
    return TRANSITION_ALIASES[raw] || DEFAULT_TRANSITION_TYPE;
}

/**
 * Generate a slideshow video from image URLs.
 * @param {Object} opts
 * @param {string[]} opts.imageUrls - URLs of product preview images
 * @param {string} [opts.audioUrl] - Optional URL of background music
 * @param {string} opts.outputPath - Local path for output MP4
 * @param {number} [opts.slideDuration] - Seconds per slide (default 3)
 * @param {number} [opts.fadeDuration] - Fade transition duration (default 0.5)
 * @param {string} [opts.transitionType] - Transition type (fade | cut | slideleft | slideright | wipeleft | wiperight | dissolve)
 * @param {number} [opts.fps] - Output frames per second (default 30)
 * @param {number} [opts.width] - Video width (default 1080)
 * @param {number} [opts.height] - Video height (default 1920)
 * @returns {Promise<string>} Path to generated video
 */
async function generateSlideshowVideo({
    imageUrls,
    audioUrl = null,
    outputPath,
    slideDuration = DEFAULT_SLIDE_DURATION,
    fadeDuration = DEFAULT_FADE_DURATION,
    transitionType = DEFAULT_TRANSITION_TYPE,
    fps = DEFAULT_FPS,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT
}) {
    if (!imageUrls || imageUrls.length === 0) {
        throw new Error('At least one image URL is required');
    }
    if (!outputPath) {
        throw new Error('outputPath is required');
    }

    const tmpDir = path.join(path.dirname(outputPath), `_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    ensureDir(tmpDir);

    try {
        const localPaths = [];
        for (let i = 0; i < imageUrls.length; i++) {
            const url = imageUrls[i];
            if (!url || typeof url !== 'string') continue;
            const ext = path.extname(new URL(url).pathname) || '.jpg';
            const dest = path.join(tmpDir, `img_${i.toString().padStart(3, '0')}${ext}`);
            await downloadUrl(url, dest, IMAGE_DOWNLOAD_OPTIONS);
            localPaths.push(dest);
        }

        if (localPaths.length === 0) {
            throw new Error('No valid images could be downloaded');
        }

        const n = localPaths.length;
        const safeSlideDuration = toPositiveNumber(slideDuration, DEFAULT_SLIDE_DURATION);
        const safeFps = Math.max(1, Math.round(toPositiveNumber(fps, DEFAULT_FPS)));
        const transitionName = normalizeTransitionType(transitionType);
        const maxTransitionDuration = Math.max(0, safeSlideDuration - 0.05);
        const requestedTransitionDuration = toPositiveNumber(fadeDuration, DEFAULT_FADE_DURATION);
        const safeTransitionDuration = transitionName === 'cut'
            ? 0
            : Math.max(0, Math.min(requestedTransitionDuration, maxTransitionDuration));
        const useTransitionFadeFallback = n > 1 && transitionName !== 'cut' && safeTransitionDuration > 0;
        const transitionDurationText = safeTransitionDuration.toFixed(3);
        const fadeOutStartText = Math.max(0, safeSlideDuration - safeTransitionDuration).toFixed(3);

        const filterParts = [];
        const inputArgs = [];
        for (let i = 0; i < localPaths.length; i++) {
            inputArgs.push('-loop', '1', '-t', String(safeSlideDuration), '-i', localPaths[i]);
        }

        const dar = `${width}/${height}`;
        const slideNormalize = [
            `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
            `fps=${safeFps}`,
            `trim=duration=${safeSlideDuration}`,
            'settb=AVTB',
            'setpts=PTS-STARTPTS',
            'setsar=1/1',
            `setdar=${dar}`,
            'format=yuv420p'
        ].join(',');
        for (let i = 0; i < n; i++) {
            let chain = `[${i}:v]${slideNormalize}`;
            if (useTransitionFadeFallback) {
                if (i > 0) {
                    chain += `,fade=t=in:st=0:d=${transitionDurationText}`;
                }
                if (i < (n - 1)) {
                    chain += `,fade=t=out:st=${fadeOutStartText}:d=${transitionDurationText}`;
                }
            }
            chain += `[s${i}]`;
            filterParts.push(chain);
        }

        if (n === 1) {
            filterParts.push('[s0]null[outv]');
        } else {
            const labels = [];
            for (let i = 0; i < n; i++) labels.push(`[s${i}]`);
            filterParts.push(`${labels.join('')}concat=n=${n}:v=1:a=0[outv]`);
        }

        if (audioUrl) {
            const audioPath = path.join(tmpDir, 'audio.mp3');
            await downloadUrl(audioUrl, audioPath, AUDIO_DOWNLOAD_OPTIONS);
            inputArgs.push('-i', audioPath);
            const totalDuration = n * safeSlideDuration;
            const safeTotalDuration = Math.max(0.1, totalDuration);
            const totalDurationText = safeTotalDuration.toFixed(3);
            filterParts.push(
                `[${n}:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
                // Use plain apad for broad FFmpeg compatibility, then clamp to video duration.
                `volume=0.5,apad,atrim=0:${totalDurationText},asetpts=PTS-STARTPTS[outa]`
            );
        }

        const mapArgs = audioUrl ? ['-map', '[outv]', '-map', '[outa]'] : ['-map', '[outv]', '-an'];
        const audioCodec = audioUrl ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2'] : [];
        const shortestArg = audioUrl ? ['-shortest'] : [];
        const args = [
            '-y',
            ...inputArgs,
            '-filter_complex', filterParts.join(';'),
            ...mapArgs,
            '-c:v', 'libx264',
            ...audioCodec,
            ...shortestArg,
            '-preset', 'medium',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outputPath
        ];

        await runFfmpeg(args);
        return outputPath;
    } finally {
        rmRecursive(tmpDir);
    }
}

/**
 * Upload a local video file to Cloudinary.
 * @param {string} localPath
 * @param {Object} cloudinary - cloudinary.v2 instance
 * @param {string} [folder] - Optional folder in Cloudinary
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadToCloudinary(localPath, cloudinary, folder = 'category-videos') {
    return new Promise((resolve, reject) => {
        const opts = {
            resource_type: 'video',
            folder: folder || undefined
        };
        cloudinary.uploader.upload(localPath, opts, (err, result) => {
            if (err) return reject(err);
            resolve({
                url: result.secure_url,
                publicId: result.public_id
            });
        });
    });
}

module.exports = {
    generateSlideshowVideo,
    uploadToCloudinary,
    DEFAULT_SLIDE_DURATION,
    DEFAULT_FADE_DURATION,
    DEFAULT_FPS,
    DEFAULT_TRANSITION_TYPE
};
