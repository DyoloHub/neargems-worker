const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// --- 1. SETUP WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // Enable JSON body parsing for POST requests

// --- CONFIGURATION ---
const API_TXNS = "https://api.nearblocks.io/v1/account";
const API_GECKO = "https://api.geckoterminal.com/api/v2/networks/near/tokens";
const API_REF_POOLS = "https://api.ref.finance/list-pools";
const API_FASTNEAR_FT = "https://api.fastnear.com/v1/ft";

// Scan speeds
const SCAN_INTERVAL_DEEP = 45 * 1000; // Deep scan a major token every 45s
const REFRESH_LIST_INTERVAL = 30 * 60 * 1000; // Re-fetch entire ecosystem list every 30 mins

const DB_FILE = path.join(__dirname, 'db_graph_data.json');

// --- STATE ---
let db = {};
let ecoList = []; // Full list of ALL tokens found on Ref, sorted by TVL
let ecoIndex = 0; // Pointer for deep scanning loop
let priorityQueue = []; // List of tokens requested by users

// Load DB on start
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log(`[INIT] Loaded database with ${Object.keys(db).length} cached tokens.`);
    } catch (e) { db = {}; }
}

// --- WEB ENDPOINTS ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: monospace; padding: 20px; background:#111; color:#00EC97;">
            <h1>🧠 NearGems Brain (Upgraded + Priority)</h1>
            <p><strong>Status:</strong> Active</p>
            <p><strong>Ecosystem Size:</strong> ${ecoList.length} tokens detected</p>
            <p><strong>Deep Scanned:</strong> ${Object.keys(db).length} tokens</p>
            <p><strong>Priority Queue:</strong> ${priorityQueue.length} pending</p>
            <p><strong>Current Target:</strong> ${priorityQueue.length > 0 ? 'PRIORITY: ' + priorityQueue[0] : (ecoList[ecoIndex]?.symbol || 'Initializing...')}</p>
        </div>
    `);
});

// 1. Get Graph Data for a specific token
app.get('/data', (req, res) => {
    const token = req.query.token;
    
    // --- SIGNAL: User is searching for this token! ---
    if (token && !priorityQueue.includes(token)) {
        // Add to front of line if not already queued
        console.log(`[SIGNAL] Priority request received for: ${token}`);
        priorityQueue.unshift(token); 
        // Cap queue size to prevent spam attacks
        if (priorityQueue.length > 20) priorityQueue.pop();
    }

    if (token && db[token]) {
        return res.json(db[token]);
    }
    // Return partial data if we know about it but haven't deep scanned yet
    const known = ecoList.find(t => t.id === token);
    if (known) {
        return res.json({ 
            status: "partial",
            market: known, 
            message: "Graph scan pending. Added to priority queue." 
        });
    }
    res.json({ status: "miss", message: "Token unknown. Queued for discovery." });
});

// 2. Get FULL Ecosystem List (for Eco Mode bubbles)
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


// --- 2. WORKER UTILS ---

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (res.status === 429) {
                const delay = 3000 * (i + 1);
                console.log(`[429] Rate Limit... waiting ${delay/1000}s`);
                await wait(delay);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) { await wait(1000); }
    }
    return null;
}

// --- 3. INTELLIGENCE LAYER ---

// STEP 1: Map the entire ecosystem
async function updateEcosystemMap() {
    console.log("[BRAIN] Mapping entire NEAR ecosystem...");
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
        console.log(`[BRAIN] Map Updated. Tracking ${ecoList.length} tokens.`);
        
    } catch (e) {
        console.error("[BRAIN] Mapping failed:", e.message);
    }
}

// STEP 2: Deep Scan a Single Token (Graph + Market Data)
async function deepScanToken(tokenId, isPriority = false) {
    console.log(`[SCAN] Processing ${isPriority ? '🔥 PRIORITY' : ''}: ${tokenId}`);
    
    // Find basic info if in ecoList, or create stub
    let tokenObj = ecoList.find(t => t.id === tokenId) || { id: tokenId, tvl: 0 };

    // A. Fetch Market Data (Gecko)
    let marketData = { tvl: tokenObj.tvl }; 
    try {
        const geckoData = await fetchWithRetry(`${API_GECKO}/${tokenId}`);
        if (geckoData && geckoData.data) {
            const attr = geckoData.data.attributes;
            marketData.price = parseFloat(attr.price_usd || 0);
            marketData.mcap = parseFloat(attr.market_cap_usd || attr.fdv_usd || 0);
            marketData.vol24 = parseFloat(attr.volume_usd?.h24 || 0);
            
            // Update cache
            tokenObj.price = marketData.price;
            tokenObj.mcap = marketData.mcap;
        }
    } catch(e) {}

    // B. Fetch Holders (FastNear)
    const holdersData = await fetchWithRetry(`${API_FASTNEAR_FT}/${tokenId}/top`);
    
    if (!holdersData || !holdersData.accounts) {
        console.log(`[SKIP] No holders for ${tokenId}`);
        return;
    }

    // C. Build Graph (Top 40 Whales)
    const holders = holdersData.accounts.slice(0, 40);
    let nodes = [];
    let links = [];
    let processed = new Set();

    for (const h of holders) {
        const whaleId = h.account_id;
        if (processed.has(whaleId)) continue;
        
        nodes.push({ 
            id: whaleId, 
            balance: h.balance, 
            isCore: true,
            _source: 'cloud' 
        });
        processed.add(whaleId);

        // Fetch History (Pages 1 & 2)
        const pages = [1, 2]; 
        const promises = pages.map(p => fetchWithRetry(`${API_TXNS}/${whaleId}/ft-txns?page=${p}&per_page=50`));
        const results = await Promise.all(promises);

        results.forEach(data => {
            if (!data || !data.txns) return;
            data.txns.forEach(tx => {
                let partner = tx.involved_account_id;
                if (!partner) partner = (tx.receiver_account_id === whaleId) ? tx.signer_account_id : tx.receiver_account_id;
                
                if (!partner || partner === whaleId) return;

                const linkId = [whaleId, partner].sort().join("-");
                if (!links.find(l => l.id === linkId)) {
                    links.push({ source: whaleId, target: partner, id: linkId });
                }
                
                if (!processed.has(partner)) {
                    nodes.push({ id: partner, group: "partner", balance: "0", isCore: false });
                    processed.add(partner);
                }
            });
        });
        await wait(200); 
    }

    // D. Save to Memory DB
    db[tokenId] = {
        nodes: nodes,
        links: links,
        market: marketData,
        lastUpdated: Date.now()
    };
    
    // Persist
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
    
    console.log(`[SAVE] ${tokenId}: ${nodes.length} nodes, ${links.length} links saved.`);
}

// --- 4. MAIN LOOP ---
async function startBrain() {
    await updateEcosystemMap(); // Initial Map Build

    setInterval(updateEcosystemMap, REFRESH_LIST_INTERVAL);

    // Deep Scan Loop
    while (true) {
        let targetId = null;
        let isPriority = false;

        // 1. Check Priority Queue First
        if (priorityQueue.length > 0) {
            targetId = priorityQueue.shift(); // Take first item
            isPriority = true;
        } 
        // 2. Fallback to Eco List (High TVL)
        else if (ecoList.length > 0) {
            targetId = ecoList[ecoIndex]?.id;
            ecoIndex = (ecoIndex + 1) % ecoList.length;
            if (ecoIndex === 0) console.log("[LOOP] Restarting ecosystem cycle.");
        }

        if (targetId) {
            await deepScanToken(targetId, isPriority);
        } else {
            await wait(5000); // Empty list? Wait.
            continue;
        }

        console.log(`[SLEEP] Resting...`);
        await wait(SCAN_INTERVAL_DEEP);
    }
}
