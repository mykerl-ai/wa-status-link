/**
 * In-memory job queue for category video generation.
 * Processes one job at a time. Job status: pending | processing | completed | failed
 */
const path = require('path');
const fs = require('fs');
const { generateSlideshowVideo, uploadToCloudinary } = require('./VideoGenerator');

const JOB_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

class VideoJobQueue {
    constructor({ cloudinary, productService, categoryService, outputDir }) {
        this.cloudinary = cloudinary;
        this.productService = productService;
        this.categoryService = categoryService;
        this.outputDir = outputDir || path.join(process.cwd(), 'uploads', 'videos');
        this.jobs = new Map();
        this.queue = [];
        this.processing = false;
    }

    _ensureOutputDir() {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Add a job. Returns jobId.
     */
    add(ownerId, categoryId, options = {}) {
        const jobId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        this.jobs.set(jobId, {
            id: jobId,
            ownerId,
            categoryId,
            status: JOB_STATUS.PENDING,
            progress: 0,
            videoUrl: null,
            publicId: null,
            error: null,
            createdAt: new Date().toISOString(),
            ...options
        });
        this.queue.push(jobId);
        this._processNext();
        return jobId;
    }

    /**
     * Get job status.
     */
    get(jobId) {
        return this.jobs.get(jobId) || null;
    }

    /**
     * Process next job in queue.
     */
    async _processNext() {
        if (this.processing || this.queue.length === 0) return;
        const jobId = this.queue.shift();
        const job = this.jobs.get(jobId);
        if (!job || job.status !== JOB_STATUS.PENDING) {
            return this._processNext();
        }

        this.processing = true;
        job.status = JOB_STATUS.PROCESSING;
        job.progress = 10;

        try {
            const products = await this.productService.list(job.ownerId, job.categoryId);
            if (!products || products.length === 0) {
                throw new Error('No products in this category');
            }

            const imageUrls = products
                .flatMap((p) => {
                    const mediaUrls = Array.isArray(p.mediaUrls) ? p.mediaUrls.filter(Boolean) : [];
                    if (mediaUrls.length) return mediaUrls;
                    return [p.previewUrl || p.link].filter(Boolean);
                })
                .filter(Boolean);
            if (imageUrls.length === 0) {
                throw new Error('No product images found');
            }

            job.progress = 20;
            this._ensureOutputDir();
            const outputPath = path.join(this.outputDir, `${jobId}.mp4`);

            await generateSlideshowVideo({
                imageUrls,
                audioUrl: (typeof job.audioUrl === 'string' && job.audioUrl.trim()) ? job.audioUrl.trim() : null,
                slideDuration: job.slideDuration || 3,
                fadeDuration: job.fadeDuration || 0.5,
                transitionType: job.transitionType || 'fade',
                outputPath
            });

            job.progress = 80;

            if (this.cloudinary) {
                const { url, publicId } = await uploadToCloudinary(outputPath, this.cloudinary);
                job.videoUrl = url;
                job.publicId = publicId;
                try {
                    fs.unlinkSync(outputPath);
                } catch (e) {
                    /* ignore */
                }
            } else {
                job.videoUrl = `/uploads/videos/${path.basename(outputPath)}`;
            }

            job.progress = 100;
            job.status = JOB_STATUS.COMPLETED;
        } catch (err) {
            job.status = JOB_STATUS.FAILED;
            job.error = err.message || String(err);
        } finally {
            this.processing = false;
            this._processNext();
        }
    }
}

module.exports = { VideoJobQueue, JOB_STATUS };
