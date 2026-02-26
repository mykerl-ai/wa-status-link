const test = require('node:test');
const assert = require('node:assert/strict');
const {
    sanitizeBusinessName,
    getBusinessInitials,
    buildLogoVariants
} = require('../lib/LogoGenerator');

test('sanitizeBusinessName trims and normalizes whitespace', () => {
    const value = sanitizeBusinessName('   My   Fancy   Store   ');
    assert.equal(value, 'My Fancy Store');
});

test('getBusinessInitials builds stable initials', () => {
    assert.equal(getBusinessInitials('Lite Box'), 'LB');
    assert.equal(getBusinessInitials('Litebox'), 'LI');
});

test('buildLogoVariants returns three escaped variants', () => {
    const variants = buildLogoVariants('Rhee <Store>');
    assert.equal(Array.isArray(variants), true);
    assert.equal(variants.length, 3);
    assert.deepEqual(
        variants.map((v) => v.variantKey),
        ['monogram', 'wordmark', 'seal']
    );
    assert.equal(variants.every((v) => typeof v.svg === 'string' && v.svg.startsWith('<svg')), true);
    assert.equal(variants.every((v) => v.businessName === 'Rhee <Store>'), true);
    assert.equal(variants.every((v) => !v.svg.includes('<Store>')), true);
});
