const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { PaystackService } = require('./lib/PaystackService');
const { OrderService } = require('./lib/OrderService');

const app = express();
const upload = multer({ dest: 'uploads/' });

const supabaseUrl = process.env.SUPABASE_URL || 'https://jfsqdzfeqgfmmkfzhrmq.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';
const paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';
const paystackService = paystackSecret ? new PaystackService(paystackSecret) : null;
const orderService = supabase ? new OrderService(supabase) : null;

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

// 5. BULK UPLOAD ROUTE (With Optional BG Removal & Watermark)
app.post('/upload-bulk', upload.array('files', 10), async (req, res) => {
    try {
        const prices = Array.isArray(req.body.prices) ? req.body.prices : [req.body.prices];
        const bgColor = req.body.bgColor || "white";
        const shouldRemoveBg = String(req.body.removeBg) === 'true';
        const watermarkText = req.body.watermarkText ? String(req.body.watermarkText).trim() : "";
        const results = [];

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const price = prices[i] || "Contact for Price";

            let transformations = [];
            
            if (shouldRemoveBg) {
                transformations.push({ effect: "background_removal" });
            }
            
            transformations.push({ width: 800, height: 1200, crop: "pad", background: bgColor });

            if (watermarkText !== "") {
                // Fixed: Using the string-based overlay format to avoid "component - 0" errors
                transformations.push({
                    overlay: { 
                        font_family: "Arial", 
                        font_size: 40, 
                        font_weight: "bold", 
                        text: watermarkText.toUpperCase() 
                    },
                    color: bgColor === 'white' ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.5)",
                    gravity: "south_east", x: 25, y: 25
                });
            }

            transformations.push({ quality: "auto:best", fetch_format: "jpg", dpr: "2.0" });

            const result = await cloudinary.uploader.upload(file.path, {
                resource_type: "auto",
                transformation: transformations // Use 'transformation' instead of 'eager' for direct upload styling
            });

            inventoryStatus[result.public_id] = { price, type: result.resource_type, isSoldOut: false };

            const host = req.get('host');
            const protocol = req.headers['x-forwarded-proto'] || req.protocol; 
            const link = `${protocol}://${host}/p/${result.public_id}?price=${encodeURIComponent(price)}&bg=${encodeURIComponent(bgColor)}`;
            
            results.push({ 
                link: link, 
                price: price, 
                previewUrl: result.secure_url 
            });

            if (supabase) {
                try {
                    await supabase.from('products').insert({
                        public_id: result.public_id,
                        price,
                        link,
                        preview_url: result.secure_url,
                        bg_color: bgColor
                    });
                } catch (dbErr) {
                    console.error('Supabase insert error:', dbErr.message);
                }
            }
        }
        res.json({ success: true, items: results });
    } catch (err) {
        console.error("Cloudinary Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. PRODUCTS PAGE (from Supabase)
app.get('/products', async (req, res) => {
    if (!supabase) {
        return res.render('products', { products: [], error: 'Supabase not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in env.' });
    }
    try {
        const { data, error } = await supabase
            .from('products')
            .select('id, price, link, preview_url, created_at')
            .order('created_at', { ascending: false });
        if (error) throw error;
        const products = (data || []).map(row => ({
            id: row.id,
            price: row.price,
            link: row.link,
            previewUrl: row.preview_url
        }));
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
    const item = inventoryStatus[publicId] || { isSoldOut: false, type: 'image' };

    const previewUrl = cloudinary.url(publicId, {
        resource_type: item.type === 'video' ? 'video' : 'image',
        transformation: [
            ...(req.query.rm === 'true' ? [{ effect: "background_removal" }] : []),
            { width: 800, height: 1200, crop: "pad", background: bg },
            { quality: "auto:best", fetch_format: "jpg", dpr: "2.0" }
        ]
    });

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: item.type });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const canonicalLink = `${protocol}://${host}/p/${publicId}?price=${encodeURIComponent(price)}&bg=${encodeURIComponent(bg)}`;

    const payload = {
        previewImage: previewUrl,
        item: { price, isSoldOut: item.isSoldOut, type: item.type },
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
        console.error('Payment init error:', err);
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

