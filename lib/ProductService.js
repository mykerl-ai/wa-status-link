/**
 * Product service (OOP). Saves and lists products in Supabase.
 */
class ProductService {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.table = 'products';
        this.mediaTable = 'product_media';
    }

    /**
     * Insert a product. Returns { id, public_id, ... } or throws.
     * ownerId = auth user id of the store owner (optional for backfill).
     */
    async create({
        publicId,
        price,
        link,
        previewUrl,
        bgColor = 'white',
        badgeLabel = '',
        size = '',
        color = '',
        qty = '',
        ownerId = null,
        categoryId = null,
        mediaItems = []
    }) {
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

        // Optional media attachments table. Keep product create resilient if schema isn't migrated yet.
        const normalizedMedia = Array.isArray(mediaItems)
            ? mediaItems
                .map((m, idx) => ({
                    product_id: data.id,
                    owner_id: ownerId || null,
                    public_id: String(m?.publicId || '').trim(),
                    media_type: String(m?.mediaType || 'image').toLowerCase() === 'video' ? 'video' : 'image',
                    preview_url: String(m?.previewUrl || '').trim(),
                    source_url: String(m?.sourceUrl || '').trim(),
                    sort_order: Number.isFinite(Number(m?.sortOrder)) ? Number(m.sortOrder) : idx
                }))
                .filter((m) => !!m.public_id)
            : [];
        if (normalizedMedia.length > 0) {
            const { error: mediaErr } = await this.supabase
                .from(this.mediaTable)
                .insert(normalizedMedia);
            if (mediaErr && mediaErr.code !== '42P01' && mediaErr.code !== '42703' && mediaErr.code !== 'PGRST205') {
                throw mediaErr;
            }
        }

        return data;
    }

    /**
     * Get one product by public_id (e.g. Cloudinary public_id). Returns null if not found.
     */
    async getByPublicId(publicId) {
        if (!this.supabase || !publicId) return null;
        const safePublicId = String(publicId || '').trim();
        if (!safePublicId) return null;

        let { data, error } = await this.supabase
            .from(this.table)
            .select('id, price, link, preview_url, badge_label, size, color, qty, owner_id, category_id, created_at')
            .eq('public_id', safePublicId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error && error.code === '42703') {
            ({ data, error } = await this.supabase
                .from(this.table)
                .select('id, price, link, preview_url, badge_label, category_id, created_at')
                .eq('public_id', safePublicId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle());
        }

        // Fallback lookup for links that target a media public_id.
        if ((!data || error) && (!error || error.code === 'PGRST116')) {
            const { data: mediaRow, error: mediaErr } = await this.supabase
                .from(this.mediaTable)
                .select('product_id')
                .eq('public_id', safePublicId)
                .limit(1)
                .maybeSingle();
            if (!mediaErr && mediaRow?.product_id) {
                ({ data, error } = await this.supabase
                    .from(this.table)
                    .select('id, price, link, preview_url, badge_label, size, color, qty, owner_id, category_id, created_at')
                    .eq('id', mediaRow.product_id)
                    .maybeSingle());
            } else if (mediaErr && mediaErr.code !== '42P01' && mediaErr.code !== '42703' && mediaErr.code !== 'PGRST205') {
                return null;
            }
        }

        if (error || !data) return null;

        let mediaItems = [];
        const { data: mediaRows, error: mediaErr } = await this.supabase
            .from(this.mediaTable)
            .select('public_id, media_type, preview_url, source_url, sort_order, created_at')
            .eq('product_id', data.id)
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: true });
        if (!mediaErr && Array.isArray(mediaRows)) {
            mediaItems = mediaRows.map((m) => ({
                publicId: m.public_id,
                mediaType: m.media_type === 'video' ? 'video' : 'image',
                previewUrl: m.preview_url || '',
                sourceUrl: m.source_url || '',
                sortOrder: Number.isFinite(Number(m.sort_order)) ? Number(m.sort_order) : 0
            }));
        } else if (mediaErr && mediaErr.code !== '42P01' && mediaErr.code !== '42703' && mediaErr.code !== 'PGRST205') {
            return null;
        }

        const primaryPreview = mediaItems.length && mediaItems[0].previewUrl
            ? mediaItems[0].previewUrl
            : data.preview_url;
        return {
            id: data.id,
            price: data.price,
            link: data.link,
            previewUrl: primaryPreview,
            badgeLabel: data.badge_label || '',
            size: data.size != null ? String(data.size) : '',
            color: data.color != null ? String(data.color) : '',
            qty: data.qty != null ? String(data.qty) : '',
            ownerId: data.owner_id || null,
            categoryId: data.category_id || null,
            mediaItems,
            mediaUrls: mediaItems.map((m) => m.previewUrl).filter(Boolean),
            mediaCount: mediaItems.length || 1
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
        const items = (data || []).map(row => ({
            id: row.id,
            price: row.price,
            link: row.link,
            previewUrl: row.preview_url,
            badgeLabel: row.badge_label || '',
            size: row.size != null ? String(row.size) : '',
            color: row.color != null ? String(row.color) : '',
            qty: row.qty != null ? String(row.qty) : '',
            categoryId: row.category_id || null,
            mediaItems: [],
            mediaUrls: row.preview_url ? [row.preview_url] : [],
            mediaCount: 1
        }));

        if (!items.length) return items;
        const productIds = items.map((item) => item.id).filter(Boolean);
        if (!productIds.length) return items;

        const { data: mediaRows, error: mediaErr } = await this.supabase
            .from(this.mediaTable)
            .select('product_id, public_id, media_type, preview_url, source_url, sort_order, created_at')
            .in('product_id', productIds)
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: true });

        if (mediaErr && mediaErr.code !== '42P01' && mediaErr.code !== '42703' && mediaErr.code !== 'PGRST205') {
            throw mediaErr;
        }
        if (!mediaErr && Array.isArray(mediaRows) && mediaRows.length) {
            const grouped = new Map();
            mediaRows.forEach((row) => {
                const key = row.product_id;
                if (!key) return;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push({
                    publicId: row.public_id,
                    mediaType: row.media_type === 'video' ? 'video' : 'image',
                    previewUrl: row.preview_url || '',
                    sourceUrl: row.source_url || '',
                    sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0
                });
            });
            items.forEach((item) => {
                const media = grouped.get(item.id) || [];
                if (!media.length) return;
                item.mediaItems = media;
                item.mediaUrls = media.map((m) => m.previewUrl).filter(Boolean);
                item.mediaCount = media.length;
                if (media[0]?.previewUrl) item.previewUrl = media[0].previewUrl;
            });
        }

        return items;
    }
}

module.exports = { ProductService };
