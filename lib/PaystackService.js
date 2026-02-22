/**
 * Paystack API service (OOP).
 */
class PaystackService {
    constructor(secretKey) {
        this.secretKey = secretKey;
        this.baseUrl = 'https://api.paystack.co';
    }

    async _request(method, path, body) {
        const url = this.baseUrl + path;
        const options = {
            method,
            headers: {
                Authorization: 'Bearer ' + this.secretKey,
                'Content-Type': 'application/json'
            }
        };
        if (body && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        const data = await res.json();
        if (!data.status) throw new Error(data.message || 'Paystack request failed');
        return data;
    }

    async initializeTransaction(email, amountKobo, reference, metadata) {
        const body = {
            email,
            amount: Math.round(Number(amountKobo)),
            currency: 'NGN',
            metadata: metadata || {}
        };
        if (reference) body.reference = reference;
        const data = await this._request('POST', '/transaction/initialize', body);
        return {
            reference: data.data.reference,
            authorizationUrl: data.data.authorization_url,
            accessCode: data.data.access_code
        };
    }

    async verifyTransaction(reference) {
        const data = await this._request('GET', '/transaction/verify/' + encodeURIComponent(reference));
        return data.data;
    }
}

module.exports = { PaystackService };
