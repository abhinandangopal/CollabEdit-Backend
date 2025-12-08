import { WebSocketServer } from 'ws';
import { Kafka } from 'kafkajs';
import { DocumentSession } from './services/DocumentSession';

// 🛠️ FIX 1: Use process.env.PORT for Railway, or fallback to 8081
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081; 
const wss = new WebSocketServer({ port: PORT });

// Store active document sessions in memory
const sessions = new Map<string, DocumentSession>();

// 🛠️ FIX 2: Use KAFKA_URL environment variable provided by Railway
const KAFKA_BROKERS = process.env.KAFKA_URL 
    ? [process.env.KAFKA_URL.split(',')[0]] // Use first broker if multiple are provided
    : ['localhost:9092']; // Fallback for local testing

// Setup Kafka Client
const kafka = new Kafka({ 
    clientId: 'editor-service', 
    brokers: KAFKA_BROKERS, // Use the fixed brokers list
    retry: {
        initialRetryTime: 100,
        retries: 8
    }
});

const producer = kafka.producer();

async function startServer() {
    try {
        // Connect to Kafka before accepting users
        await producer.connect();
        console.log("✅ Connected to Kafka");

        wss.on('connection', (ws, req) => {
            // Parse URL: ws://localhost:8081?docId=doc1&userId=userA
            const params = new URLSearchParams(req.url?.split('?')[1]);
            const docId = params.get('docId') || 'default-doc';
            const userId = params.get('userId') || 'user-' + Math.floor(Math.random() * 1000);
            
            // Set a default role, as no auth logic is present in this file
            const defaultRole = 'editor'; 

            // Create a session for this document if it doesn't exist
            if (!sessions.has(docId)) {
                console.log(`Creating new session for ${docId}`);
                sessions.set(docId, new DocumentSession(docId, producer));
            }

            const session = sessions.get(docId)!;
            
            // 🛠️ FIX 3: Add the missing 'role' argument to the function call
            session.addUser(ws, userId, defaultRole); 

            // Handle incoming messages (Edits, Cursors)
            ws.on('message', (data) => {
                console.log(`📩 Received from ${userId}: ${data}`); 

                try {
                    const operation = JSON.parse(data.toString());
                    session.handleEdit(userId, operation);
                } catch (e) {
                    console.error("Invalid message format");
                }
            });

            ws.on('close', () => {
                session.removeUser(userId);
            });
        });

        console.log(`🚀 WebSocket Server running on port ${PORT}`);

    } catch (error) {
        console.error("Failed to start server:", error);
    }
}

startServer();