const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// 1. CLOUDINARY CONFIG
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_CLOUD_NAME', 
    api_key: process.env.CLOUDINARY_API_KEY || 'YOUR_API_KEY', 
    api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_API_SECRET' 
});

// 2. EXPRESS CONFIG
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. MOCK DATABASE (For tracking "Sold Out" status)
let inventoryStatus = {}; 

// 4. DASHBOARD ROUTE
app.get('/', (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus });
});

// 5. UPLOAD ROUTE
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const price = req.body.price || "Contact for Price";

        // Eagerly process the AI Studio look so the link is ready immediately
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: "auto",
            eager: [
                { effect: "background_removal" },
                { width: 1200, height: 1200, crop: "pad", background: "white", fetch_format: "jpg", quality: "auto" }
            ],
            eager_async: false 
        });
        
        // Store status in memory
        inventoryStatus[result.public_id] = { 
            price: price, 
            type: result.resource_type,
            isSoldOut: false 
        };

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol; 
        
        // BAKE THE PRICE INTO THE URL for maximum reliability
        const link = `${protocol}://${host}/p/${result.public_id}?price=${encodeURIComponent(price)}`;
        
        res.json({ success: true, link });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. TOGGLE SOLD OUT ROUTE
app.post('/toggle-sold-out', (req, res) => {
    const { id } = req.body;
    if (inventoryStatus[id]) {
        inventoryStatus[id].isSoldOut = !inventoryStatus[id].isSoldOut;
        res.json({ success: true, newState: inventoryStatus[id].isSoldOut });
    } else {
        res.status(404).json({ success: false, error: "Item not found" });
    }
});

// 7. THE WHATSAPP PREVIEW ROUTE (Picks Price from Link)
app.get('/p/:publicId', (req, res) => {
    const { publicId } = req.params;
    
    // PRIORITY 1: Get price from the URL query string (?price=...)
    // PRIORITY 2: Get price from our internal memory
    const urlPrice = req.query.price;
    const dbItem = inventoryStatus[publicId];
    
    const displayPrice = urlPrice || (dbItem ? dbItem.price : "Price upon Request");
    const isSoldOut = dbItem ? dbItem.isSoldOut : false;
    const itemType = dbItem ? dbItem.type : (req.query.type || 'image');

    // Build the AI Studio Preview URL
    // We use the same transformation used in 'eager' so Cloudinary serves the cached file instantly
    let previewUrl = cloudinary.url(publicId, {
        resource_type: itemType === 'video' ? 'video' : 'image',
        transformation: [
            { effect: "background_removal" },
            { width: 1200, height: 1200, crop: "pad", background: "white" },
            // If Sold Out, add the Red Badge on the fly
            ...(isSoldOut ? [{
                overlay: { font_family: "Arial", font_size: 140, font_weight: "bold", text: "SOLD OUT" },
                color: "white", background: "red", flags: "layer_apply", gravity: "center", angle: -30, opacity: 80
            }] : []),
            { fetch_format: "jpg", quality: "auto" }
        ]
    });

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: itemType });

    res.render('preview', { 
        previewImage: previewUrl, 
        item: { price: displayPrice, isSoldOut: isSoldOut, type: itemType }, 
        rawMediaUrl: rawMediaUrl, 
        publicId: publicId 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
