import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { DocumentSession } from './services/DocumentSession';
import Redis from 'ioredis';
import cors from 'cors';
import { Kafka } from 'kafkajs';

// --- CONFIGURATION ---
const app = express();
const allowedOrigins = ['https://abhinandancte.vercel.app', 'http://localhost:5173']; 

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
}));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081; 
const REDIS_URL = process.env.REDIS_URL || "redis://default:RtfJevPbBmwicENQmqqRdRJegVzQojAg@redis.railway.internal:6379";
const KAFKA_BROKER = process.env.KAFKA_URL ? process.env.KAFKA_URL.split(',')[0] : "kafka-broker.railway.internal:9092";

// --- SERVICES SETUP ---
console.log(`Connecting to Redis...`);
const redis = new Redis(REDIS_URL, { 
    maxRetriesPerRequest: 2, 
    retryStrategy: (times) => Math.min(times * 50, 2000) // Keep retrying
});

console.log(`Setting up Kafka at ${KAFKA_BROKER}...`);
const kafka = new Kafka({ clientId: 'collab-app', brokers: [KAFKA_BROKER] });
const producer = kafka.producer();
const sessions = new Map<string, DocumentSession>();

// Track Kafka State
let kafkaReady = false;
producer.on('producer.connect', () => {
    kafkaReady = true;
    console.log("✅ KAFKA STATUS: Producer connected.");
});
producer.on('producer.disconnect', () => {
    kafkaReady = false;
    console.error("❌ KAFKA STATUS: Producer disconnected!");
});

// --- AUTH HELPER (From your new code - Keep this!) ---
async function getUserRole(docId: string, userId: string): Promise<string> {
    const explicitRole = await redis.hget(`doc_acl:${docId}`, userId);
    if (explicitRole) return explicitRole;
    const linkAccess = await redis.hget(`doc_settings:${docId}`, 'link_access');
    return linkAccess || 'none'; 
}

async function isOwner(docId: string, userId: string) {
    const owner = await redis.get(`doc_owner:${docId}`);
    return owner === userId;
}

// --- API ENDPOINTS (Keep Redis logic active even if Kafka is connecting) ---

app.get('/api/docs/:userId', async (req, res) => {
    // REMOVED `if (kafkaReady)` check here. 
    // This only reads from Redis, so let it run even if Kafka is slow!
    const { userId } = req.params;
    const docs = await redis.smembers(`user_docs:${userId}`);
    res.json(docs);
});

app.post('/api/docs', async (req, res) => {
    const { userId, docId } = req.body;
    await redis.sadd(`user_docs:${userId}`, docId);
    await redis.set(`doc_owner:${docId}`, userId);
    await redis.rpush(`doc_tabs:${docId}`, "Sheet 1");
    await redis.hset(`doc_acl:${docId}`, userId, 'owner');
    await redis.hset(`doc_settings:${docId}`, 'link_access', 'none');
    res.json({ success: true });
});

app.get('/api/doc/:docId/users', async (req, res) => {
    const { docId } = req.params;
    const acl = await redis.hgetall(`doc_acl:${docId}`);
    const linkAccess = await redis.hget(`doc_settings:${docId}`, 'link_access') || 'none';
    res.json({ acl, linkAccess });
});

app.post('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email, role } = req.body; 
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });
    await redis.hset(`doc_acl:${docId}`, email, role);
    await redis.sadd(`user_docs:${email}`, docId);
    res.json({ success: true });
});

app.delete('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email } = req.body;
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });
    await redis.hdel(`doc_acl:${docId}`, email);
    res.json({ success: true });
});

app.post('/api/doc/:docId/link-settings', async (req, res) => {
    const { docId, ownerId, linkAccess } = req.body; 
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

// --- WEBSOCKET SETUP (The Critical Fix) ---
// We define this OUTSIDE the async block so it is ALWAYS registered.
wss.on('connection', async (ws, req) => {
    // 1. Check Kafka Readiness immediately
    if (!kafkaReady) {
        console.error("⚠️ Client tried to connect, but Kafka is not ready.");
        ws.send(JSON.stringify({ type: 'error', message: 'Service starting... please refresh in 5 seconds.' }));
        ws.close();
        return;
    }

    const urlParams = new URLSearchParams(req.url?.split('?')[1]);
    const docId = urlParams.get('docId');
    const tabId = urlParams.get('tabId');
    const userId = urlParams.get('userId');

    if (!docId || !userId || !tabId) { ws.close(); return; }
    
    // Auth Check
    const userRole = await getUserRole(docId, userId);
    if (userRole === 'none') {
        console.log(`⛔ Access denied for ${userId} on doc ${docId}`);
        ws.send(JSON.stringify({ type: 'error', message: "Access Denied." }));
        ws.close();
        return;
    }

    const sessionKey = `${docId}::${tabId}`;
    if (!sessions.has(sessionKey)) {
        // Producer is guaranteed to be connected here because of the check above
        sessions.set(sessionKey, new DocumentSession(sessionKey, producer));
    }

    const session = sessions.get(sessionKey)!;
    const connectionId = await session.addUser(ws, userId, userRole); 

    ws.on('message', (message) => {
        const data = JSON.parse(message.toString());
        session.handleEdit(connectionId, data); 
    });

    ws.on('close', () => {
        session.removeUser(connectionId);
    });
});

// --- SERVER STARTUP (Restored "Safe" Logic) ---
(async () => {
    try {
        console.log("⏳ Connecting to Kafka...");
        // Wait for Kafka BEFORE saying "Server is ready"
        await producer.connect();
        kafkaReady = true; 
        console.log("✅ Kafka Connected!");

        // Start listening only when dependencies are ready
        server.listen(PORT, () => {
            console.log(`🚀 HTTP/WS Server running on port ${PORT}`);
        });

    } catch (e) { 
        console.error("🔥 FATAL SETUP ERROR: Could not connect to Kafka.", e);
        // Important: If we can't connect, we should probably crash and let Railway restart us.
        // process.exit(1); // Uncomment this for production stability
    }
})();