/**
 * Media pipeline helpers for Cloudinary transformations and share links.
 */
const ALLOWED_BADGES = new Set(['', 'NEW', 'SALE', 'LIMITED', 'SOLD OUT']);
const IMAGE_CARD_WIDTH = 1080;
const IMAGE_CARD_HEIGHT = 1920;
const IMAGE_CROP_MODE = 'limit';

function normalizeBadgeLabel(value) {
    const label = String(value || '').trim().toUpperCase();
    return ALLOWED_BADGES.has(label) ? label : '';
}

function buildImageTransformations({ shouldRemoveBg, bgColor, watermarkText, badgeLabel }) {
    const transformations = [];
    const safeBg = bgColor || 'white';
    const safeWatermark = String(watermarkText || '').trim();
    void badgeLabel;

    if (shouldRemoveBg) transformations.push({ effect: 'background_removal' });

    // Keep upload-time transforms non-destructive (no crop/resize).
    transformations.push({ effect: 'improve' });

    if (safeWatermark) {
        transformations.push({
            overlay: {
                font_family: 'Arial',
                font_size: 40,
                font_weight: 'bold',
                text: safeWatermark.toUpperCase()
            },
            color: safeBg === 'white' ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.5)',
            gravity: 'south_east',
            x: 25,
            y: 25
        });
    }
    return transformations;
}

function buildVideoAnimatedPreviewUrl(cloudinary, publicId) {
    return cloudinary.url(publicId, {
        resource_type: 'video',
        format: 'webp',
        transformation: [
            { width: 800, height: 1200, crop: 'fill', gravity: 'auto', start_offset: '0', duration: '3' },
            { quality: 'auto:good', flags: 'awebp' }
        ]
    });
}

function buildVideoOgPreviewUrl(cloudinary, publicId) {
    return cloudinary.url(publicId, {
        resource_type: 'video',
        format: 'jpg',
        transformation: [
            { width: 1200, height: 1200, crop: 'fill', gravity: 'auto', start_offset: '1' },
            { quality: 'auto:good' }
        ]
    });
}

function buildImagePreviewUrl(cloudinary, { publicId, bgColor = 'white' }) {
    // Source asset is already transformed at upload time.
    // Keep preview delivery lightweight and avoid forcing extra crop/zoom.
    const transformations = [
        {
            width: IMAGE_CARD_WIDTH,
            height: IMAGE_CARD_HEIGHT,
            crop: IMAGE_CROP_MODE,
            background: bgColor || 'white'
        },
        { quality: 'auto:best', fetch_format: 'auto', dpr: 'auto' }
    ];

    return cloudinary.url(publicId, {
        resource_type: 'image',
        transformation: transformations
    });
}

function buildProductLink({
    protocol,
    host,
    publicId,
    price,
    bgColor,
    removeBg,
    badgeLabel,
    mediaType,
    storeSlug
}) {
    const params = new URLSearchParams({
        price: price || 'Contact for Price',
        bg: bgColor || 'white',
        mt: mediaType === 'video' ? 'video' : 'image'
    });

    if (removeBg) params.set('rm', 'true');
    const safeBadge = normalizeBadgeLabel(badgeLabel);
    if (safeBadge) params.set('badge', safeBadge);
    if (storeSlug) params.set('store', String(storeSlug).trim().toLowerCase());

    return `${protocol}://${host}/p/${publicId}?${params.toString()}`;
}

module.exports = {
    normalizeBadgeLabel,
    buildImageTransformations,
    buildVideoAnimatedPreviewUrl,
    buildVideoOgPreviewUrl,
    buildImagePreviewUrl,
    buildProductLink
};
