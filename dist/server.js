"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const DocumentSession_1 = require("./services/DocumentSession");
const ioredis_1 = __importDefault(require("ioredis"));
const cors_1 = __importDefault(require("cors"));
const kafkajs_1 = require("kafkajs");
// 1. Setup Express and CORS
const app = (0, express_1.default)();
const allowedOrigins = ['https://abhinandancte.vercel.app', 'http://localhost:5173'];
app.use((0, cors_1.default)({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
}));
app.use(express_1.default.json());
// 2. Setup HTTP and WebSocket Server
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
// 3. Setup Environment Variables and Port
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081;
const REDIS_URL = process.env.REDIS_URL || "redis://default:RtfJevPbBmwicENQmqqRdRJegVzQojAg@redis.railway.internal:6379";
const KAFKA_BROKER = process.env.KAFKA_URL ? process.env.KAFKA_URL.split(',')[0] : "kafka-broker.railway.internal:9092";
// 4. Initialize Services
console.log(`Connecting to Redis...`);
const redis = new ioredis_1.default(REDIS_URL, { maxRetriesPerRequest: 2, });
console.log(`Setting up Kafka at ${KAFKA_BROKER}...`);
const kafka = new kafkajs_1.Kafka({ clientId: 'collab-app', brokers: [KAFKA_BROKER] });
const producer = kafka.producer();
const sessions = new Map();
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
function isOwner(docId, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        const owner = yield redis.get(`doc_owner:${docId}`);
        return owner === userId;
    });
}
// 🟢 NEW HELPER: Get the effective role for a user (fixes Share button issue)
function getUserRole(docId, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        // 1. Check for explicit role in the document's ACL (e.g., 'owner', 'editor', 'viewer')
        const explicitRole = yield redis.hget(`doc_acl:${docId}`, userId);
        if (explicitRole)
            return explicitRole;
        // 2. If no explicit role, check the general "Link Access" setting
        const linkAccess = yield redis.hget(`doc_settings:${docId}`, 'link_access');
        // 3. Return the link setting if it exists (e.g. 'viewer'), otherwise default to 'none'
        return linkAccess || 'none';
    });
}
// --- REST APIs ---
app.get('/api/docs/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (kafkaReady) {
        const { userId } = req.params;
        const docs = yield redis.smembers(`user_docs:${userId}`);
        res.json(docs);
    }
    else {
        res.status(503).json({ error: "Service Unavailable: Kafka not ready." });
    }
}));
app.post('/api/docs', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId, docId } = req.body;
    yield redis.sadd(`user_docs:${userId}`, docId);
    yield redis.set(`doc_owner:${docId}`, userId);
    yield redis.rpush(`doc_tabs:${docId}`, "Sheet 1");
    // Owner gets 'owner' role in ACL
    yield redis.hset(`doc_acl:${docId}`, userId, 'owner');
    // Default link access is 'restricted' (none)
    yield redis.hset(`doc_settings:${docId}`, 'link_access', 'none');
    res.json({ success: true });
}));
// GET PERMISSIONS & LINK SETTINGS
app.get('/api/doc/:docId/users', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId } = req.params;
    // 1. Get specific user list (ACL)
    const acl = yield redis.hgetall(`doc_acl:${docId}`);
    // 2. Get general link setting
    const linkAccess = (yield redis.hget(`doc_settings:${docId}`, 'link_access')) || 'none';
    res.json({ acl, linkAccess });
}));
// INVITE / UPDATE USER ROLE
app.post('/api/doc/:docId/user', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId, ownerId, email, role } = req.body;
    if (!(yield isOwner(docId, ownerId)))
        return res.status(403).json({ error: "Not owner" });
    yield redis.hset(`doc_acl:${docId}`, email, role);
    yield redis.sadd(`user_docs:${email}`, docId);
    res.json({ success: true });
}));
// REVOKE USER ACCESS
app.delete('/api/doc/:docId/user', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId, ownerId, email } = req.body;
    if (!(yield isOwner(docId, ownerId)))
        return res.status(403).json({ error: "Not owner" });
    yield redis.hdel(`doc_acl:${docId}`, email);
    res.json({ success: true });
}));
// UPDATE GENERAL LINK ACCESS
app.post('/api/doc/:docId/link-settings', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId, ownerId, linkAccess } = req.body; // 'none'|'viewer'|'commenter'|'editor'
    if (!(yield isOwner(docId, ownerId)))
        return res.status(403).json({ error: "Not owner" });
    yield redis.hset(`doc_settings:${docId}`, 'link_access', linkAccess);
    res.json({ success: true });
}));
app.get('/api/doc/:docId/tabs', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId } = req.params;
    const tabs = yield redis.lrange(`doc_tabs:${docId}`, 0, -1);
    if (tabs.length === 0) {
        yield redis.rpush(`doc_tabs:${docId}`, "Sheet 1");
        return res.json(["Sheet 1"]);
    }
    res.json(tabs);
}));
app.post('/api/doc/:docId/tabs', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { docId, tabName } = req.body;
    yield redis.rpush(`doc_tabs:${docId}`, tabName);
    res.json({ success: true });
}));
// --- Main Server Start Logic ---
(() => __awaiter(void 0, void 0, void 0, function* () {
    // 1. Start HTTP/WS server immediately (CRITICAL for CORS/502 fix)
    server.listen(PORT, () => {
        console.log(`🚀 HTTP/WS Server listening immediately on port ${PORT}`);
    });
    try {
        // 2. Connect to Kafka asynchronously
        yield producer.connect();
        // 3. Setup WebSocket connection handling (runs non-blocking)
        wss.on('connection', (ws, req) => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const urlParams = new URLSearchParams((_a = req.url) === null || _a === void 0 ? void 0 : _a.split('?')[1]);
            const docId = urlParams.get('docId');
            const tabId = urlParams.get('tabId');
            const userId = urlParams.get('userId');
            if (!docId || !userId || !tabId) {
                ws.close();
                return;
            }
            // 🟢 AUTH LOGIC START (Updated to use DB)
            const userRole = yield getUserRole(docId, userId);
            if (userRole === 'none') {
                console.log(`⛔ Access denied for ${userId} on doc ${docId}`);
                ws.send(JSON.stringify({ type: 'error', message: "Access Denied: You do not have permission to view this document." }));
                ws.close();
                return;
            }
            // 🟢 AUTH LOGIC END
            const sessionKey = `${docId}::${tabId}`;
            if (!sessions.has(sessionKey)) {
                sessions.set(sessionKey, new DocumentSession_1.DocumentSession(sessionKey, producer));
            }
            const session = sessions.get(sessionKey);
            // 💡 FIX: Pass the real role retrieved from Redis
            const connectionId = yield session.addUser(ws, userId, userRole);
            ws.on('message', (message) => {
                const data = JSON.parse(message.toString());
                session.handleEdit(connectionId, data);
            });
            ws.on('close', () => {
                session.removeUser(connectionId);
            });
        }));
    }
    catch (e) {
        console.error("🔥 FATAL SETUP ERROR: Could not connect to Kafka or Redis.", e);
        // The server is running, but real-time functions will be unavailable.
    }
}))();
