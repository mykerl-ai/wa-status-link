/**
 * Media pipeline helpers for Cloudinary transformations and share links.
 */
const ALLOWED_BADGES = new Set(['', 'NEW', 'SALE', 'LIMITED', 'SOLD OUT']);
const IMAGE_CARD_WIDTH = 1080;
const IMAGE_CARD_HEIGHT = 1920;
const IMAGE_CROP_MODE = 'limit';

function toCloudinaryOverlayPublicId(publicId) {
    const raw = String(publicId || '')
        .trim()
        .replace(/^\/+|\/+$/g, '');
    if (!raw) return '';
    // Cloudinary overlay public_id segments should be colon-delimited in transformation strings.
    return raw.split('/').filter(Boolean).join(':');
}

function normalizeBadgeLabel(value) {
    const label = String(value || '').trim().toUpperCase();
    return ALLOWED_BADGES.has(label) ? label : '';
}

function buildImageTransformations({ shouldRemoveBg, bgColor, badgeLabel, logoPublicId }) {
    const transformations = [];
    const safeLogoPublicId = toCloudinaryOverlayPublicId(logoPublicId);
    void badgeLabel;

    if (shouldRemoveBg) transformations.push({ effect: 'background_removal' });

    // Keep upload-time transforms non-destructive (no crop/resize).
    transformations.push({ effect: 'improve' });

    if (safeLogoPublicId) {
        // Build overlay in explicit layer-apply stages for parser stability.
        transformations.push({
            overlay: safeLogoPublicId
        });
        transformations.push({
            width: 64,
            crop: 'fit',
            opacity: 90
        });
        transformations.push({
            flags: 'layer_apply',
            gravity: 'north_east',
            x: 10,
            y: 8
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

function buildLogoOverlaySteps(logoPublicId) {
    const safeLogoPublicId = toCloudinaryOverlayPublicId(logoPublicId);
    if (!safeLogoPublicId) return [];
    return [
        { overlay: safeLogoPublicId },
        { width: 170, crop: 'fit', opacity: 95 },
        { flags: 'layer_apply', gravity: 'north_west', x: 28, y: 28 }
    ];
}

function buildVideoOgPreviewUrl(cloudinary, publicId, { logoPublicId = '' } = {}) {
    const logoOverlaySteps = buildLogoOverlaySteps(logoPublicId);
    const transformations = [
        { width: 1200, height: 1200, crop: 'fill', gravity: 'auto', start_offset: '1' }
    ];
    if (logoOverlaySteps.length) transformations.push(...logoOverlaySteps);
    transformations.push({ quality: 'auto:good' });

    return cloudinary.url(publicId, {
        resource_type: 'video',
        format: 'jpg',
        transformation: transformations
    });
}

function buildImagePreviewUrl(cloudinary, { publicId, bgColor = 'white', ogSquare = false, logoPublicId = '' }) {
    const logoOverlaySteps = buildLogoOverlaySteps(logoPublicId);
    // Source asset is already transformed at upload time.
    // Keep preview delivery lightweight and avoid forcing extra crop/zoom.
    const transformations = [];
    if (ogSquare) {
        transformations.push({
            width: 1200,
            height: 1200,
            crop: 'fill',
            gravity: 'auto'
        });
    } else {
        transformations.push({
            width: IMAGE_CARD_WIDTH,
            height: IMAGE_CARD_HEIGHT,
            crop: IMAGE_CROP_MODE,
            background: bgColor || 'white'
        });
    }
    if (logoOverlaySteps.length) transformations.push(...logoOverlaySteps);
    transformations.push({ quality: 'auto:best', fetch_format: 'auto', dpr: 'auto' });

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
