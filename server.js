const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');

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

let inventoryStatus = {}; 

// 3. HEALTH CHECK
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 4. DASHBOARD ROUTE
app.get('/', (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus });
});

// 5. BULK UPLOAD ROUTE (Image/video + AI improve + optional overlays)
app.post('/upload-bulk', upload.array('files', 10), async (req, res) => {
    try {
        const prices = Array.isArray(req.body.prices) ? req.body.prices : [req.body.prices];
        const bgColor = req.body.bgColor || "white";
        const shouldRemoveBg = String(req.body.removeBg) === 'true';
        const watermarkText = req.body.watermarkText ? String(req.body.watermarkText).trim() : "";
        const badgeLabel = normalizeBadgeLabel(req.body.badgeLabel);
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
                    bgColor,
                    removeBg: shouldRemoveBg,
                    badgeLabel
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
                mediaType
            });

            // Save product to Supabase (skipped if SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY not set)
            if (productService) {
                try {
                    await productService.create({
                        publicId: result.public_id,
                        price,
                        link,
                        previewUrl,
                        bgColor
                    });
                } catch (dbErr) {
                    console.error('Product save error:', dbErr.message, dbErr.code || '', dbErr.details || '');
                    if (!res.locals.dbError) res.locals.dbError = dbErr.message;
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
        const removeBg = parsedLink.searchParams.get('rm') === 'true';
        const badgeLabel = normalizeBadgeLabel(parsedLink.searchParams.get('badge') || '');

        return {
            ...product,
            previewUrl: buildImagePreviewUrl(cloudinary, {
                publicId,
                bgColor,
                removeBg,
                badgeLabel
            })
        };
    } catch {
        return product;
    }
}

// 6. PRODUCTS PAGE (from Supabase via ProductService)
app.get('/products', async (req, res) => {
    if (!productService) {
        return res.render('products', { products: [], error: 'Supabase not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in env.' });
    }
    try {
        const products = (await productService.list()).map(withFreshPreviewUrl);
        res.render('products', { products, error: null });
    } catch (err) {
        console.error('Products fetch error:', err);
        res.render('products', { products: [], error: err.message });
    }
});

// 7. PREVIEW ROUTE (Crawlers → preview for OG; browsers → premium app view)
function isPreviewBot(req) {
    const ua = (req.get('User-Agent') || '').toLowerCase();
    const bots = ['whatsapp', 'telegram', 'slack', 'discord', 'facebookexternalhit', 'facebot', 'twitter', 'linkedin', 'pinterest', 'snapchat', 'line-poker', 'line-sheriff', 'googlebot', 'bingbot'];
    return bots.some(bot => ua.includes(bot));
}

app.get('/p/:publicId', (req, res) => {
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
            bgColor: bg,
            removeBg: shouldRemoveBg,
            badgeLabel
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

    const payload = {
        previewImage: previewUrl,
        item: { price, isSoldOut: statusItem.isSoldOut, type: mediaType },
        rawMediaUrl,
        publicId,
        canonicalLink
    };

    if (isPreviewBot(req)) {
        res.render('preview', payload);
    } else {
        res.render('preview-app', payload);
    }
});

// 8. CART PAGE
app.get('/cart', (req, res) => {
    res.render('cart', { paystackPublicKey: paystackPublic });
});

// 9. PAYMENT API (OOP: PaystackService + OrderService)
app.post('/api/payment/initialize', async (req, res) => {
    if (!paystackService || !orderService) {
        return res.status(503).json({ success: false, error: 'Payment not configured' });
    }
    try {
        const { email, items } = req.body;
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

