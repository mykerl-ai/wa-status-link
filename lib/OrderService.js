/**
 * Order service (OOP). Creates and updates orders in Supabase.
 */
class OrderService {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.table = 'orders';
    }

    async create(reference, email, amountKobo, items) {
        if (!this.supabase) throw new Error('Supabase not configured');
        const { data, error } = await this.supabase
            .from(this.table)
            .insert({
                reference,
                email,
                amount_kobo: amountKobo,
                items,
                status: 'pending'
            })
            .select('id, reference, status')
            .single();
        if (error) throw error;
        return data;
    }

    async updateStatus(reference, status) {
        if (!this.supabase) throw new Error('Supabase not configured');
        const { data, error } = await this.supabase
            .from(this.table)
            .update({ status, updated_at: new Date().toISOString() })
            .eq('reference', reference)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findByReference(reference) {
        if (!this.supabase) return null;
        const { data, error } = await this.supabase
            .from(this.table)
            .select('*')
            .eq('reference', reference)
            .single();
        if (error || !data) return null;
        return data;
    }
}

module.exports = { OrderService };
