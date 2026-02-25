const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');

const { createClient } = require('@supabase/supabase-js');
const { PaystackService } = require('./lib/PaystackService');
const { OrderService } = require('./lib/OrderService');
const { ProductService } = require('./lib/ProductService');
const {
    normalizeBadgeLabel,
    buildImageTransformations,
    buildProductLink,
    buildVideoAnimatedPreviewUrl,
    buildVideoOgPreviewUrl,
    buildImagePreviewUrl
} = require('./lib/MediaPipeline');

const app = express();
const upload = multer({ dest: 'uploads/' });
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

const AUTH_COOKIE = 'sb-access-token';
const STORE_COOKIE = 'store';
const COOKIE_OPTS = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
const STORE_COOKIE_OPTS = { httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
const STORE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
        name: row.name || ''
    };
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
    const { data, error } = await supabaseClient
        .from('stores')
        .select('id, owner_id, slug, name')
        .eq('slug', storeSlug)
        .maybeSingle();
    if (error) throw error;
    return mapStoreRow(data);
}

async function findStoreByOwnerId(ownerId, supabaseClient = supabase) {
    if (!supabaseClient || !ownerId) return null;
    const { data, error } = await supabaseClient
        .from('stores')
        .select('id, owner_id, slug, name')
        .eq('owner_id', ownerId)
        .maybeSingle();
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
            .select('id, owner_id, slug, name')
            .single();
        if (error) {
            if (error.code === '42501') {
                throw new Error('Store update blocked by database policy. Run the latest supabase-schema.sql and retry.');
            }
            throw error;
        }
        return mapStoreRow(data);
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
            .select('id, owner_id, slug, name')
            .single();
        if (!error) return mapStoreRow(data);
        if (error.code === '23505') continue;
        if (error.code === '42501') {
            throw new Error('Store creation blocked by database policy. Run the latest supabase-schema.sql and retry.');
        }
        throw error;
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
        return res.redirect('/');
    } catch (e) {
        return res.render('create-store', {
            user: req.user,
            role: req.role,
            error: e.message || 'Could not create store',
            initialName: storeName
        });
    }
});

function logoutAndRedirect(req, res) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    const nextPath = sanitizeRedirectPath(req.query.next || req.body?.next || '/products', '/products');
    res.redirect(nextPath);
}

app.get('/logout', logoutAndRedirect);
app.post('/logout', logoutAndRedirect);

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
app.post('/upload-bulk', requireOwner, upload.array('files', 10), async (req, res) => {
    try {
        const prices = Array.isArray(req.body.prices) ? req.body.prices : [req.body.prices];
        const bgColor = req.body.bgColor || "white";
        const shouldRemoveBg = String(req.body.removeBg) === 'true';
        const watermarkText = req.body.watermarkText ? String(req.body.watermarkText).trim() : "";
        const badgeLabel = normalizeBadgeLabel(req.body.badgeLabel);
        const size = normalizeSingleField(req.body.size);
        const color = normalizeSingleField(req.body.color);
        const qty = normalizeSingleField(req.body.qty);
        const results = [];
        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const requestSupabase = getRequestSupabase(req) || supabase;
        const scopedProductService = requestSupabase && !supabaseServiceKey
            ? new ProductService(requestSupabase)
            : productService;
        let ownerStore = null;

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

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const price = prices[i] || "Contact for Price";
            const mediaType = (file.mimetype || '').startsWith('video/') ? 'video' : 'image';
            const uploadOptions = { resource_type: mediaType };
            if (mediaType === 'image') {
                uploadOptions.transformation = buildImageTransformations({
                    shouldRemoveBg,
                    bgColor,
                    watermarkText,
                    badgeLabel
                });
            }

            const result = await cloudinary.uploader.upload(file.path, uploadOptions);
            const previewUrl = mediaType === 'video'
                ? buildVideoAnimatedPreviewUrl(cloudinary, result.public_id)
                : buildImagePreviewUrl(cloudinary, {
                    publicId: result.public_id,
                    bgColor
                });

            inventoryStatus[result.public_id] = {
                price,
                type: mediaType,
                isSoldOut: false,
                badgeLabel
            };
            const link = buildProductLink({
                protocol,
                host,
                publicId: result.public_id,
                price,
                bgColor,
                removeBg: shouldRemoveBg && mediaType === 'image',
                badgeLabel,
                mediaType,
                storeSlug: ownerStore?.slug || ''
            });

            results.push({
                link,
                price,
                previewUrl,
                mediaType,
                badgeLabel,
                storeSlug: ownerStore?.slug || ''
            });

            // Save product to Supabase (skipped if SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY not set)
            if (scopedProductService) {
                try {
                    await scopedProductService.create({
                        publicId: result.public_id,
                        price,
                        link,
                        previewUrl,
                        bgColor,
                        badgeLabel,
                        size,
                        color,
                        qty,
                        ownerId: req.user ? req.user.id : null
                    });
                } catch (dbErr) {
                    console.error('Product save error:', dbErr.message, dbErr.code || '', dbErr.details || '');
                    if (!res.locals.dbError) res.locals.dbError = dbErr.message;
                    if (dbErr.code === '42703') console.error('Tip: run ALTER TABLE in supabase-schema.sql to add size, color, qty columns.');
                }
            }
        }
        res.json({
            success: true,
            items: results,
            dbSaved: !!scopedProductService && !res.locals.dbError,
            dbError: res.locals.dbError || null
        });
    } catch (err) {
        console.error("Cloudinary Error:", err);
        res.status(500).json({ success: false, error: err.message });
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

        const products = store
            ? (await productService.list(store.ownerId)).map(withFreshPreviewUrl)
            : [];
        const storePath = store?.slug ? storePathFromSlug(store.slug) : null;
        const storeLink = storePath ? absoluteUrlFromPath(req, storePath) : null;

        return res.render(viewName, {
            products,
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
    const { publicId } = req.params;
    const price = req.query.price || "Contact for Price";
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
    const item = { price, isSoldOut: statusItem.isSoldOut, type: mediaType, badgeLabel, size: '', color: '', qty: '' };
    let productOwnerId = null;
    let ownerStore = null;
    if (productService) {
        try {
            const product = await productService.getByPublicId(publicId);
            if (product) {
                item.size = product.size || '';
                item.color = product.color || '';
                item.qty = product.qty || '';
                productOwnerId = product.ownerId || null;
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

    const fallbackStoreSlug = sanitizeStoreSlug(req.query.store || req.cookies[STORE_COOKIE] || '');
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
app.get('/cart', (req, res) => {
    res.render('cart', {
        paystackPublicKey: paystackPublic,
        user: req.user,
        role: req.role,
        canCreateStore: req.role !== 'owner',
        createStoreHref: getCreateStoreHref(req)
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

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Studio live on ${HOST}:${PORT}`));


