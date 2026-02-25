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
     * ownerId = auth user id of the store owner (optional for backfill).
     */
    async create({ publicId, price, link, previewUrl, bgColor = 'white', badgeLabel = '', size = '', color = '', qty = '', ownerId = null, categoryId = null }) {
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
        if (ownerId) payload.owner_id = ownerId;
        if (categoryId) payload.category_id = categoryId;

        let query = this.supabase
            .from(this.table)
            .insert(payload)
            .select('id, public_id, price, link, preview_url, badge_label, size, color, qty, owner_id, category_id, created_at')
            .single();

        let { data, error } = await query;
        if (error && error.code === '42703') {
            delete payload.owner_id;
            delete payload.category_id;
            ({ data, error } = await this.supabase
                .from(this.table)
                .insert(payload)
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
            .select('id, price, link, preview_url, badge_label, size, color, qty, owner_id, category_id, created_at')
            .eq('public_id', publicId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error && error.code === '42703') {
            ({ data, error } = await this.supabase
                .from(this.table)
                .select('id, price, link, preview_url, badge_label, category_id, created_at')
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
            qty: data.qty != null ? String(data.qty) : '',
            ownerId: data.owner_id || null,
            categoryId: data.category_id || null
        };
    }

    /**
     * List products, optionally filtered by owner (store). Newest first.
     * When ownerId is provided, only that store's products are returned.
     */
    async list(ownerId = null, categoryId = null) {
        if (!this.supabase) return [];
        const baseCols = 'id, price, link, preview_url, badge_label, size, color, qty, category_id, created_at';
        let query = this.supabase
            .from(this.table)
            .select(baseCols)
            .order('created_at', { ascending: false });
        if (ownerId) query = query.eq('owner_id', ownerId);
        if (categoryId) query = query.eq('category_id', categoryId);
        let { data, error } = await query;
        if (error && error.code === '42703') {
            query = this.supabase
                .from(this.table)
                .select('id, price, link, preview_url, badge_label, created_at')
                .order('created_at', { ascending: false });
            if (ownerId) query = query.eq('owner_id', ownerId);
            if (categoryId) query = query.eq('category_id', categoryId);
            ({ data, error } = await query);
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
            qty: row.qty != null ? String(row.qty) : '',
            categoryId: row.category_id || null
        }));
    }
}

module.exports = { ProductService };
