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
    async create({ publicId, price, link, previewUrl, bgColor = 'white', badgeLabel = '', size = '', color = '', qty = '' }) {
        if (!this.supabase) throw new Error('Supabase not configured');
        const payload = {
            public_id: publicId,
            price: price || 'Contact for Price',
            link,
            preview_url: previewUrl,
            bg_color: bgColor,
            badge_label: badgeLabel || '',
            size: String(size || '').trim(),
            color: String(color || '').trim(),
            qty: String(qty || '').trim()
        };

        let query = this.supabase
            .from(this.table)
            .insert(payload)
            .select('id, public_id, price, link, preview_url, badge_label, size, color, qty, created_at')
            .single();

        let { data, error } = await query;
        if (error && error.code === '42703') {
            const legacyPayload = {
                public_id: publicId,
                price: price || 'Contact for Price',
                link,
                preview_url: previewUrl,
                bg_color: bgColor,
                badge_label: badgeLabel || ''
            };
            ({ data, error } = await this.supabase
                .from(this.table)
                .insert(legacyPayload)
                .select('id, public_id, price, link, preview_url, badge_label, created_at')
                .single());
        }
        if (error) throw error;
        return data;
    }

    /**
     * Get one product by public_id (e.g. Cloudinary public_id). Returns null if not found.
     */
    async getByPublicId(publicId) {
        if (!this.supabase || !publicId) return null;
        let { data, error } = await this.supabase
            .from(this.table)
            .select('id, price, link, preview_url, badge_label, size, color, qty, created_at')
            .eq('public_id', publicId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error && error.code === '42703') {
            ({ data, error } = await this.supabase
                .from(this.table)
                .select('id, price, link, preview_url, badge_label, created_at')
                .eq('public_id', publicId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle());
        }
        if (error || !data) return null;
        return {
            id: data.id,
            price: data.price,
            link: data.link,
            previewUrl: data.preview_url,
            badgeLabel: data.badge_label || '',
            size: data.size != null ? String(data.size) : '',
            color: data.color != null ? String(data.color) : '',
            qty: data.qty != null ? String(data.qty) : ''
        };
    }

    /**
     * List all products, newest first.
     */
    async list() {
        if (!this.supabase) return [];
        let { data, error } = await this.supabase
            .from(this.table)
            .select('id, price, link, preview_url, badge_label, size, color, qty, created_at')
            .order('created_at', { ascending: false });
        if (error && error.code === '42703') {
            ({ data, error } = await this.supabase
                .from(this.table)
                .select('id, price, link, preview_url, badge_label, created_at')
                .order('created_at', { ascending: false }));
        }
        if (error) throw error;
        return (data || []).map(row => ({
            id: row.id,
            price: row.price,
            link: row.link,
            previewUrl: row.preview_url,
            badgeLabel: row.badge_label || '',
            size: row.size != null ? String(row.size) : '',
            color: row.color != null ? String(row.color) : '',
            qty: row.qty != null ? String(row.qty) : ''
        }));
    }
}

module.exports = { ProductService };
