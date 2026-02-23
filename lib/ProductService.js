/**
 * Product service (OOP). Saves and lists products in Supabase.
 */
class ProductService {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.table = 'products';
    }

    /**
     * Insert a product. Returns { id, public_id, ... } or throws.
     */
    async create({ publicId, price, link, previewUrl, bgColor = 'white' }) {
        if (!this.supabase) throw new Error('Supabase not configured');
        const { data, error } = await this.supabase
            .from(this.table)
            .insert({
                public_id: publicId,
                price: price || 'Contact for Price',
                link,
                preview_url: previewUrl,
                bg_color: bgColor
            })
            .select('id, public_id, price, link, preview_url, created_at')
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * List all products, newest first.
     */
    async list() {
        if (!this.supabase) return [];
        const { data, error } = await this.supabase
            .from(this.table)
            .select('id, price, link, preview_url, created_at')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(row => ({
            id: row.id,
            price: row.price,
            link: row.link,
            previewUrl: row.preview_url
        }));
    }
}

module.exports = { ProductService };
