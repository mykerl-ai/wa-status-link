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

function buildMonogramSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <defs>
    <linearGradient id="bgA" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
  </defs>
  <rect x="80" y="80" width="864" height="864" rx="220" fill="url(#bgA)"/>
  <circle cx="512" cy="436" r="208" fill="#ffffff" fill-opacity="0.14"/>
  <text x="512" y="472" text-anchor="middle" fill="#f8fafc" font-family="Outfit, Poppins, Arial, sans-serif" font-size="226" font-weight="700" letter-spacing="8">${initials}</text>
  <text x="512" y="784" text-anchor="middle" fill="#e2e8f0" font-family="Outfit, Poppins, Arial, sans-serif" font-size="66" font-weight="500" letter-spacing="2">${safeName}</text>
</svg>`;
}

function buildWordmarkSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <rect x="78" y="236" width="868" height="552" rx="118" fill="#f8fafc"/>
  <rect x="78.5" y="236.5" width="867" height="551" rx="117.5" fill="none" stroke="#cbd5e1" stroke-width="3"/>
  <rect x="154" y="336" width="164" height="164" rx="40" fill="#111827"/>
  <text x="236" y="438" text-anchor="middle" fill="#f9fafb" font-family="Outfit, Poppins, Arial, sans-serif" font-size="78" font-weight="700">${initials}</text>
  <text x="512" y="450" text-anchor="middle" fill="#0f172a" font-family="Outfit, Poppins, Arial, sans-serif" font-size="80" font-weight="700" letter-spacing="1">${safeName}</text>
  <line x1="230" y1="534" x2="794" y2="534" stroke="#334155" stroke-width="10" stroke-linecap="round"/>
  <text x="512" y="608" text-anchor="middle" fill="#475569" font-family="Outfit, Poppins, Arial, sans-serif" font-size="40" font-weight="500" letter-spacing="5">OFFICIAL STORE</text>
</svg>`;
}

function buildSealSvg(businessName) {
    const safeName = escapeSvgText(sanitizeBusinessName(businessName));
    const initials = escapeSvgText(getBusinessInitials(businessName));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${safeName}">
  <defs>
    <radialGradient id="bgB" cx="30%" cy="20%" r="90%">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </radialGradient>
  </defs>
  <rect x="88" y="88" width="848" height="848" rx="184" fill="url(#bgB)"/>
  <rect x="88.5" y="88.5" width="847" height="847" rx="183.5" fill="none" stroke="#94a3b8" stroke-width="3"/>
  <circle cx="512" cy="438" r="206" fill="#0f172a"/>
  <circle cx="512" cy="438" r="170" fill="none" stroke="#38bdf8" stroke-width="14"/>
  <text x="512" y="470" text-anchor="middle" fill="#f8fafc" font-family="Outfit, Poppins, Arial, sans-serif" font-size="190" font-weight="700" letter-spacing="6">${initials}</text>
  <text x="512" y="760" text-anchor="middle" fill="#0f172a" font-family="Outfit, Poppins, Arial, sans-serif" font-size="68" font-weight="700" letter-spacing="2">${safeName}</text>
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
