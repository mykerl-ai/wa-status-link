/**
 * Category service. CRUD for owner-scoped product categories.
 */
class CategoryService {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.table = 'categories';
    }

    slugify(name) {
        return String(name || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'uncategorized';
    }

    async list(ownerId) {
        if (!this.supabase || !ownerId) return [];
        const { data, error } = await this.supabase
            .from(this.table)
            .select('id, name, slug, sort_order')
            .eq('owner_id', ownerId)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });
        if (error) throw error;
        return (data || []).map(r => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            sortOrder: r.sort_order
        }));
    }

    async create({ ownerId, name }) {
        if (!this.supabase || !ownerId || !name) throw new Error('ownerId and name required');
        const slug = this.slugify(name);
        const { data: existing } = await this.supabase
            .from(this.table)
            .select('id')
            .eq('owner_id', ownerId)
            .eq('slug', slug)
            .maybeSingle();
        let finalSlug = slug;
        if (existing) {
            finalSlug = `${slug}-${Date.now().toString(36).slice(-6)}`;
        }
        const { data, error } = await this.supabase
            .from(this.table)
            .insert({
                owner_id: ownerId,
                name: String(name).trim(),
                slug: finalSlug,
                sort_order: 0
            })
            .select('id, name, slug')
            .single();
        if (error) throw error;
        return { id: data.id, name: data.name, slug: data.slug };
    }

    async update(id, ownerId, { name }) {
        if (!this.supabase || !id || !ownerId) throw new Error('id and ownerId required');
        const updates = {};
        if (name != null) {
            updates.name = String(name).trim();
            updates.slug = this.slugify(name);
        }
        if (Object.keys(updates).length === 0) return null;
        const { data, error } = await this.supabase
            .from(this.table)
            .update(updates)
            .eq('id', id)
            .eq('owner_id', ownerId)
            .select('id, name, slug')
            .single();
        if (error) throw error;
        return data ? { id: data.id, name: data.name, slug: data.slug } : null;
    }

    async delete(id, ownerId) {
        if (!this.supabase || !id || !ownerId) throw new Error('id and ownerId required');
        const { error } = await this.supabase
            .from(this.table)
            .delete()
            .eq('id', id)
            .eq('owner_id', ownerId);
        if (error) throw error;
    }
}

module.exports = { CategoryService };
