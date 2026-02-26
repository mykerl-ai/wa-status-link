/**
 * Store branding logo generator.
 * Produces three clean SVG logo variants from a business name.
 */
const BUSINESS_NAME_MAX_LENGTH = 64;

function sanitizeBusinessName(input) {
    const cleaned = String(input || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, BUSINESS_NAME_MAX_LENGTH);
    return cleaned || 'My Business';
}

function escapeSvgText(input) {
    return String(input || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getBusinessInitials(input) {
    const words = sanitizeBusinessName(input)
        .split(' ')
        .filter(Boolean);
    if (words.length === 0) return 'MB';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

function initialsFontSize(initials) {
    return String(initials || '').length > 1 ? 300 : 360;
}

function buildMonogramSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    const fontSize = initialsFontSize(initials);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <defs>
    <linearGradient id="bgA" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1f2937"/>
    </linearGradient>
  </defs>
  <rect x="92" y="92" width="840" height="840" rx="212" fill="url(#bgA)"/>
  <circle cx="512" cy="512" r="276" fill="#ffffff" fill-opacity="0.12"/>
  <text x="512" y="610" text-anchor="middle" fill="#f8fafc" font-family="Outfit, Poppins, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="6">${initials}</text>
</svg>`;
}

function buildWordmarkSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    const fontSize = initialsFontSize(initials) - 22;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <defs>
    <linearGradient id="bgB" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
    <linearGradient id="accentB" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect x="92" y="92" width="840" height="840" rx="198" fill="url(#bgB)"/>
  <rect x="164" y="164" width="696" height="696" rx="168" fill="#0b1220"/>
  <circle cx="776" cy="248" r="58" fill="url(#accentB)"/>
  <text x="512" y="614" text-anchor="middle" fill="#f8fafc" font-family="Outfit, Poppins, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="6">${initials}</text>
</svg>`;
}

function buildSealSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    const fontSize = initialsFontSize(initials) - 16;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <defs>
    <radialGradient id="bgC" cx="24%" cy="18%" r="88%">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e5e7eb"/>
    </radialGradient>
  </defs>
  <rect x="92" y="92" width="840" height="840" rx="210" fill="url(#bgC)"/>
  <circle cx="512" cy="512" r="292" fill="#111827"/>
  <circle cx="512" cy="512" r="246" fill="none" stroke="#22d3ee" stroke-width="22"/>
  <circle cx="512" cy="512" r="174" fill="#0b1220"/>
  <text x="512" y="612" text-anchor="middle" fill="#f8fafc" font-family="Outfit, Poppins, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="6">${initials}</text>
</svg>`;
}

function buildLogoVariants(inputBusinessName) {
    const businessName = sanitizeBusinessName(inputBusinessName);
    return [
        {
            variantKey: 'monogram',
            variantName: 'Monogram',
            businessName,
            svg: buildMonogramSvg(businessName)
        },
        {
            variantKey: 'wordmark',
            variantName: 'Wordmark',
            businessName,
            svg: buildWordmarkSvg(businessName)
        },
        {
            variantKey: 'seal',
            variantName: 'Seal',
            businessName,
            svg: buildSealSvg(businessName)
        }
    ];
}

module.exports = {
    sanitizeBusinessName,
    getBusinessInitials,
    buildLogoVariants
};
