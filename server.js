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
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
if (supabase) {
    console.log('[Supabase] Using ' + (process.env.SUPABASE_SERVICE_KEY ? 'SERVICE_KEY (bypasses RLS)' : 'ANON_KEY (RLS applies)'));
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

async function loadAuth(req, res, next) {
    req.user = null;
    req.role = null;
    const token = req.cookies[AUTH_COOKIE];
    if (!token || !supabase) return next();
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return next();
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
        req.user = { id: user.id, email: user.email || '' };
        req.role = profile?.role || 'customer';
    } catch (e) { /* ignore */ }
    next();
}

function requireOwner(req, res, next) {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/'));
    if (req.role !== 'owner') return res.redirect('/products');
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
    res.render('login', { user: req.user, role: req.role, error: null, message: req.query.message || null, next: req.query.next || '/' });
});

app.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
    const nextUrl = req.body.next || (req.role === 'owner' ? '/' : '/products');
    if (!supabase) return res.render('login', { user: null, role: null, error: 'Auth not configured', next: nextUrl });
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    if (!email || !password) return res.render('login', { user: null, role: null, error: 'Email and password required', next: nextUrl });
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.render('login', { user: null, role: null, error: error.message, next: nextUrl });
        res.cookie(AUTH_COOKIE, data.session.access_token, COOKIE_OPTS);
        return res.redirect(nextUrl);
    } catch (e) {
        return res.render('login', { user: null, role: null, error: e.message || 'Login failed', next: nextUrl });
    }
});

app.get('/signup', (req, res) => {
    if (req.user && req.role === 'owner') return res.redirect('/');
    if (req.user) return res.redirect('/products');
    res.render('signup', { user: req.user, role: req.role, error: null });
});

app.post('/signup', express.urlencoded({ extended: true }), async (req, res) => {
    if (!supabase) return res.render('signup', { user: null, role: null, error: 'Auth not configured' });
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const displayName = (req.body.displayName || '').trim();
    if (!email || !password) return res.render('signup', { user: null, role: null, error: 'Email and password required' });
    if (password.length < 6) return res.render('signup', { user: null, role: null, error: 'Password must be at least 6 characters' });
    try {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
        if (error) return res.render('signup', { user: null, role: null, error: error.message });
        const { data: existing } = await supabase.from('profiles').select('id').limit(1);
        const isFirstUser = !existing || existing.length === 0;
        const role = isFirstUser ? 'owner' : 'customer';
        await supabase.from('profiles').upsert({ id: data.user.id, role, display_name: displayName || null }, { onConflict: 'id' });
        res.cookie(AUTH_COOKIE, data.session?.access_token, COOKIE_OPTS);
        return res.redirect(data.session ? (role === 'owner' ? '/' : '/products') : '/login?message=Confirm your email to sign in');
    } catch (e) {
        return res.render('signup', { user: null, role: null, error: e.message || 'Sign up failed' });
    }
});

app.post('/logout', (req, res) => {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.redirect(req.query.next || '/products');
});

// 5. DASHBOARD ROUTE (owner only)
app.get('/', requireOwner, (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus, user: req.user, role: req.role });
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

            const host = req.get('host');
            const protocol = req.headers['x-forwarded-proto'] || req.protocol;
            const link = buildProductLink({
                protocol,
                host,
                publicId: result.public_id,
                price,
                bgColor,
                removeBg: shouldRemoveBg && mediaType === 'image',
                badgeLabel,
                mediaType
            });

            results.push({
                link,
                price,
                previewUrl,
                mediaType,
                badgeLabel
            });

            // Save product to Supabase (skipped if SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY not set)
            if (productService) {
                try {
                    await productService.create({
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
            dbSaved: !!productService && !res.locals.dbError,
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
app.get('/products', async (req, res) => {
    if (!productService) {
        return res.render('products', { products: [], error: 'Supabase not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in env.', user: req.user, role: req.role, hasStore: false });
    }
    try {
        const storeId = req.cookies[STORE_COOKIE] || (req.role === 'owner' && req.user ? req.user.id : null);
        if (req.role === 'owner' && req.user && !req.cookies[STORE_COOKIE]) {
            res.cookie(STORE_COOKIE, req.user.id, STORE_COOKIE_OPTS);
        }
        const effectiveStoreId = storeId || (req.role === 'owner' && req.user ? req.user.id : null);
        const products = (await productService.list(effectiveStoreId)).map(withFreshPreviewUrl);
        const hasStore = !!effectiveStoreId;
        res.render('products', { products, error: null, user: req.user, role: req.role, hasStore });
    } catch (err) {
        console.error('Products fetch error:', err);
        res.render('products', { products: [], error: err.message, user: req.user, role: req.role, hasStore: false });
    }
});

// Products — simple card grid (store-scoped)
app.get('/products/simple', async (req, res) => {
    if (!productService) {
        return res.render('products-simple', { products: [], error: 'Supabase not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in env.', user: req.user, role: req.role, hasStore: false });
    }
    try {
        const storeId = req.cookies[STORE_COOKIE] || (req.role === 'owner' && req.user ? req.user.id : null);
        if (req.role === 'owner' && req.user && !req.cookies[STORE_COOKIE]) {
            res.cookie(STORE_COOKIE, req.user.id, STORE_COOKIE_OPTS);
        }
        const effectiveStoreId = storeId || (req.role === 'owner' && req.user ? req.user.id : null);
        const products = (await productService.list(effectiveStoreId)).map(withFreshPreviewUrl);
        const hasStore = !!effectiveStoreId;
        res.render('products-simple', { products, error: null, user: req.user, role: req.role, hasStore });
    } catch (err) {
        console.error('Products fetch error:', err);
        res.render('products-simple', { products: [], error: err.message, user: req.user, role: req.role, hasStore: false });
    }
});

// 7. PREVIEW ROUTE (Crawlers → preview for OG; browsers → premium app view)
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
        mediaType
    });

    const item = { price, isSoldOut: statusItem.isSoldOut, type: mediaType, badgeLabel, size: '', color: '', qty: '' };
    let productOwnerId = null;
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

    const payload = {
        previewImage: previewUrl,
        item,
        rawMediaUrl,
        publicId,
        canonicalLink
    };

    if (isPreviewBot(req)) {
        res.render('preview', payload);
    } else {
        if (productOwnerId) {
            res.cookie(STORE_COOKIE, productOwnerId, STORE_COOKIE_OPTS);
        }
        res.render('preview-app', { ...payload, user: req.user, role: req.role });
    }
});

// 8. CART PAGE
app.get('/cart', (req, res) => {
    res.render('cart', { paystackPublicKey: paystackPublic, user: req.user, role: req.role });
});

// 8b. CART API (persist when signed in)
app.get('/api/cart', async (req, res) => {
    if (!req.user || !supabase) return res.status(401).json({ error: 'Not signed in' });
    try {
        const { data, error } = await supabase.from('carts').select('items').eq('user_id', req.user.id).maybeSingle();
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
        const { error } = await supabase.from('carts').upsert(
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

