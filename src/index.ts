import { WebSocketServer } from 'ws';
import { Kafka } from 'kafkajs';
import { DocumentSession } from './services/DocumentSession';

const PORT = 8081; // Using Port 8081
const wss = new WebSocketServer({ port: PORT });

// Store active document sessions in memory
const sessions = new Map<string, DocumentSession>();

// Setup Kafka Client
const kafka = new Kafka({ 
    clientId: 'editor-service', 
    brokers: ['localhost:9092'], // Connecting to Docker Kafka
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

            // Create a session for this document if it doesn't exist
            if (!sessions.has(docId)) {
                console.log(`Creating new session for ${docId}`);
                sessions.set(docId, new DocumentSession(docId, producer));
            }

            const session = sessions.get(docId)!;
            session.addUser(ws, userId);

            // Handle incoming messages (Edits, Cursors)
            ws.on('message', (data) => {
                // 🔴 THIS IS THE DEBUG LOG WE NEED:
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