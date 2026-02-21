const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const app = express();
const upload = multer({ dest: 'uploads/' });

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // This ensures it finds the folder correctly

app.use(express.json());

// --- MOCK DATABASE ---
// In a real app, use MongoDB or Supabase. 
// This tracks if a PublicID is "sold out".
let inventoryStatus = {}; 

// --- 1. THE DASHBOARD ---
app.get('/', (req, res) => {
    res.render('dashboard', { inventory: inventoryStatus });
});

// --- 2. THE UPLOAD LOGIC (With AI Enhancements) ---
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: "auto",
            // This tags the upload so we can find it later
            tags: "whatsapp_vendor_tool" 
        });
        
        inventoryStatus[result.public_id] = { 
            price: req.body.price, 
            isSoldOut: false,
            type: result.resource_type 
        };

        const host = req.get('host');
        const link = `https://${host}/p/${result.public_id}`;
        res.json({ success: true, link });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 3. TOGGLE SOLD OUT ---
app.post('/toggle-sold-out', (req, res) => {
    const { id } = req.body;
    if (inventoryStatus[id]) {
        inventoryStatus[id].isSoldOut = !inventoryStatus[id].isSoldOut;
        res.json({ success: true, newState: inventoryStatus[id].isSoldOut });
    }
});

// --- 4. THE SMART PREVIEW TRAP ---
app.get('/p/:publicId', (req, res) => {
    const { publicId } = req.params;
    const item = inventoryStatus[publicId] || { price: "Inquiry", isSoldOut: false, type: 'image' };

    // --- THE "STUDIO" TRANSFORMATION ---
    let transformations = [
        // 1. Strip the background using AI
        { effect: "background_removal" },
        
        // 2. AI generates a professional studio floor & lighting
        // This is the "Standout" feature that fixes perspective automatically
        { effect: "gen_background:prompt_minimalist professional product photography studio floor with soft shadows" },
        
        // 3. Enhance the product colors (Auto-WB and contrast)
        { effect: "improve:outdoor" },

        // 4. Square it for the Max WhatsApp Card size
        // b_gen_fill ensures the AI fills any empty space created by the squaring
        { width: 1200, height: 1200, crop: "pad", background: "gen_fill" }
    ];

    // If sold out, slap the watermark on top of the AI-generated studio shot
    if (item.isSoldOut) {
        transformations.push({
            overlay: { font_family: "Arial", font_size: 140, font_weight: "bold", text: "SOLD OUT" },
            color: "white", background: "red", flags: "layer_apply", gravity: "center", angle: -30, opacity: 80
        });
    }

    const previewImage = cloudinary.url(publicId, {
        resource_type: item.type === 'video' ? 'video' : 'image',
        transformation: transformations,
        fetch_format: "jpg",
        quality: "auto"
    });

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: item.type });

    res.render('preview', { previewImage, item, rawMediaUrl, publicId });
});


app.listen(process.env.PORT || 3000);

