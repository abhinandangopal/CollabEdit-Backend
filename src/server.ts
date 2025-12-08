import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { DocumentSession } from './services/DocumentSession';
import Redis from 'ioredis';
import cors from 'cors';
import { Kafka } from 'kafkajs';

// 1. Setup Express and CORS
const app = express();
const allowedOrigins = ['https://abhinandancte.vercel.app', 'http://localhost:5173']; 

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
}));
app.use(express.json());

// 2. Setup HTTP and WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 3. Setup Environment Variables and Port
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081; 
const REDIS_URL = process.env.REDIS_URL || "redis://default:RtfJevPbBmwicENQmqqRdRJegVzQojAg@redis.railway.internal:6379";
const KAFKA_BROKER = process.env.KAFKA_URL ? process.env.KAFKA_URL.split(',')[0] : "kafka-broker.railway.internal:9092";

// 4. Initialize Services
console.log(`Connecting to Redis...`);
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2,});

console.log(`Setting up Kafka at ${KAFKA_BROKER}...`);
const kafka = new Kafka({ clientId: 'collab-app', brokers: [KAFKA_BROKER] });
const producer = kafka.producer();
const sessions = new Map<string, DocumentSession>();

// 🎯 FIX 1: Use a module-level variable to track Kafka connection state
let kafkaReady = false;

// --- Kafka Status Checks ---
producer.on('producer.connect', () => {
    kafkaReady = true; // Set flag to true when connected
    console.log("✅ KAFKA STATUS: Producer connected and ready for events.");
});
producer.on('producer.disconnect', (error) => {
    kafkaReady = false; // Set flag to false if disconnected
    console.error("❌ KAFKA STATUS: Producer disconnected! Check Railway configuration.", error);
});

// --- HELPER FUNCTIONS ---

async function isOwner(docId: string, userId: string) {
    const owner = await redis.get(`doc_owner:${docId}`);
    return owner === userId;
}

// 🟢 NEW HELPER: Get the effective role for a user (fixes Share button issue)
async function getUserRole(docId: string, userId: string): Promise<string> {
    // 1. Check for explicit role in the document's ACL (e.g., 'owner', 'editor', 'viewer')
    const explicitRole = await redis.hget(`doc_acl:${docId}`, userId);
    if (explicitRole) return explicitRole;
    
    // 2. If no explicit role, check the general "Link Access" setting
    const linkAccess = await redis.hget(`doc_settings:${docId}`, 'link_access');
    
    // 3. Return the link setting if it exists (e.g. 'viewer'), otherwise default to 'none'
    return linkAccess || 'none'; 
}

// --- REST APIs ---

app.get('/api/docs/:userId', async (req, res) => {
    if (kafkaReady) { 
        const { userId } = req.params;
        const docs = await redis.smembers(`user_docs:${userId}`);
        res.json(docs);
    } else {
        res.status(503).json({ error: "Service Unavailable: Kafka not ready." });
    }
});

app.post('/api/docs', async (req, res) => {
    const { userId, docId } = req.body;
    await redis.sadd(`user_docs:${userId}`, docId);
    await redis.set(`doc_owner:${docId}`, userId);
    await redis.rpush(`doc_tabs:${docId}`, "Sheet 1");
    // Owner gets 'owner' role in ACL
    await redis.hset(`doc_acl:${docId}`, userId, 'owner');
    // Default link access is 'restricted' (none)
    await redis.hset(`doc_settings:${docId}`, 'link_access', 'none');
    res.json({ success: true });
});

// GET PERMISSIONS & LINK SETTINGS
app.get('/api/doc/:docId/users', async (req, res) => {
    const { docId } = req.params;
    // 1. Get specific user list (ACL)
    const acl = await redis.hgetall(`doc_acl:${docId}`);
    // 2. Get general link setting
    const linkAccess = await redis.hget(`doc_settings:${docId}`, 'link_access') || 'none';
    
    res.json({ acl, linkAccess });
});

// INVITE / UPDATE USER ROLE
app.post('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email, role } = req.body; 
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });

    await redis.hset(`doc_acl:${docId}`, email, role);
    await redis.sadd(`user_docs:${email}`, docId);
    res.json({ success: true });
});

// REVOKE USER ACCESS
app.delete('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email } = req.body;
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });

    await redis.hdel(`doc_acl:${docId}`, email);
    res.json({ success: true });
});

// UPDATE GENERAL LINK ACCESS
app.post('/api/doc/:docId/link-settings', async (req, res) => {
    const { docId, ownerId, linkAccess } = req.body; // 'none'|'viewer'|'commenter'|'editor'
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });

    await redis.hset(`doc_settings:${docId}`, 'link_access', linkAccess);
    res.json({ success: true });
});

app.get('/api/doc/:docId/tabs', async (req, res) => {
    const { docId } = req.params;
    const tabs = await redis.lrange(`doc_tabs:${docId}`, 0, -1);
    if (tabs.length === 0) {
        await redis.rpush(`doc_tabs:${docId}`, "Sheet 1");
        return res.json(["Sheet 1"]);
    }
    res.json(tabs);
});

app.post('/api/doc/:docId/tabs', async (req, res) => {
    const { docId, tabName } = req.body;
    await redis.rpush(`doc_tabs:${docId}`, tabName);
    res.json({ success: true });
});


// --- Main Server Start Logic ---
(async () => {
    // 1. Start HTTP/WS server immediately (CRITICAL for CORS/502 fix)
    server.listen(PORT, () => {
        console.log(`🚀 HTTP/WS Server listening immediately on port ${PORT}`);
    });

    try {
        // 2. Connect to Kafka asynchronously
        await producer.connect(); 
        
        // 3. Setup WebSocket connection handling (runs non-blocking)
        wss.on('connection', async (ws, req) => {
            const urlParams = new URLSearchParams(req.url?.split('?')[1]);
            const docId = urlParams.get('docId');
            const tabId = urlParams.get('tabId');
            const userId = urlParams.get('userId');

            if (!docId || !userId || !tabId) { ws.close(); return; }
            
            // 🟢 AUTH LOGIC START (Updated to use DB)
            const userRole = await getUserRole(docId, userId);

            if (userRole === 'none') {
                console.log(`⛔ Access denied for ${userId} on doc ${docId}`);
                ws.send(JSON.stringify({ type: 'error', message: "Access Denied: You do not have permission to view this document." }));
                ws.close();
                return;
            }
            // 🟢 AUTH LOGIC END

            const sessionKey = `${docId}::${tabId}`;
            if (!sessions.has(sessionKey)) {
                sessions.set(sessionKey, new DocumentSession(sessionKey, producer));
            }

            const session = sessions.get(sessionKey)!;
            
            // 💡 FIX: Pass the real role retrieved from Redis
            const connectionId = await session.addUser(ws, userId, userRole); 

            ws.on('message', (message) => {
                const data = JSON.parse(message.toString());
                session.handleEdit(connectionId, data); 
            });

            ws.on('close', () => {
                session.removeUser(connectionId);
            });
        });

    } catch (e) { 
        console.error("🔥 FATAL SETUP ERROR: Could not connect to Kafka or Redis.", e); 
        // The server is running, but real-time functions will be unavailable.
    }
})();