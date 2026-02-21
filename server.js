const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const app = express();
const upload = multer({ dest: 'uploads/' });

// 1. CLOUDINARY CONFIG
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET 
  });

app.set('view engine', 'ejs');
app.use(express.static('public'));

// 2. VENDOR DASHBOARD (Upload Form)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; display:flex; flex-direction:column; align-items:center; background:#f0f2f5;">
            <div style="background:white; padding:2rem; border-radius:12px; margin-top:50px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
                <h2>WhatsApp Status Link Generator</h2>
                <form action="/upload" method="POST" enctype="multipart/form-data">
                    <input type="file" name="file" required style="display:block; margin-bottom:15px;">
                    <input type="text" name="price" placeholder="Price (e.g. N25,000)" required style="width:100%; padding:10px; margin-bottom:15px; border:1px solid #ccc;">
                    <button type="submit" style="width:110%; background:#25D366; color:white; border:none; padding:12px; font-weight:bold; cursor:pointer;">Generate Permanent Link</button>
                </form>
            </div>
        </body>
    `);
});

// 3. UPLOAD HANDLER
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: "auto" // Handles both images and videos
        });
        
        // Construct the permanent link
        const protocol = req.protocol;
        const host = req.get('host');
        const permanentLink = `${protocol}://${host}/p/${result.public_id}?price=${encodeURIComponent(req.body.price)}&type=${result.resource_type}`;
        
        res.send(`
            <body style="font-family:sans-serif; text-align:center; padding:50px;">
                <h3>Success! Copy this link to your Status:</h3>
                <input id="link" value="${permanentLink}" readonly style="width:80%; padding:10px; text-align:center;">
                <br><br>
                <button onclick="navigator.clipboard.writeText(document.getElementById('link').value)" style="padding:10px 20px; background:#007bff; color:white; border:none; cursor:pointer;">Copy Link</button>
                <p><a href="/">Upload another</a></p>
            </body>
        `);
    } catch (err) {
        res.status(500).send("Upload failed: " + err.message);
    }
});

// 4. THE PERMANENT PRODUCT PAGE (The WhatsApp Scraper Target)
app.get('/p/:publicId', (req, res) => {
    const { publicId } = req.params;
    const { price, type } = req.query;

    // Transformation: Pad to 1.91:1 (1200x630) for WhatsApp Large Card
    // If it's a video, Cloudinary automatically grabs a frame if we change extension to .jpg
    const previewImage = cloudinary.url(publicId, {
        transformation: [
            { width: 1200, height: 630, crop: "pad", background: "auto", fetch_format: "jpg" }
        ]
    });

    const rawMediaUrl = cloudinary.url(publicId, { resource_type: type || "image" });

    // The HTML returned contains the OG tags WhatsApp needs
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Product Details</title>
            <meta property="og:title" content="Price: ${price}">
            <meta property="og:description" content="View product and chat with vendor">
            <meta property="og:image" content="${previewImage}">
            <meta property="og:image:width" content="1200">
            <meta property="og:image:height" content="630">
            <meta property="og:type" content="website">
            <meta name="twitter:card" content="summary_large_image">
        </head>
        <body style="font-family:sans-serif; text-align:center; padding:20px;">
            <h2>Product Price: ${price}</h2>
            ${type === 'video' 
                ? `<video controls style="width:100%; max-width:400px;"><source src="${rawMediaUrl}" type="video/mp4"></video>` 
                : `<img src="${rawMediaUrl}" style="width:100%; max-width:400px;">`
            }
            <br><br>
            <a href="https://wa.me/YOUR_VENDOR_NUMBER" style="background:#25D366; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-weight:bold;">
                Order via WhatsApp
            </a>
        </body>
        </html>
    `);
});

app.listen(3000, () => console.log('Server running on port 3000'));