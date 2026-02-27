const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const http = require('http');
const https = require('https');

const { createClient } = require('@supabase/supabase-js');
const { PaystackService } = require('./lib/PaystackService');
const { OrderService } = require('./lib/OrderService');
const { ProductService } = require('./lib/ProductService');
const { CategoryService } = require('./lib/CategoryService');
const { VideoJobQueue } = require('./lib/VideoJobQueue');
const { buildLogoVariants, sanitizeBusinessName } = require('./lib/LogoGenerator');
const {
    normalizeBadgeLabel,
    buildImageTransformations,
    buildProductLink,
    buildVideoAnimatedPreviewUrl,
    buildVideoOgPreviewUrl,
    buildImagePreviewUrl
} = require('./lib/MediaPipeline');

const app = express();
const upload = multer({
    dest: 'uploads/',
    limits: {
        files: 80,
        fieldSize: 5 * 1024 * 1024,
        fileSize: 350 * 1024 * 1024
    }
});
dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL || 'https://jfsqdzfeqgfmmkfzhrmq.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseKey = supabaseServiceKey || supabaseAnonKey || '';
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
if (supabase) {
    console.log('[Supabase] Using ' + (supabaseServiceKey ? 'SERVICE_KEY (bypasses RLS)' : 'ANON_KEY (RLS applies)'));
}

const paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';
const paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';
const paystackService = paystackSecret ? new PaystackService(paystackSecret) : null;
const orderService = supabase ? new OrderService(supabase) : null;
const productService = supabase ? new ProductService(supabase) : null;
const categoryService = supabase ? new CategoryService(supabase) : null;
const videoJobQueue = productService && categoryService
    ? new VideoJobQueue({
        cloudinary: (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) ? cloudinary : null,
        productService: productService,
        categoryService: categoryService,
        outputDir: path.join(__dirname, 'uploads', 'videos')
    })
    : null;

// 1. CLOUDINARY CONFIG
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_NAME', 
    api_key: process.env.CLOUDINARY_API_KEY || 'YOUR_KEY', 
    api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_SECRET' 
});

// 2. EXPRESS CONFIG
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const AUTH_COOKIE = 'sb-access-token';
const STORE_COOKIE = 'store';
const COOKIE_OPTS = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
const STORE_COOKIE_OPTS = { httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
const STORE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_VIDEO_AUDIO_URL = String(process.env.DEFAULT_VIDEO_AUDIO_URL || '').trim();
const NAIJA_AUDIO_CACHE_TTL_MS = 10 * 60 * 1000;
const NAIJA_AUDIO_DEFAULT_LIMIT = 12;
const ITUNES_NG_TOP_SONGS_URL = 'https://itunes.apple.com/ng/rss/topsongs/limit=100/json';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const NAIJA_AUDIO_SEARCH_SEEDS = [
    'Davido',
    'Burna Boy',
    'Wizkid',
    'Asake',
    'Rema',
    'Ayra Starr',
    'Tems',
    'Seyi Vibez',
    'Omah Lay',
    'Shallipopi'
];
const NOSTALGIA_2010S_SEARCH_SEEDS = [
    'Flo Rida Good Feeling',
    'Chris Brown Yeah 3x',
    'Chris Brown Forever',
    'Pitbull Give Me Everything',
    'Usher DJ Got Us Fallin In Love',
    'Rihanna We Found Love',
    'LMFAO Party Rock Anthem',
    'Drake Headlines',
    'Bruno Mars Grenade',
    'Calvin Harris Summer'
];
const PINNED_THROWBACK_SEEDS = [
    'Flo Rida Good Feeling',
    'Flo Rida - Good Feeling',
    'Good Feeling Flo Rida'
];
const PINNED_THROWBACK_TRACK_MATCH = {
    titleIncludes: 'good feeling',
    artistIncludes: 'flo rida'
};
const PINNED_THROWBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STORE_SELECT_COLUMNS = 'id, owner_id, slug, name, logo_public_id, logo_url';
const STORE_SELECT_COLUMNS_LEGACY = 'id, owner_id, slug, name';
const OWNER_LOGOS_FETCH_LIMIT = 36;
const LARGE_VIDEO_UPLOAD_THRESHOLD_BYTES = 40 * 1024 * 1024;
let naijaAudioCache = {
    key: '',
    expiresAt: 0,
    payload: {
        source: 'Apple Music Nigeria Charts',
        updatedAt: '',
        hottestTracks: [],
        latestTracks: [],
        nostalgicTracks: []
    }
};
let pinnedThrowbackTrackCache = {
    expiresAt: 0,
    track: null
};

const VIDEO_TRANSITION_ALIASES = {
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

function sanitizeRedirectPath(input, fallback = '/products') {
    const raw = String(input || '').trim();
    if (!raw) return fallback;
    if (!raw.startsWith('/')) return fallback;
    if (raw.startsWith('//')) return fallback;
    return raw;
}

function sanitizeStoreSlug(input) {
    const slug = String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    if (!slug || !STORE_SLUG_RE.test(slug)) return '';
    return slug;
}

function clampNumber(input, { fallback, min, max }) {
    const n = Number(input);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function sanitizeVideoTransitionType(input) {
    const raw = String(input || '').trim().toLowerCase();
    return VIDEO_TRANSITION_ALIASES[raw] || 'fade';
}

function sanitizeVideoAudioUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function normalizeTextValue(input) {
    if (Array.isArray(input)) return normalizeTextValue(input[0]);
    if (input == null) return '';
    return String(input).trim();
}

function parseMoneyNumber(input) {
    if (input == null) return null;
    const raw = String(input).trim();
    if (!raw) return null;
    const cleaned = raw
        .replace(/[, ]+/g, '')
        .replace(/[^\d.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

function formatNairaValue(input) {
    const n = typeof input === 'number' ? input : parseMoneyNumber(input);
    if (!Number.isFinite(n) || n <= 0) return '';
    const hasDecimals = Math.abs(n - Math.round(n)) > 0.0001;
    return '₦' + n.toLocaleString('en-NG', {
        minimumFractionDigits: 0,
        maximumFractionDigits: hasDecimals ? 2 : 0
    });
}

function normalizePriceLabel(input, fallback = 'Contact for Price') {
    const raw = normalizeTextValue(input);
    if (!raw) return fallback;
    const maybeNumber = parseMoneyNumber(raw);
    if (maybeNumber == null) return raw;
    return formatNairaValue(maybeNumber);
}

function isTruthyFlag(input) {
    const raw = String(input || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function requestJsonWithTimeout(url, timeoutMs = 12000, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const handleError = (err) => {
            if (finished) return;
            finished = true;
            reject(err);
        };
        const handleSuccess = (value) => {
            if (finished) return;
            finished = true;
            resolve(value);
        };

        function requestOne(requestUrl, remainingRedirects) {
            const parsed = new URL(requestUrl);
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.get(parsed, {
                headers: {
                    'User-Agent': 'WaStatusLink/1.0',
                    Accept: 'application/json'
                }
            }, (res) => {
                const status = Number(res.statusCode || 0);
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (remainingRedirects <= 0) {
                        return handleError(new Error('Too many redirects'));
                    }
                    const nextUrl = new URL(res.headers.location, requestUrl).toString();
                    return requestOne(nextUrl, remainingRedirects - 1);
                }
                if (status !== 200) {
                    res.resume();
                    return handleError(new Error(`HTTP ${status}`));
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        handleSuccess(JSON.parse(body));
                    } catch {
                        handleError(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', handleError);
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error('Request timeout'));
            });
        }

        requestOne(url, redirectsLeft);
    });
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
}

function parseReleaseDateMs(input) {
    const t = Date.parse(String(input || ''));
    return Number.isFinite(t) ? t : 0;
}

function parseReleaseYear(input) {
    const ms = parseReleaseDateMs(input);
    if (!ms) return null;
    const year = new Date(ms).getUTCFullYear();
    return Number.isFinite(year) ? year : null;
}

function parseDurationSeconds(input) {
    const raw = normalizeTextValue(input);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1000) return Math.round(n / 1000);
    return Math.round(n);
}

function maximizeArtwork(url) {
    const raw = normalizeTextValue(url);
    if (!raw) return '';
    return raw.replace(/\/\d+x\d+bb\.(png|jpg)$/i, '/600x600bb.$1');
}

function extractPreviewFromEntry(entry) {
    const links = asArray(entry?.link);
    for (const link of links) {
        const attrs = link?.attributes || {};
        if (attrs.rel === 'enclosure' && normalizeTextValue(attrs.href)) {
            return {
                previewUrl: normalizeTextValue(attrs.href),
                durationSeconds: parseDurationSeconds(link?.['im:duration']?.label)
            };
        }
    }
    return { previewUrl: '', durationSeconds: null };
}

function mapItunesTopSongEntry(entry, rankIndex) {
    const previewMeta = extractPreviewFromEntry(entry);
    const previewUrl = sanitizeVideoAudioUrl(previewMeta.previewUrl);
    if (!previewUrl) return null;

    const id = normalizeTextValue(entry?.id?.attributes?.['im:id']) || previewUrl;
    const title = normalizeTextValue(entry?.['im:name']?.label) || 'Untitled';
    const artist = normalizeTextValue(entry?.['im:artist']?.label) || 'Unknown artist';
    const album = normalizeTextValue(entry?.['im:collection']?.['im:name']?.label);
    const pageUrl = normalizeTextValue(entry?.id?.label);
    const releaseDate = normalizeTextValue(entry?.['im:releaseDate']?.label);
    const releaseYear = parseReleaseYear(releaseDate);
    const images = asArray(entry?.['im:image']);
    const artworkCandidate = images.length ? normalizeTextValue(images[images.length - 1]?.label) : '';
    const artworkUrl = maximizeArtwork(artworkCandidate);

    return {
        id,
        title,
        artist,
        album,
        previewUrl,
        artworkUrl,
        pageUrl,
        releaseDate,
        releaseYear,
        releaseDateMs: parseReleaseDateMs(releaseDate),
        durationSeconds: previewMeta.durationSeconds,
        rank: rankIndex + 1,
        source: 'Apple Music Nigeria Charts'
    };
}

function mapItunesSearchTrack(item, fallbackRank = 9999, sourceLabel = 'iTunes Search') {
    const previewUrl = sanitizeVideoAudioUrl(item?.previewUrl || '');
    if (!previewUrl) return null;

    const releaseDate = normalizeTextValue(item?.releaseDate);
    const releaseYear = parseReleaseYear(releaseDate);
    const id = normalizeTextValue(item?.trackId || item?.collectionId) || previewUrl;
    return {
        id,
        title: normalizeTextValue(item?.trackName) || normalizeTextValue(item?.collectionName) || 'Untitled',
        artist: normalizeTextValue(item?.artistName) || 'Unknown artist',
        album: normalizeTextValue(item?.collectionName),
        previewUrl,
        artworkUrl: maximizeArtwork(normalizeTextValue(item?.artworkUrl100 || item?.artworkUrl60 || item?.artworkUrl30)),
        pageUrl: normalizeTextValue(item?.trackViewUrl || item?.collectionViewUrl || item?.artistViewUrl),
        releaseDate,
        releaseYear,
        releaseDateMs: parseReleaseDateMs(releaseDate),
        durationSeconds: parseDurationSeconds(item?.trackTimeMillis),
        rank: fallbackRank,
        source: sourceLabel
    };
}

async function fetchItunesSearchTracks(term, limit = 30, options = {}) {
    const country = normalizeTextValue(options.country || 'NG').toUpperCase() || 'NG';
    const sourceLabel = normalizeTextValue(options.source || 'iTunes Search') || 'iTunes Search';
    const query = normalizeTextValue(term);
    if (!query) return [];
    const url = new URL(ITUNES_SEARCH_URL);
    url.searchParams.set('term', query);
    url.searchParams.set('country', country);
    url.searchParams.set('entity', 'song');
    url.searchParams.set('limit', String(Math.max(5, Math.min(50, Math.round(Number(limit) || 30)))));

    const data = await requestJsonWithTimeout(url.toString(), 15000);
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
        .map((item, idx) => mapItunesSearchTrack(item, 2000 + idx, sourceLabel))
        .filter(Boolean);
}

function dedupeTracks(tracks) {
    const out = [];
    const seen = new Set();
    for (const track of tracks) {
        if (!track) continue;
        const key = track.id || track.previewUrl;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(track);
    }
    return out;
}

function filterTracksByQuery(tracks, query) {
    const tokens = String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);
    if (!tokens.length) return tracks;

    return tracks.filter((track) => {
        const haystack = `${track.title || ''} ${track.artist || ''} ${track.album || ''}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
    });
}

function toPublicTrack(track, mode) {
    return {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        previewUrl: track.previewUrl,
        artworkUrl: track.artworkUrl,
        pageUrl: track.pageUrl,
        releaseDate: track.releaseDate,
        releaseYear: track.releaseYear,
        durationSeconds: track.durationSeconds,
        rank: mode === 'hottest' ? track.rank : undefined,
        source: track.source
    };
}

function is2010sTrack(track) {
    const year = Number(track?.releaseYear || 0);
    return year >= 2010 && year <= 2019;
}

function isTrackMatch(track, match = {}) {
    if (!track) return false;
    const titleNeedle = normalizeTextValue(match.titleIncludes).toLowerCase();
    const artistNeedle = normalizeTextValue(match.artistIncludes).toLowerCase();
    const title = normalizeTextValue(track.title).toLowerCase();
    const artist = normalizeTextValue(track.artist).toLowerCase();
    const titleOk = !titleNeedle || title.includes(titleNeedle);
    const artistOk = !artistNeedle || artist.includes(artistNeedle);
    return titleOk && artistOk;
}

function prependUniqueTrack(tracks, track, maxItems) {
    const list = Array.isArray(tracks) ? tracks : [];
    if (!track) return list.slice(0, maxItems || list.length);
    const key = track.id || track.previewUrl;
    const deduped = list.filter((item) => (item.id || item.previewUrl) !== key);
    const merged = [track, ...deduped];
    if (!maxItems || maxItems <= 0) return merged;
    return merged.slice(0, maxItems);
}

async function getPinnedThrowbackTrack({ refresh = false } = {}) {
    if (!refresh && pinnedThrowbackTrackCache.expiresAt > Date.now()) {
        return pinnedThrowbackTrackCache.track;
    }

    for (const term of PINNED_THROWBACK_SEEDS) {
        try {
            const tracks = await fetchItunesSearchTracks(term, 20, {
                country: 'US',
                source: 'Featured Throwback'
            });
            if (!tracks.length) continue;
            const exact = tracks.find((track) => isTrackMatch(track, PINNED_THROWBACK_TRACK_MATCH));
            const selected = exact || tracks[0];
            if (selected) {
                pinnedThrowbackTrackCache = {
                    expiresAt: Date.now() + PINNED_THROWBACK_CACHE_TTL_MS,
                    track: selected
                };
                return selected;
            }
        } catch {
            // continue trying fallback seed terms
        }
    }

    pinnedThrowbackTrackCache = {
        expiresAt: Date.now() + (30 * 60 * 1000),
        track: null
    };
    return null;
}

async function fetchNaijaAudioTracks({ limit = NAIJA_AUDIO_DEFAULT_LIMIT, query = '', refresh = false } = {}) {
    const safeLimit = Math.max(6, Math.min(25, Math.round(Number(limit) || NAIJA_AUDIO_DEFAULT_LIMIT)));
    const normalizedQuery = String(query || '').trim().toLowerCase().slice(0, 80);
    const cacheKey = `${safeLimit}:${normalizedQuery}`;

    if (!refresh && naijaAudioCache.key === cacheKey && naijaAudioCache.expiresAt > Date.now()) {
        return naijaAudioCache.payload;
    }

    let mappedTracks = [];
    const sourceSet = new Set();

    try {
        const rssJson = await requestJsonWithTimeout(ITUNES_NG_TOP_SONGS_URL, 15000);
        const entries = asArray(rssJson?.feed?.entry);
        const rssTracks = entries.map((entry, idx) => mapItunesTopSongEntry(entry, idx)).filter(Boolean);
        if (rssTracks.length) {
            mappedTracks.push(...rssTracks);
            sourceSet.add('Apple Music Nigeria Charts');
        }
    } catch {
        // Fallback sources below will still try to provide tracks.
    }

    const searchTerms = [];
    if (normalizedQuery) {
        searchTerms.push(normalizedQuery);
        searchTerms.push(`${normalizedQuery} nigeria`);
        searchTerms.push(`${normalizedQuery} afrobeats`);
    } else {
        searchTerms.push('nigeria top songs');
        searchTerms.push('afrobeats 2026');
        searchTerms.push(...NAIJA_AUDIO_SEARCH_SEEDS);
    }

    const searchLimit = Math.max(12, safeLimit * 2);
    for (const term of searchTerms) {
        if (mappedTracks.length >= (safeLimit * 5)) break;
        try {
            const searchTracks = await fetchItunesSearchTracks(term, searchLimit, { country: 'NG' });
            if (searchTracks.length) {
                mappedTracks.push(...searchTracks);
                sourceSet.add('iTunes Search');
            }
        } catch {
            // continue with other terms
        }
    }

    mappedTracks = dedupeTracks(mappedTracks);
    let filtered = filterTracksByQuery(mappedTracks, normalizedQuery);
    if (normalizedQuery && filtered.length === 0) {
        filtered = mappedTracks;
    }
    if (!filtered.length) {
        throw new Error('No songs available right now.');
    }

    let nostalgicPool = [...mappedTracks];
    let nostalgicFetchedCount = 0;
    const nostalgiaTerms = normalizedQuery
        ? [
            `${normalizedQuery} 2010s`,
            `${normalizedQuery} throwback`,
            `${normalizedQuery} chris brown`,
            `${normalizedQuery} flo rida`
        ]
        : NOSTALGIA_2010S_SEARCH_SEEDS;
    for (const term of nostalgiaTerms) {
        if (nostalgicFetchedCount >= (safeLimit * 3)) break;
        try {
            const throwbackTracks = await fetchItunesSearchTracks(term, searchLimit, {
                country: 'US',
                source: 'iTunes Search (2010s Throwback)'
            });
            if (throwbackTracks.length) {
                nostalgicPool.push(...throwbackTracks);
                nostalgicFetchedCount += throwbackTracks.length;
                sourceSet.add('iTunes Search (2010s Throwback)');
            }
        } catch {
            // keep trying remaining nostalgia terms
        }
    }
    nostalgicPool = dedupeTracks(nostalgicPool);
    let nostalgicFiltered = nostalgicPool.filter((track) => is2010sTrack(track));
    if (normalizedQuery) {
        const strictNostalgia = filterTracksByQuery(nostalgicFiltered, normalizedQuery);
        if (strictNostalgia.length) {
            nostalgicFiltered = strictNostalgia;
        }
    }
    if (!nostalgicFiltered.length) {
        nostalgicFiltered = filterTracksByQuery(nostalgicPool, normalizedQuery);
    }
    if (!nostalgicFiltered.length) {
        nostalgicFiltered = nostalgicPool;
    }

    const hottestTracks = [...filtered]
        .sort((a, b) => {
            if ((a.rank || 9999) !== (b.rank || 9999)) return (a.rank || 9999) - (b.rank || 9999);
            return b.releaseDateMs - a.releaseDateMs;
        })
        .slice(0, safeLimit)
        .map((track) => toPublicTrack(track, 'hottest'));

    const latestTracks = [...filtered]
        .sort((a, b) => {
            if (b.releaseDateMs !== a.releaseDateMs) return b.releaseDateMs - a.releaseDateMs;
            return (a.rank || 9999) - (b.rank || 9999);
        })
        .slice(0, safeLimit)
        .map((track) => toPublicTrack(track, 'latest'));

    const nostalgicTracks = [...nostalgicFiltered]
        .sort((a, b) => {
            if ((b.releaseYear || 0) !== (a.releaseYear || 0)) return (b.releaseYear || 0) - (a.releaseYear || 0);
            if ((a.rank || 9999) !== (b.rank || 9999)) return (a.rank || 9999) - (b.rank || 9999);
            return b.releaseDateMs - a.releaseDateMs;
        })
        .slice(0, safeLimit)
        .map((track) => toPublicTrack(track, 'nostalgic'));

    const pinnedThrowbackTrack = await getPinnedThrowbackTrack({ refresh });
    const pinnedThrowbackPublic = pinnedThrowbackTrack
        ? toPublicTrack(
            {
                ...pinnedThrowbackTrack,
                rank: 1,
                source: 'Featured Throwback'
            },
            'nostalgic'
        )
        : null;
    const ensuredNostalgicTracks = prependUniqueTrack(nostalgicTracks, pinnedThrowbackPublic, safeLimit);

    const payload = {
        source: Array.from(sourceSet).join(' + ') || 'iTunes Search',
        updatedAt: new Date().toISOString(),
        hottestTracks,
        latestTracks,
        nostalgicTracks: ensuredNostalgicTracks
    };

    naijaAudioCache = {
        key: cacheKey,
        expiresAt: Date.now() + NAIJA_AUDIO_CACHE_TTL_MS,
        payload
    };

    return payload;
}

function slugifyStoreName(input, fallbackSeed = 'store') {
    const fromName = sanitizeStoreSlug(String(input || '').replace(/\s+/g, '-'));
    if (fromName) return fromName;
    const safeSeed = sanitizeStoreSlug(fallbackSeed) || 'store';
    return safeSeed;
}

function isUuidLike(input) {
    return UUID_RE.test(String(input || '').trim());
}

function mapStoreRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        ownerId: row.owner_id,
        slug: row.slug,
        name: row.name || '',
        logoPublicId: row.logo_public_id || '',
        logoUrl: row.logo_url || ''
    };
}

function isSchemaColumnMissing(error) {
    return String(error?.code || '') === '42703';
}

function isSchemaTableMissing(error) {
    if (String(error?.code || '') === '42P01') return true;
    return /does not exist/i.test(String(error?.message || ''));
}

function logoOnboardingPath() {
    return '/onboarding/logo';
}

function canGenerateCloudinaryAssets() {
    return Boolean(
        String(process.env.CLOUDINARY_CLOUD_NAME || '').trim()
        && String(process.env.CLOUDINARY_API_KEY || '').trim()
        && String(process.env.CLOUDINARY_API_SECRET || '').trim()
    );
}

function storePathFromSlug(storeSlug) {
    return `/s/${encodeURIComponent(storeSlug)}`;
}

function absoluteUrlFromPath(req, pathname) {
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    return `${protocol}://${host}${pathname}`;
}

function setStoreCookie(res, storeSlug) {
    if (!storeSlug) return;
    res.cookie(STORE_COOKIE, storeSlug, STORE_COOKIE_OPTS);
}

function clearStoreCookie(res) {
    res.clearCookie(STORE_COOKIE, { path: '/' });
}

function getCreateStoreHref(req) {
    if (req?.role === 'owner') return '';
    if (req?.user) return '/create-store';
    return '/signup?next=' + encodeURIComponent('/create-store');
}

function createAuthClient() {
    const authKey = supabaseAnonKey || supabaseKey;
    if (!authKey) return null;
    return createClient(supabaseUrl, authKey);
}

function getRequestSupabase(req) {
    if (!supabase) return null;
    if (supabaseServiceKey) return supabase;
    const token = req?.cookies?.[AUTH_COOKIE];
    if (!token || !supabaseAnonKey) return supabase;
    return createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        },
        global: {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    });
}

async function findStoreBySlug(storeSlug, supabaseClient = supabase) {
    if (!supabaseClient || !storeSlug) return null;
    let { data, error } = await supabaseClient
        .from('stores')
        .select(STORE_SELECT_COLUMNS)
        .eq('slug', storeSlug)
        .maybeSingle();
    if (error && isSchemaColumnMissing(error)) {
        ({ data, error } = await supabaseClient
            .from('stores')
            .select(STORE_SELECT_COLUMNS_LEGACY)
            .eq('slug', storeSlug)
            .maybeSingle());
    }
    if (error) throw error;
    return mapStoreRow(data);
}

async function findStoreByOwnerId(ownerId, supabaseClient = supabase) {
    if (!supabaseClient || !ownerId) return null;
    let { data, error } = await supabaseClient
        .from('stores')
        .select(STORE_SELECT_COLUMNS)
        .eq('owner_id', ownerId)
        .maybeSingle();
    if (error && isSchemaColumnMissing(error)) {
        ({ data, error } = await supabaseClient
            .from('stores')
            .select(STORE_SELECT_COLUMNS_LEGACY)
            .eq('owner_id', ownerId)
            .maybeSingle());
    }
    if (error) throw error;
    return mapStoreRow(data);
}

async function upsertStoreForOwner({ ownerId, storeName, storeSlug, supabaseClient = supabase }) {
    if (!supabaseClient || !ownerId) return null;

    const existing = await findStoreByOwnerId(ownerId, supabaseClient);
    const safeName = String(storeName || '').trim() || existing?.name || 'My Store';
    const safeSlug = sanitizeStoreSlug(storeSlug)
        || existing?.slug
        || slugifyStoreName(safeName, `store-${ownerId.slice(0, 8)}`);

    if (existing && existing.slug === safeSlug && existing.name === safeName) {
        return existing;
    }

    if (existing) {
        const maybeTaken = await findStoreBySlug(safeSlug, supabaseClient);
        if (maybeTaken && maybeTaken.ownerId !== ownerId) {
            throw new Error('That store link is already taken. Choose another one.');
        }
        const { data, error } = await supabaseClient
            .from('stores')
            .update({ slug: safeSlug, name: safeName })
            .eq('id', existing.id)
            .select(STORE_SELECT_COLUMNS)
            .single();
        let rowData = data;
        let rowError = error;
        if (rowError && isSchemaColumnMissing(rowError)) {
            ({ data: rowData, error: rowError } = await supabaseClient
                .from('stores')
                .update({ slug: safeSlug, name: safeName })
                .eq('id', existing.id)
                .select(STORE_SELECT_COLUMNS_LEGACY)
                .single());
        }
        if (rowError) {
            if (rowError.code === '42501') {
                throw new Error('Store update blocked by database policy. Run the latest supabase-schema.sql and retry.');
            }
            throw rowError;
        }
        return mapStoreRow(rowData);
    }

    const baseSlug = safeSlug;
    for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = attempt === 0
            ? baseSlug
            : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
        const { data, error } = await supabaseClient
            .from('stores')
            .insert({
                owner_id: ownerId,
                slug: candidate,
                name: safeName
            })
            .select(STORE_SELECT_COLUMNS)
            .single();
        let rowData = data;
        let rowError = error;
        if (rowError && isSchemaColumnMissing(rowError)) {
            ({ data: rowData, error: rowError } = await supabaseClient
                .from('stores')
                .insert({
                    owner_id: ownerId,
                    slug: candidate,
                    name: safeName
                })
                .select(STORE_SELECT_COLUMNS_LEGACY)
                .single());
        }
        if (!rowError) return mapStoreRow(rowData);
        if (rowError.code === '23505') continue;
        if (rowError.code === '42501') {
            throw new Error('Store creation blocked by database policy. Run the latest supabase-schema.sql and retry.');
        }
        throw rowError;
    }

    const fallback = await findStoreByOwnerId(ownerId, supabaseClient);
    if (fallback) return fallback;
    throw new Error('Unable to create a unique store link right now.');
}

async function ensureOwnerStore(ownerId, storeName, supabaseClient = supabase) {
    if (!ownerId) return null;
    return upsertStoreForOwner({
        ownerId,
        storeName: storeName || 'My Store',
        supabaseClient
    });
}

function toLogoVariantPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        ownerId: row.owner_id,
        storeId: row.store_id,
        businessName: row.business_name || '',
        variantKey: row.variant_key || '',
        variantName: row.variant_name || '',
        logoPublicId: row.logo_public_id || '',
        logoUrl: row.logo_url || '',
        isSelected: !!row.is_selected,
        createdAt: row.created_at || ''
    };
}

function svgToDataUri(svg) {
    return `data:image/svg+xml;base64,${Buffer.from(String(svg || ''), 'utf8').toString('base64')}`;
}

function buildLogoPublicId(ownerId, variantKey) {
    const seed = String(ownerId || 'owner').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'owner';
    const key = String(variantKey || 'logo').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'logo';
    return `store-logos/${seed}/${Date.now()}-${key}-${Math.random().toString(36).slice(2, 7)}`;
}

async function listOwnerLogoVariants(ownerId, supabaseClient = supabase) {
    if (!supabaseClient || !ownerId) return [];
    const { data, error } = await supabaseClient
        .from('store_logos')
        .select('id, owner_id, store_id, business_name, variant_key, variant_name, logo_public_id, logo_url, is_selected, created_at')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: false })
        .limit(OWNER_LOGOS_FETCH_LIMIT);
    if (error) throw error;
    return (data || []).map(toLogoVariantPublic);
}

async function setSelectedOwnerLogo({ ownerId, logoId, supabaseClient = supabase }) {
    if (!supabaseClient || !ownerId || !logoId) return null;

    const { data: selectedRow, error: selectedErr } = await supabaseClient
        .from('store_logos')
        .select('id, owner_id, store_id, business_name, variant_key, variant_name, logo_public_id, logo_url, is_selected, created_at')
        .eq('owner_id', ownerId)
        .eq('id', logoId)
        .maybeSingle();
    if (selectedErr) throw selectedErr;
    if (!selectedRow) return null;

    const { error: clearErr } = await supabaseClient
        .from('store_logos')
        .update({ is_selected: false })
        .eq('owner_id', ownerId)
        .eq('is_selected', true);
    if (clearErr) throw clearErr;

    const { error: chooseErr } = await supabaseClient
        .from('store_logos')
        .update({ is_selected: true })
        .eq('owner_id', ownerId)
        .eq('id', logoId);
    if (chooseErr) throw chooseErr;

    const { data: storeRow, error: storeErr } = await supabaseClient
        .from('stores')
        .update({
            logo_public_id: selectedRow.logo_public_id,
            logo_url: selectedRow.logo_url,
            name: selectedRow.business_name || 'My Store'
        })
        .eq('owner_id', ownerId)
        .select(STORE_SELECT_COLUMNS)
        .maybeSingle();
    if (storeErr) throw storeErr;

    return {
        logo: toLogoVariantPublic({ ...selectedRow, is_selected: true }),
        store: mapStoreRow(storeRow)
    };
}

function schemaHelpError(error, entityLabel) {
    if (isSchemaTableMissing(error) || isSchemaColumnMissing(error)) {
        return `Database schema for ${entityLabel} is missing. Run the latest supabase-schema.sql and retry.`;
    }
    return error?.message || `Could not update ${entityLabel}.`;
}

async function resolveStoreFromToken(token, supabaseClient = supabase) {
    const raw = String(token || '').trim();
    if (!raw) return null;

    const slug = sanitizeStoreSlug(raw);
    if (slug) {
        const bySlug = await findStoreBySlug(slug, supabaseClient);
        if (bySlug) return bySlug;
    }

    if (isUuidLike(raw)) {
        const byOwnerId = await findStoreByOwnerId(raw, supabaseClient);
        if (byOwnerId) return byOwnerId;
    }

    return null;
}

async function resolveStoreContext(req, { allowOwnerFallback = true, supabaseClient = supabase } = {}) {
    const queryToken = req.query.store;
    const cookieToken = req.cookies[STORE_COOKIE];
    const requestedToken = queryToken || cookieToken || '';
    let store = null;
    let source = null;

    if (queryToken) {
        store = await resolveStoreFromToken(queryToken, supabaseClient);
        source = 'query';
    } else if (cookieToken) {
        store = await resolveStoreFromToken(cookieToken, supabaseClient);
        source = 'cookie';
    }

    if (!store && allowOwnerFallback && req.user && req.role === 'owner') {
        store = await ensureOwnerStore(
            req.user.id,
            req.profile?.displayName || req.user.email || 'My Store',
            supabaseClient
        );
        source = 'owner-default';
    }

    return { store, source, requestedToken };
}

async function loadAuth(req, res, next) {
    req.user = null;
    req.role = null;
    req.profile = null;
    const token = req.cookies[AUTH_COOKIE];
    if (!token || !supabase) return next();
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return next();
        const { data: profile } = await requestSupabase.from('profiles').select('role, display_name').eq('id', user.id).maybeSingle();
        req.user = { id: user.id, email: user.email || '' };
        req.role = profile?.role || 'customer';
        req.profile = {
            displayName: profile?.display_name || ''
        };
    } catch (e) { /* ignore */ }
    next();
}

function requireOwner(req, res, next) {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/'));
    if (req.role !== 'owner') return res.redirect('/products');
    next();
}

function requireSignedIn(req, res, next) {
    if (!req.user) {
        return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/products'));
    }
    next();
}

app.use(loadAuth);

let inventoryStatus = {};

function normalizeSingleField(val) {
    if (val == null) return '';
    const one = Array.isArray(val) ? val[0] : val;
    return String(one).trim();
}

function bytesToLabel(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    const fixed = value >= 100 || idx === 0 ? 0 : 1;
    return `${value.toFixed(fixed)} ${units[idx]}`;
}

function looksLikeHeicImage(file) {
    const mime = String(file?.mimetype || '').toLowerCase();
    const name = String(file?.originalname || '').toLowerCase();
    return mime.includes('heic') || mime.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

async function uploadMediaToCloudinary(file, uploadOptions) {
    const mediaType = uploadOptions?.resource_type === 'video' ? 'video' : 'image';
    const isLargeVideo = mediaType === 'video' && Number(file?.size || 0) >= LARGE_VIDEO_UPLOAD_THRESHOLD_BYTES;
    if (isLargeVideo) {
        return cloudinary.uploader.upload_large(file.path, {
            ...uploadOptions,
            resource_type: 'video',
            chunk_size: 6 * 1024 * 1024
        });
    }
    return cloudinary.uploader.upload(file.path, uploadOptions);
}

function cleanupTempFiles(files) {
    const list = Array.isArray(files) ? files : [];
    list.forEach((file) => {
        const filePath = file?.path;
        if (!filePath) return;
        try {
            fs.unlinkSync(filePath);
        } catch {
            // ignore cleanup errors
        }
    });
}

// 3. HEALTH CHECK
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 4. AUTH ROUTES
app.get('/login', (req, res) => {
    if (req.user && req.role === 'owner') return res.redirect('/');
    if (req.user) return res.redirect('/products');
    const next = sanitizeRedirectPath(req.query.next || '/products', '/products');
    res.render('login', { user: req.user, role: req.role, error: null, message: req.query.message || null, next });
});

app.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
    const requestedNext = sanitizeRedirectPath(req.body.next || '/products', '/products');
    if (!supabase) return res.render('login', { user: null, role: null, error: 'Auth not configured', next: requestedNext });
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    if (!email || !password) return res.render('login', { user: null, role: null, error: 'Email and password required', next: requestedNext });
    try {
        const authClient = createAuthClient() || supabase;
        const { data, error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) return res.render('login', { user: null, role: null, error: error.message, next: requestedNext });
        res.cookie(AUTH_COOKIE, data.session.access_token, COOKIE_OPTS);
        const roleClient = supabaseServiceKey
            ? supabase
            : createClient(supabaseUrl, supabaseAnonKey || supabaseKey, {
                global: {
                    headers: {
                        Authorization: `Bearer ${data.session.access_token}`
                    }
                }
            });
        const { data: profile } = await roleClient.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
        if (!profile) {
            await roleClient.from('profiles').upsert({ id: data.user.id, role: 'customer' }, { onConflict: 'id' });
        }
        const role = profile?.role || 'customer';
        const redirectPath = requestedNext === '/'
            ? (role === 'owner' ? '/' : '/products')
            : requestedNext;
        return res.redirect(redirectPath);
    } catch (e) {
        return res.render('login', { user: null, role: null, error: e.message || 'Login failed', next: requestedNext });
    }
});

app.get('/signup', (req, res) => {
    if (req.user && req.role === 'owner') return res.redirect('/');
    if (req.user) return res.redirect('/products');
    const next = sanitizeRedirectPath(req.query.next || '/products', '/products');
    res.render('signup', { user: req.user, role: req.role, error: null, next });
});

app.post('/signup', express.urlencoded({ extended: true }), async (req, res) => {
    const requestedNext = sanitizeRedirectPath(req.body.next || '/products', '/products');
    if (!supabase) return res.render('signup', { user: null, role: null, error: 'Auth not configured', next: requestedNext });
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const displayName = (req.body.displayName || '').trim();
    if (!email || !password) return res.render('signup', { user: null, role: null, error: 'Email and password required', next: requestedNext });
    if (password.length < 6) return res.render('signup', { user: null, role: null, error: 'Password must be at least 6 characters', next: requestedNext });
    try {
        const authClient = createAuthClient() || supabase;
        const { data, error } = await authClient.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
        if (error) return res.render('signup', { user: null, role: null, error: error.message, next: requestedNext });
        const role = 'customer';
        if (data.session?.access_token) {
            const profileClient = supabaseServiceKey
                ? supabase
                : createClient(supabaseUrl, supabaseAnonKey || supabaseKey, {
                    global: {
                        headers: {
                            Authorization: `Bearer ${data.session.access_token}`
                        }
                    }
                });
            await profileClient
                .from('profiles')
                .upsert({ id: data.user.id, role, display_name: displayName || null }, { onConflict: 'id' });
        } else if (supabaseServiceKey) {
            await supabase
                .from('profiles')
                .upsert({ id: data.user.id, role, display_name: displayName || null }, { onConflict: 'id' });
        }
        if (data.session?.access_token) {
            res.cookie(AUTH_COOKIE, data.session.access_token, COOKIE_OPTS);
        }
        if (!data.session) return res.redirect('/login?message=Confirm your email to sign in');
        const redirectPath = requestedNext === '/'
            ? (role === 'owner' ? '/' : '/products')
            : requestedNext;
        return res.redirect(redirectPath);
    } catch (e) {
        return res.render('signup', { user: null, role: null, error: e.message || 'Sign up failed', next: requestedNext });
    }
});

app.get('/create-store', async (req, res) => {
    if (!req.user) {
        return res.redirect('/signup?next=' + encodeURIComponent('/create-store'));
    }
    if (req.role === 'owner') return res.redirect('/');
    const defaultName = req.profile?.displayName || (req.user.email ? req.user.email.split('@')[0] : '');
    res.render('create-store', {
        user: req.user,
        role: req.role,
        error: null,
        initialName: defaultName
    });
});

app.post('/create-store', express.urlencoded({ extended: true }), async (req, res) => {
    if (!req.user) {
        return res.redirect('/signup?next=' + encodeURIComponent('/create-store'));
    }
    const storeName = String(req.body.storeName || '').trim();
    const storeSlug = String(req.body.storeSlug || '').trim();
    if (!storeName) {
        return res.render('create-store', {
            user: req.user,
            role: req.role,
            error: 'Store name is required',
            initialName: storeName
        });
    }
    if (!supabase) {
        return res.render('create-store', {
            user: req.user,
            role: req.role,
            error: 'Supabase is not configured',
            initialName: storeName
        });
    }
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const { error: profileError } = await requestSupabase
            .from('profiles')
            .upsert(
                {
                    id: req.user.id,
                    role: 'owner',
                    display_name: req.profile?.displayName || storeName || null
                },
                { onConflict: 'id' }
            );
        if (profileError) {
            throw new Error('Could not upgrade your account to owner: ' + profileError.message);
        }

        const ownerStore = await upsertStoreForOwner({
            ownerId: req.user.id,
            storeName,
            storeSlug,
            supabaseClient: requestSupabase
        });
        setStoreCookie(res, ownerStore.slug);
        return res.redirect(logoOnboardingPath());
    } catch (e) {
        return res.render('create-store', {
            user: req.user,
            role: req.role,
            error: e.message || 'Could not create store',
            initialName: storeName
        });
    }
});

app.get('/onboarding/logo', requireOwner, async (req, res) => {
    if (!supabase) {
        return res.render('logo-onboarding', {
            user: req.user,
            role: req.role,
            error: 'Supabase is not configured',
            store: null,
            logos: [],
            businessName: req.profile?.displayName || '',
            manageMode: false
        });
    }
    const requestSupabase = getRequestSupabase(req) || supabase;
    const manageMode = isTruthyFlag(req.query.manage) || String(req.query.manage || '').trim() === '1';
    try {
        const store = await ensureOwnerStore(
            req.user.id,
            req.profile?.displayName || req.user.email || 'My Store',
            requestSupabase
        );
        if (store?.slug) setStoreCookie(res, store.slug);
        if (store?.logoPublicId && !manageMode) {
            return res.redirect('/');
        }
        const logos = await listOwnerLogoVariants(req.user.id, requestSupabase);
        return res.render('logo-onboarding', {
            user: req.user,
            role: req.role,
            error: null,
            store,
            logos,
            businessName: store?.name || req.profile?.displayName || '',
            manageMode
        });
    } catch (e) {
        return res.render('logo-onboarding', {
            user: req.user,
            role: req.role,
            error: schemaHelpError(e, 'store logos'),
            store: null,
            logos: [],
            businessName: req.profile?.displayName || '',
            manageMode
        });
    }
});

app.get('/api/logo-variants', requireOwner, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const logos = await listOwnerLogoVariants(req.user.id, requestSupabase);
        return res.json({ variants: logos });
    } catch (e) {
        return res.status(500).json({ error: schemaHelpError(e, 'store logos') });
    }
});

app.post('/api/logo-variants/generate', requireOwner, express.json(), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    if (!canGenerateCloudinaryAssets()) {
        return res.status(503).json({ error: 'Cloudinary logo generation is not configured' });
    }

    const businessName = sanitizeBusinessName(req.body?.businessName || req.profile?.displayName || 'My Store');
    const requestSupabase = getRequestSupabase(req) || supabase;

    try {
        const ownerStore = await ensureOwnerStore(req.user.id, businessName, requestSupabase);
        if (!ownerStore) return res.status(500).json({ error: 'Could not resolve your store' });
        if (ownerStore.slug) setStoreCookie(res, ownerStore.slug);

        const generated = buildLogoVariants(businessName);
        const uploaded = [];
        for (const item of generated) {
            const uploadResult = await cloudinary.uploader.upload(svgToDataUri(item.svg), {
                resource_type: 'image',
                public_id: buildLogoPublicId(req.user.id, item.variantKey),
                format: 'png',
                overwrite: false,
                tags: ['store-logo', `owner:${req.user.id}`, `store:${ownerStore.id}`]
            });
            uploaded.push({
                owner_id: req.user.id,
                store_id: ownerStore.id,
                business_name: businessName,
                variant_key: item.variantKey,
                variant_name: item.variantName,
                logo_public_id: uploadResult.public_id,
                logo_url: uploadResult.secure_url,
                is_selected: false
            });
        }

        const { data, error } = await requestSupabase
            .from('store_logos')
            .insert(uploaded)
            .select('id, owner_id, store_id, business_name, variant_key, variant_name, logo_public_id, logo_url, is_selected, created_at');
        if (error) throw error;

        const variants = (data || []).map(toLogoVariantPublic);
        return res.json({ success: true, businessName, variants });
    } catch (e) {
        return res.status(500).json({ error: schemaHelpError(e, 'store logos') });
    }
});

app.post('/api/logo-variants/select', requireOwner, express.json(), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const logoId = String(req.body?.logoId || '').trim();
    if (!logoId) return res.status(400).json({ error: 'logoId required' });
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const selected = await setSelectedOwnerLogo({
            ownerId: req.user.id,
            logoId,
            supabaseClient: requestSupabase
        });
        if (!selected || !selected.logo) return res.status(404).json({ error: 'Logo not found' });
        return res.json({
            success: true,
            logo: selected.logo,
            store: selected.store
        });
    } catch (e) {
        return res.status(500).json({ error: schemaHelpError(e, 'store logos') });
    }
});

function logoutAndRedirect(req, res) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    const nextPath = sanitizeRedirectPath(req.query.next || req.body?.next || '/products', '/products');
    res.redirect(nextPath);
}

app.get('/logout', logoutAndRedirect);
app.post('/logout', logoutAndRedirect);

// 4b. CATEGORY API (owner only)
app.get('/api/categories', requireOwner, async (req, res) => {
    if (!categoryService || !supabase) return res.status(503).json({ error: 'Categories not configured' });
    try {
        const client = getRequestSupabase(req) || supabase;
        const svc = new CategoryService(client);
        const categories = await svc.list(req.user.id);
        return res.json(categories);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/categories', requireOwner, express.json(), async (req, res) => {
    if (!categoryService || !supabase) return res.status(503).json({ error: 'Categories not configured' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    try {
        const client = getRequestSupabase(req) || supabase;
        const svc = new CategoryService(client);
        const cat = await svc.create({ ownerId: req.user.id, name });
        return res.json(cat);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.patch('/api/categories/:id', requireOwner, express.json(), async (req, res) => {
    if (!categoryService || !supabase) return res.status(503).json({ error: 'Categories not configured' });
    const id = req.params.id;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    try {
        const client = getRequestSupabase(req) || supabase;
        const svc = new CategoryService(client);
        const cat = await svc.update(id, req.user.id, { name });
        if (!cat) return res.status(404).json({ error: 'Category not found' });
        return res.json(cat);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.delete('/api/categories/:id', requireOwner, async (req, res) => {
    if (!categoryService || !supabase) return res.status(503).json({ error: 'Categories not configured' });
    try {
        const client = getRequestSupabase(req) || supabase;
        const svc = new CategoryService(client);
        await svc.delete(req.params.id, req.user.id);
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

async function handleNaijaSongsRequest(req, res) {
    const limit = clampNumber(req.query.limit, { fallback: NAIJA_AUDIO_DEFAULT_LIMIT, min: 6, max: 25 });
    const refresh = isTruthyFlag(req.query.refresh);
    const query = String(req.query.q || '').trim().slice(0, 80);
    res.set('Cache-Control', 'no-store');

    try {
        const payload = await fetchNaijaAudioTracks({ limit, query, refresh });
        const tracksCompat = Array.isArray(payload.hottestTracks) ? payload.hottestTracks : [];
        return res.json({
            ...payload,
            tracks: tracksCompat
        });
    } catch (e) {
        console.error('Naija audio fetch failed:', e.message);
        return res.status(502).json({
            error: 'Could not fetch songs right now.',
            source: 'iTunes Search',
            updatedAt: new Date().toISOString(),
            hottestTracks: [],
            latestTracks: [],
            nostalgicTracks: [],
            tracks: []
        });
    }
}

app.get('/api/hot-naija-songs', requireOwner, handleNaijaSongsRequest);
app.get('/api/free-audio-tracks', requireOwner, handleNaijaSongsRequest);

// 4c. CATEGORY VIDEO GENERATION (owner only)
app.post('/api/generate-category-video', requireOwner, express.json(), async (req, res) => {
    if (!videoJobQueue) return res.status(503).json({ error: 'Video generation not configured' });
    const categoryId = req.body?.categoryId ? String(req.body.categoryId).trim() : null;
    if (!categoryId) return res.status(400).json({ error: 'categoryId required' });
    const transitionType = sanitizeVideoTransitionType(req.body?.transitionType);
    const fadeDuration = clampNumber(req.body?.fadeDuration, { fallback: 0.5, min: 0, max: 2.5 });
    const slideDuration = clampNumber(req.body?.slideDuration, { fallback: 3, min: 1, max: 12 });
    const requestedAudio = sanitizeVideoAudioUrl(req.body?.audioUrl);
    const fallbackAudio = sanitizeVideoAudioUrl(DEFAULT_VIDEO_AUDIO_URL);
    const audioUrl = requestedAudio || fallbackAudio || null;
    try {
        const jobId = videoJobQueue.add(req.user.id, categoryId, {
            audioUrl,
            slideDuration,
            fadeDuration,
            transitionType
        });
        return res.json({ jobId });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/generate-category-video/:jobId', requireOwner, async (req, res) => {
    if (!videoJobQueue) return res.status(503).json({ error: 'Video generation not configured' });
    const job = videoJobQueue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    return res.json({
        id: job.id,
        status: job.status,
        progress: job.progress,
        videoUrl: job.videoUrl,
        error: job.error
    });
});

// 5. DASHBOARD ROUTE (owner only)
app.get('/', requireOwner, async (req, res) => {
    let store = null;
    let storeError = null;
    const requestSupabase = getRequestSupabase(req) || supabase;
    try {
        store = await ensureOwnerStore(
            req.user.id,
            req.profile?.displayName || req.user.email || 'My Store',
            requestSupabase
        );
        if (store?.slug) setStoreCookie(res, store.slug);
        if (store && !store.logoPublicId) {
            return res.redirect(logoOnboardingPath());
        }
    } catch (e) {
        storeError = e.message || 'Store setup failed';
    }
    const storePath = store?.slug ? storePathFromSlug(store.slug) : null;
    const storeLink = storePath ? absoluteUrlFromPath(req, storePath) : null;
    res.render('dashboard', {
        inventory: inventoryStatus,
        user: req.user,
        role: req.role,
        store,
        storePath,
        storeLink,
        storeError
    });
});

// 6. BULK UPLOAD ROUTE (owner only)
app.post('/upload-bulk', requireOwner, upload.array('files', 80), async (req, res) => {
    try {
        const files = Array.isArray(req.files) ? req.files : [];
        console.log('[debug][upload-bulk] request start', {
            ownerId: req.user?.id || null,
            files: files.length,
            userAgent: req.get('user-agent') || '',
            contentType: req.get('content-type') || ''
        });
        if (!files.length) {
            console.warn('[debug][upload-bulk] rejected: no files');
            return res.status(400).json({ success: false, error: 'Select at least one image or video.' });
        }

        const bgColor = req.body.bgColor || 'white';
        const shouldRemoveBg = String(req.body.removeBg) === 'true';
        const badgeLabel = normalizeBadgeLabel(req.body.badgeLabel);
        const legacyPrices = Array.isArray(req.body.prices) ? req.body.prices : [req.body.prices];
        const legacySize = normalizeSingleField(req.body.size);
        const legacyColor = normalizeSingleField(req.body.color);
        const legacyQty = normalizeSingleField(req.body.qty);
        const rawCategoryId = req.body.categoryId;
        const legacyCategoryId = Array.isArray(rawCategoryId)
            ? (rawCategoryId[0] && String(rawCategoryId[0]).trim()) || ''
            : (rawCategoryId && String(rawCategoryId).trim()) || '';

        let productSpecs = [];
        const rawProductsPayload = normalizeSingleField(req.body.productsPayload);
        if (rawProductsPayload) {
            let parsed = null;
            try {
                parsed = JSON.parse(rawProductsPayload);
            } catch (parseErr) {
                console.warn('[debug][upload-bulk] invalid productsPayload JSON');
                return res.status(400).json({ success: false, error: 'Invalid products payload.' });
            }
            if (!Array.isArray(parsed) || !parsed.length) {
                console.warn('[debug][upload-bulk] invalid productsPayload: empty/non-array');
                return res.status(400).json({ success: false, error: 'No products were provided.' });
            }

            productSpecs = parsed
                .map((entry) => {
                    const fileCount = Math.max(0, Math.floor(Number(entry?.fileCount) || 0));
                    return {
                        price: normalizePriceLabel(entry?.price, 'Contact for Price'),
                        size: normalizeSingleField(entry?.size),
                        color: normalizeSingleField(entry?.color),
                        qty: normalizeSingleField(entry?.qty),
                        categoryId: normalizeSingleField(entry?.categoryId),
                        fileCount
                    };
                })
                .filter((spec) => spec.fileCount > 0);

            if (!productSpecs.length) {
                console.warn('[debug][upload-bulk] invalid productsPayload: no specs with files');
                return res.status(400).json({ success: false, error: 'Each product must include at least one media file.' });
            }
        } else {
            // Backward compatibility: one file = one product.
            productSpecs = files.map((_, index) => ({
                price: normalizePriceLabel(legacyPrices[index], 'Contact for Price'),
                size: legacySize,
                color: legacyColor,
                qty: legacyQty,
                categoryId: legacyCategoryId,
                fileCount: 1
            }));
        }

        const expectedFiles = productSpecs.reduce((sum, spec) => sum + (spec.fileCount || 0), 0);
        console.log('[debug][upload-bulk] payload parsed', {
            products: productSpecs.length,
            expectedFiles,
            actualFiles: files.length
        });
        if (expectedFiles !== files.length) {
            console.warn('[debug][upload-bulk] rejected: file count mismatch', { expectedFiles, actualFiles: files.length });
            return res.status(400).json({
                success: false,
                error: 'Uploaded files do not match products. Please reselect files and try again.'
            });
        }

        const results = [];
        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const requestSupabase = getRequestSupabase(req) || supabase;
        const scopedProductService = requestSupabase && !supabaseServiceKey
            ? new ProductService(requestSupabase)
            : productService;
        const scopedCategoryService = requestSupabase && !supabaseServiceKey
            ? new CategoryService(requestSupabase)
            : categoryService;
        let ownerStore = null;
        let categoryNameById = {};

        try {
            ownerStore = await ensureOwnerStore(
                req.user.id,
                req.profile?.displayName || req.user.email || 'My Store',
                requestSupabase
            );
            if (ownerStore?.slug) setStoreCookie(res, ownerStore.slug);
        } catch (storeErr) {
            console.error('Store resolution failed during upload:', storeErr.message);
        }

        if (!ownerStore?.logoPublicId) {
            console.warn('[debug][upload-bulk] rejected: owner has no logo selected');
            return res.status(400).json({
                success: false,
                error: 'Set up your brand logo first. Open Logo onboarding and select a logo before uploading.'
            });
        }

        const requestedCategoryIds = [...new Set(productSpecs.map((spec) => spec.categoryId).filter(Boolean))];
        if (requestedCategoryIds.length && scopedCategoryService && req.user?.id) {
            try {
                const cats = await scopedCategoryService.list(req.user.id);
                categoryNameById = Object.fromEntries((cats || []).map((cat) => [cat.id, cat.name]));
                const invalidCategoryId = requestedCategoryIds.find((id) => !categoryNameById[id]);
                if (invalidCategoryId) {
                    console.warn('[debug][upload-bulk] rejected: invalid category id', invalidCategoryId);
                    return res.status(400).json({ success: false, error: 'One or more products use an invalid category.' });
                }
            } catch (categoryErr) {
                console.error('Category lookup failed during upload:', categoryErr.message);
            }
        }

        let fileCursor = 0;
        for (let productIndex = 0; productIndex < productSpecs.length; productIndex++) {
            const spec = productSpecs[productIndex];
            const productFiles = files.slice(fileCursor, fileCursor + spec.fileCount);
            fileCursor += spec.fileCount;
            if (!productFiles.length) continue;
            console.log('[debug][upload-bulk] product processing', {
                productIndex,
                files: productFiles.length,
                categoryId: spec.categoryId || '',
                price: spec.price
            });

            const mediaAssets = [];
            for (let fileIndex = 0; fileIndex < productFiles.length; fileIndex++) {
                const file = productFiles[fileIndex];
                const mediaType = (file.mimetype || '').startsWith('video/') ? 'video' : 'image';
                console.log('[debug][upload-bulk] file processing', {
                    productIndex,
                    fileIndex,
                    originalname: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    mediaType
                });
                const uploadOptions = { resource_type: mediaType };
                if (mediaType === 'image') {
                    uploadOptions.transformation = buildImageTransformations({
                        shouldRemoveBg,
                        bgColor,
                        badgeLabel,
                        logoPublicId: ownerStore.logoPublicId
                    });
                }

                let uploadResult = null;
                try {
                    uploadResult = await uploadMediaToCloudinary(file, uploadOptions);
                    console.log('[debug][upload-bulk] cloudinary upload ok', {
                        productIndex,
                        fileIndex,
                        publicId: uploadResult.public_id,
                        resourceType: uploadResult.resource_type
                    });
                } catch (uploadErr) {
                    const fileLabel = file?.originalname ? `"${file.originalname}"` : 'this file';
                    const fileSize = bytesToLabel(file?.size || 0);
                    console.error('[debug][upload-bulk] cloudinary upload failed', {
                        productIndex,
                        fileIndex,
                        fileLabel,
                        mime: file?.mimetype,
                        size: file?.size,
                        message: uploadErr?.message || String(uploadErr)
                    });
                    if (looksLikeHeicImage(file)) {
                        throw new Error(`Upload failed for ${fileLabel}. HEIC/HEIF from iPhone may be unsupported on this account. In iPhone Camera settings, set Format to "Most Compatible" (JPG/H.264) and try again.`);
                    }
                    if (String(file?.mimetype || '').toLowerCase().startsWith('video/')) {
                        throw new Error(`Upload failed for ${fileLabel} (${fileSize}). If this iPhone video is large, trim it and try again.`);
                    }
                    throw new Error(`Upload failed for ${fileLabel} (${fileSize}). ${uploadErr.message || 'Unknown upload error.'}`);
                }
                const previewUrl = mediaType === 'video'
                    ? buildVideoAnimatedPreviewUrl(cloudinary, uploadResult.public_id)
                    : buildImagePreviewUrl(cloudinary, {
                        publicId: uploadResult.public_id,
                        bgColor
                    });

                inventoryStatus[uploadResult.public_id] = {
                    price: spec.price,
                    type: mediaType,
                    isSoldOut: false,
                    badgeLabel
                };
                mediaAssets.push({
                    publicId: uploadResult.public_id,
                    mediaType,
                    previewUrl,
                    sourceUrl: uploadResult.secure_url || uploadResult.url || '',
                    sortOrder: fileIndex
                });
            }

            if (!mediaAssets.length) continue;
            const primary = mediaAssets[0];
            const link = buildProductLink({
                protocol,
                host,
                publicId: primary.publicId,
                price: spec.price,
                bgColor,
                removeBg: shouldRemoveBg && primary.mediaType === 'image',
                badgeLabel,
                mediaType: primary.mediaType,
                storeSlug: ownerStore?.slug || ''
            });

            results.push({
                link,
                price: spec.price,
                previewUrl: primary.previewUrl,
                mediaType: primary.mediaType,
                mediaCount: mediaAssets.length,
                badgeLabel,
                storeSlug: ownerStore?.slug || '',
                categoryId: spec.categoryId || '',
                categoryName: categoryNameById[spec.categoryId] || '',
                size: spec.size,
                color: spec.color,
                qty: spec.qty
            });

            if (scopedProductService) {
                try {
                    await scopedProductService.create({
                        publicId: primary.publicId,
                        price: spec.price,
                        link,
                        previewUrl: primary.previewUrl,
                        bgColor,
                        badgeLabel,
                        size: spec.size,
                        color: spec.color,
                        qty: spec.qty,
                        ownerId: req.user ? req.user.id : null,
                        categoryId: spec.categoryId || null,
                        mediaItems: mediaAssets
                    });
                    console.log('[debug][upload-bulk] product saved', {
                        productIndex,
                        primaryPublicId: primary.publicId,
                        mediaCount: mediaAssets.length
                    });
                } catch (dbErr) {
                    console.error('Product save error:', dbErr.message, dbErr.code || '', dbErr.details || '');
                    if (!res.locals.dbError) res.locals.dbError = dbErr.message;
                    if (dbErr.code === '42703') console.error('Tip: run ALTER TABLE in supabase-schema.sql to add size, color, qty columns.');
                }
            }
        }

        if (!results.length) {
            console.warn('[debug][upload-bulk] rejected: no results produced');
            return res.status(400).json({ success: false, error: 'No products were uploaded. Check your media files and try again.' });
        }

        console.log('[debug][upload-bulk] success', {
            items: results.length,
            dbSaved: !!scopedProductService && !res.locals.dbError,
            dbError: res.locals.dbError || null
        });
        res.json({
            success: true,
            items: results,
            dbSaved: !!scopedProductService && !res.locals.dbError,
            dbError: res.locals.dbError || null
        });
    } catch (err) {
        console.error('Cloudinary Error:', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanupTempFiles(req.files);
    }
});

function withFreshPreviewUrl(product) {
    if (!product || !product.link) return product;

    try {
        const parsedLink = new URL(product.link, 'http://localhost');
        const pathParts = parsedLink.pathname.split('/').filter(Boolean);
        const publicId = pathParts[0] === 'p' ? decodeURIComponent(pathParts.slice(1).join('/')) : '';
        if (!publicId) return product;

        const mediaType = (String(parsedLink.searchParams.get('mt') || 'image').toLowerCase() === 'video') ? 'video' : 'image';
        if (mediaType === 'video') {
            return {
                ...product,
                previewUrl: buildVideoAnimatedPreviewUrl(cloudinary, publicId)
            };
        }

        const bgColor = parsedLink.searchParams.get('bg') || 'white';
        const badgeLabel = normalizeBadgeLabel(product.badgeLabel || parsedLink.searchParams.get('badge') || '');

        return {
            ...product,
            previewUrl: buildImagePreviewUrl(cloudinary, {
                publicId,
                bgColor
            }),
            badgeLabel
        };
    } catch {
        return product;
    }
}

// 6. PRODUCTS PAGE (store-scoped: only products from the store whose link you used)
app.get('/s/:storeSlug', async (req, res) => {
    if (!supabase) return res.redirect('/products');
    const storeSlug = sanitizeStoreSlug(req.params.storeSlug);
    if (!storeSlug) {
        clearStoreCookie(res);
        return res.redirect('/products');
    }

    try {
        const store = await findStoreBySlug(storeSlug);
        if (!store) {
            clearStoreCookie(res);
            return res.redirect('/products');
        }
        setStoreCookie(res, store.slug);
        const targetView = req.query.view === 'simple' ? '/products/simple' : '/products';
        return res.redirect(targetView);
    } catch (e) {
        console.error('Store switch error:', e.message);
        return res.redirect('/products');
    }
});

async function renderStoreProducts(req, res, viewName) {
    if (!productService) {
        return res.render(viewName, {
            products: [],
            categories: [],
            categoryFilter: '',
            error: 'Supabase not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in env.',
            user: req.user,
            role: req.role,
            hasStore: false,
            store: null,
            storePath: null,
            storeLink: null,
            canCreateStore: req.role !== 'owner',
            createStoreHref: getCreateStoreHref(req)
        });
    }

    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const { store, requestedToken } = await resolveStoreContext(req, {
            allowOwnerFallback: true,
            supabaseClient: requestSupabase
        });
        if (store?.slug) setStoreCookie(res, store.slug);
        else if (requestedToken) clearStoreCookie(res);

        const categoryFilter = req.query.category ? String(req.query.category).trim() || null : null;
        let products = store
            ? (await productService.list(store.ownerId, categoryFilter || undefined)).map(withFreshPreviewUrl)
            : [];
        const categories = store && categoryService
            ? await categoryService.list(store.ownerId)
            : [];
        const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
        products = products.map((p) => ({
            ...p,
            price: normalizePriceLabel(p.price, 'Contact for Price'),
            categoryName: (p.categoryId && catMap[p.categoryId]) || ''
        }));
        const storePath = store?.slug ? storePathFromSlug(store.slug) : null;
        const storeLink = storePath ? absoluteUrlFromPath(req, storePath) : null;

        return res.render(viewName, {
            products,
            categories,
            categoryFilter: categoryFilter || '',
            error: null,
            user: req.user,
            role: req.role,
            hasStore: !!store,
            store,
            storePath,
            storeLink,
            canCreateStore: req.role !== 'owner',
            createStoreHref: getCreateStoreHref(req)
        });
    } catch (err) {
        console.error('Products fetch error:', err);
        return res.render(viewName, {
            products: [],
            categories: [],
            categoryFilter: '',
            error: err.message,
            user: req.user,
            role: req.role,
            hasStore: false,
            store: null,
            storePath: null,
            storeLink: null,
            canCreateStore: req.role !== 'owner',
            createStoreHref: getCreateStoreHref(req)
        });
    }
}

app.get('/products', async (req, res) => {
    await renderStoreProducts(req, res, 'products');
});

// Products - simple card grid (store-scoped)
app.get('/products/simple', async (req, res) => {
    await renderStoreProducts(req, res, 'products-simple');
});

// 7. PREVIEW ROUTE (Crawlers -> preview for OG; browsers -> premium app view)
function isPreviewBot(req) {
    const ua = (req.get('User-Agent') || '').toLowerCase();
    const bots = ['whatsapp', 'telegram', 'slack', 'discord', 'facebookexternalhit', 'facebot', 'twitter', 'linkedin', 'pinterest', 'snapchat', 'line-poker', 'line-sheriff', 'googlebot', 'bingbot'];
    return bots.some(bot => ua.includes(bot));
}

app.get('/p/:publicId', async (req, res) => {
    // This route serves different HTML for bots vs browsers.
    // Prevent caches from serving the wrong variant to link preview crawlers.
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Vary', 'User-Agent');

    const { publicId } = req.params;
    const price = normalizePriceLabel(req.query.price, 'Contact for Price');
    const bg = req.query.bg || "white";
    const statusItem = inventoryStatus[publicId] || { isSoldOut: false, type: 'image', badgeLabel: '' };
    const mediaType = (String(req.query.mt || statusItem.type || 'image').toLowerCase() === 'video') ? 'video' : 'image';
    const shouldRemoveBg = req.query.rm === 'true';
    const badgeLabel = normalizeBadgeLabel(req.query.badge || statusItem.badgeLabel);

    const previewUrl = mediaType === 'video'
        ? buildVideoOgPreviewUrl(cloudinary, publicId)
        : buildImagePreviewUrl(cloudinary, {
            publicId,
            bgColor: bg
        });

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: mediaType });
    const item = {
        price,
        isSoldOut: statusItem.isSoldOut,
        type: mediaType,
        badgeLabel,
        size: '',
        color: '',
        qty: '',
        categoryName: '',
        mediaCount: 0
    };
    let productOwnerId = null;
    let productCategoryId = null;
    let ownerStore = null;
    if (productService) {
        try {
            const product = await productService.getByPublicId(publicId);
            if (product) {
                item.size = product.size || '';
                item.color = product.color || '';
                item.qty = product.qty || '';
                item.mediaCount = Number(product.mediaCount || 0) || 0;
                productOwnerId = product.ownerId || null;
                productCategoryId = product.categoryId || null;
            }
        } catch (e) {
            // keep defaults
        }
    }

    if (productOwnerId) {
        try {
            ownerStore = await findStoreByOwnerId(productOwnerId);
        } catch (e) {
            console.error('Store lookup failed for preview:', e.message);
        }
    }
    if (productCategoryId && supabase) {
        try {
            const requestSupabase = getRequestSupabase(req) || supabase;
            const { data: categoryRow, error: categoryErr } = await requestSupabase
                .from('categories')
                .select('name')
                .eq('id', productCategoryId)
                .maybeSingle();
            if (!categoryErr && categoryRow?.name) {
                item.categoryName = String(categoryRow.name || '').trim();
            }
        } catch (categoryLookupErr) {
            console.error('Category lookup failed for preview:', categoryLookupErr.message);
        }
    }

    const fallbackStoreSlug = sanitizeStoreSlug(req.query.store || req.cookies[STORE_COOKIE] || '');
    if (!ownerStore && fallbackStoreSlug) {
        try {
            ownerStore = await findStoreBySlug(fallbackStoreSlug);
        } catch (e) {
            console.error('Fallback store lookup failed for preview:', e.message);
        }
    }
    const activeStoreSlug = ownerStore?.slug || fallbackStoreSlug || '';
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const canonicalLink = buildProductLink({
        protocol,
        host,
        publicId,
        price,
        bgColor: bg,
        removeBg: shouldRemoveBg,
        badgeLabel,
        mediaType,
        storeSlug: activeStoreSlug
    });
    const storePath = activeStoreSlug ? storePathFromSlug(activeStoreSlug) : null;

    const payload = {
        previewImage: previewUrl,
        ogPreviewImage: mediaType === 'video'
            ? buildVideoOgPreviewUrl(cloudinary, publicId, { logoPublicId: ownerStore?.logoPublicId || '' })
            : buildImagePreviewUrl(cloudinary, {
                publicId,
                bgColor: bg,
                ogSquare: true,
                logoPublicId: ownerStore?.logoPublicId || ''
            }),
        item,
        rawMediaUrl,
        publicId,
        canonicalLink,
        store: ownerStore || (activeStoreSlug ? { slug: activeStoreSlug, name: '' } : null),
        storePath
    };

    if (isPreviewBot(req)) {
        res.render('preview', payload);
    } else {
        if (activeStoreSlug) setStoreCookie(res, activeStoreSlug);
        res.render('preview-app', {
            ...payload,
            user: req.user,
            role: req.role,
            canCreateStore: req.role !== 'owner',
            createStoreHref: getCreateStoreHref(req)
        });
    }
});

// 8. CART PAGE
app.get('/cart', async (req, res) => {
    let store = null;
    let storePath = null;
    let storeLink = null;
    if (supabase) {
        try {
            const requestSupabase = getRequestSupabase(req) || supabase;
            const { store: resolvedStore, requestedToken } = await resolveStoreContext(req, {
                allowOwnerFallback: true,
                supabaseClient: requestSupabase
            });
            store = resolvedStore;
            if (store?.slug) setStoreCookie(res, store.slug);
            else if (requestedToken) clearStoreCookie(res);
            storePath = store?.slug ? storePathFromSlug(store.slug) : null;
            storeLink = storePath ? absoluteUrlFromPath(req, storePath) : null;
        } catch (e) {
            console.error('Cart store resolve error:', e.message);
        }
    }

    res.render('cart', {
        paystackPublicKey: paystackPublic,
        user: req.user,
        role: req.role,
        canCreateStore: req.role !== 'owner',
        createStoreHref: getCreateStoreHref(req),
        store,
        storePath,
        storeLink
    });
});

// 8b. CART API (persist when signed in)
app.get('/api/cart', async (req, res) => {
    if (!req.user || !supabase) return res.status(401).json({ error: 'Not signed in' });
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const { data, error } = await requestSupabase.from('carts').select('items').eq('user_id', req.user.id).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        const items = Array.isArray(data?.items) ? data.items : [];
        return res.json({ items });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.put('/api/cart', async (req, res) => {
    if (!req.user || !supabase) return res.status(401).json({ error: 'Not signed in' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    try {
        const requestSupabase = getRequestSupabase(req) || supabase;
        const { error } = await requestSupabase.from('carts').upsert(
            { user_id: req.user.id, items, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' }
        );
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 9. PAYMENT API (OOP: PaystackService + OrderService)
app.post('/api/payment/initialize', async (req, res) => {
    if (!paystackService || !orderService) {
        return res.status(503).json({ success: false, error: 'Payment not configured' });
    }
    try {
        let email = req.body.email;
        if (req.user && req.user.email) {
            email = req.user.email;
        }
        const items = req.body.items;
        if (!email || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'Email and items required' });
        }
        const totalKobo = items.reduce((sum, it) => sum + (Number(it.amountKobo) || 0), 0);
        if (totalKobo < 100) {
            return res.status(400).json({ success: false, error: 'Minimum amount is 100 kobo (₦1)' });
        }
        const reference = 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
        const { authorizationUrl, accessCode } = await paystackService.initializeTransaction(
            email,
            totalKobo,
            reference,
            { order_reference: reference }
        );
        await orderService.create(reference, email, totalKobo, items);
        res.json({
            success: true,
            reference,
            authorizationUrl,
            accessCode,
            amountKobo: totalKobo,
            publicKey: paystackPublic
        });
    } catch (err) {
        console.error('Payment init error:', err.message, err.code || '', err.details || '');
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/payment/verify', async (req, res) => {
    if (!paystackService || !orderService) {
        return res.status(503).json({ success: false, error: 'Payment not configured' });
    }
    const reference = req.query.reference;
    if (!reference) {
        return res.status(400).json({ success: false, error: 'Reference required' });
    }
    try {
        const tx = await paystackService.verifyTransaction(reference);
        if (tx.status === 'success') {
            await orderService.updateStatus(reference, 'paid');
        }
        res.json({
            success: tx.status === 'success',
            reference: tx.reference,
            status: tx.status,
            order: tx.status === 'success' ? await orderService.findByReference(reference) : null
        });
    } catch (err) {
        console.error('Verify error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.use((err, req, res, next) => {
    if (!(err instanceof multer.MulterError)) return next(err);
    console.error('[debug][multer] upload middleware error', {
        code: err.code,
        message: err.message,
        path: req.path
    });
    let message = err.message || 'Upload failed';
    if (err.code === 'LIMIT_FILE_SIZE') {
        message = 'One file is too large. Keep each file under 350 MB and try again.';
    } else if (err.code === 'LIMIT_FILE_COUNT') {
        message = 'Too many files in one upload.';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = 'Unexpected upload field. Please reselect files and try again.';
    }

    const expectsJson = req.path === '/upload-bulk' || req.path.startsWith('/api/');
    if (expectsJson) {
        return res.status(400).json({ success: false, error: message });
    }
    return res.status(400).send(message);
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    const expectsJson = req.path.startsWith('/api/') || req.path === '/upload-bulk';
    if (expectsJson) {
        return res.status(500).json({ success: false, error: 'Unexpected server error' });
    }
    return res.status(500).send('Unexpected server error');
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Studio live on ${HOST}:${PORT}`));
