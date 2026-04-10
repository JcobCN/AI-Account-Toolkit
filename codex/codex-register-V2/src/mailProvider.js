const axios = require('axios');
const { randomInt } = require('node:crypto');

class MailProvider {
    constructor(options) {
        this.baseUrl = options.baseUrl;
        this.adminPassword = options.adminPassword;
        this.sitePassword = options.sitePassword || '';
        this.domain = options.domain;
        this.jwt = null;
        this.address = null;
        this.addressId = null;
    }

    /**
     * 构建请求 headers
     */
    _adminHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'x-admin-auth': this.adminPassword,
        };
        if (this.sitePassword) {
            headers['x-custom-auth'] = this.sitePassword;
        }
        return headers;
    }

    /**
     * 构建地址 JWT 请求 headers
     */
    _addressHeaders() {
        const headers = {
            'Authorization': `Bearer ${this.jwt}`,
        };
        if (this.sitePassword) {
            headers['x-custom-auth'] = this.sitePassword;
        }
        return headers;
    }

    /**
     * 生成随机邮箱用户名
     */
    _randomName() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const length = 8 + randomInt(5); // 8-12 字符
        let name = '';
        for (let i = 0; i < length; i++) {
            name += chars[randomInt(chars.length)];
        }
        return name;
    }

    /**
     * 创建新邮箱地址
     * @param {string|null} name - 邮箱用户名，null 则随机生成
     * @returns {Promise<{jwt: string, address: string, addressId: number}>}
     */
    async createAddress(name = null) {
        const emailName = name || this._randomName();

        const response = await axios.post(
            `${this.baseUrl}/admin/new_address`,
            { name: emailName, domain: this.domain, enablePrefix: false },
            { headers: this._adminHeaders(), timeout: 15000 }
        );

        const data = response.data;
        this.jwt = data.jwt;
        this.address = data.address;
        this.addressId = data.address_id;

        console.log(`[Mail] 创建邮箱: ${this.address}`);
        return { jwt: this.jwt, address: this.address, addressId: this.addressId };
    }

    /**
     * 获取邮箱收件箱 URL（供 Agent 浏览器访问）
     * @returns {string}
     */
    getInboxUrl() {
        return `${this.baseUrl}/?jwt=${this.jwt}`;
    }

    /**
     * 获取邮箱地址
     * @returns {string}
     */
    getEmail() {
        return this.address;
    }

    /**
     * 获取邮件列表
     * @param {number} limit
     * @param {number} offset
     * @returns {Promise<Array>}
     */
    async getMails(limit = 10, offset = 0) {
        const response = await axios.get(
            `${this.baseUrl}/api/mails`,
            {
                params: { limit, offset },
                headers: this._addressHeaders(),
                timeout: 15000,
            }
        );
        return response.data.results || [];
    }
}

module.exports = { MailProvider };
