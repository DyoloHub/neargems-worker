const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// --- 1. SETUP WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- CONFIGURATION ---
const TOKENS_TO_SCAN = [
    "jambo-1679.meme-cooking.near",
    "blackdragon.tkn.near",
    "lonk.tkn.near",
    "token.v2.ref-finance.near"
];

const API_TXNS = "https://api.nearblocks.io/v1/account";
const SCAN_INTERVAL = 60 * 1000; // 1 minute delay between token loops
const DB_FILE = path.join(__dirname, 'db_graph_data.json');

// --- STATE ---
let db = {};

// Load DB on start if exists
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log(`[INIT] Loaded database.`);
    } catch (e) { db = {}; }
}

// --- WEB ENDPOINTS ---
app.get('/', (req, res) => {
    res.send('NearGems Worker is Running 24/7. <br> Get data at <a href="/data">/data</a>');
});

app.get('/data', (req, res) => {
    const token = req.query.token;
    if (token && db[token]) {
        return res.json(db[token]);
    }
    res.json({ 
        available_tokens: Object.keys(db),
        status: "active",
        timestamp: Date.now(),
        db_size: Object.keys(db).length
    });
});

app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
    startWorker(); // Start the background loop
});


// --- 2. WORKER LOGIC (GOD MODE) ---

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (res.status === 429) {
                const delay = 2500 * Math.pow(2, i); // Aggressive backoff
                console.log(`[429] Rate Limit... waiting ${delay/1000}s`);
                await wait(delay);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) { 
            await wait(1000); 
        }
    }
    return null;
}

async function scanToken(token) {
    console.log(`[SCAN] Starting Deep Scan for: ${token}`);
    
    // 1. Get Top Holders
    const holdersUrl = `https://api.fastnear.com/v1/ft/${token}/top`; 
    const holdersData = await fetchWithRetry(holdersUrl);
    
    if (!holdersData || !holdersData.accounts) {
        console.log(`[SKIP] No holders found for ${token}`);
        return;
    }

    // Scan top 50 whales deep
    const holders = holdersData.accounts.slice(0, 50); 
    let nodes = [];
    let links = [];
    let processed = new Set();

    // 2. Deep Scan Logic (3 Pages + Native Checks)
    for (const h of holders) {
        const whaleId = h.account_id;
        if (processed.has(whaleId)) continue;
        
        nodes.push({ id: whaleId, balance: h.balance, isCore: true });
        processed.add(whaleId);

        // Fetch Pages 1, 2, 3 of FT transactions AND Page 1 of Native transactions
        // This ensures we catch connections even if they didn't use the specific token
        const ftPromises = [1, 2, 3].map(p => fetchWithRetry(`${API_TXNS}/${whaleId}/ft-txns?page=${p}&per_page=50`));
        const nativePromise = fetchWithRetry(`${API_TXNS}/${whaleId}/txns?page=1&per_page=50`);
        
        const results = await Promise.all([...ftPromises, nativePromise]);
        
        let allTxns = [];

        // Collect FT Txns
        for(let i=0; i<3; i++) {
            if (results[i] && results[i].txns) allTxns = [...allTxns, ...results[i].txns];
        }

        // Collect Native Txns (mapped to match structure)
        const nativeData = results[3];
        if (nativeData && nativeData.txns) {
            const mapped = nativeData.txns.map(t => ({
                involved_account_id: (t.receiver_account_id === whaleId) ? t.signer_account_id : t.receiver_account_id,
                ...t
            }));
            allTxns = [...allTxns, ...mapped];
        }

        // Process Connections
        allTxns.forEach(tx => {
            let partner = tx.involved_account_id;
            
            // Fallback logic for FTs
            if (!partner) {
                if (tx.receiver_account_id === whaleId) partner = tx.signer_account_id;
                else partner = tx.receiver_account_id;
            }

            if (!partner || partner === whaleId) return;

            // Add Link
            const linkId = [whaleId, partner].sort().join("-");
            if (!links.find(l => l.id === linkId)) {
                links.push({ source: whaleId, target: partner, id: linkId });
            }

            // Add Partner Node (as non-core)
            if (!processed.has(partner)) {
                nodes.push({ id: partner, group: "partner", balance: "0", isCore: false });
                processed.add(partner);
            }
        });

        // Gentle pause between whales to save API credits
        await wait(250); 
    }

    // 3. Update Database
    db[token] = {
        nodes: nodes,
        links: links,
        lastUpdated: Date.now()
    };
    
    // Attempt to save to disk (ephemeral)
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
    
    console.log(`[DONE] ${token}: Found ${nodes.length} nodes and ${links.length} links.`);
}

async function startWorker() {
    let index = 0;
    while (true) {
        const token = TOKENS_TO_SCAN[index];
        await scanToken(token);
        index = (index + 1) % TOKENS_TO_SCAN.length;
        console.log(`[SLEEP] Resting...`);
        await wait(SCAN_INTERVAL);
    }
}
