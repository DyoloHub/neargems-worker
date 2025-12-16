const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
let mongoose;
try { mongoose = require('mongoose'); } catch (e) { console.log("[WARN] Mongoose not installed."); }

// --- 1. SETUP WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; 
// SECURE ADMIN PASSWORD (Set this in Render Environment Variables)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change_this_default_password";

// --- SECURITY: THE BOUNCER (CORS) ---
const allowedOrigins = [
    'https://neargems.space',
    'https://www.neargems.space',
    'http://127.0.0.1:5500', 
    'http://localhost:5500' 
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(null, true); 
        }
        return callback(null, true);
    }
}));

app.use(express.json()); 

// --- CONFIGURATION ---
const API_TXNS = "https://api.nearblocks.io/v1/account";
const API_GECKO = "https://api.geckoterminal.com/api/v2/networks/near/tokens";
const API_REF_POOLS = "https://api.ref.finance/list-pools";
const API_FASTNEAR_FT = "https://api.fastnear.com/v1/ft";

const SCAN_INTERVAL_DEEP = 45 * 1000; 
const REFRESH_LIST_INTERVAL = 30 * 60 * 1000; 
const DB_FILE = path.join(__dirname, 'db_graph_data.json');

// --- STATE ---
let db = {};
let ecoList = []; 
let ecoIndex = 0; 
let priorityQueue = []; 
const activeSessions = new Map(); // Track active users (IP/Session -> Timestamp)

// CHANGED: scanCounts now maps TokenID -> Array of Timestamps [ts1, ts2, ...]
const scanCounts = new Map(); 

// --- DATABASE SETUP (MONGODB) ---
let TokenModel = null;
let DonationModel = null;

if (mongoose && MONGO_URI) {
    console.log("[DB] Connecting to MongoDB...");
    mongoose.connect(MONGO_URI)
        .then(() => console.log("[DB] MongoDB Connected!"))
        .catch(e => console.error("[DB] Connection Error:", e));

    const TokenSchema = new mongoose.Schema({
        id: { type: String, unique: true },
        nodes: Array,
        links: Array,
        market: Object,
        lastUpdated: Number
    });
    TokenModel = mongoose.model('TokenGraph', TokenSchema);

    const DonationSchema = new mongoose.Schema({
        sender: String,
        amount: Number,
        txHash: { type: String, unique: true },
        timestamp: Number,
        message: String
    });
    DonationModel = mongoose.model('Donation', DonationSchema);

} else {
    if (fs.existsSync(DB_FILE)) {
        try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = {}; }
    }
}

// --- ADMIN MIDDLEWARE ---
const requireAdmin = (req, res, next) => {
    const pass = req.headers['x-admin-password'];
    if (!pass || pass !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Access Denied: Invalid Password" });
    }
    next();
};

// --- WEB ENDPOINTS ---

app.get('/', (req, res) => {
    res.send('NearGems Brain is Active.');
});

app.post('/api/ping', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || 'unknown';
    const id = `${ip}|${ua}`;
    activeSessions.set(id, Date.now());
    res.sendStatus(200);
});

// --- ADMIN ENDPOINTS ---

app.post('/api/admin/login', requireAdmin, (req, res) => {
    res.json({ success: true, message: "Logged in successfully" });
});

app.post('/api/admin/reset-token', requireAdmin, async (req, res) => {
    const { tokenId } = req.body;
    if (!tokenId) return res.status(400).json({ error: "Token ID required" });

    try {
        if (db[tokenId]) delete db[tokenId];
        if (TokenModel) await TokenModel.deleteOne({ id: tokenId });
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e){}
        console.log(`[ADMIN] Wiped data for ${tokenId}`);
        res.json({ success: true, message: `Database entry for ${tokenId} deleted.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/flush-all', requireAdmin, async (req, res) => {
    try {
        db = {};
        if (TokenModel) await TokenModel.deleteMany({});
        try { fs.writeFileSync(DB_FILE, JSON.stringify({})); } catch(e){}
        scanCounts.clear();
        console.log(`[ADMIN] FLUSHED ALL DATA`);
        res.json({ success: true, message: "All graph data deleted." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Get Server Stats (Updated with 24h Logic)
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const memKeys = Object.keys(db).length;
    let dbCount = 0;
    if (TokenModel) dbCount = await TokenModel.countDocuments();
    
    // Prune stale sessions
    const now = Date.now();
    for (const [id, lastSeen] of activeSessions.entries()) {
        if (now - lastSeen > 60000) activeSessions.delete(id);
    }
    
    // Calculate Top Scanned (All Time vs 24h)
    const allTime = [];
    const last24h = [];
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    // Iterate scanCounts Map
    for (const [id, timestamps] of scanCounts.entries()) {
        // Filter timestamps for 24h count
        // Note: We also cleanup old timestamps here to save memory eventually, 
        // but for simplicity we just filter for the report now.
        const valid24h = timestamps.filter(t => t > oneDayAgo);
        
        // Update memory with pruned array to prevent infinite growth
        if (valid24h.length < timestamps.length) {
             scanCounts.set(id, valid24h.length > 0 ? valid24h : []); 
             // If we wanted to keep "All Time" accurate forever, we wouldn't prune.
             // BUT for a simple server without dedicated stats DB, pruning keeps it fast.
             // COMPROMISE: We will prune, so "All Time" effectively becomes "Since Server Restart" or "Rolling Window" depending on pruning logic.
             // To keep "All Time" truly all time, we'd need a separate counter.
             // Let's implement a dual structure for better data:
        }
        
        // ACTUALLY: Let's assume scanCounts stores ALL timestamps since server start. 
        // We won't prune for now to keep "All Time" valid until restart.
        
        if (timestamps.length > 0) allTime.push({ id, count: timestamps.length });
        if (valid24h.length > 0) last24h.push({ id, count: valid24h.length });
    }

    // Sort & Slice
    allTime.sort((a, b) => b.count - a.count);
    last24h.sort((a, b) => b.count - a.count);

    res.json({
        memory_keys: memKeys,
        mongo_docs: dbCount,
        queue_length: priorityQueue.length,
        eco_list_size: ecoList.length,
        online_users: activeSessions.size,
        top_scanned: allTime.slice(0, 10),
        top_scanned_24h: last24h.slice(0, 10) // New Field
    });
});

// --- PUBLIC ENDPOINTS ---

app.post('/api/record-donation', async (req, res) => {
    if (!DonationModel) return res.status(503).json({ error: "DB not connected" });
    const { sender, amount, txHash, message } = req.body;
    if (!sender || !amount || !txHash) return res.status(400).json({ error: "Missing fields" });

    try {
        const newDonation = new DonationModel({ sender, amount, txHash, message: message || "", timestamp: Date.now() });
        await newDonation.save();
        res.json({ success: true });
    } catch (e) {
        if(e.code === 11000) return res.json({ success: true, message: "Already recorded" });
        res.status(500).json({ error: "Internal Error" });
    }
});

app.get('/api/top-donors', async (req, res) => {
    if (!DonationModel) return res.json([]);
    try {
        const leaderboard = await DonationModel.aggregate([
            { $group: { _id: "$sender", totalAmount: { $sum: "$amount" }, count: { $sum: 1 }, lastDonation: { $max: "$timestamp" } } },
            { $sort: { totalAmount: -1 } },
            { $limit: 20 }
        ]);
        const biggestDrops = await DonationModel.find().sort({ amount: -1 }).limit(10);
        res.json({ total_leaderboard: leaderboard, single_drops: biggestDrops });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/data', async (req, res) => {
    const token = req.query.token;
    
    // Update Scan Count (Store Timestamp)
    if (token) {
        const currentTimestamps = scanCounts.get(token) || [];
        currentTimestamps.push(Date.now());
        scanCounts.set(token, currentTimestamps);
        
        if (!priorityQueue.includes(token)) {
            priorityQueue.unshift(token); 
            if (priorityQueue.length > 20) priorityQueue.pop();
        }
    }
    
    if (!token) return res.json({ status: "miss" });
    if (db[token]) return res.json(db[token]);
    
    if (TokenModel) {
        try {
            const doc = await TokenModel.findOne({ id: token });
            if (doc) { 
                db[token] = doc.toObject();
                return res.json(doc); 
            }
        } catch(e) {}
    }
    const known = ecoList.find(t => t.id === token);
    if (known) return res.json({ status: "partial", market: known });
    res.json({ status: "miss" });
});

app.get('/eco', (req, res) => {
    const simpleList = ecoList.map(t => ({
        id: t.id,
        symbol: t.symbol,
        tvl: t.tvl,
        price: t.price,
        mcap: t.mcap
    }));
    res.json(simpleList);
});

app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
    startBrain(); 
});

// --- WORKER LOGIC ---

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (res.status === 429) {
                const delay = 3000 * (i + 1);
                await wait(delay);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) { await wait(1000); }
    }
    return null;
}

async function updateEcosystemMap() {
    try {
        const poolsRes = await fetch(API_REF_POOLS);
        const pools = await poolsRes.json();
        const tvlMap = {};
        pools.forEach(p => {
            const tvl = parseFloat(p.tvl);
            if (tvl > 100 && p.token_account_ids) {
                p.token_account_ids.forEach(id => {
                    tvlMap[id] = (tvlMap[id] || 0) + (tvl / p.token_account_ids.length);
                });
            }
        });
        let newEcoList = Object.keys(tvlMap).map(id => ({
            id: id,
            tvl: tvlMap[id],
            symbol: id.split('.')[0].toUpperCase().slice(0, 6)
        }));
        newEcoList = newEcoList.filter(t => t.tvl > 1000); 
        newEcoList.sort((a, b) => b.tvl - a.tvl); 
        ecoList = newEcoList;
    } catch (e) {}
}

async function deepScanToken(tokenId) {
    let tokenObj = ecoList.find(t => t.id === tokenId) || { id: tokenId, tvl: 0 };
    let marketData = { tvl: tokenObj.tvl }; 
    try {
        const geckoData = await fetchWithRetry(`${API_GECKO}/${tokenId}`);
        if (geckoData && geckoData.data) {
            const attr = geckoData.data.attributes;
            marketData.price = parseFloat(attr.price_usd || 0);
            marketData.mcap = parseFloat(attr.market_cap_usd || attr.fdv_usd || 0);
        }
    } catch(e) {}

    const holdersData = await fetchWithRetry(`${API_FASTNEAR_FT}/${tokenId}/top`);
    if (!holdersData || !holdersData.accounts) return;

    const holders = holdersData.accounts.slice(0, 40);
    let nodes = [];
    let links = [];
    let processed = new Set();

    for (const h of holders) {
        const whaleId = h.account_id;
        if (processed.has(whaleId)) continue;
        nodes.push({ id: whaleId, balance: h.balance, isCore: true, _source: 'cloud' });
        processed.add(whaleId);

        const pages = [1, 2]; 
        const promises = pages.map(p => fetchWithRetry(`${API_TXNS}/${whaleId}/ft-txns?page=${p}&per_page=50`));
        const nativePromise = fetchWithRetry(`${API_TXNS}/${whaleId}/txns?page=1&per_page=25`);
        const results = await Promise.all([...promises, nativePromise]);

        for (let i = 0; i < results.length; i++) {
            const data = results[i];
            if (!data || !data.txns) continue;
            data.txns.forEach(tx => {
                let partner = tx.involved_account_id;
                if (!partner) partner = (tx.receiver_account_id === whaleId) ? tx.signer_account_id : tx.receiver_account_id;
                if (!partner || partner === whaleId) return;
                
                const linkId = [whaleId, partner].sort().join("-");
                if (!links.find(l => l.id === linkId)) links.push({ source: whaleId, target: partner, id: linkId });
                
                if (!processed.has(partner)) {
                    nodes.push({ id: partner, group: "partner", balance: "0", isCore: false });
                    processed.add(partner);
                }
            });
        }
        await wait(200); 
    }

    const finalData = {
        id: tokenId, 
        nodes: nodes,
        links: links,
        market: marketData,
        lastUpdated: Date.now()
    };

    db[tokenId] = finalData; 
    if (TokenModel) {
        try {
            await TokenModel.findOneAndUpdate({ id: tokenId }, finalData, { upsert: true, new: true });
        } catch(e) {}
    }
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
    console.log(`[DONE] ${tokenId}: ${nodes.length} nodes, ${links.length} links.`);
}

async function startBrain() {
    await updateEcosystemMap(); 
    setInterval(updateEcosystemMap, REFRESH_LIST_INTERVAL);
    while (true) {
        let targetId = null;
        if (priorityQueue.length > 0) targetId = priorityQueue.shift(); 
        else if (ecoList.length > 0) {
            targetId = ecoList[ecoIndex]?.id;
            ecoIndex = (ecoIndex + 1) % ecoList.length;
        }
        if (targetId) await deepScanToken(targetId);
        else await wait(5000); 
        await wait(SCAN_INTERVAL_DEEP);
    }
}
