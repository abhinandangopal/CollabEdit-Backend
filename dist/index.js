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
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const kafkajs_1 = require("kafkajs");
const DocumentSession_1 = require("./services/DocumentSession");
// 🛠️ FIX 1: Use process.env.PORT for Railway, or fallback to 8081
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081;
const wss = new ws_1.WebSocketServer({ port: PORT });
// Store active document sessions in memory
const sessions = new Map();
// 🛠️ FIX 2: Use KAFKA_URL environment variable provided by Railway
const KAFKA_BROKERS = process.env.KAFKA_URL
    ? [process.env.KAFKA_URL.split(',')[0]] // Use first broker if multiple are provided
    : ['localhost:9092']; // Fallback for local testing
// Setup Kafka Client
const kafka = new kafkajs_1.Kafka({
    clientId: 'editor-service',
    brokers: KAFKA_BROKERS, // Use the fixed brokers list
    retry: {
        initialRetryTime: 100,
        retries: 8
    }
});
const producer = kafka.producer();
function startServer() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Connect to Kafka before accepting users
            yield producer.connect();
            console.log("✅ Connected to Kafka");
            wss.on('connection', (ws, req) => {
                var _a;
                // Parse URL: ws://localhost:8081?docId=doc1&userId=userA
                const params = new URLSearchParams((_a = req.url) === null || _a === void 0 ? void 0 : _a.split('?')[1]);
                const docId = params.get('docId') || 'default-doc';
                const userId = params.get('userId') || 'user-' + Math.floor(Math.random() * 1000);
                // Set a default role, as no auth logic is present in this file
                const defaultRole = 'editor';
                // Create a session for this document if it doesn't exist
                if (!sessions.has(docId)) {
                    console.log(`Creating new session for ${docId}`);
                    sessions.set(docId, new DocumentSession_1.DocumentSession(docId, producer));
                }
                const session = sessions.get(docId);
                // 🛠️ FIX 3: Add the missing 'role' argument to the function call
                session.addUser(ws, userId, defaultRole);
                // Handle incoming messages (Edits, Cursors)
                ws.on('message', (data) => {
                    console.log(`📩 Received from ${userId}: ${data}`);
                    try {
                        const operation = JSON.parse(data.toString());
                        session.handleEdit(userId, operation);
                    }
                    catch (e) {
                        console.error("Invalid message format");
                    }
                });
                ws.on('close', () => {
                    session.removeUser(userId);
                });
            });
            console.log(`🚀 WebSocket Server running on port ${PORT}`);
        }
        catch (error) {
            console.error("Failed to start server:", error);
        }
    });
}
startServer();
