const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeBadgeLabel,
    buildImageTransformations,
    buildProductLink,
    buildVideoAnimatedPreviewUrl,
    buildVideoOgPreviewUrl,
    buildImagePreviewUrl
} = require('../lib/MediaPipeline');

function mockCloudinary() {
    return {
        url(publicId, options) {
            return JSON.stringify({ publicId, options });
        }
    };
}

test('normalizeBadgeLabel keeps allowed values only', () => {
    assert.equal(normalizeBadgeLabel('sale'), 'SALE');
    assert.equal(normalizeBadgeLabel('limited'), 'LIMITED');
    assert.equal(normalizeBadgeLabel('not-allowed'), '');
    assert.equal(normalizeBadgeLabel(''), '');
});

test('buildImageTransformations stays non-destructive and includes optional overlay', () => {
    const transformations = buildImageTransformations({
        shouldRemoveBg: true,
        bgColor: 'white',
        watermarkText: 'my shop',
        badgeLabel: 'sale'
    });

    assert.equal(transformations[0].effect, 'background_removal');
    assert.equal(transformations[1].effect, 'improve');
    assert.ok(transformations.some((step) => step.overlay && step.overlay.text === 'MY SHOP'));
    assert.equal(transformations.some((step) => step.crop === 'limit'), false);
    assert.equal(transformations.some((step) => step.effect === 'trim:12'), false);
});

test('buildProductLink appends media and optional params', () => {
    const link = buildProductLink({
        protocol: 'https',
        host: 'example.com',
        publicId: 'abc123',
        price: '25000',
        bgColor: 'white',
        removeBg: true,
        badgeLabel: 'new',
        mediaType: 'video'
    });

    assert.ok(link.startsWith('https://example.com/p/abc123?'));
    assert.ok(link.includes('price=25000'));
    assert.ok(link.includes('bg=white'));
    assert.ok(link.includes('rm=true'));
    assert.ok(link.includes('badge=NEW'));
    assert.ok(link.includes('mt=video'));
});

test('buildVideoAnimatedPreviewUrl uses animated webp options', () => {
    const cloudinary = mockCloudinary();
    const raw = buildVideoAnimatedPreviewUrl(cloudinary, 'vid_1');
    const payload = JSON.parse(raw);

    assert.equal(payload.publicId, 'vid_1');
    assert.equal(payload.options.resource_type, 'video');
    assert.equal(payload.options.format, 'webp');
    assert.equal(payload.options.transformation[1].flags, 'awebp');
});

test('buildVideoOgPreviewUrl uses jpg fallback options', () => {
    const cloudinary = mockCloudinary();
    const raw = buildVideoOgPreviewUrl(cloudinary, 'vid_2');
    const payload = JSON.parse(raw);

    assert.equal(payload.publicId, 'vid_2');
    assert.equal(payload.options.resource_type, 'video');
    assert.equal(payload.options.format, 'jpg');
    assert.equal(payload.options.transformation[0].start_offset, '1');
});

test('buildImagePreviewUrl applies delivery-only limit framing and quality', () => {
    const cloudinary = mockCloudinary();
    const raw = buildImagePreviewUrl(cloudinary, {
        publicId: 'img_1',
        bgColor: 'black',
        removeBg: true,
        badgeLabel: 'sale'
    });
    const payload = JSON.parse(raw);
    const steps = payload.options.transformation;

    assert.equal(payload.options.resource_type, 'image');
    assert.equal(steps.length, 2);
    assert.equal(steps[0].crop, 'limit');
    assert.equal(steps[0].width, 1080);
    assert.equal(steps[0].height, 1920);
    assert.equal(steps[0].background, 'black');
    assert.deepEqual(steps[steps.length - 1], {
        quality: 'auto:best',
        fetch_format: 'auto',
        dpr: 'auto'
    });
});
