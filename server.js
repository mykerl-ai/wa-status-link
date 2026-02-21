const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

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

// 3. DASHBOARD
app.get('/', (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus });
});

// 4. BULK UPLOAD (Fixed Syntax)
app.post('/upload-bulk', upload.array('files', 10), async (req, res) => {
    try {
        const prices = Array.isArray(req.body.prices) ? req.body.prices : [req.body.prices];
        const bgColor = req.body.bgColor || "white";
        const results = [];

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const price = prices[i] || "Contact for Price";

            const result = await cloudinary.uploader.upload(file.path, {
                resource_type: "auto",
                eager: [
                    { 
                        effect: "background_removal" 
                    },
                    { 
                        width: 1200, 
                        height: 1200, 
                        crop: "pad", 
                        background: bgColor, 
                        fetch_format: "jpg", 
                        quality: "auto" 
                    }
                ],
                eager_async: false 
            });

            inventoryStatus[result.public_id] = { price, type: result.resource_type, isSoldOut: false, bgColor };

            const host = req.get('host');
            const protocol = req.headers['x-forwarded-proto'] || req.protocol; 
            const link = `${protocol}://${host}/p/${result.public_id}?price=${encodeURIComponent(price)}&bg=${encodeURIComponent(bgColor)}`;
            
            results.push({ 
                link: link, 
                price: price, 
                previewUrl: (result.eager && result.eager[0]) ? result.eager[0].secure_url : result.secure_url 
            });
        }
        res.json({ success: true, items: results });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. PREVIEW ROUTE
app.get('/p/:publicId', (req, res) => {
    const { publicId } = req.params;
    const price = req.query.price || "Contact for Price";
    const bg = req.query.bg || "white";
    const item = inventoryStatus[publicId] || { isSoldOut: false, type: 'image' };

    // Standard transformations
    let trans = [
        { effect: "background_removal" },
        { width: 1200, height: 1200, crop: "pad", background: bg }
    ];

    // Add Sold Out if necessary
    if (item.isSoldOut) {
        trans.push({
            overlay: { font_family: "Arial", font_size: 140, font_weight: "bold", text: "SOLD OUT" },
            color: "white", background: "red", flags: "layer_apply", gravity: "center", angle: -30, opacity: 80
        });
    }

    // Final formatting
    trans.push({ fetch_format: "jpg", quality: "auto" });

    const previewUrl = cloudinary.url(publicId, {
        resource_type: item.type === 'video' ? 'video' : 'image',
        transformation: trans
    });

    res.render('preview', { 
        previewImage: previewUrl, 
        item: { price, isSoldOut: item.isSoldOut, type: item.type }, 
        rawMediaUrl: cloudinary.url(publicId, { resource_type: item.type }),
        publicId: publicId 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
