import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { DocumentSession } from './services/DocumentSession';
import Redis from 'ioredis';
import cors from 'cors';
import { Kafka } from 'kafkajs';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 🟢 FIX: Use Environment Variables for Docker
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

console.log(`Connecting to Redis at ${REDIS_HOST}...`);
const redis = new Redis({ host: REDIS_HOST, port: 6379 });

console.log(`Connecting to Kafka at ${KAFKA_BROKER}...`);
const kafka = new Kafka({ clientId: 'collab-app', brokers: [KAFKA_BROKER] });
const producer = kafka.producer();

const sessions = new Map<string, DocumentSession>();

// --- HELPER ---
async function isOwner(docId: string, userId: string) {
    const owner = await redis.get(`doc_owner:${docId}`);
    return owner === userId;
}

// --- APIs ---

app.get('/api/docs/:userId', async (req, res) => {
    const { userId } = req.params;
    const docs = await redis.smembers(`user_docs:${userId}`);
    res.json(docs);
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

// 🟢 GET PERMISSIONS & LINK SETTINGS
app.get('/api/doc/:docId/users', async (req, res) => {
    const { docId } = req.params;
    // 1. Get specific user list (ACL)
    const acl = await redis.hgetall(`doc_acl:${docId}`);
    // 2. Get general link setting
    const linkAccess = await redis.hget(`doc_settings:${docId}`, 'link_access') || 'none';
    
    res.json({ acl, linkAccess });
});

// 🟢 INVITE / UPDATE USER ROLE
app.post('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email, role } = req.body; 
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });

    await redis.hset(`doc_acl:${docId}`, email, role);
    await redis.sadd(`user_docs:${email}`, docId);
    res.json({ success: true });
});

// 🟢 REVOKE USER ACCESS
app.delete('/api/doc/:docId/user', async (req, res) => {
    const { docId, ownerId, email } = req.body;
    if (!await isOwner(docId, ownerId)) return res.status(403).json({ error: "Not owner" });

    await redis.hdel(`doc_acl:${docId}`, email);
    res.json({ success: true });
});

// 🟢 UPDATE GENERAL LINK ACCESS
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

(async () => {
    try {
        await producer.connect();
        
        wss.on('connection', async (ws, req) => {
            const urlParams = new URLSearchParams(req.url?.split('?')[1]);
            const docId = urlParams.get('docId');
            const tabId = urlParams.get('tabId');
            const userId = urlParams.get('userId');

            if (!docId || !userId || !tabId) { ws.close(); return; }

            // 🟢 AUTH LOGIC START
            const owner = await redis.get(`doc_owner:${docId}`);
            let role = await redis.hget(`doc_acl:${docId}`, userId);
            const linkSetting = await redis.hget(`doc_settings:${docId}`, 'link_access') || 'none';

            // If not owner AND not explicitly invited
            if (userId !== owner && !role) {
                if (linkSetting !== 'none') {
                    // Grant access based on Public Link Setting
                    role = linkSetting; 
                    console.log(`${userId} joining via Link as ${role}`);
                } else {
                    // Block access
                    console.log(`⛔ BLOCKING ${userId} from ${docId}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Access Denied.' }));
                    ws.close();
                    return;
                }
            }
            // 🟢 AUTH LOGIC END

            const finalRole = (userId === owner) ? 'owner' : role;

            const sessionKey = `${docId}::${tabId}`;
            if (!sessions.has(sessionKey)) {
                sessions.set(sessionKey, new DocumentSession(sessionKey, producer));
            }

            const session = sessions.get(sessionKey)!;
            const connectionId = await session.addUser(ws, userId, finalRole || 'viewer');

            ws.on('message', (message) => {
                const data = JSON.parse(message.toString());
                session.handleEdit(connectionId, data);
            });

            ws.on('close', () => {
                session.removeUser(connectionId);
            });
        });

        const PORT = 8081;
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });
    } catch (e) { console.error(e); }
})();