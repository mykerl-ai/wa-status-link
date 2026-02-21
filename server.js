const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path'); // FIX: Added path module

const app = express();
const upload = multer({ dest: 'uploads/' });

// 1. CLOUDINARY CONFIG
// It is best practice to use environment variables for Render
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_CLOUD_NAME', 
    api_key: process.env.CLOUDINARY_API_KEY || 'YOUR_API_KEY', 
    api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_API_SECRET' 
});

// 2. EXPRESS CONFIG
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // FIX: Ensures correct folder mapping on Render
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. MOCK DATABASE
// This stores the price and status so it's not lost in the URL
let inventoryStatus = {}; 

// 4. DASHBOARD ROUTE
app.get('/', (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus });
});

// 5. UPLOAD ROUTE (With "Eager" AI Processing)
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const price = req.body.price || "Contact for Price";

        // FIX: We do the heavy AI work NOW, before giving the link to the vendor.
        // This prevents the WhatsApp bot from timing out.
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: "auto",
            eager: [
                { effect: "background_removal" },
                { effect: "gen_background:prompt_minimalist professional studio floor with soft shadows" },
                { width: 1200, height: 1200, crop: "pad", background: "gen_fill", fetch_format: "jpg", quality: "auto" }
            ],
            eager_async: false // Forces server to wait until AI is 100% finished
        });
        
        // Save data to our memory "database"
        inventoryStatus[result.public_id] = { 
            price: price, 
            type: result.resource_type,
            isSoldOut: false,
            // We save the exact URL of the instantly-ready AI image
            eagerUrl: result.eager ? result.eager[0].secure_url : result.secure_url 
        };

        // Determine the correct protocol for Render vs Localhost
        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol; 
        const link = `${protocol}://${host}/p/${result.public_id}`;
        
        res.json({ success: true, link });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. TOGGLE SOLD OUT ROUTE (For the Dashboard)
app.post('/toggle-sold-out', (req, res) => {
    const { id } = req.body;
    if (inventoryStatus[id]) {
        inventoryStatus[id].isSoldOut = !inventoryStatus[id].isSoldOut;
        res.json({ success: true, newState: inventoryStatus[id].isSoldOut });
    } else {
        res.status(404).json({ success: false, error: "Item not found" });
    }
});

// 7. THE WHATSAPP PREVIEW ROUTE
app.get('/p/:publicId', (req, res) => {
    const { publicId } = req.params;
    
    // Fetch item from our database, or provide fallback
    const item = inventoryStatus[publicId] || { 
        price: "Price upon Request", 
        isSoldOut: false, 
        type: 'image',
        eagerUrl: cloudinary.url(publicId, { width: 1200, height: 1200, crop: "pad", fetch_format: "jpg" })
    };

    let previewUrl = item.eagerUrl;

    // If marked "Sold Out", we dynamically stamp the image
    if (item.isSoldOut) {
        previewUrl = cloudinary.url(publicId, {
            resource_type: item.type === 'video' ? 'video' : 'image',
            transformation: [
                // We re-apply the base config so Cloudinary uses the cached AI result instantly
                { effect: "background_removal" },
                { effect: "gen_background:prompt_minimalist professional studio floor with soft shadows" },
                { width: 1200, height: 1200, crop: "pad", background: "gen_fill" },
                // Apply the Red SOLD OUT badge
                {
                    overlay: { font_family: "Arial", font_size: 140, font_weight: "bold", text: "SOLD OUT" },
                    color: "white", background: "red", flags: "layer_apply", gravity: "center", angle: -30, opacity: 80
                },
                { fetch_format: "jpg", quality: "auto" }
            ]
        });
    }

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: item.type });

    // Renders the views/preview.ejs file
    res.render('preview', { 
        previewImage: previewUrl, 
        item: item, 
        rawMediaUrl: rawMediaUrl, 
        publicId: publicId 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running beautifully on port ${PORT}`));
