/**
 * Media pipeline helpers for Cloudinary transformations and share links.
 */
const ALLOWED_BADGES = new Set(['', 'NEW', 'SALE', 'LIMITED', 'SOLD OUT']);

function normalizeBadgeLabel(value) {
    const label = String(value || '').trim().toUpperCase();
    return ALLOWED_BADGES.has(label) ? label : '';
}

function buildBadgeTextOverlay(label) {
    return {
        overlay: {
            font_family: 'Arial',
            font_size: 44,
            font_weight: 'bold',
            text: label
        },
        color: 'rgb:ff4d4f',
        gravity: 'north_west',
        x: 56,
        y: 74
    };
}

function buildImageTransformations({ shouldRemoveBg, bgColor, watermarkText, badgeLabel }) {
    const transformations = [];
    const safeBg = bgColor || 'white';
    const safeWatermark = String(watermarkText || '').trim();
    const safeBadge = normalizeBadgeLabel(badgeLabel);

    if (shouldRemoveBg) transformations.push({ effect: 'background_removal' });

    // Cloudinary "improve" gives an instant quality boost for typical phone photos.
    transformations.push({ effect: 'improve' });
    transformations.push({ width: 800, height: 1200, crop: 'pad', background: safeBg });

    if (safeBadge) {
        transformations.push(buildBadgeTextOverlay(safeBadge));
    }

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

    transformations.push({ quality: 'auto:best', fetch_format: 'jpg', dpr: '2.0' });
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

function buildImagePreviewUrl(cloudinary, { publicId, bgColor = 'white', removeBg = false, badgeLabel = '' }) {
    const transformations = [];
    if (removeBg) transformations.push({ effect: 'background_removal' });
    transformations.push({ effect: 'improve' });
    // Keep portrait ratio to match the swipe card viewport and avoid side-cropping badge text.
    transformations.push({ width: 800, height: 1200, crop: 'pad', background: bgColor });
    const safeBadge = normalizeBadgeLabel(badgeLabel);
    if (safeBadge) transformations.push(buildBadgeTextOverlay(safeBadge));
    transformations.push({ quality: 'auto:best', fetch_format: 'jpg', dpr: '2.0' });

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
    mediaType
}) {
    const params = new URLSearchParams({
        price: price || 'Contact for Price',
        bg: bgColor || 'white',
        mt: mediaType === 'video' ? 'video' : 'image'
    });

    if (removeBg) params.set('rm', 'true');
    const safeBadge = normalizeBadgeLabel(badgeLabel);
    if (safeBadge) params.set('badge', safeBadge);

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
